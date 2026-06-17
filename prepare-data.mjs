// Data precompute (ported from the former Python precompute).
//
// Produces build/dataset.json containing the exact compact JSON strings that
// build.mjs inlines into the page:
//   * grade-dominance flags (the `gd` field added to each emblem)
//   * the dataset-fixed DATASET precompute tables
//   * the color set thresholds / bonus tables (from emblem_sets_data.json)
//
// Serialization goes through lib/pyjson so the injected payloads stay
// byte-identical to the previous Python output (float ".0" + \uXXXX escaping).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { F, pyStringify } from './lib/pyjson.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(ROOT, 'emblems_data.json');
const SETS_PATH = path.join(ROOT, 'emblem_sets_data.json');
const BUILD_DIR = path.join(ROOT, 'build');
const OUT_PATH = path.join(BUILD_DIR, 'dataset.json');

const GRADE_ORDER = ['bronze', 'silver', 'gold'];
const EMBLEM_STAT_IDS = ['hp', 'atk', 'spatk', 'def', 'spdef', 'spd', 'crit', 'cdr'];

const COLOR_BONUS_STAT_MAP = {
  'Sp. Attack': 'spatk%',
  HP: 'hp%',
  Atk: 'atk%',
  Defense: 'def%',
  'Sp. Defense': 'spdef%',
  AS: 'atkspd%',
  CDR: 'cdr%',
  Speed: 'msp%',
  Tenacity: 'hind%',
  'Unite Charge Rate': 'unite%',
  'Damage Reduction': 'dmgflat',
};

// Grade B dominates grade A iff B >= A on every stat axis (with a strict
// inequality, or B being the higher grade for identical vectors). Mirrors
// the old Python compute_grade_dominance exactly.
function computeGradeDominance(grades) {
  const present = GRADE_ORDER.filter((g) => g in grades);
  const dom = {};
  for (const a of present) {
    for (const b of present) {
      if (a === b) continue;
      const geAll = EMBLEM_STAT_IDS.every(
        (k) => (grades[b][k] ?? 0) >= (grades[a][k] ?? 0) - 1e-9,
      );
      if (!geAll) continue;
      const strict = EMBLEM_STAT_IDS.some(
        (k) => (grades[b][k] ?? 0) > (grades[a][k] ?? 0) + 1e-9,
      );
      if (strict || GRADE_ORDER.indexOf(b) > GRADE_ORDER.indexOf(a)) {
        (dom[a] ??= []).push(b);
      }
    }
  }
  return dom;
}

// Matches str(round(float(v), 3)) closely enough for distinct-vector counting:
// the function is injective per distinct value, so the count matches Python.
function numKey(v) {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

function computeDatasetPrecompute(emblems) {
  const statRanges = {};
  const colorCapacity = {};
  const colorSignatures = {};
  const statVectors = new Set();
  for (const e of emblems) {
    const colors = e.c || [];
    for (const col of colors) colorCapacity[col] = (colorCapacity[col] || 0) + 1;
    const sig = [...colors].sort().join(',');
    (colorSignatures[sig] ??= []).push(e.n);
    const g = e.g || {};
    for (const grade of Object.keys(g)) {
      const stats = g[grade] || {};
      for (const s of EMBLEM_STAT_IDS) {
        const v = stats[s] ?? 0;
        const r = statRanges[s];
        if (r === undefined) statRanges[s] = { min: v, max: v };
        else {
          if (v < r.min) r.min = v;
          if (v > r.max) r.max = v;
        }
      }
      statVectors.add(EMBLEM_STAT_IDS.map((s) => numKey(stats[s] ?? 0)).join('|'));
    }
  }
  // statRanges in EMBLEM_STAT_IDS order; min/max are Python floats.
  const statRangesOut = {};
  for (const s of EMBLEM_STAT_IDS) {
    const r = statRanges[s] ?? { min: 0, max: 0 };
    statRangesOut[s] = { min: F(r.min), max: F(r.max) };
  }
  return {
    statRanges: statRangesOut,
    colorCapacity,
    colorSignatures,
    statVectorCount: statVectors.size,
    emblemCount: emblems.length,
  };
}

export function prepareData({ log = console.log } = {}) {
  const emblems = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  let gradeDomCount = 0;
  for (const e of emblems) {
    const dom = computeGradeDominance(e.g || {});
    if (Object.keys(dom).length) {
      e.gd = dom;
      gradeDomCount += Object.keys(dom).length;
    }
  }

  const dataset = computeDatasetPrecompute(emblems);

  const sets = JSON.parse(fs.readFileSync(SETS_PATH, 'utf8'));
  const colorThresholds = {};
  const colorBonus = {};
  const colorBonusStat = {};
  for (const [k, v] of Object.entries(sets)) {
    colorThresholds[k] = v.thresholds;
    colorBonus[k] = v.bonuses;
    colorBonusStat[k] = COLOR_BONUS_STAT_MAP[v.stat] ?? v.stat.toLowerCase();
  }

  const payload = {
    // emblems: every number is a float -> forceFloat. gd holds only strings.
    emblemsJson: pyStringify(emblems, true),
    datasetJson: pyStringify(dataset, false),
    emblemCount: emblems.length,
    colorThresholdsJson: pyStringify(colorThresholds, false),
    colorBonusJson: pyStringify(colorBonus, false),
    colorBonusStatJson: pyStringify(colorBonusStat, false),
  };

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));

  log(
    `Derived data: ${gradeDomCount} dominated grade variants flagged; ` +
    `${Object.keys(dataset.colorCapacity).length} colors, ` +
    `${dataset.statVectorCount} distinct stat vectors.`,
  );
  log(
    `Wrote ${path.relative(ROOT, OUT_PATH)} ` +
    `(${payload.emblemsJson.length} bytes of emblem JSON, ${payload.emblemCount} emblems)`,
  );
  return payload;
}

const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isMain) {
  prepareData();
}
