# Working notes for contributors (human or AI)

## Always run the tests before ending a coding task

Run the full suite and make sure it is green before you stop:

```bash
npm install     # once — jpeg-js
npm test
```

`npm test` must report **14 passed / 14 total** (add cases to
`tests/expected.json` when you add fixtures). CI runs the same command on
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
