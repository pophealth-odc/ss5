// Unit tests for extension/lib/messaging.js (the dashboard <-> extension trust boundary).  Run: node tests/messaging.test.mjs
import assert from 'node:assert/strict';
import { trustedFromMatchPattern, checkSender, validateRequest } from '../extension/lib/messaging.js';
import { PROTOCOL_VERSION, COMMANDS } from '../extension/lib/constants.js';

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL:', name, '\n  ', e.message); process.exitCode = 1; } };

// ---- trustedFromMatchPattern (the manifest's externally_connectable pattern is the single source of trust)
t('accepts a https github pages project pattern', () => {
  const r = trustedFromMatchPattern('https://octocat.github.io/edge-screenshot-automation/*');
  assert.deepEqual(r, { ok: true, origin: 'https://octocat.github.io', pathPrefix: '/edge-screenshot-automation/', anyPort: false });
});
t('user-site root pattern', () => assert.equal(trustedFromMatchPattern('https://octocat.github.io/*').pathPrefix, '/'));
t('placeholder is refused', () => assert.equal(trustedFromMatchPattern('https://YOUR-GITHUB-USERNAME.github.io/edge-screenshot-automation/*').code, 'placeholder'));
t('plain http refused for remote hosts', () => assert.equal(trustedFromMatchPattern('http://octocat.github.io/x/*').ok, false));
t('http allowed for localhost only, any port', () => {
  const r = trustedFromMatchPattern('http://localhost/x/*');
  assert.equal(r.ok, true); assert.equal(r.anyPort, true);
  assert.equal(trustedFromMatchPattern('http://evil.com/x/*').ok, false);
});
t('localhost WITH a port pins that port', () => {
  const r = trustedFromMatchPattern('http://localhost:5287/edge-screenshot-automation/*');
  assert.deepEqual(r, { ok: true, origin: 'http://localhost:5287', pathPrefix: '/edge-screenshot-automation/', anyPort: false });
});
t('pinned localhost port: the same port is accepted, any OTHER local port is refused', () => {
  const tr = trustedFromMatchPattern('http://localhost:5287/app/*');
  const S2 = (url) => ({ url, frameId: 0 });
  assert.equal(checkSender(S2('http://localhost:5287/app/index.html'), tr).ok, true);
  assert.equal(checkSender(S2('http://localhost:5288/app/index.html'), tr).code, 'bad_origin');
  assert.equal(checkSender(S2('http://localhost:80/app/index.html'), tr).code, 'bad_origin');
  assert.equal(checkSender(S2('http://localhost/app/index.html'), tr).code, 'bad_origin');
  assert.equal(checkSender(S2('http://127.0.0.1:5287/app/index.html'), tr).code, 'bad_origin');   // same port, different host
  assert.equal(checkSender(S2('http://localhost:5287/other/index.html'), tr).code, 'bad_origin');
  assert.equal(checkSender(S2('https://localhost:5287/app/index.html'), tr).code, 'bad_origin');  // scheme downgrade/upgrade
});
t('an https port that is the default (:443) is the same origin as no port', () => {
  const r = trustedFromMatchPattern('https://tools.example.org:443/x/*');
  assert.equal(r.origin, 'https://tools.example.org');
  assert.equal(checkSender({ url: 'https://tools.example.org/x/a.html', frameId: 0 }, r).ok, true);
});
t('non-default https port is pinned', () => {
  const r = trustedFromMatchPattern('https://tools.example.org:8443/x/*');
  assert.equal(r.origin, 'https://tools.example.org:8443');
  assert.equal(checkSender({ url: 'https://tools.example.org/x/a.html', frameId: 0 }, r).code, 'bad_origin');
  assert.equal(checkSender({ url: 'https://tools.example.org:8443/x/a.html', frameId: 0 }, r).ok, true);
});
t('out-of-range or malformed ports are refused', () => {
  for (const p of ['0', '65536', '99999', '123456']) assert.equal(trustedFromMatchPattern(`http://localhost:${p}/x/*`).ok, false, p);
  assert.equal(trustedFromMatchPattern('http://localhost:abc/x/*').ok, false);
  assert.equal(trustedFromMatchPattern('http://localhost:/x/*').ok, false);
});
t('a pinned remote http port is still refused (http is localhost-only)', () => assert.equal(trustedFromMatchPattern('http://example.org:8080/x/*').ok, false));
t('wildcard host refused (would trust every subdomain)', () => {
  assert.equal(trustedFromMatchPattern('https://*.github.io/x/*').ok, false);
  assert.equal(trustedFromMatchPattern('*://octocat.github.io/x/*').ok, false);
});
t('pattern must end with a wildcard path', () => assert.equal(trustedFromMatchPattern('https://octocat.github.io/x/').ok, false));
t('rejects junk', () => { for (const j of ['', '   ', 'not a url', null, undefined, 5, '<all_urls>']) assert.equal(trustedFromMatchPattern(j).ok, false, String(j)); });
t('custom domains work (no github.io special-casing)', () => assert.equal(trustedFromMatchPattern('https://tools.example.org/shots/*').ok, true));

