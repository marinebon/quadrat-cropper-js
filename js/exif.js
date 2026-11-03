/**
 * exif.js — minimal JPEG EXIF reader (no dependencies).
 * Exposes window.QDExif.fromBlob(blob) -> Promise<{make, model, dateTimeOriginal, orientation}>
 * Falls back to {} for non-JPEG or EXIF-less files.
 */
(function (root) {
  'use strict';

  var TAGS = {
    0x010f: { key: 'make', type: 'ascii' },
    0x0110: { key: 'model', type: 'ascii' },
    0x0112: { key: 'orientation', type: 'short' },
    0x0132: { key: 'modifyDate', type: 'ascii' }
  };
  var EXIF_TAGS = {
    0x9003: { key: 'dateTimeOriginal', type: 'ascii' },
    0x9004: { key: 'dateTimeDigitized', type: 'ascii' }
  };

  function readString(view, dv, offset, len) {
    var s = '';
    for (var i = 0; i < len - 1; i++) {
      var c = dv.getUint8(offset + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** Parse a TIFF-structured EXIF block from ArrayBuffer. */
  function parseExifBuffer(buf) {
    var dv = new DataView(buf);
    if (dv.byteLength < 8) return {};
    if (dv.getUint16(0) !== 0x4949 && dv.getUint16(0) !== 0x4d4d) return {};
    var little = dv.getUint16(0) === 0x4949;
    function u16(o) { return dv.getUint16(o, little); }
    function u32(o) { return dv.getUint32(o, little); }
    // 0x2a = TIFF (CR2, NEF, ARW, DNG, PEF…); Olympus ORF uses "RO"/"RS",
    // Panasonic RW2 uses 0x55 — same IFD layout otherwise
    var magic = u16(2);
    if (magic !== 0x2a && magic !== 0x4f52 && magic !== 0x5352 && magic !== 0x55) return {};
    var t0 = u32(4);                       // IFD0 offset
    if (t0 + 2 > dv.byteLength) return {};
    var out = {};
    var nEntries = u16(t0);

    function readValueOffset(e) {
      var valCount = u32(e + 4);
      // value stored inline (<= 4 bytes) or at a TIFF-relative pointer
      return valCount * typeLen(u16(e + 2)) <= 4 ? e + 8 : u32(e + 8);
    }
    function typeLen(t) { return [0, 1, 1, 2, 4, 8, 1, 1, 4, 8][t] || 1; }

    function readIfd(offset, tags) {
      if (offset + 2 > dv.byteLength) return;
      var n = dv.getUint16(offset, little);
      for (var i = 0; i < n; i++) {
        var e = offset + 2 + i * 12;
        if (e + 12 > dv.byteLength) return;
        var tag = u16(e);
        var meta = tags[tag];
        if (meta && u16(e + 2) === { ascii: 2, short: 3, long: 4 }[meta.type]) {
          var vo = readValueOffset(e);
          if (vo + 1 > dv.byteLength - 1) continue;
          out[meta.key] = (meta.type === 'ascii')
            ? readString(null, dv, vo, u32(e + 4)).trim() // TG-6 pads Model with spaces
            : u16(vo);
        } else if (tag === 0x8769) {           // Exif IFD pointer (TIFF-relative)
          readIfd(u32(e + 8), EXIF_TAGS);
        } else if (tag === 0x8825 && tags === TAGS) { // GPS IFD pointer
          readGps(u32(e + 8));
        }
      }
    }
    /** GPS IFD → decimal degrees (signed by the N/S, E/W refs). */
    function readGps(offset) {
      if (offset + 2 > dv.byteLength) return;
      var n = u16(offset), ref = {}, val = {};
      for (var i = 0; i < n; i++) {
        var e = offset + 2 + i * 12;
        if (e + 12 > dv.byteLength) return;
        var tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        if ((tag === 1 || tag === 3) && type === 2) ref[tag] = String.fromCharCode(dv.getUint8(e + 8));
        if ((tag === 2 || tag === 4) && type === 5 && cnt === 3) {
          var o = u32(e + 8);
          if (o + 24 > dv.byteLength) continue;
          var d = [0, 1, 2].map(function (k) {
            var den = u32(o + k * 8 + 4);
            return den ? u32(o + k * 8) / den : 0;
          });
          val[tag] = d[0] + d[1] / 60 + d[2] / 3600;
        }
      }
      if (val[2] != null && val[4] != null && (val[2] || val[4])) {
        out.latitude = (ref[1] === 'S' ? -1 : 1) * val[2];
        out.longitude = (ref[3] === 'W' ? -1 : 1) * val[4];
      }
    }

    readIfd(t0, TAGS);
    return out;
  }

  /** Find the EXIF APP1 segment in a JPEG slice and parse it. */
  function parseJpeg(buf) {
    var dv = new DataView(buf);
    if (dv.getUint16(0) !== 0xffd8) return {};
    var off = 2;
    while (off + 4 <= dv.byteLength) {
      if (dv.getUint8(off) !== 0xff) break;
      var marker = dv.getUint8(off + 1);
      var size = dv.getUint16(off + 2);
      if (marker === 0xe1 && size > 8 &&
          dv.getUint32(off + 4) === 0x45786966 && dv.getUint16(off + 8) === 0x0000) {
        return parseExifBuffer(buf.slice(off + 10, off + 2 + size));
      }
      off += 2 + size;
      if (marker === 0xda) break;              // start of scan — stop
    }
    return {};
  }

  async function fromBlob(blob) {
    try {
      // read first 256 KB – EXIF always lives in the file head
      var head = blob.slice(0, 262144);
      var buf = await head.arrayBuffer();
      return parseJpeg(buf);
    } catch (e) {
      return {};
    }
  }

  /** EXIF straight from a TIFF-based RAW file (whole-file ArrayBuffer). */
  function fromTiffBuffer(buf) {
    try { return parseExifBuffer(buf); } catch (e) { return {}; }
  }

  root.QDExif = { fromBlob: fromBlob, fromTiffBuffer: fromTiffBuffer };
})(typeof self !== 'undefined' ? self : this);
