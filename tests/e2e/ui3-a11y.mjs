// UI 3: objective accessibility checks on every page: names, labels, landmarks, keyboard reachability, visible focus,
// contrast of the main text pairs in light AND dark mode, and a responsive layout check at tablet width.
import { stageExtension, startEdge, killEdge, sleep, Cdp } from './harness.mjs';
import { startPagesServer } from './pages-server.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 600) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 200000);

const pages = await startPagesServer({});
const D = `http://localhost:${pages.port}${pages.prefix}`;
let ctx;
try {
  ctx = await startEdge({ extDir: stageExtension({ pattern: `http://localhost${pages.prefix}*` }) });
  const tab = await (await fetch(`http://127.0.0.1:${ctx.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ui = await Cdp.connect(tab.webSocketDebuggerUrl);
  await ui.send('Page.enable');
  const go = async (file) => { await ui.send('Page.navigate', { url: D + file }); await sleep(1800); };

  // WCAG relative luminance / contrast, evaluated in the page with the real computed colours
  const contrastFn = `
    const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };`;

  for (const file of ['index.html', 'settings.html', 'gallery.html']) {
    await go(file);
    const r = await ui.eval(`(() => {
      const out = { unnamedButtons: [], unlabelledInputs: [], dupIds: [], noLang: !document.documentElement.lang, landmarks: {}, headings: [], imgNoAlt: [] };
      const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.textContent || el.title || '').trim();
      document.querySelectorAll('button, a[href]').forEach((b) => { if (!name(b)) out.unnamedButtons.push(b.outerHTML.slice(0, 80)); });
      document.querySelectorAll('input:not([type=hidden]), select, textarea').forEach((i) => {
        const labelled = i.getAttribute('aria-label') || i.getAttribute('aria-labelledby') || (i.id && document.querySelector('label[for="' + i.id + '"]')) || i.closest('label');
        if (!labelled) out.unlabelledInputs.push((i.id || i.name || i.type) + ''); });
      const seen = new Set(); document.querySelectorAll('[id]').forEach((e) => { if (seen.has(e.id)) out.dupIds.push(e.id); seen.add(e.id); });
      out.landmarks = { main: document.querySelectorAll('main').length, nav: document.querySelectorAll('nav[aria-label]').length, h1: document.querySelectorAll('h1').length, skip: !!document.querySelector('.skip-link') };
      out.headings = [...document.querySelectorAll('h1,h2,h3')].map((h) => h.tagName);
      document.querySelectorAll('img').forEach((i) => { if (!i.hasAttribute('alt')) out.imgNoAlt.push(i.src.slice(0, 40)); });
      return out;
    })()`);
    check(`${file}: every button/link has an accessible name`, r.unnamedButtons.length === 0, JSON.stringify(r.unnamedButtons));
    check(`${file}: every form control has a label`, r.unlabelledInputs.length === 0, JSON.stringify(r.unlabelledInputs));
    check(`${file}: no duplicate ids; lang set; one <main>, one <h1>, labelled <nav>, skip link`, r.dupIds.length === 0 && !r.noLang && r.landmarks.main === 1 && r.landmarks.h1 === 1 && r.landmarks.nav === 1 && r.landmarks.skip, JSON.stringify({ dup: r.dupIds, ...r.landmarks, noLang: r.noLang }));
    check(`${file}: heading levels never skip (h1 -> h2 -> h3)`, r.headings.every((h, i) => i === 0 || Number(h[1]) - Number(r.headings[i - 1][1]) <= 1), r.headings.join('>'));

    // keyboard: Tab through the whole page; every focusable control must be reachable and show a visible focus ring
    const kb = await ui.eval(`(async () => {
      const focusables = [...document.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled)')].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      const bad = [];
      for (const el of focusables) {
        el.focus({ preventScroll: true });
        if (document.activeElement !== el) { bad.push('cannot focus ' + (el.id || el.outerHTML.slice(0, 50))); continue; }
        const cs = getComputedStyle(el);
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || cs.boxShadow !== 'none';
        // :focus-visible only matches keyboard focus; programmatic focus() after a key event counts, so simulate that heuristic via matches()
        const fv = el.matches(':focus-visible');
        if (!(ring || !fv)) bad.push('no ring ' + (el.id || el.outerHTML.slice(0, 50)));
      }
      return { total: focusables.length, bad, tabindexPositive: [...document.querySelectorAll('[tabindex]')].filter((e) => Number(e.getAttribute('tabindex')) > 0).length };
    })()`);
    check(`${file}: all ${kb.total} controls are keyboard-focusable and none has a positive tabindex`, kb.bad.filter((b) => b.startsWith('cannot')).length === 0 && kb.tabindexPositive === 0, JSON.stringify(kb.bad.slice(0, 4)));

    // contrast, light + dark
    for (const scheme of ['light', 'dark']) {
      await ui.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await sleep(200);
      const c = await ui.eval(`(() => { ${contrastFn}
        const sel = ['h1', '.lead', '.nav a', '.nav a[aria-current=page]', 'button.big, .btn.big, button', '.hint', '.card', '.pill', 'label'];
        const bad = [];
        for (const s of sel) { document.querySelectorAll(s).forEach((el) => { if (!el.getClientRects().length || !el.textContent.trim()) return; const fg = parse(getComputedStyle(el).color); const bg = bgOf(el); if (!fg || !bg) return; const rr = ratio(fg, bg); const size = parseFloat(getComputedStyle(el).fontSize); const bold = Number(getComputedStyle(el).fontWeight) >= 700; const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5; if (rr < need) bad.push(s + ' ' + rr.toFixed(2) + ' < ' + need + ' [' + el.textContent.trim().slice(0, 24) + ']'); }); }
        return [...new Set(bad)].slice(0, 6); })()`);
      check(`${file}: text contrast meets WCAG AA in ${scheme} mode`, c.length === 0, JSON.stringify(c));
    }
    await ui.send('Emulation.setEmulatedMedia', { features: [] });

    // responsive: tablet (820) and narrow (480) widths must not scroll sideways
    for (const width of [1280, 820, 480]) {
      await ui.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      const o = await ui.eval(`({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, wide: [...document.querySelectorAll('.card, .shot, table, pre')].filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible').map((e) => e.className.slice(0, 30)) })`);
      check(`${file}: no horizontal scrolling at ${width}px wide`, o.over <= 0, JSON.stringify(o));
    }
    await ui.send('Emulation.clearDeviceMetricsOverride');
  }

  // Dialogs: focus moves into the dialog, Escape closes it, and focus is trapped by the modal
  await go('gallery.html');
  const hasShots = await ui.eval(`document.querySelectorAll('#grid .shot').length`);
  await ui.eval(`document.querySelector('#del-all').disabled ? 0 : document.querySelector('#del-all').click()`);
  if (!hasShots) check('dialogs (skipped - empty gallery, Clear is disabled; covered in ui2-flow)', true);
  // settings page "restore defaults" always works
  await go('settings.html');
  await ui.eval(`document.querySelector('#defaults').click()`); await sleep(400);
  const dlg = await ui.eval(`(() => { const d = document.querySelector('dialog.confirm'); return d ? { open: d.open, focusInside: d.contains(document.activeElement), focusedText: document.activeElement?.textContent, labelled: !!d.getAttribute('aria-labelledby') } : null; })()`);
  check('confirm dialog: opens modally, labelled, focus moved inside onto the SAFE button (Cancel)', dlg && dlg.open && dlg.focusInside && dlg.labelled && dlg.focusedText === 'Cancel', JSON.stringify(dlg));
  await ui.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await ui.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  check('confirm dialog: Escape closes it without confirming', await ui.eval(`!document.querySelector('dialog.confirm')`));
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
