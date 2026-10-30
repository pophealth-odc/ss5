// Settings page. The extension is the source of truth and the strict validator; this page shows values,
// sends changes, and displays the extension's per-field errors.
import { DEFAULT_SETTINGS, LIMITS } from '../extension/lib/constants.js';
import { buildFilename } from '../extension/lib/validate.js';
import { api, getExtensionId, setExtensionId } from './extension-bridge.js';
import { mountShell, onChange, refreshAll, store, attempt, toast, confirmDialog, errorMessage, $, $$, fmtBytes } from './app.js';

mountShell({ page: 'settings.html', title: 'Settings', lead: 'Login address, browser zoom, loading delay and screenshot options. Saved on this computer.' });

const form = $('#form');
const FIELDS = ['loginUrl', 'allowHttp', 'includeLoginPage', 'detectSessionExpiry', 'zoomPercent', 'reapplyZoomEachPage',
  'pageDelaySeconds', 'navigationTimeoutSeconds', 'captureMode', 'autoCapture', 'continueOnError', 'filenameFormat'];

/* ---------- read / write the form ---------- */

function fill(s) {
  $('#loginUrl').value = s.loginUrl;
  for (const k of ['allowHttp', 'includeLoginPage', 'detectSessionExpiry', 'reapplyZoomEachPage', 'autoCapture', 'continueOnError']) $(`#${k}`).checked = !!s[k];
  $('#zoomPercent').value = String(s.zoomPercent);
  $('#pageDelaySeconds').value = String(s.pageDelaySeconds);
  $('#navigationTimeoutSeconds').value = String(s.navigationTimeoutSeconds);
  $(`#mode-${s.captureMode}`).checked = true;
  $('#filenameFormat').value = s.filenameFormat;
  syncZoom(); syncPresets(); syncPreview();
}

function read() {
  return {
    loginUrl: $('#loginUrl').value.trim(),
    allowHttp: $('#allowHttp').checked,
    includeLoginPage: $('#includeLoginPage').checked,
    detectSessionExpiry: $('#detectSessionExpiry').checked,
    zoomPercent: Number($('#zoomPercent').value),
    reapplyZoomEachPage: $('#reapplyZoomEachPage').checked,
    pageDelaySeconds: Number($('#pageDelaySeconds').value),
    navigationTimeoutSeconds: Number($('#navigationTimeoutSeconds').value),
    captureMode: $('input[name="captureMode"]:checked')?.value || 'visible',
    autoCapture: $('#autoCapture').checked,
    continueOnError: $('#continueOnError').checked,
    filenameFormat: $('#filenameFormat').value,
  };
}

function showErrors(details) {
  for (const k of FIELDS) {
    const el = $(`#${k}-err`);
    const input = $(`#${k}`);
    if (el) el.textContent = details?.[k] || '';
    if (input) input.setAttribute('aria-invalid', details?.[k] ? 'true' : 'false');
  }
}

/* ---------- zoom ---------- */

function syncZoom() {
  const v = Number($('#zoomPercent').value);
  $('#zoom-readout').textContent = `${v}%`;
  $('#zoomPercent').setAttribute('aria-valuetext', `${v} percent`);
}
$('#zoomPercent').addEventListener('input', syncZoom);
$('#zoom-reset').addEventListener('click', () => { $('#zoomPercent').value = '100'; syncZoom(); });

/* ---------- delay presets ---------- */

const presets = $('#delay-presets');
for (const n of LIMITS.delayPresets) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'secondary'; b.dataset.v = String(n); b.textContent = `${n} s`;
  b.addEventListener('click', () => { $('#pageDelaySeconds').value = String(n); syncPresets(); });
  presets.append(b);
}
function syncPresets() {
  const cur = Number($('#pageDelaySeconds').value);
  for (const b of $$('button', presets)) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === cur));
}
$('#pageDelaySeconds').addEventListener('input', syncPresets);

/* ---------- file name preview ---------- */

