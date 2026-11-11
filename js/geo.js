/**
 * geo.js — GPS helpers for the Map tab (no DOM, UMD: also loads in Node).
 *
 * Window global: QDGeo
 *
 *   parseTrack(text, fileName, opts) -> { points: [{t, lat, lon}], format, skipped }
 *       GPX (trkpt / rtept / wpt with <time>), KML (gx:Track or timestamped
 *       Placemarks) or CSV/TXT (columns time + lat + lon, any order).
 *       t = milliseconds UTC. opts.csvTzMin = UTC offset (minutes) applied to
 *       CSV times written without a zone (GPX/KML times are always UTC).
 *
 *   photoTime(exif, opts) -> { utc, local, usedExifOffset } | null
 *       Camera time of a photo in ms UTC. The camera writes local wall-clock
 *       time (DateTimeOriginal) with no zone, so the zone comes from
 *       opts.camTzMin, or from EXIF OffsetTimeOriginal when opts.useExifOffset
 *       and the camera wrote it. opts.clockOffsetSec corrects a camera clock
 *       that is fast/slow relative to the GPS (positive = add to camera time).
 *
 *   clockOffsetFromReference(photoExif, gpsWallClock, gpsTzMin, opts) -> seconds
 *       The iBenthos geotagging method: photograph the GPS screen once, type
 *       the time it shows; the difference is the camera clock error.
 *
 *   locate(points, tUtc, opts) -> { lat, lon, dt, gap, interpolated } | { error }
 *       Position at time t: linear interpolation between the two fixes
 *       around t if they are ≤ opts.maxGapSec apart; the nearest end fix if t
 *       is ≤ opts.edgeTolSec outside the track; otherwise an error.
 *
 *   position(item) -> { latitude, longitude, source } | null
 *       The position used for display and export: a position assigned in the
 *       Map tab (item.geo: 'map' or 'track') wins over the camera's EXIF GPS.
 *
 * Method based on CSIRO's iBenthos geotagging tool
 * (https://github.com/csiro/ibenthos-geotagging-tool, LGPL-3.0): GPX track +
 * camera time zone + reference photo of the GPS screen. Re-implemented here
 * (no code copied) and extended with KML/CSV tracks, interpolation limits and
 * EXIF OffsetTime support.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QDGeo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------ time zones

  /** UTC offsets in minutes, the set in use worldwide (incl. :30 and :45). */
  var TZ_LIST = [-720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180,
    -120, -60, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525,
    540, 570, 600, 630, 660, 720, 765, 780, 840];

  function fmtTz(min) {
    var s = min < 0 ? '-' : '+', a = Math.abs(min);
    return 'UTC' + s + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** "+05:30", "-03:00", "Z" → minutes; null if not parseable. */
  function parseTzString(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (/^z$/i.test(s)) return 0;
    var m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(s);
    if (!m) return null;
    var v = (+m[2]) * 60 + (+(m[3] || 0));
    return m[1] === '-' ? -v : v;
  }

  /** "±hh:mm:ss" / "±mm:ss" / "±ss" → seconds (NaN if invalid). */
  function parseOffset(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return 0;
    var m = /^([+-])?(\d+(?:\.\d+)?)(?::(\d{1,2}(?:\.\d+)?))?(?::(\d{1,2}(?:\.\d+)?))?$/.exec(s);
    if (!m) return NaN;
    var parts = [m[2], m[3], m[4]].filter(function (x) { return x != null; }).map(Number);
    var v = 0;
    parts.forEach(function (p) { v = v * 60 + p; });
    return m[1] === '-' ? -v : v;
  }
  function fmtOffset(sec) {
    var s = sec < 0 ? '-' : '+', a = Math.round(Math.abs(sec));
    return s + pad(Math.floor(a / 3600)) + ':' + pad(Math.floor(a / 60) % 60) + ':' + pad(a % 60);
  }

  /** Wall-clock "YYYY:MM:DD HH:MM:SS" or "YYYY-MM-DD[T ]HH:MM[:SS[.fff]]" → ms as if UTC. */
  function wallClockMs(s, subsec) {
    s = String(s || '').trim();
    // day-first dates (dd/mm/yyyy, as exported in Latin America / Europe) → ISO order
    s = s.replace(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?=[ T])/, '$3-$2-$1');
    var m = /^(\d{4})[:\-/](\d{1,2})[:\-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?/.exec(s);
    if (!m) return null;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    var frac = m[7] != null ? m[7] : (subsec != null ? String(subsec).replace(/\D/g, '') : '');
    if (frac) ms += Math.round(+('0.' + frac) * 1000);
    return isNaN(ms) ? null : ms;
  }

  /**
   * A track/CSV time string → ms UTC. ISO strings with Z or ±hh:mm keep their
   * zone; bare wall-clock times use tzMin; plain numbers are Unix epoch
   * seconds (or ms when > 1e11).
   */
  function parseTime(s, tzMin) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) { var n = +s; return n > 1e11 ? n : n * 1000; }
    var z = /(Z|[+-]\d{2}:?\d{2})$/i.exec(s);
    var base = wallClockMs(z ? s.slice(0, z.index) : s);
    if (base == null) return null;
    var off = z ? parseTzString(z[1]) : (tzMin || 0);
    return base - off * 60000;
  }

  // ------------------------------------------------------------ track files

  function num(s) { var v = parseFloat(String(s).replace(',', '.')); return isFinite(v) ? v : null; }
  function attr(tag, name) {
    var m = new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']+)["\']', 'i').exec(tag);
    return m ? m[1] : null;
  }
  function validLatLon(lat, lon) {
    return lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  }

  function parseGpx(text) {
    var pts = [], skipped = 0, re = /<(?:\w+:)?(trkpt|rtept|wpt)\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:\w+:)?\1\s*>)/gi, m;
    while ((m = re.exec(text))) {
      var lat = num(attr(m[2], 'lat')), lon = num(attr(m[2], 'lon'));
      var tm = m[4] && /<(?:\w+:)?time>\s*([^<]+?)\s*<\/(?:\w+:)?time>/i.exec(m[4]);
      var t = tm ? parseTime(tm[1], 0) : null;
      if (validLatLon(lat, lon) && t != null) pts.push({ t: t, lat: lat, lon: lon });
      else skipped++;
    }
    return { points: pts, skipped: skipped };
  }

  function parseKml(text) {
    var pts = [], skipped = 0, m;
    // gx:Track — parallel <when> and <gx:coord> lists, in order, per track
    var trackRe = /<gx:Track\b[\s\S]*?<\/gx:Track>/gi;
    while ((m = trackRe.exec(text))) {
      var whens = [], coords = [], w, c;
      var wr = /<when>\s*([^<]+?)\s*<\/when>/gi, cr = /<gx:coord>\s*([^<]+?)\s*<\/gx:coord>/gi;
      while ((w = wr.exec(m[0]))) whens.push(w[1]);
      while ((c = cr.exec(m[0]))) coords.push(c[1]);
      for (var i = 0; i < Math.min(whens.length, coords.length); i++) {
        var p = coords[i].split(/\s+/), t = parseTime(whens[i], 0);
        var lon = num(p[0]), lat = num(p[1]);
        if (validLatLon(lat, lon) && t != null) pts.push({ t: t, lat: lat, lon: lon }); else skipped++;
      }
    }
    // timestamped Placemarks: <TimeStamp><when> + <Point><coordinates>lon,lat
    var pmRe = /<Placemark\b[\s\S]*?<\/Placemark>/gi;
    while ((m = pmRe.exec(text))) {
      if (/<gx:Track\b/i.test(m[0])) continue;
      var wm = /<TimeStamp>[\s\S]*?<when>\s*([^<]+?)\s*<\/when>/i.exec(m[0]);
      var cm = /<Point>[\s\S]*?<coordinates>\s*([^<]+?)\s*<\/coordinates>/i.exec(m[0]);
      if (!wm || !cm) continue;
      var q = cm[1].split(','), tt = parseTime(wm[1], 0);
      var la = num(q[1]), lo = num(q[0]);
      if (validLatLon(la, lo) && tt != null) pts.push({ t: tt, lat: la, lon: lo }); else skipped++;
    }
    return { points: pts, skipped: skipped };
  }

  function splitCsvLine(line, d) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === d) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  /**
   * CSV / TXT: a header row with a latitude column, a longitude column and
   * either one date-time column or separate date and time columns.
   * Dates: ISO (yyyy-mm-dd) or day-first (dd/mm/yyyy); never month-first.
   * Decimal commas in coordinates are accepted.
   * Delimiter: the first of ; tab , that splits the header into ≥ 3 columns.
   */
  function parseCsv(text, tzMin) {
    var lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return { points: [], skipped: 0, error: 'empty CSV' };
    var d = [';', '\t', ','].filter(function (c) { return splitCsvLine(lines[0], c).length >= 3; })[0];
    if (!d) return { points: [], skipped: 0, error: 'could not find the columns' };
    var h = splitCsvLine(lines[0], d).map(function (s) { return s.toLowerCase().replace(/[^a-z_]/g, ''); });
    function col(names) {
      for (var i = 0; i < h.length; i++) if (names.indexOf(h[i]) >= 0) return i;
      return -1;
    }
    var iLat = col(['lat', 'latitude', 'y', 'gpslatitude']);
    var iLon = col(['lon', 'lng', 'long', 'longitude', 'x', 'gpslongitude']);
    var iDT = col(['time', 'datetime', 'timestamp', 'utc', 'datetimeutc', 'timeutc', 'gpstime', 'date_time', 'isotime']);
    var iDate = col(['date', 'fecha', 'gpsdate', 'dateutc']), iTime = col(['time', 'hora', 'clock', 'timeofday', 'timeutc', 'gpstime']);
    // separate date + time columns (e.g. "date;time"): combine them
    if (iDate >= 0 && iTime >= 0 && iDate !== iTime) iDT = -1;
    if (iLat < 0 || iLon < 0 || (iDT < 0 && (iDate < 0 || iTime < 0))) {
      return { points: [], skipped: 0, error: 'need lat, lon and time columns (header: ' + h.join(', ') + ')' };
    }
    var pts = [], skipped = 0;
    for (var r = 1; r < lines.length; r++) {
      var c = splitCsvLine(lines[r], d);
      var raw = iDT >= 0 ? c[iDT] : (c[iDate] + ' ' + c[iTime]);
      var t = parseTime(raw, tzMin), lat = num(c[iLat]), lon = num(c[iLon]);
      if (validLatLon(lat, lon) && t != null) pts.push({ t: t, lat: lat, lon: lon }); else skipped++;
    }
    return { points: pts, skipped: skipped };
  }

  function parseTrack(text, fileName, opts) {
    opts = opts || {};
    var ext = String(fileName || '').toLowerCase().split('.').pop(), r, format;
    if (ext === 'gpx' || (/<gpx\b/i.test(text) && ext !== 'kml')) { r = parseGpx(text); format = 'GPX'; }
    else if (ext === 'kml' || /<kml\b/i.test(text)) { r = parseKml(text); format = 'KML'; }
    else { r = parseCsv(text, opts.csvTzMin || 0); format = 'CSV'; }
    r.points.sort(function (a, b) { return a.t - b.t; });
    // drop exact duplicate timestamps (logger repeats)
    var pts = r.points.filter(function (p, i, a) { return i === 0 || p.t !== a[i - 1].t; });
    return { points: pts, format: format, skipped: r.skipped, error: r.error || null };
  }

  // ------------------------------------------------------------ photo time

  function photoTime(exif, opts) {
    opts = opts || {};
    if (!exif) return null;
    var dt = exif.dateTimeOriginal || exif.dateTimeDigitized || exif.modifyDate;
    var local = wallClockMs(dt, exif.subSecTimeOriginal);
    if (local == null) return null;
    var exifTz = opts.useExifOffset ? parseTzString(exif.offsetTimeOriginal || exif.offsetTime) : null;
    var tz = exifTz != null ? exifTz : (opts.camTzMin || 0);
    return {
      utc: local - tz * 60000 + (opts.clockOffsetSec || 0) * 1000,
      local: local, usedExifOffset: exifTz != null
    };
  }

  /**
   * Camera clock error from a photo of the GPS screen.
   * gpsWallClock = the date-time shown on the GPS ("YYYY-MM-DD HH:MM:SS"),
   * gpsTzMin = the zone the GPS displays (0 if it shows UTC).
   */
  function clockOffsetFromReference(photoExif, gpsWallClock, gpsTzMin, opts) {
    var pt = photoTime(photoExif, { camTzMin: opts.camTzMin, useExifOffset: opts.useExifOffset });
    var g = wallClockMs(gpsWallClock);
    if (!pt || g == null) return NaN;
    return Math.round((g - (gpsTzMin || 0) * 60000 - pt.utc) / 1000);
  }

  // ------------------------------------------------------------ matching

  function locate(points, t, opts) {
    opts = opts || {};
    var maxGap = (opts.maxGapSec != null ? opts.maxGapSec : 60) * 1000;
    var edge = (opts.edgeTolSec != null ? opts.edgeTolSec : 30) * 1000;
    var n = points.length;
    if (!n) return { error: 'empty track' };
    if (t < points[0].t) {
      var d0 = points[0].t - t;
      return d0 <= edge ? { lat: points[0].lat, lon: points[0].lon, dt: d0 / 1000, gap: 0, interpolated: false }
        : { error: 'before the track', dt: d0 / 1000 };
    }
    if (t > points[n - 1].t) {
      var d1 = t - points[n - 1].t;
      return d1 <= edge ? { lat: points[n - 1].lat, lon: points[n - 1].lon, dt: d1 / 1000, gap: 0, interpolated: false }
        : { error: 'after the track', dt: d1 / 1000 };
    }
    var lo = 0, hi = n - 1;                // binary search: points[lo].t ≤ t ≤ points[hi].t
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (points[mid].t <= t) lo = mid; else hi = mid; }
    var a = points[lo], b = points[hi], gap = b.t - a.t;
    if (gap === 0 || t === a.t) return { lat: a.lat, lon: a.lon, dt: 0, gap: gap / 1000, interpolated: false };
    if (gap > maxGap) {
      // a hole in the log (GPS lost fix / switched off): only accept a fix
      // that is itself close enough in time
      var near = (t - a.t) <= (b.t - t) ? a : b, dn = Math.abs(near.t - t);
      return dn <= edge ? { lat: near.lat, lon: near.lon, dt: dn / 1000, gap: gap / 1000, interpolated: false }
        : { error: 'in a gap of the track (' + Math.round(gap / 1000) + ' s without fixes)', dt: dn / 1000 };
    }
    var f = (t - a.t) / gap;
    return {
      lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f,
      dt: Math.min(t - a.t, b.t - t) / 1000, gap: gap / 1000, interpolated: true
    };
  }

  // ------------------------------------------------------------ item position

  function position(it) {
    if (!it) return null;
    if (it.geo && Number.isFinite(it.geo.lat) && Number.isFinite(it.geo.lon)) {
      return { latitude: it.geo.lat, longitude: it.geo.lon, source: it.geo.source || 'map' };
    }
    var e = it.exif;
    if (e && Number.isFinite(e.latitude) && Number.isFinite(e.longitude)) {
      return { latitude: e.latitude, longitude: e.longitude, source: 'exif' };
    }
    return null;
  }

  function haversineM(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  return {
    TZ_LIST: TZ_LIST, fmtTz: fmtTz, parseTzString: parseTzString,
    parseOffset: parseOffset, fmtOffset: fmtOffset,
    wallClockMs: wallClockMs, parseTime: parseTime,
    parseTrack: parseTrack, photoTime: photoTime,
    clockOffsetFromReference: clockOffsetFromReference,
    locate: locate, position: position, haversineM: haversineM
  };
}));
