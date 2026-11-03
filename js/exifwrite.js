/**
 * exifwrite.js — embed metadata in the exported crops (EXIF APP1 segment).
 *
 * Canvas-encoded JPEGs carry no metadata, so the crops lost the camera date,
 * GPS and model of the original photo. At export time we insert a minimal,
 * standards-compliant EXIF block right after SOI:
 *
 *   IFD0:  ImageDescription (the form fields, "key=value; …"), Make, Model,
 *          Orientation = 1 (the crop is already upright), Software, Artist
 *          (photographer), DateTime
 *   Exif:  DateTimeOriginal, UserComment (same text as ImageDescription)
 *   GPS:   GPSVersionID, latitude / longitude with N/S, E/W refs
 *
 * QDExifWrite.embed(jpegBytes: Uint8Array, info) -> Uint8Array
 *   info = { make, model, dateTimeOriginal ("YYYY:MM:DD HH:MM:SS"),
 *            latitude, longitude, artist, description, software }
 */
(function (root) {
  'use strict';

  var enc = new TextEncoder();
  var ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5, BYTE = 1, UNDEFINED = 7;
  var SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

  function asciiBytes(s) { return Array.from(enc.encode(String(s))).concat([0]); }

  function rationalDMS(deg) {
    deg = Math.abs(deg);
    var d = Math.floor(deg), mFloat = (deg - d) * 60, m = Math.floor(mFloat);
    var s = Math.round((mFloat - m) * 60 * 10000);
    return [[d, 1], [m, 1], [s, 10000]];
  }

  /**
   * Serialize one IFD at absolute TIFF offset `base`. entries: [{tag, type,
   * count, bytes}] (bytes little-endian). Returns { bytes, size } where values
   * longer than 4 bytes live in a data area right after the IFD.
   */
  function buildIfd(entries, base) {
    entries.sort(function (a, b) { return a.tag - b.tag; });
    var n = entries.length, headLen = 2 + n * 12 + 4;
    var data = [], out = [];
    function u16(v) { out.push(v & 255, (v >>> 8) & 255); }
    function u32(v) { out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }
    u16(n);
    entries.forEach(function (e) {
      u16(e.tag); u16(e.type); u32(e.count);
      if (e.bytes.length <= 4) {
        var b = e.bytes.slice(); while (b.length < 4) b.push(0);
        out.push.apply(out, b);
      } else {
        u32(base + headLen + data.length);
        data.push.apply(data, e.bytes);
        if (data.length % 2) data.push(0); // word-align the next value
      }
    });
    u32(0); // no next IFD
    return out.concat(data);
  }

  function le16(v) { return [v & 255, (v >>> 8) & 255]; }
  function le32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
  function rationals(list) {
    var b = [];
    list.forEach(function (r) { b = b.concat(le32(r[0]), le32(r[1])); });
    return b;
  }
  function ascii(tag, s) { var b = asciiBytes(s); return { tag: tag, type: ASCII, count: b.length, bytes: b }; }

  function buildTiff(info) {
    var hasGps = isFinite(info.latitude) && isFinite(info.longitude) &&
                 info.latitude !== null && info.longitude !== null;
    var desc = info.description || '';
    // UserComment: 8-byte charset header + text ("ASCII\0\0\0" is the most
    // widely read; UTF-8 bytes beyond ASCII are tolerated by common readers)
    var uc = [0x41, 0x53, 0x43, 0x49, 0x49, 0, 0, 0].concat(Array.from(enc.encode(desc)));

    var ifd0 = [];
    if (desc) ifd0.push(ascii(0x010E, desc));
    if (info.make) ifd0.push(ascii(0x010F, info.make));
    if (info.model) ifd0.push(ascii(0x0110, info.model));
    ifd0.push({ tag: 0x0112, type: SHORT, count: 1, bytes: le16(1) });
    ifd0.push(ascii(0x0131, info.software || 'Quadrat Cropper'));
    if (info.dateTimeOriginal) ifd0.push(ascii(0x0132, info.dateTimeOriginal));
    if (info.artist) ifd0.push(ascii(0x013B, info.artist));
    // pointers filled after we know the layout (placeholders, fixed size)
    var exifPtr = { tag: 0x8769, type: LONG, count: 1, bytes: le32(0) };
    ifd0.push(exifPtr);
    var gpsPtr = hasGps ? { tag: 0x8825, type: LONG, count: 1, bytes: le32(0) } : null;
    if (gpsPtr) ifd0.push(gpsPtr);

    var exif = [];
    if (info.dateTimeOriginal) exif.push(ascii(0x9003, info.dateTimeOriginal));
    if (desc) exif.push({ tag: 0x9286, type: UNDEFINED, count: uc.length, bytes: uc });

    var gps = hasGps ? [
      { tag: 0x0000, type: BYTE, count: 4, bytes: [2, 3, 0, 0] },
      ascii(0x0001, info.latitude < 0 ? 'S' : 'N'),
      { tag: 0x0002, type: RATIONAL, count: 3, bytes: rationals(rationalDMS(info.latitude)) },
      ascii(0x0003, info.longitude < 0 ? 'W' : 'E'),
      { tag: 0x0004, type: RATIONAL, count: 3, bytes: rationals(rationalDMS(info.longitude)) }
    ] : null;

    // layout: header(8) | IFD0 | Exif IFD | GPS IFD
    var ifd0Bytes = buildIfd(ifd0, 8);
    var exifOff = 8 + ifd0Bytes.length;
    exifPtr.bytes = le32(exifOff);
    var exifBytes = buildIfd(exif, exifOff);
    var gpsOff = exifOff + exifBytes.length;
    if (gpsPtr) gpsPtr.bytes = le32(gpsOff);
    ifd0Bytes = buildIfd(ifd0, 8); // rebuild with the real pointers (same size)
    var gpsBytes = gps ? buildIfd(gps, gpsOff) : [];
    return [0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0].concat(ifd0Bytes, exifBytes, gpsBytes);
  }

  /** Insert an APP1 Exif segment after SOI, dropping any existing APP1 Exif. */
  function embed(jpeg, info) {
    if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return jpeg;
    var tiff = buildTiff(info);
    var payload = [0x45, 0x78, 0x69, 0x66, 0, 0].concat(tiff); // "Exif\0\0"
    var segLen = payload.length + 2;
    if (segLen > 0xFFFF) return jpeg; // description absurdly long: skip
    var app1 = [0xFF, 0xE1, (segLen >>> 8) & 255, segLen & 255].concat(payload);
    // skip an existing Exif APP1 (canvas output has none, but be safe)
    var rest = 2;
    if (jpeg[2] === 0xFF && jpeg[3] === 0xE1 && jpeg[6] === 0x45 && jpeg[7] === 0x78) {
      rest = 4 + ((jpeg[4] << 8) | jpeg[5]);
    }
    var out = new Uint8Array(2 + app1.length + (jpeg.length - rest));
    out[0] = 0xFF; out[1] = 0xD8;
    out.set(app1, 2);
    out.set(jpeg.subarray(rest), 2 + app1.length);
    return out;
  }

  root.QDExifWrite = { embed: embed, _buildTiff: buildTiff };
})(typeof self !== 'undefined' ? self : this);
