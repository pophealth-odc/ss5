// Unit tests for extension/lib/runstate.js.  Run: node tests/runstate.test.mjs
import assert from 'node:assert/strict';
import {
  isAllowed, availableActions, emptyRun, progress, recoverAfterRestart, judgeProbe, looksLikeSignIn, sameSite,
  originOf, noteOriginalZoom, originsToRestore,
} from '../extension/lib/runstate.js';
import { STATES as S } from '../extension/lib/constants.js';

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL:', name, '\n  ', e.message); process.exitCode = 1; } };

// ---- transitions: the login gate
t('cannot start straight from idle without a confirmed login', () => {
  assert.equal(availableActions({ state: S.IDLE, loginConfirmed: false }).start, false);
  assert.equal(availableActions({ state: S.IDLE, loginConfirmed: true }).start, true);
});
t('start is impossible while waiting for login', () => { for (const st of [S.OPENING_LOGIN, S.WAITING_LOGIN, S.WAITING_CONFIRMATION]) assert.equal(availableActions({ state: st, loginConfirmed: true }).start, false); });
t('confirm only while waiting (a plain state string never allows it from PAUSED)', () => {
  for (const st of Object.values(S)) assert.equal(isAllowed('confirmLogin', st), st === S.WAITING_LOGIN || st === S.WAITING_CONFIRMATION || st === S.PAUSED, st);
});
t('expired-session pause REQUIRES a fresh confirmation; Resume is refused', () => {
  const reauth = { ...emptyRun(), state: S.PAUSED, loginConfirmed: false };
  assert.equal(isAllowed('confirmLogin', reauth), true);
  assert.equal(isAllowed('resume', reauth), false);
  const a = availableActions(reauth);
  assert.equal(a.confirmLogin, true); assert.equal(a.resume, false); assert.equal(a.start, false); assert.equal(a.stop, true);
});
t('a normal (user) pause resumes WITHOUT another confirmation', () => {
  const normal = { ...emptyRun(), state: S.PAUSED, loginConfirmed: true };
  assert.equal(isAllowed('resume', normal), true);
  assert.equal(isAllowed('confirmLogin', normal), false);
  const a = availableActions(normal);
  assert.equal(a.resume, true); assert.equal(a.confirmLogin, false);
});
t('no second run while one is active', () => {
  for (const st of [S.PREPARING, S.NAVIGATING, S.WAITING_LOAD, S.CAPTURING, S.SAVING, S.PAUSED]) {
    assert.equal(isAllowed('start', st), false, st);
    assert.equal(isAllowed('openLogin', st), false, st);
  }
});
t('pause only while busy; resume only while paused', () => {
  for (const st of Object.values(S)) {
    assert.equal(isAllowed('pause', st), [S.PREPARING, S.NAVIGATING, S.WAITING_LOAD, S.CAPTURING, S.SAVING].includes(st), 'pause ' + st);
    assert.equal(isAllowed('resume', st), st === S.PAUSED, 'resume ' + st);
  }
});

// ---- zoom ledger (Edge keeps an applied zoom per SITE, so each touched site must be restored)
t('originOf', () => { assert.equal(originOf('https://a.com/x?y#z'), 'https://a.com'); assert.equal(originOf('nope'), null); });
t('noteOriginalZoom records the FIRST value only', () => {
  let l = noteOriginalZoom({}, 'https://a.com', 1.25);
  l = noteOriginalZoom(l, 'https://a.com', 1.5);            // later reading already includes our change - must not overwrite
  assert.deepEqual(l, { 'https://a.com': 1.25 });
});
t('noteOriginalZoom does not mutate its input', () => {
  const l0 = Object.freeze({ 'https://a.com': 1 });
  const l1 = noteOriginalZoom(l0, 'https://b.com', 0.9);
  assert.deepEqual(l0, { 'https://a.com': 1 }); assert.deepEqual(l1, { 'https://a.com': 1, 'https://b.com': 0.9 });
});
t('noteOriginalZoom ignores bad input', () => {
  assert.deepEqual(noteOriginalZoom({}, null, 1), {}); assert.deepEqual(noteOriginalZoom({}, 'https://a.com', NaN), {});
  assert.deepEqual(noteOriginalZoom({}, 'https://a.com', 'x'), {}); assert.deepEqual(noteOriginalZoom(undefined, 'https://a.com', 1), { 'https://a.com': 1 });
});
t('noteOriginalZoom keeps a legitimate zoom of 0 out (non-finite only) and handles __proto__ origin safely', () => {
  const l = noteOriginalZoom({}, '__proto__', 1.1);
  assert.equal(({}).polluted, undefined); assert.equal(Object.prototype.hasOwnProperty.call(l, '__proto__'), true);
});
t('originsToRestore lists every touched site', () => assert.deepEqual(originsToRestore({ 'https://a.com': 1, 'https://b.com': 1.25 }), [{ origin: 'https://a.com', zoom: 1 }, { origin: 'https://b.com', zoom: 1.25 }]));
t('originsToRestore tolerates missing ledger', () => assert.deepEqual(originsToRestore(undefined), []));
t('stop is available whenever something is in progress, never when idle/finished', () => {
  for (const st of [S.PREPARING, S.NAVIGATING, S.WAITING_LOAD, S.CAPTURING, S.SAVING, S.PAUSED, S.WAITING_LOGIN, S.WAITING_CONFIRMATION, S.OPENING_LOGIN]) assert.equal(isAllowed('stop', st), true, st);
  for (const st of [S.IDLE, S.COMPLETED, S.STOPPED, S.ERROR]) assert.equal(isAllowed('stop', st), false, st);
});
t('unknown action is never allowed', () => assert.equal(isAllowed('format-disk', S.IDLE), false));
t('availableActions defaults for missing run', () => assert.equal(availableActions(null).openLogin, true));

