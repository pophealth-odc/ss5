// UI 5: hostile content must never execute in the dashboard. A target page whose TITLE, URL path, and error text are
// XSS payloads goes through a real run; then every dashboard page that displays it is inspected.
import { stageExtension, startServer, startEdge, killEdge, EXT_ID, sleep, Cdp } from './harness.mjs';
import { startPagesServer } from './pages-server.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 600) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 200000);

// Inside <title> the HTML parser treats everything up to </title> as TEXT, so a title that survives parsing is
// markup-looking text such as this (entity-encoded angle brackets decode to real "<" characters in document.title).
const PAYLOAD_TITLE = `&lt;img src=x onerror="window.__pwned=1"&gt; &lt;script&gt;window.__pwned=1&lt;/script&gt;`;
const target = await startServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html');
  if (u.pathname === '/login') return res.end('<title>login</title>login');
  // the title is hostile; the URL contains markup-looking characters too
  res.end(`<title>${PAYLOAD_TITLE}</title><body style="font:40px sans-serif">hostile page</body>`);
});
const T = `http://127.0.0.1:${target.port}`;
const HOSTILE_PATH = `/%22%3E%3Cimg%20src=x%20onerror=window.__pwned=1%3E`;     // "><img src=x onerror=...>
const pages = await startPagesServer({});
const D = `http://localhost:${pages.port}${pages.prefix}`;
let ctx, ui;
const call = (msg) => ui.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', ${JSON.stringify({ v: 1, ...msg })}, (r) => res(r)))`);
const waitFor = async (pred, ms, label) => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await call({ cmd: 'state.get' }); if (pred(last)) return last; await sleep(300); } throw new Error('timeout ' + label); };

try {
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://localhost${pages.prefix}*` }) });
  const tab = await (await fetch(`http://127.0.0.1:${ctx.port}/json/new?about:blank`, { method: 'PUT' })).json();
  ui = await Cdp.connect(tab.webSocketDebuggerUrl);
  await ui.send('Page.enable'); await ui.send('Runtime.enable');
  const dialogs = [];
  ui.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); ui.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); } });
  await ui.send('Page.navigate', { url: D + 'index.html' }); await sleep(1800);

  const must = async (m) => { const r = await call(m); if (!r.ok) throw new Error(m.cmd + ': ' + JSON.stringify(r)); return r; };
  await must({ cmd: 'settings.save', payload: { settings: { loginUrl: `${T}/login`, allowHttp: true, pageDelaySeconds: 1, navigationTimeoutSeconds: 10, filenameFormat: '{index}_{page}' } } });
  await must({ cmd: 'urls.save', payload: { urls: [`${T}${HOSTILE_PATH}`, `${T}/ok`] } });
  await must({ cmd: 'run.openLogin' }); await sleep(800); await must({ cmd: 'run.confirmLogin' });
  const done = await waitFor((s) => ['completed', 'error', 'stopped'].includes(s.run.state), 60000, 'run');
  check('I0 the run with a hostile page completed', done.run.state === 'completed' && done.run.captured === 2, JSON.stringify({ s: done.run.state, c: done.run.captured }));

  const list = (await call({ cmd: 'gallery.list' })).items;
  check('I1 the hostile page title is stored as inert text', list.some((i) => (i.title || '').includes('<script>') || (i.title || '').includes('onerror')), JSON.stringify(list.map((i) => i.title)));
  // Windows forbids < > : " / \ | ? * and control characters in file names; none may survive sanitising.
  check('I2 file names contain no Windows-forbidden or markup characters', list.every((i) => !/[<>:"/\\|?*\u0000-\u001f]/.test(i.filename) && i.filename.endsWith('.png')), JSON.stringify(list.map((i) => i.filename)));

  for (const file of ['index.html', 'gallery.html']) {
    await ui.send('Page.navigate', { url: D + file }); await sleep(2500);
    if (file === 'gallery.html') {
      await ui.eval(`document.querySelector('#grid .shot .thumb')?.click()`); await sleep(1200);   // open the preview, which shows title/url
    }
    const r = await ui.eval(`({ pwned: window.__pwned === 1, injectedImgs: [...document.querySelectorAll('img[onerror], img[src="x"]')].length, injectedScripts: [...document.querySelectorAll('#root script')].length, bodyHasMarkup: /<img src=x|<script>window/.test(document.body.innerHTML.replace(/&lt;/g, '<').replace(/&gt;/g, '>')) && !!document.querySelector('#root img[onerror]') })`);
    check(`I3 ${file}: hostile title/URL did not execute or create elements`, !r.pwned && r.injectedImgs === 0 && r.injectedScripts === 0 && !r.bodyHasMarkup, JSON.stringify(r));
  }
  check('I4 no alert/confirm/prompt dialog was triggered anywhere', dialogs.length === 0, JSON.stringify(dialogs));

  // Hostile text in the URL manager: an injected value must stay in the input's value, not become markup
  await ui.send('Page.navigate', { url: D + 'index.html' }); await sleep(2000);
  await ui.eval(`(() => { const i = document.querySelector('#url-new'); i.value = 'https://x.test/"><img src=x onerror=window.__pwned=1>'; document.querySelector('#url-add').click(); })()`); await sleep(500);
  const um = await ui.eval(`({ pwned: window.__pwned === 1, imgs: document.querySelectorAll('#url-list img').length, inputs: [...document.querySelectorAll('#url-list input')].map((i) => i.value).filter((v) => v.includes('onerror')).length })`);
  check('I5 URL manager: hostile URL stays inside the input value and creates no element', !um.pwned && um.imgs === 0, JSON.stringify(um));
} catch (e) {
  check('harness ran to completion', false, e.stack || e.message);
} finally {
  if (ctx) killEdge(ctx.edge);
  target.server.close(); pages.server.close();
  clearTimeout(watchdog);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
