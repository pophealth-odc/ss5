// UI 1: every dashboard page loads from a project sub-path with the extension present: no JS errors, no 404s,
// no CSP violations, correct initial render, connection indicator turns green, nothing leaves the origin.
import { stageExtension, startServer, startEdge, killEdge, EXT_ID, sleep, Cdp } from './harness.mjs';
import { startPagesServer } from './pages-server.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 600) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 150000);

const reqLog = [];
const pages = await startPagesServer({ log: reqLog });
const PREFIX = pages.prefix;
const ORIGIN = `http://localhost:${pages.port}`;
let ctx;
try {
  // the dashboard is on "localhost"; the extension's pattern allows exactly that origin + path
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://localhost${PREFIX}*` }) });

  for (const file of ['index.html', 'settings.html', 'gallery.html']) {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/json/new?about:blank`, { method: 'PUT' });
    const tab = await r.json();
    const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    const problems = [];
    const requests = new Set();
    cdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(m.params.type)) problems.push('console.' + m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) problems.push('log ' + m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
      if (m.method === 'Network.requestWillBeSent') requests.add(m.params.request.url);
      if (m.method === 'Network.loadingFailed') problems.push('request failed: ' + (m.params.errorText) + ' ' + (m.params.blockedReason || ''));
      if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) problems.push('HTTP ' + m.params.response.status + ' ' + m.params.response.url);
    });
    for (const d of ['Runtime', 'Log', 'Network', 'Page']) await cdp.send(d + '.enable');
    await cdp.send('Page.navigate', { url: `${ORIGIN}${PREFIX}${file}` });
    await sleep(3500);

    check(`${file}: no JS errors, failed requests, 4xx/5xx or CSP violations`, problems.length === 0, problems.join(' | '));
    const external = [...requests].filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('chrome-extension://'));
    check(`${file}: makes no requests outside its own origin`, external.length === 0, external.join(', '));
    const info = await cdp.eval(`({ title: document.title, h1: document.querySelector('h1')?.textContent, conn: document.querySelector('#conn-text')?.textContent, hasNav: !!document.querySelector('nav a[aria-current="page"]'), overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth })`);
    check(`${file}: renders title + heading + current-page nav`, !!info.h1 && info.hasNav && /Edge Screenshot Automation/.test(info.title), JSON.stringify(info));
    check(`${file}: shows "Extension connected"`, /Extension connected/.test(info.conn || ''), info.conn);
    check(`${file}: no horizontal scroll at desktop width`, !info.overflowX);
    cdp.close();
  }

  // The same pages must NOT be reachable by the extension from outside the subpath
  const strayHits = reqLog.filter((p) => !p.startsWith(PREFIX));
  check('no request escaped the project sub-path (all asset paths are relative)', strayHits.length === 0, strayHits.join(', '));
  const missing = reqLog.filter((p) => p.startsWith(PREFIX) && /tests|\.git/.test(p));
  check('no page requested unpublished folders', missing.length === 0, missing.join(', '));
} catch (e) {
  check('harness ran to completion', false, e.stack || e.message);
} finally {
  if (ctx) killEdge(ctx.edge);
  pages.server.close();
  clearTimeout(watchdog);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
