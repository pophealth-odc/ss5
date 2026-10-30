// Static check: every ${...} interpolated into an HTML template must be escaped with esc() or be provably numeric/static.
// Anything else is listed so a human can confirm it is safe. This guards against HTML injection from page titles,
// URLs and error text, which come from arbitrary websites.
//
//   node tests/xss-scan.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// Expressions that cannot carry attacker-controlled text.
const SAFE_EXPR = [
  /^esc\(/,                                  // explicitly escaped
  /^\d+$/,                                   // literal number
  /^i \+ 1$/,                                // loop index
  /^(failed|list|items|ws)\.length$/,        // counts
  /^!?v\.ok$/, /^!v\.ok$/,                   // booleans rendered into attributes
  /^[a-zA-Z]+ \? ['"][^'"]*['"] : ['"][^'"]*['"]$/,   // cond ? 'literal' : 'literal'
];

/** Find ${...} (with balanced braces) inside template literals; returns [{line, expr}]. */
export function interpolations(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      const expr = src.slice(i + 2, j - 1).trim();
      out.push({ line: src.slice(0, i).split('\n').length, expr });
      i = i + 2;                              // continue inside, so nested templates are inspected too
    } else i++;
  }
  return out;
}

/** An interpolation is "in HTML" when its line (or the template it belongs to) contains a tag or innerHTML. */
export function isHtmlContext(lines, line) {
  for (let k = line - 1; k >= Math.max(0, line - 12); k--) {
    if (/innerHTML\s*=|insertAdjacentHTML|outerHTML/.test(lines[k])) return true;
  }
  return /<[a-zA-Z][^>]*\$\{/.test(lines[line - 1]) || /\$\{[^}]*\}[^`]*<\/?[a-zA-Z]/.test(lines[line - 1]);
}

// Interpolations a human reviewed and confirmed safe. Each entry is "file: expression" and says WHY. A NEW unescaped
// interpolation will not match and will fail the scan, so it must be reviewed (and either escaped or added here).
const REVIEWED = {
  // app.js shell: constants from the NAV table and the page's own static markup
  'js/app.js: n.href': 'constant from the NAV table',
  "js/app.js: n.href === page ? 'aria-current=\"page\"' : ''": 'static literal chosen by a comparison',
  'js/app.js: n.icon': 'constant SVG path from the NAV table',
  "js/app.js: n.badge ? '<span class=\"badge\" id=\"nav-count\" aria-label=\"screenshots\">0</span>' : ''": 'static literal',
  'js/app.js: nav': 'built from the NAV table above (labels pass through esc())',
  'js/app.js: lead ? `<p class="lead">${esc(lead)}</p>` : \'\'': 'inner value is esc()-wrapped',
  'js/app.js: actionsHtml': 'developer-supplied markup argument; callers pass literals only',
  'js/app.js: content': "the page's own original markup (moved, not built from data)",
  // gallery.js
  "js/gallery.js: it.thumb ? `<img src=\"${esc(it.thumb)}\" alt=\"Thumbnail of ${esc(it.filename)}\" loading=\"lazy\">` : '<span class=\"sr-only\">No thumbnail</span>'": 'inner values are esc()-wrapped',
  "js/gallery.js: selected.has(it.id) ? 'checked' : ''": 'static literal',
  "js/gallery.js: it.status === 'ok' ? 'ok' : 'bad'": 'static literal',
  "js/gallery.js: it.status === 'ok' ? 'Captured' : esc(it.status)": 'esc() on the only data branch',
  "js/gallery.js: it.mode === 'full' || it.mode === 'element' ? ' <span class=\"pill\">Full page</span>' : ''": 'static literal',
  'js/gallery.js: it.note ? ` <span class="hint">${esc(it.note)}</span>` : \'\'': 'inner value is esc()-wrapped',
  'js/gallery.js: it.filename': 'goes to setProgress(), which writes textContent, not HTML',
  "js/gallery.js: failed.map((f) => `<li>${esc(f.it.filename)} - ${esc(f.why)}</li>`).join('')": 'inner values are esc()-wrapped',
  'js/gallery.js: okCount': 'a number',
  // index.js
  'js/index.js: status': "one of two static string literals",
  'js/index.js: detail': 'built from esc(run.lastError) plus static text',
  "js/index.js: ws.map((x) => `<li>${esc(x)}</li>`).join('')": 'inner value is esc()-wrapped',
  "js/index.js: v.ok ? '' : `<div class=\"error-text\">${esc(v.error)}</div>`": 'inner value is esc()-wrapped',
  "js/index.js: i === 0 ? 'disabled' : ''": 'static literal',
  "js/index.js: i === urls.length - 1 ? 'disabled' : ''": 'static literal',
};

const isSafe = (expr, where = '') => SAFE_EXPR.some((r) => r.test(expr)) || Object.hasOwn(REVIEWED, `${where}: ${expr}`);

export function scan(src, where = '') {
  const lines = src.split('\n');
  return interpolations(src).filter((x) => isHtmlContext(lines, x.line) && !isSafe(x.expr, where));
}

/* ---- self-test: the scanner must catch known-bad code, or a clean result means nothing ---- */
const bad = scan('el.innerHTML = `<b>${page.title}</b>`;');
const good = scan('el.innerHTML = `<b>${esc(page.title)}</b>`;');
if (bad.length !== 1 || good.length !== 0) {
  console.error('xss-scan self-test FAILED (the scanner cannot be trusted)', { bad, good });
  process.exit(2);
}

let findings = 0;
let scanned = 0;
for (const dir of ['js']) {
  for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
    const html = interpolations(src).filter((x) => isHtmlContext(src.split('\n'), x.line));
    scanned += html.length;
    for (const x of scan(src, `${dir}/${f}`)) { findings++; console.log(`${dir}/${f}:${x.line}  \${${x.expr}}`); }
  }
}
for (const f of ['popup.js', 'options.js']) {
  const src = fs.readFileSync(path.join(root, 'extension', f), 'utf8');
  scanned += interpolations(src).filter((x) => isHtmlContext(src.split('\n'), x.line)).length;
  for (const x of scan(src, `extension/${f}`)) { findings++; console.log(`extension/${f}:${x.line}  \${${x.expr}}`); }
}
// A reviewed entry that no longer matches any code is stale and would hide a future change: report it.
const used = new Set();
for (const dir of ['js']) for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
  for (const x of interpolations(src)) used.add(`${dir}/${f}: ${x.expr}`);
}
const stale = Object.keys(REVIEWED).filter((k) => !used.has(k));
for (const k of stale) { findings++; console.log(`stale reviewed entry (code changed, re-review): ${k}`); }
console.log(`xss-scan: ${scanned} HTML interpolations inspected, ${findings} not escaped/provably-safe or stale`);
process.exit(findings ? 1 : 0);
