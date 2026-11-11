# Working notes for contributors (human or AI)

## Always run the tests before ending a coding task

Run the full suite and make sure it is green before you stop:

```bash
npm install     # once — jpeg-js
npm test
```

`npm test` must be green across every case in `tests/expected.json` (**16
today** — add cases there when you add fixtures). CI runs the same command on
every push, so a red suite is never a "later" problem.

If a change touches the UI (not just `js/qd.js`), also load the page through
`make preview` and exercise the flow you changed — the suite only covers the
detector core.

## Detector coordinate contract (do not break)

`QD.detectQuadrat()` returns:

- `quad` — the four opening corners in **source pixels** of the input image
  (the app crops the photo with these directly),
- `scaledQuad` — the same corners in the ~1152-px internal work space,
- `scale` — the work-space → source-pixel factor
  (`min(1, workWidth / sourceWidth)`); `quad === scaledQuad / scale`.

The app decodes photos at their original resolution, so returning `quad` in
work space silently crops the **upper-left** of every real photo (that bug
shipped in v1.3.x–v1.5.x). `tests/run.js` now asserts the relationship for
every `crop` fixture; keep it that way when touching the pipeline.

## Other conventions

- Bump `QD.VERSION` (`js/qd.js`) for each logical change — the page title and
  footer show it so testers can confirm they are not on a cached build.
- `make preview` serves the repo root on <http://localhost:8080> (port 8080
  matches the Google OAuth authorized origin for Drive access).
- `make publish` is the deploy path: it runs the suite, pushes `main` (GitHub
  Pages serves the repo root of `main`, so the push *is* the build), then polls
  the live `js/qd.js` until it serves the pushed `QD.VERSION`. It refuses a
  dirty checkout — the suite validates the working tree but the push ships the
  committed tree — so commit first; `make deploy-status` compares local and
  live versions.

## Pipeline invariants (added in v1.6–v1.12, see `docs/CHANGES-1.5.3-to-1.12.0.md`)

- **Two copies of the per-photo pipeline:** `js/worker.js` (`processPhoto`,
  used by the worker pool) and `js/app.js` (`processOne` + `squareGeometry`,
  the fallback when Worker/OffscreenCanvas is missing or a worker errors).
  Change them together: square fit → inset → fit inside → warp side.
- **Square geometry is app-level.** `det.quad` stays the raw detector output
  (source pixels); the app stores `det.quadRaw`, `det.quadFull` and
  `det.geom`. Do not move the square/inset logic into `detectQuadrat`.
- **Color passes run mint → yellow → cyan → white.** `cyan` (TG-6/TG-7 mint
  tube) and `white` (rod frames) only run when no earlier pass reached 0.8.
  `white` is the pass most likely to grab bright sand; keep it last.
- **Batch-relative checks** (typical square size) are re-applied when the
  queue drains, so flags can change at the end of a batch.
- **Drive originals are released after processing.** Code that needs the
  original later (editor, re-export) must call `ensureBlob(it)`.
- **Crops are warped at native resolution** (cap `NATIVE_MAX`) and resized to
  a common side only at export (`QDExport.exportZip(..., { side })`).
- **Positions:** read them through `QDGeo.position(it)` (map/track position in
  `it.geo` wins over the camera's EXIF GPS). The CoralNet CSV, the crops' EXIF
  and `manifest.csv` all do; never read `it.exif.latitude` directly for output.
- **Leaflet is vendored** (`vendor/leaflet-1.9.4/`) and loaded lazily by
  `maptab.js`; the page itself must keep working without it.
- **Suggested-square geometry lives in `QD.suggestSquare` (qd.js)**, shared by
  `app.js` (`squareGeometry`) and `worker.js` (`cropFrom`). Change it there only.
  `det.quadRaw` (original px) is kept so settings changes can re-crop without
  re-detecting (`reapplySquare`, worker re-crop mode `msg.quadRaw`).
