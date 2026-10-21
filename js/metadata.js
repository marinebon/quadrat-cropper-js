/**
 * metadata.js — filename parsing + Drive CSV joining.
 *
 * Filenames in these datasets look like:
 *   "20251111_HIGHTIDE_Group_2_PB110048.jpg"
 *   "P1120587.JPG"
 * We extract a date (YYYYMMDD), site/label tokens, an optional group number,
 * and a trailing short code (e.g. PB110048, P1120587).
 *
 * Drive CSVs (metadata.csv, annotations.csv, …) are joined by
 * filename or code column when present.
 */
(function (root) {
  'use strict';

  /** Parse a photoquadrat filename into structured bits. */
  function parseFilename(name) {
    var m = { original: name, date: null, site: null, group: null, code: null };
    var base = name.replace(/\.[^.]+$/, '');
    // date + site + optional Group_N + optional code
    var rx = /^(\d{4})(\d{2})(\d{2})_([^_]+(?:_[^_]+)*?)(?:_Group[-_ ]?(\d+))?(?:_([A-Z]{1,3}\d{4,7}))?$/i;
    var hit = rx.exec(base);
    if (hit) {
      m.date = hit[1] + '-' + hit[2] + '-' + hit[3];
      m.site = hit[4] || null;
      m.group = hit[5] ? +hit[5] : null;
      m.code = hit[6] || null;
      return m;
    }
    // plain "CODE 1234567" style (e.g. P1120587)
    var c = /\b([A-Z]{1,3}\d{4,7})\b/.exec(base.toUpperCase());
    if (c) m.code = c[1];
    return m;
  }

  /** RFC-ish CSV parser (handles quoted fields, commas, newlines, \r\n). */
  function parseCSV(text) {
    var rows = [], row = [], field = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
    if (!rows.length) return { header: [], rows: [] };
    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var data = rows.slice(1).map(function (r) {
      var o = {};
      header.forEach(function (h, idx) { o[h] = r[idx] !== undefined ? r[idx].trim() : ''; });
      return o;
    });
    return { header: header, rows: data };
  }

  /** Build a lookup: filename-ish & code-ish keys -> CSV row. */
  function buildCSVIndex(header, rows) {
    var byName = [], byCode = [];
    header.forEach(function (h) {
      var hl = h.replace(/[^a-z]/g, '');
      if (/^(image|filename|file|name|img|photo|imagename|sourcefile)$/.test(hl)) byName.push(h);
      if (/^(code|samplecode|quadratcode|imageref|photo.?code|image.?id)$/.test(hl)) byCode.push(h);
    });
    // also treat ANY header literally containing 'code' as code candidate (last resort)
    if (!byCode.length) {
      header.forEach(function (h) { if (/code$/.test(h)) byCode.push(h); });
    }
    var idx = { byName: {}, byCode: {}, byNameCols: byName, byCodeCols: byCode };
    rows.forEach(function (r, i) {
      byName.forEach(function (c) {
        var v = (r[c] || '').trim();
        if (!v) return;
        idx.byName[v.toLowerCase()] = i;
        var b = v.replace(/\.[^.]+$/, '').toLowerCase();
        if (b !== v.toLowerCase()) idx.byName[b] = i;
      });
      byCode.forEach(function (c) {
        var v = (r[c] || '').trim().toUpperCase();
        if (v) idx.byCode[v] = i;
      });
    });
    return idx;
  }

  /** Join parsed filename + CSV indexes into one metadata object. */
  function joinMeta(fname, csvs) {
    var parsed = parseFilename(fname);
    var meta = Object.assign({}, parsed);
    meta.csv = {};
    (csvs || []).forEach(function (csv) {
      var idx = buildCSVIndex(csv.header, csv.rows);
      var name = fname.toLowerCase();
      var bare = name.replace(/\.[^.]+$/, '');
      var rowIdx = (name in idx.byName) ? idx.byName[name]
                 : (bare in idx.byName) ? idx.byName[bare]
                 : (parsed.code && parsed.code.toUpperCase() in idx.byCode)
                   ? idx.byCode[parsed.code.toUpperCase()] : null;
      if (rowIdx != null) {
        var row = csv.rows[rowIdx];
        Object.keys(row).forEach(function (k) {
          if (k && row[k] !== '') meta.csv[k] = row[k];
        });
        meta.csv._row = rowIdx;
      }
    });
    return meta;
  }

  /** Manifest CSV value quoting. */
  function csvEscape(v) {
    v = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function csvRow(cells) { return cells.map(csvEscape).join(','); }

  root.QDMeta = {
    parseFilename: parseFilename,
    parseCSV: parseCSV,
    joinMeta: joinMeta,
    buildCSVIndex: buildCSVIndex,
    csvRow: csvRow
  };
})(typeof self !== 'undefined' ? self : this);
