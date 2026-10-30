// The dashboard's only connection to the extension. Uses chrome.runtime.sendMessage / connect, which Edge
// exposes to a web page ONLY when the page's address matches the extension's "externally_connectable" pattern.
// Nothing here talks to any server.

import { PROTOCOL_VERSION, DEFAULT_EXTENSION_ID } from '../extension/lib/constants.js';

const ID_KEY = 'essa.extensionId';
const REQUEST_TIMEOUT_MS = 20000;

export function getExtensionId() {
  try {
    const saved = localStorage.getItem(ID_KEY);
    if (saved && /^[a-p]{32}$/.test(saved)) return saved;
  } catch { /* storage blocked: fall back to the built-in ID */ }
  return DEFAULT_EXTENSION_ID;
}

export function setExtensionId(id) {
  if (!/^[a-p]{32}$/.test(id)) throw new Error('An extension ID is exactly 32 letters (a-p).');
  try { localStorage.setItem(ID_KEY, id); } catch { /* ignore */ }
}

/** Is this page running in Edge (Chromium) with the messaging API available? */
export function messagingAvailable() {
  return typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
}

export class BridgeError extends Error {
  constructor(message, { code = 'bridge', details } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Why can't we reach the extension? Returns a user-facing explanation and what to do about it.
 */
function explainUnreachable(lastErrorMessage) {
  const m = String(lastErrorMessage || '');
  if (!messagingAvailable()) {
    return new BridgeError(
      'This page cannot reach the extension. Use Microsoft Edge, install the extension, and make sure the address in the extension\'s manifest.json matches this page\'s address exactly. Then reload the extension and this page.',
      { code: 'not_available' },
    );
  }
  if (/Could not establish connection|Receiving end does not exist|extension.*(not found|invalid)|Invalid extension id/i.test(m)) {
    return new BridgeError(
      'The extension is not installed in this Edge profile, is turned off, or its ID differs from the one this dashboard uses. Open edge://extensions, check it is enabled, and compare its ID with the one in Settings → Extension connection.',
      { code: 'not_installed' },
    );
  }
  return new BridgeError(m || 'Could not reach the extension.', { code: 'unreachable' });
}

let nextId = 1;

/** Send one command. Resolves with the extension's reply, rejects with a BridgeError carrying a readable message. */
export function send(cmd, payload) {
  return new Promise((resolve, reject) => {
    if (!messagingAvailable()) return reject(explainUnreachable(''));
    const msg = { v: PROTOCOL_VERSION, cmd, requestId: `r${nextId++}` };
    if (payload !== undefined) msg.payload = payload;

    const timer = setTimeout(() => reject(new BridgeError('The extension did not answer in time. Reload the extension at edge://extensions and try again.', { code: 'timeout' })), REQUEST_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(getExtensionId(), msg, (reply) => {
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) return reject(explainUnreachable(lastError.message));
        if (!reply || typeof reply !== 'object') return reject(new BridgeError('The extension sent an empty reply.', { code: 'empty' }));
        if (reply.ok === false) return reject(new BridgeError(reply.error || 'The extension refused the request.', { code: reply.code || 'rejected', details: reply.details }));
        resolve(reply);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(explainUnreachable(e.message));
    }
  });
}

/**
 * Live status updates. Calls onRun(snapshot) for every change, onStatus('connected'|'disconnected', reason) when the
 * link changes, and reconnects automatically (the extension's service worker can be stopped and restarted by Edge).
 * Returns a function that closes it.
 */
export function watch({ onRun, onStatus }) {
  let port = null;
  let closed = false;
  let retry = 0;
  let timer = null;

  const connect = () => {
    if (closed) return;
    if (!messagingAvailable()) { onStatus?.('disconnected', explainUnreachable('').message); return; }
    try {
      port = chrome.runtime.connect(getExtensionId());
    } catch (e) {
      onStatus?.('disconnected', explainUnreachable(e.message).message);
      schedule();
      return;
    }
    port.onMessage.addListener((m) => {
      if (!m || m.v !== PROTOCOL_VERSION) return;
      if (m.type === 'run') { retry = 0; onStatus?.('connected'); onRun?.(m.run); }
      else if (m.type === 'error') onStatus?.('disconnected', m.error);
    });
    port.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError?.message || '';
      port = null;
      onStatus?.('disconnected', why ? explainUnreachable(why).message : 'The connection to the extension was closed. Reconnecting…');
      schedule();
    });
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    retry = Math.min(retry + 1, 6);
    timer = setTimeout(connect, Math.min(1000 * 2 ** (retry - 1), 15000));
  };

  connect();
  return () => { closed = true; clearTimeout(timer); try { port?.disconnect(); } catch { /* ignore */ } };
}

/* ---------- convenience wrappers ---------- */
export const api = {
  ping: () => send('ping'),
  state: () => send('state.get'),
  saveSettings: (settings) => send('settings.save', { settings }),
  saveUrls: (urls) => send('urls.save', { urls }),
  openLogin: () => send('run.openLogin'),
  cancelLogin: () => send('run.cancelLogin'),
  confirmLogin: () => send('run.confirmLogin'),
  start: () => send('run.start'),
  pause: () => send('run.pause'),
  resume: () => send('run.resume'),
  stop: () => send('run.stop'),
  gallery: () => send('gallery.list'),
  image: (id) => send('gallery.get', { id }),
  deleteShots: (ids) => send('gallery.delete', { ids }),
  clearGallery: () => send('gallery.clear', { confirm: true }),
  clearAll: () => send('data.clearAll', { confirm: true }),
};
