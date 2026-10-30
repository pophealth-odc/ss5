// Dashboard page: login confirmation, run controls, live progress, URL manager.
import { STATE_LABELS, EXAMPLE_URLS, LIMITS } from '../extension/lib/constants.js';
import { validateUrl, validateUrlList, parseUrlText } from '../extension/lib/validate.js';
import { api } from './extension-bridge.js';
import { mountShell, onChange, refreshAll, store, attempt, toast, confirmDialog, esc, $, fmtBytes } from './app.js';

mountShell({ page: 'index.html', title: 'Dashboard', lead: 'Open your login page, sign in yourself, then confirm to start the automation.' });
$('#self-addr').textContent = location.origin + location.pathname.replace(/[^/]*$/, '') + '*';

/* ---------------- run controls ---------------- */

const btn = {
  open: $('#b-open'), start: $('#b-start'), pause: $('#b-pause'), resume: $('#b-resume'), stop: $('#b-stop'), clear: $('#b-clear'),
};

// Button presses are run one after another. A press that arrives while another call is still in flight WAITS its
// turn - it is never silently dropped (a person clicking "I'm Logged In" right after another action must not lose
// that click). The extension itself re-validates every command, so ordering here is only for tidy UI feedback.
let busyCall = false;
let pending = Promise.resolve();
function act(fn, okMsg) {
  const run = async () => {
    busyCall = true;
    render(store);
    try { await attempt(fn, { ok: okMsg }); } finally { busyCall = false; render(store); }
  };
  pending = pending.then(run, run);
  return pending;
}

btn.open.addEventListener('click', () => act(() => api.openLogin()));
btn.start.addEventListener('click', () => act(() => api.start()));
btn.pause.addEventListener('click', () => act(() => api.pause()));
btn.resume.addEventListener('click', () => act(() => api.resume()));
btn.stop.addEventListener('click', () => act(() => api.stop()));
btn.clear.addEventListener('click', async () => {
  const yes = await confirmDialog({
    title: 'Delete all screenshots?',
    body: 'This permanently removes every screenshot stored by the extension on this computer. It does not log you out of any website.',
    confirmText: 'Delete screenshots', danger: true,
  });
  if (yes) act(() => api.clearGallery(), 'Gallery cleared.');
});

/* ---------------- login confirmation panel ---------------- */

const slot = $('#login-slot');
let panelKey = '';

function renderLoginPanel(run) {
  const a = run?.actions;
  const waiting = a?.confirmLogin || a?.cancelLogin;
  const reauth = run?.state === 'paused' && run?.loginConfirmed === false;
  const key = `${waiting}|${reauth}|${run?.state}|${run?.lastError}`;
  if (key === panelKey) return;               // do not rebuild (and steal focus from) an unchanged panel
  panelKey = key;
  if (!waiting) { slot.innerHTML = ''; return; }

  const status = reauth ? 'Session needs a fresh login' : 'Waiting for user login';
  const detail = reauth
    ? esc(run.lastError || 'Your session may have expired.') + ' Sign in again in Microsoft Edge, then confirm to continue where the run left off.'
    : 'Complete your login and MFA in Microsoft Edge.';
  slot.innerHTML = `
    <section class="card login-panel" aria-labelledby="lp-h" role="region">
      <h2 id="lp-h"><span class="pulse" aria-hidden="true"></span>Login confirmation</h2>
      <p class="status-line">Status: ${status}.</p>
      <p>${detail}</p>
      <p class="hint">Sign in yourself on the real website - this tool never sees or stores your password or MFA code. The button stays available for as long as you need.</p>
      <div class="btn-row">
        <button type="button" class="ok big" id="lp-confirm">I'm Logged In — Continue Automation</button>
        <button type="button" class="secondary big" id="lp-cancel">${reauth ? 'Stop run' : 'Cancel'}</button>
      </div>
    </section>`;
  $('#lp-confirm').addEventListener('click', () => act(() => api.confirmLogin(), undefined));
  $('#lp-cancel').addEventListener('click', () => act(() => (reauth ? api.stop() : api.cancelLogin())));
}

/* ---------------- summary / progress rendering ---------------- */

function setText(id, v) { const el = $(id); if (el && el.textContent !== v) el.textContent = v; }

