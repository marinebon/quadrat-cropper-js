/**
 * unzip.js — minimal ZIP reader (STORE + DEFLATE), no dependencies.
 * Uses the built-in DecompressionStream('deflate-raw'); suitable for the
 * "download Drive folder as .zip and drop it here" flow.
 * Exposes QDUnzip.read(fileOrBlob) -> Promise<[{ name, blob, lastMod }]>
 */
(function (root) {
  'use strict';

  function u16(v, o) { return v[o] | (v[o + 1] << 8); }
  function u32(v, o) { return (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0; }

  /** Find EOCD then walk the central directory. */
  async function read(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    // EOCD: last >=22 bytes, signature 0x06054b50 (+ comment up to 64K)
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file');
    const count = u16(buf, eocd + 10);
    let cdOff = u32(buf, eocd + 16);

    const out = [];
    for (let n = 0; n < count; n++) {
      if (u32(buf, cdOff) !== 0x02014b50) break;
      const compMethod = u16(buf, cdOff + 10);
      const compSize = u32(buf, cdOff + 20);
      const csize = u32(buf, cdOff + 24);
      const nameLen = u16(buf, cdOff + 28);
      const extraLen = u16(buf, cdOff + 30);
      const commentLen = u16(buf, cdOff + 32);
      const lho = u32(buf, cdOff + 42);
      const nameBytes = buf.slice(cdOff + 46, cdOff + 46 + nameLen);
      let name = '';
      for (let i = 0; i < nameBytes.length; i++) {
        name += nameBytes[i] < 128 ? String.fromCharCode(nameBytes[i]) : '_';
      }
      if (name.endsWith('/')) { // directory entry
        cdOff += 46 + nameLen + extraLen + commentLen;
        continue;
      }
      // local header (recompute data offset from local header — sizes may live here)
      const lhoNameLen = u16(buf, lho + 26);
      const lhoExtraLen = u16(buf, lho + 28);
      const dataStart = lho + 30 + lhoNameLen + lhoExtraLen;
      const useCompSize = u16(buf, lho + 6) & 8 ? compSize /* descriptor: CD wins */ : compSize;
      const size = useCompSize || csize;
      const raw = buf.slice(dataStart, dataStart + size);
      let data;
      if (compMethod === 0) {
        data = raw;
      } else if (compMethod === 8) {
        if (typeof DecompressionStream === 'undefined') {
          throw new Error('This browser cannot unzip compressed folders — use Chrome, Edge, Firefox or Safari (2023+).');
        }
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([raw]).stream().pipeThrough(ds);
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        cdOff += 46 + nameLen + extraLen + commentLen;
        continue; // unsupported method — skip file
      }
      const mime = guessMime(name);
      out.push({
        name: name.split('/').pop(),
        path: name,
        blob: new Blob([data], mime ? { type: mime } : {}),
        size: raw.length
      });
      cdOff += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function guessMime(name) {
    const m = /\.(jpe?g|png|tiff?|zip|csv|txt)$/i.exec(name);
    if (!m) return null;
    const e = m[1].toLowerCase();
    return e === 'csv' ? 'text/csv'
      : e === 'txt' ? 'text/plain'
      : e === 'png' ? 'image/png'
      : /tiff?/.test(e) ? 'image/tiff'
      : e === 'zip' ? 'application/zip' : 'image/jpeg';
  }

  root.QDUnzip = { read: read };
})(typeof self !== 'undefined' ? self : this);
