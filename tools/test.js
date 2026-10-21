/* Node harness: run quadrat detector on sample images, save overlays + crops. */
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');
const QD = require('../js/qd.js');

// optional CLI overrides: node test.js [rawDir] [outDir]
const RAW_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'raw'));
const OUT_DIR = path.resolve(process.argv[3] || path.join(__dirname, '..', 'results'));

function decodeJpeg(file) {
  const buf = fs.readFileSync(file);
  const raw = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 });
  return { width: raw.width, height: raw.height, data: new Uint8Array(raw.data) };
}

function encodeJpeg(rgba, w, h, q) {
  return jpeg.encode({ data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width: w, height: h }, q).data;
}

// draw mask overlay + detected lines + quad on the scaled image
function overlay(scaled, mask, det) {
  const { width: W, height: H, data } = scaled;
  const out = new Uint8Array(W * H * 4);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (mask[i]) {
      // show green mask tinted magenta-ish to spot misclassification
      out[p] = (data[p] * 0.25 + 150 * 0.75) | 0;
      out[p + 1] = data[p + 1];
      out[p + 2] = (data[p + 2] * 0.25 + 220 * 0.75) | 0;
      out[p + 3] = 255;
    } else {
      out[p] = (data[p] * 0.4) | 0;
      out[p + 1] = (data[p + 1] * 0.4) | 0;
      out[p + 2] = (data[p + 2] * 0.4) | 0;
      out[p + 3] = 255;
    }
  }
  const setpx = (x, y, r, g, b) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) return;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const o = ((yi + dy) * W + xi + dx) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  };
  const lineTo = (l, x0, y0, x1, y1, r, g, b) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= n; i++) setpx(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, r, g, b);
  };
  (det.lines || []).forEach((l, idx) => {
    // draw fitted line across its support
    const t = l.dir, c = l.c;
    const half = (l.spread || 200) / 2;
    const col = idx < 2 ? [255, 90, 0] : [255, 255, 0];
    lineTo(l, c.x - t.x * half, c.y - t.y * half, c.x + t.x * half, c.y + t.y * half, col[0], col[1], col[2]);
    (l.pts || []).forEach(pt => setpx(pt.x, pt.y, col[0], col[1], col[2]));
  });
  if (det.scaledQuad) {
    for (let i = 0; i < 4; i++) {
      const a = det.scaledQuad[i], b = det.scaledQuad[(i + 1) % 4];
      lineTo(null, a.x, a.y, b.x, b.y, 255, 250, 90);
    }
    det.scaledQuad.forEach(c => setpx(c.x, c.y, 255, 0, 255));
  }
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = fs.readdirSync(RAW_DIR).filter(f => f.toUpperCase().endsWith('.JPG')).sort();
  const summary = [];
  for (const f of files) {
    try {
      const img = decodeJpeg(path.join(RAW_DIR, f));
      const det = QD.detectQuadrat(img, {});
      const S = det.scaled, mask = det.greenMask;
      const ov = S ? overlay(S, mask || new Uint8Array(S.width * S.height), det) : null;
      const ovBuf = ov ? encodeJpeg(ov, S.width, S.height, 72) : null;
      fs.writeFileSync(path.join(OUT_DIR, f.replace(/\.jpe?g$/i, '_ov.jpg')), ovBuf);
      let cropBuf = null;
      if (det.ok && det.quad) {
        const side = Math.round(Math.max.apply(null, det.metrics.sideLens) / det.scale);
        const warped = QD.warpToSquare(img, det.quad.map(c => ({ x: Math.max(0, Math.min(img.width - 1, c.x)), y: Math.max(0, Math.min(img.height - 1, c.y)) })), Math.min(1500, Math.max(600, side)));
        cropBuf = encodeJpeg(warped, warped.length / (4 * Math.min(1500, Math.max(600, side))) | 0, 0, 85);
        // re-encode properly: compute side from array length
        const sidePx = Math.round(Math.sqrt(warped.length / 4));
        cropBuf = encodeJpeg(warped, sidePx, sidePx, 85);
      }
      if (cropBuf) fs.writeFileSync(path.join(OUT_DIR, f.replace(/\.jpe?g$/i, '_crop.jpg')), cropBuf);
      summary.push({
        file: f, ok: det.ok, conf: det.confidence.toFixed(3),
        parts: Object.fromEntries(Object.entries(det.confParts || {}).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])),
        flags: det.flags || [],
        diag: det.diagnostics.reason || null,
        sideLens: det.metrics ? det.metrics.sideLens && det.metrics.sideLens.map(x => Math.round(x)) : null,
        timeMs: det.diagnostics.timeMs
      });
      console.log(`${f}  ok=${det.ok}  conf=${det.confidence.toFixed(3)}  ${det.flags.join(' | ') || (det.diagnostics.reason || 'clean')}`);
    } catch (e) {
      console.error(f, 'ERROR', e.message);
      summary.push({ file: f, error: e.message + e.stack.split('\n')[1] });
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('done');
})();
