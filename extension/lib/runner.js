// The automation engine. Lives in the service worker.
//
// Guarantees (each is covered by the end-to-end tests):
//   * Nothing is navigated or captured until the user confirms the login (state gate + `loginConfirmed`).
//   * Exactly one run loop at a time: `loopActive` is set synchronously, before any await.
//   * Progress is persisted after every step, so a restarted service worker resumes as "paused", not lost.
//   * Pause/stop are cooperative: they take effect at the next checkpoint and abort waits via AbortSignal.
//   * A failed page is recorded and (if allowed) skipped; it never throws out of the loop.
//   * A sign-in page after navigation pauses the run and requires a fresh confirmation.

import { STATES as S } from './constants.js';
import {
  emptyRun, isAllowed, availableActions, progress, recoverAfterRestart, judgeProbe,
  originOf, noteOriginalZoom, originsToRestore,
} from './runstate.js';
import {
  loadSettings, loadUrls, loadRun, saveRun, addScreenshot, loadGalleryMeta, StorageError,
} from './storage.js';
import { buildFilename, uniqueFilename, validateUrl } from './validate.js';
import { captureVisible, explainCaptureError, sleep, abortError } from './capture.js';
import { captureFullPage } from './fullpage.js';
import {
  navigate, tabInfo, probePage, applyZoom, readZoomBaseline, restoreZoom, openRunWindow,
  ensureMaximized, targetExists, bringToFront, isProtectedUrl,
} from './browser.js';

const THUMB_WIDTH = 320;

let run = emptyRun();
let loaded = false;
let loopActive = false;          // synchronous guard: true from the moment a loop is scheduled until it fully exits
let abort = null;                // AbortController for the in-flight loop
let wantPause = false;
let wantStop = false;
const listeners = new Set();

/* ---------------- state publishing ---------------- */

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function snapshot() {
  return { ...run, progress: progress(run), actions: availableActions(run) };
}

async function commit(patch = {}, { persist = true } = {}) {
  run = { ...run, ...patch, updatedAt: Date.now() };
  // The login confirmation only survives a run that COMPLETED, so "Start Automation" can repeat it while the same Edge
  // window and session are still open (an expired session is caught on the first page and demands a fresh login).
  // After a Stop, an error, a cancel, or going idle, using the automation again means logging in and confirming again -
  // enforced here, in the one place every state change passes through, so no exit path can forget it.
  if (['stopped', 'error', 'idle'].includes(run.state)) run.loginConfirmed = false;
  if (persist) {
    try { await saveRun(run); } catch { /* a storage failure must not crash the loop; state still lives in memory */ }
  }
  const snap = snapshot();
  for (const fn of listeners) { try { fn(snap); } catch { /* a dead listener must not break the run */ } }
}

const setState = (state, action, extra = {}) => commit({ state, action, ...extra });

/* ---------------- lifecycle ---------------- */

/** Call once when the service worker starts. */
export async function init() {
  if (loaded) return;
  loaded = true;
  run = recoverAfterRestart(await loadRun());
  // Keep the (possibly downgraded) state, but never re-arm a loop automatically: the user must press Resume.
  await commit({}, { persist: true });
}

const fail = (error) => ({ ok: false, error });
const ok = (extra = {}) => ({ ok: true, ...extra });

/* ---------------- commands ---------------- */

/** Step 1-2: open the login page in a maximised Edge window and wait for the human. */
export async function openLogin() {
  if (!isAllowed('openLogin', run) || loopActive) return fail('A run is already in progress. Stop it first.');
  const settings = await loadSettings();
  const v = validateUrl(settings.loginUrl, { allowHttp: settings.allowHttp });
  if (!v.ok) return fail(`The login URL is not valid: ${v.error}`);

  loopActive = true; // also blocks overlapping openLogin calls while we await below
  try {
    await commit({ ...emptyRun(), runId: crypto.randomUUID(), startedAt: Date.now(), state: S.OPENING_LOGIN, action: 'Opening the login page in Microsoft Edge…' });
    const w = await openRunWindow(v.url);
    await commit({
      windowId: w.windowId, tabId: w.tabId,
      warnings: w.warning ? [w.warning] : [],
      state: S.WAITING_LOGIN,
      action: 'Complete your login and MFA in Microsoft Edge. Then confirm in the dashboard.',
    });
    return ok({ maximized: w.maximized, warning: w.warning });
  } catch (e) {
    await commit({ state: S.ERROR, action: '', lastError: `Could not open Microsoft Edge: ${e.message}` });
    return fail(run.lastError);
  } finally {
    loopActive = false;
  }
}

