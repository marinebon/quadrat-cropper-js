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
    UI.dialog.addEventListener('close', releaseSrc);
    document.getElementById('btnEditorApply').addEventListener('click', apply);
    UI.lockSq = document.getElementById('editorLockSquare');
    if (UI.lockSq) {
      try { UI.lockSq.checked = localStorage.getItem('quadrat.lockSquare') !== '0'; } catch (e) { /* private mode */ }
      UI.lockSq.addEventListener('change', function () {
        try { localStorage.setItem('quadrat.lockSquare', UI.lockSq.checked ? '1' : '0'); } catch (e) { /* private mode */ }
      });
    }
    UI.prev = document.getElementById('btnEditorPrev');
    UI.next = document.getElementById('btnEditorNext');
    UI.pos = document.getElementById('editorPos');
    UI.prev.addEventListener('click', function () { navigate(-1); });
    UI.next.addEventListener('click', function () { navigate(1); });
    document.getElementById('btnEditorReset').addEventListener('click', function () {
      state.quad = clonesQuad(autoQuadOf(state.item)) || defaultQuad();
      draw(); schedulePreview();
    });

    UI.img.addEventListener('load', function () {
      state.imgW = UI.img.naturalWidth;
      state.imgH = UI.img.naturalHeight;
      if (!state.quad) state.quad = defaultQuad();
      clampQuad();
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

  // showModal() focuses the first button (Reset), so a plain Enter used to
  // reset the markers instead of applying. Focus Apply after every open.
  function focusApply() {
    var b = document.getElementById('btnEditorApply');
    if (b) b.focus();
  }

  /**
   * Previous / next photo without leaving the editor. Markers that were moved
   * are applied first (same as Apply), so a batch can be reviewed in one pass;
   * untouched photos are left as they are. `nav` comes from app.js:
   * { pos, total, go(dir) } — go() opens the neighbour in this same dialog.
   */
  function navigate(dir) {
    var nav = state.nav;
    if (!nav || !state.item) return;
    var target = nav.pos - 1 + dir;
    if (target < 0 || target >= nav.total) return;
    // only markers the user actually dragged count as an edit: a "no frame"
    // photo opens with a default square, and merely passing through it must
    // not turn that square into a manual crop
    if (state.touched && state.quad && state.appliedCb) state.appliedCb(clonesQuad(state.quad));
    nav.go(dir);
  }

  function open(item, appliedCb, nav) {
    state.item = item;
    state.appliedCb = appliedCb;
    state.nav = nav || null;
    state.touched = false;
    if (UI.pos) {
      UI.pos.textContent = nav ? nav.pos + ' / ' + nav.total : '';
      UI.prev.disabled = !nav || nav.pos <= 1;
      UI.next.disabled = !nav || nav.pos >= nav.total;
      UI.prev.hidden = UI.next.hidden = !nav;
    }
    state.quad = clonesQuad(
      (item.corners && item.corners.length === 4) ? item.corners : autoQuadOf(item));
    UI.title.textContent = 'Manual corner review — ' + item.name + (item.excluded ? ' (excluded)' : '');
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
      // showModal() throws on an already-open dialog (prev/next navigation)
      if (!UI.dialog.open) UI.dialog.showModal();
      focusApply();
      return; // the img 'load' handler draws markers + preview
    }
    // Same photo re-opened: no 'load' event fires, so redraw explicitly.
    // Otherwise the overlay still shows the markers from the previous visit
    // (e.g. moved, then closed without Apply) while state.quad was reset to
    // the item's corners — the handles you see are not the ones you drag.
    if (!state.quad && state.imgW) state.quad = defaultQuad();
    if (state.imgW) clampQuad();
    if (!UI.dialog.open) UI.dialog.showModal();
    focusApply();
    resizeCanvas();
    schedulePreview();
  }

  function close() { UI.dialog.close(); }
  // release the cached full-resolution pixels whenever the dialog closes
  // (Close button, Esc, or Apply)
  function releaseSrc() { state.src = null; state.srcFor = null; }

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

  /**
   * Starting markers when detection found no frame: a centred square of
   * half the short side (the protocol centres the opening in the shot).
   * Previously nothing was drawn until a first click on the photo, so a
   * failed item opened as a bare photo with no visible way to start.
   */
  function defaultQuad() {
    var s = Math.min(state.imgW, state.imgH) * 0.5;
    var cx = state.imgW / 2, cy = state.imgH / 2;
    return [
      { x: cx - s / 2, y: cy - s / 2 },
      { x: cx + s / 2, y: cy - s / 2 },
      { x: cx + s / 2, y: cy + s / 2 },
      { x: cx - s / 2, y: cy + s / 2 }
    ];
  }

  /** Bring every marker inside the photo so it can always be grabbed
   * (a corner outside the visible image could not be clicked to move it). */
  function clampQuad() {
    if (!state.quad || !state.imgW) return;
    state.quad = state.quad.map(function (c) {
      return { x: Math.max(0, Math.min(state.imgW - 1, c.x)),
               y: Math.max(0, Math.min(state.imgH - 1, c.y)) };
    });
  }

  // ---- square lock -------------------------------------------------------
  // The opening is a square, so by default a dragged corner can only resize /
  // rotate the square: the OPPOSITE corner stays put and the other two are
  // rebuilt from the diagonal. Dragging inside the square moves it whole.
  // "Keep square" off = free corners (old behaviour).
  function squareLocked() { return !UI.lockSq || UI.lockSq.checked; }

  function inside(q) {
    return q.every(function (c) { return c.x >= 0 && c.y >= 0 && c.x <= state.imgW - 1 && c.y <= state.imgH - 1; });
  }

  /** Square with corner i at P and the opposite corner fixed (TL,TR,BR,BL order kept). */
  function squareFromDiagonal(q, i, P) {
    var O = q[(i + 2) % 4];
    var cx = (O.x + P.x) / 2, cy = (O.y + P.y) / 2;
    var hx = P.x - cx, hy = P.y - cy;          // centre → dragged corner
    var rx = -hy, ry = hx;                     // that vector turned 90° (next corner, clockwise on screen)
    var out = [];
    out[i] = { x: P.x, y: P.y };
    out[(i + 1) % 4] = { x: cx + rx, y: cy + ry };
    out[(i + 2) % 4] = { x: O.x, y: O.y };
    out[(i + 3) % 4] = { x: cx - rx, y: cy - ry };
    return out;
  }

  function pointInQuad(q, x, y) {
    var inside = false;
    for (var a = 0, b = 3; a < 4; b = a++) {
      if (((q[a].y > y) !== (q[b].y > y)) &&
          (x < (q[b].x - q[a].x) * (y - q[a].y) / (q[b].y - q[a].y) + q[a].x)) inside = !inside;
    }
    return inside;
  }

  function onDown(e) {
    if (!state.quad) {
      state.quad = defaultQuad();
      draw(); redrawPreview();
    }
    var p = evPos(e);
    var hit = hitHandle(p.x, p.y);
    if (hit < 0 && squareLocked() && pointInQuad(state.quad, p.x, p.y)) {
      hit = 4;                                  // 4 = move the whole square
      state.dragFrom = p; state.dragQuad = clonesQuad(state.quad);
    }
    if (hit >= 0) {
      state.dragging = hit;
      UI.overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }

  function onMove(e) {
    if (state.dragging < 0) {
      // cursor hint: grab inside the square when it can be moved
      if (state.quad && squareLocked()) {
        var h = evPos(e);
        UI.overlay.style.cursor = hitHandle(h.x, h.y) >= 0 ? 'pointer' : (pointInQuad(state.quad, h.x, h.y) ? 'move' : '');
      }
      return;
    }
    var p = evPos(e);
    var P = { x: Math.max(0, Math.min(state.imgW - 1, p.x)), y: Math.max(0, Math.min(state.imgH - 1, p.y)) };
    var next;
    if (state.dragging === 4) {
      var dx = p.x - state.dragFrom.x, dy = p.y - state.dragFrom.y;
      next = state.dragQuad.map(function (c) { return { x: c.x + dx, y: c.y + dy }; });
    } else if (squareLocked()) {
      next = squareFromDiagonal(state.quad, state.dragging, P);
    } else {
      next = clonesQuad(state.quad);
      next[state.dragging] = P;
    }
    if (!inside(next)) return;                  // never let a corner leave the photo
    state.touched = true;
    state.quad = next;
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
    // Decode the full-resolution pixels once per opened photo. Previously a
    // full-size canvas + getImageData (~48 MB for a 12 MP TG-7 frame) was
    // allocated on every debounced drag step, which made dragging stutter
    // and churned memory on laptops/tablets used in the field.
    if (!state.src || state.srcFor !== state.urlFor) {
      var cv = document.createElement('canvas');
      cv.width = state.imgW; cv.height = state.imgH;
      cv.getContext('2d').drawImage(UI.img, 0, 0);
      state.src = { width: cv.width, height: cv.height,
                    data: cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data };
      state.srcFor = state.urlFor;
    }
    var warped = root.QuadratDetect.warpToSquare(state.src, q, side);
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
    // The dialog's help text promises "Enter apply & re-crop", but no
    // handler existed. Leave Enter alone on focused buttons so it keeps
    // activating Close/Reset natively.
    if (e.key === 'Enter' && !(e.target && e.target.tagName === 'BUTTON')) {
      e.preventDefault();
      apply();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      state.quad = clonesQuad(autoQuadOf(state.item)) || defaultQuad();
      draw(); schedulePreview();
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (state.dragging >= 0) return;
      e.preventDefault();
      navigate(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  root.QDEditor = { init: init, open: open };
})(typeof self !== 'undefined' ? self : this);
