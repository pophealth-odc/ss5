// Full-page capture by scroll-and-stitch.
//
// How it works
//   1. Inject pagePrepare() to find what scrolls: the document, or (for app-shell pages where the document
//      itself does not scroll) the one large inner scroll container.
//   2. Scroll to the top, capture a tile, scroll down one viewport, capture again ... until the end.
//      Each tile is drawn at its REAL scroll offset (read back after scrolling), so the clamped last tile
//      overlaps the previous one instead of leaving a gap.
//   3. After the first tile, position:fixed / position:sticky elements are hidden (visibility only, so layout
//      does not move) so a header is not repeated on every tile. They therefore appear once, in the first screen.
//   4. Everything is restored in `finally`: scroll position and hidden elements.
//
// Known limits (also listed in the README): content inside cross-origin iframes is not scrolled; lazy-loaded
// content only appears if it loads within the settle time; very tall pages are cut at FULLPAGE_LIMITS and the
// result says so (`truncated`); a visible scrollbar thumb can show in each tile.

import { captureVisible, sleep } from './capture.js';

export const FULLPAGE_LIMITS = Object.freeze({
  maxTiles: 80,
  maxHeightPx: 20000,       // device pixels
  maxPixels: 80_000_000,    // width * height
  settleMs: 300,
});

/* ---------- functions injected into the page (serialised: they must not use anything outside themselves) ---------- */

function pagePrepare() {
  const undoOld = (o) => {
    for (const h of (o && o.hidden) || []) {
      try { if (h.value) h.el.style.setProperty('visibility', h.value, h.priority); else h.el.style.removeProperty('visibility'); } catch (e) { /* element gone */ }
    }
  };
  undoOld(window.__essaFP); // leftovers from an interrupted earlier run

  const docEl = document.scrollingElement || document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let target = null;

  if (docEl.scrollHeight <= docEl.clientHeight + 2 && document.body) {
    let best = null;
    let bestArea = 0;
    let seen = 0;
    for (const e of [document.body, ...document.body.querySelectorAll('*')]) { // body itself can be the scroller
      if (++seen > 20000) break;
      if (e.clientHeight < 100 || e.scrollHeight <= e.clientHeight + 2) continue;
      const oy = getComputedStyle(e).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const r = e.getBoundingClientRect();
      const w = Math.min(r.right, vw) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (w > 0 && h > 0 && w * h > bestArea) { best = e; bestArea = w * h; }
    }
    if (best && bestArea >= 0.3 * vw * vh) target = best;
  }

  const el = target || docEl;
  const r = target ? target.getBoundingClientRect() : null;
  const bgOf = (n) => {
    for (let x = n; x; x = x.parentElement) {
      const c = getComputedStyle(x).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
    }
    return '#ffffff';
  };
  window.__essaFP = { target, startTop: el.scrollTop, startLeft: el.scrollLeft, hidden: [] };
  return {
    mode: target ? 'element' : 'document',
    dpr: window.devicePixelRatio,   // exact device pixels per CSS pixel (browser zoom x display scale); image width / innerWidth is only an estimate
    innerWidth: vw,
    innerHeight: vh,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    rect: target
      ? { left: r.left + target.clientLeft, top: r.top + target.clientTop, width: target.clientWidth, height: target.clientHeight }
      : { left: 0, top: 0, width: vw, height: el.clientHeight },
    bg: bgOf(target || document.body || docEl),
  };
}