export async function cancelLogin() {
  if (!isAllowed('cancelLogin', run)) return fail('There is no login in progress.');
  // The Edge window stays open: the user may still be signing in there, and we never close their windows.
  await commit({ ...emptyRun(), state: S.IDLE, action: 'Login cancelled. Nothing was automated.' });
  return ok();
}

/** Step 4: the explicit human confirmation. Validates, then starts exactly one run. */
export async function confirmLogin() {
  if (!isAllowed('confirmLogin', run)) return fail('There is no login waiting for confirmation.');
  if (loopActive) return fail('A run is already starting.');
  loopActive = true; // claim the slot synchronously; a second click sees `true` and is rejected

  try {
    const t = await targetExists(run.windowId, run.tabId);
    if (!t.ok) {
      await commit({ state: S.IDLE, action: 'The Edge login window was closed. Open the login page again.', loginConfirmed: false, windowId: null, tabId: null });
      loopActive = false;
      return fail('The Edge login tab was closed. Please open the login page again.');
    }
    if (run.state === S.PAUSED) {
      // Re-login after an expired session: keep the list and everything captured so far, and retry the page that
      // triggered the sign-in. (Nothing is reset, so no screenshot is duplicated.)
      await commit({
        loginConfirmed: true, windowId: t.windowId, lastError: null,
        state: S.PREPARING, action: 'Login confirmed again. Continuing where the run left off…',
      });
    } else {
      const settings = await loadSettings();
      let urls = await loadUrls();
      if (settings.includeLoginPage) urls = [settings.loginUrl, ...urls.filter((u) => u !== settings.loginUrl)];
      if (urls.length === 0) {
        loopActive = false;
        return fail('There are no pages to visit. Add at least one URL first.');
      }
      await commit({
        loginConfirmed: true, windowId: t.windowId, urls, nextIndex: 0, captured: 0, failed: 0,
        results: [], lastError: null, currentUrl: null, zoomLedger: {}, warnings: run.warnings,
        state: S.PREPARING, action: 'Login confirmed. Preparing the browser…',
      });
    }
  } catch (e) {
    loopActive = false;
    await commit({ state: S.ERROR, lastError: e.message, action: '' });
    return fail(e.message);
  }

  startLoop(); // runs detached; releases `loopActive` itself
  return ok();
}

/** The same gate as Start: only valid after a confirmed login in a finished/idle session. */
export async function start() {
  if (!isAllowed('start', run) || !run.loginConfirmed) {
    return fail('Open the login page, sign in, and confirm first. Automation never starts before you confirm your login.');
  }
  if (loopActive) return fail('A run is already in progress.');
  loopActive = true;
  try {
    const t = await targetExists(run.windowId, run.tabId);
    if (!t.ok) {
      await commit({ loginConfirmed: false, state: S.IDLE, action: 'The Edge window was closed. Open the login page again.', windowId: null, tabId: null });
      loopActive = false;
      return fail('The Edge window was closed. Please log in again.');
    }
    const settings = await loadSettings();
    let urls = await loadUrls();
    if (settings.includeLoginPage) urls = [settings.loginUrl, ...urls.filter((u) => u !== settings.loginUrl)];
    if (urls.length === 0) { loopActive = false; return fail('There are no pages to visit. Add at least one URL first.'); }
    await commit({
      windowId: t.windowId, urls, nextIndex: 0, captured: 0, failed: 0, results: [], lastError: null, currentUrl: null,
      zoomLedger: {}, state: S.PREPARING, action: 'Preparing the browser…',
    });
  } catch (e) {
    loopActive = false;
    await commit({ state: S.ERROR, lastError: e.message, action: '' });
    return fail(e.message);
  }
  startLoop();
  return ok();
}

export async function pause() {
  if (!isAllowed('pause', run)) return fail('Nothing is running that can be paused.');
  wantPause = true;
  await commit({ action: 'Pausing after the current step…' });
  return ok();
}

