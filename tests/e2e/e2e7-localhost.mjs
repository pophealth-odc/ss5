// E2E 7: the "run on localhost" setup, exactly as tools/serve-local.mjs produces it: the dashboard served at a
// pinned port, and the staged extension copy trusting ONLY that address. Uses the launcher's own server and staging
// code path (it starts tools/serve-local.mjs as a child process), then proves the trust boundary in a real browser.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { startServer, startEdge, openPage, killEdge, EXT_ID, sleep, SRC } from './harness.mjs';
import { freePort } from './harness.mjs';

const results = [];
const check = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? '  -> ' + String(detail).slice(0, 500) : '')); };
const watchdog = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 200000);

// Use a free port (not the default 5287) so the test never collides with a server you are running yourself.
const PORT = await freePort();
const PREFIX = '/edge-screenshot-automation/';
const BASE = `http://localhost:${PORT}${PREFIX}`;
const staged = path.join(SRC, '.local', 'extension');

let launcher, ctx, other;
const launcherOut = [];
try {
  // The launcher writes .local/extension; if you have one staged for port 5287 right now, keep a copy and restore it.
  const hadStaged = fs.existsSync(staged);
  const backup = hadStaged ? path.join(SRC, '.local', `extension.bak-${process.pid}`) : null;
  if (hadStaged) fs.cpSync(staged, backup, { recursive: true });

  launcher = spawn(process.execPath, [path.join(SRC, 'tools', 'serve-local.mjs'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  launcher.stdout.on('data', (d) => launcherOut.push(String(d)));
  launcher.stderr.on('data', (d) => launcherOut.push(String(d)));
  for (let i = 0; i < 50 && !launcherOut.join('').includes('is running locally'); i++) await sleep(100);
  check('L1 launcher starts and reports the dashboard address', launcherOut.join('').includes(BASE), launcherOut.join('').slice(0, 300));

  const manifest = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8'));
  check('L2 staged manifest trusts exactly this address and nothing else', JSON.stringify(manifest.externally_connectable.matches) === JSON.stringify([`${BASE}*`]), JSON.stringify(manifest.externally_connectable.matches));
  check('L3 staged extension keeps the same key, so the same extension ID', manifest.key && manifest.key.startsWith('MIIBIjANBgkqhkiG9w0BAQEF'));

  // Load the STAGED folder itself (not a copy made by the harness) so this tests what the user will actually load.
  ctx = await startEdge({ extDir: staged });
  const dash = await openPage(ctx.port, BASE + 'index.html');
  await sleep(1500);
  const conn = await dash.cdp.eval(`document.querySelector('#conn-text')?.textContent`);
  check('L4 dashboard served by the launcher connects to the staged extension', /Extension connected/.test(conn || ''), conn);

  // The point of pinning: another local web server (any other port) must NOT be able to reach the extension.
  other = await startServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>other</title>other'); });
  const rogue = await openPage(ctx.port, `http://localhost:${other.port}${PREFIX}index.html`);
  const rogueReach = await rogue.cdp.eval(`typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage)`);
  check('L5 a different local port with the SAME path cannot reach the extension', rogueReach === false);
  const rogue2 = await openPage(ctx.port, `http://127.0.0.1:${PORT}${PREFIX}index.html`);
  check('L6 the same port reached as 127.0.0.1 (a different origin) cannot reach the extension', (await rogue2.cdp.eval(`typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage)`)) === false);

  // Full flow through the real pages
  const target = await startServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<title>${req.url}</title><body style="font:40px sans-serif">${req.url}</body>`); });
  const T = `http://127.0.0.1:${target.port}`;
  const call = (msg) => dash.cdp.eval(`new Promise((res) => chrome.runtime.sendMessage('${EXT_ID}', ${JSON.stringify({ v: 1, ...msg })}, (r) => res(r)))`);
  const s1 = await call({ cmd: 'settings.save', payload: { settings: { loginUrl: `${T}/login`, allowHttp: true, pageDelaySeconds: 1 } } });
  const u1 = await call({ cmd: 'urls.save', payload: { urls: [`${T}/one`, `${T}/two`] } });
  check('L7 settings and URLs save through the localhost dashboard', s1.ok && u1.ok, JSON.stringify({ s1: s1.error, u1: u1.error }));
  const early = await call({ cmd: 'run.start' });
  check('L8 Start is refused before login, as on GitHub Pages', early.ok === false);
  await call({ cmd: 'run.openLogin' }); await sleep(800);
  const confirm = await call({ cmd: 'run.confirmLogin' });
  check('L9 explicit confirmation starts the run', confirm.ok, JSON.stringify(confirm).slice(0, 160));
  let st; for (let i = 0; i < 120; i++) { st = await call({ cmd: 'state.get' }); if (['completed', 'error', 'stopped'].includes(st.run.state)) break; await sleep(400); }
  check('L10 run completes and both pages are captured', st.run.state === 'completed' && st.run.captured === 2, JSON.stringify({ s: st.run.state, c: st.run.captured, e: st.run.lastError }));
  const gal = await openPage(ctx.port, BASE + 'gallery.html'); await sleep(2500);
  const shots = await gal.cdp.eval(`document.querySelectorAll('#grid .shot').length`);
  check('L11 the gallery page served by the launcher shows both screenshots', shots === 2, String(shots));
  target.server.close();

  if (hadStaged) { fs.rmSync(staged, { recursive: true, force: true }); fs.renameSync(backup, staged); }
} catch (e) {
  check('harness ran to completion', false, e.stack || e.message);
} finally {
  if (ctx) killEdge(ctx.edge);
  if (other) other.server.close();
  if (launcher) launcher.kill();
  clearTimeout(watchdog);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
