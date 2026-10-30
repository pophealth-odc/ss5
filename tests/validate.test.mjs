// Plain-Node unit tests for extension/lib/validate.js.  Run:  node tests/validate.test.mjs
// (Node is only a dev-time convenience for testing; nothing in the shipped app needs it.)
import assert from 'node:assert/strict';
import {
  validateUrl, validateUrlList, parseUrlText, normalizeSettings,
  sanitizeFilename, pageNameFromUrl, buildFilename, uniqueFilename, isPlaceholderOrigin,
} from '../extension/lib/validate.js';
import { DEFAULT_SETTINGS } from '../extension/lib/constants.js';

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL:', name, '\n  ', e.message); process.exitCode = 1; } };

// ---- validateUrl
t('https accepted + normalised', () => assert.deepEqual(validateUrl(' https://Example.com '), { ok: true, url: 'https://example.com/' }));
t('default login url is valid', () => assert.equal(validateUrl(DEFAULT_SETTINGS.loginUrl).ok, true));
t('http blocked by default', () => assert.equal(validateUrl('http://example.com').ok, false));
t('http allowed when enabled', () => assert.equal(validateUrl('http://example.com', { allowHttp: true }).ok, true));
for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/x', 'edge://settings', 'chrome://version', 'about:blank', 'ftp://x.com', 'blob:https://x.com/1', 'view-source:https://x.com']) {
  t(`rejects ${bad}`, () => assert.equal(validateUrl(bad, { allowHttp: true }).ok, false));
}
for (const bad of ['', '   ', 'example.com', 'https://', 'https:///x', 'https://u:p@example.com/', 42, null, undefined, {}]) {
  t(`rejects ${JSON.stringify(bad)}`, () => assert.equal(validateUrl(bad).ok, false));
}
t('rejects control chars', () => assert.equal(validateUrl('https://example.com/\u0000x').ok, false));
t('rejects overlong url', () => assert.equal(validateUrl('https://example.com/' + 'a'.repeat(3000)).ok, false));
t('rejects edge add-ons store', () => assert.equal(validateUrl('https://microsoftedge.microsoft.com/addons/x').ok, false));

// ---- lists / import
t('validateUrlList splits valid/invalid', () => {
  const r = validateUrlList(['https://a.com', 'nope', 'https://b.com']);
  assert.deepEqual(r.urls, ['https://a.com/', 'https://b.com/']);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].index, 1);
});
t('validateUrlList rejects non-array', () => assert.equal(validateUrlList('x').errors.length, 1));
t('validateUrlList enforces max', () => assert.equal(validateUrlList(new Array(501).fill('https://a.com')).urls.length, 0));
t('parseUrlText handles BOM, CRLF, comments, blanks', () =>
  assert.deepEqual(parseUrlText('\uFEFF# my pages\r\nhttps://a.com\r\n\r\n  https://b.com  \n#skip\nhttps://c.com'), ['https://a.com', 'https://b.com', 'https://c.com']));

