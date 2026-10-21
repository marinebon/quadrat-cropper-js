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
  var USE_WIDTH = 1152;   // detection working width (same as Node harness)

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
      previewDialog: el('previewDialog'), previewImg: el('previewImg'),
      previewTitle: el('previewTitle'), previewMeta: el('previewMeta'),
      previewClose: el('btnPreviewClose'),
      // onboarding / zero-setup paths
      help: el('btnHelp'), dropHelp: el('btnDropHelp'),
      welcomeDialog: el('welcomeDialog'), welcomeOk: el('btnWelcomeOk'),
      helpDialog: el('helpDialog'), helpClose: el('btnHelpClose'),
      folderDialog: el('folderDialog'),
      folderZip: el('btnFolderZip'), folderSignin: el('btnFolderSignin'),
      copyOrigin: el('btnCopyOrigin')
    };

    ui.addFiles.addEventListener('click', function () { ui.fileInput.click(); });
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
    ui.exportBtn.addEventListener('click', doExport);
    ui.clear.addEventListener('click', clearAll);
    ui.previewClose.addEventListener('click', function () { ui.previewDialog.close(); });

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
      addFiles(e.dataTransfer.files);
    });
    ui.drop.addEventListener('click', function () { ui.fileInput.click(); });

    QDGrid.init({ onThumb: onThumbClick });
    QDEditor.init();
    render();

    // first-run onboarding: makes the README unnecessary
    var welcomed = false;
    try { welcomed = !!localStorage.getItem('quadrat.welcomed'); } catch (e) { /* private mode */ }
    if (!welcomed) ui.welcomeDialog.showModal();
  }

  // ---------------------------------------------------------------- ingest

  function addFiles(fileList) {
    var files = Array.from(fileList);
    var zips = files.filter(function (f) { return /\.zip$/i.test(f.name); });
    var imgs = files.filter(function (f) {
      return !/\.zip$/i.test(f.name) && (/image|jpe?g/i.test(f.type) || /\.(jpe?g|png|tiff?)$/i.test(f.name));
    });
    if (zips.length) { zips.forEach(addZip); }
    if (!imgs.length) return;
    imgs.forEach(function (f) {
      state.items.push(newItem(f.name, f, null));
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
        return /^(image|application\/octet-stream)/.test(e.blob.type || '') &&
               /\.(jpe?g|png|tiff?)$/i.test(e.path) && !/^__MACOSX/.test(e.path);
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
          state.items.push(newItem(e.name, e.blob, 'zip:' + e.path));
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
          state.items.push(newItem(pick.name, blob, pick.id));
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
      setProgress(true, msg);
    }).then(function (res) {      state.csvs = (res.csvs || []).filter(Boolean);
      res.items.forEach(function (it) {
        state.items.push(newItem(it.name, it.blob, it.driveId));
      });
      setProgress(false);
      render();
      startQueue();
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
      fullDataKept: false
    };
  }

  // ------------------------------------------------------------- processing

  function setProgress(on, msg, frac) {
    ui.progressWrap.hidden = !on;
    ui.progressText.textContent = msg || '';
    if (frac != null) ui.progressFill.style.width = Math.round(frac * 100) + '%';
  }

  async function startQueue() {
    if (state.busy) return;
    state.busy = true;
    var queue = state.items.filter(function (it) { return it.status === 'queued'; });
    var done = 0;
    for (var i = 0; i < queue.length; i++) {
      var it = queue[i];
      it.status = 'processing';
      QDGrid.updateCard(it);
      setProgress(true, 'Processing ' + (i + 1) + '/' + queue.length + ' — ' + it.name, i / queue.length);
      try {
        await processOne(it);
      } catch (e) {
        it.status = 'failed';
        it.reason = String(e.message || e);
        console.error('failed', it.name, e);
      }
      done++;
      QDGrid.updateCard(it);
      renderStats();
    }
    setProgress(false);
    state.busy = false;
    ui.exportBtn.disabled = false;
  }

  async function decodeScaled(it, targetW) {
    var bmp = await createImageBitmap(it.blob, { imageOrientation: 'from-image' });
    var natW = bmp.width, natH = bmp.height;
    var scale = Math.min(1, targetW / bmp.width);
    var w = Math.max(2, Math.round(bmp.width * scale));
    var h = Math.max(2, Math.round(bmp.height * scale));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    return { cv: cv, natW: natW, natH: natH };
  }

  async function processOne(it) {
    if (!it.meta) it.meta = QDMeta.joinMeta(it.name, state.csvs);
    if (!it.exif) it.exif = await QDExif.fromBlob(it.blob);

    var dec = await decodeScaled(it, USE_WIDTH);
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
      var quadFull = det.quad.map(function (c) {
        return { x: c.x * fac, y: c.y * fac };
      });
      det.quadFull = quadFull;
      it.source = 'auto';
      it.status = 'done';
      await makeCrop(it, quadFull, 'auto');
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

  /** Warp the source image through `quad` into a square JPEG blob + thumbnail. */
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
    it.thumbURL = thumbDataUrl(outCv, 340);
    if (it.previewURL) URL.revokeObjectURL(it.previewURL);
    it.previewURL = URL.createObjectURL(it.cropBlob);
    it.cropCanvas = null; // release the full crop canvas (blob retained)
  }

  function sideForQuad(quad, maxSide) {
    var lens = [0, 1, 2, 3].map(function (i) {
      var a = quad[i], b = quad[(i + 1) % 4];
      return Math.hypot(b.x - a.x, b.y - a.y);
    });
    var mean = lens.reduce(function (a, b) { return a + b; }, 0) / 4;
    var side = Math.round(Math.min(maxSide || 1600, Math.max(500, mean)));
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
    if (!item.det) return; // still scanning
    if (QDGrid.tierOf(item) === 'ok') {
      openPreview(item);
      return;
    }
    // review / manual / failed → review page: the full photo with the
    // suggested box and draggable corner markers
    QDEditor.open(item, function (quad) { reCropManual(item, quad); });
  }

  function openPreview(item) {
    ui.previewTitle.textContent = item.name +
      (item.source === 'manual' ? ' (manual)' : ' — ' + Math.round(item.conf * 100) + '%');
    if (item.previewURL) {
      // item.previewURL is owned by the item (makeCrop revokes and replaces
      // it when the crop is rebuilt) — never revoke or replace it here
      ui.previewImg.src = item.previewURL;
    }
    ui.previewMeta.textContent = JSON.stringify({
      confidence: it_conf(item), flags: item.flags || [],
      corners: item.corners, meta: item.meta, exif: item.exif,
      metrics: item.det && item.det.metrics, timeMs: item.det && item.det.diagnostics && item.det.diagnostics.timeMs
    }, null, 1);
    ui.previewDialog.showModal();
  }
  function it_conf(item) { return item.conf ? Math.round(item.conf * 1000) / 1000 : null; }

  function render() {
    ui.grid.innerHTML = '';
    state.items.forEach(function (item) {
      ui.grid.appendChild(QDGrid.render(item));
    });
    renderStats();
  }

  function renderStats() {
    var n = QDGrid.updateStats(state.items);
    var ok = n.auto, review = n.review, manual = n.manual, failed = n.failed;
    var total = ok + review + manual + failed;
    if (!total) { ui.stats.hidden = true; ui.exportBtn.textContent = '⬇ Export ZIP'; return; }
    ui.stats.hidden = false;
    var ready = state.items.filter(isExportable).length;
    ui.stats.innerHTML =
      '<span><b>' + ok + '</b> auto-accepted</span>' +
      '<span><b>' + review + '</b> suggested review</span>' +
      '<span><b>' + manual + '</b> need manual corners</span>' +
      '<span><b>' + failed + '</b> no frame found</span>' +
      '<span><b>' + total + '</b> total</span>' +
      '<span>· <b>' + ready + '</b> ready for export</span>';
    ui.exportBtn.textContent = '⬇ Export ZIP (' + ready + ')';
    ui.exportBtn.title = 'Includes auto crops at ≥ 80% confidence and every manually adjusted one';
    ui.exportBtn.disabled = !state.items.length;
  }

  /** An item qualifies for export on its own merits — no manual ticking. */
  function isExportable(it) {
    return !!it.cropBlob && (it.source === 'manual' || (it.ok && it.conf >= 0.8));
  }

  function doExport() {
    var sel = state.items.filter(isExportable);
    if (!sel.length) {
      alert('No images ready to export.\n\n'
        + 'Crops are included automatically when confidence is at least 80%.\n'
        + 'For the red/amber ones, click the thumbnail and adjust the corner\n'
        + 'markers — a manually adjusted crop is always included.');
      return;
    }
    var skipped = state.items.length - sel.length;
    setProgress(true, 'Building ZIP…', null);
    QDExport.exportZip(sel, state.items).then(function (size) {
      setProgress(false);
      alert(sel.length + ' crop' + (sel.length === 1 ? '' : 's') + ' exported.'
        + (skipped ? '\n\n' + skipped + ' image' + (skipped === 1 ? '' : 's')
          + ' not included (confidence < 80% and not manually adjusted) — they are listed in manifest.csv.' : ''));
      console.log('zip ready:', size);
    }).catch(function (e) { setProgress(false); alert(String(e.message || e)); });
  }

  function clearAll() {
    if (state.items.length && !confirm('Discard all ' + state.items.length + ' images?')) return;
    state.items = [];
    state.csvs = [];
    render();
  }

  function openSettings() {
    ui.clientIdInput.value = QDDrive.getClientId();
    ui.settingsDialog.showModal();
  }
  function saveSettings() {
    QDDrive.setConfig(ui.clientIdInput.value, QDDrive.getApiKey());
    ui.settingsDialog.close();
  }

  document.addEventListener('DOMContentLoaded', init);

  // debug/testing hook
  window.__qd = {
    items: state,
    reCropManual: reCropManual
  };
})(typeof self !== 'undefined' ? self : this);