function syncPreview() {
  const fmt = $('#filenameFormat').value;
  try { $('#fn-preview').textContent = buildFilename(fmt, { index: 3, url: 'https://example.com/reports/overview', capturedAt: new Date() }); }
  catch { $('#fn-preview').textContent = '–'; }
}
$('#filenameFormat').addEventListener('input', syncPreview);

/* ---------- save / defaults ---------- */

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showErrors(null);
  const saveBtn = $('#save');
  saveBtn.disabled = true;
  $('#save-state').textContent = 'Saving…';
  try {
    const r = await api.saveSettings(read());
    store.settings = r.settings;
    fill(r.settings);
    $('#save-state').textContent = `Saved ${new Date().toLocaleTimeString()}`;
    toast('Settings saved.', 'ok');
  } catch (err) {
    $('#save-state').textContent = 'Not saved';
    if (err.details && !Array.isArray(err.details)) {
      showErrors(err.details);
      const first = FIELDS.find((k) => err.details[k]);
      if (first) $(first === 'captureMode' ? '#mode-visible' : `#${first}`)?.focus();
      toast('Some settings need fixing - see the messages in red.', 'bad');
    } else toast(errorMessage(err), 'bad', 9000);
  } finally {
    saveBtn.disabled = !store.connected;
  }
});

$('#defaults').addEventListener('click', async () => {
  if (await confirmDialog({ title: 'Restore default settings?', body: 'Your login URL and options on this page go back to their original values. Your URL list and screenshots are not touched. Press "Save settings" to keep the change.', confirmText: 'Restore defaults' })) {
    showErrors(null);
    fill(DEFAULT_SETTINGS);
  }
});

/* ---------- extension connection ---------- */

$('#x-self').textContent = location.origin + location.pathname.replace(/[^/]*$/, '');
$('#x-id').textContent = getExtensionId();
$('#x-setid').addEventListener('click', () => {
  const v = $('#x-newid').value.trim();
  try { setExtensionId(v); $('#x-err').textContent = ''; toast('Extension ID saved. Reloading…', 'ok'); setTimeout(() => location.reload(), 600); }
  catch (e) { $('#x-err').textContent = e.message; }
});
$('#x-recheck').addEventListener('click', async () => {
  const r = await attempt(() => api.ping());
  if (r) { toast(`Connected to extension ${r.extensionVersion}.`, 'ok'); refreshAll().catch(() => {}); }
});

/* ---------- data ---------- */

$('#d-clear').addEventListener('click', async () => {
  if (store.run && ['preparing', 'navigating', 'waiting_load', 'capturing', 'saving', 'paused'].includes(store.run.state)) { toast('Stop the current run before deleting data.', 'warn'); return; }
  const yes = await confirmDialog({
    title: 'Delete ALL stored data?',
    body: 'This removes your settings, your URL list and every screenshot from this computer. It cannot be undone. It does not sign you out of any website.',
    confirmText: 'Delete everything', danger: true,
  });
  if (!yes) return;
  const r = await attempt(() => api.clearAll(), { ok: 'All stored data was deleted.' });
  if (r) { await refreshAll().catch(() => {}); if (store.settings) fill(store.settings); }
});

/* ---------- wiring ---------- */

let filled = false;
let touched = false;      // the user has edited something: never overwrite their input with stored values
form.addEventListener('input', () => { touched = true; });
form.addEventListener('change', () => { touched = true; });
onChange((s) => {
  $('#x-status').textContent = s.connected ? 'Connected' : 'Not connected';
  $('#x-status').className = s.connected ? '' : 'error-text';
  $('#save').disabled = !s.connected;
  $('#d-usage').textContent = fmtBytes(s.usage?.usage);
  $('#d-count').textContent = String(s.galleryCount ?? 0);
  if (s.settings && !filled) {
    filled = true;
    if (!touched) fill(s.settings);
    else toast('Your stored settings loaded, but you had already started editing, so your changes were kept.', 'info', 7000);
  }
});
api.ping().then((r) => { $('#x-version').textContent = r.extensionVersion; }).catch(() => { $('#x-version').textContent = '–'; });
fill(DEFAULT_SETTINGS);     // show sensible values immediately; replaced by the stored ones as soon as the extension answers
refreshAll().catch(() => {});