export async function resume() {
  if (!isAllowed('resume', run)) return fail('The run is not paused.');
  if (loopActive) return fail('The run is still finishing its current step. Try again in a moment.');
  loopActive = true;
  try {
    const t = await targetExists(run.windowId, run.tabId);
    if (!t.ok) {
      loopActive = false;
      await commit({ state: S.STOPPED, action: 'The Edge window was closed, so the run was stopped.', loginConfirmed: false });
      return fail('The Edge window was closed. Open the login page and start again.');
    }
    await commit({ windowId: t.windowId, state: S.PREPARING, action: 'Resuming…', lastError: null });
  } catch (e) {
    loopActive = false;
    return fail(e.message);
  }
  startLoop();
  return ok();
}

export async function stop() {
  if (!isAllowed('stop', run)) return fail('Nothing is running.');
  wantStop = true;
  abort?.abort();
  if (!loopActive) {
    // Not in a loop (paused, or waiting for login): finish the stop right here.
    await finishStopped('Stopped by user.');
  } else {
    await commit({ action: 'Stopping…' });
  }
  return ok();
}

/**
 * Edge stores an applied zoom PER SITE and it survives closing the window (measured), so every site we zoom must
 * be put back, or the user's normal browsing silently changes afterwards. A tab's zoom can only be set for the site
 * it is showing, and we never navigate just to tidy up, so the restore happens at two natural moments:
 *   - right before the tab leaves a site for a different one  (restoreCurrentSite, called from processOne)
 *   - when the run ends/pauses/stops, while the tab is still on the last site  (restoreAllZoom)
 * The ledger lives in the persisted run state, so a service-worker restart does not lose it.
 */
async function restoreCurrentSite() {
  try {
    const info = await tabInfo(run.tabId);
    const origin = originOf(info.url);
    const ledger = run.zoomLedger || {};
    if (origin && Object.prototype.hasOwnProperty.call(ledger, origin)) {
      await restoreZoom(run.tabId, ledger[origin]);
      const { [origin]: _done, ...rest } = ledger;
      await commit({ zoomLedger: rest });
    }
  } catch { /* tab closed: nothing to restore on it */ }
}

async function restoreAllZoom() {
  await restoreCurrentSite();
  const left = originsToRestore(run.zoomLedger);
  if (left.length) {
    await commit({
      zoomLedger: {},
      warnings: [...run.warnings, `Could not restore the original zoom of: ${left.map((l) => l.origin).join(', ')}. Reset it with Ctrl+0 on those sites if it looks wrong.`].slice(-10),
    });
  }
}

async function finishStopped(message) {
  await restoreAllZoom();
  wantStop = false; wantPause = false;
  await commit({ state: S.STOPPED, action: message });
}

/* ---------------- the loop ---------------- */

function startLoop() {
  abort = new AbortController();
  wantPause = false;
  wantStop = false;
  runLoop(abort.signal)
    .catch(async (e) => {
      await commit({ state: S.ERROR, action: '', lastError: `Unexpected error: ${e?.message || e}` });
    })
    .finally(() => { loopActive = false; abort = null; });
}

const stopRequested = () => wantStop;

async function checkpoint() {
  if (wantStop) return 'stop';
  if (wantPause) return 'pause';
  return null;
}

