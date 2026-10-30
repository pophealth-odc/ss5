// Screenshot primitives for the service worker.
//   captureVisible(windowId)  - one throttled, retried captureVisibleTab -> PNG Blob
// Measured on Edge 155: captureVisibleTab allows ~2 calls/second and the 3rd in a second fails with
// MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, so every call goes through one shared gate.

const MIN_GAP_MS = 600;            // comfortably under the 2/sec quota
const MAX_RETRIES = 6;

let lastCallAt = 0;
let gate = Promise.resolve();       // serialises all captures so the gap is honoured across callers

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function abortError() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

const isQuotaMessage = (m) => /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(m || '');

/** Messages that mean "this page can never be captured" (do not retry). */
export function explainCaptureError(err) {
  const m = String(err?.message || err || '');
  if (/<all_urls>|activeTab/.test(m)) {
    return 'Edge refused to capture this page. The extension needs access to all sites; open edge://extensions, choose Details, and make sure "Site access" is "On all sites". Edge internal pages and the Add-ons store can never be captured.';
  }
  if (/cannot be scripted|cannot access|chrome:\/\/|edge:\/\//i.test(m)) return 'This is a protected browser page and cannot be captured.';
  if (/No tab with id|tab was closed|No window with id|window was closed/i.test(m)) return 'The Edge tab or window was closed.';
  if (/image readback failed|Failed to capture tab/i.test(m)) return 'Edge could not read the page image (the tab may be hidden, minimised, or still rendering).';
  return m || 'Unknown capture error.';
}

async function throttled(fn, signal) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCallAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait, signal);
      if (signal?.aborted) throw abortError();
      lastCallAt = Date.now();
      try {
        return await fn();
      } catch (e) {
        if (isQuotaMessage(e?.message) && attempt < MAX_RETRIES) {
          lastCallAt = Date.now() + 400 * (attempt + 1); // back off a little more each time
          continue;
        }
        throw e;
      }
    }
  };
  const result = gate.then(run, run);
  gate = result.catch(() => {});
  return result;
}

/** Decode a data: URL produced by captureVisibleTab into a Blob without any network request. */
export function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('Edge returned an unexpected image format.');
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

/** One visible-area capture of the active tab in `windowId`. */
export async function captureVisible(windowId, signal) {
  const dataUrl = await throttled(() => chrome.tabs.captureVisibleTab(windowId, { format: 'png' }), signal);
  return dataUrlToBlob(dataUrl);
}
