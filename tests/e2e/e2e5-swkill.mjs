// E2E 5: the MV3 service worker can be killed at any moment. Kill it MID-RUN and see what the user is left with.
import { stageExtension, startServer, startEdge, openPage, killEdge, EXT_ID, DASH_PATH, sleep, waitTarget, Cdp } from './harness.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 700) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 240000);

const hits = [];
const server = await startServer((req, res) => {
  const u = new URL(req.url, 'http://x'); hits.push(u.pathname);
  res.setHeader('content-type', 'text/html');
  if (u.pathname.startsWith(DASH_PATH)) return res.end('<title>dash</title>dash');
  res.end(`<title>${u.pathname}</title><body style="font:48px sans-serif;background:hsl(${u.pathname.length * 40},60%,75%)">${u.pathname}</body>`);
});
const A = `http://127.0.0.1:${server.port}`;
let ctx, dash;
const call = (msg) => dash.cdp.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', ${JSON.stringify({ v: 1, ...msg })}, (r) => res(r || { lastError: chrome.runtime.lastError && chrome.runtime.lastError.message })))`);
const waitFor = async (pred, ms, label) => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await call({ cmd: 'state.get' }); if (last.ok && pred(last)) return last; await sleep(300); } throw new Error('timeout ' + label + ' last=' + JSON.stringify(last?.run && { s: last.run.state, a: last.run.action, n: last.run.nextIndex })); };

try {
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://127.0.0.1${DASH_PATH}*` }) });
  dash = await openPage(ctx.port, `${A}${DASH_PATH}index.html`);
  const must = async (m) => { const r = await call(m); if (!r.ok) throw new Error(m.cmd + ': ' + JSON.stringify(r)); return r; };
  await must({ cmd: 'settings.save', payload: { settings: { loginUrl: `${A}/login`, allowHttp: true, pageDelaySeconds: 4, navigationTimeoutSeconds: 15 } } });
  await must({ cmd: 'urls.save', payload: { urls: Array.from({ length: 6 }, (_, i) => `${A}/k${i + 1}`) } });

  // ===== (1) kill while WAITING FOR LOGIN: the gate must survive and must NOT auto-confirm
  await must({ cmd: 'run.openLogin' });
  await sleep(500);
  const killSw = async () => {
    const sw = await waitTarget(ctx.port, (t) => t.type === 'service_worker' && t.url.includes(EXT_ID), 8000);
    const c = await Cdp.connect(sw.webSocketDebuggerUrl);
    await c.send('ServiceWorker.enable').catch(() => {});
    // Ask Edge to terminate the worker the way idle-timeout does.
    await fetch(`http://127.0.0.1:${ctx.port}/json/close/${sw.id}`).catch(() => {});
    c.close();
  };
  await killSw(); await sleep(1500);
  const afterKill1 = await waitFor((s) => true, 10000, 'worker back');          // any message wakes the worker again
  check('K1 worker restarts on demand and answers', afterKill1.ok);
  check('K2 login gate survived the restart: still waiting, NOT confirmed', afterKill1.run.state === 'waiting_login' && afterKill1.run.loginConfirmed === false, JSON.stringify({ s: afterKill1.run.state, lc: afterKill1.run.loginConfirmed }));
  const startTry = await call({ cmd: 'run.start' });
  check('K3 Start is still refused after the restart', startTry.ok === false);
  const navBefore = hits.filter((p) => /^\/k\d/.test(p)).length;
  check('K4 nothing from the URL list was visited because of the restart', navBefore === 0, JSON.stringify(hits));

  // ===== (2) kill MID-RUN
  await must({ cmd: 'run.confirmLogin' });
  await waitFor((s) => s.run.captured >= 1, 40000, 'first capture');
  const mid = (await call({ cmd: 'state.get' })).run;
  await killSw();
  await sleep(2500);
  const afterKill2 = (await call({ cmd: 'state.get' })).run;
  check('K5 after a mid-run kill the run is PAUSED (not lost, not silently running)', afterKill2.state === 'paused', JSON.stringify({ s: afterKill2.state, a: afterKill2.action, w: afterKill2.warnings }));
  check('K6 progress and screenshots so far were kept', afterKill2.captured >= mid.captured && afterKill2.nextIndex >= 1, JSON.stringify({ before: mid.captured, after: afterKill2.captured, next: afterKill2.nextIndex }));
  check('K7 the dashboard is told why (warning mentions the restart)', afterKill2.warnings.some((w) => /restart/i.test(w)) || /restart/i.test(afterKill2.action), JSON.stringify(afterKill2.warnings) + ' | ' + afterKill2.action);
  const nAtPause = hits.length;
  await sleep(5000);
  check('K8 a paused-after-restart run does not keep navigating on its own', hits.length === nAtPause);
  const res = await call({ cmd: 'run.resume' });
  check('K9 Resume works after the restart (login still valid in the same Edge window)', res.ok, JSON.stringify(res).slice(0, 200));
  const fin = await waitFor((s) => ['completed', 'error', 'stopped'].includes(s.run.state), 90000, 'finish after resume');
  const g = (await call({ cmd: 'gallery.list' })).items;
  const urls = g.map((i) => i.url);
  check('K10 run completes: every page captured exactly once (no duplicates, none missing)', fin.run.state === 'completed' && g.length === 6 && new Set(urls).size === 6, JSON.stringify({ s: fin.run.state, n: g.length, uniq: new Set(urls).size, e: fin.run.lastError }));
  check('K11 each page was requested the expected number of times (a page interrupted mid-capture may repeat once)', [1, 2, 3, 4, 5, 6].every((i) => hits.filter((p) => p === `/k${i}`).length >= 1 && hits.filter((p) => p === `/k${i}`).length <= 2), JSON.stringify([1, 2, 3, 4, 5, 6].map((i) => hits.filter((p) => p === `/k${i}`).length)));
} catch (e) {
  check('harness ran to completion', false, e.stack || e.message);
} finally {
  if (ctx) killEdge(ctx.edge);
  server.server.close();
  clearTimeout(watchdog);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