async function runLoop(signal) {
  const settings = await loadSettings();
  const timeoutMs = settings.navigationTimeoutSeconds * 1000;

  try {
    // ----- Preparing: maximise, remember the user's zoom, learn the OS scale -----
    await setState(S.PREPARING, 'Maximising Edge and preparing the zoom level…');
    const max = await ensureMaximized(run.windowId);
    if (!max.maximized) await commit({ warnings: [...run.warnings, max.warning].slice(-10) });
    await bringToFront(run.windowId, run.tabId);

    // The OS display scale (e.g. 125% on a laptop) shifts devicePixelRatio; learn it once so zoom checks are exact.
    // Zoom itself is applied per page, AFTER each page loads - never to the login page, which we don't own.
    const baseline = (await readZoomBaseline(run.tabId)) || 1;

    // ----- Pages -----
    let firstInLoop = true; // zoom is always applied at the start of a run / after a resume, even if "reapply" is off
    while (run.nextIndex < run.urls.length) {
      const stopOrPause = await checkpoint();
      if (stopOrPause === 'stop') return await finishStopped('Stopped by user.');
      if (stopOrPause === 'pause') {
        await restoreAllZoom();
        wantPause = false;
        return await setState(S.PAUSED, 'Paused. Press Resume to continue with the next page.');
      }

      const index = run.nextIndex;
      const url = run.urls[index];
      const step = await processOne({ index, url, settings, timeoutMs, baseline, signal, firstInLoop });
      firstInLoop = false;

      if (step.outcome === 'stopped') return await finishStopped('Stopped by user.');
      if (step.outcome === 'window-closed') {
        return await commit({ zoomLedger: {}, state: S.PAUSED, loginConfirmed: false, action: 'The Edge window or tab was closed. Open the login page, sign in, and confirm to continue.', lastError: 'The Edge window or tab was closed.', windowId: null, tabId: null });
      }
      if (step.outcome === 'auth') {
        await restoreAllZoom();
        // Do NOT advance: this page must be retried after the user signs in again.
        return await commit({
          state: S.PAUSED, loginConfirmed: false, lastError: step.message,
          action: 'Your session needs a fresh login. Sign in in Microsoft Edge, then confirm in the dashboard to continue.',
        });
      }

      const status = step.outcome === 'ok' ? 'ok' : step.outcome === 'skipped' ? 'skipped' : 'failed';
      const record = { index, url, status, ...(step.error ? { error: step.error } : {}), ...(step.screenshotId ? { screenshotId: step.screenshotId } : {}) };
      await commit({
        results: [...run.results, record],
        nextIndex: index + 1,
        captured: run.captured + (status === 'ok' ? 1 : 0),
        failed: run.failed + (status === 'failed' ? 1 : 0),
        lastError: status === 'failed' ? step.error : run.lastError,
      });

      if (status === 'failed' && !settings.continueOnError) {
        await restoreAllZoom();
        return await commit({ state: S.ERROR, action: 'Stopped after an error (the "continue after error" setting is off).' });
      }
      if (step.fatal) {
        await restoreAllZoom();
        return await commit({ state: S.ERROR, action: step.fatalAction || 'Stopped because of a storage problem.' });
      }
    }

    await restoreAllZoom();
    await commit({
      state: S.COMPLETED, currentUrl: null,
      action: run.failed ? `Finished with ${run.failed} failed page${run.failed === 1 ? '' : 's'}.` : 'All pages captured.',
    });
  } catch (e) {
    if (e?.name === 'AbortError' || stopRequested()) return await finishStopped('Stopped by user.');
    await restoreAllZoom().catch(() => {});
    await commit({ state: S.ERROR, action: '', lastError: e?.message || String(e) });
  }
}

/**
 * Visit one URL and capture it. Never throws for page-level problems; returns an outcome instead:
 *   { outcome: 'ok' | 'failed' | 'skipped' | 'auth' | 'window-closed' | 'stopped', error?, screenshotId?, fatal? }
 */
