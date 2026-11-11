# Quadrat Cropper — changes from v1.5.3 to v1.12.0

**Branch:** `review/claude-bugfixes-2026-10` (fork `gonzalobravoargentina/quadrat-cropper-js`).
**Context:** the MBON Pole to Pole field team (Argentina) used the live site on
real batches and reported problems and needs, which are listed here. The work
was done together with Claude (Anthropic) in October 2026. Every change is
also commented in the code at the place where it was made.

This document is meant to be read **before the diff**. It explains *why*
each change exists, *what* it does, *where* it lives, and *how it was
checked*.

---

## 0. How to review this branch

1. Read §1 (version map) and §2 (files) for orientation.
2. Areas, roughly from most to least important for the field team:
   §3 detection · §4 square geometry · §5 editor · §6 ingest/Drive ·
   §7 performance · §8 metadata & export · §9 UI · §10 bug fixes.
3. Before merging:
   - Run `npm test`. The detector core changes in three places only (§3).
   - Run the manual checks in §13 with `make preview`.
   - Keep `QD.VERSION` in mind: every logical change bumped it, so testers
     can tell builds apart.

The commits are small and themed, so `git log --oneline main..` reads like a changelog.

---

## 1. Version map

| Version | Commit (subject) | In one line |
|---|---|---|
| 1.5.4 | Review fixes: queue, failed-item editing, editor, zip names, CSV parsing | 11 bugs found in a code review (§10.2) |
| 1.5.4 | Fix Drive "next(...).then is not a function" and editing of no-frame photos | Two bugs reported from the live site (§10.1) |
| 1.5.5 | Drive: support Shared drives, shortcuts and JPGs with generic MIME types | Real MBON folders listed as empty (§6) |
| 1.6.0 | Square-only suggested crops, kept inside the photo; blue ring for manual crops | §4, §9 |
| 1.7.0 | Parallel processing + Drive streaming, 5 % inset, exclude toggle, RAW support | §7, §4, §8, §6 |
| 1.7.1 | Editor: previous/next photo with buttons and arrow keys | §5 |
| 1.8.0 | Metadata tab: per-folder groups, CoralNet CSV, EXIF in the crops | §8 |
| 1.8.1 | Metadata: read the team's Drive layout, known localities, date-prefixed names | §8 |
| 1.8.2 | Folder picker in the Add menu; floating progress that never shifts the page | §6, §9 |
| 1.9.0 | Metadata: "Azores workshop" preset | §8 |
| 1.9.1 | Editor: "Keep square" | §5 |
| 1.10.0 | Detector: turquoise/cyan pass for the mint frame as rendered by TG-6/TG-7 | §3 |
| 1.11.0 | Detector: frames that fill the shot + white rod frames | §3 |
| 1.12.0 | Same output size for every crop in the ZIP | §8 |
| 1.13.0 | Map tab: photo positions, place by click, GPS-track merge by time | §15 |
| 1.14.0 | Metadata tab: download only the metadata CSV | §16 |
| 1.14.1 | Map tab: zoom to ~2 cm/pixel on every basemap | §17 |
| 1.14.2 | Map tab: Esri imagery depth detected per place (no grey tiles) | §17 |
| 1.14.3 | `js/site-config.js`: optional site-wide ArcGIS key for hosted copies | §18 |

---

## 2. Files

