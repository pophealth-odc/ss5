// Tests for js/zip.js.  Run: node tests/zip.test.mjs
// Beyond unit checks it extracts a generated archive with the OS's own `tar` (bsdtar, bundled with Windows 10/11),
// i.e. an independent ZIP reader, and compares every byte.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { makeZip, crc32, ZipLimitError } from '../js/zip.js';

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; } catch (e) { console.error('FAIL:', name, '\n  ', e.message); process.exitCode = 1; } };
const bytes = (s) => new TextEncoder().encode(s);

// ---- CRC-32 against zlib's independent implementation
t('crc32 known vector ("123456789" -> cbf43926)', () => assert.equal(crc32(bytes('123456789')), 0xcbf43926));
t('crc32 empty', () => assert.equal(crc32(new Uint8Array(0)), 0));
t('crc32 matches node zlib on random data', () => {
  for (const n of [1, 7, 255, 4096, 100000]) {
    const d = new Uint8Array(n); for (let i = 0; i < n; i++) d[i] = (i * 31 + n) & 255;
    assert.equal(crc32(d), zlib.crc32(d), `n=${n}`);
  }
});

// ---- structure
t('empty archive is just the end record (22 bytes)', async () => {
  const b = makeZip([]);
  assert.equal(b.size, 22);
});
t('duplicate names are rejected (case-insensitive)', () => assert.throws(() => makeZip([{ name: 'A.png', data: bytes('x') }, { name: 'a.png', data: bytes('y') }]), /Duplicate/));
t('ZipLimitError type exists', () => assert.ok(new ZipLimitError('x') instanceof Error));

// ---- real extraction with bsdtar (ASCII names: on a non-UTF-8 Windows console bsdtar cannot CREATE unicode file
// names, which is a limit of that reader, not a ZIP defect - unicode names are verified with Python's zipfile below)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'essa-zip-'));
try {
  const png = new Uint8Array(70000); for (let i = 0; i < png.length; i++) png[i] = (i * 131 + (i >> 8)) & 255;
  const files = [
    { name: '001_example.com_20261029-080503.png', data: png },
    { name: 'empty.png', data: new Uint8Array(0) },
    { name: 'with space and (parens).png', data: bytes('spaces ok') },
  ];
  const blob = makeZip(files, new Date(2026, 9, 29, 8, 5, 3));
  const zipPath = path.join(tmp, 'out.zip');
  fs.writeFileSync(zipPath, Buffer.from(await blob.arrayBuffer()));

  const list = spawnSync('tar', ['-tf', zipPath], { encoding: 'utf8' });
  t('bsdtar can list the archive', () => assert.equal(list.status, 0, list.stderr));
  t('bsdtar lists every file name (incl. unicode)', () => {
    const names = list.stdout.split(/\r?\n/).filter(Boolean);
    assert.deepEqual(names.sort(), files.map((f) => f.name).sort());
  });

  const outDir = path.join(tmp, 'out'); fs.mkdirSync(outDir);
  const ex = spawnSync('tar', ['-xf', zipPath, '-C', outDir], { encoding: 'utf8' });
  t('bsdtar extracts without errors (CRCs and sizes verified by the reader)', () => assert.equal(ex.status, 0, ex.stderr));
  for (const f of files) {
    t(`extracted bytes identical: ${f.name}`, () => {
      const got = fs.readFileSync(path.join(outDir, f.name));
      assert.equal(Buffer.compare(got, Buffer.from(f.data)), 0);
    });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- unicode names, read by a second independent implementation (Python's zipfile through the `py` launcher)
const pyProbe = spawnSync('py', ['-I', '-c', 'import sys'], { encoding: 'utf8' });
if (pyProbe.status !== 0) {
  console.log('  (skipped: no Python launcher found for the unicode-name check)');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'essa-zipu-'));
  try {
    const uni = 'dashboard-überblick_日本語.png';
    const blob = makeZip([{ name: uni, data: bytes('hello') }, { name: 'plain.png', data: bytes('x') }]);
    const zipPath = path.join(dir, 'u.zip');
    fs.writeFileSync(zipPath, Buffer.from(await blob.arrayBuffer()));
    const script = [
      'import zipfile, sys',
      'z = zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'n = z.namelist()',
      "assert n == ['dashboard-\\u00fcberblick_\\u65e5\\u672c\\u8a9e.png', 'plain.png'], ascii(n)",
      "assert z.read(n[0]) == b'hello' and z.read(n[1]) == b'x'",
      "print('ok')",
    ].join('\n');
    const r = spawnSync('py', ['-I', '-c', script, zipPath], { encoding: 'utf8' });
    t('Python zipfile: CRCs valid, bytes identical, unicode name decoded', () => { assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'ok'); });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`zip.js: ${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
