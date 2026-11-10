/**
 * maptab.js — "Map" tab: where the photos were taken, and adding a position
 * to the ones that have none.
 *
 * Window global: QDMapTab  { init(opts), show(), refresh() }
 *   opts.getItems()  -> state.items (shared with app.js)
 *   opts.onChange()  -> called after positions change
 *
 * Positions live on the item: it.exif.latitude/longitude (from the camera)
 * and it.geo = { lat, lon, source: 'map' | 'track', dt?, gap? } assigned here.
 * QDGeo.position(it) decides which one is used (it.geo wins); the CoralNet
 * CSV, the EXIF written into the crops and manifest.csv all read it.
 *
 * Basemaps (Leaflet, loaded on first use from vendor/):
 *   - Sentinel-2 cloudless (EOX): satellite, 10 m, no key. Free for
 *     non-commercial use with attribution (CC BY-NC-SA 4.0).
 *   - Esri World Imagery: satellite, sub-metre in many coasts; needs a free
 *     ArcGIS Location Platform API key (⚙ Settings). Shown only with a key.
 *   - OpenStreetMap: streets / place names (ODbL, attribution).
 */
(function (root) {
  'use strict';

  var LEAFLET = 'vendor/leaflet-1.9.4/';
  var COLORS = { exif: '#2e9e5b', track: '#1f8fd6', map: '#e8891a', preview: '#ffffff' };
  var LABELS = { exif: 'camera GPS (EXIF)', track: 'GPS track', map: 'placed on the map' };

  var getItems = function () { return []; }, onChange = function () {};
  var map = null, L = null, layers = {}, layerControl = null, markerLayer = null, previewLayer = null, trackLayer = null;
  var st = {
    selected: {},      // item id -> true (photos to place with the next map click)
    moveId: null,      // item id being moved by the next map click
    track: null,       // { points, format, name, skipped }
    preview: null,     // [{ it, res, t }]
    fitted: false,
    groupFilter: ''
  };
  var cfg = loadCfg();
  var refreshTimer = null;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------ settings

  function loadCfg() {
    var d = {
      camTz: -new Date().getTimezoneOffset(), useExifOffset: true, csvTz: 0,
      offset: '', maxGap: 60, edgeTol: 30, overwrite: false, base: 's2'
    };
    try { var s = JSON.parse(localStorage.getItem('quadrat.gpsMerge') || '{}'); Object.keys(s).forEach(function (k) { d[k] = s[k]; }); } catch (e) { /* private mode */ }
    return d;
  }
  function saveCfg() { try { localStorage.setItem('quadrat.gpsMerge', JSON.stringify(cfg)); } catch (e) { /* private mode */ } }
  function arcgisKey() { try { return localStorage.getItem('quadrat.arcgisKey') || ''; } catch (e) { return ''; } }

  // ------------------------------------------------------------ Leaflet

  var leafletPromise = null;
  function loadLeaflet() {
    if (root.L) return Promise.resolve(root.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = LEAFLET + 'leaflet.js';
      s.onload = function () { resolve(root.L); };
      s.onerror = function () { leafletPromise = null; reject(new Error('could not load the map library')); };
      document.head.appendChild(s);
    });
    return leafletPromise;
  }

  function makeBaseLayers() {
    var out = {};
    // EOX publishes one mosaic per year; fall back to 2020 if the newest
    // layer name is not served (tile errors before any tile loads).
    var s2url = function (y) { return 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-' + y + '_3857/default/g/{z}/{y}/{x}.jpg'; };
    var s2 = L.tileLayer(s2url(2024), {
      maxNativeZoom: 14, maxZoom: 19,
      attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by '
        + '<a href="https://eox.at" target="_blank" rel="noopener">EOX IT Services GmbH</a> '
        + '(Contains modified Copernicus Sentinel data 2024) — CC BY-NC-SA 4.0'
    });
    var loaded = false, errors = 0;
    s2.on('tileload', function () { loaded = true; });
    s2.on('tileerror', function () {
      if (!loaded && ++errors === 6) s2.setUrl(s2url(2020));
    });
    out['Satellite — Sentinel-2 cloudless (10 m, EOX)'] = s2;
    var key = arcgisKey();
    if (key) {
      out['Satellite — Esri World Imagery (high resolution)'] = L.tileLayer(
        'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=' + encodeURIComponent(key), {
          maxNativeZoom: 19, maxZoom: 20,
          attribution: 'Powered by <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> | '
            + 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
        });
    }
    out['Map — OpenStreetMap'] = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    });
    return out;
  }

  function ensureMap() {
    if (map) return Promise.resolve(map);
    return loadLeaflet().then(function (lib) {
      L = lib;
      map = L.map('mapView', { preferCanvas: true, worldCopyJump: true }).setView([-42, -64], 4);
      layers = makeBaseLayers();
      var names = Object.keys(layers);
      var pick = names.filter(function (n) { return n.indexOf(cfg.base === 'esri' ? 'Esri' : cfg.base === 'osm' ? 'OpenStreetMap' : 'Sentinel') >= 0; })[0] || names[0];
      layers[pick].addTo(map);
      layerControl = L.control.layers(layers, null, { collapsed: true }).addTo(map);
      L.control.scale({ imperial: false }).addTo(map);
      map.on('baselayerchange', function (e) {
        cfg.base = /Esri/.test(e.name) ? 'esri' : /OpenStreetMap/.test(e.name) ? 'osm' : 's2';
        saveCfg();
      });
      trackLayer = L.layerGroup().addTo(map);
      previewLayer = L.layerGroup().addTo(map);
      markerLayer = L.layerGroup().addTo(map);
      map.on('click', onMapClick);
      return map;
    });
  }

  /** Rebuild the basemap list (after the ArcGIS key changes in ⚙). */
  function resetBaseLayers() {
    if (!map) return;
    Object.keys(layers).forEach(function (k) { map.removeLayer(layers[k]); });
    if (layerControl) map.removeControl(layerControl);
    layers = makeBaseLayers();
    var names = Object.keys(layers);
    var pick = names.filter(function (n) { return /Esri/.test(n); })[0] || names[0];
    layers[pick].addTo(map);
    layerControl = L.control.layers(layers, null, { collapsed: true }).addTo(map);
  }

  // ------------------------------------------------------------ data helpers

  function processed(it) { return it.status !== 'queued' && it.status !== 'processing'; }
  function active() { return getItems().filter(function (it) { return !it.excluded; }); }
  function groupOf(it) { return root.QDMetaTab && root.QDMetaTab.groupOf ? root.QDMetaTab.groupOf(it) : (it.group || ''); }
  function byId(id) { return getItems().filter(function (it) { return it.id === id; })[0]; }
  function timeOpts() {
    return {
      camTzMin: +cfg.camTz, useExifOffset: !!cfg.useExifOffset,
      clockOffsetSec: QDGeo.parseOffset(cfg.offset) || 0
    };
  }
  function fmtLocal(ms) { return ms == null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }

  // ------------------------------------------------------------ rendering

  function show() {
    renderSide();
    return ensureMap().then(function () {
      map.invalidateSize();
      drawMarkers();
      if (!st.fitted) { st.fitted = fitToPhotos(); }
    }).catch(function (e) {
      el('mapView').innerHTML = '<p class="map-error">' + esc(e.message || e) + '</p>';
    });
  }

  /** Called by app.js whenever the grid re-renders (cheap, debounced). */
  function refresh() {
    if (!el('mapPanel') || el('mapPanel').hidden) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { renderSide(); if (map) drawMarkers(); }, 300);
  }

  function fitToPhotos() {
    var pts = [];
    active().forEach(function (it) { var p = QDGeo.position(it); if (p) pts.push([p.latitude, p.longitude]); });
    if (st.track) st.track.points.forEach(function (p, i) { if (i % 20 === 0) pts.push([p.lat, p.lon]); });
    if (!pts.length) return false;
    map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 17 });
    return true;
  }

  function drawMarkers() {
    markerLayer.clearLayers();
    active().forEach(function (it) {
      var p = QDGeo.position(it);
      if (!p) return;
      var m = L.circleMarker([p.latitude, p.longitude], {
        radius: 7, weight: st.moveId === it.id ? 4 : 2, color: '#fff',
        fillColor: COLORS[p.source] || COLORS.map, fillOpacity: 0.95
      });
      m.bindPopup(function () { return popupFor(it); }, { minWidth: 220 });
      m.addTo(markerLayer);
    });
    previewLayer.clearLayers();
    if (st.preview) {
      st.preview.forEach(function (r) {
        if (!r.res || r.res.error) return;
        L.circleMarker([r.res.lat, r.res.lon], {
          radius: 6, weight: 2, color: COLORS.track, dashArray: '3,3', fillColor: COLORS.preview, fillOpacity: 0.6
        }).bindTooltip(esc(r.it.name) + ' · ±' + r.res.dt.toFixed(0) + ' s').addTo(previewLayer);
      });
    }
    trackLayer.clearLayers();
    if (st.track && st.track.points.length) {
      L.polyline(st.track.points.map(function (p) { return [p.lat, p.lon]; }), {
        color: '#ffe14d', weight: 2, opacity: 0.9, interactive: false
      }).addTo(trackLayer);
    }
    el('mapView').classList.toggle('placing', !!st.moveId || Object.keys(st.selected).length > 0);
  }

  function popupFor(it) {
    var p = QDGeo.position(it), t = QDGeo.photoTime(it.exif, timeOpts());
    var d = document.createElement('div');
    d.className = 'map-pop';
    d.innerHTML = (it.thumbURL ? '<img src="' + esc(it.thumbURL) + '" alt="">' : '')
      + '<b>' + esc(it.name) + '</b><br>'
      + '<span class="muted">' + esc(groupOf(it)) + '</span><br>'
      + (it.exif && it.exif.dateTimeOriginal ? 'Camera time: ' + esc(it.exif.dateTimeOriginal) + '<br>' : '')
      + (t ? 'UTC (with the settings below): ' + fmtLocal(t.utc) + '<br>' : '')
      + 'Position: ' + p.latitude.toFixed(6) + ', ' + p.longitude.toFixed(6) + '<br>'
      + 'Source: ' + LABELS[p.source]
      + (p.source === 'track' && it.geo ? ' (nearest fix ' + it.geo.dt.toFixed(0) + ' s)' : '');
    var row = document.createElement('div');
    row.className = 'map-pop-actions';
    var mv = document.createElement('button');
    mv.type = 'button'; mv.textContent = 'Move…';
    mv.title = 'Then click the new position on the map';
    mv.onclick = function () { st.moveId = it.id; st.selected = {}; map.closePopup(); drawMarkers(); renderSide(); };
    row.appendChild(mv);
    if (it.geo) {
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = it.exif && it.exif.latitude != null ? 'Back to camera GPS' : 'Remove position';
      rm.onclick = function () { it.geo = null; map.closePopup(); changed(); };
      row.appendChild(rm);
    }
    d.appendChild(row);
    return d;
  }

  function onMapClick(e) {
    var ll = e.latlng.wrap();
    if (st.moveId) {
      var it = byId(st.moveId);
      if (it) it.geo = { lat: ll.lat, lon: ll.lng, source: 'map' };
      st.moveId = null;
      changed();
      return;
    }
    var ids = Object.keys(st.selected);
    if (!ids.length) return;
    ids.forEach(function (id) {
      var x = byId(id);
      if (x) x.geo = { lat: ll.lat, lon: ll.lng, source: 'map' };
    });
    st.selected = {};
    changed();
  }

  function changed() {
    renderSide();
    if (map) drawMarkers();
    onChange();
  }

  // ------------------------------------------------------------ side panel

  function renderSide() {
    var items = active();
    var n = { exif: 0, track: 0, map: 0 }, without = [], pending = 0;
    items.forEach(function (it) {
      var p = QDGeo.position(it);
      if (p) n[p.source]++;
      else if (!processed(it)) pending++;
      else without.push(it);
    });
    var withPos = n.exif + n.track + n.map;
    el('mapStats').innerHTML = '<b>' + withPos + '</b> with a position'
      + (withPos ? ' <span class="muted">(camera ' + n.exif + ' · track ' + n.track + ' · map ' + n.map + ')</span>' : '')
      + ' · <b>' + without.length + '</b> without'
      + (pending ? ' · <span class="muted">' + pending + ' still processing</span>' : '');

    // groups for the filter
    var groups = {};
    without.forEach(function (it) { groups[groupOf(it)] = (groups[groupOf(it)] || 0) + 1; });
    var gsel = el('mapGroupFilter');
    var gk = Object.keys(groups).sort();
    if (gk.indexOf(st.groupFilter) < 0) st.groupFilter = '';
    gsel.innerHTML = '<option value="">all folders (' + without.length + ')</option>'
      + gk.map(function (g) { return '<option value="' + esc(g) + '"' + (g === st.groupFilter ? ' selected' : '') + '>' + esc(g || '(no folder)') + ' (' + groups[g] + ')</option>'; }).join('');
    gsel.parentNode.hidden = gk.length < 2;

    var shown = without.filter(function (it) { return !st.groupFilter || groupOf(it) === st.groupFilter; });
    // drop selections that no longer apply
    Object.keys(st.selected).forEach(function (id) {
      if (!without.some(function (it) { return it.id === id; })) delete st.selected[id];
    });
    var list = el('mapNoGps');
    list.innerHTML = shown.length ? shown.slice(0, 500).map(function (it) {
      return '<label class="map-item"><input type="checkbox" data-id="' + it.id + '"' + (st.selected[it.id] ? ' checked' : '') + '>'
        + (it.thumbURL ? '<img src="' + esc(it.thumbURL) + '" alt="" loading="lazy">' : '<span class="noimg"></span>')
        + '<span>' + esc(it.name) + '<br><span class="muted">' + esc(it.exif && it.exif.dateTimeOriginal || 'no camera time') + '</span></span></label>';
    }).join('') + (shown.length > 500 ? '<p class="muted">… and ' + (shown.length - 500) + ' more (use “Select all”).</p>' : '')
      : '<p class="muted">' + (items.length ? 'Every photo has a position.' : 'Add photos first.') + '</p>';
    list.dataset.ids = shown.map(function (it) { return it.id; }).join(',');

    var nsel = Object.keys(st.selected).length;
    el('mapPlaceHint').innerHTML = st.moveId
      ? '<b>Click the new position</b> of ' + esc((byId(st.moveId) || {}).name || '') + ' on the map. <button type="button" class="linklike" id="mapCancelMove">cancel</button>'
      : nsel ? '<b>Click on the map</b> to place the ' + nsel + ' selected photo' + (nsel > 1 ? 's' : '') + '.'
      : 'Tick photos, then click their position on the map. A marker can be moved later from its popup.';
    var cm = el('mapCancelMove');
    if (cm) cm.onclick = function () { st.moveId = null; changed(); };
    if (map) el('mapView').classList.toggle('placing', !!st.moveId || nsel > 0);

    renderRefOptions();
  }

  function renderRefOptions() {
    var sel = el('gpsRefPhoto'), cur = sel.value;
    var withTime = active().filter(function (it) { return it.exif && (it.exif.dateTimeOriginal || it.exif.modifyDate); });
    var html = '<option value="">— choose the photo of the GPS screen —</option>' + withTime.map(function (it) {
      return '<option value="' + it.id + '"' + (it.id === cur ? ' selected' : '') + '>' + esc(it.name) + ' — ' + esc(it.exif.dateTimeOriginal || it.exif.modifyDate) + '</option>';
    }).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
  }

  // ------------------------------------------------------------ track merge

  function loadTrackFile(file) {
    var r = new FileReader();
    r.onload = function () {
      var tr = QDGeo.parseTrack(String(r.result), file.name, { csvTzMin: +cfg.csvTz });
      tr.name = file.name;
      st.track = tr; st.preview = null;
      var info = el('gpsTrackInfo');
      if (!tr.points.length) {
        info.innerHTML = '<span class="err">No time-stamped positions found in ' + esc(file.name)
          + (tr.error ? ': ' + esc(tr.error) : '') + '.</span>';
      } else {
        var a = tr.points[0].t, b = tr.points[tr.points.length - 1].t;
        info.innerHTML = '<b>' + esc(file.name) + '</b> (' + tr.format + '): ' + tr.points.length + ' fixes, '
          + fmtLocal(a) + ' → ' + fmtLocal(b) + ' UTC'
          + (tr.skipped ? ' <span class="muted">(' + tr.skipped + ' points without time or position skipped)</span>' : '');
      }
      el('gpsCsvTzRow').hidden = tr.format !== 'CSV';
      el('btnGpsPreview').disabled = el('btnGpsApply').disabled = !tr.points.length;
      el('gpsResult').innerHTML = '';
      if (map) { drawMarkers(); if (tr.points.length) fitToPhotos(); }
    };
    r.readAsText(file);
  }

  function candidates() {
    return active().filter(function (it) {
      if (!processed(it)) return false;
      var p = QDGeo.position(it);
      if (!p) return true;
      if (!cfg.overwrite) return false;
      return p.source !== 'map';        // never overwrite a hand-placed position
    });
  }

  function runPreview() {
    if (!st.track || !st.track.points.length) return null;
    var o = timeOpts();
    if (isNaN(o.clockOffsetSec)) { alert('Camera clock offset: use ±hh:mm:ss, e.g. -00:01:30'); return null; }
    var opts = { maxGapSec: +cfg.maxGap, edgeTolSec: +cfg.edgeTol };
    st.preview = candidates().map(function (it) {
      var t = QDGeo.photoTime(it.exif, o);
      return { it: it, t: t, res: t ? QDGeo.locate(st.track.points, t.utc, opts) : { error: 'no date/time in the photo' } };
    });
    var ok = st.preview.filter(function (r) { return !r.res.error; });
    var reasons = {};
    st.preview.forEach(function (r) {
      if (!r.res.error) return;
      var k = r.res.error.replace(/\(.*\)/, '').trim();
      reasons[k] = (reasons[k] || 0) + 1;
    });
    var first = st.preview.filter(function (r) { return r.res.error && r.t; })[0];
    var html = '<b>' + ok.length + '</b> of ' + st.preview.length + ' photos fall on the track';
    if (ok.length) {
      var worst = Math.max.apply(null, ok.map(function (r) { return r.res.dt; }));
      html += ' <span class="muted">(farthest from a fix: ' + worst.toFixed(0) + ' s)</span>';
    }
    Object.keys(reasons).forEach(function (k) { html += '<br>' + reasons[k] + ' ' + esc(k); });
    if (first && !ok.length) {
      html += '<br><span class="err">None matched. Check the camera time zone and clock offset: e.g. '
        + esc(first.it.name) + ' is ' + fmtLocal(first.t.utc) + ' UTC, the track is '
        + fmtLocal(st.track.points[0].t) + ' → ' + fmtLocal(st.track.points[st.track.points.length - 1].t) + ' UTC.</span>';
    }
    if (!st.preview.length) html = 'No photos to geotag (all have a position' + (cfg.overwrite ? '' : '; tick “overwrite” to replace camera GPS') + ').';
    el('gpsResult').innerHTML = html;
    if (map) { drawMarkers(); if (ok.length) fitToPhotos(); }
    return st.preview;
  }

  function apply() {
    var pv = runPreview();
    if (!pv) return;
    var n = 0;
    pv.forEach(function (r) {
      if (r.res.error) return;
      r.it.geo = { lat: r.res.lat, lon: r.res.lon, source: 'track', dt: r.res.dt, gap: r.res.gap, track: st.track.name };
      n++;
    });
    st.preview = null;
    changed();
    el('gpsResult').innerHTML = '<b>' + n + '</b> photo' + (n === 1 ? '' : 's') + ' geotagged from ' + esc(st.track.name) + '.';
  }

  function computeReferenceOffset() {
    var it = byId(el('gpsRefPhoto').value);
    var v = el('gpsRefTime').value;      // datetime-local: "YYYY-MM-DDTHH:MM[:SS]"
    if (!it || !v) { alert('Choose the photo of the GPS screen and type the date and time it shows.'); return; }
    var off = QDGeo.clockOffsetFromReference(it.exif, v.replace('T', ' '), +el('gpsRefTz').value,
      { camTzMin: +cfg.camTz, useExifOffset: !!cfg.useExifOffset });
    if (isNaN(off)) { alert('Could not read the time of that photo.'); return; }
    cfg.offset = QDGeo.fmtOffset(off); saveCfg();
    el('gpsOffset').value = cfg.offset;
    el('gpsRefResult').textContent = off === 0 ? 'Camera clock matches the GPS.'
      : 'Camera clock is ' + QDGeo.fmtOffset(Math.abs(off)).slice(1) + (off > 0 ? ' behind' : ' ahead of') + ' the GPS'
        + (off > 0 ? ' (slow)' : '') + '; this offset is added to every photo time.';
  }

  // ------------------------------------------------------------ init

  function tzOptions(selected) {
    return QDGeo.TZ_LIST.map(function (m) {
      return '<option value="' + m + '"' + (m === +selected ? ' selected' : '') + '>' + QDGeo.fmtTz(m) + '</option>';
    }).join('');
  }

  function init(opts) {
    getItems = opts.getItems;
    onChange = opts.onChange || onChange;
    if (QDGeo.TZ_LIST.indexOf(+cfg.camTz) < 0) cfg.camTz = 0;

    el('gpsCamTz').innerHTML = tzOptions(cfg.camTz);
    el('gpsRefTz').innerHTML = tzOptions(cfg.camTz);
    el('gpsCsvTz').innerHTML = tzOptions(cfg.csvTz);
    el('gpsUseExifTz').checked = !!cfg.useExifOffset;
    el('gpsOffset').value = cfg.offset;
    el('gpsMaxGap').value = cfg.maxGap;
    el('gpsEdgeTol').value = cfg.edgeTol;
    el('gpsOverwrite').checked = !!cfg.overwrite;

    function bind(id, key, conv) {
      el(id).addEventListener('change', function () {
        cfg[key] = conv(el(id));
        saveCfg();
        if (st.preview) runPreview();
      });
    }
    bind('gpsCamTz', 'camTz', function (x) { return +x.value; });
    bind('gpsCsvTz', 'csvTz', function (x) { return +x.value; });
    bind('gpsUseExifTz', 'useExifOffset', function (x) { return x.checked; });
    bind('gpsOffset', 'offset', function (x) { return x.value.trim(); });
    bind('gpsMaxGap', 'maxGap', function (x) { return Math.max(1, +x.value || 60); });
    bind('gpsEdgeTol', 'edgeTol', function (x) { return Math.max(0, +x.value || 0); });
    bind('gpsOverwrite', 'overwrite', function (x) { return x.checked; });
    el('gpsCsvTz').addEventListener('change', function () {
      var f = el('gpsTrackFile').files[0]; if (f) loadTrackFile(f);
    });

    el('gpsTrackFile').addEventListener('change', function () {
      var f = el('gpsTrackFile').files[0]; if (f) loadTrackFile(f);
    });
    el('btnGpsPreview').addEventListener('click', runPreview);
    el('btnGpsApply').addEventListener('click', apply);
    el('btnGpsRefCompute').addEventListener('click', computeReferenceOffset);
    el('gpsRefPhoto').addEventListener('change', function () {
      var it = byId(el('gpsRefPhoto').value);
      var w = it && QDGeo.wallClockMs(it.exif.dateTimeOriginal || it.exif.modifyDate);
      if (w != null && !el('gpsRefTime').value) el('gpsRefTime').value = new Date(w).toISOString().slice(0, 19);
    });

    el('mapNoGps').addEventListener('change', function (e) {
      var id = e.target && e.target.getAttribute('data-id');
      if (!id) return;
      if (e.target.checked) st.selected[id] = true; else delete st.selected[id];
      st.moveId = null;
      renderSide();
    });
    el('btnMapSelectAll').addEventListener('click', function () {
      (el('mapNoGps').dataset.ids || '').split(',').filter(Boolean).forEach(function (id) { st.selected[id] = true; });
      st.moveId = null; renderSide();
    });
    el('btnMapSelectNone').addEventListener('click', function () { st.selected = {}; renderSide(); });
    el('mapGroupFilter').addEventListener('change', function () { st.groupFilter = el('mapGroupFilter').value; renderSide(); });
    el('btnMapFit').addEventListener('click', function () { if (map) fitToPhotos(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && (st.moveId || Object.keys(st.selected).length) && !el('mapPanel').hidden) {
        st.moveId = null; st.selected = {}; changed();
      }
    });
  }

  root.QDMapTab = { init: init, show: show, refresh: refresh, resetBaseLayers: resetBaseLayers };
}(typeof self !== 'undefined' ? self : this));
