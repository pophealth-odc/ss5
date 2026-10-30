// E2E 1: does the REAL extension load, boot cleanly, and enforce its trust boundary in real Edge?
import { stageExtension, startServer, startEdge, openPage, killEdge, EXT_ID, DASH_PATH, sleep } from './harness.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail && !cond ? '  -> ' + detail : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 100000);

const { server, port: P } = await startServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>dash</title>dashboard stand-in'); });
let ctx;
try {
  // --- A: shipped manifest as-is (placeholder) must boot and refuse everybody
  const shipped = stageExtension();
  ctx = await startEdge({ extDir: shipped });
  check('A1 extension loads with the shipped (placeholder) manifest', true);
  const err = await ctx.swCdp.eval(`(async () => { const r = await chrome.storage.local.get(null); return Object.keys(r); })()`).catch((e) => 'ERR ' + e.message);
  check('A2 service worker can use chrome.storage', Array.isArray(err), String(err));
  const trustedErr = await ctx.swCdp.eval(`chrome.runtime.getManifest().externally_connectable.matches`);
  check('A3 manifest still has the placeholder pattern', /YOUR-GITHUB-USERNAME/.test(trustedErr[0]), JSON.stringify(trustedErr));
  killEdge(ctx.edge); ctx = null;

  // --- B: configured for the local stand-in dashboard
  const pattern = `http://localhost${DASH_PATH}*`;
  const dir = stageExtension({ pattern });
  ctx = await startEdge({ extDir: dir });
  check('B1 extension loads with a configured dashboard pattern', true);

  const call = (page, msg) => page.cdp.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', ${JSON.stringify(msg)}, (r) => res(r || { lastError: chrome.runtime.lastError && chrome.runtime.lastError.message })))`);

  const good = await openPage(ctx.port, `http://localhost:${P}${DASH_PATH}index.html`);
  const ping = await call(good, { v: 1, cmd: 'ping', requestId: 'r1' });
  check('B2 dashboard page: ping answered', ping.ok === true && ping.name === 'edge-screenshot-automation' && ping.requestId === 'r1', JSON.stringify(ping));

  const st = await call(good, { v: 1, cmd: 'state.get' });
  check('B3 state.get returns idle run + default settings', st.ok && st.run.state === 'idle' && st.settings.zoomPercent === 100 && st.settings.pageDelaySeconds === 5 && st.settings.loginUrl === 'https://aaj23525.apps.dynatrace.com/', JSON.stringify(st).slice(0, 300));
  check('B4 idle: start is NOT available, openLogin is', st.run.actions.start === false && st.run.actions.openLogin === true, JSON.stringify(st.run.actions));

  const unk = await call(good, { v: 1, cmd: 'eval' });
  check('B5 unknown command rejected', unk.ok === false && unk.code === 'unknown_command', JSON.stringify(unk));
  const ver = await call(good, { v: 99, cmd: 'ping' });
  check('B6 wrong protocol version rejected', ver.ok === false && ver.code === 'bad_version', JSON.stringify(ver));
  const bad = await call(good, { v: 1, cmd: 'settings.save', payload: { settings: { zoomPercent: 500 } } });
  check('B7 invalid settings rejected', bad.ok === false && bad.code === 'bad_payload', JSON.stringify(bad));
  const startNoLogin = await call(good, { v: 1, cmd: 'run.start' });
  check('B8 run.start before any login confirmation is refused', startNoLogin.ok === false && /confirm/i.test(startNoLogin.error), JSON.stringify(startNoLogin));
  const confirmNoLogin = await call(good, { v: 1, cmd: 'run.confirmLogin' });
  check('B9 run.confirmLogin with no login pending is refused', confirmNoLogin.ok === false, JSON.stringify(confirmNoLogin));

  const save = await call(good, { v: 1, cmd: 'settings.save', payload: { settings: { zoomPercent: 125, pageDelaySeconds: 10 } } });
  const st2 = await call(good, { v: 1, cmd: 'state.get' });
  check('B10 valid settings saved and persisted', save.ok && st2.settings.zoomPercent === 125 && st2.settings.pageDelaySeconds === 10, JSON.stringify(st2.settings));

  // --- C: pages the browser must keep out
  const otherPath = await openPage(ctx.port, `http://localhost:${P}/other/index.html`);
  const rtOther = await otherPath.cdp.eval(`typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage)`);
  check('C1 other path on the same host cannot even reach the extension (browser-enforced)', rtOther === false);
  const lookalike = await openPage(ctx.port, `http://localhost:${P}/edge-screenshot-automation-evil/index.html`);
  const rtLook = await lookalike.cdp.eval(`typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage)`);
  check('C2 path-prefix lookalike cannot reach the extension', rtLook === false);
  const otherHost = await openPage(ctx.port, `http://127.0.0.1:${P}${DASH_PATH}index.html`);
  const rtHost = await otherHost.cdp.eval(`typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage)`);
  check('C3 same path on a different host cannot reach the extension', rtHost === false);

  // --- D: live status port
  const portMsg = await good.cdp.eval(`new Promise((res) => { const p = chrome.runtime.connect('${EXT_ID}'); const to = setTimeout(() => res('no message'), 3000); p.onMessage.addListener((m) => { clearTimeout(to); res(m); p.disconnect(); }); p.onDisconnect.addListener(() => { clearTimeout(to); res('disconnected: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message)); }); })`);
  check('D1 live status port delivers the current run state', portMsg && portMsg.type === 'run' && portMsg.run.state === 'idle', JSON.stringify(portMsg).slice(0, 200));
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
