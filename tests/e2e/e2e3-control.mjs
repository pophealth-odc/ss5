// E2E 3: zoom restore across origins (leak check), session expiry + re-login, pause/resume/stop, hang, closed window.
import { stageExtension, startServer, startEdge, openPage, killEdge, EXT_ID, DASH_PATH, sleep } from './harness.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 500) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 420000);

let sessionValid = true;   // flips to false to simulate an expired session
const hits = [];
const { server, port: P } = await startServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.push(u.pathname);
  res.setHeader('content-type', 'text/html');
  if (u.pathname.startsWith(DASH_PATH)) return res.end('<title>dash</title>dash');
  if (u.pathname === '/hang') return;
  if (u.pathname === '/login') return res.end('<title>Sign in</title><form><input type="password"></form>');
  if (u.pathname.startsWith('/secure/') && !sessionValid) { res.statusCode = 302; res.setHeader('location', '/login?next=' + encodeURIComponent(u.pathname)); return res.end(); }
  res.end(`<title>${u.pathname}</title><body style="margin:0;background:hsl(${(u.pathname.length * 53) % 360},60%,75%);font:48px sans-serif">${u.pathname}</body>`);
});
const A = `http://127.0.0.1:${P}`, B = `http://localhost:${P}`;     // two different origins, same server
let ctx, dash;
const call = (msg) => dash.cdp.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', ${JSON.stringify({ v: 1, ...msg })}, (r) => res(r || { lastError: chrome.runtime.lastError && chrome.runtime.lastError.message })))`);
const state = () => call({ cmd: 'state.get' });
const waitFor = async (pred, ms = 60000, label = '') => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await state(); if (pred(last)) return last; await sleep(250); } throw new Error('timeout waiting for ' + label + '; last=' + JSON.stringify(last?.run && { s: last.run.state, a: last.run.action, e: last.run.lastError, n: last.run.nextIndex })); };
const sw = (expr) => ctx.swCdp.eval(expr);
const login = async () => { const o = await call({ cmd: 'run.openLogin' }); if (!o.ok) throw new Error('openLogin: ' + o.error); await waitFor((s) => s.run.state === 'waiting_login', 15000, 'waiting_login'); };
const must = async (msg) => { const r = await call(msg); if (!r.ok) throw new Error('setup call ' + msg.cmd + ' failed: ' + JSON.stringify(r).slice(0, 300)); return r; };
const confirm = async () => { const c = await call({ cmd: 'run.confirmLogin' }); if (!c.ok) throw new Error('confirmLogin refused: ' + JSON.stringify(c).slice(0, 300)); return c; };
const zoomProbe = (url) => sw(`(async () => { const w = await chrome.windows.create({ url: ${JSON.stringify(url)}, focused: false }); await new Promise(r => setTimeout(r, 900)); const z = await chrome.tabs.getZoom(w.tabs[0].id); const d = (await chrome.scripting.executeScript({ target: { tabId: w.tabs[0].id }, func: () => devicePixelRatio }))[0].result; await chrome.windows.remove(w.id); return { z, d }; })()`);

