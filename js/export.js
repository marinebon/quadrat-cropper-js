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
    function latinBytes(s) {
      var a = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c > 255) a.push(0x5f, 0x5f); else a.push(c);
      }
      return a;
    }
    entries.forEach(function (e) {
      var nameB = latinBytes(e.name);
      var crc = crc32(e.data);
      var localHeader = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(e.data.length), u32(e.data.length),
        u16(nameB.length), u16(0), nameB);
      parts.push(new Uint8Array(localHeader), e.data);
      central.push([].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(e.data.length), u32(e.data.length),
        u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB));
      offset += localHeader.length + e.data.length;
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
  function exportZip(items, manifestItems) {
    manifestItems = manifestItems || items;
    var inZip = {};
    items.forEach(function (it) { inZip[it.id] = true; });

    var entries = [], rows = [], seen = {};
    var metaCols = collectMetaColumns(manifestItems);
    manifestItems.forEach(function (it) {
      var dupBase = (it.exportName || it.name.replace(/\.[^.]+$/, '')) + '_crop';
      var base = dupBase; var n = 2;
      while (seen[base + '.jpg']) { base = dupBase + '_' + n++; }
      seen[base + '.jpg'] = true;
      var fileName = '';
      if (inZip[it.id]) {
        fileName = base + '.jpg';
        if (it.cropBlob) entries.push({ name: fileName, blob: it.cropBlob });
        else if (it.warpData) entries.push({ name: fileName, data: it.warpData });
        else fileName = '';
      }
      var row = [
        fileName,
        it.ok ? (it.source === 'manual' ? 'manual' : (it.conf >= 0.8 ? 'auto' : 'review'))
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
        it.driveId || ''
      ];
      metaCols.forEach(function (c) { row.push((it.meta && it.meta.csv && it.meta.csv[c]) || ''); });
      rows.push(row);
    });

    var header = ['file', 'status', 'confidence', 'flags', 'source', 'date', 'site', 'group', 'code',
      'exif_make', 'exif_model', 'exif_datetime', 'drive_file_id'].concat(metaCols);
    var lines = [root.QDMeta.csvRow(header)].concat(rows.map(function (r) { return root.QDMeta.csvRow(r); }));
    var manifest = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
    entries.push({ name: 'manifest.csv', data: manifest });

    var review = { generated: new Date().toISOString(), items: manifestItems.map(function (it) {
      return { name: it.name, ok: it.ok, confidence: it.conf,
               source: it.source, corners: it.corners || null,
               flags: it.flags || [], status: it.status };
    }) };
    entries.push({ name: 'review.json', data: new TextEncoder().encode(JSON.stringify(review, null, 1)) });

    return Promise.all(entries.map(function (e) {
      if (e.blob) return e.blob.arrayBuffer().then(function (b) { return { name: e.name, data: new Uint8Array(b) }; });
      return Promise.resolve({ name: e.name, data: e.data });
    })).then(function (ready) {
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
