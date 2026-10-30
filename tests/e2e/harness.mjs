// Shared e2e harness: stages a COPY of the real extension with the dashboard pattern pointed at a local test
// server, launches isolated Edge with it, and exposes CDP handles. The shipped manifest is never modified.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { launchEdge, killEdge, waitTarget, Cdp, targets, sleep } from './cdp.mjs';

export const EXT_ID = 'ihedfabnpfjninccblgdbojfilhbhlnj';
export const SRC = path.resolve(import.meta.dirname, '..', '..');   // the repo root, wherever it was cloned
export const DASH_PATH = '/edge-screenshot-automation/';

export function stageExtension({ pattern } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'essa-ext-'));
  fs.cpSync(path.join(SRC, 'extension'), dest, { recursive: true });
  const mp = path.join(dest, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (pattern) m.externally_connectable.matches = [pattern];
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return dest;
}

/** A tiny multi-purpose web server: serves the dashboard stand-in and a few target pages. */
export function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/** A TCP port that is free right now (bind to port 0, read what the OS chose, release it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export async function startEdge({ extDir, headless = true }) {
  const port = await freePort();   // ask the OS: a random guess could hit a still-running Edge from the previous suite
  // EDGE_SCALE=1.25 (or 1.5, 2) emulates a scaled Windows display, where devicePixelRatio != 1 at 100% browser zoom.
  const extra = process.env.EDGE_SCALE ? [`--force-device-scale-factor=${process.env.EDGE_SCALE}`] : [];
  const edge = await launchEdge({ extDir, port, headless, extra });
  const sw = await waitTarget(port, (t) => t.type === 'service_worker' && t.url.includes(EXT_ID), 20000);
  if (!sw) { killEdge(edge); throw new Error('Extension service worker never started (extension failed to load).'); }
  const swCdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  for (let i = 0; i < 60; i++) {
    if (await swCdp.eval(`typeof chrome!=='undefined'&&!!chrome.windows&&!!chrome.scripting&&!!chrome.storage`).catch(() => false)) break;
    await sleep(200);
  }
  return { edge, port, swCdp, sw };
}

export async function openPage(port, url) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  await sleep(800);
  return { cdp, target: t };
}

export { killEdge, Cdp, sleep, targets, waitTarget };
