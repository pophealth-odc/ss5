// Minimal ZIP writer ("store" method, no compression). PNG data is already compressed, so deflating it again
// would cost time for ~no size gain; a stored ZIP is a few dozen lines, needs no library, and opens in Windows Explorer.
//
//   const blob = makeZip([{ name: 'a.png', data: Uint8Array }, ...], new Date());
//
// Limits: classic ZIP (not ZIP64): each file < 4 GiB, total < 4 GiB, < 65,535 files. makeZip throws a clear
// error if exceeded - the gallery then offers to download the files individually instead.

const MAX_U32 = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

const enc = new TextEncoder();

export class ZipLimitError extends Error {}

/** Build a ZIP Blob from [{ name, data:Uint8Array }]. Names must be unique and already sanitised. */
export function makeZip(files, when = new Date()) {
  if (files.length > 0xfffe) throw new ZipLimitError('Too many files for one ZIP archive.');
  const { time, date } = dosDateTime(when);
  const parts = [];
  const central = [];
  let offset = 0;
  const seen = new Set();

  for (const f of files) {
    if (seen.has(f.name.toLowerCase())) throw new Error(`Duplicate file name in ZIP: ${f.name}`);
    seen.add(f.name.toLowerCase());
    if (f.data.length > MAX_U32) throw new ZipLimitError(`"${f.name}" is too large for a ZIP archive.`);
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);   // local file header signature
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(6, 0x0800, true);       // flags: bit 11 = UTF-8 names
    local.setUint16(8, 0, true);            // method 0 = stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);      // central directory signature
    cd.setUint16(4, 20, true);              // version made by
    cd.setUint16(6, 20, true);              // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true);              // extra length
    cd.setUint16(32, 0, true);              // comment length
    cd.setUint16(34, 0, true);              // disk number
    cd.setUint16(36, 0, true);              // internal attrs
    cd.setUint32(38, 0, true);              // external attrs
    cd.setUint32(42, offset, true);         // local header offset
    central.push(cd.buffer, name);

    offset += 30 + name.length + size;
    if (offset > MAX_U32) throw new ZipLimitError('The archive would be larger than 4 GB.');
  }

  const cdSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);       // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
