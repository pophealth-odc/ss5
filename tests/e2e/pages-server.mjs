// Static server that mimics GitHub Pages for a PROJECT site: the repo is served under /edge-screenshot-automation/.
// Anything outside that prefix is a 404 (so a wrong absolute path in the app would be caught), MIME types are
// the ones Pages sends, and path traversal is refused.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

export function startPagesServer({ root = REPO_ROOT, prefix = '/edge-screenshot-automation/', log = [] } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push(u.pathname);
    if (!u.pathname.startsWith(prefix)) { res.statusCode = 404; return res.end('not found (outside project path)'); }
    let rel = decodeURIComponent(u.pathname.slice(prefix.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root) + path.sep)) { res.statusCode = 403; return res.end('forbidden'); }
    // GitHub Pages does not publish dot-folders or the tests; mirror that so a stray dependency is caught.
    if (/(^|[\\/])(\.git|tests|node_modules)([\\/]|$)/.test(rel)) { res.statusCode = 404; return res.end('not published'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, prefix, log })));
}
