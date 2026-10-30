// Toolbar popup: read-only status. Talks to the background over the internal channel (own pages only).
import { STATE_LABELS, PROTOCOL_VERSION } from './lib/constants.js';
import { trustedFromMatchPattern } from './lib/messaging.js';

const $ = (id) => document.getElementById(id);

function note(kind, text) {
  const n = $('note');
  n.hidden = !text;
  n.className = `msg ${kind}`;
  n.textContent = text || '';
}

async function main() {
  const pattern = chrome.runtime.getManifest().externally_connectable?.matches?.[0] || '';
  const trusted = trustedFromMatchPattern(pattern);
  $('dash').textContent = trusted.ok ? trusted.origin.replace(/^https?:\/\//, '') : 'not set up';
  if (trusted.ok) {
    const a = $('open');
    a.href = `${trusted.origin}${trusted.pathPrefix}`;
    a.hidden = false;
  } else {
    note('warn', trusted.error);
  }

  try {
    const res = await chrome.runtime.sendMessage({ v: PROTOCOL_VERSION, cmd: 'state.get' });
    if (!res?.ok) throw new Error(res?.error || 'No answer from the extension.');
    const { run, galleryCount } = res;
    $('state').textContent = STATE_LABELS[run.state] || run.state;
    const p = run.progress;
    $('progress').textContent = p.total ? `${p.done} of ${p.total} (${p.percent}%)` : '–';
    $('count').textContent = String(galleryCount);
    if (run.lastError) note('bad', run.lastError);
    else if (run.state === 'waiting_login' || run.state === 'waiting_confirmation') note('warn', 'Sign in (including MFA) in Edge, then confirm in the dashboard.');
    else if (run.warnings?.length) note('warn', run.warnings[run.warnings.length - 1]);
  } catch (e) {
    $('state').textContent = 'Unavailable';
    note('bad', e.message);
  }
}

main();