| File | Status | Role |
|---|---|---|
| `js/qd.js` | changed | Detector. New color passes `cyan` and `white`, `openingSideMax` 0.75 → 0.95, optional `satMax` in the mask, new exported helpers `fitSquare`, `fitInside`, `scaleQuad`. **Coordinate contract unchanged.** |
| `js/worker.js` | **new** | Per-photo pipeline in a Web Worker: decode → detect → square → warp → encode → thumbnail. |
| `js/raw.js` | **new** | Camera RAW support: largest embedded JPEG, plus the RAW's EXIF and orientation. |
| `js/metatab.js` | **new** | Metadata tab: presets, per-folder groups, folder-name parser, CoralNet CSV rows, EXIF content. |
| `js/exifwrite.js` | **new** | Writes an EXIF APP1 segment (date, GPS, camera, fields) into the exported crops. |
| `js/app.js` | changed | Worker-pool queue, square geometry + checks, groups, RAW preparation, exclude, uniform crop size, tabs, folder input/drop. |
| `js/editor.js` | changed | Failed items, Enter, prev/next, Keep square, clamping, preview cache, reopen redraw. |
| `js/drive.js` | changed | Recursive listing, Shared drives, shortcuts, streaming downloads, root folder name. |
| `js/export.js` | changed | UTF-8 zip names, Blob-part zip, metadata CSV, EXIF embedding, uniform resize, manifest columns. |
| `js/exif.js` | changed | GPS, TIFF-based RAW headers, trimmed strings. |
| `js/metadata.js` | changed | BOM, `;`/tab delimiters, cached CSV index, date+code filenames. |
| `js/unzip.js` | changed | UTF-8 entry names. |
| `js/grid.js` | changed | `adjusted` (blue), `excluded` (grey) and neutral queued tiers; ✕/↺ button; stats. |
| `index.html`, `css/styles.css` | changed | Add menu, folder input, tabs, Metadata panel, settings, floating progress, legend. |
| `js/geo.js` | **new** (1.13) | GPS helpers without DOM: GPX/KML/CSV track parsing, camera time → UTC, time matching, `position(it)`. |
| `js/maptab.js` | **new** (1.13) | Map tab UI on Leaflet. |
| `vendor/leaflet-1.9.4/` | **new** (1.13) | Leaflet (BSD-2), unmodified `dist/` files, loaded lazily. |
| `README.md` | changed | User-facing documentation of everything below. |

---

## 3. Detection (`js/qd.js`)

### 3.1 Turquoise / cyan pass for the mint frame (v1.10.0)

- **Why:** field users said mint frames were "hard to find".
  - **Measured on 10 field photos:** the protocol camera (Olympus/OM TG-6 /
    TG-7) renders the mint tube at hue **~165–185°** in air and **~180–205°**
    underwater. The `mint` band is 118–172°: it was tuned on Panasonic
    DMC-G8 photos, where the tube reads ~144°. Only 3–69 % of tube pixels
    fell inside the band, and the photos with the least in-band pixels were
    the ones that failed.
  - **No TG mint fixtures exist:** every mint fixture in `tests/` is from the
    G8.
- **What:** `FRAME_COLORS.cyan` (hue 158–205, sat ≥ 0.13, val ≥ 0.30).
  - It runs **only when no earlier pass reached 0.8**. Photos that already
    work keep their result and their speed.
- **Result:** the 10 field photos went from 4 ok / 2 review / 4 failed to
  9 ok / 1 review. The remaining one has a tilted camera.

### 3.2 Frames that fill the shot (v1.11.0)

- **Why:** some shots are taken with the frame very close to the camera:
  TG-7 in 1:1 format on the subtidal rig, and tight hand-held shots. The
  opening is ~85 % of the frame, and `openingSideMax: 0.75` rejected every
  one of them (10/10 TG-7 subtidal).
- **What:** `openingSideMax` 0.75 → **0.95**.
- **Safety:** the "pre-cropped output must fail" fixtures (PB110048/PB110110)
  show no frame at all, so they still fail. This was verified.

### 3.3 White / aluminium rod frames (v1.11.0)

- **Why:** subtidal programs (Canon SL1 JPG/CR2, GoPro) use thin white or
  metal rods. These have no hue of their own.
- **What:**
  - `FRAME_COLORS.white`: any hue, sat ≤ 0.30, val ≥ 0.62.
  - New optional `satMax` in `buildMask`. It is `undefined` for every other
    pass, so their behaviour does not change.
  - Last resort, run only when nothing reached 0.8. Bright sand and blown
    highlights share this band, but the structural scoring and the app's
    square/confidence checks (§4) flag the doubtful cases.
- **Result on its own:** 10 photos recovered. 7 are correct, 2 are misplaced
  but flagged for review, and 1 is an ambiguous two-cell frame. It also fixed
  fixture **AP161656**, which failed in the browser on `main` (*no plausible
  quadrilateral*) although `expected.json` expects a crop.

### 3.4 Field-sample study (v1.11.0)

