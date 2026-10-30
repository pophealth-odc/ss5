// E2E 2: the full workflow against a local site, driven ONLY through the dashboard->extension message API.
import { stageExtension, startServer, startEdge, openPage, killEdge, EXT_ID, DASH_PATH, sleep } from './harness.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 400) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 280000);

const hits = []; // every request the local site sees, in order (proves navigation order and "nothing before confirm")
const { server, port: P } = await startServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.push(u.pathname);
  res.setHeader('content-type', 'text/html');
  if (u.pathname.startsWith(DASH_PATH)) return res.end('<title>dash</title>dashboard stand-in');
  if (u.pathname === '/hang') return;                                    // never answers
  if (u.pathname === '/404') { res.statusCode = 404; return res.end('<title>nf</title>not found'); }
  if (u.pathname === '/expired') { res.statusCode = 302; res.setHeader('location', '/login?next=/expired'); return res.end(); }
  if (u.pathname === '/login') return res.end('<title>Sign in</title><form><input type="password"></form>');
  if (u.pathname === '/long') return res.end('<title>long</title><body style="margin:0">' + Array.from({ length: 12 }, (_, i) => `<div style="height:500px;background:hsl(${i * 30},70%,60%);font:32px sans-serif">Section ${i + 1}</div>`).join('') + '</body>');
  const n = u.pathname.replace('/', '') || 'home';
  res.end(`<title>Page ${n}</title><body style="margin:0;background:hsl(${(n.length * 47) % 360},60%,75%);font:48px sans-serif">Page ${n}</body>`);
});
const BASE = `http://127.0.0.1:${P}`;
let ctx, dash;
const call = (msg) => dash.cdp.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', ${JSON.stringify({ v: 1, ...msg })}, (r) => res(r || { lastError: chrome.runtime.lastError && chrome.runtime.lastError.message })))`);
const state = async () => (await call({ cmd: 'state.get' }));
const waitFor = async (pred, ms = 60000, label = '') => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await state(); if (pred(last)) return last; await sleep(300); } throw new Error('timeout waiting for ' + label + '; last state=' + JSON.stringify(last?.run && { s: last.run.state, a: last.run.action, e: last.run.lastError, n: last.run.nextIndex })); };

