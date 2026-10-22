/**
 * qd.js — Quadrat detection + warping core.
 *
 * Pure, DOM-free JS so the same file runs in Node (validation harness)
 * and in the browser (the app). Operates on RGBA Uint8Array buffers.
 *
 * Approach:
 *  1. Downscale source to a working resolution (~1152 px wide).
 *  2. Build a "PVC" mask from measured hue/sat/value bands, once per known
 *     tube color (mint green hue ~135-150 deg, or yellow hue ~50-65 deg);
 *     the best-confidence detection wins.
 *  3. Grow the mask through bright, weakly-tinted "highlight" pixels (direct
 *     sun blows the mint PVC out to near-white; the fill is bounded by the
 *     masked rims of the tube).
 *  4. Cast rays from the frame middle as the origin — the protocol centers
 *     the quadrat in the shot, so the middle must sit inside an enclosed
 *     pocket of the mask (interior clutter stripped away); otherwise the
 *     image is flagged and detection stops. Each ray keeps up to two
 *     sufficiently long mask runs (gap-tolerant) as points on INNER edges
 *     of the quadrat opening (ignores small moss specks / outer structure).
 *  5. Sequential RANSAC fits up to 8 inner-edge lines, merging parallel
 *     near-duplicates (the two rims of the same tube); group them into two
 *     orientation families (mod PI on tangent angle) and pick best pair each.
 *  6. Inner corners = intersections of the 4 chosen consecutive lines.
 *  7. Confidence: per-edge support, tube-width consistency, squareness,
 *     parallelism, PVC coverage outside the opening, opening cleanliness,
 *     and absolute-size sanity.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.QuadratDetect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Detector version — bumped when qd.js or its calling contract changes.
  // app.js surfaces this in the page title / header so users can confirm
  // they are running a fresh build (not a cached one).
  var VERSION = '1.4.0';

  var DEFAULTS = {
    workWidth: 1152,
    nRays: 128,
    hueMin: 118, hueMax: 172,
    satMin: 0.13,
    valMin: 0.045,
    highlightHueMin: 100, highlightHueMax: 200,
    minRunSw: 0.012,
    rayGap: 9,
    rayTol: 2.6,
    minSupport: 4,
    refineIters: 2,
    autoThreshold: 0.80,
    reviewThreshold: 0.55,
  };

  /**
   * Known quadrat tube colors.  Each defines the mask hue/sat/value band and
   * the highlight-tint family used by floodHighlights (sun-blown tube pixels
   * stay weakly tinted toward their own color).  detectQuadrat runs the full
   * pipeline once per color and keeps the best-confidence result — the mask
   * bands never mix, so green algae cannot pollute a yellow pass and pale
   * sand cannot pollute a mint one.
   */
  var FRAME_COLORS = {
    mint: {
      color: 'mint',
      hueMin: 118, hueMax: 172, satMin: 0.13, valMin: 0.045,
      highlightHueMin: 100, highlightHueMax: 200,
    },
    yellow: {
      color: 'yellow',
      // measured on MONTEMAR yellow PVC: hue 47-66 p10-p90 in sun, up to ~74
      // in shade, so satMin 0.20. Pale sand / pearl-barnacle cream (hue 40-70)
      // stays in band but is speckled — the structural scoring rejects it.
      // hueMax can't drop below ~82: BAJO/MEDIO tubes reach hue ~80, and
      // green ulva begins at ~74, so hue alone cannot split tube from alga —
      // the structural scoring (RANSAC + opening probes) prunes instead.
      hueMin: 42, hueMax: 82, satMin: 0.20, valMin: 0.35,
      highlightHueMin: 25, highlightHueMax: 95,
    },
  };

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (p, q) { return p - q; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function polyArea(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) {
      var j = (i + 1) % pts.length;
      a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return a / 2;
  }

  function boxScale(src, outW, outH) {
    var sw = src.width, sh = src.height, sd = src.data;
    outW = Math.max(1, outW | 0); outH = Math.max(1, outH | 0);
    var od = new Uint8Array(outW * outH * 4);
    var stepX = sw / outW, stepY = sh / outH;
    for (var y = 0; y < outH; y++) {
      var sy0 = Math.floor(y * stepY), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * stepY));
      for (var x = 0; x < outW; x++) {
        var sx0 = Math.floor(x * stepX), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * stepX));
        var r = 0, g = 0, b = 0, n = 0;
        for (var yy = sy0; yy < sy1; yy++) {
          var rowOff = (yy * sw + sx0) * 4;
          for (var xx = sx0; xx < sx1; xx++) {
            r += sd[rowOff]; g += sd[rowOff + 1]; b += sd[rowOff + 2];
            rowOff += 4; n++;
          }
        }
        var o = (y * outW + x) * 4;
        od[o] = r / n; od[o + 1] = g / n; od[o + 2] = b / n; od[o + 3] = 255;
      }
    }
    return { width: outW, height: outH, data: od };
  }

  function buildMask(scaled, opts) {
    var W = scaled.width, H = scaled.height, d = scaled.data;
    var mask = new Uint8Array(W * H);
    var cx = 0, cy = 0, cnt = 0;
    for (var i = 0, p = 0; i < mask.length; i++, p += 4) {
      var r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255;
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var v = mx, s = mx > 0 ? (mx - mn) / mx : 0, h = -1;
      if (mx !== mn) {
        var df = mx - mn;
        if (mx === r) h = 60 * ((g - b) / df) % 360;
        else if (mx === g) h = 60 * ((b - r) / df) + 120;
        else h = 60 * ((r - g) / df) + 240;
        if (h < 0) h += 360;
      }
      if (h >= opts.hueMin && h <= opts.hueMax && s >= opts.satMin && v >= opts.valMin) {
        mask[i] = 1;
        cx += i % W; cy += (i / W) | 0; cnt++;
      }
    }
    return { mask: mask, centroid: cnt > 32 ? { x: cx / cnt, y: cy / cnt } : null, count: cnt };
  }

  /**
   * Direct-sun shots blow the mint PVC out to near-white (sat < 0.1, value 1),
   * so only thin shaded rims classify as mint and the ray casting loses whole
   * sides.  Grow the mask from classified-mint pixels through "highlight"
   * pixels (bright + weakly tinted toward mint) — the tube body is bounded by
   * its two masked rims, and interior/exterior rock is either too saturated
   * or too dark to qualify, so the fill stays on the PVC.
   */
  function floodHighlights(mask, W, H, scaled, opts) {
    var d = scaled.data, n = W * H;
    var queue = new Int32Array(n), head = 0, tail = 0;
    for (var i = 0; i < n; i++) if (mask[i]) queue[tail++] = i;
    while (head < tail) {
      var i2 = queue[head++];
      var x = i2 % W, y = (i2 / W) | 0;
      for (var k = 0; k < 4; k++) {
        var nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
        var ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var j = ny * W + nx;
        if (mask[j]) continue;
        var p = j * 4;
        var r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255;
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        var v = mx, s = mx > 0 ? (mx - mn) / mx : 0, h = -1;
        if (mx !== mn) {
          var df = mx - mn;
          if (mx === r) h = 60 * ((g - b) / df) % 360;
          else if (mx === g) h = 60 * ((b - r) / df) + 120;
          else h = 60 * ((r - g) / df) + 240;
          if (h < 0) h += 360;
        }
        // bright, weakly tinted (or fully blown neutral) — highlight candidate
        // tint family comes from the active tube color (opts.highlightHue*)
        if (v >= 0.6 && s <= 0.25 &&
            (h < 0 || (h >= (opts.highlightHueMin || 100) && h <= (opts.highlightHueMax || 200)))) {
          mask[j] = 1;
          queue[tail++] = j;
        }
      }
    }
  }

  /** Separable box min/max morph op (max=dilate, min=erode), radius r,
   *  sliding-window deque: O(W*H) regardless of r. */
  function morphMask(src, W, H, r, useMax) {
    var tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    var W2 = 2 * r + 1;
    var dq = new Int32Array(W2 > H ? W2 : H), dqVal = new Uint8Array(W2 > H ? W2 : H);
    var x, y, head, tail, v;
    // horizontal pass (deque holds indices of better-valued pixels)
    for (y = 0; y < H; y++) {
      head = tail = 0;
      var off = y * W;
      for (x = 0; x < W; x++) {
        v = src[off + x];
        if (useMax) { while (tail > head && dqVal[(tail - 1) % W2] <= v) tail--; }
        else { while (tail > head && dqVal[(tail - 1) % W2] >= v) tail--; }
        dq[tail % W2] = x; dqVal[tail % W2] = v; tail++;
        while (dq[head % W2] < x - r) head++;
        tmp[off + x] = dqVal[head % W2];
      }
    }
    // vertical pass
    for (x = 0; x < W; x++) {
      head = tail = 0;
      for (y = 0; y < H; y++) {
        v = tmp[y * W + x];
        if (useMax) { while (tail > head && dqVal[(tail - 1) % W2] <= v) tail--; }
        else { while (tail > head && dqVal[(tail - 1) % W2] >= v) tail--; }
        dq[tail % W2] = y; dqVal[tail % W2] = v; tail++;
        while (dq[head % W2] < y - r) head++;
        out[y * W + x] = dqVal[head % W2];
      }
    }
    return out;
  }

  /**
   * Zero out mask components that lie ENTIRELY inside the enclosed pocket
   * (they are interior clutter — barnacle cream, alga patches — not tube;
   * any structure attached to the frame's ring pokes out of the pocket and
   * is kept). Returns true when anything was removed.
   */
  function stripPocketBlobs(mask, W, H, plbl, pid) {
    var N = mask.length;
    var seen = new Uint8Array(N);
    var stack = new Int32Array(N);
    var comp = new Int32Array(N);
    var removed = false;
    for (var s0 = 0; s0 < N; s0++) {
      if (!mask[s0] || seen[s0] || plbl[s0] !== pid) continue;
      var head = 0, tail = 0, n = 0, inPocket = true;
      stack[tail++] = s0; seen[s0] = 1;
      while (head < tail) {
        var c = stack[head++];
        comp[n++] = c;
        if (plbl[c] !== pid) inPocket = false;
        var cx = c % W, cy = (c / W) | 0;
        if (cx > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[tail++] = c - 1; }
        if (cx < W - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[tail++] = c + 1; }
        if (cy > 0 && mask[c - W] && !seen[c - W]) { seen[c - W] = 1; stack[tail++] = c - W; }
        if (cy < H - 1 && mask[c + W] && !seen[c + W]) { seen[c + W] = 1; stack[tail++] = c + W; }
      }
      if (inPocket) {
        for (var k = 0; k < n; k++) mask[comp[k]] = 0;
        removed = true;
      }
    }
    return removed;
  }

  /**
   * Offset vector to the nearest free (non-mask) cell of `ring`, at or within
   * `maxR` of (ax, ay); [0, 0] when the anchor itself is free, [null, r] when
   * none is found inside the radius.
   */
  function findFreeNear(ring, W, H, ax, ay, maxR) {
    if (!ring[ay * W + ax]) return [0, 0];
    for (var r = 1; r <= maxR; r++) {
      for (var yy = ay - r; yy <= ay + r; yy++) {
        for (var xx = ax - r; xx <= ax + r; xx++) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if (yy !== ay - r && yy !== ay + r && xx !== ax - r && xx !== ax + r) continue;
          if (!ring[yy * W + xx]) return [xx - ax, yy - ay];
        }
      }
    }
    return [null, maxR];
  }

  /**
   * Ray origin: the geometric middle of the frame. The sampling protocol
   * centers the quadrat in the shot, so from the middle the tube wall must
   * be present in essentially every direction: 24 spokes march outward to
   * the first mask pixel; two spokes may fail (a sun-flared or occluded
   * section, a corner corridor), more means the middle is not within the
   * quadrat and the caller flags the image and stops. Floor clutter (in-band
   * barnacle cream, alga) is irrelevant — spokes stop at any wall — so
   * speckled openings pass. The middle itself may sit on a patch; a nearby
   * free cell (≤ 24 px) becomes the anchor, a solid mask mass fails.
   * Returns { x, y, within, wallHits, wallSpokes } or null when buried.
   */
  function centerOrigin(mask, W, H) {
    var cx = W >> 1, cy = H >> 1;
    var near = findFreeNear(mask, W, H, cx, cy, 24);
    if (near[0] === null) return null;
    var ax = cx + near[0], ay = cy + near[1];

    // spoke reach: corner diagonals of a centered opening sit farthest from
    // the middle (~0.42·sqrt(W·H) at a full-frame quadrat), so reach a bit
    // past that but stay well inside the image half-diagonal
    var K = 24, maxT = Math.round(0.55 * Math.sqrt(W * H)), hits = 0;
    for (var k = 0; k < K; k++) {
      var th = (k / K) * 2 * Math.PI;
      var dx = Math.cos(th), dy = Math.sin(th);
      var hit = false;
      for (var t = 4; t <= maxT; t += 2) {
        var xi = (ax + dx * t) | 0, yi = (ay + dy * t) | 0;
        if (xi < 0 || yi < 0 || xi >= W || yi >= H) break; // left the image
        if (mask[yi * W + xi]) { hit = true; break; }
      }
      if (hit) hits++;
    }
    // tolerate small breaches/occlusions AND floor specks (in-band barnacle
    // cream/kelp read as premature walls) — a middle genuinely outside the
    // opening shows edge-escapes / long open corridors instead
    return { x: ax, y: ay, within: hits >= K - 4, wallHits: hits, wallSpokes: K };
  }

  /**
   * Largest free pocket enclosed by the mask (border flood over a
   * ring-closed mask, the closing radius escalating while no sizable pocket
   * appears) — used to strip in-band floor blobs that lie fully inside the
   * opening (real tube structures always connect to the ring).
   * Returns { lbl, pocketId } or null when the ring admits no such pocket.
   */
  function originPocket(mask, W, H) {
    var diag = Math.sqrt(W * H);
    var minArea = Math.max(1200, 0.012 * W * H); // ignore speck-sized bubbles
    for (var ri = 0; ri <= 4; ri++) {
      var rad = ri === 0 ? 0 : Math.round(diag * (0.007 + 0.005 * (ri - 1)));
      var ringMask = rad ? morphMask(morphMask(mask, W, H, rad, true), W, H, rad, false) : mask;
      var lbl = new Int32Array(W * H); // 0 unvisited, 1 escaped-to-border, >=2 comp id
      var stack = new Int32Array(W * H);
      var top = 0;
      for (var x = 0; x < W; x++) {
        if (!ringMask[x]) { lbl[x] = 1; stack[top++] = x; }
        var b2 = (H - 1) * W + x;
        if (!ringMask[b2]) { lbl[b2] = 1; stack[top++] = b2; }
      }
      for (var y = 0; y < H; y++) {
        var lidx = y * W, ridx = y * W + W - 1;
        if (!ringMask[lidx]) { lbl[lidx] = 1; stack[top++] = lidx; }
        if (!ringMask[ridx]) { lbl[ridx] = 1; stack[top++] = ridx; }
      }
      while (top > 0) {
        var i2 = stack[--top];
        var ix = i2 % W, iy = (i2 / W) | 0;
        if (ix > 0 && !ringMask[i2 - 1] && !lbl[i2 - 1]) { lbl[i2 - 1] = 1; stack[top++] = i2 - 1; }
        if (ix < W - 1 && !ringMask[i2 + 1] && !lbl[i2 + 1]) { lbl[i2 + 1] = 1; stack[top++] = i2 + 1; }
        if (iy > 0 && !ringMask[i2 - W] && !lbl[i2 - W]) { lbl[i2 - W] = 1; stack[top++] = i2 - W; }
        if (iy < H - 1 && !ringMask[i2 + W] && !lbl[i2 + W]) { lbl[i2 + W] = 1; stack[top++] = i2 + W; }
      }
      var nComp = 1, compArea = [0, 0];
      for (var j = 0; j < lbl.length; j++) {
        if (lbl[j] || ringMask[j]) continue;
        nComp++;
        var head = 0, tail = 0;
        stack[tail++] = j; lbl[j] = nComp;
        while (head < tail) {
          var i3 = stack[head++];
          compArea[nComp] = (compArea[nComp] || 0) + 1;
          var ix2 = i3 % W, iy2 = (i3 / W) | 0;
          if (ix2 > 0 && !ringMask[i3 - 1] && !lbl[i3 - 1]) { lbl[i3 - 1] = nComp; stack[tail++] = i3 - 1; }
          if (ix2 < W - 1 && !ringMask[i3 + 1] && !lbl[i3 + 1]) { lbl[i3 + 1] = nComp; stack[tail++] = i3 + 1; }
          if (iy2 > 0 && !ringMask[i3 - W] && !lbl[i3 - W]) { lbl[i3 - W] = nComp; stack[tail++] = i3 - W; }
          if (iy2 < H - 1 && !ringMask[i3 + W] && !lbl[i3 + W]) { lbl[i3 + W] = nComp; stack[tail++] = i3 + W; }
        }
      }
      var bestComp = 0, bestArea = minArea;
      for (var cc = 2; cc <= nComp; cc++) {
        if (compArea[cc] > bestArea) { bestArea = compArea[cc]; bestComp = cc; }
      }
      if (bestComp) return { lbl: lbl, pocketId: bestComp };
    }
    return null;
  }

  /** Mask post-processing hook (currently: highlight-aware tube fill). */
  function floodHints(mk, scaled, opts) {
    floodHighlights(mk.mask, scaled.width, scaled.height, scaled, opts);
  }

  /**
   * Cast rays from `center`; up to two qualifying mask crossings are kept per
   * ray (the first, which in a blob-littered interior may be an in-band
   * alga/barnacle patch, and the next) so a ray blocked by interior clutter
   * still contributes a tube-rim point. Wrong candidates are pruned later by
   * the opening probes / quad scoring. Rays that ride a tube to the image
   * border get a borderRun hit (frame continues off-image).
   */
  function castRays(scaled, mask, center, opts) {
    var W = scaled.width, H = scaled.height;
    var minRun = Math.max(4, opts.minRunSw * Math.sqrt(W * H));
    var gapTol = opts.rayGap || 5; // tolerate mask holes inside a tube
    var step = 1.0, maxDim = Math.sqrt(W * W + H * H);
    var hits = [];
    for (var k = 0; k < opts.nRays; k++) {
      var th = (k / opts.nRays) * 2 * Math.PI;
      var dx = Math.cos(th), dy = Math.sin(th);
      var firstT = -1, greenTot = 0, gap = 0, band = [];
      var found1 = null; // first accepted crossing along this ray
      for (var t = step; t < maxDim; t += step) {
        var xi = (center.x + dx * t) | 0, yi = (center.y + dy * t) | 0;
        if (xi < 0 || yi < 0 || xi >= W || yi >= H) break; // left image: frame continuing off-frame
        var m = mask[yi * W + xi];
        if (m) {
          if (firstT < 0) firstT = t;
          greenTot += step;
          band.push({ x: xi, y: yi });
          gap = 0;
        } else if (firstT >= 0) {
          gap += step;
          if (gap > gapTol) {
            if (greenTot >= minRun) {
              // accepting crossing: inner-edge point = first mask pixel along ray
              var cand = { x: center.x + dx * firstT, y: center.y + dy * firstT, run: greenTot, band: band, angle: th };
              if (!found1) {
                found1 = cand;
                firstT = -1; greenTot = 0; gap = 0; band = [];
                continue;
              }
              hits.push(found1); hits.push(cand);
              found1 = null;
              break;
            }
            // rejected crossing (too small = speck): re-arm
            firstT = -1; greenTot = 0; gap = 0; band = [];
          }
        }
      }
      // ray survived to image border inside a tube — treat as reaching frame off-image
      if (found1) {
        if (greenTot >= minRun) found1.borderRun = true;
        hits.push(found1); // keep the lone first crossing anyway
      } else if (firstT >= 0 && greenTot >= minRun) {
        // rode a tube to (or past) the image border without completing a
        // crossing: frame continues off-image
        hits.push({ x: center.x + dx * firstT, y: center.y + dy * firstT, run: greenTot, band: band, angle: th, borderRun: true });
      }
    }
    return hits;
  }

  function fitLineFromPoints(pts) {
    var n = pts.length, cx = 0, cy = 0, i;
    for (i = 0; i < n; i++) { cx += pts[i].x; cy += pts[i].y; }
    cx /= n; cy /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < n; i++) {
      var ax = pts[i].x - cx, ay = pts[i].y - cy;
      sxx += ax * ax; syy += ay * ay; sxy += ax * ay;
    }
    var theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var dirx = Math.cos(theta), diry = Math.sin(theta);
    return { n: { x: -diry, y: dirx }, d: -diry * cx + dirx * cy, dir: { x: dirx, y: diry }, c: { x: cx, y: cy } };
  }

  function lineDist(l, p) { return Math.abs(l.n.x * p.x + l.n.y * p.y - l.d); }

  function intersect(l1, l2) {
    var det = l1.n.x * l2.n.y - l1.n.y * l2.n.x;
    if (Math.abs(det) < 1e-9) return null;
    var x = (l1.d * l2.n.y - l2.d * l1.n.y) / det;
    var y = (l2.d * l1.n.x - l1.d * l2.n.x) / det;
    return { x: x, y: y };
  }

  /** Sequential RANSAC over hit points. Returns lines (PCA-fit) sorted by inlier count desc.
   *  Near-duplicate parallel lines (same tube's inner/outer rims) are merged
   *  into the stronger one via the union of inliers so one tube yields one
   *  fitted edge; merging distance uses the median ray-crossing run
   *  (opts.rayMedRun) as a tube-width proxy. */
  function ransacLines(points, opts, W, H) {
    var remaining = points.slice();
    var lines = [];
    var tol = opts.rayTol;
    var mergeD = Math.max(8, (opts.rayMedRun || 0) * 1.3);
    for (var iter = 0; iter < 8 && remaining.length >= opts.minSupport; iter++) {
      var best = null;
      for (var i = 0; i < remaining.length; i++) {
        for (var j = i + 1; j < remaining.length; j++) {
          var p1 = remaining[i], p2 = remaining[j];
          var dx = p2.x - p1.x, dy = p2.y - p1.y;
          var len = Math.hypot(dx, dy);
          if (len < 0.25 * Math.min(W, H)) continue; // pairs must be far apart
          var nx = -dy / len, ny = dx / len;
          var dd = nx * p1.x + ny * p1.y;
          var c = 0;
          for (var q = 0; q < remaining.length; q++) {
            var r = Math.abs(remaining[q].x * nx + remaining[q].y * ny - dd);
            if (r < tol) c++;
          }
          if (!best || c > best.count) best = { i: i, j: j, count: c, nx: nx, ny: ny, dd: dd };
        }
      }
      if (!best || best.count < opts.minSupport) break;
      var inliers = [];
      for (var qq = 0; qq < remaining.length; qq++)
        if (Math.abs(remaining[qq].x * best.nx + remaining[qq].y * best.ny - best.dd) < tol) inliers.push(remaining[qq]);
      var l = fitLineFromPoints(inliers);
      for (var it = 0; it < opts.refineIters; it++) {
        var inl2 = [];
        for (var q2 = 0; q2 < remaining.length; q2++)
          if (lineDist(l, remaining[q2]) < tol) inl2.push(remaining[q2]);
        if (inl2.length < opts.minSupport) break;
        inliers = inl2;
        l = fitLineFromPoints(inl2);
      }
      // duplicate-tube merge: parallel to an existing line within a tube width
      var merged = false;
      for (var m = 0; m < lines.length; m++) {
        var e = lines[m];
        var dotp = Math.abs(e.dir.x * l.dir.x + e.dir.y * l.dir.y);
        if (dotp < 0.985) continue; // angle deviates > ~10deg
        if (lineDist(e, l.c) >= mergeD) continue;
        var union = e.inliers.concat(inliers);
        lines[m] = refitLine(fitLineFromPoints(union), union);
        merged = true;
        break;
      }
      function refitLine(base, pts2) {
        var mn = 1e9, mx = -1e9;
        for (var s = 0; s < pts2.length; s++) {
          var pr = (pts2[s].x - base.c.x) * base.dir.x + (pts2[s].y - base.c.y) * base.dir.y;
          if (pr < mn) mn = pr; if (pr > mx) mx = pr;
        }
        base.spread = mx - mn;
        base.inliers = pts2;
        return base;
      }
      if (merged) {
        remaining = remaining.filter(function (p) {
          return lines.every(function (e) { return lineDist(e, p) >= tol; });
        });
        continue;
      }
      if (inliers.length < opts.minSupport) break;
      var mn = 1e9, mx = -1e9;
      for (var s = 0; s < inliers.length; s++) {
        var pr = (inliers[s].x - l.c.x) * l.dir.x + (inliers[s].y - l.c.y) * l.dir.y;
        if (pr < mn) mn = pr; if (pr > mx) mx = pr;
      }
      l.spread = mx - mn;
      l.inliers = inliers;
      lines.push(l);
      remaining = remaining.filter(function (p) { return lineDist(l, p) >= tol; });
    }
    return lines;
  }

  function isGreenAt(scaled, mask, x, y, rad) {
    var W = scaled.width, H = scaled.height;
    var x0 = Math.max(0, (x - rad) | 0), y0 = Math.max(0, (y - rad) | 0);
    var x1 = Math.min(W - 1, (x + rad) | 0), y1 = Math.min(H - 1, (y + rad) | 0);
    var cnt = 0, tot = 0;
    for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) { tot++; if (mask[yy * W + xx]) cnt++; }
    return tot ? cnt / tot : 0;
  }

  function circleAngleDist(a, b) { // angles in [0, PI)
    var d = Math.abs(a - b);
    return Math.min(d, Math.PI - d);
  }

  /**
   * Main entry.
   * image: {width,height,data:RGBA}
   * options may pin a specific frame color via `color: 'mint' | 'yellow'`.
   * Returns { ok, confidence, quad(source px), scaledQuad, metrics, flags, diagnostics }
   *
   * The pipeline runs once per known tube color (mint, then yellow) and the
   * best-confidence detection wins; ties go to the earlier pass.  A single
   * pass can succeed on the "wrong" color via blown-out neutral highlights,
   * but the explicit band is more reliable, so both are always evaluated.
   */
  function detectQuadrat(image, options) {
    var opts = Object.assign({}, DEFAULTS, options || {});
    var t0 = Date.now();
    var srcW = image.width, srcH = image.height;
    var scale = Math.min(1, opts.workWidth / srcW);
    var scaled = scale < 1 ? boxScale(image, Math.round(srcW * scale), Math.round(srcH * scale))
                           : { width: image.width, height: image.height, data: image.data };

    var names = ['mint', 'yellow'];
    if (options && FRAME_COLORS[options.color]) names = [options.color];
    else if (options && (options.hueMin !== undefined || options.satMin !== undefined || options.valMin !== undefined)) {
      names = ['custom']; // caller pinned an explicit band — single pass
    }

    var best = null, bestName = null, bestConf = -1;
    for (var pi = 0; pi < names.length; pi++) {
      var nm = names[pi];
      var passOpts = (nm === 'custom')
        ? Object.assign({}, opts, { color: 'custom' })
        : Object.assign({}, opts, FRAME_COLORS[nm]);
      var res = runPass(scaled, passOpts, t0);
      res.diagnostics.color = passOpts.color;
      if (res.confidence > bestConf + 1e-9) { best = res; bestName = passOpts.color; bestConf = res.confidence; }
    }
    if (best) best.metrics.frameColor = bestName;
    return best;
  }

  /** One full detection pipeline over `scaled`, parameterized by tube color. */
  function runPass(scaled, opts, t0) {
    var srcW = scaled.width, srcH = scaled.height;
    var scale = 1;
    var W = scaled.width, H = scaled.height;

    var mk = buildMask(scaled, opts);
    floodHints(mk, scaled, opts);
    // Ray origin: the geometric middle of the frame (see centerOrigin) — the
    // protocol centers the quadrat in the shot, so the tube wall must be
    // visible from the middle in essentially every direction; otherwise the
    // image is flagged and detection stops (within stays false below).
    var center = { x: W / 2, y: H / 2 };
    var org = centerOrigin(mk.mask, W, H);
    var rays = [];
    // Barnacle-cream / alga patches inside the color band litter the opening:
    // they steal rays (their edges seed bogus RANSAC lines). With an enclosed
    // pocket known (best-effort; the middle-edge spokes already gate the
    // origin), strip mask components that lie fully inside it.
    if (org && org.within) {
      var pk = originPocket(mk.mask, W, H);
      if (pk && stripPocketBlobs(mk.mask, W, H, pk.lbl, pk.pocketId) && org) {
        pk = originPocket(mk.mask, W, H) || pk;
      }
      rays = castRays(scaled, mk.mask, { x: org.x, y: org.y }, opts).filter(Boolean);
    }

    // denser, more permissive retry in hard lighting (a more forgiving mask
    // can also restore the wall spokes and rescue the origin)
    if (!org || !org.within || rays.length < opts.nRays * 0.4) {
      var opts2 = Object.assign({}, opts, { nRays: opts.nRays * 2, satMin: opts.satMin * 0.8, valMin: Math.max(0.05, opts.valMin * 0.8) });
      var mk2 = buildMask(scaled, opts2);
      floodHints(mk2, scaled, opts2);
      var org2 = centerOrigin(mk2.mask, W, H);
      var rays2 = [];
      if (org2 && org2.within) {
        var pk2 = originPocket(mk2.mask, W, H);
        if (pk2 && stripPocketBlobs(mk2.mask, W, H, pk2.lbl, pk2.pocketId)) {
          pk2 = originPocket(mk2.mask, W, H) || pk2;
        }
        rays2 = castRays(scaled, mk2.mask, { x: org2.x, y: org2.y }, opts2).filter(Boolean);
        if (rays2.length > rays.length) { rays = rays2; mk = mk2; org = org2; }
      }
    }

    if (!org || !org.within) {
      return {
        ok: false, confidence: 0, quad: null, scaledQuad: null,
        metrics: {}, flags: [], confParts: {},
        center: center, greenMask: mk.mask, scaled: scaled, scale: scale,
        _rays: [], lines: [],
        diagnostics: { timeMs: Date.now() - t0, rayHits: 0, linesFound: 0, reason:
          'quadrat opening not centered in the photo — the frame middle must sit inside the opening'
            + (org && org.wallHits != null ? ' (wall seen in ' + org.wallHits + '/' + org.wallSpokes + ' directions)' : '') }
      };
    }

    // tube-width proxy (a 25th-percentile run — tube hit points are the
    // minority when the opening is blob-littered, so the median would land
    // inside blob territory); used by the RANSAC duplicate-line merge as
    // the max offset for the two rims of the same tube.
    var runs = rays.map(function (r) { return r.run; }).slice().sort(function (a, b) { return a - b; });
    opts.rayMedRun = runs.length ? runs[Math.floor(runs.length * 0.25)] : 0;

    var hitPts = rays.map(function (r) { return { x: r.x, y: r.y, run: r.run }; });
    var lines = ransacLines(hitPts, opts, W, H);

    var out = {
      ok: false, confidence: 0, quad: null, scaledQuad: null,
      metrics: {}, flags: [], confParts: {},
      center: { x: org.x, y: org.y }, greenMask: mk.mask, scaled: scaled, scale: scale,
      _rays: rays,
      originEnclosed: true, originAnchor: { x: org.x, y: org.y },
      wallSpokes: { hits: org.wallHits, total: org.wallSpokes },
      lines: lines.map(function (l) {
        return { n: l.n, d: l.d, dir: l.dir, c: l.c, spread: l.spread,
                 nInl: l.inliers ? l.inliers.length : 0, pts: l.inliers };
      }),
      diagnostics: { timeMs: 0, rayHits: rays.length, linesFound: lines.length, reason: null }
    };

    if (lines.length < 2) {
      out.diagnostics.reason = 'found < 2 straight quadrat edges — frame not visible/cropped away';
      out.diagnostics.timeMs = Date.now() - t0;
      return out;
    }

    // --- group into two orientation families, then try candidate combos ---
    function angleOf(l) {
      var a = Math.atan2(l.dir.y, l.dir.x);
      a = ((a % Math.PI) + Math.PI) % Math.PI;
      return a;
    }
    function circleAngleDist(a, b) {
      // true distance in mod-PI angle space (equivalent orientations ~ distance 0)
      var d = 2 * a - 2 * b;
      d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return Math.min(d, 2 * Math.PI - d) / 2;
    }
    // split lines into 2 orientation families by k-means on angle
    var fam = [[], []];
    var angs = lines.map(angleOf);
    if (lines.length >= 2) {
      var A0 = angs[0], A1;
      // seed B: farthest angle from A0
      var maxd = -1;
      for (var si = 0; si < angs.length; si++) {
        var dsi = circleAngleDist(angs[si], A0);
        if (dsi > maxd) { maxd = dsi; A1 = angs[si]; }
      }
      if (circleAngleDist(A0, A1) < Math.PI / 8) A1 = (A0 + Math.PI / 4) % Math.PI;
      for (var it = 0; it < 8; it++) {
        var sn0 = 0, cs0 = 0, sn1 = 0, cs1 = 0, c0 = 0, c1 = 0;
        for (var zi = 0; zi < lines.length; zi++) {
          var f = circleAngleDist(angs[zi], A0) < circleAngleDist(angs[zi], A1) ? 0 : 1;
          if (f === 0) { sn0 += Math.sin(2 * angs[zi]); cs0 += Math.cos(2 * angs[zi]); c0++; }
          else { sn1 += Math.sin(2 * angs[zi]); cs1 += Math.cos(2 * angs[zi]); c1++; }
        }
        // circular mean via doubled angle (robust across the mod-PI wrap)
        if (c0) A0 = Math.atan2(sn0, cs0) / 2;
        if (c1) A1 = Math.atan2(sn1, cs1) / 2;
      }
      for (var ai = 0; ai < lines.length; ai++) {
        fam[circleAngleDist(angs[ai], A0) < circleAngleDist(angs[ai], A1) ? 0 : 1].push(lines[ai]);
      }
    }
    out._fams = [fam[0].length, fam[1].length];
    if (fam[0].length < 1 || fam[1].length < 1) {
      out.diagnostics.reason = 'could not separate two perpendicular edge families';
      out.diagnostics.timeMs = Date.now() - t0;
      return out;
    }

    // interior reference = mean of all hit points
    var mxx = 0, myy = 0;
    for (var m = 0; m < hitPts.length; m++) { mxx += hitPts[m].x; myy += hitPts[m].y; }
    mxx /= hitPts.length; myy /= hitPts.length;
    var interior = { x: mxx, y: myy };

    // orient normals toward interior
    lines.forEach(function (l) {
      var sgn = interior.x * l.n.x + interior.y * l.n.y - l.d;
      if (sgn < 0) { l.n = { x: -l.n.x, y: -l.n.y }; l.d = -l.d; }
    });

    function edgeStats(l) {
      var runs = l.inliers.map(function (p) { return p.run === undefined ? 0 : p.run; });
      var med = median(runs);
      var mad = median(runs.map(function (r) { return Math.abs(r - med); }));
      return {
        support: clamp01(l.inliers.length / Math.max(3, rays.length / 10)),
        tubeCV: clamp01(mad / Math.max(6, 0.4 * med)),
        lenFrac: l.spread || 0,
        tubeMed: med
      };
    }
    var statCache = new Map();
    function statsOf(l) {
      if (!statCache.has(l)) statCache.set(l, edgeStats(l));
      return statCache.get(l);
    }

    // enumerate combinations: 2 lines from family0 x 2 from family1, score quads
    function dbgReason(s) { if (out._qcdbg) out._qcdbg.push(s); }
    function quadForCombo(a, b, c, d) {
      var ls = [a, b, c, d];
      // corners: lines sorted by normal angle; consecutive intersections
      var sorted = ls.slice().sort(function (p, q) {
        var ap = Math.atan2(p.n.y, p.n.x), aq = Math.atan2(q.n.y, q.n.x);
        return ap - aq;
      });
      var corners = [];
      for (var ci = 0; ci < 4; ci++) {
        var C = intersect(sorted[ci], sorted[(ci + 1) % 4]);
        if (!C) { dbgReason('par'); return null; }
        corners.push(C);
      }
      // sensible bounds
      for (var bi = 0; bi < 4; bi++) {
        if (corners[bi].x < -W * 0.35 || corners[bi].x > W * 1.35 || corners[bi].y < -H * 0.35 || corners[bi].y > H * 1.35) { dbgReason('bounds'); return null; }
      }
      var area = Math.abs(polyArea(corners));
      if (area < 0.04 * (W * H) || area > 0.97 * (W * H)) { dbgReason('area'); return null; }
      var sideLens = [];
      for (var sli = 0; sli < 4; sli++) {
        var A2 = corners[sli], B2 = corners[(sli + 1) % 4];
        sideLens.push(Math.hypot(B2.x - A2.x, B2.y - A2.y));
      }
      var sideMed = median(sideLens);
      if (sideMed < 0.25 * Math.min(W, H)) { dbgReason('sideMed'); return null; }
      var sideCV = (Math.max.apply(null, sideLens) - Math.min.apply(null, sideLens)) / sideMed;
      // The opening is physically square; foreshortening from reasonable
      // camera tilt stays under ~20% side spread. Combos beyond this are
      // missed-corner assemblies (e.g. an interior kelp edge standing in
      // for a rail) and must be rejected, not accepted with a warning.
      if (sideCV > 0.35) { dbgReason('sideCV:' + sideCV.toFixed(2)); return null; }
      // --- opening validity: just inside each line = opening (not green),
      // just outside = tube (green). A line sitting inside a tube (biased
      // inward into PVC, e.g. past mask holes) fails the inside probe hard.
      var ctr = out.center || { x: W / 2, y: H / 2 };
      var pen = 0, openParts = [];
      for (var oi = 0; oi < 4; oi++) {
        var L = sorted[oi];
        var off = 10; // px inward/outward probes
        var nSamp = Math.max(4, Math.min(9, Math.floor(L.inliers.length / 2)));
        var gIn = [], gOut = [];
        for (var qi = 0; qi < nSamp; qi++) {
          var pr2 = (nSamp === 1) ? 0 : (-0.35 * L.spread + (0.7 * L.spread * qi) / (nSamp - 1));
          var px = L.c.x + pr2 * L.dir.x, py = L.c.y + pr2 * L.dir.y;
          var si = ((ctr.x - px) * L.n.x + (ctr.y - py) * L.n.y) >= 0 ? 1 : -1; // toward interior
          gIn.push(isGreenAt(scaled, mk.mask, px + si * off * L.n.x, py + si * off * L.n.y, 4));
          gOut.push(isGreenAt(scaled, mk.mask, px - si * off * L.n.x, py - si * off * L.n.y, 4));
        }
        var mIn = median(gIn), mOut = median(gOut);
        // penalize green just inside; also reward green just outside slightly
        var pLine = clamp01((mIn - 0.15) / 0.45);
        pen += pLine;
        openParts.push({ gIn: +mIn.toFixed(2), gOut: +mOut.toFixed(2), pen: +pLine.toFixed(2) });
      }
      pen /= 4;

      function angDiff(a2, b3) {
        var d = Math.abs(a2 - b3);
        d = ((d + Math.PI / 2) % Math.PI) - Math.PI / 2;
        return Math.abs(d);
      }
      var sA = [statsOf(sorted[0]), statsOf(sorted[1]), statsOf(sorted[2]), statsOf(sorted[3])];
      var supScore = sA.reduce(function (acc, s) { return acc + (s ? s.support : 0); }, 0) / 4;
      var tubeScore = sA.reduce(function (acc, s) { return acc + (s ? 1 - s.tubeCV : 0); }, 0) / 4;
      var lenScore = sA.reduce(function (acc, s) { return acc + (s ? clamp01((s.lenFrac * 2.2) / Math.min(W, H)) : 0); }, 0) / 4;
      var par1 = angDiff(Math.atan2(sorted[0].n.y, sorted[0].n.x), Math.atan2(sorted[2].n.y, sorted[2].n.x));
      var par2 = angDiff(Math.atan2(sorted[1].n.y, sorted[1].n.x), Math.atan2(sorted[3].n.y, sorted[3].n.x));
      var angleDev = angDiff(Math.atan2(sorted[0].n.y, sorted[0].n.x), Math.atan2(sorted[1].n.y, sorted[1].n.x));
      var parScore = 1 - clamp01(Math.max(par1, par2) / 0.32);
      var angleScore = 1 - clamp01(Math.abs(angleDev - Math.PI / 2) / 0.45);
      var score = 0.26 * supScore + 0.18 * tubeScore + 0.1 * lenScore + 0.2 * parScore + 0.16 * angleScore
                + 0.1 * clamp01(1 - sideCV / 0.5) - 0.45 * pen;
      if (out._qcdbg) out._qcdbg.push({ score: +score.toFixed(3), f0i: f0.indexOf(a), open: openParts, sup: +supScore.toFixed(2), pen: +pen.toFixed(2) });
      return { corners: corners, score: score, sideLens: sideLens, expectedLines: sorted, parts: { supScore: supScore, tubeScore: tubeScore, lenScore: lenScore, parScore: parScore, angleScore: angleScore, sideCV: clamp01(1 - sideCV / 0.5), openPen: pen } };
    }

    var best = null;
    out._qcdbg = [];
    var f0 = fam[0].slice(0, 4).sort(function (p, q) { return q.inliers.length - p.inliers.length; });
    var f1 = fam[1].slice(0, 4).sort(function (p, q) { return q.inliers.length - p.inliers.length; });
    for (var ci1 = 0; ci1 < f0.length; ci1++) {
      for (var ci2 = ci1 + 1; ci2 < f0.length; ci2++) {
        for (var cj1 = 0; cj1 < f1.length; cj1++) {
          for (var cj2 = cj1 + 1; cj2 < f1.length; cj2++) {
            var combo = quadForCombo(f0[ci1], f0[ci2], f1[cj1], f1[cj2]);
            if (combo && (!best || combo.score > best.score)) best = combo;
          }
        }
      }
    }
    if (!best) {
      out.diagnostics.reason = 'no plausible quadrilateral among fitted edges';
      out.diagnostics.timeMs = Date.now() - t0;
      return out;
    }

    var corners = best.corners;
    var sortedLines4 = best.expectedLines; // ordered by normal angle around the quad
    out._bestLines = sortedLines4.map(function (l) { return lines.indexOf(l); });

    // --- edge position refinement ---
    // Guessed lines sit slightly inside the PVC tube when the mask's first
    // green pixel lands past shadowed/anti-aliased tube pixels.  Correct test:
    // walk INWARD (toward the opening, +n) from the line; if green continues,
    // the line lives in the tube and should move inward until green ends.
    // Walking outward is intentionally not done (would grow into the tube).
    (function refineEdges() {
      for (var e = 0; e < 4; e++) {
        var l = sortedLines4[e];
        var st = statsOf(l);
        var tube = st.tubeMed || 0.06 * Math.min(W, H);
        var dmax = Math.min(Math.max(6, tube * 0.5), 0.06 * Math.min(W, H));
        var half = l.spread / 2;
        var samples = Math.max(7, Math.min(15, l.inliers.length));
        var deltas = [];
        for (var q = 0; q < samples; q++) {
          var pr = (samples === 1) ? 0 : (-0.7 * half + (1.4 * half * q) / (samples - 1));
          var sx = l.c.x + pr * l.dir.x, sy = l.c.y + pr * l.dir.y;
          // inward green run: contiguous green from d=0 inward (gaps <= 3)
          var run = 0, gap = 0, lastGreen = -1;
          for (var d = 1; d <= dmax; d += 2) {
            var gx = sx + l.n.x * d, gy = sy + l.n.y * d;
            if (gx < 8 || gy < 8 || gx > W - 9 || gy > H - 9) break;
            if (isGreenAt(scaled, mk.mask, gx, gy, 4) >= 0.3) { run += 2; gap = 0; lastGreen = d; }
            else if (++gap > 2) break;
          }
          // contiguous green from the line until green ends
          if (lastGreen >= 0) {
            var clear = lastGreen + 1;
            while (clear <= dmax) {
              var hx = sx + l.n.x * clear, hy = sy + l.n.y * clear;
              if (hx < 8 || hy < 8 || hx > W - 9 || hy > H - 9) break;
              if (isGreenAt(scaled, mk.mask, hx, hy, 4) >= 0.3) { clear += 2; lastGreen = clear; }
              else break;
            }
          }
          deltas.push(lastGreen < 0 ? 0 : lastGreen);
        }
        var shift = median(deltas);
        var madS = median(deltas.map(function (x) { return Math.abs(x - shift); }));
        var applied = 0;
        if (shift >= 3 && madS <= 5 && shift < dmax * 0.85) {
          applied = shift;
        }
        // light uniform inward safety margin: hides residual tube/edge biases
        // (straight-line fits vs slightly bowed pipes, joint protrusions at corners)
        applied += Math.min(Math.max(4, 0.08 * st.tubeMed), 10);
        l.d += applied; // n points interior: inward move = l.d += t
        out._refine = out._refine || [];
        out._refine.push(e, deltas.slice().sort(function (a, b) { return a - b; }).map(function (x) { return Math.round(x); }), 'tube', Math.round(st.tubeMed), 'applied', Math.round(applied));
      }
    })();

    // re-intersect with refined lines
    (function recomputeCorners() {
      var cs = [];
      for (var ci = 0; ci < 4; ci++) {
        var C = intersect(sortedLines4[ci], sortedLines4[(ci + 1) % 4]);
        if (C) cs.push(C);
      }
      if (cs.length === 4) best.corners = cs;
    })();
    corners = best.corners;
    var ordered = corners.slice().sort(function (p, q) {
      return Math.atan2(p.y - interior.y, p.x - interior.x) - Math.atan2(q.y - interior.y, q.x - interior.x);
    });
    // rotate so first corner is "top-left-most" (min x+y) for consistent TL,TR,BR,BL
    var startIdx = 0, minSum = 1e12;
    for (var ri = 0; ri < 4; ri++) {
      var su = ordered[ri].x + ordered[ri].y;
      if (su < minSum) { minSum = su; startIdx = ri; }
    }
    var tlOrder = ordered.slice(startIdx).concat(ordered.slice(0, startIdx));

    // side lengths
    var sideLens = [];
    for (var sl = 0; sl < 4; sl++) {
      var A2 = tlOrder[sl], B2 = tlOrder[(sl + 1) % 4];
      sideLens.push(Math.hypot(B2.x - A2.x, B2.y - A2.y));
    }

    // inner-band green (opening should be clean of PVC)
    var qcx = interior.x, qcy = interior.y;
    var innerGreen = 0, innerN = 0;
    for (var e = 0; e < 4; e++) {
      var p1 = tlOrder[e], p2 = tlOrder[(e + 1) % 4];
      for (var si = 1; si <= 6; si++) {
        var tt = si / 7;
        var sx = p1.x + (p2.x - p1.x) * tt, sy = p1.y + (p2.y - p1.y) * tt;
        var ix = sx + (qcx - sx) * 0.08, iy = sy + (qcy - sy) * 0.08;
        if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
        innerGreen += isGreenAt(scaled, mk.mask, ix, iy, 6);
        innerN++;
      }
    }
    innerGreen = innerN ? innerGreen / innerN : 0;

    // outer-band green coverage (just outside opening should be PVC green)
    var outGreen = 0, outN = 0;
    for (var e2 = 0; e2 < 4; e2++) {
      var l2b = sortedLines4[e2];
      var stats2 = statsOf(l2b);
      var samples = Math.max(2, Math.min(4, Math.round(l2b.inliers.length * 0.5)));
      for (var qi = 0; qi < samples; qi++) {
        var pr = (samples === 1) ? 0 : (-l2b.spread / 2 + (l2b.spread * qi) / (samples - 1));
        var qo = { x: l2b.c.x + pr * l2b.dir.x - (stats2.tubeMed || 30) * 0.7 * l2b.n.x,
                   y: l2b.c.y + pr * l2b.dir.y - (stats2.tubeMed || 30) * 0.7 * l2b.n.y };
        if (qo.x < 0 || qo.y < 0 || qo.x >= W || qo.y >= H) continue;
        outGreen += isGreenAt(scaled, mk.mask, qo.x, qo.y, 10);
        outN++;
      }
    }
    outGreen = outN ? outGreen / outN : 0;

    // orientation deviations
    function angDiff(a, b) {
      var d = Math.abs(a - b);
      d = ((d + Math.PI / 2) % Math.PI) - Math.PI / 2;
      return Math.abs(d);
    }
    var nA = sortedLines4.map(function (l) { return Math.atan2(l.n.y, l.n.x); });
    var parDev = Math.max(angDiff(nA[0], nA[2]), angDiff(nA[1], nA[3]));
    var angleDev = Math.abs(angDiff(nA[0], nA[1]) - Math.PI / 2); // deviation from square

    var supScores = sortedLines4.map(function (l) { return statsOf(l).support; });
    var supScore = supScores.reduce(function (a, b) { return a + b; }, 0) / 4;
    var supMin = Math.min.apply(null, supScores);
    var tubeScore = sortedLines4.reduce(function (acc, l) { return acc + (1 - statsOf(l).tubeCV); }, 0) / 4;
    var lenScore = sortedLines4.reduce(function (acc, l) { return acc + clamp01((l.spread * 2.2) / Math.min(W, H)); }, 0) / 4;
    var angleScore = 1 - clamp01(angleDev / 0.45); // ~26deg
    var parScore = 1 - clamp01(parDev / 0.35);
    var coverScore = 0.65 * clamp01(outGreen / 0.8) + 0.35 * (1 - clamp01((innerGreen - 0.1) / 0.35));
    var sideMin = Math.min.apply(null, sideLens);
    var sizeScore = clamp01((sideMin - 0.28 * Math.min(W, H)) / (0.22 * Math.min(W, H)));

    var confParts = Object.assign({}, best.parts, {
      coverage: coverScore, size: sizeScore
    });
    var confidence = 0.24 * supScore + 0.09 * (0.5 + 0.5 * supMin) + 0.12 * tubeScore + 0.08 * lenScore
                   + 0.13 * angleScore + 0.1 * parScore + 0.16 * coverScore + 0.08 * sizeScore;

    // side length consistency (PVC square + near-vertical camera)
    var sideCV = (median(sideLens) > 0)
      ? (Math.max.apply(null, sideLens) - Math.min.apply(null, sideLens)) / median(sideLens) : 1;
    confParts.sideCV = clamp01(1 - sideCV / 0.45);
    confidence += 0.06 * confParts.sideCV;
    confidence = clamp01(confidence);

    var flags = [];
    if (innerGreen > 0.25) flags.push('opening partially covered by green algae or PVC — verify visually');
    if (outGreen < 0.45) flags.push('weak PVC coverage outside opening — structure might not be the frame');
    if (angleDev > 0.28) flags.push('opening far from square (camera heavily tilted or bad corners)');
    if (sideCV > 0.35) flags.push('opposite sides very different lengths — likely missed corners');
    if (supMin < 0.45) flags.push('an edge is weakly supported — frame may run off the image edge');

    var quadOut = tlOrder.map(function (c) { return { x: c.x / scale, y: c.y / scale }; });
    out.ok = true;
    out.confidence = confidence;
    out.confParts = confParts;
    out.quad = quadOut;
    out.scaledQuad = tlOrder;
    out.metrics = {
      innerGreen: innerGreen, outGreen: outGreen, sideLens: sideLens,
      angleDev: angleDev * 180 / Math.PI, parDev: parDev * 180 / Math.PI, sideCV: sideCV,
      sizeFrac: Math.abs(polyArea(tlOrder)) / (W * H), rayHits: rays.length,
      tubeMedians: sortedLines4.map(function (l) { return statsOf(l).tubeMed; })
    };
    out.flags = flags;
    out.diagnostics.timeMs = Date.now() - t0;
    return out;
  }

  function solveH(pairs) {
    var M = [], i;
    for (i = 0; i < 8; i++) M.push(new Array(9).fill(0));
    for (i = 0; i < 4; i++) {
      var s = pairs[i].src, d = pairs[i].dst;
      M[2 * i][0] = s.x; M[2 * i][1] = s.y; M[2 * i][2] = 1; M[2 * i][3] = 0; M[2 * i][4] = 0; M[2 * i][5] = 0; M[2 * i][6] = -s.x * d.x; M[2 * i][7] = -s.y * d.x; M[2 * i][8] = d.x;
      M[2 * i + 1][0] = 0; M[2 * i + 1][1] = 0; M[2 * i + 1][2] = 0; M[2 * i + 1][3] = s.x; M[2 * i + 1][4] = s.y; M[2 * i + 1][5] = 1; M[2 * i + 1][6] = -s.x * d.y; M[2 * i + 1][7] = -s.y * d.y; M[2 * i + 1][8] = d.y;
    }
    for (var col = 0; col < 8; col++) {
      var piv = col;
      for (var r = col + 1; r < 8; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      var tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
      for (var r2 = 0; r2 < 8; r2++) {
        if (r2 === col) continue;
        var f = M[r2][col] / M[col][col];
        for (var c2 = col; c2 < 9; c2++) M[r2][c2] -= f * M[col][c2];
      }
    }
    var hv = [];
    for (var r3 = 0; r3 < 8; r3++) hv.push(M[r3][8] / M[r3][r3]);
    return hv;
  }

  function applyH(H, x, y) {
    var w = H[6] * x + H[7] * y + 1;
    return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
  }

  /** Warp quad (order TL,TR,BR,BL in image px) to a `side`-px square RGBA. */
  function warpToSquare(image, quad, side) {
    var src = image.data, W = image.width, H2 = image.height;
    var out = new Uint8Array(side * side * 4);
    var pairs = [
      { src: { x: 0, y: 0 }, dst: quad[0] },
      { src: { x: side, y: 0 }, dst: quad[1] },
      { src: { x: side, y: side }, dst: quad[2] },
      { src: { x: 0, y: side }, dst: quad[3] }
    ];
    var Hm = solveH(pairs);
    if (!Hm) return out;
    for (var y = 0; y < side; y++) {
      for (var x = 0; x < side; x++) {
        var p = applyH(Hm, x, y);
        var xi = Math.floor(p.x), yi = Math.floor(p.y);
        var o = (y * side + x) * 4;
        if (xi >= 0 && yi >= 0 && xi < W - 1 && yi < H2 - 1) {
          var fx = p.x - xi, fy = p.y - yi;
          var i00 = (yi * W + xi) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
          for (var c = 0; c < 3; c++) {
            var v00 = src[i00 + c], v10 = src[i10 + c], v01 = src[i01 + c], v11 = src[i11 + c];
            out[o + c] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
          }
          out[o + 3] = 255;
        }
      }
    }
    return out;
  }

  return {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    detectQuadrat: detectQuadrat,
    centerOrigin: centerOrigin,
    warpToSquare: warpToSquare,
    boxScale: boxScale,
    buildMask: buildMask,
    castRays: castRays,
    ransacLines: ransacLines,
    solveH: solveH,
    applyH: applyH,
    isGreenAt: isGreenAt,
    polyArea: polyArea,
    median: median
  };
});