125 photos from 8 cameras: TG-6, TG-7 (including 1:1 subtidal), TG ORF, Canon
PowerShot D20, Canon SL1 JPG + CR2, GoPro and iPhone. They were run through
the app in headless Chromium.

| | ok | review | failed |
|---|---|---|---|
| v1.10.0 | 85 | 10 | 30 |
| **v1.11.0** | **104** | **8** | **13** |

Still failing:
- 5 GoPro: fisheye lens, and white rods on bright sand.
- 4 hand-held iPhone crops: ~900 px, with the tube cut at the borders.
- 3 Canon subtidal shots.
- 1 CR2 under heavy green algae.

All 16 repo fixtures give the expected result. The field photos are **not**
in the repo: they belong to the field teams.

---

## 4. Square geometry of the suggested crop (`app.js` + helpers in `qd.js`)

**Why:** field users asked that the suggested crop always be a **square**,
and that **no corner ever fall outside the photo**. Before this, the detector
accepted quads up to 35 % side difference / 16° off square, and corners
could leave the image, where the editor could not grab them. The camera is
rigidly mounted on the frame, so the opening is a square in the image.

The detector output (`det.quad`) is **not modified**: the coordinate contract
in `AGENTS.md` still holds. Instead, the app post-processes it (see
`squareGeometry()` in `app.js` and the same steps in `worker.js`):

1. **`QD.fitSquare(quad)`:** least-squares similarity fit (translation +
   rotation + uniform scale, no shear) of a square to the 4 corners. Returns
   `{quad, side, residual}`, where *residual* = max corner shift / side.
2. **`QD.scaleQuad(quad, 1 − inset)`:** the square is shrunk about its centre
   by the **inset** (default **5 %**, set in ⚙, 0–20 %). The detected square
   sits on the tube's inner rim, so the field team saw PVC in the crops.
3. **`QD.fitInside(quad, W, H)`:** translate, then shrink if needed, so the
   square stays inside the photo.

Stored as `det.quadRaw` (detector), `det.quadFull` (final square) and
`det.geom` (`side`, `residual`, `moved`, `shrunk`, `inset`).

**Checks** (`applyChecks()`), which cap the confidence and add a flag:

| Condition | Effect | Rationale |
|---|---|---|
| residual > **6 %** | review (≤ 0.79) | TG photos show the opening ~5 % wider than tall (camera/mount geometry, measured). 4 % flagged normal photos, while 6 % still catches a tilted camera (15 % stretch → 6.4 %). |
| residual > 12 % | manual (≤ 0.54) | The detected outline is clearly wrong. |
| moved / shrunk to fit | review | The frame runs off the photo. |
| side outside 0.8–1.25 × batch median | review | Unusual size. The median is a fraction of the short side, taken from ≥ 5 clean detections, and re-checked when the queue drains, because early photos had no reference yet. |

---

## 5. Manual editor (`js/editor.js`)

| Change | Why | Notes |
|---|---|---|
| "No frame" (red) photos open the editor | Reported: they could not be fixed at all, although the tooltip says "click to fix corners". | Opens with a centred starting square; Reset falls back to it. |
| Enter applies | The help text promised it; no handler existed. | `showModal()` focused Reset, so Apply now gets focus. |
| **◀ ▶ / ← →** previous/next photo | Requested: review a batch in one pass. | Markers that were **dragged** are applied before moving; photos only passed through stay untouched (`state.touched`). The next Drive original is prefetched. |
| **Keep square** (default on, remembered) | Requested: manual crops must keep the quadrat's area. | A corner rebuilds the square from the diagonal, with the opposite corner fixed (resize + rotate, no shear). Dragging inside moves the square. Moves that would leave the photo are refused. Off = free corners. |
| Markers clamped into the photo on open | Reported: a corner outside the image could not be grabbed. | |
| Redraw when the same photo is reopened | The overlay showed stale markers while `state.quad` had been reset. | |
| Preview pixels cached per photo | ~48 MB `getImageData` on every drag step. | Released on close. |

---

## 6. Getting photos in (`drive.js`, `app.js`, `unzip.js`, `metadata.js`, `raw.js`)

### Drive
- **`ingestFolder` always returns a Promise.** This fixes *"next(...).then is
  not a function"* (reported) on folders that have no images directly inside.
