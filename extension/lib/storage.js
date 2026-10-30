// Local-only persistence.
//   chrome.storage.local : settings, URL list, run state, screenshot metadata index (small JSON)
//   IndexedDB            : screenshot image blobs (large binary; chrome.storage would need base64)
// Nothing here talks to the network. Passwords, MFA codes, cookies and tokens are never read or stored.

import { normalizeSettings, validateUrlList } from './validate.js';
import { DEFAULT_SETTINGS } from './constants.js';

const DB_NAME = 'edge-screenshot-automation';
const DB_VERSION = 1;
const STORE = 'images';

const KEY_SETTINGS = 'settings';
const KEY_URLS = 'urls';
const KEY_RUN = 'run';
const KEY_GALLERY = 'gallery';

export class StorageError extends Error {
  constructor(message, { quota = false, cause } = {}) {
    super(message);
    this.name = 'StorageError';
    this.quota = quota;
    if (cause) this.cause = cause;
  }
}

const isQuotaError = (e) =>
  !!e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || '')));

const friendly = (e, what) => {
  if (isQuotaError(e)) {
    return new StorageError(
      `Not enough local storage space to save ${what}. Delete some screenshots (or free disk space) and try again.`,
      { quota: true, cause: e },
    );
  }
  return new StorageError(`Could not save ${what}: ${e?.message || e}`, { cause: e });
};

// ---------- chrome.storage.local helpers ----------

async function getKey(key) {
  const r = await chrome.storage.local.get(key);
  return r[key];
}

async function setKey(key, value, what) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (e) {
    throw friendly(e, what);
  }
}

export async function loadSettings() {
  return normalizeSettings(await getKey(KEY_SETTINGS), { strict: false }).settings;
}

export async function saveSettings(settings) {
  await setKey(KEY_SETTINGS, settings, 'settings');
}

export async function loadUrls() {
  const stored = await getKey(KEY_URLS);
  const settings = await loadSettings();
  // Re-validate on load so a corrupted/edited store can never feed bad URLs to the runner.
  return validateUrlList(Array.isArray(stored) ? stored : [], { allowHttp: settings.allowHttp }).urls;
}

export async function saveUrls(urls) {
  await setKey(KEY_URLS, urls, 'the URL list');
}

export async function loadRun() {
  const r = await getKey(KEY_RUN);
  return r && typeof r === 'object' ? r : null;
}

export async function saveRun(run) {
  await setKey(KEY_RUN, run, 'run state');
}

export async function clearRun() {
  await chrome.storage.local.remove(KEY_RUN);
}

// ---------- gallery metadata (small) ----------

export async function loadGalleryMeta() {
  const g = await getKey(KEY_GALLERY);
  return Array.isArray(g) ? g : [];
}

async function saveGalleryMeta(list) {
  await setKey(KEY_GALLERY, list, 'the gallery index');
}

// ---------- IndexedDB (screenshot blobs) ----------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      dbPromise = null;
      return reject(new StorageError(`Browser storage is unavailable: ${e.message}`, { cause: e }));
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(new StorageError(`Browser storage is unavailable: ${req.error?.message || 'unknown error'}`, { cause: req.error }));
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new StorageError('Browser storage is blocked by another open copy of the extension. Close other Edge windows and retry.'));
    };
  });
  return dbPromise;
}

function tx(mode, work) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    let result;
    let t;
    try {
      t = db.transaction(STORE, mode);
    } catch (e) {
      dbPromise = null; // stale connection: reopen next time
      return reject(friendly(e, 'screenshot data'));
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(friendly(t.error, 'a screenshot'));
    t.onabort = () => reject(friendly(t.error || new Error('transaction aborted'), 'a screenshot'));
    try {
      result = work(t.objectStore(STORE));
    } catch (e) {
      try { t.abort(); } catch { /* already finished */ }
      reject(friendly(e, 'a screenshot'));
    }
  }));
}

const reqPromise = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const imgKey = (id) => `img:${id}`;
const thumbKey = (id) => `thumb:${id}`;

/** Write the full image (and its small thumbnail) in ONE transaction, so they succeed or fail together. */
export async function putScreenshotBlobs(id, blob, thumb) {
  await tx('readwrite', (s) => {
    s.put(blob, imgKey(id));
    if (thumb) s.put(thumb, thumbKey(id));
  });
}

/** kind: 'full' | 'thumb'. Returns a Blob or null. */
export async function getImage(id, kind = 'full') {
  const key = kind === 'thumb' ? thumbKey(id) : imgKey(id);
  return openDb().then((db) => new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(new StorageError(`Could not read screenshot: ${r.error?.message}`, { cause: r.error }));
  }));
}

export async function deleteImages(ids) {
  if (!ids.length) return;
  await tx('readwrite', (s) => { for (const id of ids) { s.delete(imgKey(id)); s.delete(thumbKey(id)); } });
}

export async function clearImages() {
  await tx('readwrite', (s) => { s.clear(); });
}

/** { images: Set<id>, thumbs: Set<id> } of everything physically in IndexedDB. */
async function listBlobIds() {
  const db = await openDb();
  const keys = await reqPromise(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys());
  const images = new Set();
  const thumbs = new Set();
  for (const k of keys) {
    if (typeof k !== 'string') continue;
    if (k.startsWith('img:')) images.add(k.slice(4));
    else if (k.startsWith('thumb:')) thumbs.add(k.slice(6));
  }
  return { images, thumbs };
}

// ---------- gallery operations (metadata + blob kept consistent) ----------

/**
 * Save a screenshot blob and its metadata. The blob is written first; if the metadata write then fails
 * the blob is removed again so nothing is orphaned.
 */
export async function addScreenshot(meta, blob, thumb = null) {
  await putScreenshotBlobs(meta.id, blob, thumb);
  try {
    const list = await loadGalleryMeta();
    list.push(meta);
    await saveGalleryMeta(list);
  } catch (e) {
    await deleteImages([meta.id]).catch(() => {});
    throw e;
  }
}

export async function deleteScreenshots(ids) {
  const set = new Set(ids);
  const list = await loadGalleryMeta();
  await saveGalleryMeta(list.filter((m) => !set.has(m.id)));
  await deleteImages([...set]);
}

export async function clearGallery() {
  await saveGalleryMeta([]);
  await clearImages();
}

/** Drop metadata whose image is gone and images with no metadata (e.g. after a crash mid-save). */
export async function reconcileGallery() {
  const [list, blobs] = await Promise.all([loadGalleryMeta(), listBlobIds()]);
  const keep = list.filter((m) => blobs.images.has(m.id));          // an entry without its full image is useless
  const keptIds = new Set(keep.map((m) => m.id));
  const orphans = new Set([...blobs.images, ...blobs.thumbs].filter((id) => !keptIds.has(id)));
  if (keep.length !== list.length) await saveGalleryMeta(keep);
  if (orphans.size) await deleteImages([...orphans]);
  return { removedMeta: list.length - keep.length, removedImages: orphans.size };
}

/** Estimated usage, for the dashboard. May be unavailable in some contexts. */
export async function estimateUsage() {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? null, quota: e.quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}

/** Remove everything this extension has stored (settings, URLs, run state, gallery, images). */
export async function clearAllData() {
  await chrome.storage.local.clear();
  await clearImages();
}

export { DEFAULT_SETTINGS };