function render(s) {
  const run = s.run;
  const a = run?.actions || {};
  const on = (b, v) => { b.disabled = !v || busyCall || !s.connected; };
  on(btn.open, a.openLogin); on(btn.start, a.start); on(btn.pause, a.pause); on(btn.resume, a.resume); on(btn.stop, a.stop);
  btn.clear.disabled = !s.connected || !s.galleryCount || (run && ['preparing', 'navigating', 'waiting_load', 'capturing', 'saving'].includes(run.state));

  renderLoginPanel(run);

  const label = run ? (STATE_LABELS[run.state] || run.state) : '–';
  const p = run?.progress || { total: 0, done: 0, page: 0, percent: 0 };
  setText('#s-state', label);
  setText('#s-action', run?.action || '');
  setText('#s-progress', p.total ? `${p.percent}%` : '–');
  setText('#s-pages', p.total ? `${p.done} of ${p.total} pages` : 'No run yet');
  setText('#s-captured', String(run?.captured ?? 0));
  setText('#s-failed', run?.failed ? `${run.failed} failed` : 'No failures');
  setText('#s-store', fmtBytes(s.usage?.usage));
  setText('#s-store-sub', s.usage?.quota ? `of ${fmtBytes(s.usage.quota)} available` : `${s.galleryCount ?? 0} screenshot(s)`);

  setText('#f-state', label);
  setText('#f-action', run?.action || '–');
  setText('#f-url', run?.currentUrl || '–');
  setText('#f-page', p.total ? `${p.page} of ${p.total}` : '–');
  setText('#f-counts', `${run?.captured ?? 0} captured · ${run?.failed ?? 0} failed`);
  setText('#f-error', run?.lastError || 'None');

  const bar = $('#bar');
  bar.setAttribute('aria-valuenow', String(p.percent));
  bar.firstElementChild.style.width = `${p.percent}%`;     // CSSOM property assignment is allowed under the strict CSP
  bar.className = `progress ${run?.state === 'completed' ? 'done' : run?.state === 'error' ? 'err' : ''}`;

  const w = $('#warnings');
  const ws = run?.warnings || [];
  const wk = ws.join('|');
  if (w.dataset.k !== wk) {
    w.dataset.k = wk;
    w.innerHTML = ws.length ? `<div class="alert warn"><strong>Heads up</strong><ul>${ws.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  }

  const hint = $('#control-hint');
  hint.textContent = run?.state === 'completed' ? 'Finished. To run again, open the login page and confirm again.'
    : run?.state === 'stopped' ? 'Stopped. To run again, open the login page and confirm again.'
    : 'Open the login page, sign in yourself (including MFA), then confirm here. Nothing is visited before you confirm.';
}

/* ---------------- URL manager ---------------- */

let urls = [];          // working copy being edited
let savedKey = '';
let loadedOnce = false;
const listEl = $('#url-list');
const errEl = $('#url-error');

function dirty() { return JSON.stringify(urls) !== savedKey; }

function renderUrls() {
  listEl.replaceChildren();
  $('#url-empty').hidden = urls.length > 0;
  $('#url-count').textContent = urls.length ? `${urls.length} page${urls.length === 1 ? '' : 's'}` : '';
  const allowHttp = !!store.settings?.allowHttp;
  urls.forEach((u, i) => {
    const li = document.createElement('li');
    const v = validateUrl(u, { allowHttp });
    li.className = `url-item${v.ok ? '' : ' invalid'}`;
    li.innerHTML = `<span class="num">${i + 1}.</span><div><input type="text" value="${esc(u)}" aria-label="URL ${i + 1}" aria-invalid="${!v.ok}">${v.ok ? '' : `<div class="error-text">${esc(v.error)}</div>`}</div>
      <div class="tools"><button type="button" class="icon-btn" data-a="up" aria-label="Move URL ${i + 1} up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="icon-btn" data-a="down" aria-label="Move URL ${i + 1} down" ${i === urls.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="icon-btn" data-a="del" aria-label="Remove URL ${i + 1}">✕</button></div>`;
    const input = li.querySelector('input');
    input.addEventListener('change', () => { urls[i] = input.value.trim(); renderUrls(); });
    li.querySelector('.tools').addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      let focusRow = i;                                   // which row should keep keyboard focus afterwards
      if (a === 'up' && i > 0) { [urls[i - 1], urls[i]] = [urls[i], urls[i - 1]]; focusRow = i - 1; }
      else if (a === 'down' && i < urls.length - 1) { [urls[i + 1], urls[i]] = [urls[i], urls[i + 1]]; focusRow = i + 1; }
      else if (a === 'del') { urls.splice(i, 1); focusRow = Math.min(i, urls.length - 1); }
      else return;
      renderUrls();
      const rows = listEl.children;
      const target = rows[focusRow];
      // Keep focus on the same kind of control; fall back to the row's first enabled button if that one is now disabled.
      const same = target?.querySelector(`[data-a="${a}"]:not(:disabled)`);
      (same || target?.querySelector('button:not(:disabled)') || $('#url-new'))?.focus();
    });
    listEl.append(li);
  });
  const d = dirty();
  $('#url-dirty').textContent = d ? 'Unsaved changes' : (loadedOnce ? 'Saved' : '');
  $('#url-save').disabled = !store.connected;
}

