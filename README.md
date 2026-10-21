# Quadrat Cropper (JS)

Browser-based tool that automatically crops photoquadrat images to the square
interior area framed by the PVC quadrat (mint-green or yellow, 25 × 25 cm). Supports
individual files, drag & drop batches, and Google Drive (Picker or a pasted
folder link). Low-confidence detections are flagged for manual review with
draggable corner markers, and everything exports as a ZIP of square crops plus
a metadata manifest.

**No build step, no installation** — it is plain HTML + JS; serve the folder
with any static web server, or host it on any static host (GitHub Pages, etc).

## The MBON Pole to Pole protocol

These photo-quadrats come from the **[MBON Pole to Pole](https://marinebon.org/p2p/)**
(P2P) network of the Americas, whose standardized low-cost protocol monitors
sessile invertebrates and macroalgae on rocky shores
([sandy beaches](https://repository.oceanbestpractices.org/handle/11329/1145)
have a separate manual):

- **Field manual**: *"Sampling protocol for monitoring marine biodiversity on
  rocky shores"* — Montes, Bravo & Bigatti (2025), 3rd edition, in
  [English](https://marinebon.org/p2p/protocols/Protocol%20MBON%20&%20AMPs_V3_2025.pdf)
  and
  [Spanish](https://marinebon.org/p2p/protocols/Protocolo%20MBON%20&%20AMPs_V2.pdf),
  DOI [10.25607/OBP-2014.3](https://doi.org/10.25607/OBP-2014.3), also archived in the
  [Ocean Best Practices System](https://repository.oceanbestpractices.org/handle/11329/1143).
  Developed through participatory workshops (Camarones 2023, Ushuaia 2024,
  Puerto Madryn / Puerto Pirámides 2025) with park rangers, scientists and
  coastal communities.
- **The frame**: a 20 mm thermo-fusion (Fusiogas-type) PVC structure holds an
  **Olympus TG-6/7** camera (1/4"-20 UNC, 25 mm screw; 12 MP; built-in GPS)
  **42 cm** above the substrate, photographing the **25 × 25 cm** opening —
  exactly the square this tool auto-crops.
- **Sampling design**: 3 sites per locality (> 1 km apart), 3 intertidal
  levels each (high / mid / low; barnacles, mussels, macroalgae as indicators),
  **40–60 photo-quadrats per level**, walking > 100 m at low tide; camera
  horizontal or inclined up to 40° (no vertical walls), the quadrat shaded for
  homogeneous lighting, and no tide pools in shot. A field-sheet photo closes
  each level; species shots are later uploaded to
  [iNaturalist](https://www.inaturalist.org/).

## Quick start

The app is already live at
**<https://marinebon.org/quadrat-cropper-js/>** (GitHub Pages from `main`,
pushes deploy automatically).

To run it locally:

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
   - `https://marinebon.org` — the deployed site (scheme + host only, no path;
     the app's ⚙ dialog shows and copies the running origin for you)
   - `http://localhost:8080` — if you develop locally
   
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
2. Run the pipeline once per known tube color (`FRAME_COLORS`): an HSV mask
   band for mint PVC (hue 118–172°, sat ≥ 0.13) and for yellow PVC (hue 42–82°,
   sat ≥ 0.2; kept band-separate so green algae never pollutes a yellow pass
   and pale sand a mint one). The best-confidence detection wins.
3. Flood the mask through bright, weakly-tinted "highlight" pixels (direct-sun
   shots blow the PVC out to near-white; the fill is bounded by masked rims).
4. Cast 128 rays from the open interior's origin — chosen as the largest
   free pocket *enclosed* by the mask (border flood; a morphological
   ring-closing tolerates a breached frame such as a sun-flared section or a
   dark sticker on the tube). A raw deepest-chamfer selection is not enough:
   the mask centroid is biased, and on yellow frames barnacle-cream specks
   inside the opening shred its inscribed radius so an exterior rock pocket
   can win by depth. Mask components lying entirely inside the pocket
   (barnacle cream, alga clumps — real tube structures always connect to the
   ring) are stripped so they cannot steal rays, and the origin is anchored
   on the free floor near the pocket's area centroid. From the origin, each
   ray keeps up to two sufficiently long runs of mask pixels (gap-tolerant;
   a ray blocked by interior clutter still contributes a tube-rim point)
   and marks inner-edge points of the opening.
5. Sequential RANSAC fits up to 8 lines, merging parallel near-duplicates
   (the inner and outer rims of the same tube); they are grouped into two
   perpendicular orientation families (k-means on circular angle) and the best
   pair from each is scored into quadrilaterals (support, tube-width
   consistency, side-length squareness, parallelism, plus a "just inside must
   be non-PVC / just outside must be PVC" opening probe).
6. Per-edge refinement walks *inward* from each line and trims residual
   inward-side bias, plus a light uniform margin — directional analysis of the
   tube color profile along each normal.
7. Confidence score (support, tube CV, squareness, parallelism, PVC coverage
   inside/outside, size sanity) drives the green/amber/red highlighting.

Pre-cropped images (already-square outputs) are rejected: no straight frame
edges present → flagged "no frame found" rather than crop-garbage.

## Tests

```bash
npm install
npm test          # runs the regression suite in tests/
```

`tests/` contains real captured fixtures with expectations in
`tests/expected.json`:

- **"crop"** cases must detect the opening: `ok`, confidence ≥ threshold,
  near-square quad fitting inside the image. Includes the deliberately hard
  `P1120593.JPG` / `P1120605.JPG` — direct-sun shots where the PVC is blown
  out white and side-arm pipes cross the opening interior.
- **"reject"** cases are pre-cropped quadrat outputs that must fail cleanly
  (no forced crop of an already-cropped image).

`npm test` exits non-zero on failure; CI (`.github/workflows/test.yml`) runs
it on every push/PR. `npm run harness` dumps overlay/crop imagery for a whole
folder into `tools/results/` for visual inspection, and
`node tools/qdbg.js <image>…` prints per-stage diagnostics (ray hits, fitted
lines, orientation families, combo rejections).

## Validation harness (Node)

`tools/test.js` runs the same `js/qd.js` against raw photos and known
pre-cropped negatives, writing overlays (`_ov.jpg`: mask tint + fitted quad)
and square crops (`_crop.jpg`) plus `summary.json` into `results/`:

```bash
npm install                    # jpeg-js (from the repo root)
npm run harness /path/to/raw   # or edit paths in tools/test.js
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
tests/run.js        regression suite (npm test; also run by CI)
tests/images/       captured fixtures + expected.json
tools/test.js       visual debug harness — overlays, crops, summary.json
tools/qdbg.js       per-stage detector diagnostics for one or more images
```

## Notes & limitations

- Anonymous Drive access: a single publicly-shared **image** link loads with
  no sign-in (full resolution via Google's image CDN). The crop filename is
  `drive_<id>.jpg` in that case, since the original filename is not exposed
  cross-origin; filename-based metadata won't join for those items. Anonymous
  **folder** listing is not possible (Google requires sign-in) — use the .zip
  drop or the one-time sign-in instead.
- Camera 42 cm above the substrate per the P2P protocol (horizontal or up
  to 40° inclination): the detector reports far-from-square openings as low
  confidence instead of forcing a wrong crop.
- Images where the frame is partly outside the picture are handled (edge
  support flag) but the crop will be missing that side.
- Chile/northern-Hemisphere dark rock shots with heavy algae: the opening
  probe and confidence weighting flag them for review; manual markers are the
  intended fallback.
- Export crops are capped at 1600 px square, matching the light gray `s190`
  preview convention of the reference outputs.