async function processOne({ index, url, settings, timeoutMs, baseline, signal, firstInLoop }) {
  const gone = async () => !(await targetExists(run.windowId, run.tabId)).ok;
  try {
    // ----- navigate -----
    await setState(S.NAVIGATING, `Opening page ${index + 1} of ${run.urls.length}…`, { currentUrl: url });
    if (await gone()) return { outcome: 'window-closed' };
    // Leaving a site we zoomed for a different one: put the old site's zoom back first (we can't do it afterwards).
    if (originOf(url) !== originOf((await tabInfo(run.tabId)).url)) await restoreCurrentSite();
    const nav = await navigate(run.tabId, url, { timeoutMs, signal });

    // ----- wait for load + the configured extra delay -----
    await setState(S.WAITING_LOAD, nav.waited === 'timeout'
      ? 'The page is slow to finish loading; continuing after the extra delay…'
      : `Waiting ${settings.pageDelaySeconds}s for the page to settle…`);
    await sleep(settings.pageDelaySeconds * 1000, signal);
    if (await gone()) return { outcome: 'window-closed' };

    // ----- judge what actually loaded (error pages, stale pages, HTTP errors, sign-in redirects) -----
    const info = await tabInfo(run.tabId);
    if (isProtectedUrl(info.url)) return { outcome: 'failed', error: 'This is a protected browser page and cannot be captured.' };
    const probe = await probePage(run.tabId);
    const verdict = judgeProbe(probe, { requested: url, loginUrl: settings.loginUrl, detectSessionExpiry: settings.detectSessionExpiry, startedAt: nav.startedAt });
    if (verdict.kind === 'auth') return { outcome: 'auth', message: verdict.message };
    if (verdict.kind !== 'ok') {
      const why = verdict.kind === 'stale' && nav.waited === 'timeout'
        ? `The page did not load within ${settings.navigationTimeoutSeconds}s.`
        : verdict.message;
      return { outcome: 'failed', error: why };
    }

    // ----- zoom: apply at the start of the run (first page) and, if enabled, again after every navigation -----
    if (settings.reapplyZoomEachPage || firstInLoop) {
      // Remember what this site's zoom was BEFORE we touch it, so it can be put back when we're done.
      const origin = originOf((await tabInfo(run.tabId)).url);
      const current = await chrome.tabs.getZoom(run.tabId).catch(() => null);
      await commit({ zoomLedger: noteOriginalZoom(run.zoomLedger, origin, current) });
      const z = await applyZoom(run.tabId, settings.zoomPercent, baseline, signal);
      if (!z.ok) await commit({ warnings: [...run.warnings, `Zoom on page ${index + 1}: ${z.message}`].slice(-10) });
      await sleep(400, signal); // let the layout settle after the zoom change
    }
    if (!settings.autoCapture) return { outcome: 'skipped' }; // visited on purpose, nothing to capture: neither success nor failure

    // ----- capture -----
    await setState(S.CAPTURING, settings.captureMode === 'full' ? 'Capturing the full page (scrolling)…' : 'Capturing screenshot…');
    await bringToFront(run.windowId, run.tabId);
    let image;
    try {
      image = settings.captureMode === 'full'
        ? await captureFullPage(run.tabId, run.windowId, { signal })
        : { blob: await captureVisible(run.windowId, signal), mode: 'visible', note: '' };
    } catch (e) {
      if (e?.name === 'AbortError') return { outcome: 'stopped' };
      if (await gone()) return { outcome: 'window-closed' };
      return { outcome: 'failed', error: explainCaptureError(e) };
    }

    // ----- save -----
    await setState(S.SAVING, 'Saving screenshot…');
    const existing = await loadGalleryMeta();
    const taken = new Set(existing.map((m) => m.filename.toLowerCase()));
    const capturedAt = Date.now();
    const filename = uniqueFilename(buildFilename(settings.filenameFormat, { index: index + 1, url, capturedAt: new Date(capturedAt) }), taken);
    const id = crypto.randomUUID().replace(/-/g, '');
    const thumb = await makeThumbnail(image.blob).catch(() => null);
    const meta = {
      id, filename, url, finalUrl: probe.href, title: probe.title || '', capturedAt, status: 'ok',
      bytes: image.blob.size, mode: image.mode, note: image.note || '', runId: run.runId, index: index + 1,
    };
    try {
      await addScreenshot(meta, image.blob, thumb);
    } catch (e) {
      const quota = e instanceof StorageError && e.quota;
      return { outcome: 'failed', error: e.message, fatal: quota, fatalAction: quota ? 'Stopped: local storage is full. Delete some screenshots and resume.' : undefined };
    }
    return { outcome: 'ok', screenshotId: id };
  } catch (e) {
    if (e?.name === 'AbortError') return { outcome: 'stopped' };
    if (/closed|No tab with id|No window with id/i.test(e?.message || '') || await gone()) return { outcome: 'window-closed' };
    return { outcome: 'failed', error: e?.message || String(e) };
  }
}

async function makeThumbnail(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    const w = Math.min(THUMB_WIDTH, bmp.width);
    const h = Math.max(1, Math.round(bmp.height * (w / bmp.width)));
    const c = new OffscreenCanvas(w, Math.min(h, THUMB_WIDTH * 3));
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  } finally {
    bmp.close();
  }
}

/** Test/diagnostic accessor. */
export function _debug() {
  return { loopActive, wantPause, wantStop };
}
