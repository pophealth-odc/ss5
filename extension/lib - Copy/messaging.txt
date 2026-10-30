// Security boundary for messages from the dashboard (chrome.runtime.onMessageExternal / onConnectExternal).
//   1. The manifest's externally_connectable restricts which pages can reach us at all.
//   2. This module re-checks the sender (defence in depth) against that SAME manifest pattern - the single place
//      the user configures the dashboard address - then validates the command name and the payload shape
//      before any privileged code runs.
// Pure functions only (no chrome.* calls) so they are unit-testable in plain Node.

import { COMMANDS, PROTOCOL_VERSION, PLACEHOLDER_MARKER } from './constants.js';
import { normalizeSettings, validateUrlList } from './validate.js';

const MAX_MESSAGE_BYTES = 256 * 1024;

const fail = (code, message) => ({ ok: false, code, error: message });

/**
 * Derive the trusted dashboard from the manifest's externally_connectable match pattern, so there is ONE place
 * to configure it. e.g. "https://octocat.github.io/edge-screenshot-automation/*" -> origin + path prefix.
 * A port IS honoured by Edge (measured: with "http://localhost:5287/app/*" a page on another localhost port gets no
 * chrome.runtime at all), so a localhost pattern should name its port; this check then enforces the same port.
 * A localhost pattern WITHOUT a port means "any local port", which lets every program on this PC that serves a
 * web page control the extension - tolerated only so the test-suite can use ephemeral ports.
 */
