// Runs every test suite and prints a summary.
//
//   node tests/run-all.mjs            unit tests + end-to-end tests (needs Microsoft Edge)
//   node tests/run-all.mjs --unit     unit tests only (fast, no browser)
//
// Emulate a scaled Windows display (e.g. 125% / 150%) for the browser tests:
//   PowerShell:  $env:EDGE_SCALE = '1.25'; node tests/run-all.mjs
//
// Node is only a development-time convenience for TESTING. The shipped dashboard and extension need no Node.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const here = import.meta.dirname;
const unitOnly = process.argv.includes('--unit');

const unit = ['validate', 'messaging', 'runstate', 'zip'].map((n) => ({ name: `unit: ${n}`, file: path.join(here, `${n}.test.mjs`) }));
const e2e = [
  ['e2e1-load', 'extension loads, trust boundary'],
  ['e2e2-run', 'login gate, run, gallery'],
  ['e2e3-control', 'zoom restore, session expiry, pause/stop, hang, closed window'],
  ['e2e4-fullpage', 'full-page stitching'],
  ['e2e5-swkill', 'service worker killed mid-run'],
  ['e2e6-zoomcapture', 'full-page accuracy across 50-200% zoom'],
  ['ui1-load', 'dashboard pages load from a sub-path'],
  ['ui2-flow', 'real dashboard UI, downloads'],
  ['ui3-a11y', 'accessibility, keyboard, contrast, responsive'],
  ['ui4-states-contrast', 'contrast of transient UI states'],
  ['ui5-injection', 'hostile page content cannot execute in the dashboard'],
  ['ui6-extension-pages', 'popup and options pages report the truth'],
  ['e2e7-localhost', 'localhost launcher + pinned-port trust boundary'],
].map(([n, d]) => ({ name: `e2e : ${n} (${d})`, file: path.join(here, 'e2e', `${n}.mjs`) }));

const scans = [{ name: 'scan: HTML-injection (xss-scan)', file: path.join(here, 'xss-scan.mjs') }];
const suites = unitOnly ? [...unit, ...scans] : [...unit, ...scans, ...e2e];
let failed = 0;
const rows = [];
for (const s of suites) {
  const t0 = Date.now();
  process.stdout.write(`\n=== ${s.name}\n`);
  const r = spawnSync(process.execPath, [s.file], { stdio: 'inherit', cwd: path.resolve(here, '..') });
  const ok = r.status === 0;
  if (!ok) failed++;
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${s.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log('\n================ summary ================');
for (const r of rows) console.log(r);
console.log(failed ? `\n${failed} suite(s) FAILED` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
