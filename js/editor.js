/**
 * editor.js — manual corner-marker review.
 *
 * Shows the full source image, four draggable corner handles, a live
 * crop preview and Apply & re-crop. Works in ORIGINAL image pixel space.
 */
(function (root) {
  'use strict';

  var UI = {
    dialog: null, img: null, overlay: null, preview: null, info: null, title: null
  };
  var state = {
    item: null, quad: null,           // original-image px TL,TR,BR,BL
    dragging: -1, appliedCb: null,
    imgW: 0, imgH: 0
  };
  var HANDLE_R = 13;

  function init() {
    UI.dialog = document.getElementById('editorDialog');
    UI.img = document.getElementById('editorImg');
    UI.overlay = document.getElementById('editorOverlay');
    UI.preview = document.getElementById('cropPreview');
    UI.info = document.getElementById('editorInfo');
    UI.title = document.getElementById('editorTitle');
    UI.cropWrap = document.getElementById('cropPreviewWrap');

    document.getElementById('btnEditorClose').addEventListener('click', close);
    document.getElementById('btnEditorApply').addEventListener('click', apply);
    document.getElementById('btnEditorReset').addEventListener('click', function () {
      state.quad = clonesQuad(autoQuadOf(state.item));
      draw(); schedulePreview();
    });

    UI.img.addEventListener('load', function () {
      state.imgW = UI.img.naturalWidth;
      state.imgH = UI.img.naturalHeight;
      resizeCanvas();
      draw(); schedulePreview();
      setTimeout(resizeCanvas, 0);
    });
    window.addEventListener('resize', resizeCanvas);

    // pointer dragging on the overlay
    UI.overlay.addEventListener('pointerdown', onDown);
    UI.overlay.addEventListener('pointermove', onMove);
    UI.overlay.addEventListener('pointerup', onUp);
    UI.overlay.addEventListener('pointercancel', onUp);
  }

  function clonesQuad(q) { return q && q.map(function (c) { return { x: c.x, y: c.y }; }); }

  function autoQuadOf(item) {
    return (item.det && (item.det.quadFull || item.det.quad)) || null;
  }

  function open(item, appliedCb) {
    state.item = item;
    state.appliedCb = appliedCb;
    state.quad = clonesQuad(
      (item.corners && item.corners.length === 4) ? item.corners : autoQuadOf(item));
    UI.title.textContent = 'Manual corner review — ' + item.name;
    UI.info.textContent = [
      'Auto detection: ' + (item.ok ? Math.round(item.conf * 100) + '% confidence' : 'failed (' + (item.reason || 'no frame found') + ')'),
      autoQuadOf(item) ? 'Auto quad: ' + fmtQuad(autoQuadOf(item)) : 'No auto quad — place all four markers by dragging.',
      'Crop from: ' + (state.quad ? 'markers' : '—')
    ].join('\n');
    // fresh object-URL per item (do not reuse across items)
    if (state.urlFor !== item.id) {
      if (state.imgURL) URL.revokeObjectURL(state.imgURL);
      state.imgURL = URL.createObjectURL(item.blob);
      state.urlFor = item.id;
      UI.img.src = state.imgURL;
    }
    UI.dialog.showModal();
  }

  function close() { UI.dialog.close(); }

  function fmtQuad(q) {
    return q.map(function (c) { return '(' + Math.round(c.x) + ',' + Math.round(c.y) + ')'; }).join(' ');
  }

  /** Fit-canvas mapping: original px <-> displayed px. */
  function fit() {
    var rw = UI.img.getBoundingClientRect();
    return { sx: rw.width / state.imgW, sy: rw.height / state.imgH, ox: rw.left, oy: rw.top };
  }

  function resizeCanvas() {
    if (!state.imgW) return;
    var rw = UI.img.getBoundingClientRect();
    UI.overlay.width = Math.round(rw.width * devicePixelRatio);
    UI.overlay.height = Math.round(rw.height * devicePixelRatio);
    UI.overlay.style.width = rw.width + 'px';
    UI.overlay.style.height = rw.height + 'px';
    draw();
  }

  function draw() {
    if (!UI.overlay.width || !state.quad) return;
    var ctx = UI.overlay.getContext('2d');
    var dpr = devicePixelRatio || 1;
    var f = fit();
    ctx.setTransform(dpr * f.sx, 0, 0, dpr * f.sy, 0, 0);
    ctx.clearRect(0, 0, state.imgW, state.imgH);

    // quad outline
    ctx.beginPath();
    state.quad.forEach(function (c, i) {
      if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
    });
    ctx.closePath();
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 3 / f.sx;
    ctx.stroke();
    // handles
    state.quad.forEach(function (c, i) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, HANDLE_R / f.sx, 0, Math.PI * 2);
      ctx.fillStyle = ['#4af', '#4fa', '#f84', '#f4a'][i];
      ctx.fill();
      ctx.strokeStyle = '#0009';
      ctx.lineWidth = 2 / f.sx;
      ctx.stroke();
    });
  }

  function hitHandle(mx, my) {
    var f = fit();
    for (var i = 0; i < 4; i++) {
      var c = state.quad[i];
      if (Math.hypot((mx - c.x) * f.sx, (my - c.y) * f.sy) <= HANDLE_R + 6) return i;
    }
    return -1;
  }

  function evPos(e) {
    var r = UI.overlay.getBoundingClientRect();
    var f = fit();
    return { x: (e.clientX - f.ox) / f.sx, y: (e.clientY - f.oy) / f.sy };
  }

  function onDown(e) {
    if (!state.quad) {
      // create markers on first click if none
      state.quad = [
        { x: state.imgW * 0.25, y: state.imgH * 0.25 },
        { x: state.imgW * 0.75, y: state.imgH * 0.25 },
        { x: state.imgW * 0.75, y: state.imgH * 0.75 },
        { x: state.imgW * 0.25, y: state.imgH * 0.75 }
      ];
      draw(); redrawPreview();
    }
    var p = evPos(e);
    var hit = hitHandle(p.x, p.y);
    if (hit >= 0) {
      state.dragging = hit;
      UI.overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }

  function onMove(e) {
    if (state.dragging < 0) return;
    var p = evPos(e);
    state.quad[state.dragging] = {
      x: Math.max(0, Math.min(state.imgW - 1, p.x)),
      y: Math.max(0, Math.min(state.imgH - 1, p.y))
    };
    draw();
    schedulePreview();
  }

  function onUp() { state.dragging = -1; }

  /** Debounced heavy preview warp while dragging. */
  function schedulePreview() {
    if (state.previewTimer) clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(function () {
      state.previewTimer = null;
      redrawPreview();
    }, 160);
  }

  function redrawPreview() {
    var ctx = UI.preview.getContext('2d');
    ctx.clearRect(0, 0, UI.preview.width, UI.preview.height);
    if (!state.quad || !state.imgW || !UI.img.complete) return;
    var side = Math.max(UI.preview.width, 300);
    var q = state.quad;
    var Hm = root.QuadratDetect.solveH([
      { src: { x: 0, y: 0 }, dst: q[0] },
      { src: { x: side, y: 0 }, dst: q[1] },
      { src: { x: side, y: side }, dst: q[2] },
      { src: { x: 0, y: side }, dst: q[3] }
    ]);
    if (!Hm) return;
    var cv = document.createElement('canvas');
    cv.width = state.imgW; cv.height = state.imgH;
    cv.getContext('2d').drawImage(UI.img, 0, 0);
    var data = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    var warped = root.QuadratDetect.warpToSquare(
      { width: cv.width, height: cv.height, data: data }, q, side);
    var outCv = document.createElement('canvas');
    outCv.width = side; outCv.height = side;
    var outData = new ImageData(new Uint8ClampedArray(warped.buffer), side, side);
    outCv.getContext('2d').putImageData(outData, 0, 0);
    ctx.drawImage(outCv, 0, 0, UI.preview.width, UI.preview.height);
  }

  /** Apply: replace the item's corners and trigger the provided re-crop callback. */
  function apply() {
    if (!state.quad) return;
    var ov = clonesQuad(state.quad);
    UI.dialog.close();
    state.appliedCb && state.appliedCb(ov);
  }

  document.addEventListener('keydown', function (e) {
    if (!UI.dialog || !UI.dialog.open) return;
    if (e.key === 'r' || e.key === 'R') {
      state.quad = clonesQuad(autoQuadOf(state.item));
      draw(); schedulePreview();
    }
  });

  root.QDEditor = { init: init, open: open };
})(typeof self !== 'undefined' ? self : this);
