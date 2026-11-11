/**
 * metatab.js — "Metadata" tab: per-project presets, per-group field values,
 * and what the export needs (CoralNet CSV rows, file names, EXIF to embed).
 *
 * Photos are grouped by their source folder (Drive subfolder, zip folder or
 * a folder dropped from Finder/Explorer); every photo of a group gets the
 * group's values. Values can be pre-filled from the folder names (see
 * folderGuess) and are remembered in this browser for the next session.
 *
 * Presets describe the CSV the destination expects. The first one is the
 * MBON Pole to Pole intertidal / CoralNet layout:
 *   Name, Date, <5 Aux: country, state, locality, site, strata>, Height (cm),
 *   Latitude, Longitude, Depth, Camera, Photographer, Water quality, Strobes,
 *   Framing gear used, White balance card, Comments
 */
(function (root) {
  'use strict';

  var STRATA = ['HIGHTIDE', 'MIDTIDE', 'LOWTIDE'];
  var SEASONS = ['FRIO', 'CALIDO'];
  var REEF_AREAS = ['horizontal', 'vertical', 'overhang', 'cavefloor'];
  var YES_NO = ['no', 'yes'];

  // Localities already monitored: state + AMP code (Comments), from the
  // team's 2026 metadata.csv (6670 photos; one state/AMP per locality). New
  // ones are learned as they are typed in the Metadata tab (this browser).
  var KNOWN_LOCALITIES = {
    'CABO DOS BAHIAS': { state: 'CHUBUT', Comments: 'AMP5' },
    'ISLOTE LOBOS': { state: 'RIO NEGRO', Comments: 'AMP3' },
    'MAKENKE': { state: 'SANTA CRUZ', Comments: 'AMP8' },
    'MONTE LEON': { state: 'SANTA CRUZ', Comments: 'AMP8' },
    'PIMCPA': { state: 'CHUBUT', Comments: 'AMP5' },
    'PIMCPA_ISLA TOVA': { state: 'CHUBUT', Comments: 'AMP5' },
    'PLAYA LARGA': { state: 'TIERRA DEL FUEGO', Comments: 'AMP12' },
    'PNTDF': { state: 'TIERRA DEL FUEGO', Comments: 'AMP12' },
    'PUNTA BS AS': { state: 'CHUBUT', Comments: 'AMP22' },
    'PUNTA BUQUE': { state: 'CHUBUT', Comments: 'AMP7' },
    'PUNTA LOMA': { state: 'CHUBUT', Comments: 'AMP1' },
    'RESERVA COSTA ATLANTICA': { state: 'TIERRA DEL FUEGO', Comments: 'AMP11' }
  };
  var COUNTRIES = /^(ARGENTINA|CHILE|URUGUAY|BRASIL|BRAZIL|PERU|ECUADOR|COLOMBIA|VENEZUELA|PANAMA|COSTA RICA|MEXICO|USA|ESTADOS UNIDOS|UNITED STATES|CANADA|PORTUGAL|ESPANA|SPAIN|AZORES|ACORES)$/;

  var PRESETS = {
    intertidal: {
      label: 'Intertidal — MBON Pole to Pole (CoralNet)',
      csvName: 'metadata_coralnet.csv',
      columns: ['Name', 'Date', 'country', 'state', 'locality', 'site', 'strata', 'Height (cm)',
        'Latitude', 'Longitude', 'Depth', 'Camera', 'Photographer', 'Water quality', 'Strobes',
        'Framing gear used', 'White balance card', 'Comments'],
      // read from each photo
      auto: { Name: 'file name of the crop', Date: 'EXIF date', Latitude: 'EXIF GPS',
              Longitude: 'EXIF GPS', Camera: 'EXIF camera model' },
      // same for every photo of the project
      fixed: { 'Height (cm)': '42', Strobes: 'no', 'Framing gear used': '25x25cm' },
      // filled per group (folder); upper: stored upper-case like the P2P data
      fields: [
        { key: 'country', upper: true, required: true, remember: true },
        { key: 'state', upper: true, required: true },
        { key: 'locality', upper: true, required: true },
        { key: 'site', upper: true, required: true },
        { key: 'strata', options: STRATA, required: true },
        { key: 'Photographer', required: true },
        { key: 'Comments', hint: 'e.g. AMP12' },
        { key: 'Depth' },
        { key: 'Water quality' },
        { key: 'White balance card' },
        // not a CoralNet column: kept in each crop's EXIF and in manifest.csv
        { key: 'season', options: SEASONS, extra: true }
      ],
      guess: function (k) { return folderGuess(k); }
    },

    // MBON + AIR Centre workshop, Terceira (Azores). Same CoralNet layout
    // but the five Aux fields are Group, country, locality, site, strata
    // (no state); Photographer is the group; Comments names the workshop;
    // no framing gear recorded. From the workshop's metadata.csv (Oct 2026).
    azores: {
      label: 'Azores workshop (CoralNet)',
      csvName: 'metadata_coralnet.csv',
      columns: ['Name', 'Date', 'Group', 'country', 'locality', 'site', 'strata', 'Height (cm)',
        'Latitude', 'Longitude', 'Depth', 'Camera', 'Photographer', 'Water quality', 'Strobes',
        'Framing gear used', 'White balance card', 'Comments'],
      auto: { Name: 'file name of the crop', Date: 'EXIF date', Latitude: 'EXIF GPS',
              Longitude: 'EXIF GPS', Camera: 'EXIF camera model' },
      fixed: { 'Height (cm)': '42', Strobes: 'no' },
      fields: [
        { key: 'Group', required: true, hint: 'Group_1' },
        { key: 'country', upper: true, required: true, default: 'PORTUGAL' },
        { key: 'locality', upper: true, required: true, default: 'ILHA TERCEIRA' },
        { key: 'site', upper: true, required: true, hint: 'e.g. NEGRITO', remember: true },
        { key: 'strata', options: STRATA, required: true },
        { key: 'Photographer', copyFrom: 'Group', hint: 'empty = Group' },
        { key: 'Comments', default: 'Azores Workshop 2026' },
        { key: 'Framing gear used' },
        { key: 'Depth' },
        { key: 'Water quality' },
        { key: 'White balance card' }
      ],
      guess: function (k) { return azoresGuess(k); }
    },

    // MBON Pole to Pole subtidal photo-quadrats (rocky reefs, diver with
    // strobes). Columns exactly as the team's subtidal metadata.csv (Isla de
    // los Estados 2022): Aux fields region, site, reef name, reef area,
    // understory. Height (cm) is editable here (45 cm in that survey).
    subtidal: {
      label: 'Subtidal — MBON Pole to Pole (CoralNet)',
      csvName: 'metadata_coralnet.csv',
      columns: ['Name', 'Date', 'region', 'site', 'reef name', 'reef area', 'understory', 'Height (cm)',
        'Latitude', 'Longitude', 'Depth', 'Camera', 'Photographer', 'Water quality', 'Strobes',
        'Framing gear used', 'White balance card', 'Comments'],
      auto: { Name: 'file name of the crop', Date: 'EXIF date', Latitude: 'EXIF GPS',
              Longitude: 'EXIF GPS', Camera: 'EXIF camera model' },
      fixed: { 'Framing gear used': '25x25cm' },
      fields: [
        { key: 'region', required: true, remember: true, hint: 'e.g. Isla de los Estados' },
        { key: 'site', required: true, remember: true },
        { key: 'reef name', required: true, hint: 'e.g. Hoppner I' },
        { key: 'reef area', options: REEF_AREAS, required: true },
        { key: 'understory', options: YES_NO, default: 'no' },
        { key: 'Depth', hint: 'm, e.g. 6' },
        { key: 'Height (cm)', default: '45' },
        { key: 'Photographer', required: true, remember: true },
        { key: 'Water quality', default: 'good' },
        { key: 'Strobes', default: 'two' },
        { key: 'White balance card', default: 'no' },
        { key: 'Comments', remember: true, hint: 'e.g. Costa Patagonica' }
      ],
      guess: function (k) { return subtidalGuess(k); }
    }
  };

  var LS = 'quadrat.meta.v2';
  var st = {
    preset: 'intertidal',     // or 'none'
    nameFormat: 'dateprefix', // 'dateprefix' (YYYYMMDD_ + source) | 'source'
    groups: {},               // groupKey -> { field: value }
    last: {},                 // last value typed per field (country default)
    known: {}                 // locality -> { state, Comments, Photographer } learned here
  };
  var ui = {}, getItems = function () { return []; };

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(LS) || '{}');
      if (s.preset) st.preset = s.preset;
      if (s.nameFormat) st.nameFormat = s.nameFormat;
      st.last = s.last || {};
      st.known = s.known || {};
    } catch (e) { /* private mode */ }
  }
  function save() {
    try { localStorage.setItem(LS, JSON.stringify({ preset: st.preset, nameFormat: st.nameFormat, last: st.last, known: st.known })); } catch (e) { /* private mode */ }
  }

  function preset() { return PRESETS[st.preset] || null; }

  // ------------------------------------------------------------- groups

  /**
   * Group key of a photo: its source folder (Drive subfolder, zip folder,
   * picked/dropped folder). Photos loaded WITHOUT a folder (loose files, a
   * single Drive link) are each their own group, so the Metadata tab shows
   * one row per photo and each can get its own values. Key '§' + item id
   * (never a folder path); groupLabel() is what is shown / exported.
   */
  var SINGLE = '\u00a7';
  function groupOf(it) { return it.group || SINGLE + it.id; }
  function isSingle(key) { return String(key).charAt(0) === SINGLE; }
  function groupLabel(it) { return it.group || ''; }

  function groupList() {
    var map = {}, order = [];
    getItems().forEach(function (it) {
      var g = groupOf(it);
      if (!map[g]) { map[g] = { key: g, n: 0, nExport: 0, single: isSingle(g), name: it.name }; order.push(g); }
      map[g].n++;
    });
    return order.map(function (k) { return map[k]; });
  }

  function normStrata(v) {
    var s = String(v || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!s) return '';
    if (/HIGH|ALT[OA]|SUPERIOR|SUP/.test(s)) return 'HIGHTIDE';
    if (/MID|MEDI[OA]|MEIO/.test(s)) return 'MIDTIDE';
    if (/LOW|BAJ[OA]|INFERIOR|INF|BAIX/.test(s)) return 'LOWTIDE';
    return '';
  }

  function normKey(v) {
    return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  }
  function normSeason(v) {
    var s = normKey(v);
    if (/^(FRI[OA]|INVIERNO|OTONO|COLD|WINTER|AUTUMN|FALL)$/.test(s)) return 'FRIO';
    if (/^(CALID[OA]|VERANO|PRIMAVERA|WARM|SUMMER|SPRING)$/.test(s)) return 'CALIDO';
    return '';
  }

  /**
   * Read fields from the folder path. Layout used by the P2P team:
   *   COUNTRY / YEAR / SEASON / LOCALITY / SITE / STRATA / photo
   *   e.g. ARGENTINA/2026/FRIO/CABO DOS BAHIAS/ENTRE CALETAS/ALTO/AMP55261.JPG
   * Parsed from the deepest folder up, so it also works when the link points
   * lower in the tree (e.g. at a locality): strata (ALTO/MEDIO/BAJO,
   * HIGH/MID/LOW …), then site, then locality; a 4-digit year and a season
   * (FRIO/CALIDO …) are recognised above them, and the country is the folder
   * above the year (or any folder that is a known country name). state and
   * Comments (AMP code) come from the locality table. Only empty fields are
   * ever filled; everything stays editable.
   */
  function folderGuess(groupKey) {
    var parts = String(groupKey).split('/').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!parts.length || groupKey === 'Ungrouped' || isSingle(groupKey) || /^Load \d+$/.test(groupKey)) return {};
    var out = {}, i = parts.length - 1;
    var sv = normStrata(parts[i]);
    if (sv) { out.strata = sv; i--; }
    var named = [];
    for (var k = i; k >= 0; k--) {
      var seg = parts[k], key = normKey(seg);
      if (/^(19|20)\d{2}$/.test(key)) {             // year: the folder above is the country
        if (k > 0) out.country = normKey(parts[k - 1]);
        break;
      }
      if (normSeason(seg)) { out.season = out.season || normSeason(seg); continue; }
      if (COUNTRIES.test(key)) { out.country = key; break; }
      named.push(seg.toUpperCase());
    }
    if (named[0]) out.site = named[0];
    if (named[1]) out.locality = named[1];
    var lk = out.locality && normKey(out.locality);
    var loc = lk && Object.assign({}, KNOWN_LOCALITIES[lk] || {}, st.known[lk] || {});
    if (loc) Object.keys(loc).forEach(function (f) { if (loc[f] && !out[f]) out[f] = loc[f]; });
    return out;
  }

  function valuesFor(groupKey) {
    if (!st.groups[groupKey]) {
      var v = {}, p = preset();
      if (p) {
        var guess = p.guess ? p.guess(groupKey) : {};
        p.fields.forEach(function (f) {
          v[f.key] = guess[f.key] || f.default || (f.remember ? (st.last[f.key] || '') : '');
        });
      }
      st.groups[groupKey] = v;
    }
    return st.groups[groupKey];
  }

  /**
   * Azores workshop folders: one folder per group / transect ("Group_1",
   * "Grupo 2", "Transect_3"…) → Group = "Group_N"; a tide-level folder
   * anywhere in the path → strata. Everything else comes from the defaults.
   */
  function azoresGuess(groupKey) {
    if (isSingle(groupKey)) return {};
    var parts = String(groupKey).split('/').filter(Boolean), out = {};
    for (var i = parts.length - 1; i >= 0; i--) {
      var m = /(?:GROUP|GRUPO|GRUPPE|TRANSECT|TRANSECTA|TRANSECTO)[\s_-]*(\d+)/i.exec(parts[i]);
      if (m && !out.Group) out.Group = 'Group_' + (+m[1]);
      var sv = normStrata(parts[i]);
      if (sv && !out.strata && !m) out.strata = sv;
    }
    return out;
  }

  /**
   * Subtidal folders, read from the deepest folder up: a reef-area folder
   * (VERTICAL / HORIZONTAL / OVERHANG / CAVEFLOOR, PARED / PISO / ALERO /
   * CUEVA, WALL / FLOOR …) → reef area; the
   * folders above → reef name, site, region (year and season folders are
   * skipped). E.g. ISLA DE LOS ESTADOS/2022/HOPPNER/HOPPNER I/VERTICAL.
   */
  function normReefArea(v) {
    var s = normKey(v);
    if (/^(VERTICAL|VERT|PARED|WALL)$/.test(s)) return 'vertical';
    if (/^(HORIZONTAL|HORIZ|PISO|FLOOR|FONDO)$/.test(s)) return 'horizontal';
    if (/^(OVERHANG|ALERO|TECHO|CEILING|EXTRAPLOMO|EXTRAPLOMADO)$/.test(s)) return 'overhang';
    if (/^(CAVE ?FLOOR|CAVE_FLOOR|CUEVA|PISO (DE )?CUEVA|FONDO (DE )?CUEVA)$/.test(s)) return 'cavefloor';
    return '';
  }
  function subtidalGuess(groupKey) {
    var parts = String(groupKey).split('/').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!parts.length || groupKey === 'Ungrouped' || isSingle(groupKey) || /^Load \d+$/.test(groupKey)) return {};
    var out = {}, named = [];
    for (var i = parts.length - 1; i >= 0; i--) {
      var ra = normReefArea(parts[i]);
      if (ra) { if (!out['reef area']) out['reef area'] = ra; continue; }
      if (/^(19|20)\d{2}$/.test(normKey(parts[i])) || normSeason(parts[i])) continue;
      if (COUNTRIES.test(normKey(parts[i]))) break;
      named.push(parts[i]);
    }
    if (named[0]) out['reef name'] = named[0];
    if (named[1]) out.site = named[1];
    if (named[2]) out.region = named[2];
    return out;
  }

  /**
   * Metadata of one photo for display elsewhere (Map tab): the preset's
   * per-group fields that have a value, as [key, value] pairs.
   */
  function summaryFor(it) {
    var p = preset(); if (!p) return [];
    var g = valuesFor(groupOf(it));
    return p.fields.filter(function (f) { return !f.extra; })
      .map(function (f) { return [f.key, fieldValue(p, g, f.key)]; })
      .filter(function (x) { return x[1]; });
  }

  /** Field value for a group, falling back to another field (Photographer ← Group). */
  function fieldValue(p, g, key) {
    var f = p.fields.filter(function (x) { return x.key === key; })[0];
    return g[key] || (f && f.copyFrom ? (g[f.copyFrom] || '') : '');
  }

  /** Remember state / AMP / photographer per locality as the user types them. */
  function learn(groupKey) {
    var v = st.groups[groupKey];
    if (!v || !v.locality) return;
    var k = normKey(v.locality), rec = st.known[k] || {};
    ['state', 'Comments', 'Photographer'].forEach(function (f) { if (v[f]) rec[f] = v[f]; });
    st.known[k] = rec;
  }

  // ------------------------------------------------------------- export API

  function exifDate(it) {
    var d = it.exif && (it.exif.dateTimeOriginal || it.exif.modifyDate);
    if (d && /^\d{4}:\d{2}:\d{2}/.test(d)) return d;
    if (it.meta && it.meta.date) return it.meta.date.replace(/-/g, ':') + ' 00:00:00';
    return '';
  }

  /** Output file name (CoralNet "Name"): the source name as .jpg, optionally date-prefixed. */
  function nameFor(it) {
    var base = it.name.replace(/\.[^.]+$/, '');
    if (st.nameFormat === 'dateprefix' && !/^\d{8}[_-]/.test(base)) {
      var d = exifDate(it);
      if (d) base = d.slice(0, 10).replace(/:/g, '') + '_' + base;
    }
    return base + '.jpg';
  }

  function rowFor(it, name) {
    var p = preset(); if (!p) return null;
    var g = valuesFor(groupOf(it)), d = exifDate(it);
    // camera GPS, or a position set in the Map tab (geo.js decides)
    var pos = root.QDGeo ? root.QDGeo.position(it) : null;
    var vals = {
      Name: name,
      Date: d ? d.slice(0, 10).replace(/:/g, '-') : '',
      // 8 decimals ≈ 1 mm: drops float noise like -54.858760000000004
      Latitude: pos ? String(+pos.latitude.toFixed(8)) : '',
      Longitude: pos ? String(+pos.longitude.toFixed(8)) : '',
      Camera: (it.exif && it.exif.model) || ''
    };
    Object.keys(p.fixed).forEach(function (k) { vals[k] = p.fixed[k]; });
    p.fields.forEach(function (f) { vals[f.key] = fieldValue(p, g, f.key); });
    return p.columns.map(function (c) { return vals[c] != null ? vals[c] : ''; });
  }

  /** EXIF block for one crop: camera date/GPS/model + this group's fields. */
  function exifFor(it) {
    var p = preset(), g = p ? valuesFor(groupOf(it)) : {};
    var pos = root.QDGeo ? root.QDGeo.position(it) : null;
    var desc = [];
    if (p) {
      p.fields.forEach(function (f) { var v = fieldValue(p, g, f.key); if (v) desc.push(f.key + '=' + v); });
      Object.keys(p.fixed).forEach(function (k) { desc.push(k + '=' + p.fixed[k]); });
    }
    return {
      make: it.exif && it.exif.make, model: it.exif && it.exif.model,
      dateTimeOriginal: exifDate(it),
      latitude: pos ? pos.latitude : null, longitude: pos ? pos.longitude : null,
      artist: (p && fieldValue(p, g, 'Photographer')) || '', description: desc.join('; ')
    };
  }

  /** Groups (among the exported photos) with required fields still empty. */
  function missing(items) {
    var p = preset(); if (!p) return [];
    var seen = {}, out = [];
    items.forEach(function (it) {
      var k = groupOf(it); if (seen[k]) return; seen[k] = true;
      var v = valuesFor(k);
      var miss = p.fields.filter(function (f) { return f.required && !fieldValue(p, v, f.key); }).map(function (f) { return f.key; });
      if (miss.length) out.push((isSingle(k) ? it.name : k) + ': ' + miss.join(', '));
    });
    return out;
  }

  function exportInfo() {
    var p = preset();
    if (!p) return null;
    return { csvName: p.csvName, columns: p.columns, nameFor: nameFor, rowFor: rowFor, exifFor: exifFor, missing: missing };
  }

  // ------------------------------------------------------------- UI

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function render() {
    if (!ui.panel) return;
    var p = preset(), groups = groupList();
    ui.presetSel.value = st.preset;
    ui.nameSel.value = st.nameFormat;
    if (!p) { ui.body.innerHTML = '<p class="muted">No metadata file will be added to the ZIP.</p>'; return; }
    var html = '<div class="meta-fixed">'
      + '<span class="muted">From each photo:</span> ' + Object.keys(p.auto).map(function (k) { return '<code>' + esc(k) + '</code>'; }).join(' ')
      + ' &nbsp; <span class="muted">Same for all:</span> ' + Object.keys(p.fixed).map(function (k) { return '<code>' + esc(k) + ' = ' + esc(p.fixed[k]) + '</code>'; }).join(' ')
      + '</div>';
    if (!groups.length) {
      ui.body.innerHTML = html + '<p class="muted">Load photos first: each source folder becomes a group here.</p>';
      return;
    }
    var nSingle = groups.filter(function (g) { return g.single; }).length;
    if (nSingle) {
      html += '<p class="muted small">' + nSingle + ' photo' + (nSingle > 1 ? 's were' : ' was')
        + ' loaded without a folder: one row per photo (📷). Use ⇣ to copy the first row\'s value down a column.</p>';
    }
    html += '<div class="meta-scroll"><table class="meta-table"><thead><tr><th>Folder / group</th><th>#</th>';
    p.fields.forEach(function (f) {
      html += '<th>' + esc(f.key) + (f.required ? ' <span class="req">*</span>' : '')
        + (groups.length > 1 ? '<button type="button" class="filldown" data-k="' + esc(f.key) + '" title="Copy the first group\'s value to every empty cell in this column">⇣</button>' : '')
        + '</th>';
    });
    html += '</tr></thead><tbody>';
    groups.forEach(function (g) {
      var v = valuesFor(g.key);
      // the deepest folders are what tells groups apart: show the path's tail
      var parts = g.key.split('/'), shown = parts.length > 3 ? '…/' + parts.slice(-3).join('/') : g.key;
      if (g.single) shown = '📷 ' + g.name;       // photo loaded without a folder: its own row
      html += '<tr><td class="gname" title="' + esc(g.single ? g.name + ' (no folder: one row per photo)' : g.key) + '">'
        + esc(shown) + '</td><td>' + g.n + '</td>';
      p.fields.forEach(function (f) {
        var val = v[f.key] || '', cls = (f.required && !val) ? ' class="missing"' : '';
        if (f.options) {
          html += '<td><select data-g="' + esc(g.key) + '" data-k="' + esc(f.key) + '"' + cls + '><option value=""></option>'
            + f.options.map(function (o) { return '<option' + (o === val ? ' selected' : '') + '>' + o + '</option>'; }).join('')
            + '</select></td>';
        } else {
          html += '<td><input type="text" data-g="' + esc(g.key) + '" data-k="' + esc(f.key) + '" value="' + esc(val) + '"'
            + (f.hint ? ' placeholder="' + esc(f.hint) + '"' : '') + cls + '></td>';
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table></div><p class="muted small"><span class="req">*</span> required for CoralNet. '
      + 'The ZIP gets <code>' + esc(p.csvName) + '</code> (upload it to CoralNet with the crops) and every crop carries '
      + 'these values plus date, GPS and camera in its EXIF.</p>';
    ui.body.innerHTML = html;
  }

  function onInput(e) {
    var t = e.target, g = t.getAttribute('data-g'), k = t.getAttribute('data-k');
    if (!g || !k) return;
    var f = preset().fields.filter(function (x) { return x.key === k; })[0];
    var v = t.value;
    if (f && f.upper) { v = v.toUpperCase(); if (t.value !== v) { var pos = t.selectionStart; t.value = v; try { t.setSelectionRange(pos, pos); } catch (er) { /* select */ } } }
    valuesFor(g)[k] = v.trim();
    st.last[k] = v.trim();
    learn(g);
    save();
    t.classList.toggle('missing', !!(f && f.required && !v.trim()));
    if (ui.onChange) ui.onChange();
  }

  function fillDown(k) {
    var groups = groupList(); if (!groups.length) return;
    var first = valuesFor(groups[0].key)[k];
    if (!first) return;
    groups.forEach(function (g) { var v = valuesFor(g.key); if (!v[k]) v[k] = first; });
    render();
  }

  function init(opts) {
    load();
    getItems = opts.getItems;
    ui.onChange = opts.onChange;
    ui.panel = document.getElementById('metaPanel');
    ui.body = document.getElementById('metaBody');
    ui.presetSel = document.getElementById('metaPreset');
    ui.nameSel = document.getElementById('metaNameFormat');
    ui.presetSel.innerHTML = Object.keys(PRESETS).map(function (k) { return '<option value="' + k + '">' + esc(PRESETS[k].label) + '</option>'; }).join('')
      + '<option value="none">None — no metadata file</option>';
    ui.presetSel.addEventListener('change', function () { st.preset = ui.presetSel.value; st.groups = {}; save(); render(); });
    ui.nameSel.addEventListener('change', function () { st.nameFormat = ui.nameSel.value; save(); });
    ui.body.addEventListener('input', onInput);
    ui.body.addEventListener('change', onInput);
    ui.body.addEventListener('click', function (e) {
      var k = e.target.getAttribute && e.target.getAttribute('data-k');
      if (k && e.target.classList.contains('filldown')) fillDown(k);
    });
    render();
  }

  root.QDMetaTab = {
    init: init, render: render, exportInfo: exportInfo, groupOf: groupOf, groupLabel: groupLabel, summaryFor: summaryFor,
    _subtidalGuess: subtidalGuess,
    _folderGuess: folderGuess, _azoresGuess: azoresGuess, _normStrata: normStrata, PRESETS: PRESETS
  };
})(typeof self !== 'undefined' ? self : this);
