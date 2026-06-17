# Pokémon UNITE Emblem Optimizer

A single self-contained `index.html` (all JS, CSS and icons inlined) that runs
the emblem optimizer entirely in the browser. The same file is synced to
`repo/uniteemblemfinder.github.io/index.html` for GitHub Pages.

The toolchain is **pure Node** (no Python). Requires Node 18+ (for built-in
`fetch`).

## Build

```powershell
npm install        # one-time: installs esbuild
npm run build      # produces index.html + syncs the repo copy
```

`npm run build` does everything (offline — it uses the already-fetched
`emblems_data.json` and `icons/`):

1. Runs the JS precompute (`prepare-data.mjs`) -> `build/dataset.json`.
2. Bundles + minifies the app JS, the web worker and the CSS with **esbuild**.
3. Base64-inlines every icon from `icons/`.
4. Injects the precomputed data + assets into `src/index.html`.
5. Writes `index.html` (repo root) and copies it to
   `repo/uniteemblemfinder.github.io/index.html`.

Other commands:

```powershell
npm run watch        # rebuild on changes to src/ and the data/worker files
npm run data         # run the precompute on its own (-> build/dataset.json)
npm run fetch        # re-download source data + icons (network)
npm run fetch:source # just re-scrape unitedb_page.html
npm run fetch:data   # just re-pull emblems_data.json / emblem_sets_data.json
npm run fetch:icons  # just download any missing icon PNGs
```

## Project layout

```
src/index.html        HTML shell (placeholders filled at build time)
src/styles.css        all page CSS
src/app.js            main app script (browser globals; not ES modules)
recipe_search.js      shared solver, inlined into BOTH the app and the worker
search_worker.js      heavy search worker body
prepare-data.mjs      precompute -> build/dataset.json (exports prepareData)
parse-emblems.mjs     fetch + parse emblem data -> emblems_data.json, ...
fetch-icons.mjs       download icon PNGs into icons/ (dynamic CDN discovery)
fetch-unitedb.mjs     scrape the unite-db boost-emblems page
lib/pyjson.mjs        Python-compatible compact JSON serializer
lib/unitedb.mjs       source/CDN config, HTTP helpers, CDN discovery
build.mjs             esbuild assembly -> single-file HTML
build/dataset.json    intermediate data (git-ignored)
```

## Pipeline split

- **Data** (`prepare-data.mjs`) — grade-dominance flags, the `DATASET`
  precompute tables, and the color set thresholds/bonus tables. It writes the
  exact compact JSON strings to `build/dataset.json` via `lib/pyjson.mjs`, which
  reproduces Python's formatting (trailing `.0` floats, `\uXXXX` escaping) so the
  injected payloads stay byte-identical to the old build.
- **Assembly** (`build.mjs`) — all HTML/CSS/JS assembly, bundling, minification,
  icon base64 inlining and the final single-file emit. It imports `prepareData()`
  directly (no subprocess).

The build is offline and deterministic. Refreshing the upstream data/icons is a
separate, explicit step (`npm run fetch`).

## Source & CDN configuration

All upstream URLs are configurable via environment variables (with sensible
defaults), so a host change needs no code edit:

| Env var           | Default                                                    | Used by |
|-------------------|------------------------------------------------------------|---------|
| `UNITEDB_BASE`    | `https://unite-db.com`                                      | base for the three URLs below |
| `EMBLEMS_URL`     | `${UNITEDB_BASE}/emblems.json`                              | `parse-emblems.mjs` |
| `SETS_URL`        | `${UNITEDB_BASE}/emblem_sets.json`                         | `parse-emblems.mjs` |
| `UNITEDB_PAGE_URL`| `${UNITEDB_BASE}/boost-emblems`                            | `fetch-unitedb.mjs`, CDN discovery |
| `ICON_CDN_BASE`   | _(discovered dynamically; falls back to the known CDN)_     | `fetch-icons.mjs` |

### Icon CDN — dynamic discovery

The emblem icon CDN base is **discovered dynamically** from unite-db rather than
hardcoded. The boost-emblems page is a Nuxt app whose JS bundle builds icon URLs
as `https://<cdn>/emblems/pokedex/<name>.png`; `fetch-icons.mjs` fetches the
page, enumerates its `/_nuxt/*.js` bundles, and extracts the base from the first
match. Resolution order:

1. **dynamic discovery** from the live unite-db source (default behavior)
2. **`ICON_CDN_BASE`** env var (manual override / fallback)
3. built-in **default constant** (last resort, currently
   `https://d275t8dp8rxb42.cloudfront.net/emblems/pokedex`)

The chosen source is logged at fetch time. Discovery only runs when icons are
actually missing, so a normal build/refresh with a full `icons/` cache makes no
network calls.

### The web worker

The worker is built as `recipe_search.js + "\n" + search_worker.js`, minified,
JSON-stringified and inlined as `SEARCH_WORKER_CODE`, which the page turns into a
`Blob` URL at runtime. `recipe_search.js` is also inlined directly into the main
app script (it is shared by both the main thread and the worker).

### Notes

- JS is minified for whitespace/syntax only — identifier renaming is disabled on
  purpose so cross-`<script>` globals (`EMBLEMS`, `DATASET`, …) keep working.
- `src/` is the sole source of truth for the page. Edit `src/index.html`,
  `src/styles.css` and `src/app.js` directly.
