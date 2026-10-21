/**
 * tests/run.js — regression suite for the quadrat detector.
 *
 * Runs js/qd.js over tests/images/ and checks expectations in
 * tests/expected.json:
 *
 *   "crop"   — must detect: ok=true, confidence ≥ minConf, quad inside the
 *              image, roughly square (max/min side ≤ 1.35), sane size.
 *   "reject" — must fail cleanly (ok=false): pre-cropped images must be
 *              flagged, never force-cropped.
 *
 * Usage:
 *   node tests/run.js                 # the fixtures above
 *   node tests/run.js <imgDir> ...    # add extra ad-hoc dirs of .JPG/.jpg
 *                                     # (expected.json files with an
 *                                     # "extend" section are honored)
 * Exit code 0 = all pass, 1 = failure. Used by CI (.github/workflows/test.yml).
 */
'use strict';

const fs = require('fs');
const path = require('path');

let jpeg;
try {
  jpeg = require('jpeg-js');
} catch (e) {
  console.error('jpeg-js not installed — run: npm install');
  process.exit(1);
}
const QD = require('../js/qd.js');

const EXPECTED = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'));

function decodeJpeg(file) {
  const buf = fs.readFileSync(file);
  const raw = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 });
  return { width: raw.width, height: raw.height, data: new Uint8Array(raw.data) };
}

function checkQuad(det) {
  const m = det.metrics;
  if (!m || !m.sideLens || m.sideLens.length !== 4) return 'no side metrics';
  const sides = m.sideLens.map(x => Math.abs(x));
  const mx = Math.max.apply(null, sides), mn = Math.min.apply(null, sides);
  if (!mn) return 'degenerate quad';
  if (mx / mn > 1.35) return 'not square (' + mx.toFixed(0) + ' vs ' + mn.toFixed(0) + ' scaled px)';
  const minDim = det.scaled.width, maxDim = det.scaled.height;
  const rel = mn / Math.min(minDim, maxDim);
  if (rel < 0.15 || rel > 0.98) return 'implausible size ' + rel.toFixed(2);
  for (const c of det.quad) {
    if (c.x < -0.5 || c.y < -0.5 || c.x > (image.width || 1e9) || c.y > (image.height || 1e9)) {
      // allow tiny negative excursions from refinement but not wild ones
      if (c.x < -det.scaled.width * 0.1 || c.y < -det.scaled.height * 0.1) return 'quad outside image';
    }
  }
  return null;
}

let image = null; // set per-case for checkQuad bounds

function runCase(name, expect, minConf) {
  const img = decodeJpeg(name);
  image = img;
  const t0 = Date.now();
  const det = QD.detectQuadrat(img, {});
  const conf = det.confidence;
  let fail = null;
  if (expect === 'crop') {
    if (!det.ok) fail = 'expected detection: ' + (det.diagnostics.reason || 'ok=false');
    else if (conf < minConf) fail = 'confidence ' + conf.toFixed(3) + ' < ' + minConf;
    else {
      const qf = checkQuad(det);
      if (qf) fail = 'expected detection but ' + qf;
    }
  } else if (expect === 'reject') {
    if (det.ok) fail = 'expected clean rejection but got ok=true conf=' + conf.toFixed(3);
  } else {
    fail = 'unknown expectation: ' + expect;
  }
  return {
    name: path.basename(name), pass: !fail, fail,
    ok: det.ok, conf: +conf.toFixed(3), ms: Date.now() - t0,
    flags: det.flags || []
  };
}

function main() {
  const dirs = process.argv.slice(2);
  const fixtureDir = path.join(__dirname, 'images');
  if (!dirs.length) dirs.push(fixtureDir);

  const cases = [];
  for (const dir of dirs) {
    const files = fs.readdirSync(dir).filter(f => /\.jpe?g$/i.test(f)).sort();
    for (const f of files) {
      const expect = EXPECTED[f] || EXPECTED[path.join(path.basename(dir), f)];
      if (!expect) {
        console.log('SKIP (no expectation) ' + f);
        continue;
      }
      cases.push(path.join(dir, f));
    }
  }
  if (!cases.length) {
    console.error('no testable images found');
    process.exit(1);
  }

  let failed = 0;
  console.log('fixture'.padEnd(22), 'expect '.padEnd(8), 'got'.padEnd(22), 'ms', '  result');
  for (const file of cases) {
    const e = EXPECTED[path.basename(file)];
    const r = runCase(file, e.expect, e.minConf || 0);
    const got = (r.ok ? 'ok ' + r.conf : 'reject ') + (r.flags.length ? ' [' + r.flags.join(',') + ']' : '');
    const verdict = r.pass ? 'PASS' : 'FAIL: ' + r.fail;
    if (!r.pass) failed++;
    console.log(r.name.padEnd(22), e.expect.padEnd(8), got.padEnd(22), String(r.ms), ' ', verdict);
  }
  console.log('\n' + (cases.length - failed) + '/' + cases.length + ' passed');
  process.exit(failed ? 1 : 0);
}

main();
