// Gallery page: thumbnails, preview, sort/filter, multi-select, single / selected / all downloads (PNG or ZIP).
import { api } from './extension-bridge.js';
import { makeZip, ZipLimitError } from './zip.js';
import { uniqueFilename, sanitizeFilename } from '../extension/lib/validate.js';
import { mountShell, onChange, refreshAll, store, attempt, toast, confirmDialog, errorMessage, esc, $, fmtBytes, fmtTime } from './app.js';

mountShell({ page: 'gallery.html', title: 'Screenshot gallery', lead: 'Everything captured so far. Stored only on this computer.' });

let items = [];                 // metadata + small thumbnail data URLs from the extension
const selected = new Set();
let viewIndex = -1;             // index into `shown()` of the open preview
const grid = $('#grid');

/* ---------- list / filter / sort ---------- */

function shown() {
  const q = $('#filter').value.trim().toLowerCase();
  let list = q ? items.filter((i) => `${i.filename} ${i.url} ${i.title || ''}`.toLowerCase().includes(q)) : [...items];
  const how = $('#sort').value;
  list.sort(how === 'old' ? (a, b) => a.capturedAt - b.capturedAt
    : how === 'name' ? (a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true })
    : how === 'order' ? (a, b) => (a.runId === b.runId ? a.index - b.index : a.capturedAt - b.capturedAt)
    : (a, b) => b.capturedAt - a.capturedAt);
  return list;
}

function render() {
  const list = shown();
  grid.replaceChildren();
  $('#empty').hidden = items.length > 0;
  $('#count').textContent = items.length
    ? `${list.length} of ${items.length} screenshot${items.length === 1 ? '' : 's'} · ${selected.size} selected`
    : '';
  for (const it of list) {
    const el = document.createElement('article');
    el.className = `shot${selected.has(it.id) ? ' selected' : ''}`;
    el.innerHTML = `
      <button type="button" class="thumb" aria-label="Preview ${esc(it.filename)}">
        ${it.thumb ? `<img src="${esc(it.thumb)}" alt="Thumbnail of ${esc(it.filename)}" loading="lazy">` : '<span class="sr-only">No thumbnail</span>'}
        <span class="pick"><input type="checkbox" aria-label="Select ${esc(it.filename)}" ${selected.has(it.id) ? 'checked' : ''}></span>
      </button>
      <div class="meta">
        <div class="fn">${esc(it.filename)}</div>
        <div class="src">${esc(it.url)}</div>
        <div>${esc(fmtTime(it.capturedAt))} · ${esc(fmtBytes(it.bytes))}</div>
        <div><span class="pill ${it.status === 'ok' ? 'ok' : 'bad'}">${it.status === 'ok' ? 'Captured' : esc(it.status)}</span>${it.mode === 'full' || it.mode === 'element' ? ' <span class="pill">Full page</span>' : ''}${it.note ? ` <span class="hint">${esc(it.note)}</span>` : ''}</div>
      </div>
      <div class="actions"><button type="button" class="secondary small" data-a="dl">Download</button><button type="button" class="danger small" data-a="del">Delete</button></div>`;
    const pick = el.querySelector('.pick input');
    pick.addEventListener('click', (e) => e.stopPropagation());
    pick.addEventListener('change', () => { pick.checked ? selected.add(it.id) : selected.delete(it.id); el.classList.toggle('selected', pick.checked); updateButtons(); $('#count').textContent = `${shown().length} of ${items.length} screenshot${items.length === 1 ? '' : 's'} · ${selected.size} selected`; });
    el.querySelector('.thumb').addEventListener('click', (e) => { if (e.target.closest('.pick')) return; openViewer(list.indexOf(it), list); });
    el.querySelector('[data-a="dl"]').addEventListener('click', () => downloadOne(it));
    el.querySelector('[data-a="del"]').addEventListener('click', () => deleteIds([it.id], `Delete "${it.filename}"?`));
    grid.append(el);
  }
  updateButtons();
}

function updateButtons() {
  const has = items.length > 0;
  const c = store.connected && !downloading;
  $('#dl-sel').disabled = !c || selected.size === 0;
  $('#dl-all').disabled = !c || !has;
  $('#del-sel').disabled = !store.connected || selected.size === 0;
  $('#del-all').disabled = !store.connected || !has;
  $('#sel-all').disabled = !has;
  $('#sel-none').disabled = selected.size === 0;
}

async function load() {
  const r = await attempt(() => api.gallery());
  if (!r) return;
  items = r.items;
  for (const id of [...selected]) if (!items.some((i) => i.id === id)) selected.delete(id);
  const u = r.usage;
  $('#storage-note').textContent = u?.usage != null ? `Using ${fmtBytes(u.usage)}${u.quota ? ` of about ${fmtBytes(u.quota)} available to the browser` : ''}. Deleting screenshots frees space.` : '';
  render();
}

/* ---------- downloads ---------- */

let downloading = false;

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('unexpected image data');
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchPng(it) {
  const r = await api.image(it.id);
  return dataUrlToBytes(r.dataUrl);
}

async function downloadOne(it) {
  const bytes = await attempt(() => fetchPng(it));
  if (bytes) saveBlob(new Blob([bytes], { type: 'image/png' }), sanitizeFilename(it.filename.replace(/\.png$/i, '')) + '.png');
}

function setProgress(done, total, text) {
  const box = $('#dl-progress');
  box.hidden = false;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = box.querySelector('.progress');
  bar.setAttribute('aria-valuenow', String(pct));
  bar.firstElementChild.style.width = `${pct}%`;
  $('#dl-text').textContent = text;
}

