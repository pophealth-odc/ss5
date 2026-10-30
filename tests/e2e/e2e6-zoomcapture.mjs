// E2E 6: full-page capture accuracy across the whole supported zoom range (50-200%), optionally combined with a
// display scale (EDGE_SCALE). A perfect render of the 14-band test page has exactly 14 colour bands whose edges sit at
// multiples of 500 CSS px x (zoom x display scale).
import { stageExtension, startServer, startEdge, openPage, killEdge, EXT_ID, DASH_PATH, sleep } from './harness.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 500) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 420000);

const N = 14, SEC_H = 500, hue = (i) => (i * 25) % 360, DISPLAY = Number(process.env.EDGE_SCALE || 1);
const server = await startServer((req, res) => {
  const u = new URL(req.url, 'http://x'); res.setHeader('content-type', 'text/html');
  if (u.pathname.startsWith(DASH_PATH)) return res.end('<title>d</title>d');
  if (u.pathname === '/login') return res.end('<title>l</title>l');
  res.end(`<title>tall</title><body style="margin:0">${Array.from({ length: N }, (_, i) => `<div style="height:${SEC_H}px;background:hsl(${hue(i)},80%,55%)"></div>`).join('')}</body>`);
});
const A = `http://127.0.0.1:${server.port}`;
let ctx, dash;
const call = (msg) => dash.cdp.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', ${JSON.stringify({ v: 1, ...msg })}, (r) => res(r)))`);
const must = async (m) => { const r = await call(m); if (!r.ok) throw new Error(m.cmd + ': ' + JSON.stringify(r)); return r; };
const bands = (dataUrl) => dash.cdp.eval(`new Promise((res) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = 1; c.height = i.naturalHeight; const x = c.getContext('2d'); x.drawImage(i, Math.floor(i.naturalWidth / 2), 0, 1, i.naturalHeight, 0, 0, 1, i.naturalHeight); const d = x.getImageData(0, 0, 1, i.naturalHeight).data; const runs = []; let s = 0; for (let y = 1; y <= i.naturalHeight; y++) { const same = y < i.naturalHeight && d[y*4]===d[(y-1)*4] && d[y*4+1]===d[(y-1)*4+1] && d[y*4+2]===d[(y-1)*4+2]; if (!same) { runs.push([s, y - 1]); s = y; } } res({ h: i.naturalHeight, runs }); }; i.src = ${JSON.stringify(dataUrl)}; })`);

try {
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://127.0.0.1${DASH_PATH}*` }) });
  dash = await openPage(ctx.port, `${A}${DASH_PATH}index.html`);
  await must({ cmd: 'settings.save', payload: { settings: { loginUrl: `${A}/login`, allowHttp: true, pageDelaySeconds: 1, captureMode: 'full' } } });

  for (const zoom of [50, 75, 100, 125, 150, 175, 200]) {
    await must({ cmd: 'gallery.clear', payload: { confirm: true } });
    await must({ cmd: 'settings.save', payload: { settings: { zoomPercent: zoom } } });
    await must({ cmd: 'urls.save', payload: { urls: [`${A}/tall`] } });
    await must({ cmd: 'run.openLogin' }); await sleep(600); await must({ cmd: 'run.confirmLogin' });
    let st; for (let i = 0; i < 160; i++) { st = await call({ cmd: 'state.get' }); if (['completed', 'error', 'stopped'].includes(st.run.state)) break; await sleep(400); }
    const item = (await call({ cmd: 'gallery.list' })).items[0];
    if (!item) { check(`zoom ${zoom}%: a screenshot was produced`, false, JSON.stringify({ s: st.run.state, e: st.run.lastError, w: st.run.warnings, r: st.run.results })); continue; }
    const img = await bands((await call({ cmd: 'gallery.get', payload: { id: item.id } })).dataUrl);
    const scale = (zoom / 100) * DISPLAY;
    const fullH = N * SEC_H * scale;
    const LIMIT = 20000;                                  // FULLPAGE_LIMITS.maxHeightPx
    const warn = st.run.warnings.filter((w) => /zoom/i.test(w));
    if (fullH > LIMIT) {
      // Beyond the stitching limit the image must be cut AT the limit, and the user must be told (never a silent partial image).
      const bandsOk = img.runs.every(([a, b], k) => Math.abs(a - k * SEC_H * scale) <= 1.5);
      check(`zoom ${zoom}% x display ${DISPLAY}: page (${fullH}px) exceeds the ${LIMIT}px limit -> cut at the limit AND says so`,
        Math.abs(img.h - LIMIT) <= 1.5 && /taller than the stitching limit/i.test(item.note || '') && bandsOk && warn.length === 0,
        JSON.stringify({ h: img.h, note: item.note, bandsOk, warn }));
    } else {
      const worst = img.runs.reduce((m, [a, b], k) => Math.max(m, Math.abs(a - k * SEC_H * scale), Math.abs(b - ((k + 1) * SEC_H * scale - 1))), 0);
      check(`zoom ${zoom}% x display ${DISPLAY}: exactly ${N} bands, height ${fullH}, edges within 1px, mode=${item.mode}`,
        img.runs.length === N && Math.abs(img.h - fullH) <= 1.5 && worst <= 1.5 && item.mode === 'document' && warn.length === 0,
        JSON.stringify({ bands: img.runs.length, h: img.h, wantH: fullH, worst: +worst.toFixed(2), mode: item.mode, note: item.note, warn }));
    }
  }
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
