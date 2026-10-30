// E2E 4: full-page capture. Does it really produce the whole page? Verified by DECODING the PNG and sampling pixels.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageExtension, startServer, startEdge, openPage, killEdge, EXT_ID, DASH_PATH, sleep } from './harness.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 700) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 300000);

const N = 14, SEC_H = 500;                        // 14 coloured sections, 500px each => 7000px document
const hue = (i) => (i * 25) % 360;
const server = await startServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html');
  if (u.pathname.startsWith(DASH_PATH)) return res.end('<title>dash</title>dash');
  if (u.pathname === '/login') return res.end('<title>login</title>login');
  const sections = Array.from({ length: N }, (_, i) => `<div style="height:${SEC_H}px;background:hsl(${hue(i)},80%,55%);font:40px sans-serif;color:#fff">Section ${i + 1}</div>`).join('');
  if (u.pathname === '/tall') return res.end(`<title>tall</title><body style="margin:0"><header style="position:fixed;top:0;left:0;right:0;height:60px;background:#000;color:#fff;font:24px sans-serif;z-index:9">STICKY HEADER</header>${sections}</body>`);
  if (u.pathname === '/short') return res.end('<title>short</title><body style="margin:0;background:#fc0;height:120px">short page</body>');
  if (u.pathname === '/shell') return res.end(`<title>shell</title><body style="margin:0;overflow:hidden"><div style="height:60px;background:#000;color:#fff;font:24px sans-serif">APP HEADER</div><div style="position:absolute;top:60px;left:0;right:0;bottom:0;overflow-y:auto">${sections}</div></body>`);
  res.end('<title>x</title>x');
});
const A = `http://127.0.0.1:${server.port}`;
let ctx, dash;
const call = (msg) => dash.cdp.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', ${JSON.stringify({ v: 1, ...msg })}, (r) => res(r)))`);
const waitFor = async (pred, ms, label) => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await call({ cmd: 'state.get' }); if (pred(last)) return last; await sleep(300); } throw new Error('timeout ' + label + ' ' + JSON.stringify(last?.run?.action)); };

// Decode a PNG data URL inside the dashboard page and sample the pixel at (x,y)
// Probe y values are written in CSS pixels; `scale` (display scale: device px per CSS px) converts them to image pixels.
// Run with EDGE_SCALE=1.25 / 1.5 to check behaviour on scaled Windows displays.
const analyse = (dataUrl, probes, scale = 1) => dash.cdp.eval(`new Promise((res) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const x = c.getContext('2d'); x.drawImage(i, 0, 0); const px = ${JSON.stringify(probes)}.map(([fx, fy]) => { const d = x.getImageData(Math.min(c.width - 1, Math.floor(fx * c.width)), Math.min(c.height - 1, Math.floor(fy * ${scale})), 1, 1).data; return [d[0], d[1], d[2]]; }); res({ w: i.naturalWidth, h: i.naturalHeight, px }); }; i.onerror = () => res({ error: 'decode failed' }); i.src = ${JSON.stringify(dataUrl)}; })`);
const SCALE = Number(process.env.EDGE_SCALE || 1);
const hsl = (h, s, l) => { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))]; };
const near = (p, q, tol = 14) => p.every((v, i) => Math.abs(v - q[i]) <= tol);