try {
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://127.0.0.1${DASH_PATH}*` }) });
  dash = await openPage(ctx.port, `${A}${DASH_PATH}index.html`);

  // ================= 1. zoom: two origins, 150%, and the user's own zoom on A is 125% =================
  await must({ cmd: 'settings.save', payload: { settings: { loginUrl: `${A}/login-start`, allowHttp: true, pageDelaySeconds: 1, navigationTimeoutSeconds: 10, zoomPercent: 150 } } });
  await must({ cmd: 'urls.save', payload: { urls: [`${A}/a1`, `${B}/b1`, `${A}/a2`] } });
  // Give site A a pre-existing "user" zoom of 125% (as if they'd set it in Edge earlier).
  await sw(`(async () => { const w = await chrome.windows.create({ url: '${A}/pre', focused: false }); await new Promise(r => setTimeout(r, 800)); await chrome.tabs.setZoom(w.tabs[0].id, 1.25); await new Promise(r => setTimeout(r, 300)); await chrome.windows.remove(w.id); })()`);
  const preA = await zoomProbe(`${A}/probe`), preB = await zoomProbe(`${B}/probe`);
  check('Z0 setup: site A starts at the user zoom 125%, site B at 100%', Math.abs(preA.z - 1.25) < 0.01 && Math.abs(preB.z - 1) < 0.01, JSON.stringify({ preA, preB }));

  await login();
  await confirm();
  const d1 = await waitFor((s) => ['completed', 'error', 'stopped'].includes(s.run.state), 90000, 'zoom run');
  check('Z1 zoom run completed with 3 screenshots', d1.run.state === 'completed' && d1.run.captured === 3, JSON.stringify({ s: d1.run.state, c: d1.run.captured, e: d1.run.lastError }));
  const gl = await call({ cmd: 'gallery.list' });
  // 150% means the page renders at devicePixelRatio 1.5, so a 1.5x narrower CSS viewport => screenshots show larger content.
  check('Z2 each page was really captured at the configured zoom (verified by the extension, no zoom warnings)', !d1.run.warnings.some((w) => /Zoom/i.test(w)), JSON.stringify(d1.run.warnings));
  const postA = await zoomProbe(`${A}/probe`), postB = await zoomProbe(`${B}/probe`);
  // devicePixelRatio = browser zoom x display scale, so divide the display scale out (EDGE_SCALE emulates 125%/150% Windows displays).
  const DISPLAY = Number(process.env.EDGE_SCALE || 1);
  check('Z3 site A is back to the USER\'s 125% (not 100%, not 150%)', Math.abs(postA.z - 1.25) < 0.01 && Math.abs(postA.d / DISPLAY - 1.25) < 0.05, JSON.stringify(postA));
  check('Z4 site B is back to 100%', Math.abs(postB.z - 1) < 0.01 && Math.abs(postB.d / DISPLAY - 1) < 0.05, JSON.stringify(postB));
  check('Z5 ledger is empty after the run', Object.keys(d1.run.zoomLedger || {}).length === 0, JSON.stringify(d1.run.zoomLedger));
  await must({ cmd: 'gallery.clear', payload: { confirm: true } });

  // ================= 2. session expiry mid-run, then re-login, no duplicates =================
  await must({ cmd: 'settings.save', payload: { settings: { zoomPercent: 100 } } });
  await must({ cmd: 'urls.save', payload: { urls: [`${A}/secure/1`, `${A}/secure/2`, `${A}/secure/3`, `${A}/secure/4`] } });
  sessionValid = true;
  await login();
  await confirm();
  await waitFor((s) => s.run.captured >= 1, 40000, 'first capture');
  sessionValid = false;                                   // the "session" expires now
  const pausedAuth = await waitFor((s) => s.run.state === 'paused', 40000, 'pause on expiry');
  check('E1 expired session pauses the run', pausedAuth.run.state === 'paused' && /sign|login|session/i.test(pausedAuth.run.action + pausedAuth.run.lastError), JSON.stringify({ a: pausedAuth.run.action, e: pausedAuth.run.lastError }));
  check('E2 login is no longer considered confirmed', pausedAuth.run.loginConfirmed === false);
  check('E3 Resume is NOT offered; re-confirmation is', pausedAuth.run.actions.resume === false && pausedAuth.run.actions.confirmLogin === true, JSON.stringify(pausedAuth.run.actions));
  const resumeTry = await call({ cmd: 'run.resume' });
  check('E4 run.resume is refused after expiry', !resumeTry.ok, JSON.stringify(resumeTry));
  const capturedBefore = pausedAuth.run.captured, nextBefore = pausedAuth.run.nextIndex;
  const pagesAfterPause = hits.length;
  await sleep(2500);
  check('E5 nothing navigates while waiting for the new login', hits.length === pagesAfterPause, `${hits.length} vs ${pagesAfterPause}`);
  sessionValid = true;                                    // user signs in again
  const reconf = await call({ cmd: 'run.confirmLogin' });
  check('E6 explicit re-confirmation accepted', reconf.ok, JSON.stringify(reconf));
  const d2 = await waitFor((s) => ['completed', 'error', 'stopped'].includes(s.run.state), 60000, 'run after re-login');
  check('E7 run completes after re-login with all 4 pages and NO duplicates', d2.run.state === 'completed' && d2.run.captured === 4 && d2.run.results.length === 4, JSON.stringify({ s: d2.run.state, c: d2.run.captured, n: d2.run.results.length, capturedBefore, nextBefore }));
  const g2 = await call({ cmd: 'gallery.list' });
  check('E8 gallery has exactly 4 screenshots (the interrupted page was retried, not duplicated)', g2.items.length === 4 && new Set(g2.items.map((i) => i.url)).size === 4, JSON.stringify(g2.items.map((i) => i.url)));
  await must({ cmd: 'gallery.clear', payload: { confirm: true } });

  // ================= 3. pause / resume / stop =================
  await must({ cmd: 'settings.save', payload: { settings: { pageDelaySeconds: 3 } } });
  await must({ cmd: 'urls.save', payload: { urls: Array.from({ length: 6 }, (_, i) => `${A}/p${i + 1}`) } });
  await login();
  await confirm();
  await waitFor((s) => s.run.captured >= 1, 40000, 'first page');
  const pz = await call({ cmd: 'run.pause' });
  check('P1 pause accepted while running', pz.ok, JSON.stringify(pz));
  const paused = await waitFor((s) => s.run.state === 'paused', 30000, 'paused');
  const nAtPause = hits.length;
  await sleep(3500);
  check('P2 pause starts no further navigation', hits.length === nAtPause, `${hits.length} vs ${nAtPause}`);
  check('P3 paused run keeps its login (Resume offered, no re-confirm)', paused.run.loginConfirmed === true && paused.run.actions.resume === true && paused.run.actions.confirmLogin === false);
  const capAtPause = paused.run.captured;
  const rz = await call({ cmd: 'run.resume' });
  check('P4 resume accepted', rz.ok, JSON.stringify(rz));
  await waitFor((s) => s.run.captured > capAtPause, 30000, 'progress after resume');
  const stp = await call({ cmd: 'run.stop' });
  check('P5 stop accepted', stp.ok, JSON.stringify(stp));
  const stopped = await waitFor((s) => s.run.state === 'stopped', 30000, 'stopped');
  const nAtStop = hits.length;
  await sleep(3500);
  check('P6 stop schedules no further navigation', hits.length === nAtStop);
  check('P7 stopped run kept the screenshots captured so far (no loss, no duplicates)', stopped.run.captured >= 2 && stopped.run.captured < 6 && (await call({ cmd: 'gallery.list' })).items.length === stopped.run.captured, JSON.stringify({ c: stopped.run.captured }));
  const startAfterStop = await call({ cmd: 'run.start' });
  check('P8 a stopped run cannot be started again without a fresh login + confirmation', startAfterStop.ok === false, JSON.stringify(startAfterStop).slice(0, 200));
  check('P9 after stop, the login is no longer considered confirmed', stopped.run.loginConfirmed === false && stopped.run.actions.start === false, JSON.stringify({ lc: stopped.run.loginConfirmed, a: stopped.run.actions }));
  await must({ cmd: 'gallery.clear', payload: { confirm: true } });

  // ================= 3b. repeating a COMPLETED run with Start Automation (same Edge window, session still open) =================
  await must({ cmd: 'settings.save', payload: { settings: { pageDelaySeconds: 1 } } });
  await must({ cmd: 'urls.save', payload: { urls: [`${A}/r1`, `${A}/r2`] } });
  await login();
  await confirm();
  const first = await waitFor((s) => ['completed', 'error', 'stopped'].includes(s.run.state), 60000, 'first run of the repeat test');
  check('RPT1 first run completed; Start Automation is offered to repeat it (login still valid in the open window)', first.run.state === 'completed' && first.run.actions.start === true && first.run.loginConfirmed === true, JSON.stringify({ s: first.run.state, a: first.run.actions }));
  await must({ cmd: 'gallery.clear', payload: { confirm: true } });
  const hitsBeforeRepeat = hits.filter((p) => p === '/r1').length;
  const again = await call({ cmd: 'run.start' });
  check('RPT2 Start Automation repeats the run without another login', again.ok, JSON.stringify(again).slice(0, 200));
  const second = await waitFor((s) => ['completed', 'error', 'stopped'].includes(s.run.state), 60000, 'repeat run');
  check('RPT3 the repeat is a fresh, complete run (2 captured, results restarted, pages visited again)', second.run.state === 'completed' && second.run.captured === 2 && second.run.results.length === 2 && hits.filter((p) => p === '/r1').length === hitsBeforeRepeat + 1, JSON.stringify({ s: second.run.state, c: second.run.captured, n: second.run.results.length }));
  check('RPT4 the repeat did not duplicate screenshots', (await call({ cmd: 'gallery.list' })).items.length === 2);
  // Start must NOT work once the Edge window is gone, even though the last run completed
  await must({ cmd: 'gallery.clear', payload: { confirm: true } });
  await sw(`chrome.windows.remove(${(await state()).run.windowId})`);
  await sleep(800);
  const orphan = await call({ cmd: 'run.start' });
  check('RPT5 Start is refused once the Edge window has been closed, and the login is cleared', orphan.ok === false && (await state()).run.loginConfirmed === false, JSON.stringify(orphan).slice(0, 200));

  // ================= 4. server that never answers =================
  await must({ cmd: 'settings.save', payload: { settings: { pageDelaySeconds: 1, navigationTimeoutSeconds: 10 } } });
  await must({ cmd: 'urls.save', payload: { urls: [`${A}/ok1`, `${A}/hang`, `${A}/ok2`] } });
  await login();
  await confirm();
  const dh = await waitFor((s) => ['completed', 'error', 'stopped'].includes(s.run.state), 80000, 'hang run');
  check('H1 a page that never loads fails cleanly and the run continues', dh.run.state === 'completed' && dh.run.results[1].status === 'failed' && dh.run.results[2].status === 'ok', JSON.stringify(dh.run.results.map((r) => r.status + (r.error ? ':' + r.error : ''))));
  check('H2 the failure says WHY (timeout) rather than saving the previous page', /did not load|load/i.test(dh.run.results[1].error || ''), dh.run.results[1].error);
  const gh = await call({ cmd: 'gallery.list' });
  check('H3 no screenshot was saved for the hung page', gh.items.length === 2 && !gh.items.some((i) => i.url.endsWith('/hang')));
  await must({ cmd: 'gallery.clear', payload: { confirm: true } });

  // ================= 5. user closes the window mid-run =================
  await must({ cmd: 'settings.save', payload: { settings: { pageDelaySeconds: 3 } } });
  await must({ cmd: 'urls.save', payload: { urls: Array.from({ length: 5 }, (_, i) => `${A}/w${i + 1}`) } });
  await login();
  await confirm();
  await waitFor((s) => s.run.captured >= 1, 40000, 'first page');
  const winId = (await state()).run.windowId;
  await sw(`chrome.windows.remove(${winId})`);
  const wc = await waitFor((s) => s.run.state === 'paused' || s.run.state === 'error' || s.run.state === 'stopped', 30000, 'reaction to closed window');
  check('W1 closing the window pauses safely and requires re-login', wc.run.state === 'paused' && wc.run.loginConfirmed === false, JSON.stringify({ s: wc.run.state, a: wc.run.action }));
  check('W2 the message explains what happened', /closed/i.test(wc.run.action + (wc.run.lastError || '')), wc.run.action);
  const ghost = await call({ cmd: 'run.confirmLogin' });
  check('W3 confirming a login whose window is gone is refused (no phantom run)', ghost.ok === false, JSON.stringify(ghost).slice(0, 200));
  await call({ cmd: 'run.stop' });
} catch (e) {
  check('harness ran to completion', false, e.stack || e.message);
} finally {
  if (ctx) killEdge(ctx.edge);
  server.close();
  clearTimeout(watchdog);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