async function downloadMany(list, label) {
  if (downloading || !list.length) return;
  if (list.length === 1) { await downloadOne(list[0]); return; }
  downloading = true; updateButtons();
  $('#dl-errors').innerHTML = '';
  const asZip = $('#as-zip').checked;
  const failed = [];
  const files = [];
  const taken = new Set();
  try {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      setProgress(i, list.length, `${asZip ? 'Preparing' : 'Saving'} ${i + 1} of ${list.length}: ${it.filename}`);
      try {
        const bytes = await fetchPng(it);
        const name = uniqueFilename(sanitizeFilename(it.filename.replace(/\.png$/i, '')) + '.png', taken);
        taken.add(name.toLowerCase());
        if (asZip) files.push({ name, data: bytes });
        else { saveBlob(new Blob([bytes], { type: 'image/png' }), name); await new Promise((r) => setTimeout(r, 350)); }  // pace multi-file saves so Edge doesn't drop them
      } catch (e) {
        failed.push({ it, why: errorMessage(e) });
      }
    }
    if (asZip && files.length) {
      setProgress(list.length, list.length, 'Building ZIP file…');
      try {
        saveBlob(makeZip(files), `screenshots_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`);
      } catch (e) {
        if (e instanceof ZipLimitError) toast(`${e.message} Untick "Bundle into a ZIP" to download them one by one.`, 'bad', 10000);
        else throw e;
        return;
      }
    }
    const okCount = list.length - failed.length;
    setProgress(list.length, list.length, `${label}: ${okCount} of ${list.length} saved${asZip ? ' in one ZIP' : ''}.`);
    if (failed.length) {
      $('#dl-errors').innerHTML = `<div class="alert warn" role="alert"><strong>${failed.length} file(s) could not be included</strong><ul>${failed.map((f) => `<li>${esc(f.it.filename)} - ${esc(f.why)}</li>`).join('')}</ul></div>`;
    } else toast(`${okCount} screenshots downloaded.`, 'ok');
  } catch (e) {
    toast(errorMessage(e), 'bad', 9000);
  } finally {
    downloading = false; updateButtons();
  }
}

$('#dl-sel').addEventListener('click', () => downloadMany(items.filter((i) => selected.has(i.id)), 'Selected'));
$('#dl-all').addEventListener('click', () => downloadMany(shown().length === items.length ? [...items].sort((a, b) => a.capturedAt - b.capturedAt) : shown(), shown().length === items.length ? 'All' : 'Filtered'));

/* ---------- delete ---------- */

async function deleteIds(ids, title) {
  const yes = await confirmDialog({ title, body: `${ids.length === 1 ? 'This screenshot' : `These ${ids.length} screenshots`} will be permanently removed from this computer. It does not log you out of any website.`, confirmText: 'Delete', danger: true });
  if (!yes) return;
  const r = await attempt(() => api.deleteShots(ids), { ok: `${ids.length} deleted.` });
  if (r) { ids.forEach((id) => selected.delete(id)); await load(); refreshAll().catch(() => {}); }
}
$('#del-sel').addEventListener('click', () => deleteIds([...selected], `Delete ${selected.size} selected screenshot(s)?`));
$('#del-all').addEventListener('click', async () => {
  const yes = await confirmDialog({ title: 'Clear the whole gallery?', body: 'Every screenshot is permanently removed from this computer. It does not log you out of any website.', confirmText: 'Clear gallery', danger: true });
  if (!yes) return;
  const r = await attempt(() => api.clearGallery(), { ok: 'Gallery cleared.' });
  if (r) { selected.clear(); await load(); refreshAll().catch(() => {}); }
});

/* ---------- selection helpers ---------- */

$('#sel-all').addEventListener('click', () => { shown().forEach((i) => selected.add(i.id)); render(); });
$('#sel-none').addEventListener('click', () => { selected.clear(); render(); });
$('#filter').addEventListener('input', render);
$('#sort').addEventListener('change', render);

/* ---------- preview ---------- */

const dlg = $('#viewer');
let viewList = [];

async function openViewer(index, list) {
  viewList = list; viewIndex = index;
  await showView();
  if (!dlg.open) dlg.showModal();
}

async function showView() {
  const it = viewList[viewIndex];
  if (!it) return;
  $('#v-title').textContent = it.filename;
  $('#v-foot').textContent = `${it.url} · ${fmtTime(it.capturedAt)}${it.note ? ' · ' + it.note : ''}`;
  $('#v-prev').disabled = viewIndex <= 0;
  $('#v-next').disabled = viewIndex >= viewList.length - 1;
  const img = $('#v-img');
  img.alt = `Screenshot of ${it.url}`;
  img.removeAttribute('src');
  const r = await attempt(() => api.image(it.id));
  if (r && viewList[viewIndex] === it) img.src = r.dataUrl;
}

$('#v-close').addEventListener('click', () => dlg.close());
$('#v-prev').addEventListener('click', () => { if (viewIndex > 0) { viewIndex--; showView(); } });
$('#v-next').addEventListener('click', () => { if (viewIndex < viewList.length - 1) { viewIndex++; showView(); } });
$('#v-dl').addEventListener('click', () => { const it = viewList[viewIndex]; if (it) downloadOne(it); });
dlg.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') $('#v-prev').click(); else if (e.key === 'ArrowRight') $('#v-next').click(); });
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
dlg.addEventListener('close', () => $('#v-img').removeAttribute('src'));   // release the large image

/* ---------- wiring ---------- */

let lastSig = '';
onChange((s) => {
  updateButtons();
  // Reload when the stored count OR the run's capture counter/run id changes (count alone misses "delete one,
  // capture one", which leaves it unchanged while the contents differ).
  const sig = `${s.galleryCount}|${s.run?.runId}|${s.run?.captured}`;
  if (s.connected && sig !== lastSig) { lastSig = sig; load(); }
});
refreshAll().catch(() => {});
