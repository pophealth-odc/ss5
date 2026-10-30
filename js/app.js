// Shared shell for every dashboard page: sidebar, connection status, live state store, toasts, confirm dialog.
// Each page imports { mountShell, store, toast, confirmDialog, esc } from here.

import { STATE_LABELS, BUSY_STATES } from '../extension/lib/constants.js';
import { api, watch, BridgeError, messagingAvailable } from './extension-bridge.js';

/* ---------- tiny helpers ---------- */

/** Escape text for safe insertion with innerHTML. (Page code otherwise uses textContent.) */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function fmtBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function fmtTime(ms) {
  if (!ms) return '–';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/* ---------- live state store ---------- */

const listeners = new Set();
export const store = {
  run: null,           // latest run snapshot from the extension
  connected: false,
  connectionNote: '',  // human explanation when not connected
  settings: null,
  urls: null,
  galleryCount: 0,
  usage: null,
  version: '',
};

export function onChange(fn) { listeners.add(fn); fn(store); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(store); } catch (e) { console.error(e); } } }

/** Pull settings / URLs / counts once (the run snapshot arrives live over the port). */
export async function refreshAll() {
  const s = await api.state();
  store.run = s.run;
  store.settings = s.settings;
  store.urls = s.urls;
  store.galleryCount = s.galleryCount;
  store.usage = s.usage;
  emit();
  return s;
}

let started = false;
function startWatching() {
  if (started) return;
  started = true;
  watch({
    onRun: (run) => {
      const before = store.run?.captured;
      store.run = run;
      if (run.captured !== before) api.state().then((s) => { store.galleryCount = s.galleryCount; store.usage = s.usage; emit(); }).catch(() => {});
      emit();
    },
    onStatus: (status, why) => {
      const was = store.connected;
      store.connected = status === 'connected';
      store.connectionNote = store.connected ? '' : (why || '');
      if (store.connected && !was) refreshAll().catch(() => {});
      emit();
    },
  });
}

/* ---------- toasts ---------- */

export function toast(message, kind = 'info', ms = 5000) {
  let region = $('#toasts');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toasts';
    region.className = 'toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  region.append(t);
  setTimeout(() => t.remove(), ms);
}

export function errorMessage(e) {
  if (e instanceof BridgeError) {
    if (e.details && typeof e.details === 'object') {
      const bits = Array.isArray(e.details)
        ? e.details.slice(0, 3).map((d) => `${d.input ? d.input + ': ' : ''}${d.error}`)
        : Object.values(e.details).slice(0, 3);
      if (bits.length) return `${e.message} ${bits.join(' · ')}`;
    }
    return e.message;
  }
  return e?.message || String(e);
}

/** Run an action, toast any failure in plain words. Returns the result, or undefined on failure. */
export async function attempt(fn, { ok } = {}) {
  try {
    const r = await fn();
    if (ok) toast(ok, 'ok');
    return r;
  } catch (e) {
    toast(errorMessage(e), 'bad', 9000);
    return undefined;
  }
}

/* ---------- confirm dialog (replaces window.confirm so it is styled, focus-trapped and testable) ---------- */

export function confirmDialog({ title, body, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm';
    d.setAttribute('aria-labelledby', 'cd-title');
    d.innerHTML = `<h2 id="cd-title">${esc(title)}</h2><p>${esc(body)}</p>
      <div class="btn-row"><button type="button" class="secondary" data-act="no">Cancel</button>
      <button type="button" class="${danger ? 'danger' : ''}" data-act="yes">${esc(confirmText)}</button></div>`;
    document.body.append(d);
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.addEventListener('click', (e) => { const a = e.target.closest('button')?.dataset.act; if (a) done(a === 'yes'); });
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    d.showModal();
    d.querySelector('[data-act="no"]').focus();
  });
}

/* ---------- shell (sidebar + connection banner) ---------- */

const NAV = [
  { href: 'index.html', label: 'Dashboard', icon: 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10' },
  { href: 'settings.html', label: 'Settings', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2m12 0h2M12 4v2m0 12v2' },
  { href: 'gallery.html', label: 'Gallery', icon: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4', badge: true },
];

export function mountShell({ page, title, lead, actionsHtml = '' }) {
  document.title = `${title} - Edge Screenshot Automation`;
  const nav = NAV.map((n) => `
    <a href="${n.href}" ${n.href === page ? 'aria-current="page"' : ''}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${n.icon}"/></svg>
      <span>${esc(n.label)}</span>${n.badge ? '<span class="badge" id="nav-count" aria-label="screenshots">0</span>' : ''}
    </a>`).join('');

  const root = document.getElementById('root');
  const content = root.innerHTML;
  root.innerHTML = `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0b63ce"/><path d="M8 13V8h5M24 13V8h-5M8 19v5h5M24 19v5h-5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/><circle cx="16" cy="16" r="3" fill="#fff"/></svg>
          <span>Edge Screenshot<br>Automation</span>
        </div>
        <nav class="nav" aria-label="Main">${nav}</nav>
        <div class="side-foot">Runs locally in Microsoft Edge. Nothing is uploaded.</div>
      </aside>
      <main class="main" id="main" tabindex="-1">
        <div class="page-head">
          <div><h1>${esc(title)}</h1>${lead ? `<p class="lead">${esc(lead)}</p>` : ''}</div>
          <div class="row"><span class="conn" id="conn" role="status"><span class="dot"></span><span id="conn-text">Connecting…</span></span>${actionsHtml}</div>
        </div>
        <div id="conn-alert"></div>
        <div id="page">${content}</div>
      </main>
    </div>`;

  onChange((s) => {
    const conn = $('#conn');
    const text = $('#conn-text');
    if (conn) {
      const busy = s.run && BUSY_STATES.includes(s.run.state);
      conn.className = `conn ${s.connected ? (busy ? 'warn' : 'ok') : 'bad'}`;
      text.textContent = s.connected ? `Extension connected · ${STATE_LABELS[s.run?.state] || 'Idle'}` : 'Extension not connected';
    }
    const nc = $('#nav-count');
    if (nc) nc.textContent = String(s.galleryCount ?? 0);
    const alertBox = $('#conn-alert');
    if (alertBox) {
      if (s.connected) alertBox.innerHTML = '';
      else {
        const why = s.connectionNote || (messagingAvailable() ? 'Looking for the extension…' : 'This browser cannot talk to the extension. Use Microsoft Edge.');
        alertBox.innerHTML = `<div class="alert bad" role="alert"><strong>The extension is not connected</strong>${esc(why)}<div class="actions"><a class="btn secondary small" href="index.html#setup">Setup help</a></div></div>`;
      }
    }
  });
  startWatching();
  return root;
}