// ---- checkSender
const trusted = trustedFromMatchPattern('https://octocat.github.io/edge-screenshot-automation/*');
const S = (url, extra = {}) => ({ url, origin: new URL(url).origin, frameId: 0, ...extra });
t('exact dashboard page ok', () => assert.equal(checkSender(S('https://octocat.github.io/edge-screenshot-automation/index.html'), trusted).ok, true));
t('sub-page ok', () => assert.equal(checkSender(S('https://octocat.github.io/edge-screenshot-automation/gallery.html?x=1#y'), trusted).ok, true));
t('same origin, different repo refused', () => assert.equal(checkSender(S('https://octocat.github.io/other-repo/index.html'), trusted).code, 'bad_origin'));
t('path-prefix lookalike refused', () => assert.equal(checkSender(S('https://octocat.github.io/edge-screenshot-automation-evil/index.html'), trusted).code, 'bad_origin'));
t('other github user refused', () => assert.equal(checkSender(S('https://mallory.github.io/edge-screenshot-automation/index.html'), trusted).code, 'bad_origin'));
t('subdomain trick refused', () => assert.equal(checkSender(S('https://octocat.github.io.evil.com/edge-screenshot-automation/'), trusted).code, 'bad_origin'));
t('http downgrade refused', () => assert.equal(checkSender(S('http://octocat.github.io/edge-screenshot-automation/'), trusted).code, 'bad_origin'));
t('different port refused', () => assert.equal(checkSender(S('https://octocat.github.io:8443/edge-screenshot-automation/'), trusted).code, 'bad_origin'));
t('embedded frame refused', () => assert.equal(checkSender(S('https://octocat.github.io/edge-screenshot-automation/index.html', { frameId: 3 }), trusted).code, 'bad_sender'));
t('missing/garbage sender refused', () => { for (const s of [null, undefined, {}, { url: 'nope' }, 'x']) assert.equal(checkSender(s, trusted).ok, false); });
t('unconfigured trust refuses everything', () => assert.equal(checkSender(S('https://octocat.github.io/edge-screenshot-automation/'), trustedFromMatchPattern('')).ok, false));
t('placeholder trust refuses everything', () => assert.equal(checkSender(S('https://octocat.github.io/edge-screenshot-automation/'), trustedFromMatchPattern('https://YOUR-GITHUB-USERNAME.github.io/edge-screenshot-automation/*')).ok, false));
t('sender.origin is not trusted over sender.url', () => {
  // an attacker cannot make url and origin disagree in reality, but we only rely on the parsed url
  const s = { url: 'https://mallory.github.io/edge-screenshot-automation/', origin: 'https://octocat.github.io', frameId: 0 };
  assert.equal(checkSender(s, trusted).ok, false);
});

