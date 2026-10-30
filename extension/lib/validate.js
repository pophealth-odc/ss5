// Pure validation / normalisation helpers shared by the extension and the dashboard.
// No chrome.* calls here, so they can be unit-tested in plain Node and reused in page code.

import { DEFAULT_SETTINGS, LIMITS, FILENAME_TOKENS } from './constants.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Pages the extension cannot script or capture (checked in experiments: "cannot be scripted").
const RESTRICTED_HOSTS = [
  { host: 'microsoftedge.microsoft.com', pathPrefix: '/addons' },
  { host: 'chromewebstore.google.com', pathPrefix: '/' },
  { host: 'chrome.google.com', pathPrefix: '/webstore' },
];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const fail = (error) => ({ ok: false, error });

/** Validate one URL the user wants to open. Returns { ok, url } or { ok:false, error }. */
export function validateUrl(raw, { allowHttp = false } = {}) {
  if (typeof raw !== 'string') return fail('URL must be text.');
  const s = raw.trim();
  if (!s) return fail('URL is empty.');
  if (s.length > LIMITS.maxUrlLength) return fail(`URL is longer than ${LIMITS.maxUrlLength} characters.`);
  if (CONTROL_CHARS.test(s)) return fail('URL contains control characters.');

  let u;
  try {
    u = new URL(s);
  } catch {
    return fail('Not a valid absolute URL. Include the scheme, e.g. https://example.com/page');
  }

  if (u.protocol === 'http:') {
    if (!allowHttp) return fail('Plain HTTP is blocked. Use https:// or enable "Allow HTTP" in Settings.');
  } else if (u.protocol !== 'https:') {
    return fail(`"${u.protocol}" addresses cannot be automated. Only https:// (and http:// when enabled) pages can be opened.`);
  }
  // WHATWG parsing silently rewrites "https:///host" or "https:\\host" into a different, valid URL.
  // Reject those so a typo is reported instead of automating a page the user did not type.
  if (!/^https?:\/\/[^/\\]/i.test(s)) return fail('Malformed address. Use the form https://host/path');
  if (!u.hostname) return fail('URL has no host name.');
  if (u.username || u.password) return fail('URLs that contain a user name or password are not allowed.');

  for (const r of RESTRICTED_HOSTS) {
    if (u.hostname.toLowerCase() === r.host && u.pathname.toLowerCase().startsWith(r.pathPrefix)) {
      return fail('This is a browser store page. Extensions cannot script or capture it.');
    }
  }
  return { ok: true, url: u.href };
}

/** Validate a list of URLs. Returns { urls, errors:[{index,input,error}] } (valid ones are normalised). */
export function validateUrlList(list, opts = {}) {
  const urls = [];
  const errors = [];
  if (!Array.isArray(list)) return { urls, errors: [{ index: -1, input: '', error: 'URL list must be an array.' }] };
  if (list.length > LIMITS.maxUrls) {
    errors.push({ index: -1, input: '', error: `At most ${LIMITS.maxUrls} URLs are allowed.` });
    return { urls, errors };
  }
  list.forEach((item, index) => {
    const r = validateUrl(item, opts);
    if (r.ok) urls.push(r.url);
    else errors.push({ index, input: typeof item === 'string' ? item : '', error: r.error });
  });
  return { urls, errors };
}

