# Quadrat Cropper (JS)

Browser-based tool that automatically crops photoquadrat images to the square
interior area framed by the mint-green PVC quadrat (25 × 25 cm). Supports
individual files, drag & drop batches, and Google Drive (Picker or a pasted
folder link). Low-confidence detections are flagged for manual review with
draggable corner markers, and everything exports as a ZIP of square crops plus
a metadata manifest.

**No build step, no installation** — it is plain HTML + JS; serve the folder
with any static web server, or host it on any static host (GitHub Pages, etc).

## Quick start

```bash
cd quadrat-cropper-js
python3 -m http.server 8080
# open http://localhost:8080
```

The app explains itself: a **welcome screen appears on first visit** and a **?**
button in the header re-opens the same instructions any time. No README needed
for everyday use.

Three ways to get images in, in order of least setup:

1. **Drag & drop** image files (or hundreds of them) onto the page.
2. **Paste a Drive link to a single photo** — shared as *“Anyone with the
   link”* it downloads anonymously, no sign-in, no configuration.
3. **Bulk from Drive** — either
   - right-click the folder in Drive → **Download**, then **drop the .zip**
     onto the page (zero setup; the zip is unpacked in the browser and any
     `.csv` files inside are picked up as metadata), or
   - do the one-time Google sign-in below and paste the folder link.

Each thumbnail shows:

- green ring — auto-accepted (confidence ≥ 0.80)
- amber ring — usable but flagged, review suggested (0.55–0.80)
- red ring — needs manual corners (< 0.55) or no frame found

Click a thumbnail: strong detections open a crop preview; weak ones open the
corner editor (drag the four markers onto the inner corners of the PVC
opening, live preview, `Enter` to apply, `R` to reset, `Esc` to close).

**⬇ Export ZIP** produces `quadrat-crops-<timestamp>.zip` containing:

- `<name>_crop.jpg` square crops
- `manifest.csv` — filename, status, confidence, flags, date/site/group/code
  parsed from filenames, EXIF (make/model/date), Drive file id, and any
  columns joined from CSVs found in the Drive folder
- `review.json` — full per-image record incl. corner coordinates used

## Google Drive sign-in (only for auto-listing whole folders)

Anonymous paths cover single photo links and folder .zip drops. Only *listing*
everything in a folder without downloading a zip needs OAuth (Google removed
anonymous/API-key Drive listing). The **⚙** dialog walks through the whole
setup inline — including a click-to-copy of this page's origin:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Enable the **Google Drive API** and **Google Picker API**.
3. Create an **OAuth 2.0 Client ID** (type *Web application*).
   Add authorized JavaScript origins:
   - `http://localhost:8080`
   - and your deployed origin (e.g. the final hosting URL).
   No redirect URI is needed (this uses the implicit token flow).
4. Click **⚙** in the app header, paste the Client ID, save.
5. Use **⊕ Add from Google Drive** (Picker → choose a folder or image), or paste
   a folder link (`https://drive.google.com/drive/folders/<ID>…`) and press
   **Load link**. The app requests `drive.readonly` and only lists/downloads
   what you have access to.

CSV files found in the chosen Drive folder
(`metadata.csv`, `annotations.csv`, `labelset.csv`, …) are downloaded and
joined into the manifest by filename or quadrat code.

## How detection works (js/qd.js)

Pure, DOM-free JavaScript module (`js/qd.js`, no dependencies) shared with the
Node validation harness:

1. Downscale to ~1152 px working width.
2. Build an HSV "mint-PVC" mask (hue 118–172°, sat ≥ 0.13, val ≥ 0.045 —
   tolerant of shadow) with 7×7-majority filtering.
3. Cast 128 rays from the green-mask centroid; the first long-enough run of
   mask pixels along each ray (gap-tolerant) marks an inner-edge point of the
   opening.
4. Sequential RANSAC fits up to 6 lines; they are grouped into two
   perpendicular orientation families (k-means on circular angle) and the best
   pair from each is scored into quadrilaterals (support, tube-width
   consistency, side-length squareness, parallelism, plus a "just inside must
   be non-PVC / just outside must be PVC" opening probe).
5. Per-edge refinement walks *inward* from each line and trims residual
   inward-side bias, plus a light uniform margin — directional analysis of the
   mint color profile along each normal.
6. Confidence score (support, tube CV, squareness, parallelism, PVC coverage
   inside/outside, size sanity) drives the green/amber/red highlighting.

Pre-cropped images (already-square outputs) are rejected: no straight frame
edges present → flagged "no frame found" rather than crop-garbage.

## Validation harness (Node)

`tools/test.js` runs the same `js/qd.js` against raw photos and known
pre-cropped negatives, writing overlays (`_ov.jpg`: mask tint + fitted quad)
and square crops (`_crop.jpg`) plus `summary.json` into `results/`:

```bash
cd tools
npm install jpeg-js
node --max-old-space-size=4096 test.js /path/to/raw  # or edit paths in test.js
```

Current validation: 13/13 raw positives pass (conf 0.96–1.00), 4/4 pre-cropped
negatives cleanly rejected.

## Layout

```
index.html          app shell
css/styles.css      styling
js/qd.js            detection core (browser + Node compatible)
js/app.js           orchestration, queue, ingestion UI
js/grid.js          thumbnail grid + confidence ring highlighting
js/editor.js        manual corner-marker editor + live crop preview
js/drive.js         Google Identity Services (OAuth token), Picker, Drive v3 REST,
                    anonymous single-file download (`drive.usercontent.google.com`)
js/unzip.js         in-browser ZIP reader (STORE + DEFLATE via DecompressionStream)
                    for the "download Drive folder as .zip" flow
js/export.js        ZIP writer (STORE), manifest CSV, review.json
js/exif.js          minimal JPEG EXIF reader
js/metadata.js      filename parsing (date/site/group/code) + CSV join
tools/test.js       Node validation harness (jpeg-js)
```

## Notes & limitations

- Anonymous Drive access: a single publicly-shared **image** link loads with
  no sign-in (full resolution via Google's image CDN). The crop filename is
  `drive_<id>.jpg` in that case, since the original filename is not exposed
  cross-origin; filename-based metadata won't join for those items. Anonymous
  **folder** listing is not possible (Google requires sign-in) — use the .zip
  drop or the one-time sign-in instead.
- Top-down camera only (metadata says 0.45 m shooting distance); the detector
  still reports far-from-square openings as low confidence instead of forcing
  a wrong crop.
- Images where the frame is partly outside the picture are handled (edge
  support flag) but the crop will be missing that side.
- Chile/northern-Hemisphere dark rock shots with heavy algae: the opening
  probe and confidence weighting flag them for review; manual markers are the
  intended fallback.
- Export crops are capped at 1600 px square, matching the light gray `s190`
  preview convention of the reference outputs.