// ---- settings
t('defaults round-trip valid in strict mode', () => {
  const r = normalizeSettings({ ...DEFAULT_SETTINGS }, { strict: true });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.settings, { ...DEFAULT_SETTINGS });
});
t('default zoom 100, delay 5', () => { assert.equal(DEFAULT_SETTINGS.zoomPercent, 100); assert.equal(DEFAULT_SETTINGS.pageDelaySeconds, 5); });
t('zoom bounds strict', () => {
  assert.equal(normalizeSettings({ zoomPercent: 45 }, { strict: true }).ok, false);
  assert.equal(normalizeSettings({ zoomPercent: 205 }, { strict: true }).ok, false);
  assert.equal(normalizeSettings({ zoomPercent: 50 }, { strict: true }).ok, true);
  assert.equal(normalizeSettings({ zoomPercent: 200 }, { strict: true }).ok, true);
});
t('zoom must be a multiple of 5 (strict)', () => assert.equal(normalizeSettings({ zoomPercent: 102 }, { strict: true }).ok, false));
t('zoom snaps + clamps (lenient)', () => {
  assert.equal(normalizeSettings({ zoomPercent: 102 }).settings.zoomPercent, 100);
  assert.equal(normalizeSettings({ zoomPercent: 9999 }).settings.zoomPercent, 200);
  assert.equal(normalizeSettings({ zoomPercent: 'abc' }).settings.zoomPercent, 100);
});
t('delay presets accepted', () => { for (const n of [3, 5, 10, 15]) assert.equal(normalizeSettings({ pageDelaySeconds: n }, { strict: true }).settings.pageDelaySeconds, n); });
t('delay out of range', () => assert.equal(normalizeSettings({ pageDelaySeconds: 500 }, { strict: true }).ok, false));
t('unknown keys rejected in strict mode', () => assert.equal(normalizeSettings({ evil: 1 }, { strict: true }).ok, false));
t('prototype-pollution style input is inert', () => {
  const r = normalizeSettings(JSON.parse('{"__proto__":{"x":1},"zoomPercent":100}'), { strict: true });
  assert.equal(({}).x, undefined);
  assert.equal(r.settings.x, undefined);
});
t('non-object input -> defaults', () => assert.deepEqual(normalizeSettings(null).settings, { ...DEFAULT_SETTINGS }));
t('login url honours allowHttp in same payload', () => {
  assert.equal(normalizeSettings({ loginUrl: 'http://intranet/', allowHttp: true }, { strict: true }).ok, true);
  assert.equal(normalizeSettings({ loginUrl: 'http://intranet/', allowHttp: false }, { strict: true }).ok, false);
});
t('captureMode enum', () => {
  assert.equal(normalizeSettings({ captureMode: 'full' }, { strict: true }).ok, true);
  assert.equal(normalizeSettings({ captureMode: 'weird' }, { strict: true }).ok, false);
});
t('filename format placeholders checked', () => {
  assert.equal(normalizeSettings({ filenameFormat: '{page}_{timestamp}' }, { strict: true }).ok, true);
  assert.equal(normalizeSettings({ filenameFormat: '{nope}' }, { strict: true }).ok, false);
  assert.equal(normalizeSettings({ filenameFormat: '   ' }, { strict: true }).ok, false);
});
t('booleans must be booleans (strict)', () => assert.equal(normalizeSettings({ autoCapture: 'yes' }, { strict: true }).ok, false));

// ---- filenames
t('sanitize strips illegal chars', () => assert.equal(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j'));
t('sanitize windows reserved names', () => { assert.equal(sanitizeFilename('CON'), '_CON'); assert.equal(sanitizeFilename('nul'), '_nul'); });
t('sanitize empty -> screenshot', () => { assert.equal(sanitizeFilename(''), 'screenshot'); assert.equal(sanitizeFilename('...'), 'screenshot'); assert.equal(sanitizeFilename(null), 'screenshot'); });
t('sanitize trims length', () => assert.ok(sanitizeFilename('x'.repeat(500)).length <= 120));
t('sanitize no path traversal', () => assert.ok(!/[\\/]|\.\./.test(sanitizeFilename('../../etc/passwd'))));
t('pageNameFromUrl', () => assert.equal(pageNameFromUrl('https://x.apps.dynatrace.com/ui/dashboards/main/'), 'x.apps.dynatrace.com_ui_dashboards_main'));
t('buildFilename', () => {
  const n = buildFilename('{index}_{page}_{timestamp}', { index: 7, url: 'https://example.com/a/b', capturedAt: new Date(2026, 9, 29, 8, 5, 3) });
  assert.equal(n, '007_example.com_a_b_20261029-080503.png');
});
t('buildFilename with other tokens', () => {
  const n = buildFilename('{host}__{date}__{time}', { index: 1, url: 'https://example.com/', capturedAt: new Date(2026, 0, 2, 3, 4, 5) });
  assert.equal(n, 'example.com__2026-01-02__03-04-05.png');
});
t('buildFilename falls back on bad format/url', () => assert.ok(buildFilename('', { url: 'not a url' }).endsWith('.png')));
t('uniqueFilename', () => {
  const taken = new Set(['a.png', 'a-2.png']);
  assert.equal(uniqueFilename('b.png', taken), 'b.png');
  assert.equal(uniqueFilename('A.png', taken), 'A-3.png');
});
t('isPlaceholderOrigin', () => {
  assert.equal(isPlaceholderOrigin('https://YOUR-GITHUB-USERNAME.github.io/x/', 'YOUR-GITHUB-USERNAME'), true);
  assert.equal(isPlaceholderOrigin('https://octocat.github.io/x/', 'YOUR-GITHUB-USERNAME'), false);
});

console.log(`validate.js: ${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
