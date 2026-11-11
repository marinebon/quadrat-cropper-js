/**
 * app.js — main orchestration: ingest (files / Drive), detection queue,
 * grid, review triggers, export.
 */
(function (root) {
  'use strict';

  var QD = root.QuadratDetect;
  var state = {
    items: [],            // records: {id,name,blob,driveId,status,ok,conf,det,cornners…}
    csvs: [],             // parsed CSV tables joined into metadata
    busy: false
  };
  var ui = {};
  var MAX_DETECT_MP = 24;   // safety cap for absurd sources (~96MB RGBA)

  function el(id) { return document.getElementById(id); }

  function init() {
    ui = {
      addFiles: el('btnAddFiles'), fileInput: el('fileInput'),
      addDrive: el('btnAddDrive'), folderLink: el('folderLink'),
      btnFolderLink: el('btnFolderLink'), settings: el('btnSettings'),
      exportBtn: el('btnExport'), clear: el('btnClear'),
      grid: el('grid'), drop: el('dropzone'),
      progressWrap: el('progressWrap'), progressFill: el('progressFill'),
      progressText: el('progressText'), stats: el('stats'),
      settingsDialog: el('settingsDialog'), clientIdInput: el('clientIdInput'),
      saveSettings: el('btnSaveSettings'),
      // onboarding / zero-setup paths
      help: el('btnHelp'), dropHelp: el('btnDropHelp'),
      welcomeDialog: el('welcomeDialog'), welcomeOk: el('btnWelcomeOk'),
      helpDialog: el('helpDialog'), helpClose: el('btnHelpClose'),
      folderDialog: el('folderDialog'),
      folderZip: el('btnFolderZip'), folderSignin: el('btnFolderSignin'),
      copyOrigin: el('btnCopyOrigin'),
      verTag: el('verTag'), footVer: el('footVer')
    };

    // Version shown in title/tab + header so testers can confirm they run
    // a fresh build (detects stale-cache reports like 2026-10-21 MEDIO.zip).
    var VER = QD.VERSION || '?';
    document.title = 'Quadrat Cropper v' + VER;
    ui.verTag.textContent = 'v' + VER;
    ui.footVer.textContent = 'v' + VER;

    ui.addFiles.addEventListener('click', function () { closeAddMenu(); ui.fileInput.click(); });
    ui.fileInput.addEventListener('change', function () {
      addFiles(ui.fileInput.files);
      ui.fileInput.value = '';
    });
    ui.addDrive.addEventListener('click', addFromDrive);
    ui.btnFolderLink.addEventListener('click', addFromLink);
    ui.folderLink.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addFromLink();
    });
    ui.settings.addEventListener('click', openSettings);
    ui.saveSettings.addEventListener('click', saveSettings);
    el('squareMode').addEventListener('change', syncSquareMode);
    ui.exportBtn.addEventListener('click', doExport);
    ui.clear.addEventListener('click', clearAll);

    // onboarding & help
    ui.help.addEventListener('click', function () { ui.helpDialog.showModal(); });
    ui.dropHelp.addEventListener('click', function () { ui.helpDialog.showModal(); });
    ui.helpClose.addEventListener('click', function () { ui.helpDialog.close(); });
    ui.welcomeOk.addEventListener('click', function () {
      try { localStorage.setItem('quadrat.welcomed', '1'); } catch (e) { /* private mode */ }
      ui.welcomeDialog.close();
    });

    // folder-without-sign-in dialog
    ui.folderZip.addEventListener('click', function () {
      ui.folderDialog.close();
      ui.fileInput.click(); // .zip files are accepted by the same picker
    });
    ui.folderSignin.addEventListener('click', function () {
      ui.folderDialog.close();
      openSettings();
    });

    // settings: self-describing — show this page's origin, copy on click
    ui.copyOrigin.textContent = location.origin;
    ui.copyOrigin.addEventListener('click', function () {
      var done = function () {
        ui.copyOrigin.textContent = 'copied ✓';
        setTimeout(function () { ui.copyOrigin.textContent = location.origin; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(location.origin).then(done, done);
      } else { done(); }
    });

    // drag & drop
    ['dragenter', 'dragover'].forEach(function (evn) {
      ui.drop.addEventListener(evn, function (e) { e.preventDefault(); ui.drop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (evn) {
      ui.drop.addEventListener(evn, function (e) { e.preventDefault(); ui.drop.classList.remove('drag'); });
    });
    ui.drop.addEventListener('drop', function (e) {
      filesFromDrop(e.dataTransfer).then(addFiles);
    });
    var folderInput = el('folderInput');
    if (folderInput) {
      el('btnAddFolder').addEventListener('click', function () { closeAddMenu(); folderInput.click(); });
      folderInput.addEventListener('change', function () { addFiles(folderInput.files); folderInput.value = ''; });
    }
    // Photos | Metadata tabs
    QDMetaTab.init({ getItems: function () { return state.items; }, onChange: function () {} });
    QDMapTab.init({ getItems: function () { return state.items; }, onChange: function () {} });
    el('btnMetaCsv').addEventListener('click', doExportMetaCsv);
    Array.prototype.forEach.call(document.querySelectorAll('.tabs [data-tab]'), function (b) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
    });
    // the usual case is a whole field folder (country/…/site/strata)
    ui.drop.addEventListener('click', function () { (el('folderInput') || ui.fileInput).click(); });
    document.addEventListener('click', function (e) {
      var m = el('addMenu');
      if (m && m.open && !m.contains(e.target)) m.open = false;
    });

    QDGrid.init({ onThumb: onThumbClick, onExclude: toggleExclude });
    QDEditor.init();
    render();

    // first-run onboarding: makes the README unnecessary
    var welcomed = false;
    try { welcomed = !!localStorage.getItem('quadrat.welcomed'); } catch (e) { /* private mode */ }
    if (!welcomed) ui.welcomeDialog.showModal();
  }

  // ---------------------------------------------------------------- ingest

  var loadCount = 0;
  /** Folder part of a relative path ("A/B/C/x.jpg" → "A/B/C"), or null. */
  function dirOf(path) {
    var i = String(path || '').lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : null;
  }

  /**
   * Walk dropped folders (Finder/Explorer, e.g. a Google Drive for desktop
   * folder): files keep their relative path, so the folder structure becomes
   * metadata groups exactly as with a Drive link or a zip.
   */
  function filesFromDrop(dt) {
    var items = dt.items ? Array.from(dt.items) : [];
    var entries = items.map(function (i) { return i.webkitGetAsEntry && i.webkitGetAsEntry(); }).filter(Boolean);
    if (!entries.some(function (en) { return en.isDirectory; })) return Promise.resolve(Array.from(dt.files));
    var out = [];
    function walk(entry, prefix) {
      if (entry.isFile) {
        return new Promise(function (res) {
          entry.file(function (f) { f._relPath = prefix + f.name; out.push(f); res(); }, function () { res(); });
        });
      }
      return new Promise(function (res) {
        var reader = entry.createReader(), all = [];
        (function more() {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              all.reduce(function (p, ch) { return p.then(function () { return walk(ch, prefix + entry.name + '/'); }); }, Promise.resolve()).then(res);
              return;
            }
            all = all.concat(batch); more();
          }, function () { res(); });
        })();
      });
    }
    return entries.reduce(function (p, en) { return p.then(function () { return walk(en, ''); }); }, Promise.resolve())
      .then(function () { return out; });
  }

  function closeAddMenu() { var m = el('addMenu'); if (m) m.open = false; }

  function addFiles(fileList) {
    var files = Array.from(fileList);
    var load = 'Load ' + (++loadCount);
    // CSVs inside a picked/dropped folder are metadata (same as in a zip or a
    // Drive folder): read them before the photos are queued so they join
    var csvFiles = files.filter(function (f) { return /\.csv$/i.test(f.name); });
    if (csvFiles.length) {
      Promise.all(csvFiles.map(function (f) {
        return f.text().then(function (t) { var p = QDMeta.parseCSV(t); p.name = f.name; return p; }, function () { return null; });
      })).then(function (cs) {
        state.csvs = state.csvs.concat(cs.filter(Boolean));
        addFiles(files.filter(function (f) { return !/\.csv$/i.test(f.name); }));
      });
      return;
    }
    var zips = files.filter(function (f) { return /\.zip$/i.test(f.name); });
    var imgs = files.filter(function (f) {
      return !/\.zip$/i.test(f.name) && (/image|jpe?g/i.test(f.type) || /\.(jpe?g|png|tiff?)$/i.test(f.name) || QDRaw.isRaw(f.name));
    });
    if (zips.length) { zips.forEach(addZip); }
    if (!imgs.length) return;
    imgs.forEach(function (f) {
      var it = newItem(f.name, f, null);
      // folder of a dropped / picked folder, else this load as one group
      it.group = dirOf(f._relPath || f.webkitRelativePath) || load;
      state.items.push(it);
    });
    render();
    startQueue();
  }

  /** Bulk path with zero setup: a .zip exported from Drive. */
  function addZip(file) {
    setProgress(true, 'Opening ' + file.name + '…', 0.02);
    QDUnzip.read(file).then(function (entries) {
      var csvEntries = entries.filter(function (e) { return /\.csv$/i.test(e.name) && !/^__MACOSX/.test(e.path); });
      var imgEntries = entries.filter(function (e) {
        return (/\.(jpe?g|png|tiff?)$/i.test(e.path) || QDRaw.isRaw(e.path)) && !/^__MACOSX/.test(e.path);
      });
      if (!imgEntries.length && !csvEntries.length) {
        setProgress(false);
        alert('No images found in the zip.');
        return;
      }
      return Promise.all(csvEntries.map(function (e) {
        return e.blob.text().then(function (t) {
          var p = QDMeta.parseCSV(t); p.name = e.name; return p;
        }).catch(function () { return null; });
      })).then(function (csvData) {
        state.csvs = csvData.filter(Boolean);
        imgEntries.forEach(function (e) {
          var zi = newItem(e.name, e.blob, 'zip:' + e.path);
          zi.group = dirOf(e.path) || file.name.replace(/\.zip$/i, '');
          state.items.push(zi);
        });
        setProgress(false);
        render();
        startQueue();
      });
    }).catch(function (err) {
      setProgress(false);
      alert('Could not read the zip: ' + (err.message || err));
    });
  }

  function addFromDrive() {
    if (!QDDrive.hasConfig()) { openSettings(); return; }
    QDDrive.pickFolder().then(function (res) {
      if (!res || !res.picked) return;
      var pick = res.picked;
      if (/^image\//.test(pick.mimeType || '')) {
        // single image picked: download directly
        setProgress(true, 'Downloading ' + pick.name + '…');
        return QDDrive.downloadFile(pick.id).then(function (blob) {
          setProgress(false);
          var it = newItem(pick.name, blob, pick.id);
          it.origin = 'drive-api';
          state.items.push(it);
          render(); startQueue();
        });
      }
      return ingestFolderById(pick.id);
    }).catch(function (e) { setProgress(false); alert(String(e.message || e)); });
  }

  function addFromLink() {
    var raw = ui.folderLink.value.trim();
    if (!raw) { alert('Paste a Drive link first.'); return; }
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    var id = QDDrive.extractId(raw);
    if (!id) { alert('That does not look like a Google Drive link.'); return; }
    var isFolder = /folders\//.test(raw);

    if (!isFolder) {
      // single file: anonymous direct download — zero setup
      loadLinkBusy(true);
      QDDrive.downloadPublic(id).then(function (blob) {
        loadLinkBusy(false);
        state.items.push(newItem('drive_' + id + '.jpg', blob, id));
        render(); startQueue();
      }).catch(function (e) {
        loadLinkBusy(false);
        handleLinkFailure(e, 'file');
      });
      return;
    }

    if (QDDrive.hasConfig()) { ingestFolderById(id); return; }
    // folder without sign-in configured → offer the two zero/low-effort paths
    ui.folderDialog.showModal();
  }

  function loadLinkBusy(on) {
    setProgress(on, 'Fetching link…', on ? 0.05 : null);
    if (!on) setProgress(false);
  }

  function handleLinkFailure(e, kind) {
    var msg = String(e.message || e);
    var name = kind === 'file' ? 'file' : 'folder';
    if (msg.indexOf('not-public') >= 0 || /not-public|403|404/.test(msg)) {
      alert('This Drive ' + name + ' is not publicly shared.\n\n'
        + 'In Drive: right-click it → Share → change "General access" to\n'
        + '"Anyone with the link" (Viewer), then try again.\n\n'
        + 'Alternatively use "⊕ Add from Google Drive" (one-time sign-in).');
    } else if (/CORS|Failed to fetch|NetworkError/i.test(msg)) {
      alert('Direct fetch was blocked. Use "⊕ Add from Google Drive" (one-time sign-in), '
        + 'or download the folder as .zip in Drive and drop the zip here.');
    } else {
      alert('Could not load the link: ' + msg);
    }
  }

  function ingestFolderById(folderId) {
    setProgress(true, 'Listing Drive folder…');
    return QDDrive.ingestFolder(folderId, function (msg) {
      state.dlMsg = msg;
      if (!state.busy) setProgress(true, msg);
    }, {
      onCsvs: function (csvs) { state.csvs = (csvs || []).filter(Boolean); },
      // stream: each photo joins the queue as soon as it is downloaded
      onItem: function (f) {
        var it = newItem(f.name, f.blob, f.driveId);
        // Drive subfolder path below the pasted/picked folder
        it.group = dirOf(f.path) || 'Drive folder';
        it.origin = 'drive-api';
        state.items.push(it);
        ui.grid.appendChild(QDGrid.render(it));
        startQueue();
        return waitForRoom();
      }
    }).then(function (res) {
      state.dlMsg = '';
      if (!state.busy) setProgress(false);
      renderStats();
      if (res.failed && res.failed.length) {
        alert(res.failed.length + ' file(s) could not be downloaded from Drive and were skipped:\n\n'
          + res.failed.slice(0, 15).join('\n') + (res.failed.length > 15 ? '\n…' : ''));
      }
    }).catch(function (e) {
      setProgress(false);
      alert(String(e.message || e));
    });
  }

  function newItem(name, blob, driveId) {
    return {
      id: 'i' + Math.random().toString(36).slice(2, 10),
      name: name, blob: blob, driveId: driveId || null,
      status: 'queued', ok: false, conf: 0, det: null,
      corners: null, source: 'auto', flags: [], reason: null,
      cropBlob: null, thumbURL: null, meta: null, exif: null,
      geo: null,            // position set in the Map tab (geo.js position())
      fullDataKept: false
    };
  }

  // ------------------------------------------------------------- processing

  function setProgress(on, msg, frac) {
    ui.progressWrap.hidden = !on;
    ui.progressText.textContent = msg || '';
    if (frac != null) ui.progressFill.style.width = Math.round(frac * 100) + '%';
  }

  // ------------------------------------------------------- worker pool
  //
  // Each worker runs the full per-photo pipeline (decode → detect → square →
  // warp → encode, see worker.js), one photo at a time, on its own CPU core.
  // Falls back to the main-thread processOne() when workers/OffscreenCanvas
  // are unavailable (old Safari, file:// pages) or a worker errors out.
  var pool = null;
  function getPool() {
    if (pool) return pool;
    pool = [];
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return pool;
    var n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    try {
      for (var i = 0; i < n; i++) pool.push({ w: new Worker('js/worker.js'), busy: false, broken: false });
    } catch (e) { pool = []; }
    return pool;
  }

  function runInWorker(slot, msg) {
    return new Promise(function (resolve, reject) {
      slot.w.onmessage = function (e) { resolve(e.data); };
      slot.w.onerror = function (e) { slot.broken = true; e.preventDefault && e.preventDefault(); reject(new Error(e.message || 'worker error')); };
      slot.w.postMessage(msg);
    });
  }

  async function processInWorker(it, slot) {
    if (!it.meta) it.meta = QDMeta.joinMeta(it.name, state.csvs);
    if (!it.exif) it.exif = await QDExif.fromBlob(it.blob);
    var r = await runInWorker(slot, { id: it.id, blob: it.blob, maxSide: NATIVE_MAX, maxMP: MAX_DETECT_MP,
      inset: getInset(), squareSide: getSquareSide() });
    if (r.error) throw new Error(r.error);
    var det = r.det;
    it.det = det;
    it.ok = !!r.ok;
    it.conf = det.confidence || 0;
    it.flags = det.flags || [];
    it.reason = det.diagnostics && det.diagnostics.reason || null;
    if (r.ok) {
      det.geom = r.geom;
      det.quadFull = r.geom.quad;
      it.sidePx = r.geom.detSide;          // detected size: for the batch size check
      it.natW = r.natW; it.natH = r.natH;
      it.imgShort = Math.min(r.natW, r.natH);
      applyChecks(it);
      it.corners = det.quadFull.map(function (c) { return { x: c.x, y: c.y }; });
      it.source = 'auto';
      it.cropBlob = r.cropBlob;
      it.cropSide = r.side;
      it.status = 'done';
    } else {
      it.status = 'failed';
      it.thumbIsSource = true;
    }
    if (it.thumbURL && /^blob:/.test(it.thumbURL)) URL.revokeObjectURL(it.thumbURL);
    it.thumbURL = URL.createObjectURL(r.thumbBlob);
  }

  /**
   * Originals pulled through the Drive API are dropped once processed (a
   * 3000-photo folder is ~25 GB) and fetched again only if the photo is
   * opened in the editor. Local files are disk-backed File objects: kept.
   */
  function releaseOriginal(it) {
    if (it.origin === 'drive-api' && it.driveId) it.blob = null;
  }
  function ensureBlob(it) {
    if (it.blob) return Promise.resolve(it.blob);
    if (it.origin !== 'drive-api' || !it.driveId) return Promise.reject(new Error('original photo is no longer available'));
    setProgress(true, 'Downloading original of ' + it.name + '…', null);
    return QDDrive.downloadFile(it.driveId).then(function (b) {
      // a released RAW comes back as RAW: extract its JPEG again for the editor
      return QDRaw.isRaw(it.name) ? QDRaw.toJpeg(b).then(function (r) { return r.blob; }) : b;
    }).then(function (b) {
      setProgress(false); it.blob = b; return b;
    }, function (e) { setProgress(false); throw e; });
  }

  /** Resolves when few enough photos wait in memory (download backpressure). */
  function waitForRoom() {
    var limit = Math.max(6, getPool().length * 3);
    return new Promise(function (resolve) {
      (function check() {
        var waiting = 0;
        for (var i = 0; i < state.items.length; i++) {
          var st = state.items[i].status;
          if (st === 'queued' || st === 'processing') waiting++;
        }
        if (waiting < limit) resolve(); else setTimeout(check, 250);
      })();
    });
  }

  /**
   * RAW files (CR2, NEF, ORF…): swap in the largest embedded camera JPEG
   * once, keeping the RAW's EXIF; flag it when that JPEG is only a reduced
   * preview (common in Olympus ORF).
   */
  async function prepare(it) {
    if (!QDRaw.isRaw(it.name) || it.rawDone) return;
    if (!it.blob) await ensureBlob(it);
    var r = await QDRaw.toJpeg(it.blob);
    it.blob = r.blob;
    it.exif = r.exif;
    it.rawDone = true;
    it.rawNote = 'RAW: using the embedded camera JPEG (' + r.width + '×' + r.height + ')'
      + (r.small ? ' — reduced resolution; export full-size JPEGs from the RAW if detail matters' : '');
  }

  async function startQueue() {
    if (state.busy) return;
    state.busy = true;
    var workers = getPool();
    var done = 0, active = 0, t0 = Date.now();
    await new Promise(function (resolve) {
      function pump() {
        // re-scan every time: items added mid-run (drops, Drive streaming)
        // are picked up; clearAll() empties the list and ends the run
        var pending = state.items.filter(function (q) { return q.status === 'queued'; });
        if (!pending.length && active === 0) { resolve(); return; }
        var free = workers.length
          ? workers.filter(function (w) { return !w.busy && !w.broken; })
          : (active === 0 ? [null] : []);
        if (workers.length && !free.length && active === 0) free = [null]; // all broken
        for (var k = 0; k < free.length && k < pending.length; k++) launch(pending[k], free[k]);
        var left = state.items.filter(function (q) { return q.status === 'queued'; }).length;
        var total = done + active + left;
        var rate = done ? (Date.now() - t0) / done : 0;
        setProgress(true, 'Processing ' + done + '/' + total + ' (' + (workers.length || 1) + ' in parallel)'
          + (rate && left ? ' — ~' + Math.ceil(rate * (left + active) / 60000) + ' min left' : '')
          + (state.dlMsg ? ' · Drive: ' + state.dlMsg : ''),
          total ? done / total : 0);
      }
      function launch(it, slot) {
        it.status = 'processing';
        QDGrid.updateCard(it);
        active++;
        if (slot) slot.busy = true;
        var job = prepare(it).then(function () {
          return slot ? processInWorker(it, slot).catch(function (e) {
              console.warn('worker failed, retrying on main thread', it.name, e);
              return processOne(it);
            })
          : processOne(it);
        });
        job.catch(function (e) {
          it.status = 'failed';
          it.reason = String(e.message || e);
          console.error('failed', it.name, e);
        }).then(function () {
          if (it.rawNote && it.flags.indexOf(it.rawNote) < 0) it.flags = it.flags.concat([it.rawNote]);
          releaseOriginal(it);
          if (slot) slot.busy = false;
          active--; done++;
          QDGrid.updateCard(it);
          renderStats();
          pump();
        });
      }
      pump();
    });
    // The batch-typical size is only known once enough photos are in, so the
    // first ones were checked without it: re-check every auto crop now
    // (flags/confidence only — the crop itself does not change).
    var frac = typicalSideFrac(null);
    state.items.forEach(function (o) {
      if (o.source === 'auto' && o.det && o.det.geom) { applyChecks(o, frac); QDGrid.updateCard(o); }
    });
    renderStats();
    setProgress(false);
    state.busy = false;
    ui.exportBtn.disabled = false;
    if (reapplyPending) { reapplyPending = false; reapplySquare(); }
  }

  // Detection input: keep the ORIGINAL-resolution pixels. detectQuadrat()
  // does its own single box-average resample internally (work width 1152),
  // so the browser path and the Node/test path see identical detector
  // input (previously drawImage resampled to 1152 here with unknown
  // interpolation, diverging from the fixtures on borderline images).
  async function decodeScaled(it) {
    var bmp = await createImageBitmap(it.blob, { imageOrientation: 'from-image' });
    var natW = bmp.width, natH = bmp.height;
    var mp = (natW * natH) / 1e6;
    var scale = mp > MAX_DETECT_MP ? Math.sqrt(MAX_DETECT_MP / mp) : 1;
    var w = Math.max(2, Math.round(natW * scale));
    var h = Math.max(2, Math.round(natH * scale));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    return { cv: cv, natW: natW, natH: natH };
  }

  async function processOne(it) {
    if (!it.meta) it.meta = QDMeta.joinMeta(it.name, state.csvs);
    if (!it.exif) it.exif = await QDExif.fromBlob(it.blob);

    var dec = await decodeScaled(it);
    var id = dec.cv.getContext('2d').getImageData(0, 0, dec.cv.width, dec.cv.height);
    var img = { width: id.width, height: id.height, data: new Uint8Array(id.data.buffer) };
    var det = QD.detectQuadrat(img, {});
    it.det = det;
    it.ok = !!det.ok;
    it.conf = det.confidence || 0;
    it.flags = det.flags || [];
    it.reason = det.diagnostics && det.diagnostics.reason || null;

    if (it.ok) {
      // map detection-space quad to ORIGINAL image px once — everything
      // downstream (crop, manual editor, manifest) speaks original px.
      var fac = dec.natW / id.width;
      var quadRaw = det.quad.map(function (c) {
        return { x: c.x * fac, y: c.y * fac };
      });
      // The recommended crop is ALWAYS a square (rigid camera mount → the
      // opening is square in the image) and always inside the photo, so the
      // editor never shows an unreachable marker. See squareGeometry().
      var g = squareGeometry(quadRaw, dec.natW, dec.natH);
      det.quadRaw = quadRaw;
      det.quadFull = g.quad;
      det.geom = g;
      it.sidePx = g.detSide;
      it.natW = dec.natW; it.natH = dec.natH;
      it.imgShort = Math.min(dec.natW, dec.natH);
      applyChecks(it);
      it.source = 'auto';
      it.status = 'done';
      await makeCrop(it, g.quad, 'auto');
    } else {
      it.status = 'failed';
      // show the source photo as the card thumbnail so failures can be
      // spotted (and reviewed instead of a blank placeholder)
      it.thumbURL = thumbDataUrlFit(dec.cv, 340);
      it.thumbIsSource = true;
    }
    // keep full-resolution source for manual review of failures only
    it.keptForReview = !it.ok;
  }

  // ------------------------------------------------- square-crop geometry

  // Tolerances for the recommended crop (fractions of the square's side).
  // TG-6/TG-7 field photos show the opening ~5 % wider than tall (camera /
  // mount geometry, measured on 2026 photos: residual 2-4.4 % on good
  // detections), so 4 % flagged normal photos; 6 % still catches a tilted
  // camera (15 % stretch → 6.4 %).
  var SQUARE_TOL_REVIEW = 0.06;   // > 6 % corner shift → "suggested review"
  var SQUARE_TOL_MANUAL = 0.12;   // > 12 % → "needs manual corners"
  var SIZE_TOL = [0.8, 1.25];     // side vs batch-typical side
  var SIZE_MIN_SAMPLES = 5;       // clean detections needed to know "typical"
  var CAP_REVIEW = 0.79, CAP_MANUAL = 0.54;

  /** Detector quad → best-fit square, kept inside the image. */
  // Inset of the suggested crop (% of the side): the detected square sits on
  // the inner rim of the tube, so a few % less keeps the yellow/green PVC
  // out of the crop. Set in ⚙; default 5 %.
  function getInset() {
    var v = 5;
    try { var s = localStorage.getItem('quadrat.inset'); if (s !== null && s !== '') v = +s; } catch (e) { /* private mode */ }
    return isFinite(v) ? Math.max(0, Math.min(20, v)) : 5;
  }

  /**
   * Suggested-square size mode (⚙ "Suggested square"): null = the detected
   * frame shrunk by the inset %; a number = a FIXED side in original-photo
   * px (the camera sits at a fixed height, so the opening has almost the
   * same px size in every photo; a fixed side keeps tube out of the crop when
   * a detection comes out slightly large). localStorage 'quadrat.squareSide'.
   */
  function getSquareSide() {
    var v = '';
    try { v = localStorage.getItem('quadrat.squareSide') || ''; } catch (e) { /* private mode */ }
    return /^\d+$/.test(v) ? Math.max(100, Math.min(NATIVE_MAX, +v)) : null;
  }

  function squareGeometry(quadRaw, W, H) {
    // same helper as worker.js (QD.suggestSquare): both paths give one crop
    return QD.suggestSquare(quadRaw, W, H, { inset: getInset(), side: getSquareSide() });
  }

  /**
   * Typical square side for this batch, as a fraction of the photo's short
   * side (robust to mixed cameras/resolutions): median over clean, confident
   * auto detections, excluding `self`. null until there are enough samples.
   */
  function typicalSideFrac(self) {
    var fr = state.items.filter(function (o) {
      return o !== self && o.source === 'auto' && o.det && o.det.geom &&
        (o.det.confidence || 0) >= 0.8 && o.det.geom.residual <= SQUARE_TOL_REVIEW &&
        !o.det.geom.moved && !o.det.geom.shrunk && o.imgShort;
    }).map(function (o) { return o.sidePx / o.imgShort; }).sort(function (a, b) { return a - b; });
    if (fr.length < SIZE_MIN_SAMPLES) return null;
    return fr[Math.floor(fr.length / 2)];
  }

  /** Recompute flags + capped confidence of an auto crop from its geometry. */
  function applyChecks(it, fracOverride) {
    var det = it.det, g = det && det.geom;
    if (!g) return;
    var flags = (det.flags || []).slice(), cap = 1;
    var pct = Math.round(g.residual * 100);
    if (g.residual > SQUARE_TOL_MANUAL) {
      flags.unshift('detected outline far from square (' + pct + '% off) — replaced by best-fit square; check corners');
      cap = Math.min(cap, CAP_MANUAL);
    } else if (g.residual > SQUARE_TOL_REVIEW) {
      flags.unshift('detected outline not square (' + pct + '% off) — replaced by best-fit square');
      cap = Math.min(cap, CAP_REVIEW);
    }
    if (g.moved || g.shrunk) {
      flags.unshift('frame runs off the photo — square kept inside the image; check corners');
      cap = Math.min(cap, CAP_REVIEW);
    }
    if (g.fixedSide && g.detSide && g.fixedSide > g.detSide * 1.02) {
      flags.unshift('fixed square (' + g.fixedSide + ' px) larger than the detected opening (~'
        + Math.round(g.detSide) + ' px): the crop may include the frame');
      cap = Math.min(cap, CAP_REVIEW);
    }
    var frac = fracOverride !== undefined ? fracOverride : typicalSideFrac(it);
    if (frac) {
      var exp = frac * it.imgShort, ratio = it.sidePx / exp;
      if (ratio < SIZE_TOL[0] || ratio > SIZE_TOL[1]) {
        flags.unshift('unusual size: ' + Math.round(it.sidePx) + ' px vs ~' + Math.round(exp) + ' px typical in this batch');
        cap = Math.min(cap, CAP_REVIEW);
      }
    }
    if (it.rawNote) flags.push(it.rawNote);
    it.flags = flags;
    it.conf = Math.min(det.confidence || 0, cap);
  }

  /** Warp the source image through `quad` into a square JPEG blob + thumbnail. */
  // Crops are warped at the square's own resolution (no more 1600-px cap,
  // which downsampled the ~1700-px TG openings); the export then brings them
  // all to one size (see cropSizeTarget).
  var NATIVE_MAX = 4000;

  /**
   * Output size for every crop in the ZIP. Each crop shows the same 25 × 25 cm,
   * so a common pixel size means a common scale (px/cm) across photos.
   * 'median' (default): median crop side of the exported photos; a number:
   * fixed side in px; 'native': each crop keeps its own size.
   */
  function getCropSize() {
    // default 'native' (v1.15): each crop keeps the size seen in the viewer.
    // With a fixed suggested square, crops from one camera are equal anyway.
    var v = 'native';
    try { v = localStorage.getItem('quadrat.cropSize') || 'native'; } catch (e) { /* private mode */ }
    return v;
  }
  function cropSizeTarget(sel) {
    var mode = getCropSize();
    if (mode === 'native') return null;
    if (/^\d+$/.test(mode)) return Math.max(200, Math.min(NATIVE_MAX, +mode));
    var s = sel.map(function (it) { return it.cropSide; }).filter(Boolean).sort(function (a, b) { return a - b; });
    return s.length ? s[Math.floor(s.length / 2)] : null;
  }

  async function makeCrop(it, quad, source, maxSide) {
    var bmp = await createImageBitmap(it.blob, { imageOrientation: 'from-image' });
    var cvFull = document.createElement('canvas');
    cvFull.width = bmp.width; cvFull.height = bmp.height;
    cvFull.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();

    var side = sideForQuad(quad, maxSide);
    var idata = cvFull.getContext('2d').getImageData(0, 0, cvFull.width, cvFull.height);
    var warped = QD.warpToSquare(
      { width: cvFull.width, height: cvFull.height, data: idata.data }, quad, side);

    var outCv = document.createElement('canvas');
    outCv.width = side; outCv.height = side;
    var outCtx = outCv.getContext('2d');
    outCtx.putImageData(new ImageData(new Uint8ClampedArray(warped.buffer), side, side), 0, 0);

    it.corners = quad.map(function (c) { return { x: c.x, y: c.y }; });
    it.source = source;
    it.cropBlob = await new Promise(function (res) {
      outCv.toBlob(function (b) { res(b); }, 'image/jpeg', 0.92);
    });
    it.cropSide = side;
    it.thumbURL = thumbDataUrl(outCv, 340);
    it.cropCanvas = null; // release the full crop canvas (blob retained)
  }

  function sideForQuad(quad, maxSide) {
    var lens = [0, 1, 2, 3].map(function (i) {
      var a = quad[i], b = quad[(i + 1) % 4];
      return Math.hypot(b.x - a.x, b.y - a.y);
    });
    var mean = lens.reduce(function (a, b) { return a + b; }, 0) / 4;
    var side = Math.round(Math.min(maxSide || NATIVE_MAX, Math.max(500, mean)));
    return side;
  }

  function thumbDataUrl(cv, size) {
    var t = document.createElement('canvas');
    t.width = size; t.height = size;
    t.getContext('2d').drawImage(cv, 0, 0, size, size);
    return t.toDataURL('image/jpeg', 0.75);
  }

  /** Thumbnail that letterboxes a non-square canvas (source shots, 4:3 …). */
  function thumbDataUrlFit(cv, size) {
    var t = document.createElement('canvas');
    t.width = size; t.height = size;
    var ctx = t.getContext('2d');
    ctx.fillStyle = '#0b1014';
    ctx.fillRect(0, 0, size, size);
    var s = Math.min(size / cv.width, size / cv.height);
    var w = cv.width * s, h = cv.height * s;
    ctx.drawImage(cv, (size - w) / 2, (size - h) / 2, w, h);
    return t.toDataURL('image/jpeg', 0.75);
  }

  /** Manual re-crop after corner edit. */
  async function reCropManual(it, quad) {
    // Apply on an untouched detection is a no-op: re-encoding would only lose
    // a little quality and would mislabel an auto crop as manual in the
    // manifest.
    var prev = it.corners || (it.det && (it.det.quadFull || it.det.quad));
    var moved = !prev || quad.some(function (c, i) {
      return Math.hypot(c.x - prev[i].x, c.y - prev[i].y) > 1;
    });
    if (!moved) return;
    try {
      await makeCrop(it, quad, 'manual');
      it.status = 'done';
      it.ok = true;
      it.flags = ['manually adjusted corners'];
    } catch (e) {
      it.status = 'failed';
      it.reason = String(e.message || e);
    }
    QDGrid.updateCard(it);
    renderStats();
  }

  // ---------------------------------------------------------------- grid/ui

  function onThumbClick(item) {
    // 'failed' items must open too: the card tooltip says "No frame found —
    // click to fix corners manually" and the editor supports placing all four
    // markers when there is no auto quad, but this guard used to return for
    // them, so red "no frame" photos could never be fixed or exported.
    if (!item.det || (item.status !== 'done' && item.status !== 'failed')) return; // still scanning
    // every item opens the review page: the full uncropped photo with the
    // crop's corner markers (draggable) and a live crop preview alongside
    openEditorAt(item);
  }

  /** Photos the editor can show, in grid order (prev/next navigation). */
  function editableItems() {
    return state.items.filter(function (it) {
      return it.det && (it.status === 'done' || it.status === 'failed');
    });
  }

  function openEditorAt(item) {
    var list = editableItems();
    var idx = list.indexOf(item);
    ensureBlob(item).then(function () {
      QDEditor.open(item, function (quad) {
        reCropManual(item, quad).then(function () { releaseOriginal(item); });
      }, {
        pos: idx + 1,
        total: list.length,
        go: function (dir) {
          var target = list[idx + dir];
          if (!target) return;
          // leaving an untouched Drive photo: drop its original again
          if (item.source !== 'manual') releaseOriginal(item);
          openEditorAt(target);
        }
      });
      // fetch the next photo's original in the background (Drive items are
      // released after processing), so → shows it without a wait
      var nxt = list[idx + 1];
      if (nxt && !nxt.blob && nxt.origin === 'drive-api') {
        QDDrive.downloadFile(nxt.driveId).then(function (b) {
          return QDRaw.isRaw(nxt.name) ? QDRaw.toJpeg(b).then(function (r) { return r.blob; }) : b;
        }).then(function (b) { if (!nxt.blob) nxt.blob = b; }, function () { /* fetched on demand */ });
      }
    }, function (e) { alert('Could not load the original photo: ' + (e.message || e)); });
  }

  function render() {
    ui.grid.innerHTML = '';
    state.items.forEach(function (item) {
      ui.grid.appendChild(QDGrid.render(item));
    });
    renderStats();
  }

  function renderStats() {
    QDMapTab.refresh();          // no-op unless the Map tab is open (debounced)
    var n = QDGrid.updateStats(state.items);
    var ok = n.auto, review = n.review, manual = n.manual, failed = n.failed;
    var adjusted = n.adjusted || 0;
    var total = ok + review + manual + failed + adjusted + (n.excluded || 0);
    if (!total) { ui.stats.hidden = true; ui.exportBtn.textContent = '⬇ Export ZIP'; return; }
    ui.stats.hidden = false;
    var ready = state.items.filter(isExportable).length;
    ui.stats.innerHTML =
      '<span><b>' + ok + '</b> auto-accepted</span>' +
      '<span><b>' + review + '</b> suggested review</span>' +
      '<span><b>' + manual + '</b> need manual corners</span>' +
      '<span><b>' + failed + '</b> no frame found</span>' +
      (adjusted ? '<span><b>' + adjusted + '</b> manually adjusted</span>' : '') +
      (n.excluded ? '<span><b>' + n.excluded + '</b> excluded</span>' : '') +
      '<span><b>' + total + '</b> total</span>' +
      '<span>· <b>' + ready + '</b> ready for export</span>';
    ui.exportBtn.textContent = '⬇ Export ZIP (' + ready + ')';
    ui.exportBtn.title = 'Includes auto crops at ≥ 80% confidence and every manually adjusted one';
    ui.exportBtn.disabled = !state.items.length;
  }

  function toggleExclude(it) {
    it.excluded = !it.excluded;
    QDGrid.updateCard(it);
    renderStats();
  }

  /** An item qualifies for export on its own merits — no manual ticking. */
  function isExportable(it) {
    if (it.excluded) return false;
    return !!it.cropBlob && (it.source === 'manual' || (it.ok && it.conf >= 0.8));
  }

  function doExport() {
    var sel = state.items.filter(isExportable);
    if (!sel.length) {
      alert('No images ready to export.\n\n'
        + 'Crops are included automatically when confidence is at least 80%.\n'
        + 'Click a thumbnail to check the corners on the full photo and adjust\n'
        + 'them — a manually adjusted crop is always included.');
      return;
    }
    var meta = QDMetaTab.exportInfo();
    if (meta) {
      var miss = meta.missing(sel);
      if (miss.length && !confirm('Metadata is incomplete for ' + miss.length + ' group(s):\n\n'
          + miss.slice(0, 10).join('\n') + (miss.length > 10 ? '\n…' : '')
          + '\n\nExport anyway? (Cancel opens the Metadata tab.)')) {
        showTab('meta');
        return;
      }
    }
    var skipped = state.items.length - sel.length;
    setProgress(true, 'Building ZIP…', null);
    QDExport.exportZip(sel, state.items, meta, { side: cropSizeTarget(sel) }).then(function (size) {
      setProgress(false);
      alert(sel.length + ' crop' + (sel.length === 1 ? '' : 's') + ' exported.'
        + (skipped ? '\n\n' + skipped + ' image' + (skipped === 1 ? '' : 's')
          + ' not included (excluded, or confidence < 80% and not manually adjusted) — they are listed in manifest.csv.' : ''));
      console.log('zip ready:', size);
    }).catch(function (e) { setProgress(false); alert(String(e.message || e)); });
  }

  /** Metadata tab: download only the metadata CSV (no crops, no ZIP). */
  function doExportMetaCsv() {
    var meta = QDMetaTab.exportInfo();
    if (!meta) { alert('Choose a project preset first (the preset defines the CSV columns).'); return; }
    var sel = state.items.filter(isExportable);
    if (!sel.length) {
      alert('No photos ready to export yet: the CSV lists the crops the ZIP would contain.');
      return;
    }
    var miss = meta.missing(sel);
    if (miss.length && !confirm('Metadata is incomplete for ' + miss.length + ' group(s):\n\n'
        + miss.slice(0, 10).join('\n') + (miss.length > 10 ? '\n…' : '') + '\n\nDownload anyway?')) return;
    QDExport.metadataCsv(sel, state.items, meta);
  }

  function clearAll() {
    if (state.items.length && !confirm('Discard all ' + state.items.length + ' images?')) return;
    state.items = [];
    state.csvs = [];
    render();
  }

  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs [data-tab]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    el('photosPanel').hidden = name !== 'photos';
    el('metaPanel').hidden = name !== 'meta';
    el('mapPanel').hidden = name !== 'map';
    if (name === 'meta') QDMetaTab.render();
    if (name === 'map') QDMapTab.show();
  }

  function openSettings() {
    ui.clientIdInput.value = QDDrive.getClientId();
    el('insetInput').value = getInset();
    var ss = getSquareSide();
    el('squareMode').value = ss ? 'fixed' : 'detected';
    el('squareSidePx').value = ss || suggestedFixedSide() || 1600;
    el('squareStats').textContent = squareStatsText();
    syncSquareMode();
    var cs = getCropSize();
    el('cropSizeMode').value = /^\d+$/.test(cs) ? 'fixed' : cs;
    el('cropSizePx').value = /^\d+$/.test(cs) ? cs : 1600;
    try { el('arcgisKeyInput').value = localStorage.getItem('quadrat.arcgisKey') || ''; } catch (e) { /* private mode */ }
    el('arcgisSiteNote').hidden = !(window.QD_SITE_CONFIG && window.QD_SITE_CONFIG.arcgisKey);
    ui.settingsDialog.showModal();
  }
  function saveSettings() {
    QDDrive.setConfig(ui.clientIdInput.value, QDDrive.getApiKey());
    var before = getInset() + '|' + getSquareSide();
    try { localStorage.setItem('quadrat.inset', String(Math.max(0, Math.min(20, +el('insetInput').value || 0)))); } catch (e) { /* private mode */ }
    try {
      if (el('squareMode').value === 'fixed') {
        localStorage.setItem('quadrat.squareSide', String(Math.round(+el('squareSidePx').value || 1600)));
      } else localStorage.removeItem('quadrat.squareSide');
    } catch (e) { /* private mode */ }
    if (getInset() + '|' + getSquareSide() !== before) reapplySquare();
    try {
      var m = el('cropSizeMode').value;
      localStorage.setItem('quadrat.cropSize', m === 'fixed' ? String(Math.round(+el('cropSizePx').value || 1600)) : m);
    } catch (e) { /* private mode */ }
    try {
      var k = el('arcgisKeyInput').value.trim(), old = localStorage.getItem('quadrat.arcgisKey') || '';
      if (k) localStorage.setItem('quadrat.arcgisKey', k); else localStorage.removeItem('quadrat.arcgisKey');
      if (k !== old) QDMapTab.resetBaseLayers();
    } catch (e) { /* private mode */ }
    ui.settingsDialog.close();
  }

  function syncSquareMode() {
    var fixed = el('squareMode').value === 'fixed';
    el('squareInsetRow').hidden = fixed;
    el('squareFixedRow').hidden = !fixed;
  }

  /** Detected opening sides (original px) of the clean auto detections. */
  function detectedSides() {
    return state.items.filter(function (o) {
      return o.det && o.det.geom && o.det.geom.detSide && (o.det.confidence || 0) >= 0.8;
    }).map(function (o) { return o.det.geom.detSide; }).sort(function (a, b) { return a - b; });
  }
  /** A fixed side that stays inside most openings: ~5 % under the median. */
  function suggestedFixedSide() {
    var s = detectedSides();
    return s.length ? Math.round(s[Math.floor(s.length / 2)] * 0.95 / 10) * 10 : null;
  }
  function squareStatsText() {
    var s = detectedSides();
    if (!s.length) return 'Load photos to see the size of the detected openings.';
    var pct = function (q) { return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]); };
    return 'Detected openings in this batch (' + s.length + ' photos): median ' + pct(0.5)
      + ' px, 10–90 % range ' + pct(0.1) + '–' + pct(0.9) + ' px. Suggested fixed size: '
      + suggestedFixedSide() + ' px.';
  }

  /**
   * ⚙ "Suggested square" changed: re-crop every AUTO crop already processed
   * from its stored detection (det.quadRaw) — no detection again. Crops
   * adjusted by hand are left alone. Drive originals released after
   * processing are downloaded again (slower).
   */
  var reapplyPending = false;
  async function reapplySquare() {
    if (state.busy) { reapplyPending = true; return; }   // after the running batch
    var todo = state.items.filter(function (o) {
      return o.status === 'done' && o.source === 'auto' && o.det && o.det.quadRaw;
    });
    if (!todo.length) return;
    state.busy = true;
    var workers = getPool().filter(function (w) { return !w.broken; });
    var done = 0, next = 0, fails = 0;
    var msgFor = function () {
      return 'Re-cropping with the new square ' + done + '/' + todo.length;
    };
    setProgress(true, msgFor(), 0);
    async function one(it, slot) {
      await ensureBlob(it);
      if (slot) {
        var r = await runInWorker(slot, { id: it.id, blob: it.blob, quadRaw: it.det.quadRaw,
          maxSide: NATIVE_MAX, inset: getInset(), squareSide: getSquareSide() });
        if (r.error) throw new Error(r.error);
        it.det.geom = r.geom;
        it.det.quadFull = r.geom.quad;
        it.corners = r.geom.quad.map(function (c) { return { x: c.x, y: c.y }; });
        it.cropBlob = r.cropBlob;
        it.cropSide = r.side;
        if (it.thumbURL && /^blob:/.test(it.thumbURL)) URL.revokeObjectURL(it.thumbURL);
        it.thumbURL = URL.createObjectURL(r.thumbBlob);
      } else {
        var g = squareGeometry(it.det.quadRaw, it.natW, it.natH);
        it.det.geom = g;
        it.det.quadFull = g.quad;
        await makeCrop(it, g.quad, 'auto');
      }
    }
    async function lane(slot) {
      while (next < todo.length) {
        var it = todo[next++];
        try { await one(it, slot); } catch (e) { fails++; console.warn('re-crop failed', it.name, e); }
        releaseOriginal(it);
        done++;
        QDGrid.updateCard(it);
        setProgress(true, msgFor(), done / todo.length);
      }
    }
    await Promise.all((workers.length ? workers : [null]).map(lane));
    var frac = typicalSideFrac(null);
    todo.forEach(function (o) { applyChecks(o, frac); QDGrid.updateCard(o); });
    renderStats();
    setProgress(false);
    state.busy = false;
    if (fails) alert(fails + ' photo(s) could not be re-cropped (original not available); see the console.');
  }

  document.addEventListener('DOMContentLoaded', init);

  // debug/testing hook
  window.__qd = {
    items: state,
    reCropManual: reCropManual,
    poolSize: function () { return (pool || []).length; }
  };
})(typeof self !== 'undefined' ? self : this);
