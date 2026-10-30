// Run the dashboard on localhost, exactly as GitHub Pages would serve it, and prepare a matching copy of the extension.
//
//   node tools/serve-local.mjs                 serve on http://localhost:5287/edge-screenshot-automation/
//   node tools/serve-local.mjs --port 8080     use another port
//   node tools/serve-local.mjs --no-stage      only serve; do not (re)write the local extension copy
//
// This is a DEVELOPMENT convenience only. The deployed app is static files on GitHub Pages and needs no Node.
//
// What it does
//   1. Serves this repo at /edge-screenshot-automation/ (the same project sub-path Pages uses), binding to 127.0.0.1
//      only, so nothing else on your network can reach it.
//   2. Writes a copy of the extension to  .local/extension  whose manifest trusts ONLY this exact address
//      (http://localhost:<port>/edge-screenshot-automation/*). Your real extension/manifest.json is left untouched.
//   3. Prints what to do in Edge.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const argVal = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const PORT = Number(argVal('--port', '5287'));
const PREFIX = '/edge-screenshot-automation/';
const STAGE = !args.includes('--no-stage');

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error(`Invalid --port "${argVal('--port', '')}". Use a number from 1024 to 65535.`);
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

// Not published by GitHub Pages either (and never needed by the pages): keep local behaviour identical.
const HIDDEN = /(^|[\\/])(\.git|\.local|tests|tools|node_modules)([\\/]|$)|(^|[\\/])\.[^\\/]+$/;

const server = http.createServer((req, res) => {
  const send = (code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(400, 'bad request'); }
  if (pathname === '/') { res.writeHead(302, { location: PREFIX }); return res.end(); }
  if (!pathname.startsWith(PREFIX)) return send(404, `Not found. The dashboard lives at ${PREFIX}`);
  let rel = pathname.slice(PREFIX.length) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  if (HIDDEN.test(rel)) return send(404, 'not published');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return send(403, 'forbidden');          // path traversal
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

/** Copy extension/ to .local/extension with the manifest pointed at this exact localhost address. */
function stageExtension() {
  const src = path.join(root, 'extension');
  const dest = path.join(root, '.local', 'extension');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  const mp = path.join(dest, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  manifest.externally_connectable.matches = [`http://localhost:${PORT}${PREFIX}*`];
  manifest.name = `${manifest.name} (localhost:${PORT})`;
  fs.writeFileSync(mp, JSON.stringify(manifest, null, 2) + '\n');
  return dest;
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use by another program. Nothing was started.\nPick another port:  node tools/serve-local.mjs --port 8080\n(The extension copy is written for the port you choose, so this is all you need to change.)`);
  } else console.error('\nServer error:', e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}${PREFIX}`;
  let staged = null;
  if (STAGE) staged = stageExtension();
  console.log(`
Edge Screenshot Automation is running locally.

  Dashboard :  ${url}
  Bound to  :  127.0.0.1 only (not reachable from other computers)
${staged ? `  Extension :  ${staged}\n` : ''}
In Microsoft Edge:
  1. Open  edge://extensions  and turn on Developer mode.
  2. If you already loaded the extension from the "extension" folder, REMOVE it first
     (two copies of the same extension cannot both be installed).
  3. Choose "Load unpacked" and select:
       ${staged || path.join(root, '.local', 'extension')}
  4. Open  ${url}
     The top-right indicator should say "Extension connected".

Press Ctrl+C to stop the server.
`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('\nStopping.'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); });
