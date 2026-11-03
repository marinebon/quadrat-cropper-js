/**
 * raw.js — camera RAW support (Canon CR2/CR3, Nikon NEF/NRW, Olympus ORF,
 * Sony ARW, Adobe DNG, Panasonic RW2, Fuji RAF, Pentax PEF, Samsung SRW).
 *
 * Browsers cannot decode RAW sensor data, but every one of these formats
 * embeds a camera-rendered JPEG. We pull out the LARGEST embedded baseline /
 * progressive JPEG (full resolution in CR2/NEF/ARW/DNG; Olympus ORF often
 * only carries a smaller preview — flagged) and process it like any photo.
 *
 * Generic, format-agnostic: scan for JPEG SOI markers, walk each candidate's
 * segments (so EXIF thumbnails nested in APP1 are skipped), read its SOF
 * dimensions and find its EOI. Lossless JPEG (SOF3 — CR2/DNG raw data) is
 * ignored. The orientation is taken from the RAW's TIFF header when the
 * embedded JPEG has none, and applied by re-encoding (rotated) once.
 *
 * QDRaw.isRaw(name) / QDRaw.toJpeg(blob) -> Promise<{ blob, width, height,
 * exif, orientation, small }>
 */
(function (root) {
  'use strict';

  var RAW_EXT = /\.(cr2|cr3|nef|nrw|orf|arw|dng|rw2|raf|pef|srw)$/i;
  var SMALL_PREVIEW = 2500; // long side below this → flag as reduced resolution

  function isRaw(name) { return RAW_EXT.test(name || ''); }

  function u16be(u, i) { return (u[i] << 8) | u[i + 1]; }

  /** Parse one JPEG starting at `start` (FFD8). null if not a usable one. */
  function probeJpeg(u, start) {
    var n = u.length, j = start + 2, w = 0, h = 0, sof = 0, scan = -1;
    while (j + 4 <= n) {
      if (u[j] !== 0xFF) return null;
      var m = u[j + 1];
      if (m === 0xFF) { j++; continue; }                     // fill byte
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { j += 2; continue; }
      var len = u16be(u, j + 2);
      if (len < 2) return null;
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        sof = m; h = u16be(u, j + 5); w = u16be(u, j + 7);
      }
      if (m === 0xDA) { scan = j + 2 + len; break; }
      j += 2 + len;
    }
    if (scan < 0 || !w || !h || (sof !== 0xC0 && sof !== 0xC1 && sof !== 0xC2)) return null;
    // entropy data: the first FFD9 not part of a stuffed byte / restart
    // marker ends the image (progressive files keep scanning across their
    // further DHT/SOS segments until the EOI)
    var k = scan;
    while (k < n - 1) {
      k = u.indexOf(0xFF, k);
      if (k < 0 || k >= n - 1) return null;
      var b = u[k + 1];
      if (b === 0xD9) return { start: start, end: k + 2, width: w, height: h };
      k += (b === 0xFF) ? 1 : 2;
    }
    return null;
  }

  function largestJpeg(u) {
    var best = null, pos = 0, n = u.length;
    while (pos < n - 3) {
      var i = u.indexOf(0xFF, pos);
      if (i < 0 || i >= n - 3) break;
      if (u[i + 1] === 0xD8 && u[i + 2] === 0xFF) {
        var c = probeJpeg(u, i);
        if (c) {
          if (!best || c.width * c.height > best.width * best.height) best = c;
          pos = c.end;
          continue;
        }
      }
      pos = i + 1;
    }
    return best;
  }

  /** Re-encode with the RAW's EXIF orientation applied (3 = 180°, 6 = 90° CW, 8 = 90° CCW). */
  async function rotate(blob, orientation) {
    var bmp = await createImageBitmap(blob);
    var swap = orientation === 6 || orientation === 8;
    var cv = document.createElement('canvas');
    cv.width = swap ? bmp.height : bmp.width;
    cv.height = swap ? bmp.width : bmp.height;
    var ctx = cv.getContext('2d');
    if (orientation === 3) { ctx.translate(cv.width, cv.height); ctx.rotate(Math.PI); }
    else if (orientation === 6) { ctx.translate(cv.width, 0); ctx.rotate(Math.PI / 2); }
    else if (orientation === 8) { ctx.translate(0, cv.height); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    return new Promise(function (res) { cv.toBlob(res, 'image/jpeg', 0.95); });
  }

  async function toJpeg(file) {
    var buf = await file.arrayBuffer();
    var u = new Uint8Array(buf);
    var best = largestJpeg(u);
    if (!best) throw new Error('no embedded JPEG found in this RAW file');
    var jpg = new Blob([u.subarray(best.start, best.end)], { type: 'image/jpeg' });
    // camera make/model/date + orientation from the RAW's own TIFF header
    var exif = (root.QDExif && root.QDExif.fromTiffBuffer) ? root.QDExif.fromTiffBuffer(buf) : {};
    var inner = root.QDExif ? await root.QDExif.fromBlob(jpg) : {};
    var orientation = exif.orientation || 1;
    if (!inner.orientation && (orientation === 3 || orientation === 6 || orientation === 8)) {
      jpg = await rotate(jpg, orientation);
    }
    var w = best.width, h = best.height;
    if (orientation === 6 || orientation === 8) { var t = w; w = h; h = t; }
    Object.keys(inner).forEach(function (k) { if (!exif[k]) exif[k] = inner[k]; });
    return { blob: jpg, width: w, height: h, exif: exif, orientation: orientation,
             small: Math.max(w, h) < SMALL_PREVIEW };
  }

  root.QDRaw = { isRaw: isRaw, toJpeg: toJpeg, RAW_EXT: RAW_EXT, _largestJpeg: largestJpeg };
})(typeof self !== 'undefined' ? self : this);