try {
  const dir = stageExtension({ pattern: `http://127.0.0.1${DASH_PATH}*` });
  ctx = await startEdge({ extDir: dir });
  dash = await openPage(ctx.port, `${BASE}${DASH_PATH}index.html`);

  // Settings for a quick run: 100% zoom (default), short delay.
  const urls = [`${BASE}/one`, `${BASE}/404`, `${BASE}/two`, `${BASE}/three`];
  const s1 = await call({ cmd: 'settings.save', payload: { settings: { loginUrl: `${BASE}/login-start`, allowHttp: true, pageDelaySeconds: 1, navigationTimeoutSeconds: 10, zoomPercent: 100 } } });
  check('S1 settings saved (http allowed for the local test site)', s1.ok, JSON.stringify(s1));
  const u1 = await call({ cmd: 'urls.save', payload: { urls } });
  check('S2 URL list saved in order', u1.ok && JSON.stringify(u1.urls) === JSON.stringify(urls.map((u) => new URL(u).href)), JSON.stringify(u1));

  // ---- login gate
  hits.length = 0;
  const earlyStart = await call({ cmd: 'run.start' });
  check('G1 start refused before login', !earlyStart.ok);
  const ol = await call({ cmd: 'run.openLogin' });
  check('G2 openLogin succeeds', ol.ok, JSON.stringify(ol));
  const waiting = await state();
  check('G3 state is waiting_login', waiting.run.state === 'waiting_login', waiting.run.state);
  check('G4 login page was actually requested', hits.includes('/login-start'), JSON.stringify(hits));
  check('G5 Edge window is maximised (as reported by Edge)', ol.maximized === true, JSON.stringify({ maximized: ol.maximized, warning: ol.warning }));
  await sleep(4000);
  check('G6 NOTHING from the URL list was requested while waiting for the user', !urls.some((u) => hits.includes(new URL(u).pathname)), JSON.stringify(hits));
  const startWhileWaiting = await call({ cmd: 'run.start' });
  check('G7 start still refused while waiting for confirmation', !startWhileWaiting.ok);
  const stillNone = await state();
  check('G8 still no gallery items and no navigation', stillNone.galleryCount === 0 && !urls.some((u) => hits.includes(new URL(u).pathname)));

  // ---- confirm TWICE concurrently: must start exactly one run
  const [c1, c2] = await Promise.all([call({ cmd: 'run.confirmLogin' }), call({ cmd: 'run.confirmLogin' })]);
  check('G9 exactly one of two simultaneous confirmations is accepted', [c1, c2].filter((c) => c.ok).length === 1, JSON.stringify([c1, c2]));

  const done = await waitFor((s) => ['completed', 'error', 'stopped'].includes(s.run.state), 90000, 'run to finish');
  check('R1 run completed', done.run.state === 'completed', done.run.state + ' ' + done.run.lastError);
  const order = hits.filter((p) => ['/one', '/404', '/two', '/three'].includes(p));
  check('R2 pages visited in configured order, each once', JSON.stringify(order) === JSON.stringify(['/one', '/404', '/two', '/three']), JSON.stringify(order));
  check('R3 progress counts: 3 captured, 1 failed, 4 results', done.run.captured === 3 && done.run.failed === 1 && done.run.results.length === 4, JSON.stringify({ c: done.run.captured, f: done.run.failed, n: done.run.results.length }));
  check('R4 the 404 page is recorded as failed with a clear reason', done.run.results[1].status === 'failed' && /404/.test(done.run.results[1].error), JSON.stringify(done.run.results[1]));
  check('R5 the failed page did not stop the run', done.run.results[2].status === 'ok' && done.run.results[3].status === 'ok');
  check('R6 progress is 100% when complete', done.run.progress.percent === 100 && done.run.progress.done === 4);

  // ---- gallery
  const gl = await call({ cmd: 'gallery.list' });
  check('Q1 gallery has 3 items (none for the failed page)', gl.ok && gl.items.length === 3, JSON.stringify(gl).slice(0, 200));
  const names = gl.items.map((i) => i.filename);
  check('Q2 filenames unique, sanitised, .png', new Set(names).size === 3 && names.every((n) => /^[\w.\-]+\.png$/.test(n)), JSON.stringify(names));
  check('Q3 each item has url, timestamp, status, thumbnail', gl.items.every((i) => i.url && i.capturedAt && i.status === 'ok' && /^data:image\/jpeg;base64,/.test(i.thumb || '')));
  const g1 = await call({ cmd: 'gallery.get', payload: { id: gl.items[0].id } });
  check('Q4 full image is a real PNG', g1.ok && g1.dataUrl.startsWith('data:image/png;base64,') && g1.dataUrl.length > 1000, (g1.dataUrl || '').slice(0, 40));
  const pngSig = await dash.cdp.eval(`(${JSON.stringify(g1.dataUrl)}).slice(22, 34)`);
  check('Q5 PNG signature present', pngSig.startsWith('iVBORw0KGgo'), pngSig);
  const dims = await dash.cdp.eval(`new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res('decode failed'); i.src = ${JSON.stringify(g1.dataUrl)}; })`);
  check('Q6 image decodes and has real dimensions', Array.isArray(dims) && dims[0] > 300 && dims[1] > 200, JSON.stringify(dims));
  const nonblank = await dash.cdp.eval(`new Promise((res) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; const x = c.getContext('2d'); x.drawImage(i, 0, 0, 40, 40); const d = x.getImageData(0, 0, 40, 40).data; let s = new Set(); for (let k = 0; k < d.length; k += 4) s.add(d[k] + ',' + d[k + 1] + ',' + d[k + 2]); res(s.size); }; i.src = ${JSON.stringify(g1.dataUrl)}; })`);
  check('Q7 image is not blank (has varied pixels)', nonblank > 1, String(nonblank));

  // ---- per-item delete + persistence of ids
  const del = await call({ cmd: 'gallery.delete', payload: { ids: [gl.items[2].id] } });
  const gl2 = await call({ cmd: 'gallery.list' });
  check('Q8 delete removes exactly one item and its data', del.ok && gl2.items.length === 2 && !gl2.items.some((i) => i.id === gl.items[2].id));
  const gone = await call({ cmd: 'gallery.get', payload: { id: gl.items[2].id } });
  check('Q9 deleted image is really gone', gone.ok === false && gone.code === 'not_found');
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
