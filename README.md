# Quadrat Cropper (JS)

Browser-based tool that automatically crops photoquadrat images to the square
interior area framed by the PVC quadrat (mint-green or yellow, 25 × 25 cm;
the mint tube is also found when the camera renders it turquoise/cyan, as the
Olympus/OM TG-6/TG-7 does). Supports
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
  **OM System Tough TG-7** camera (1/4"-20 UNC, 25 mm screw; 12 MP; built-in GPS)
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
pushes deploy automatically — see [Publishing](#publishing)).

To run it locally:

```bash
cd quadrat-cropper-js
make preview       # serves the repo root on http://localhost:8080
```

(or, without make: `python3 -m http.server 8080`). Use another port with
`make preview PORT=8000`.

The app explains itself: a **welcome screen appears on first visit** and a **?**
button in the header re-opens the same instructions any time. No README needed
for everyday use.

Three ways to get images in, in order of least setup:

**＋ Add photos ▾ → A folder** picks a whole folder **including all its
subfolders** (their names fill the metadata; CSVs inside are joined as
metadata too). Clicking the drop area does the same.

1. **Drag & drop** image files or folders (or hundreds of them) onto the page — JPEG,
   PNG, TIFF, or camera **RAW** (Canon CR2/CR3, Nikon NEF/NRW, Olympus ORF,
   Sony ARW, DNG, Panasonic RW2, Fuji RAF, Pentax PEF, Samsung SRW; see
   [RAW files](#raw-files)).
2. **Paste a Drive link to a single photo** — shared as *“Anyone with the
   link”* it downloads anonymously, no sign-in, no configuration.
3. **Bulk from Drive** — either
   - right-click the folder in Drive → **Download**, then **drop the .zip**
     onto the page (zero setup; the zip is unpacked in the browser and any
     `.csv` files inside are picked up as metadata), or
   - do the one-time Google sign-in below and paste the folder link.
     Subfolders (e.g. `locality/site/strata/`), Shared drives and Drive
     shortcuts are followed. Photos are downloaded 4 at a time and processed
     as they arrive, so large folders (thousands of photos) start right away.

Photos are processed in parallel in Web Workers (one per spare CPU core, up
to 8); the progress bar shows an estimate of the time left.

**The suggested crop is always a square** inside the photo: the camera is
rigidly mounted on the frame, so the opening is a square in the image. The
detected corners are replaced by their best-fit square (least squares), and
that square is shrunk by an **inset (default 5 %)** so the PVC rim stays out
of the crop — change it in **⚙** (0–20 %). A photo is flagged for review when
the detected outline was clearly not square (> 6 % → amber, > 12 % → red),
when the square had to be moved/shrunk to stay inside the photo, or when its
size differs from the typical size in the batch (outside 0.8–1.25×).

Each thumbnail shows:

- green ring — auto-accepted (confidence ≥ 0.80)
- amber ring — usable but flagged, review suggested (0.55–0.80)
- red ring — needs manual corners (< 0.55) or no frame found
- blue ring — cropped by hand in the editor
- grey — excluded from the export (✕ on the card; ↺ to include it again)

Click a thumbnail: the review page opens on the **full uncropped photo** with
the crop's four corner markers and a live crop preview alongside. Drag the
markers onto the inner corners of the PVC opening, then Apply (or press
`Enter`; `R` resets to the auto-detected corners, `Esc` closes). This works
the same for confident crops and for detections that need a fix — nothing is
changed unless you move a marker. With **Keep square** (on by default)
the crop stays a true square: dragging a corner resizes/rotates it around the
opposite corner, dragging inside it moves it, and it can never leave the
photo; untick it for free corners. **◀ ▶ (or ← →)** move to the previous /
next photo without leaving the editor; markers you dragged are applied before
moving on, so a whole batch can be reviewed in one pass.

**⬇ Export ZIP** — there is nothing to tick: every crop with **confidence ≥ 0.80**
is included automatically, plus every one you adjusted manually, minus the
ones you excluded with ✕. Red/amber
thumbnails can be fixed in the editor to qualify. The
`quadrat-crops-<timestamp>.zip` contains:

- square crops, **all the same size in px** by default (the median crop
  size of the batch; a fixed size or each crop's own size can be chosen in
  **⚙**). Every crop shows the same 25 × 25 cm, so one size = one scale
  (px per cm) for the whole batch. Crops are warped at the opening's own
  resolution (no 1600-px cap any more)
- `manifest.csv` — every image that was loaded, with filename, status,
  confidence, flags, date/site/group/code parsed from filenames, EXIF
  (make/model/date), Drive file id, and any columns joined from CSVs found in
  the Drive folder; images excluded from the zip keep an empty *file* column
  (status `excluded` for the ones removed with ✕)
- `review.json` — full per-image record incl. corner coordinates used

### Metadata tab (CoralNet CSV + EXIF)

Photos are grouped by their **source folder** — Drive subfolders, folders
inside a zip, or a folder added with **＋ Add folder** / dropped from Finder
(e.g. a Google Drive for desktop folder). The **Metadata** tab shows one row
per group; fill the fields once per group (⇣ copies the first row down a
column). With the **Intertidal — MBON Pole to Pole (CoralNet)** preset:

- read from each photo: `Name`, `Date`, `Latitude`, `Longitude`, `Camera`
  (EXIF date, GPS and model);
- the same for every photo: `Height (cm)` = 42, `Strobes` = no,
  `Framing gear used` = 25x25cm;
- per group: `country`, `state`, `locality`, `site`, `strata`
  (HIGHTIDE / MIDTIDE / LOWTIDE), `Photographer`, `Comments` (e.g. AMP code),
  `Depth`, `Water quality`, `White balance card`, plus `season` (FRIO /
  CALIDO; kept in EXIF and the manifest, not a CoralNet column).

Folder names pre-fill the group. The field team's Drive layout is
`COUNTRY/YEAR/SEASON/LOCALITY/SITE/STRATA/photo`, e.g.
`ARGENTINA/2026/FRIO/CABO DOS BAHIAS/ENTRE CALETAS/ALTO/AMP55261.JPG`; it is
read from the deepest folder up, so links to a lower folder work too. Strata
names ALTO/MEDIO/BAJO (or HIGH/MID/LOW…) become HIGHTIDE/MIDTIDE/LOWTIDE.
`state` and `Comments` (AMP code) come from a table of the localities already
monitored (seeded from the 2026 campaign), and the app learns new localities
— including the photographer — as you type them.

**Azores workshop (CoralNet)** preset — the MBON + AIR Centre workshop
layout: the five Aux fields are `Group, country, locality, site, strata`
(no `state`); defaults PORTUGAL / ILHA TERCEIRA, `Comments` = *Azores Workshop
2026*, `Photographer` = the group when left empty, no framing gear; a folder
per group or transect (*Group_1*, *Grupo 2*, *Transect_3*…) fills `Group`.

The ZIP then names each crop `YYYYMMDD_` + the source photo name (the
date from EXIF; names that already start with a date are left alone — or
choose *as the source photo*), adds **`metadata_coralnet.csv`** in CoralNet's upload
format (columns `Name, Date, country, state, locality, site, strata,
Height (cm), Latitude, Longitude, Depth, Camera, Photographer, Water quality,
Strobes, Framing gear used, White balance card, Comments`) and embeds the same
information in every crop's **EXIF** (date, GPS, make/model, photographer as
Artist, the group fields in ImageDescription/UserComment). Export warns when
a required field is empty. Choose *None* as preset to skip all of this.

### RAW files

Browsers cannot decode RAW sensor data, so the app uses the **largest JPEG
embedded by the camera** in the RAW file (full resolution in CR2, NEF, ARW and
DNG from most cameras), keeps the RAW's EXIF (make, model, date) and applies
its orientation. Some formats — notably Olympus/OM System **ORF** and older
Canon CR2 — only embed a reduced preview; those photos are flagged ("reduced
resolution"). If detail matters for annotation, export full-size JPEGs from
the RAW files first (camera software, Lightroom, darktable…).

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
4. Cast 128 rays from the frame middle. The protocol centers the quadrat in
   the shot, so the middle must sit within the opening: 24 spokes from the
   middle must reach the tube mask in (nearly) every direction — if not, the
   image is flagged and detection stops. Mask components lying entirely
   inside the opening's enclosed pocket (barnacle cream, alga clumps — real
   tube structures always connect to the ring) are stripped so they cannot
   steal rays. From the origin, each ray keeps up to two sufficiently long
   runs of mask pixels (gap-tolerant; a ray blocked by interior clutter
   still contributes a tube-rim point) and marks inner-edge points of the
   opening.
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

## Publishing

GitHub Pages serves the repo root of `main` (legacy build, no `gh-pages`
branch), so a push *is* the deploy:

```bash
make publish        # suite → push main → wait for the live build
make deploy-status  # compare the local and live QD.VERSION
```

`make publish` will not run on a dirty checkout: `npm test` validates the
working tree, but a push ships the committed tree, so publishing uncommitted
edits would deploy something the suite never saw — commit first. It also
refuses when `origin/main` has moved ahead (pull/rebase first), warns about
untracked files that will not be deployed, and finishes by polling the live
`js/qd.js` until it serves the pushed `QD.VERSION` (bounded by
`DEPLOY_WAIT`, default 180 s), so a stale CDN or a broken build is visible
immediately.

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
Makefile            make preview (serve) / test / publish (deploy to Pages)
css/styles.css      styling
js/qd.js            detection core (browser + Node compatible)
js/app.js           orchestration, worker-pool queue, square-crop checks, ingestion UI
js/worker.js        per-photo pipeline in a Web Worker (decode → detect → square → warp → encode)
js/raw.js           camera RAW support (largest embedded JPEG + RAW EXIF)
js/metatab.js       Metadata tab: presets, per-folder groups, CoralNet CSV rows
js/exifwrite.js     writes EXIF (date, GPS, camera, fields) into the exported crops
js/grid.js          thumbnail grid + confidence ring highlighting
js/editor.js        manual corner-marker editor + live crop preview
js/drive.js         Google Identity Services (OAuth token), Picker, Drive v3 REST,
                    anonymous single-file download (`drive.usercontent.google.com`)
js/unzip.js         in-browser ZIP reader (STORE + DEFLATE via DecompressionStream)
                    for the "download Drive folder as .zip" flow
js/export.js        ZIP writer (STORE), manifest CSV, review.json
js/exif.js          minimal EXIF reader incl. GPS (JPEG + TIFF-based RAW headers)
js/metadata.js      filename parsing (date/site/group/code) + CSV join
tests/run.js        regression suite (npm test; also run by CI)
tests/images/       captured fixtures + expected.json
tools/test.js       visual debug harness — overlays, crops, summary.json
tools/qdbg.js       per-stage detector diagnostics for one or more images
```

## Change history

The field-review changes from v1.5.3 to v1.12.0 (why, what, where, how
tested) are explained in
[`docs/CHANGES-1.5.3-to-1.12.0.md`](docs/CHANGES-1.5.3-to-1.12.0.md).

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
- Images where the frame is partly outside the picture are handled: the
  suggested square is kept inside the photo and flagged for review.
- Chile/northern-Hemisphere dark rock shots with heavy algae: the opening
  probe and confidence weighting flag them for review; manual markers are the
  intended fallback.
- Crops are warped at the opening's native resolution and brought to one
  common size at export (median of the batch by default).