export function trustedFromMatchPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return fail('not_configured', 'No dashboard address is configured in manifest.json (externally_connectable.matches).');
  if (pattern.toLowerCase().includes(PLACEHOLDER_MARKER.toLowerCase())) {
    return fail('placeholder', 'manifest.json still contains the placeholder YOUR-GITHUB-USERNAME. Replace it with your GitHub user name (and the repository name if different), then reload the extension.');
  }
  const m = /^(https?):\/\/([^/*:]+)(?::(\d{1,5}))?(\/[^*]*)\*$/.exec(pattern.trim());
  if (!m) return fail('invalid', 'The dashboard pattern in manifest.json must look like https://USER.github.io/REPO/* (no wildcards in the host name).');
  const [, scheme, host, port, path] = m;
  const local = host === 'localhost' || host === '127.0.0.1';
  if (scheme === 'http' && !local) return fail('invalid', 'Only https:// dashboards are accepted (http:// is allowed for localhost testing only).');
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return fail('invalid', 'The port in the dashboard pattern must be between 1 and 65535.');
  const defaultPort = scheme === 'https' ? '443' : '80';
  // An explicit port that is just the scheme's default (e.g. :443) is the same origin as no port.
  const pinned = port !== undefined && port !== defaultPort ? port : undefined;
  return {
    ok: true,
    origin: pinned ? `${scheme}://${host}:${pinned}` : `${scheme}://${host}`,
    pathPrefix: path,
    anyPort: scheme === 'http' && port === undefined,   // only a portless LOCAL http pattern means "any port"
  };
}

/**
 * Is `sender` the dashboard the user configured? (External messages only. The popup and options page use the
 * separate internal channel, which background.js authenticates by extension id.)
 */
export function checkSender(sender, trusted) {
  if (!trusted || !trusted.ok) return fail('not_configured', trusted?.error || 'Dashboard address is not configured.');
  if (!sender || typeof sender !== 'object') return fail('bad_sender', 'Missing sender.');

  if (sender.frameId !== undefined && sender.frameId !== 0) return fail('bad_sender', 'Messages from embedded frames are not accepted.');
  let u;
  try { u = new URL(sender.url); } catch { return fail('bad_sender', 'Sender has no valid URL.'); }
  const sameOrigin = trusted.anyPort ? `${u.protocol}//${u.hostname}` === trusted.origin : u.origin === trusted.origin;
  if (!sameOrigin) return fail('bad_origin', 'This page is not the configured dashboard.');
  if (!u.pathname.startsWith(trusted.pathPrefix)) return fail('bad_origin', 'This page is outside the configured dashboard path.');
  return { ok: true };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

const payloadRules = {
  'ping': () => ({}),
  'state.get': () => ({}),
  'settings.save': (p, ctx) => {
    if (!isPlainObject(p?.settings)) return { error: 'settings must be an object.' };
    const r = normalizeSettings(p.settings, { strict: true });
    if (!r.ok) return { error: 'Invalid settings.', details: r.errors };
    // Return ONLY the keys the caller sent (normalised). normalizeSettings fills every missing field with a
    // default; passing those on would overwrite the user's stored values whenever one option is saved.
    const sent = {};
    for (const k of Object.keys(p.settings)) sent[k] = r.settings[k];
    return { settings: sent };
  },
  'urls.save': (p, ctx) => {
    if (!Array.isArray(p?.urls)) return { error: 'urls must be an array.' };
    const r = validateUrlList(p.urls, { allowHttp: !!ctx.allowHttp });
    return r.errors.length ? { error: 'Some URLs are invalid.', details: r.errors } : { urls: r.urls };
  },
  'run.openLogin': () => ({}),
  'run.cancelLogin': () => ({}),
  'run.confirmLogin': () => ({}),
  'run.start': () => ({}),
  'run.pause': () => ({}),
  'run.resume': () => ({}),
  'run.stop': () => ({}),
  'gallery.list': () => ({}),
  'gallery.get': (p) => (isId(p?.id) ? { id: p.id } : { error: 'id is invalid.' }),
  'gallery.delete': (p) => {
    if (!Array.isArray(p?.ids) || p.ids.length === 0 || p.ids.length > 1000 || !p.ids.every(isId)) return { error: 'ids must be a non-empty array of valid ids.' };
    return { ids: [...new Set(p.ids)] };
  },
  'gallery.clear': (p) => (p?.confirm === true ? {} : { error: 'Clearing requires confirm: true.' }),
  'data.clearAll': (p) => (p?.confirm === true ? {} : { error: 'Clearing requires confirm: true.' }),
};

/**
 * Validate a full request envelope: { v, cmd, requestId?, payload? }.
 * ctx: { allowHttp } (current settings, needed to validate URLs).
 */
export function validateRequest(msg, ctx = {}) {
  if (!isPlainObject(msg)) return fail('bad_request', 'Message must be an object.');
  let size = 0;
  try { size = JSON.stringify(msg).length; } catch { return fail('bad_request', 'Message is not serialisable.'); }
  if (size > MAX_MESSAGE_BYTES) return fail('too_large', 'Message is too large.');

  for (const k of Object.keys(msg)) {
    if (!['v', 'cmd', 'requestId', 'payload'].includes(k)) return fail('bad_request', `Unexpected field "${k}".`);
  }
  if (msg.v !== PROTOCOL_VERSION) return fail('bad_version', `Unsupported protocol version. Expected ${PROTOCOL_VERSION}. Update the dashboard or the extension so they match.`);
  if (typeof msg.cmd !== 'string' || !COMMANDS.includes(msg.cmd)) return fail('unknown_command', 'Unknown command.');
  if (msg.requestId !== undefined && !(typeof msg.requestId === 'string' && msg.requestId.length <= 64)) return fail('bad_request', 'requestId is invalid.');
  if (msg.payload !== undefined && !isPlainObject(msg.payload)) return fail('bad_request', 'payload must be an object.');

  const rule = payloadRules[msg.cmd];
  const checked = rule(msg.payload, ctx);
  if (checked.error) return { ok: false, code: 'bad_payload', error: checked.error, details: checked.details };
  return { ok: true, cmd: msg.cmd, requestId: msg.requestId, payload: checked };
}

export const MESSAGE_LIMIT_BYTES = MAX_MESSAGE_BYTES;