// ---- validateRequest
const req = (cmd, payload, extra = {}) => ({ v: PROTOCOL_VERSION, cmd, ...(payload !== undefined ? { payload } : {}), ...extra });
t('every command has a rule and a valid minimal request', () => {
  const minimal = {
    'settings.save': { settings: {} }, 'urls.save': { urls: [] }, 'gallery.get': { id: 'abc' },
    'gallery.delete': { ids: ['abc'] }, 'gallery.clear': { confirm: true }, 'data.clearAll': { confirm: true },
  };
  for (const c of COMMANDS) assert.equal(validateRequest(req(c, minimal[c])).ok, true, c);
});
t('rejects non-object / array / null', () => { for (const m of [null, undefined, 'x', 5, [], [req('ping')]]) assert.equal(validateRequest(m).ok, false); });
t('rejects wrong protocol version', () => assert.equal(validateRequest({ v: 99, cmd: 'ping' }).code, 'bad_version'));
t('rejects missing version', () => assert.equal(validateRequest({ cmd: 'ping' }).code, 'bad_version'));
t('rejects unknown command', () => { for (const c of ['eval', 'run.start ', 'RUN.START', '__proto__', 'constructor', 'toString', '', 5]) assert.equal(validateRequest({ v: PROTOCOL_VERSION, cmd: c }).code, 'unknown_command', String(c)); });
t('rejects unexpected top-level fields', () => assert.equal(validateRequest({ v: PROTOCOL_VERSION, cmd: 'ping', extra: 1 }).code, 'bad_request'));
t('rejects non-object payload', () => { for (const p of ['x', 5, [], null]) assert.equal(validateRequest({ v: PROTOCOL_VERSION, cmd: 'ping', payload: p }).ok, false); });
t('rejects oversized message', () => assert.equal(validateRequest(req('urls.save', { urls: ['https://a.com/' + 'x'.repeat(300000)] })).code, 'too_large'));
t('rejects bad requestId', () => { assert.equal(validateRequest(req('ping', undefined, { requestId: 5 })).ok, false); assert.equal(validateRequest(req('ping', undefined, { requestId: 'x'.repeat(65) })).ok, false); });
t('settings.save validates strictly', () => {
  assert.equal(validateRequest(req('settings.save', { settings: { zoomPercent: 500 } })).ok, false);
  assert.equal(validateRequest(req('settings.save', { settings: { evil: true } })).ok, false);
  const r = validateRequest(req('settings.save', { settings: { zoomPercent: 125 } }));
  assert.equal(r.ok, true); assert.equal(r.payload.settings.zoomPercent, 125);
});
t('settings.save returns ONLY the keys that were sent (a partial save must not reset other options)', () => {
  const r = validateRequest(req('settings.save', { settings: { zoomPercent: 125 } }));
  assert.deepEqual(r.payload.settings, { zoomPercent: 125 });
  const r2 = validateRequest(req('settings.save', { settings: { zoomPercent: 132 } }));
  assert.equal(r2.ok, false);   // still strictly validated
});
t('settings.save with array/non-object', () => { assert.equal(validateRequest(req('settings.save', { settings: [] })).ok, false); assert.equal(validateRequest(req('settings.save', {})).ok, false); });
t('urls.save validates each URL and honours allowHttp', () => {
  assert.equal(validateRequest(req('urls.save', { urls: ['https://a.com', 'javascript:alert(1)'] })).ok, false);
  assert.equal(validateRequest(req('urls.save', { urls: ['http://a.com'] }), { allowHttp: false }).ok, false);
  assert.equal(validateRequest(req('urls.save', { urls: ['http://a.com'] }), { allowHttp: true }).ok, true);
  assert.deepEqual(validateRequest(req('urls.save', { urls: ['https://A.com'] })).payload.urls, ['https://a.com/']);
});
t('gallery ids restricted to safe charset', () => {
  assert.equal(validateRequest(req('gallery.get', { id: '../../x' })).ok, false);
  assert.equal(validateRequest(req('gallery.get', { id: 5 })).ok, false);
  assert.equal(validateRequest(req('gallery.delete', { ids: [] })).ok, false);
  assert.equal(validateRequest(req('gallery.delete', { ids: ['ok', 'a b'] })).ok, false);
  assert.deepEqual(validateRequest(req('gallery.delete', { ids: ['a', 'a', 'b'] })).payload.ids, ['a', 'b']);
});
t('destructive commands need explicit confirm:true', () => {
  for (const c of ['gallery.clear', 'data.clearAll']) {
    assert.equal(validateRequest(req(c)).ok, false);
    assert.equal(validateRequest(req(c, { confirm: 'true' })).ok, false);
    assert.equal(validateRequest(req(c, { confirm: 1 })).ok, false);
    assert.equal(validateRequest(req(c, { confirm: true })).ok, true);
  }
});
t('prototype pollution payload is inert', () => {
  const m = JSON.parse('{"v":1,"cmd":"settings.save","payload":{"settings":{"__proto__":{"polluted":1},"zoomPercent":100}}}');
  validateRequest(m);
  assert.equal(({}).polluted, undefined);
});

console.log(`messaging.js: ${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
