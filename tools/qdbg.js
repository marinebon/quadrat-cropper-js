const jpeg = require('jpeg-js');
const fs = require('fs');
const QD = require('../js/qd.js');
function decodeJpeg(file) {
  const buf = fs.readFileSync(file);
  const raw = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 });
  return { width: raw.width, height: raw.height, data: new Uint8Array(raw.data) };
}
for (const f of process.argv.slice(2)) {
  const img = decodeJpeg(f);
  const det = QD.detectQuadrat(img, {});
  console.log('=====', f.split('/').pop(), 'ok', det.ok, 'conf', det.confidence.toFixed(3), 'reason', det.diagnostics.reason);
  console.log('rays', det.diagnostics.rayHits, 'lines', det.diagnostics.linesFound, 'fams', JSON.stringify(det._fams));
  det.lines.forEach((l, i) => {
    console.log('  L' + i, 'ang=' + ((Math.atan2(l.dir.y, l.dir.x) * 180 / Math.PI + 180) % 180).toFixed(1),
      'spread=' + Math.round(l.spread), 'nInl=' + l.nInl,
      'c=(' + Math.round(l.c.x) + ',' + Math.round(l.c.y) + ')');
  });
  if (det._qcdbg) {
    const counts = {};
    det._qcdbg.forEach(r => {
      const k = typeof r === 'string' ? r : (r.score !== undefined ? 'scored ' + r.score : '?');
      counts[k] = (counts[k] || 0) + 1;
    });
    console.log('  combo reasons:', JSON.stringify(counts, null, 1));
  }
}
