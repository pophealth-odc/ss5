// Extension details page: shows trust status (read-only) and offers "delete all data".
import { PROTOCOL_VERSION } from './lib/constants.js';
import { trustedFromMatchPattern } from './lib/messaging.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage({ v: PROTOCOL_VERSION, ...msg });

function showTrust() {
  const pattern = chrome.runtime.getManifest().externally_connectable?.matches?.[0] || '';
  const t = trustedFromMatchPattern(pattern);
  const s = $('trust-status');
  if (t.ok) {
    s.textContent = 'Configured';
    s.className = 'status ok';
    $('trust-detail').textContent = `Only pages under ${t.origin}${t.pathPrefix} can control this extension.`;
  } else {
    s.textContent = t.code === 'placeholder' ? 'Not set up yet' : 'Problem';
    s.className = `status ${t.code === 'placeholder' ? 'warn' : 'bad'}`;
    $('trust-detail').textContent = t.error;
  }
}

async function refreshCount() {
  try {
    const res = await send({ cmd: 'state.get' });
    $('count').textContent = res?.ok ? String(res.galleryCount) : '–';
  } catch { $('count').textContent = '–'; }
}

$('clear').addEventListener('click', async () => {
  const msg = $('clear-msg');
  if (!confirm('Delete ALL data stored by this extension (settings, URL list and every screenshot)? This cannot be undone. It does not sign you out of any website.')) return;
  try {
    const res = await send({ cmd: 'data.clearAll', payload: { confirm: true } });
    msg.textContent = res?.ok ? 'All stored data was deleted.' : (res?.error || 'Could not delete the data.');
  } catch (e) {
    msg.textContent = e.message;
  }
  refreshCount();
});

showTrust();
refreshCount();