function addUrls(list) {
  const known = new Set(urls);
  let added = 0, dup = 0;
  for (const raw of list) {
    const t = raw.trim();
    if (!t) continue;
    const norm = validateUrl(t, { allowHttp: true }).url || t;
    if (known.has(norm)) { dup++; continue; }
    known.add(norm); urls.push(norm); added++;
  }
  if (urls.length > LIMITS.maxUrls) { urls.length = LIMITS.maxUrls; toast(`Only ${LIMITS.maxUrls} URLs are allowed; the rest were dropped.`, 'warn'); }
  renderUrls();
  return { added, dup };
}

$('#url-add').addEventListener('click', () => {
  const input = $('#url-new');
  const v = validateUrl(input.value, { allowHttp: !!store.settings?.allowHttp });
  if (!v.ok) { errEl.textContent = v.error; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
  errEl.textContent = ''; input.removeAttribute('aria-invalid');
  const r = addUrls([v.url]);
  if (r.dup) toast('That URL is already in the list.', 'warn');
  input.value = ''; input.focus();
});
$('#url-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#url-add').click(); } });

$('#url-example').addEventListener('click', () => { urls = [...EXAMPLE_URLS]; renderUrls(); toast('Example list loaded. Press "Save list" to keep it.', 'info'); });
$('#url-clear').addEventListener('click', async () => {
  if (!urls.length) return;
  if (await confirmDialog({ title: 'Remove all URLs?', body: 'This clears the list on this page. Press "Save list" afterwards to make it permanent.', confirmText: 'Remove all', danger: true })) { urls = []; renderUrls(); }
});

$('#url-import').addEventListener('click', () => $('#url-file').click());
$('#url-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 512 * 1024) { toast('That file is too large to be a URL list.', 'bad'); return; }
  const lines = parseUrlText(await f.text());
  const check = validateUrlList(lines, { allowHttp: !!store.settings?.allowHttp });
  const r = addUrls(lines);
  const bad = check.errors.length;
  toast(`Imported ${r.added} URL(s)${r.dup ? `, ${r.dup} duplicate(s) skipped` : ''}${bad ? `. ${bad} line(s) are invalid and highlighted in red - fix or remove them before saving.` : '.'}`, bad ? 'warn' : 'ok', 8000);
});

$('#url-export').addEventListener('click', () => {
  if (!urls.length) { toast('There are no URLs to export.', 'warn'); return; }
  const blob = new Blob([`# Edge Screenshot Automation - URL list\n${urls.join('\n')}\n`], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'urls.txt';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('#url-save').addEventListener('click', async () => {
  const check = validateUrlList(urls, { allowHttp: !!store.settings?.allowHttp });
  if (check.errors.length) {
    toast(`${check.errors.length} URL(s) are invalid (shown in red). Fix or remove them, then save.`, 'bad', 8000);
    return;
  }
  const r = await attempt(() => api.saveUrls(urls), { ok: 'URL list saved.' });
  if (r) { urls = r.urls; savedKey = JSON.stringify(urls); store.urls = urls; renderUrls(); }
});

window.addEventListener('beforeunload', (e) => { if (loadedOnce && dirty()) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------- wiring ---------------- */

onChange((s) => {
  render(s);
  if (s.urls && !loadedOnce) { urls = [...s.urls]; savedKey = JSON.stringify(urls); loadedOnce = true; renderUrls(); }
  else $('#url-save').disabled = !s.connected;
});
renderUrls();
refreshAll().catch(() => { /* the connection banner explains why */ });
