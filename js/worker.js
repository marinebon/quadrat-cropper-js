/**
 * worker.js — runs the whole per-photo pipeline off the main thread:
 * decode → detect → best-fit square → warp → JPEG encode → thumbnail.
 *
 * app.js keeps a pool of these (one per spare CPU core), so a batch is
 * processed in parallel and the page stays responsive. The batch-level
 * checks (typical size, flags/confidence caps) stay in app.js because they
 * need every photo's result.
 *
 * in:  { id, blob, maxSide, maxMP }
 * out: { id, ok, det, geom, natW, natH, side, cropBlob, thumbBlob, error }
 */
/* global importScripts, QuadratDetect, OffscreenCanvas */
importScripts('qd.js');

var QD = self.QuadratDetect;
var THUMB = 340;

function sideForQuad(q, maxSide) {
  var mean = 0;
  for (var i = 0; i < 4; i++) {
    var a = q[i], b = q[(i + 1) % 4];
    mean += Math.hypot(b.x - a.x, b.y - a.y) / 4;
  }
  return Math.round(Math.min(maxSide || 1600, Math.max(500, mean)));
}

/** Small, structured-clone-friendly copy of the detection (drops pixel buffers). */
function slimDet(det) {
  return {
    ok: !!det.ok,
    confidence: det.confidence || 0,
    quad: det.quad || null,
    flags: det.flags || [],
    metrics: det.metrics || {},
    diagnostics: det.diagnostics ? {
      reason: det.diagnostics.reason || null,
      timeMs: det.diagnostics.timeMs,
      color: det.diagnostics.color
    } : {}
  };
}

function thumbFit(src, w, h, letterbox) {
  var t = new OffscreenCanvas(THUMB, THUMB), ctx = t.getContext('2d');
  if (letterbox) {
    ctx.fillStyle = '#0b1014'; ctx.fillRect(0, 0, THUMB, THUMB);
    var s = Math.min(THUMB / w, THUMB / h);
    ctx.drawImage(src, (THUMB - w * s) / 2, (THUMB - h * s) / 2, w * s, h * s);
  } else {
    ctx.drawImage(src, 0, 0, THUMB, THUMB);
  }
  return t.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
}

async function processPhoto(msg) {
  var bmp = await createImageBitmap(msg.blob, { imageOrientation: 'from-image' });
  var natW = bmp.width, natH = bmp.height;
  var mp = natW * natH / 1e6;
  var scale = mp > msg.maxMP ? Math.sqrt(msg.maxMP / mp) : 1;
  var w = Math.max(2, Math.round(natW * scale)), h = Math.max(2, Math.round(natH * scale));
  var cv = new OffscreenCanvas(w, h);
  var ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  var id = ctx.getImageData(0, 0, w, h);
  var det = QD.detectQuadrat({ width: w, height: h, data: new Uint8Array(id.data.buffer) }, {});
  var out = { id: msg.id, ok: !!det.ok, det: slimDet(det), natW: natW, natH: natH };

  if (!det.ok) {
    out.thumbBlob = await thumbFit(cv, w, h, true);
    bmp.close();
    return out;
  }

  // detection px → original px, then the best-fit square kept inside the photo
  var fac = natW / w;
  var quadRaw = det.quad.map(function (c) { return { x: c.x * fac, y: c.y * fac }; });
  var sq = QD.fitSquare(quadRaw);
  // shrink by the inset (% of side) so the PVC rim stays out of the crop
  var inset = msg.inset || 0;
  var ins = QD.fitInside(inset ? QD.scaleQuad(sq.quad, 1 - inset / 100) : sq.quad, natW, natH);
  var q = ins.quad;
  out.det.quadRaw = quadRaw;
  out.det.quadFull = q;
  out.geom = { quad: q, side: Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y),
               residual: sq.residual, moved: ins.moved, shrunk: ins.shrunk, inset: inset };

  // warp from ORIGINAL pixels (re-draw only in the rare >maxMP case)
  var src = id;
  if (scale < 1) {
    var full = new OffscreenCanvas(natW, natH), fctx = full.getContext('2d', { willReadFrequently: true });
    fctx.drawImage(bmp, 0, 0);
    src = fctx.getImageData(0, 0, natW, natH);
  }
  bmp.close();
  var side = sideForQuad(q, msg.maxSide);
  var warped = QD.warpToSquare({ width: src.width, height: src.height, data: src.data }, q, side);
  var oc = new OffscreenCanvas(side, side);
  oc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(warped.buffer), side, side), 0, 0);
  out.side = side;
  out.cropBlob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  out.thumbBlob = await thumbFit(oc, side, side, false);
  return out;
}

self.onmessage = function (e) {
  processPhoto(e.data).then(function (out) {
    self.postMessage(out);
  }, function (err) {
    self.postMessage({ id: e.data.id, error: String(err && err.message || err) });
  });
};
