// Edge-facing primitives used by the runner. Each one encodes something measured on Edge 155:
//   - tab.status can be "complete" for a failed navigation (error page) -> a real in-page probe is needed
//   - a server that never answers leaves the PREVIOUS page on screen -> compare performance.timeOrigin
//   - fragment-only navigation does not reload -> force tabs.reload
//   - getZoom() can report a value the page is not actually using -> verify against devicePixelRatio
//   - zoom is remembered per origin in automatic mode -> restore the user's original zoom afterwards

import { sleep, abortError } from './capture.js';

const PROTECTED = /^(edge|chrome|about|devtools|view-source|chrome-extension|extension|edge-extension):/i;

export const isProtectedUrl = (u) => !u || PROTECTED.test(u);

/** Resolve when the tab reports status "complete" after a navigation we started, or reject on timeout/abort. */
export function waitForLoad(tabId, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let started = false;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      if (info.status === 'complete' && started) finish(resolve, 'complete');
    };
    const onRemoved = (id) => { if (id === tabId) finish(reject, new Error('The Edge tab was closed.')); };
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => finish(resolve, 'timeout'), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Navigate `tabId` to `url` and wait for it to load (or time out). Always produces a real new document:
 * a fragment-only change is followed by a reload.
 * Returns { waited: 'complete' | 'timeout', startedAt }.
 */
export async function navigate(tabId, url, { timeoutMs, signal }) {
  const startedAt = Date.now();
  const loaded = waitForLoad(tabId, { timeoutMs, signal });
  loaded.catch(() => {}); // avoid an unhandled rejection if we throw before awaiting it
  const cur = await chrome.tabs.get(tabId);
  const sameDocument = (() => {
    try {
      const a = new URL(cur.url || 'about:blank');
      const b = new URL(url);
      return a.href.split('#')[0] === b.href.split('#')[0] && a.hash !== b.hash;
    } catch { return false; }
  })();
  await chrome.tabs.update(tabId, { url });
  if (sameDocument) await chrome.tabs.reload(tabId);
  const waited = await loaded;
  return { waited, startedAt };
}

/** Tab-level facts that need no host permission. */
export async function tabInfo(tabId) {
  const t = await chrome.tabs.get(tabId);
  return { url: t.url || '', pendingUrl: t.pendingUrl || '', status: t.status, title: t.title || '', windowId: t.windowId };
}

/**
 * Ask the page about itself. Never throws: a page that can't be scripted (error page, protected page) returns { err }.
 * Reads only: location, navigation timing, and whether a password field exists (NOT its contents).
 */
export async function probePage(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const n = performance.getEntriesByType('navigation')[0];
        return {
          href: location.href,
          title: document.title,
          ready: document.readyState,
          timeOrigin: performance.timeOrigin,
          status: n && typeof n.responseStatus === 'number' ? n.responseStatus : null,
          redirects: n ? n.redirectCount : 0,
          pwd: !!document.querySelector('input[type="password"]'),
        };
      },
    });
    return r?.[0]?.result || { err: 'No result from page.' };
  } catch (e) {
    return { err: String(e?.message || e) };
  }
}

/** The page's real zoom as seen by the page itself. */
async function pageZoom(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.devicePixelRatio });
    return r?.[0]?.result;
  } catch { return null; }
}

/** devicePixelRatio is also changed by OS display scaling, so compare to the baseline measured at zoom 1.0. */
export async function readZoomBaseline(tabId) {
  const current = await chrome.tabs.getZoom(tabId);
  const dpr = await pageZoom(tabId);
  if (!dpr || !current) return null;
  return dpr / current; // = OS scale factor (e.g. 1.25 on a 125% Windows display)
}

/**
 * Set zoom (percent) and VERIFY the page really changed. Returns { ok, applied, message }.
 * `baseline` is the OS scale from readZoomBaseline() (defaults to 1).
 */
export async function applyZoom(tabId, percent, baseline = 1, signal) {
  const want = percent / 100;
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await chrome.tabs.setZoom(tabId, want); } catch (e) { return { ok: false, applied: null, message: `Edge refused to change the zoom: ${e.message}` }; }
    await sleep(250 + attempt * 200, signal);
    const dpr = await pageZoom(tabId);
    last = dpr ? dpr / baseline : null;
    if (last !== null && Math.abs(last - want) < 0.02) return { ok: true, applied: last, message: '' };
  }
  // Pages that cannot be scripted (e.g. a freshly failed load) can't be verified; trust the API value for them.
  if (last === null) {
    const g = await chrome.tabs.getZoom(tabId).catch(() => null);
    return { ok: g !== null && Math.abs(g - want) < 0.01, applied: g, message: g === null ? 'Could not read the zoom level.' : '' };
  }
  return { ok: false, applied: last, message: `Edge reported zoom ${Math.round(last * 100)}% instead of ${percent}%.` };
}

/** Put the tab's zoom back to what it was before the run. Best-effort. */
export async function restoreZoom(tabId, original) {
  if (original === null || original === undefined) return;
  try { await chrome.tabs.setZoom(tabId, original); } catch { /* tab may be gone */ }
}

/** Open (or reuse) a dedicated window for the run, maximised. Returns { windowId, tabId, maximized, warning }. */
export async function openRunWindow(url) {
  const w = await chrome.windows.create({ url, focused: true, state: 'maximized' });
  const tabId = w.tabs?.[0]?.id;
  if (tabId === undefined) throw new Error('Edge did not return a tab for the new window.');
  const res = await ensureMaximized(w.id);
  return { windowId: w.id, tabId, ...res };
}

/** Request the maximised state and report honestly whether Edge reports it. */
export async function ensureMaximized(windowId) {
  try {
    await chrome.windows.update(windowId, { state: 'maximized', focused: true });
    await sleep(200);
    const w = await chrome.windows.get(windowId);
    if (w.state === 'maximized') return { maximized: true, warning: '' };
    return { maximized: false, warning: `Edge did not maximise the window (state: ${w.state}). Please maximise it manually for consistent screenshots.` };
  } catch (e) {
    return { maximized: false, warning: `Could not maximise the window (${e.message}). Please maximise Edge manually.` };
  }
}

/** Do the window and tab we think we own still exist? */
export async function targetExists(windowId, tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.windowId !== windowId) return { ok: true, windowId: t.windowId }; // user dragged the tab to another window - still ours
    return { ok: true, windowId };
  } catch {
    return { ok: false };
  }
}

/** Make sure our tab is the visible one in its window (captureVisibleTab only sees the active tab). */
export async function bringToFront(windowId, tabId) {
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(windowId, { focused: true });
}
