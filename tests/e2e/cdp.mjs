// Test-only helper (NOT part of the deliverable): launch an isolated Edge + tiny CDP client.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Microsoft Edge: set EDGE_PATH to override, otherwise use the standard Windows install locations.
export const EDGE = process.env.EDGE_PATH || [
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].find((p) => fs.existsSync(p)) || 'msedge.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchEdge({ extDir, port, headless = true, extra = [] }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'essa-prof-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    ...(extDir ? [`--load-extension=${extDir}`] : []),
    ...(headless ? ['--headless=new'] : []),
    ...extra,
    'about:blank',
  ];
  const proc = spawn(EDGE, args, { stdio: 'ignore' });
  let exited = false;
  proc.once('exit', () => { exited = true; });
  for (let i = 0; i < 100; i++) {
    if (exited) break;      // Edge quit straight away (e.g. the port or profile was already in use): do NOT adopt whatever answers there
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      // Only trust the answer if OUR process is still alive and has started writing to OUR throw-away profile.
      if (r.ok && !exited && fs.existsSync(path.join(profile, 'Default'))) return { proc, profile, extDir, port };
    } catch {}
    await sleep(200);
  }
  killEdge({ proc, profile, extDir });
  throw new Error('Edge did not start (or the debug port was already taken by another process)');
}

export function killEdge({ proc, profile, extDir }) {
  // Only the process tree WE spawned (unique --user-data-dir), never the user's own Edge.
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  // Remove the throw-away profile and the staged extension copy (best effort: Edge may need a moment to release its
  // files). Only folders carrying the harness's own prefix are ever deleted.
  for (const [dir, prefix] of [[profile, 'essa-prof-'], [extDir, 'essa-ext-']]) {
    if (!dir || !path.basename(dir).startsWith(prefix)) continue;
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { spawnSync('ping', ['-n', '2', '127.0.0.1'], { stdio: 'ignore' }); }
    }
  }
}

export const targets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

export async function waitTarget(port, pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await targets(port)).find(pred);
    if (t) return t;
    await sleep(250);
  }
  return null;
}

export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const c = new Cdp(ws);
      ws.addEventListener('open', () => resolve(c));
      ws.addEventListener('error', () => reject(new Error('ws error')));
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && c.pending.has(m.id)) {
          const { res, rej } = c.pending.get(m.id);
          c.pending.delete(m.id);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...opts });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}
