/**
 * export.js — ZIP export (STORE method, no compression) + manifest CSV.
 * Zero dependencies; produces a Blob then triggers a download.
 */
(function (root) {
  'use strict';

  // ---- CRC32 ----
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** Assemble a zip Blob from [{ name, data (Uint8Array) }]. */
  function buildZip(entries) {
    var parts = [], central = [], offset = 0;
    function u16(v) { return [v & 255, (v >>> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    // Names are written as UTF-8 with general-purpose bit 11 (0x0800) set.
    // The previous Latin-1 bytes without that flag are read as CP437 by
    // Windows Explorer / Info-ZIP, so "Pirámides_…_crop.jpg" came out as
    // "Pir├ímides…", and any char > U+00FF became "__".
    var UTF8_FLAG = 0x0800;
    var enc = new TextEncoder();
    // DOS date 0 is invalid (month/day 0); stamp entries with the export time
    var d = new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    entries.forEach(function (e) {
      var nameB = Array.from(enc.encode(e.name));
      // e.data may be a Blob with a precomputed e.crc / e.size (see
      // exportZip): Blob parts are references, so a multi-GB zip is not
      // copied into JS memory.
      var size = e.size != null ? e.size : e.data.length;
      var crc = e.crc != null ? e.crc : crc32(e.data);
      var localHeader = [].concat(u32(0x04034b50), u16(20), u16(UTF8_FLAG), u16(0), u16(dosTime), u16(dosDate),
        u32(crc), u32(size), u32(size),
        u16(nameB.length), u16(0), nameB);
      parts.push(new Uint8Array(localHeader), e.data);
      central.push([].concat(u32(0x02014b50), u16(20), u16(20), u16(UTF8_FLAG), u16(0), u16(dosTime), u16(dosDate),
        u32(crc), u32(size), u32(size),
        u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB));
      offset += localHeader.length + size;
    });
    var cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    var eocd = [].concat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(cdSize), u32(offset), u16(0));
    var blobParts = parts.concat(central.map(function (c) { return new Uint8Array(c); }),
      [new Uint8Array(eocd)]);
    return new Blob(blobParts, { type: 'application/zip' });
  }

  function nowStamp() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /**
   * Export a ZIP. `items` = the images whose crops go into the zip
   * (confidence ≥ 0.80 or manually adjusted). `manifestItems` (optional) =
   * every image loaded — they are all recorded in manifest.csv and
   * review.json (with an empty "file" column when no crop is included) so
   * excluded shots are never silently dropped.
   * item shape: { id, name, cropBlob|null, conf, ok, flags, meta, exif, source, corners, driveId, status }
   */
  /** Resize a square JPEG crop to side × side (high-quality resample). */
  function resizeCrop(blob, side) {
    return createImageBitmap(blob, { resizeWidth: side, resizeHeight: side, resizeQuality: 'high' })
      .then(function (bmp) {
        var cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(side, side)
          : Object.assign(document.createElement('canvas'), { width: side, height: side });
        cv.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close && bmp.close();
        return cv.convertToBlob ? cv.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
          : new Promise(function (res) { cv.toBlob(res, 'image/jpeg', 0.92); });
      });
  }

  function exportZip(items, manifestItems, meta, opts) {
    // opts.side: one output size (px) for every crop, or null to keep each
    // crop's own size (see cropSizeTarget in app.js)
    var outSide = opts && opts.side ? opts.side : null;
    manifestItems = manifestItems || items;
    // meta (from QDMetaTab.exportInfo(), null when the preset is "None"):
    // crops are named like the source photo (CoralNet matches the CSV's
    // Name column to the uploaded file name), get the preset CSV, and carry
    // EXIF (date, GPS, camera + the group's fields)
    var metaLines = meta ? [root.QDMeta.csvRow(meta.columns)] : null;
    var inZip = {};
    items.forEach(function (it) { inZip[it.id] = true; });

    var entries = [], rows = [], seen = {};
    var metaCols = collectMetaColumns(manifestItems);
    manifestItems.forEach(function (it) {
      var dupBase = meta ? meta.nameFor(it).replace(/\.jpg$/, '')
        : (it.exportName || it.name.replace(/\.[^.]+$/, '')) + '_crop';
      var base = dupBase; var n = 2;
      while (seen[base.toLowerCase() + '.jpg']) { base = dupBase + '_' + n++; }
      seen[base.toLowerCase() + '.jpg'] = true;
      var fileName = '';
      if (inZip[it.id]) {
        fileName = base + '.jpg';
        if (it.cropBlob) entries.push({ name: fileName, blob: it.cropBlob, exif: meta ? meta.exifFor(it) : null,
                                        resize: outSide && it.cropSide && it.cropSide !== outSide ? outSide : null });
        else if (it.warpData) entries.push({ name: fileName, data: it.warpData });
        else fileName = '';
      }
      var row = [
        fileName,
        it.excluded ? 'excluded' : it.ok ? (it.source === 'manual' ? 'manual' : (it.conf >= 0.8 ? 'auto' : 'review'))
              : (it.status === 'processing' ? 'review' : (it.status || 'failed')),
        it.ok ? Math.round(it.conf * 1000) / 1000 : '',
        (it.flags || []).join('; '),
        it.source || 'auto',
        (it.meta && it.meta.date) || '',
        (it.meta && it.meta.site) || '',
        (it.meta && it.meta.group) || '',
        (it.meta && it.meta.code) || '',
        (it.exif && it.exif.make) || '',
        (it.exif && it.exif.model) || '',
        (it.exif && (it.exif.dateTimeOriginal || it.exif.modifyDate)) || '',
        it.driveId || '',
        (root.QDMetaTab && root.QDMetaTab.groupOf(it)) || '',
        it.cropSide || '',
        fileName ? (outSide || it.cropSide || '') : ''
      ];
      if (meta && fileName) metaLines.push(root.QDMeta.csvRow(meta.rowFor(it, fileName)));
      metaCols.forEach(function (c) { row.push((it.meta && it.meta.csv && it.meta.csv[c]) || ''); });
      rows.push(row);
    });

    var header = ['file', 'status', 'confidence', 'flags', 'source', 'date', 'site', 'group', 'code',
      'exif_make', 'exif_model', 'exif_datetime', 'drive_file_id', 'group', 'square_side_px', 'output_px'].concat(metaCols);
    var lines = [root.QDMeta.csvRow(header)].concat(rows.map(function (r) { return root.QDMeta.csvRow(r); }));
    var manifest = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
    entries.push({ name: 'manifest.csv', data: manifest });
    if (meta) entries.push({ name: meta.csvName, data: new TextEncoder().encode(metaLines.join('\r\n') + '\r\n') });

    var review = { generated: new Date().toISOString(), items: manifestItems.map(function (it) {
      return { name: it.name, ok: it.ok, confidence: it.conf,
               source: it.source, corners: it.corners || null,
               flags: it.flags || [], status: it.excluded ? 'excluded' : it.status };
    }) };
    entries.push({ name: 'review.json', data: new TextEncoder().encode(JSON.stringify(review, null, 1)) });

    // One crop at a time: read it only to compute its CRC, then keep the
    // Blob itself as the zip part (Promise.all + arrayBuffer() used to hold
    // every crop in memory at once — ~3 GB for a 3000-photo batch).
    var ready = [];
    return entries.reduce(function (p, e) {
      return p.then(function () {
        if (!e.blob) { ready.push({ name: e.name, data: e.data }); return; }
        var src = e.resize ? resizeCrop(e.blob, e.resize) : Promise.resolve(e.blob);
        return src.then(function (blob) { e.blob = blob; return blob.arrayBuffer(); }).then(function (b) {
          var bytes = new Uint8Array(b), part = e.blob;
          if (e.exif && root.QDExifWrite) {
            bytes = root.QDExifWrite.embed(bytes, e.exif);
            part = new Blob([bytes], { type: 'image/jpeg' });
          }
          ready.push({ name: e.name, data: part, crc: crc32(bytes), size: bytes.length });
        });
      });
    }, Promise.resolve()).then(function () {
      var blob = buildZip(ready);
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'quadrat-crops-' + nowStamp() + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return blob.size;
    });
  }

  /** Union of CSV-joined column names (to make manifest columns stable). */
  function collectMetaColumns(items) {
    var set = [];
    var got = {};
    items.forEach(function (it) {
      var csv = it.meta && it.meta.csv;
      if (!csv) return;
      Object.keys(csv).forEach(function (k) {
        if (k[0] !== '_' && !got[k]) { got[k] = true; set.push(k); }
      });
    });
    return set.slice(0, 40);
  }

  root.QDExport = { exportZip: exportZip, buildZip: buildZip };
})(typeof self !== 'undefined' ? self : this);