- **Recursive listing** (depth ≤ 4). The team's layout is
  `COUNTRY/YEAR/SEASON/LOCALITY/SITE/STRATA/photo`.
- **Shared drives:** `supportsAllDrives` + `includeItemsFromAllDrives` on
  list/download, and `SUPPORT_DRIVES` in the Picker. Without them, folders of
  an organisation drive list as empty (seen on a real MBON folder).
- **Shortcuts** are followed. Images are detected **by extension** too
  (`application/octet-stream`, `image/JPEG`).
- One failed download is **skipped and reported** instead of aborting the
  whole folder. When nothing is found, the message lists the MIME types that
  were found.
- **Streaming:** 4 downloads in flight; each photo enters the queue as soon
  as it arrives, with backpressure: downloading pauses while more than
  3 × workers photos wait. Before, everything was downloaded first and kept
  in memory (~25 GB for 3000 photos).
- **Originals released** after processing (`releaseOriginal`); they are
  re-fetched only if the photo is opened in the editor (`ensureBlob`).
- The root folder name is prepended to every path, because it feeds the
  metadata groups (§8).

### Local files
- **＋ Add photos ▾ → A folder (with all its subfolders)**, using a
  `webkitdirectory` input. Clicking the drop area does the same. Dropping a
  folder from Finder/Explorer is traversed too (`filesFromDrop`). CSVs inside
  are joined as metadata.

### Zip / CSV
- Zip entry names decoded as **UTF-8**. Before, every non-ASCII byte became
  `_`: `Pirámides` → `Pir__mides`, which also broke the CSV join.
- CSV: the **BOM** is stripped and **`;` / tab** delimiters are sniffed.
  Excel in ES/PT/FR locales saves `;`. The index is built once per CSV, not
  once per image.
- Filenames like `20251028_IMG111148.jpg` now give code = `IMG111148`, not
  site.

### RAW (v1.7.0)
- CR2/CR3, NEF/NRW, ORF, ARW, DNG, RW2, RAF, PEF, SRW. Browsers cannot
  demosaic RAW, so `raw.js` extracts the **largest embedded baseline or
  progressive JPEG** by walking the segments of every SOI candidate. Lossless
  SOF3 raw data is skipped.
- EXIF comes from the RAW's TIFF header (ORF "RO"/RW2 magics accepted) and
  its orientation is applied.
- Photos whose embedded JPEG is under 2500 px are flagged; this is common in
  ORF and older CR2.
- Tested on Canon 5D II CR2 (5616×3744), Nikon D3S NEF (4256×2832), Canon
  Rebel XTi CR2 (1936×1288, flagged) and a synthetic ORF.

---

## 7. Performance (`js/worker.js`, `app.js`, `export.js`)

- **Why:** a ~3000-photo folder "took forever". One 16 MP photo took ~2 s on
  the main thread (1.6 s detection + 1 s encode), one photo at a time.
- **What:**
  - **Worker pool** of (cores − 1) workers, max 8. Each worker runs the
    whole pipeline for one photo.
  - **Fallback** to the main-thread `processOne()` when Worker or
    OffscreenCanvas is missing, or when a worker errors.
  - **Zip built from Blob parts.** Each crop is read once for its CRC; before,
    all crops were held in memory at once.
- **Measured:** 60 photos from a mocked Drive with 300 ms latency took
  0.75 s/photo on a 2-core VM, with **0 originals left in memory**. A 4-core
  machine should do better.
- **⚠ Invariant:** `worker.js` (`processPhoto`) and `app.js`
  (`processOne` + `squareGeometry`) implement the same pipeline. **Change
  both together**: square fit → inset → fit inside → warp side.

---

## 8. Metadata and export (`metatab.js`, `exifwrite.js`, `export.js`)

**Why:** the team uploads the crops **plus a metadata CSV** to CoralNet. They
used to build that CSV by hand for thousands of photos.

- **Metadata tab:** photos are grouped by **source folder** (Drive path,
  zip folder, picked or dropped folder). There is one row per group, ⇣ copies
  a value down a column, and export warns when required fields are empty.