/** Parse the text of an imported .txt file: one URL per line; blank lines and #-comments ignored. */
export function parseUrlText(text) {
  if (typeof text !== 'string') return [];
  return text
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const asBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

/**
 * Normalise a settings object.
 *  strict=true  -> invalid fields are reported in `errors` (used when the user saves).
 *  strict=false -> invalid fields silently fall back to a safe value (used when loading stored data).
 */
export function normalizeSettings(input, { strict = false } = {}) {
  const d = DEFAULT_SETTINGS;
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = {};
  const s = { ...d };
  const bad = (key, msg) => { if (strict) errors[key] = msg; };

  if (strict) {
    for (const k of Object.keys(src)) {
      if (!(k in d)) errors[k] = 'Unknown setting.';
    }
  }

  s.allowHttp = asBool(src.allowHttp, d.allowHttp);
  if ('allowHttp' in src && typeof src.allowHttp !== 'boolean') bad('allowHttp', 'Must be true or false.');

  if ('loginUrl' in src) {
    const r = validateUrl(src.loginUrl, { allowHttp: s.allowHttp });
    if (r.ok) s.loginUrl = r.url;
    else bad('loginUrl', r.error);
  }

  if ('zoomPercent' in src) {
    const z = Number(src.zoomPercent);
    if (!Number.isFinite(z)) bad('zoomPercent', 'Zoom must be a number.');
    else {
      if (z < LIMITS.zoomMin || z > LIMITS.zoomMax) bad('zoomPercent', `Zoom must be between ${LIMITS.zoomMin}% and ${LIMITS.zoomMax}%.`);
      else if (z % LIMITS.zoomStep !== 0) bad('zoomPercent', `Zoom must change in steps of ${LIMITS.zoomStep}%.`);
      const snapped = Math.round(z / LIMITS.zoomStep) * LIMITS.zoomStep;
      s.zoomPercent = Math.min(LIMITS.zoomMax, Math.max(LIMITS.zoomMin, snapped));
    }
  }

  for (const key of ['reapplyZoomEachPage', 'autoCapture', 'includeLoginPage', 'continueOnError', 'detectSessionExpiry']) {
    if (key in src) {
      if (typeof src[key] === 'boolean') s[key] = src[key];
      else bad(key, 'Must be true or false.');
    }
  }

  const numberInRange = (key, min, max, label) => {
    if (!(key in src)) return;
    const n = Number(src[key]);
    if (!Number.isFinite(n)) return bad(key, `${label} must be a number.`);
    if (n < min || n > max) bad(key, `${label} must be between ${min} and ${max} seconds.`);
    s[key] = Math.min(max, Math.max(min, Math.round(n)));
  };
  numberInRange('pageDelaySeconds', LIMITS.delayMin, LIMITS.delayMax, 'Page loading delay');
  numberInRange('navigationTimeoutSeconds', LIMITS.navTimeoutMin, LIMITS.navTimeoutMax, 'Navigation timeout');

  if ('captureMode' in src) {
    if (src.captureMode === 'visible' || src.captureMode === 'full') s.captureMode = src.captureMode;
    else bad('captureMode', 'Must be "visible" or "full".');
  }

  if ('filenameFormat' in src) {
    const f = src.filenameFormat;
    if (typeof f !== 'string' || !f.trim()) bad('filenameFormat', 'Filename format cannot be empty.');
    else if (f.length > LIMITS.filenameFormatMax) bad('filenameFormat', `Filename format is longer than ${LIMITS.filenameFormatMax} characters.`);
    else {
      const unknown = [...f.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).filter((t) => !FILENAME_TOKENS.includes(t));
      if (unknown.length) bad('filenameFormat', `Unknown placeholder {${unknown[0]}}. Allowed: ${FILENAME_TOKENS.map((t) => `{${t}}`).join(' ')}`);
      else s.filenameFormat = f.trim();
    }
  }

  return { settings: s, errors, ok: Object.keys(errors).length === 0 };
}

/** Make a string safe to use as (part of) a Windows file name. */
export function sanitizeFilename(name, maxLength = LIMITS.filenameMax) {
  let s = String(name ?? '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._\s-]+|[._\s]+$/g, '');
  if (s.length > maxLength) s = s.slice(0, maxLength).replace(/[._\s]+$/g, '');
  if (!s) s = 'screenshot';
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Short, readable page name from a URL, e.g. https://x.com/ui/dashboards/main -> "x.com_ui_dashboards_main". */
export function pageNameFromUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    const bits = [u.hostname, ...path.split('/').filter(Boolean)];
    return sanitizeFilename(bits.join('_'), 60);
  } catch {
    return 'page';
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Local-time date parts used for the {date}/{time}/{timestamp} placeholders. */
export function timeParts(date) {
  const d = date instanceof Date ? date : new Date(date);
  const Y = d.getFullYear(), M = pad(d.getMonth() + 1), D = pad(d.getDate());
  const h = pad(d.getHours()), m = pad(d.getMinutes()), s = pad(d.getSeconds());
  return { date: `${Y}-${M}-${D}`, time: `${h}-${m}-${s}`, timestamp: `${Y}${M}${D}-${h}${m}${s}` };
}

/** Build a sanitised file name (with .png) from the user's format and a capture context. */
export function buildFilename(format, { index = 1, url = '', capturedAt = new Date() } = {}) {
  let host = 'page';
  try { host = new URL(url).hostname; } catch { /* keep default */ }
  const t = timeParts(capturedAt);
  const values = {
    index: pad(index, 3),
    page: pageNameFromUrl(url),
    host: sanitizeFilename(host, 60),
    date: t.date,
    time: t.time,
    timestamp: t.timestamp,
  };
  const fmt = typeof format === 'string' && format.trim() ? format : DEFAULT_SETTINGS.filenameFormat;
  const filled = fmt.replace(/\{([^{}]*)\}/g, (m, k) => (k in values ? values[k] : ''));
  return `${sanitizeFilename(filled)}.png`;
}

/** Return a name not present in `taken` (a Set of lower-cased names), adding -2, -3 ... before the extension. */
export function uniqueFilename(name, taken) {
  const lower = (n) => n.toLowerCase();
  if (!taken.has(lower(name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 100000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(lower(candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** Is this the unedited placeholder origin from the shipped manifest? */
export function isPlaceholderOrigin(text, marker) {
  return typeof text === 'string' && text.toLowerCase().includes(String(marker).toLowerCase());
}
