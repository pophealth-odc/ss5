// UI 4: contrast of the TRANSIENT UI that is not on screen when idle: login panel (both variants), alert boxes,
// status pills, error text, toasts, progress states. These are rendered in the real page with the real stylesheet,
// then measured in light and dark mode.
import { stageExtension, startEdge, killEdge, sleep, Cdp } from './harness.mjs';
import { startPagesServer } from './pages-server.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 700) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 120000);

const pages = await startPagesServer({});
const D = `http://localhost:${pages.port}${pages.prefix}`;
let ctx;
try {
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://localhost${pages.prefix}*` }) });
  const tab = await (await fetch(`http://127.0.0.1:${ctx.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ui = await Cdp.connect(tab.webSocketDebuggerUrl);
  await ui.send('Page.enable');
  await ui.send('Page.navigate', { url: D + 'index.html' }); await sleep(1800);

  // Build every transient state from the REAL markup patterns used by the app.
  await ui.eval(`(() => {
    const host = document.createElement('div'); host.id = 'synthetic';
    host.innerHTML = \`
      <section class="card login-panel"><h2><span class="pulse"></span>Login confirmation</h2><p class="status-line">Status: Waiting for user login.</p><p>Complete your login and MFA in Microsoft Edge.</p><p class="hint">Sign in yourself on the real website.</p>
        <div class="btn-row"><button type="button" class="ok big">I'm Logged In — Continue Automation</button><button type="button" class="secondary big">Cancel</button></div></section>
      <div class="alert ok"><strong>OK</strong>Everything worked.</div>
      <div class="alert warn"><strong>Heads up</strong><ul><li>Zoom on page 2: Edge reported zoom 150%.</li></ul></div>
      <div class="alert bad" role="alert"><strong>The extension is not connected</strong>Reason text.<div class="actions"><a class="btn secondary small" href="#">Setup help</a></div></div>
      <div class="alert info"><strong>Info</strong>Some information.</div>
      <p class="error-text">Field error text</p><p class="hint">Hint text</p>
      <span class="pill ok">Captured</span> <span class="pill warn">Warn</span> <span class="pill bad">Failed</span> <span class="pill">Neutral</span>
      <span class="conn ok"><span class="dot"></span>Extension connected</span> <span class="conn bad"><span class="dot"></span>Extension not connected</span> <span class="conn warn"><span class="dot"></span>Busy</span>
      <div class="toast ok">Toast ok</div><div class="toast bad">Toast bad</div>
      <div class="seg"><button type="button" aria-pressed="true">15 s</button><button type="button" aria-pressed="false">3 s</button></div>
      <button type="button" class="danger">Delete</button> <button type="button" class="secondary">Secondary</button> <button type="button">Primary</button> <button type="button" disabled>Disabled</button>
      <dl class="facts"><dt>Label</dt><dd>Value</dd></dl><div class="empty">Empty state</div>\`;
    document.querySelector('#page').prepend(host);
  })()`);

  const measure = (scheme) => ui.eval(`(() => {
    const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const bad = []; let n = 0;
    document.querySelectorAll('#synthetic *').forEach((el) => {
      const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      if (!own || el.disabled) return;                       // disabled controls are exempt under WCAG
      const cs = getComputedStyle(el); const fg = parse(cs.color); const bg = bgOf(el); if (!fg) return;
      const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700, need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
      n++; const rr = ratio(fg, bg); if (rr < need) bad.push((el.className || el.tagName) + ' "' + el.textContent.trim().slice(0, 22) + '" ' + rr.toFixed(2) + ' < ' + need);
    });
    // UI component boundaries (WCAG 1.4.11, 3:1): focus ring colour against the page
    const ring = parse(getComputedStyle(document.documentElement).getPropertyValue('--focus').trim().startsWith('#') ? (() => { const h = getComputedStyle(document.documentElement).getPropertyValue('--focus').trim().slice(1); return 'rgb(' + [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16)).join(',') + ')'; })() : 'rgb(0,0,0)');
    const ringRatio = ratio(ring, parse(getComputedStyle(document.body).backgroundColor));
    return { checked: n, bad, ringRatio: +ringRatio.toFixed(2) };
  })()`);

  for (const scheme of ['light', 'dark']) {
    await ui.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await sleep(250);
    const r = await measure(scheme);
    check(`transient UI text contrast meets WCAG AA in ${scheme} mode (${r.checked} elements checked)`, r.bad.length === 0, JSON.stringify(r.bad));
    check(`focus ring is >= 3:1 against the page in ${scheme} mode`, r.ringRatio >= 3, String(r.ringRatio));
  }
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