- **Presets** (`PRESETS` in `metatab.js`), each with its own columns,
  defaults, folder parser and fixed values:
  - **Intertidal — MBON Pole to Pole (CoralNet):**
    - Columns: `Name, Date, country, state, locality, site, strata,
      Height (cm), Latitude, Longitude, Depth, Camera, Photographer,
      Water quality, Strobes, Framing gear used, White balance card,
      Comments`, exactly as in the team's 6670-row `metadata.csv`.
    - Fixed values: 42 cm, no strobes, 25x25cm.
    - `strata` is chosen from HIGHTIDE/MIDTIDE/LOWTIDE.
    - `season` (FRIO/CALIDO) is kept in EXIF and the manifest only.
  - **Azores workshop (CoralNet):** Aux = `Group, country, locality, site,
    strata`; PORTUGAL / ILHA TERCEIRA / *Azores Workshop 2026*;
    `Photographer` falls back to `Group`. The CSV header is byte-identical to
    the workshop file.
- **Folder parser** for the team's Drive layout
  `COUNTRY/YEAR/SEASON/LOCALITY/SITE/STRATA/photo`:
  - Read from the deepest folder up, so links to a lower folder work too.
  - ALTO/MEDIO/BAJO (or HIGH/MID/LOW) → HIGHTIDE/MIDTIDE/LOWTIDE.
  - **state** and **AMP code** (`Comments`) are pre-filled from the 12
    localities of the 2026 campaign. New localities are learned in this
    browser as they are typed.
  - Tested on the real layout: only the photographer had to be typed.
- **EXIF:** GPS is now read. Exported crops get an EXIF block: date, GPS,
  make/model, photographer as Artist, and the group fields in
  ImageDescription/UserComment. Canvas output had no metadata at all.