async function pageScroll(y, settleMs) {
  const s = window.__essaFP;
  const el = (s && s.target) || document.scrollingElement || document.documentElement;
  el.scrollTo({ top: y, behavior: 'instant' }); // 'instant' beats CSS scroll-behavior: smooth
  await new Promise((resolve) => {
    let frames = 0;
    const tick = () => { if (++frames >= 2) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(resolve, settleMs); // rAF can be throttled in background windows
  });
  return { top: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, dpr: window.devicePixelRatio };
}

function pageHideFloating() {
  const s = window.__essaFP;
  if (!s) return 0;
  let n = 0;
  let seen = 0;
  for (const e of document.querySelectorAll('*')) {
    if (++seen > 30000) break;
    if (s.target && e.contains(s.target)) continue; // never hide the scroller or anything that holds it
    const p = getComputedStyle(e).position;
    if (p !== 'fixed' && p !== 'sticky') continue;
    s.hidden.push({ el: e, value: e.style.getPropertyValue('visibility'), priority: e.style.getPropertyPriority('visibility') });
    e.style.setProperty('visibility', 'hidden', 'important');
    n++;
  }
  return n;
}

function pageRestore() {
  const s = window.__essaFP;
  if (!s) return false;
  for (const h of s.hidden) {
    try { if (h.value) h.el.style.setProperty('visibility', h.value, h.priority); else h.el.style.removeProperty('visibility'); } catch (e) { /* element gone */ }
  }
  const el = s.target || document.scrollingElement || document.documentElement;
  try { el.scrollTo({ top: s.startTop, left: s.startLeft, behavior: 'instant' }); } catch (e) { /* ignore */ }
  delete window.__essaFP;
  return true;
}

/* ---------- orchestration (runs in the service worker) ---------- */

/**
 * Capture the whole scrollable page of `tabId` (which must be the active tab of `windowId`).
 * Returns { blob, mode, tiles, truncated, note, width, height } - `mode` says what was really produced:
 *   'document'     stitched from the page's own scrolling
 *   'element'      stitched from a large inner scroll container (the rest of the screen taken from the first tile)
 *   'visible-only' nothing scrollable was found / needed, so this is just the visible area
 */
export async function captureFullPage(tabId, windowId, { signal, settleMs = FULLPAGE_LIMITS.settleMs } = {}) {
  const inject = async (func, args = []) => (await chrome.scripting.executeScript({ target: { tabId }, func, args }))?.[0]?.result;

  const m = await inject(pagePrepare);
  if (!m) throw new Error('Could not inspect the page (it may have navigated or been closed).');

  try {
    if (m.scrollHeight <= m.clientHeight + 2) {
      const blob = await captureVisible(windowId, signal);
      return {
        blob, mode: 'visible-only', tiles: 1, truncated: false,
        note: 'No page scrolling was needed or detected, so this is the visible area. Content that scrolls inside frames or small panels is not stitched.',
      };
    }

    await inject(pageScroll, [0, settleMs]);
    await sleep(settleMs, signal);

    let canvas = null;
    let ctx = null;
    let scale = 1;
    let widthDev = 0;
    let maxHeightDev = FULLPAGE_LIMITS.maxHeightPx;
    let bandTop = 0;            // element mode: device-px top of the scroller inside the viewport
    let bottomBand = null;      // element mode: everything below the scroller, taken from tile 0
    let scrollHeight = m.scrollHeight;
    let tiles = 0;
    let truncated = false;

    const wantedHeight = () => {
      const content = Math.round(scrollHeight * scale);
      return m.mode === 'element' ? bandTop + content + (bottomBand ? bottomBand.height : 0) : content;
    };

    const ensureCanvas = () => {
      let h = wantedHeight();
      if (h > maxHeightDev) { h = maxHeightDev; truncated = true; }
      if (canvas && canvas.height >= h) return;
      const next = new OffscreenCanvas(widthDev, h);
      const nctx = next.getContext('2d');
      if (!nctx) throw new Error('The page is too large to stitch in memory.');
      nctx.fillStyle = m.bg;
      nctx.fillRect(0, 0, widthDev, h);
      if (canvas) nctx.drawImage(canvas, 0, 0);
      canvas = next;
      ctx = nctx;
    };

    let want = 0;
    for (let i = 0; i < FULLPAGE_LIMITS.maxTiles; i++) {
      const s = await inject(pageScroll, [want, settleMs]);
      if (!s) throw new Error('The page changed while it was being captured.');
      scrollHeight = Math.max(scrollHeight, s.scrollHeight);
      await sleep(settleMs, signal);

      const bmp = await createImageBitmap(await captureVisible(windowId, signal));
      const tileHeight = bmp.height; // a closed ImageBitmap reports 0, so read it now
      try {
        if (i === 0) {
          // The page's own devicePixelRatio is exact. Image width / innerWidth is not (innerWidth is rounded to a whole
          // CSS pixel), and that small error multiplies by the scroll offset and shifts every later tile.
          scale = m.dpr > 0 ? m.dpr : bmp.width / m.innerWidth;
          widthDev = bmp.width;
          maxHeightDev = Math.min(FULLPAGE_LIMITS.maxHeightPx, Math.floor(FULLPAGE_LIMITS.maxPixels / widthDev));
          if (m.mode === 'element') {
            bandTop = Math.min(bmp.height, Math.max(0, Math.round(m.rect.top * scale)));
            const bandBottom = Math.min(bmp.height, bandTop + Math.round(m.rect.height * scale));
            if (bandBottom < bmp.height) bottomBand = await createImageBitmap(bmp, 0, bandBottom, bmp.width, bmp.height - bandBottom);
          }
        }
        ensureCanvas();

        if (m.mode === 'document') {
          ctx.drawImage(bmp, 0, Math.round(s.top * scale));
        } else {
          const sx = Math.max(0, Math.round(m.rect.left * scale));
          const sw = Math.min(bmp.width - sx, Math.round(m.rect.width * scale));
          const sh = Math.min(bmp.height - bandTop, Math.round(m.rect.height * scale));
          const dy = bandTop + Math.round(s.top * scale);
          if (i === 0) ctx.drawImage(bmp, 0, 0, bmp.width, bandTop + sh, 0, 0, bmp.width, bandTop + sh); // header + first view, full width
          else ctx.drawImage(bmp, sx, bandTop, sw, sh, sx, dy, sw, sh);
        }
        tiles++;
      } finally {
        bmp.close();
      }

      if (i === 0) await inject(pageHideFloating);

      const maxTop = s.scrollHeight - s.clientHeight;
      if (s.top >= maxTop - 1) break;                      // reached the end
      if (canvas.height >= maxHeightDev && wantedHeight() > maxHeightDev && Math.round(s.top * scale) + tileHeight >= maxHeightDev) { truncated = true; break; }
      // Step by LESS than one visible tile, so neighbouring tiles always overlap by a few pixels and can never leave a
      // gap. clientHeight is a rounded integer while the real viewport is fractional at non-100% zoom (323 vs 323.33
      // CSS px), so stepping by the full clientHeight would skip a pixel row per tile and show the white canvas.
      const tileCss = tileHeight / scale;                                   // CSS px the captured tile really covers
      const overlapCss = Math.max(2, 4 / scale);                            // ~4 device px of overlap
      want = Math.min(s.top + Math.max(1, Math.min(s.clientHeight, tileCss) - overlapCss), maxTop);
      if (i === FULLPAGE_LIMITS.maxTiles - 1) truncated = true;
    }

    if (m.mode === 'element' && bottomBand) {
      ensureCanvas();
      ctx.drawImage(bottomBand, 0, bandTop + Math.round(scrollHeight * scale));
    }
    bottomBand?.close();

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return {
      blob, mode: m.mode, tiles, truncated, width: canvas.width, height: canvas.height,
      note: truncated
        ? `The page is taller than the stitching limit, so the image was cut at ${canvas.height}px.`
        : (m.mode === 'element' ? 'Content scrolls inside a panel; that panel was stitched and the rest of the screen was taken from the first view.' : ''),
    };
  } finally {
    await inject(pageRestore).catch(() => {});
  }
}
