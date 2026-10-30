// UI 6: the extension's own pages (options + popup) - the README sends users there to diagnose problems, so they must
// tell the truth: "Not set up yet" for the shipped placeholder, "Configured" + the address when set, a working
// "delete all data", and no errors.
import { stageExtension, startServer, startEdge, openPage, killEdge, EXT_ID, DASH_PATH, sleep, Cdp } from './harness.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 500) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 150000);

const server = await startServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>t</title>t'); });
const A = `http://127.0.0.1:${server.port}`;
let ctx;
const watchErrors = (cdp, sink) => cdp.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') sink.push('EXC ' + m.params.exceptionDetails.exception?.description); if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') sink.push(m.params.entry.text); });

try {
  // ---- A: the shipped manifest (placeholder)
  ctx = await startEdge({ extDir: stageExtension() });
  let errs = [];
  let page = await openPage(ctx.port, `chrome-extension://${EXT_ID}/options.html`);
  watchErrors(page.cdp, errs); await page.cdp.send('Runtime.enable'); await page.cdp.send('Log.enable'); await page.cdp.send('Page.reload'); await sleep(1500);
  let t = await page.cdp.eval(`({ status: document.querySelector('#trust-status').textContent, cls: document.querySelector('#trust-status').className, detail: document.querySelector('#trust-detail').textContent })`);
  check('X1 options page: shipped placeholder is reported as "Not set up yet" with the instruction', t.status === 'Not set up yet' && /YOUR-GITHUB-USERNAME/.test(t.detail) && /warn/.test(t.cls), JSON.stringify(t));
  const pop = await openPage(ctx.port, `chrome-extension://${EXT_ID}/popup.html`);
  watchErrors(pop.cdp, errs); await pop.cdp.send('Runtime.enable'); await pop.cdp.send('Log.enable'); await pop.cdp.send('Page.reload'); await sleep(1500);
  const p1 = await pop.cdp.eval(`({ state: document.querySelector('#state').textContent, dash: document.querySelector('#dash').textContent, noteHidden: document.querySelector('#note').hidden, noteText: document.querySelector('#note').textContent, openHidden: document.querySelector('#open').hidden })`);
  check('X2 popup: shows "not set up", explains why, offers no link to a dashboard', p1.dash === 'not set up' && !p1.noteHidden && /placeholder|YOUR-GITHUB/i.test(p1.noteText) && p1.openHidden, JSON.stringify(p1));
  check('X3 popup shows the extension status (Idle) even when the dashboard is not configured', /Idle/.test(p1.state), p1.state);
  check('X4 no errors in either page (shipped manifest)', errs.length === 0, JSON.stringify(errs));
  killEdge(ctx.edge); ctx = null;

  // ---- B: configured
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://127.0.0.1${DASH_PATH}*` }) });
  errs = [];
  const dash = await openPage(ctx.port, `${A}${DASH_PATH}index.html`);
  const call = (msg) => dash.cdp.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', ${JSON.stringify({ v: 1, ...msg })}, (r) => res(r)))`);
  await call({ cmd: 'settings.save', payload: { settings: { loginUrl: `${A}/login`, allowHttp: true, pageDelaySeconds: 1 } } });
  await call({ cmd: 'urls.save', payload: { urls: [`${A}/a`] } });
  await call({ cmd: 'run.openLogin' }); await sleep(800); await call({ cmd: 'run.confirmLogin' });
  for (let i = 0; i < 60; i++) { if ((await call({ cmd: 'state.get' })).run.state === 'completed') break; await sleep(400); }

  page = await openPage(ctx.port, `chrome-extension://${EXT_ID}/options.html`);
  watchErrors(page.cdp, errs); await page.cdp.send('Runtime.enable'); await page.cdp.send('Log.enable'); await page.cdp.send('Page.reload'); await sleep(1500);
  t = await page.cdp.eval(`({ status: document.querySelector('#trust-status').textContent, cls: document.querySelector('#trust-status').className, detail: document.querySelector('#trust-detail').textContent, count: document.querySelector('#count').textContent })`);
  check('X5 options page: configured address is shown as "Configured" with the exact origin and path', t.status === 'Configured' && /ok/.test(t.cls) && t.detail.includes(`http://127.0.0.1${DASH_PATH}`), JSON.stringify(t));
  check('X6 options page shows the real number of stored screenshots', t.count === '1', t.count);

  // delete-all through the page (confirm() is a native dialog: auto-accept it)
  page.cdp.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') page.cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
  await page.cdp.send('Page.enable');
  await page.cdp.eval(`document.querySelector('#clear').click()`); await sleep(1500);
  const after = await call({ cmd: 'state.get' });
  const msg = await page.cdp.eval(`document.querySelector('#clear-msg').textContent`);
  check('X7 "Delete all stored data" removes screenshots, URLs and settings, and says so', after.galleryCount === 0 && after.urls.length === 0 && after.settings.loginUrl === 'https://aaj23525.apps.dynatrace.com/' && /deleted/i.test(msg), JSON.stringify({ n: after.galleryCount, u: after.urls, l: after.settings.loginUrl, msg }));
  check('X8 no errors on the options page (configured)', errs.length === 0, JSON.stringify(errs));

  // popup link goes to the configured dashboard
  const pop2 = await openPage(ctx.port, `chrome-extension://${EXT_ID}/popup.html`); await sleep(1200);
  const p2 = await pop2.cdp.eval(`({ href: document.querySelector('#open').href, hidden: document.querySelector('#open').hidden, dash: document.querySelector('#dash').textContent })`);
  check('X9 popup links to the configured dashboard', !p2.hidden && p2.href === `http://127.0.0.1${DASH_PATH}` && p2.dash === '127.0.0.1', JSON.stringify(p2));
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