try {
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://127.0.0.1${DASH_PATH}*` }) });
  dash = await openPage(ctx.port, `${A}${DASH_PATH}index.html`);
  const must = async (m) => { const r = await call(m); if (!r.ok) throw new Error(m.cmd + ': ' + JSON.stringify(r)); return r; };
  await must({ cmd: 'settings.save', payload: { settings: { loginUrl: `${A}/login`, allowHttp: true, pageDelaySeconds: 1, navigationTimeoutSeconds: 15, zoomPercent: 100, captureMode: 'full' } } });
  await must({ cmd: 'urls.save', payload: { urls: [`${A}/tall`, `${A}/short`, `${A}/shell`] } });
  await must({ cmd: 'run.openLogin' }); await sleep(800); await must({ cmd: 'run.confirmLogin' });
  const done = await waitFor((s) => ['completed', 'error', 'stopped'].includes(s.run.state), 120000, 'full-page run');
  check('F0 run completed with 3 captures', done.run.state === 'completed' && done.run.captured === 3, JSON.stringify({ s: done.run.state, c: done.run.captured, f: done.run.failed, e: done.run.lastError, w: done.run.warnings }));

  const list = (await call({ cmd: 'gallery.list' })).items;
  const by = (p) => list.find((i) => i.url.endsWith(p));
  const get = async (it) => (await call({ cmd: 'gallery.get', payload: { id: it.id } })).dataUrl;

  // ---- tall document page
  const tall = by('/tall'); const tImg = await analyse(await get(tall), []);
  const expectedH = N * SEC_H;                                   // CSS px
  check(`F1 tall page: image is the WHOLE document height (${expectedH} CSS px x display scale ${SCALE}), not one screen`, Math.abs(tImg.h - expectedH * SCALE) <= 4, JSON.stringify({ got: tImg.h, want: expectedH * SCALE, mode: tall.mode, note: tall.note }));
  check('F2 recorded as a real full-page capture, not truncated', tall.mode === 'document' && !/cut at/i.test(tall.note || ''), JSON.stringify({ mode: tall.mode, note: tall.note }));
  // sample the middle of every section, well away from stitch seams and from the sticky header band
  const probes = Array.from({ length: N }, (_, i) => [0.5, i * SEC_H + SEC_H / 2 + 120]);
  const tp = await analyse(await get(tall), probes, SCALE);
  const wrong = tp.px.map((p, i) => ({ i: i + 1, got: p, want: hsl(hue(i), 80, 55) })).filter((x) => !near(x.got, x.want));
  check('F3 every one of the 14 sections appears in the right place and order (pixel-verified)', wrong.length === 0, JSON.stringify(wrong.slice(0, 3)));
  // sections must be contiguous: look right at each stitch boundary row for a seam/gap/duplicate
  const seamProbes = []; for (let y = 600; y < expectedH - 20; y += 600) seamProbes.push([0.5, y - 1], [0.5, y], [0.5, y + 1]);
  const sp = await analyse(await get(tall), seamProbes, SCALE);
  const seamBad = [];
  for (let k = 0; k < sp.px.length; k++) { const y = seamProbes[k][1]; const sec = Math.min(N - 1, Math.floor(y / SEC_H)); if (y > 80 && !near(sp.px[k], hsl(hue(sec), 80, 55), 16)) seamBad.push({ y, got: sp.px[k], want: hsl(hue(sec), 80, 55) }); }
  check('F4 no seams, gaps or duplicated strips at stitch boundaries', seamBad.length === 0, JSON.stringify(seamBad.slice(0, 3)));
  // sticky header: black at the very top once, NOT repeated further down
  const hp = await analyse(await get(tall), [[0.5, 20], [0.5, 700], [0.5, 1400], [0.5, 3000]], SCALE);
  check('F5 fixed header appears once at the top and is not repeated in the middle of the page', near(hp.px[0], [0, 0, 0], 20) && hp.px.slice(1).every((p) => !near(p, [0, 0, 0], 20)), JSON.stringify(hp.px));

  // ---- short page: honest about what it is
  const sh = by('/short'); const shImg = await analyse(await get(sh), []);
  check('F6 page that fits on screen is reported honestly as visible-area only', sh.mode === 'visible-only' && shImg.h < 700 * SCALE, JSON.stringify({ mode: sh.mode, h: shImg.h }));

  // ---- app shell: only an inner panel scrolls
  const shell = by('/shell'); const sImg = await analyse(await get(shell), []);
  check('F7 app-shell page: the inner scrolling panel is stitched (image taller than a screen)', shell.mode === 'element' && sImg.h > 3000, JSON.stringify({ mode: shell.mode, h: sImg.h, note: shell.note }));
  const sp2 = await analyse(await get(shell), [[0.5, 20], ...Array.from({ length: 6 }, (_, i) => [0.5, 60 + i * 1000 + SEC_H / 2 + 30])], SCALE);
  const shellOk = near(sp2.px[0], [0, 0, 0], 20) && [0, 1, 2, 3, 4, 5].every((k) => near(sp2.px[k + 1], hsl(hue(Math.floor((k * 1000 + SEC_H / 2 + 30) / SEC_H)), 80, 55), 16));
  check('F8 app-shell: header on top, then the panel sections in order', shellOk, JSON.stringify(sp2.px));
  // F9: restoration. Scroll a page partway down, run the real captureFullPage on it, then read back what it left behind.
  // import() is not allowed in a service worker, so run the REAL module from an extension page (same origin, same chrome.* APIs).
  const extPage = await openPage(ctx.port, `chrome-extension://${EXT_ID}/popup.html`);
  const rest = await extPage.cdp.eval(`(async () => {
    const { captureFullPage } = await import(chrome.runtime.getURL('lib/fullpage.js'));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const w = await chrome.windows.create({ url: ${JSON.stringify(A + '/tall')}, focused: true, state: 'maximized' });
    const tabId = w.tabs[0].id; await sleep(1500);
    const read = async () => (await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ y: Math.round(scrollY), header: getComputedStyle(document.querySelector('header')).visibility, leftover: !!window.__essaFP }) }))[0].result;
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.scrollTo(0, 2345); } }); await sleep(400);
    const before = await read();
    const r = await captureFullPage(tabId, w.id, {});
    const after = await read();
    await chrome.windows.remove(w.id);
    return { before, after, h: (await createImageBitmap(r.blob)).height, mode: r.mode };
  })()`);
  check('F9a before capture: page scrolled to y=2345 with a visible header (test setup is real)', rest.before.y === 2345 && rest.before.header === 'visible', JSON.stringify(rest.before));
  check('F9b after capture: scroll position restored to y=2345', rest.after.y === 2345, JSON.stringify(rest.after));
  check('F9c after capture: the fixed header is visible again and no helper state is left on the page', rest.after.header === 'visible' && rest.after.leftover === false, JSON.stringify(rest.after));
  check('F9d that capture was a full-page one', rest.h > 6900 * SCALE && rest.mode === 'document', JSON.stringify({ h: rest.h, mode: rest.mode }));
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