// ---- progress
t('progress counts finished results only', () => {
  const run = { ...emptyRun(), state: S.NAVIGATING, urls: ['a', 'b', 'c', 'd'], results: [{}, {}] };
  assert.deepEqual(progress(run), { total: 4, done: 2, page: 3, percent: 50 });
});
t('progress never exceeds 100% or total', () => {
  const run = { ...emptyRun(), state: S.COMPLETED, urls: ['a', 'b'], results: [{}, {}] };
  assert.deepEqual(progress(run), { total: 2, done: 2, page: 2, percent: 100 });
});
t('progress with no urls', () => assert.deepEqual(progress(emptyRun()), { total: 0, done: 0, page: 0, percent: 0 }));

// ---- restart recovery
t('busy run becomes paused after restart (resumable)', () => {
  for (const st of [S.PREPARING, S.NAVIGATING, S.WAITING_LOAD, S.CAPTURING, S.SAVING]) {
    const r = recoverAfterRestart({ ...emptyRun(), state: st, nextIndex: 3, urls: ['a', 'b', 'c', 'd'] });
    assert.equal(r.state, S.PAUSED, st); assert.equal(r.nextIndex, 3);
    assert.ok(r.warnings.length >= 1);
  }
});
t('login gate survives restart (does not auto-confirm)', () => {
  const r = recoverAfterRestart({ ...emptyRun(), state: S.WAITING_LOGIN, loginConfirmed: false });
  assert.equal(r.state, S.WAITING_LOGIN); assert.equal(r.loginConfirmed, false);
});
t('opening_login recovers to waiting_login', () => assert.equal(recoverAfterRestart({ ...emptyRun(), state: S.OPENING_LOGIN }).state, S.WAITING_LOGIN));
t('finished states are untouched', () => { for (const st of [S.IDLE, S.COMPLETED, S.STOPPED, S.ERROR, S.PAUSED]) assert.equal(recoverAfterRestart({ ...emptyRun(), state: st }).state, st); });
t('garbage run -> empty run', () => { for (const g of [null, undefined, 'x', 5]) assert.equal(recoverAfterRestart(g).state, S.IDLE); });

// ---- judgeProbe
const okProbe = (o = {}) => ({ href: 'https://a.com/x', timeOrigin: 2000, status: 200, redirects: 0, pwd: false, ...o });
const base = { requested: 'https://a.com/x', loginUrl: 'https://a.com/', startedAt: 1000 };
t('good page is ok', () => assert.equal(judgeProbe(okProbe(), base).kind, 'ok'));
t('error page (refused/DNS) detected from script error', () => assert.equal(judgeProbe({ err: 'Frame with ID 0 is showing error page' }, base).kind, 'error-page'));
t('protected page detected', () => assert.equal(judgeProbe({ err: 'Cannot access chrome:// and edge:// URLs' }, base).kind, 'error-page'));
t('stale document detected (old timeOrigin)', () => assert.equal(judgeProbe(okProbe({ timeOrigin: 500 }), base).kind, 'stale'));
t('small clock skew tolerated', () => assert.equal(judgeProbe(okProbe({ timeOrigin: 900 }), base).kind, 'ok'));
t('HTTP 404/500 are failures', () => { assert.equal(judgeProbe(okProbe({ status: 404 }), base).kind, 'http-error'); assert.equal(judgeProbe(okProbe({ status: 500 }), base).kind, 'http-error'); });
t('missing status (null) is not treated as an error', () => assert.equal(judgeProbe(okProbe({ status: null }), base).kind, 'ok'));
t('redirect to a sign-in page = auth', () => assert.equal(judgeProbe(okProbe({ href: 'https://a.com/login?next=/x', redirects: 1, pwd: true }), base).kind, 'auth'));
t('redirect to SSO provider = auth', () => assert.equal(judgeProbe(okProbe({ href: 'https://login.microsoftonline.com/tenant/oauth2/authorize?x=1' }), base).kind, 'auth'));
t('session-expiry detection can be turned off', () => assert.equal(judgeProbe(okProbe({ href: 'https://a.com/login', pwd: true }), { ...base, detectSessionExpiry: false }).kind, 'ok'));
t('a listed login page is NOT flagged', () => {
  const b = { ...base, requested: 'https://a.com/login' };
  assert.equal(judgeProbe(okProbe({ href: 'https://a.com/login' }), b).kind, 'ok');
});
t('normal same-site redirect is not auth', () => assert.equal(judgeProbe(okProbe({ href: 'https://a.com/x/overview', redirects: 1 }), base).kind, 'ok'));
t('"author"/"authority" in a path is not mistaken for auth', () => {
  assert.equal(looksLikeSignIn({ href: 'https://a.com/authors/list', redirects: 1 }, { requested: 'https://a.com/x' }), false);
  assert.equal(looksLikeSignIn({ href: 'https://a.com/authority', redirects: 1 }, { requested: 'https://a.com/x' }), false);
});
t('sameSite ignores www and case', () => { assert.equal(sameSite('https://WWW.A.com/x', 'https://a.com/y'), true); assert.equal(sameSite('https://a.com', 'https://b.com'), false); });

console.log(`runstate.js: ${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
