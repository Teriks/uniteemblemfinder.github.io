// Node build for the single-file Pokémon UNITE emblem optimizer.
//
// Pipeline (pure Node, no Python):
//   1. run the JS precompute (prepare-data.mjs) -> build/dataset.json
//      (grade-dominance + DATASET precompute + color tables, as byte-identical
//      compact JSON strings)
//   2. bundle/minify the app JS, the Blob web-worker (recipe_search + search_worker)
//      and the CSS with esbuild
//   3. base64-inline every referenced icon PNG as a data: URI
//   4. inject everything into src/index.html
//   5. write index.html and sync it to the github.io repo folder
//
// A single `npm run build` does all of the above.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { prepareData } from './prepare-data.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const ICONS_DIR = path.join(ROOT, 'icons');
const OUT_PATH = path.join(ROOT, 'index.html');
const REPO_OUT = path.join(ROOT, 'repo', 'uniteemblemfinder.github.io', 'index.html');

const args = new Set(process.argv.slice(2));
const WATCH = args.has('--watch');

// --- helpers -------------------------------------------------------------

const read = (p) => fs.readFileSync(p, 'utf8');

// Literal placeholder substitution. We deliberately use split/join instead of
// String.replace because the injected payloads contain `${...}` template
// literals and `$`/`/` sequences that String.replace would mangle via its
// special replacement patterns ($&, $1, ...).
function inject(haystack, token, value) {
  if (!haystack.includes(token)) {
    throw new Error(`Placeholder "${token}" not found in template`);
  }
  return haystack.split(token).join(value);
}

const MINIFY_JS = {
  loader: 'js',
  minify: false,
  // Whitespace + syntax minification only. We intentionally do NOT minify
  // identifiers: the main app script and the data-injection <script> live in
  // separate top-level <script> blocks, so renaming globals (EMBLEMS, DATASET,
  // …) would break cross-block references. Identifier savings are negligible
  // next to the ~18 MB of inlined icons anyway.
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  legalComments: 'none',
  charset: 'utf8',
};

// src/ is the sole source of truth for the page (index.html, app.js, styles.css).
function requireSources() {
  for (const name of ['index.html', 'app.js', 'styles.css']) {
    if (!fs.existsSync(path.join(SRC, name))) {
      throw new Error(`Missing src/${name}. The src/ directory is the build's source of truth.`);
    }
  }
}

function collectIconCodes(emblems) {
  const codes = new Set();
  for (const em of emblems) {
    const c = em.codes || {};
    for (const v of Object.values(c)) codes.add(v);
  }
  return [...codes].sort();
}

function buildIconsJson(emblems) {
  const codes = collectIconCodes(emblems);
  const icons = {};
  const missing = [];
  for (const code of codes) {
    const p = path.join(ICONS_DIR, `${code}.png`);
    if (!fs.existsSync(p)) { missing.push(code); continue; }
    const raw = fs.readFileSync(p);
    icons[code] = 'data:image/png;base64,' + raw.toString('base64');
  }
  if (missing.length) {
    throw new Error(
      `Cannot embed icons: ${missing.length} files missing in icons/ ` +
      `(e.g. ${missing[0]}). Run: npm run fetch:icons`,
    );
  }
  const mb = Object.values(icons).reduce((a, v) => a + v.length, 0) / (1024 * 1024);
  return { json: JSON.stringify(icons), count: codes.length, mb };
}

async function build() {
  requireSources();
  const data = prepareData();

  const indexTemplate = read(path.join(SRC, 'index.html'));
  const appSrc = read(path.join(SRC, 'app.js'));
  const cssSrc = read(path.join(SRC, 'styles.css'));
  const recipeSearchSrc = read(path.join(ROOT, 'recipe_search.js'));
  const searchWorkerSrc = read(path.join(ROOT, 'search_worker.js'));

  // --- web worker: recipe_search + search_worker, minified, as a Blob string.
  // Concatenation order matters: recipe_search.js first, then search_worker.js.
  const workerCombined = recipeSearchSrc + '\n' + searchWorkerSrc;
  const workerMin = (await esbuild.transform(workerCombined, MINIFY_JS)).code;
  const workerLiteral = JSON.stringify(workerMin);

  // --- main app JS: inline recipe_search + color tables + worker, then minify.
  let appJs = appSrc;
  appJs = inject(appJs, '__RECIPE_SEARCH_JS__', recipeSearchSrc);
  appJs = inject(appJs, '__COLOR_THRESHOLDS_JS__', data.colorThresholdsJson);
  appJs = inject(appJs, '__COLOR_BONUS_JS__', data.colorBonusJson);
  appJs = inject(appJs, '__COLOR_BONUS_STAT_JS__', data.colorBonusStatJson);
  appJs = inject(appJs, '__SEARCH_WORKER_JS__', workerLiteral);
  const appMin = (await esbuild.transform(appJs, MINIFY_JS)).code;

  // --- CSS ---------------------------------------------------------------
  const cssMin = (await esbuild.transform(cssSrc, { loader: 'css', minify: true })).code.trim();

  // --- icons -------------------------------------------------------------
  const emblems = JSON.parse(data.emblemsJson);
  const icons = buildIconsJson(emblems);

  // --- assemble HTML -----------------------------------------------------
  let html = indexTemplate;
  html = inject(html, '{{STYLES}}', cssMin);
  html = inject(html, '{{EMBLEM_COUNT}}', String(data.emblemCount));
  html = inject(html, '{{APP_SCRIPT}}', appMin);
  html = inject(html, '__EMBLEMS_JSON__', data.emblemsJson);
  html = inject(html, '__ICONS_JSON__', icons.json);
  html = inject(html, '__DATASET_JSON__', data.datasetJson);

  // --- write + sync ------------------------------------------------------
  fs.writeFileSync(OUT_PATH, html);
  fs.mkdirSync(path.dirname(REPO_OUT), { recursive: true });
  fs.copyFileSync(OUT_PATH, REPO_OUT);

  const sizeMb = Buffer.byteLength(html, 'utf8') / (1024 * 1024);
  console.log(
    `Wrote ${path.basename(OUT_PATH)} (${sizeMb.toFixed(1)} MB, ${data.emblemCount} emblems, ` +
    `${icons.count} embedded icons ~${icons.mb.toFixed(1)} MB)`,
  );
  console.log(`Synced -> ${path.relative(ROOT, REPO_OUT)}`);
}

async function main() {
  await build();
  if (!WATCH) return;

  console.log('\nWatching for changes (Ctrl+C to stop)…');
  const watched = [
    SRC,
    path.join(ROOT, 'recipe_search.js'),
    path.join(ROOT, 'search_worker.js'),
    path.join(ROOT, 'emblems_data.json'),
    path.join(ROOT, 'emblem_sets_data.json'),
  ];
  let timer = null;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      build().then(
        () => console.log('Rebuilt OK\n'),
        (err) => console.error('Build failed:', err.message, '\n'),
      );
    }, 200);
  };
  for (const target of watched) {
    if (!fs.existsSync(target)) continue;
    fs.watch(target, { recursive: fs.statSync(target).isDirectory() }, trigger);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
