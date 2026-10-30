// Service worker entry point.
// Three ways in:
//   chrome.runtime.onMessageExternal  - commands from the GitHub Pages dashboard (origin-checked + validated)
//   chrome.runtime.onConnectExternal  - the dashboard's live status port (same checks)
//   chrome.runtime.onMessage          - the popup and options page (our own pages only)

import { PROTOCOL_VERSION, COMMANDS } from './lib/constants.js';
import { trustedFromMatchPattern, checkSender, validateRequest } from './lib/messaging.js';
import {
  loadSettings, saveSettings, loadUrls, saveUrls, loadGalleryMeta, getImage,
  deleteScreenshots, clearGallery, clearAllData, reconcileGallery, estimateUsage, StorageError,
} from './lib/storage.js';
import { normalizeSettings } from './lib/validate.js';
import * as runner from './lib/runner.js';

/* ---------------- trust ---------------- */

// The ONE place the dashboard address is configured is manifest.json -> externally_connectable.matches[0].
// The browser enforces it first; this re-checks it in code (defence in depth).
function getTrusted() {
  const patterns = chrome.runtime.getManifest().externally_connectable?.matches;
  return trustedFromMatchPattern(Array.isArray(patterns) && patterns.length === 1 ? patterns[0] : '');
}

/* ---------------- command handling ---------------- */

const reply = (ok, data = {}) => ({ v: PROTOCOL_VERSION, ok, ...data });
const errReply = (code, error, extra = {}) => reply(false, { code, error, ...extra });

async function fullState() {
  const [settings, urls, gallery, usage] = await Promise.all([loadSettings(), loadUrls(), loadGalleryMeta(), estimateUsage()]);
  return { run: runner.snapshot(), settings, urls, galleryCount: gallery.length, usage };
}

/** Image blobs can't cross the messaging boundary as Blobs, so they travel as data: URLs. */
async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

async function execute(cmd, payload) {
  switch (cmd) {
    case 'ping':
      return reply(true, { name: 'edge-screenshot-automation', extensionVersion: chrome.runtime.getManifest().version, commands: COMMANDS });
    case 'state.get':
      return reply(true, await fullState());
    case 'settings.save': {
      // A save may carry just the fields that changed. Apply it on top of what is stored, then validate the whole
      // result, so saving one option can never silently reset the others to their defaults.
      const merged = normalizeSettings({ ...(await loadSettings()), ...payload.settings }, { strict: true });
      if (!merged.ok) return errReply('bad_payload', 'Invalid settings.', { details: merged.errors });
      await saveSettings(merged.settings);
      return reply(true, { settings: merged.settings });
    }
    case 'urls.save':
      await saveUrls(payload.urls);
      return reply(true, { urls: payload.urls });

    case 'run.openLogin': { const r = await runner.openLogin(); return r.ok ? reply(true, { ...r, run: runner.snapshot() }) : errReply('rejected', r.error); }
    case 'run.cancelLogin': { const r = await runner.cancelLogin(); return r.ok ? reply(true, { run: runner.snapshot() }) : errReply('rejected', r.error); }
    case 'run.confirmLogin': { const r = await runner.confirmLogin(); return r.ok ? reply(true, { run: runner.snapshot() }) : errReply('rejected', r.error); }
    case 'run.start': { const r = await runner.start(); return r.ok ? reply(true, { run: runner.snapshot() }) : errReply('rejected', r.error); }
    case 'run.pause': { const r = await runner.pause(); return r.ok ? reply(true, { run: runner.snapshot() }) : errReply('rejected', r.error); }
    case 'run.resume': { const r = await runner.resume(); return r.ok ? reply(true, { run: runner.snapshot() }) : errReply('rejected', r.error); }
    case 'run.stop': { const r = await runner.stop(); return r.ok ? reply(true, { run: runner.snapshot() }) : errReply('rejected', r.error); }

    case 'gallery.list': {
      const items = await loadGalleryMeta();
      const withThumbs = [];
      for (const m of items) {
        const t = await getImage(m.id, 'thumb').catch(() => null);
        withThumbs.push({ ...m, thumb: t ? await blobToDataUrl(t) : null });
      }
      return reply(true, { items: withThumbs, usage: await estimateUsage() });
    }
    case 'gallery.get': {
      const meta = (await loadGalleryMeta()).find((m) => m.id === payload.id);
      if (!meta) return errReply('not_found', 'That screenshot no longer exists.');
      const blob = await getImage(payload.id, 'full');
      if (!blob) return errReply('not_found', 'The image data is missing.');
      return reply(true, { meta, dataUrl: await blobToDataUrl(blob) });
    }
    case 'gallery.delete':
      await deleteScreenshots(payload.ids);
      return reply(true, { deleted: payload.ids.length });
    case 'gallery.clear':
      await clearGallery();
      return reply(true, {});
    case 'data.clearAll': {
      const rs = runner.snapshot().state;
      if (!['idle', 'completed', 'stopped', 'error'].includes(rs)) return errReply('rejected', 'Stop the current run before clearing all data.');
      await clearAllData();
      await runner.init();
      return reply(true, {});
    }
    default:
      return errReply('unknown_command', 'Unknown command.');
  }
}

async function handle(rawMsg, sender, { external }) {
  try {
    if (external) {
      const check = checkSender(sender, getTrusted());
      if (!check.ok) return errReply(check.code, check.error);
    } else if (sender.id !== chrome.runtime.id) {
      return errReply('bad_sender', 'Not an extension page.');
    }
    await runner.init();
    const settings = await loadSettings();
    const req = validateRequest(rawMsg, { allowHttp: settings.allowHttp });
    if (!req.ok) return errReply(req.code, req.error, req.details ? { details: req.details } : {});
    const res = await execute(req.cmd, req.payload);
    if (req.requestId) res.requestId = req.requestId;
    return res;
  } catch (e) {
    const quota = e instanceof StorageError && e.quota;
    return errReply(quota ? 'storage_full' : 'internal', e?.message || String(e));
  }
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  handle(msg, sender, { external: true }).then(sendResponse);
  return true; // keep the channel open for the async reply
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // ignore everything not from our own pages
  handle(msg, sender, { external: false }).then(sendResponse);
  return true;
});

/* ---------------- live status port ---------------- */

const ports = new Set();

function broadcast(snap) {
  const msg = { v: PROTOCOL_VERSION, type: 'run', run: snap };
  for (const p of ports) { try { p.postMessage(msg); } catch { ports.delete(p); } }
}
runner.subscribe(broadcast);

chrome.runtime.onConnectExternal.addListener(async (port) => {
  const check = checkSender(port.sender, getTrusted());
  if (!check.ok) { try { port.postMessage({ v: PROTOCOL_VERSION, type: 'error', code: check.code, error: check.error }); } catch { /* ignore */ } port.disconnect(); return; }
  await runner.init();
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.postMessage({ v: PROTOCOL_VERSION, type: 'run', run: runner.snapshot() });
});

/* ---------------- startup ---------------- */

chrome.runtime.onInstalled.addListener(async () => {
  await runner.init();
  await reconcileGallery().catch(() => {});
});
chrome.runtime.onStartup.addListener(async () => {
  await runner.init();
  await reconcileGallery().catch(() => {});
});
runner.init().catch(() => {});