- **File names:** like the source photo, `YYYYMMDD_` + name by default (the
  team's convention). CoralNet matches the CSV's `Name` to the file name.
- **Same output size (v1.12.0):**
  - Crops are warped at the opening's **native** resolution; the 1600-px cap
    is gone (TG openings are ~1700 px).
  - At export every crop is resampled to **one common side**: the batch
    median by default, or a fixed px value or each crop's own size, set in
    ⚙. All crops show 25 × 25 cm, so one size means one **px/cm** scale.
  - `manifest.csv` gains `square_side_px` and `output_px`.
- **Exclude:** ✕ on a card keeps the photo out of the ZIP, and ↺ brings it
  back. Excluded photos stay in `manifest.csv` / `review.json` as
  `excluded`.
- **Zip names** are written as UTF-8 with general-purpose bit 11, plus a
  valid DOS timestamp.

---

## 9. UI

| Change | Why |
|---|---|
| **Blue** ring = cropped by hand; grey = excluded; queued = neutral (was red) | Requested: corrected photos should stand out. Red queued cards read as "failed". |
| "Need manual corners" no longer counts fixed photos | The counter never went down while working. |
| **Progress** in a small fixed corner card; the stats line keeps its height | Reported: the bar pushed the grid around while working on processed photos. Measured: the grid top stays constant. |
| **＋ Add photos ▾** menu (folder first, files/zip second) | Requested: "+" must allow picking a folder with its subfolders. |
| Photos / Metadata tabs; ⚙ gains Inset and Crop size | §4, §8 |

---

## 10. Bug fixes

### 10.1 Reported from the live site
- Red "no frame" photos could not be opened in the editor.
- Drive: *"next(...).then is not a function"*.
- Drive: folders in a Shared drive listed as empty.
- Mint frames often not found (§3.1).

### 10.2 Found in code review (v1.5.4)
1. Photos dropped while a batch was running stayed "queued" forever, because
   the queue iterated a snapshot.
2. "Need manual corners" counted crops that were already fixed.
3. Enter did nothing in the editor.
4. Reopening the same photo showed stale markers.
5. The editor preview re-read the full image on every drag.
6. Zip import replaced accents with `_`.
7. Zip export: Latin-1 names without the UTF-8 flag, and DOS date 0.
8. CSV: no BOM handling, and only `,` as delimiter.
9. CSV index rebuilt per image.
10. `20251028_IMG111148.jpg` was parsed with code as site.
11. `MAX_DETECT_MP` was declared twice.

---

## 11. Settings and storage (localStorage)

| Key | Meaning | Default |
|---|---|---|
| `quadrat.inset` | Shrink of the suggested square, % | 5 |
| `quadrat.cropSize` | `median` / `native` / px number | `median` |
| `quadrat.lockSquare` | Editor Keep square | on |
| `quadrat.meta.v2` | Preset, name format, last values, learned localities | intertidal, date prefix |
| `quadrat.gpsMerge` | Map tab: camera / CSV time zone, use EXIF zone, clock offset, max gap, end tolerance, overwrite, basemap | browser zone, on, —, 60 s, 30 s, off, Sentinel-2 |
| `quadrat.arcgisKey` | Optional ArcGIS API key (Esri World Imagery) | none |
| `quadrat.clientId`, `quadrat.welcomed` | unchanged | |

---

## 12. Invariants and gotchas

- **Detector contract:** `det.quad` is in source pixels, as `AGENTS.md`
  describes. The square / inset / fit-inside steps live in the app and the
  worker; they never touch `det.quad`.
- **Keep `worker.js` and `processOne` in sync** (§7).
- **Color pass order:** mint → yellow → cyan → white. `cyan` and `white` are
  skipped when an earlier pass reached 0.8. Changing that threshold changes
  which pass wins on borderline photos.
- **`white` is the riskiest pass,** because bright sand shares its band. It is
  guarded by being the last resort and by the app's square/size checks;
  watch it if fixtures with sand are added.
- **Batch-relative checks** (typical size) are re-run when the queue drains,
  so a photo's flags can change at the end of a batch.
- **Drive originals are released** after processing. Anything that needs the
  original later must call `ensureBlob(it)`.
- **The test environment of this branch could not run `npm test`.**
  Everything was verified in headless Chromium through the real UI
  (`make preview`-style serving), against all 16 fixtures and the field
  samples. CI runs `npm test` on the PR.

---

## 13. Manual checks (`make preview`)

1. Drop a few photos; while they process, drop more. All get processed and
   the grid does not jump.
2. Click a red card → editor with a starting square → drag a corner (it stays
   a square) → ← / → to other photos → Esc. Only the dragged photo turns
   blue.
3. ⚙ → Inset 5 % and Crop size *median*. Export: every crop has the same
   size, and `manifest.csv` has `square_side_px` / `output_px`.
4. Metadata tab with a folder `ARGENTINA/2026/FRIO/CABO DOS BAHIAS/ENTRE
   CALETAS/ALTO`: the fields are pre-filled (state CHUBUT, AMP5). Type the
   photographer and export: `metadata_coralnet.csv` is there, and the crops
   carry EXIF (date, GPS).
5. Drive: sign in and paste a folder that has only subfolders, or one in a
   Shared drive: the photos stream in.
6. Drop a `.CR2` / `.ORF`: it is processed, and an ORF with a small preview
   is flagged.

---

## 14. Open points (not changed here)

- **Add TG-6/TG-7 mint fixtures to `tests/`.** None exist, which is why §3.1
  went unnoticed. The field team has photos; ask them which can be
  published.
- **Two-cell rod frames** (e.g. a cell plus a narrow side cell, or two
  stacked cells): which cell is the quadrat? The detector currently picks one
  by score.
- **GoPro:** fisheye correction would be needed.
- **A CoralNet `annotations.csv` in a folder** joins one arbitrary point row
  per image into the manifest.
- **Subfolder paths** are used for groups but not written as a manifest
  column.
- **Public single-photo Drive links** are fetched through
  `lh3.googleusercontent.com`, which likely strips EXIF, and the original
  name is lost (`drive_<id>.jpg`).

---

## 15. Map tab (v1.13.0, part 8 of the stack)

**Why:** the team needs every photo positioned for the CoralNet CSV and for
OBIS. Some cameras have no GPS (or lose it underwater), and subtidal teams
log a track with a handheld GPS on the surface buoy. Requested: (1) see the
photos on a freely usable satellite map; (2) give a position to photos
without one, by clicking on the map or by merging a GPS file by time, as
CSIRO's iBenthos geotagging tool does.

**What:**
- **Map** (`maptab.js`, Leaflet 1.9.4 vendored, loaded on first open). Colour
  = source: camera EXIF / GPS track / placed on the map. Popup: thumbnail,
  camera time, UTC, coordinates, *Move…*, *Remove position* or *Back to camera
  GPS*.
- **Basemaps** — chosen for licence, not only looks:
  - Sentinel-2 cloudless (EOX): no key; free for non-commercial use with
    attribution (CC BY-NC-SA 4.0). 10 m pixels, so it shows the site, not the
    quadrat. If the 2024 layer is not served, it falls back to 2020.
  - Esri World Imagery: sub-metre, but Esri's terms require an API key outside
    Esri's own apps, so it is offered only when a (free) ArcGIS Location
    Platform key is set in ⚙.
  - OpenStreetMap: place names.
- **Place by click:** list of photos without a position (thumbnails, folder
  filter, select all). The next map click positions the ticked photos.
- **Merge a GPS track by time** (`geo.js`). This is a re-implementation of the
  iBenthos method (LGPL tool, no code copied):
  - Track formats:
    - GPX: `trkpt`, `rtept` and `wpt` with `<time>`.
    - KML: `gx:Track`, or Placemarks with a TimeStamp.
    - CSV/TXT: columns for lat, lon and either one date-time column or
      separate date and time columns. Delimiter `;`, tab or `,`; decimal commas
      accepted; ISO or day-first dates; a time-zone selector for times written
      without a zone.
  - **Photo time → UTC:** the camera writes local wall-clock time with no
    zone. The zone comes from a selector (default: the browser's zone), or
    from EXIF `OffsetTimeOriginal` when the camera wrote it. EXIF
    `SubSecTimeOriginal` is used when present. `exif.js` now reads these
    three tags.
  - **Clock offset:** typed as ±hh:mm:ss, or computed from a **photo of the
    GPS screen**: the user picks it and types the time the GPS shows (and the
    zone it shows time in). Offset = GPS UTC − camera UTC.
  - **Matching:** binary search in the sorted track.
    - Linear interpolation between the two fixes around the photo time, if
      they are at most *Max gap* apart (default 60 s).
    - Inside a larger gap, only a fix within *Tolerance* (30 s) of the photo
      time is accepted. Before or after the track, the end fix is used within
      the same tolerance.
    - Anything else is rejected with a reason ("before the track", "in a gap
      of the track…"). When nothing matches, the preview prints a photo's UTC
      time next to the track's span, so a wrong zone or offset is obvious.
  - *Preview* draws the would-be positions (dashed) and the track (yellow);
    *Apply* commits them. Only photos without a position change, unless
    *also replace the camera's own GPS* is ticked. Hand-placed positions are
    never overwritten.
- **Where positions go:**
  - `it.geo = {lat, lon, source: 'map'|'track', dt, gap, track}`.
  - `QDGeo.position(it)` returns it, or else the EXIF GPS. `metatab.js`
    (CoralNet `Latitude`/`Longitude` and crop EXIF) and `export.js` read it.
  - `manifest.csv` gains `latitude`, `longitude` and `gps_source`
    (`exif`, `map` or `track (±N s)`).
- **Fixed on the way:** `exifwrite.js` could write 60 seconds of arc
  (44.9° → 44°53'60") because of float noise. It now works in integer
  1/10000 s and carries over.

**Tested** (headless Chromium, real UI). The test batch was 2 photos with
camera GPS plus 6 without, one of them a "GPS screen" photo. The track was a
synthetic GPX with 5 s fixes; the camera was set to UTC−3 and 90 s slow.
- Without an offset, 5 of 6 photos matched (1 after the track). The reference
  photo gave an offset of +00:01:30. Apply then put each photo at the
  expected interpolated longitude.
- The photo outside the track was placed by click, then removed again from
  its popup.
- In the exported ZIP, the CSV, the manifest and the crops' EXIF carry the
  positions.
- Unit checks in the page: zone and offset parsing, ISO / zoned / zoneless /
  epoch times, KML (both forms), CSV (`date;time` with decimal commas, ISO
  with Z), interpolation, end tolerance, gap rejection, and EXIF zone plus
  sub-seconds.
- Map tiles could not be fetched in the test environment (no outside
  network). **Check the basemaps by eye with `make preview`.**

**Open:** clustering if a batch has thousands of points at one site (a
canvas renderer is used, so it stays fast, but overlapping markers stack);
per-folder time zones (one zone per merge for now).

---

## 16. Download only the metadata CSV (v1.14.0, part 9 of the stack)

**Why:** after uploading to CoralNet, the field team sometimes finds errors
in the metadata (a wrong site or photographer). They fix them in the
Metadata tab, but then had to export the whole ZIP, crops included, just to
get the corrected CSV.

**What:**
- **⬇ Download metadata.csv** button, visible only in the Metadata tab.
  It downloads the preset's CSV on its own as
  `metadata_coralnet-<timestamp>.csv`.
- It warns about empty required fields, like Export does.
- `export.js`:
  - `cropNames()` was taken out of `exportZip`. It gives each crop its file
    name, including the `_2`, `_3`… suffixes for duplicates.
  - The new `metadataCsv()` and `exportZip` both use it, so the CSV's `Name`
    column always matches the files of a ZIP exported from the same batch
    (CoralNet joins on it).
  - A `download()` helper is now shared by both.

**Tested** (headless Chromium): the button is hidden on the Photos tab and
shown on the Metadata tab. On the same batch, the CSV it downloads is
byte-identical to `metadata_coralnet.csv` inside the exported ZIP.

---

## 17. Deeper zoom in the Map tab (v1.14.1, part 10 of the stack)

**Why:** quadrats are often ~1 m apart. The maps stopped at zoom 19, where
those points overlap.

**What:** every basemap now allows zoom 22 (~2 cm per screen pixel at
43° S). Past each layer's native resolution the tiles are stretched:
Sentinel-2 beyond z14, Esri and OSM beyond z19. The image gets blurry, but
the markers stay sharp and separate, and the scale bar stays exact.
*Zoom to photos* now stops at z19 instead of z17.

**Imagery note:** no free, keyless satellite layer reaches ~1 m
worldwide. Esri World Imagery (0.3–0.5 m on many coasts) is the best
option, and its terms require an API key. A free ArcGIS Location Platform
key in ⚙ enables it.

**Esri depth (v1.14.2):** Esri imagery is deeper in some places than in
others: z19 on many coasts, but only z17 (~0.9 m/px) at Puerto Madryn
(checked with Esri's tilemap service). Requesting a missing level returns
grey "no data" tiles. When the Esri layer is shown at z ≥ 16,
`adjustEsriNative()` asks the layer's `tilemap` endpoint (19 → 15) which
level exists at the map centre. It caches the answer per ~5 km cell and
sets `maxNativeZoom`, so deeper zooms stretch the deepest real imagery. On
any error it keeps z19. Tested with mocked Esri services (imagery only to
z17): it probed 19, 18, 17 and then requested z17 tiles at zoom 22.

**Tested:** with 86 geotagged photos spread over ~35 × 73 m, the map zooms
to the limit (scale bar 2 m) and the markers stay distinct.

---

## 18. Per-site configuration (v1.14.3, part 11 of the stack)

**Why:** a hosted copy of the tool, such as the one at
culturaoceanica.org/fotocuadrantes/ used for courses, should show
high-resolution Esri imagery to every visitor. Each visitor should not have
to create an ArcGIS key, and the key must not live in the shared code.

**What:**
- New `js/site-config.js`, loaded before everything else. In this
  repository it sets `window.QD_SITE_CONFIG = { arcgisKey: '' }`, i.e. no
  behaviour change.
- A deployment can overwrite that file at deploy time, for example from a
  CI variable, with a key that has only the Basemaps privilege and is
  restricted to its domain.
- `maptab.js`: a key set in ⚙ wins; otherwise the site key is used.
- When Esri is available and the user never picked a basemap, the map
  opens on Esri; otherwise it opens on Sentinel-2 as before.
- ⚙ shows a note when the site already provides a key.

**Tested:** without a site key, the layers and the default basemap are
unchanged. With a site key (served by a mocked `site-config.js`), Esri is
listed, selected and loads, and the ⚙ note shows.

