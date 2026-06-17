// Fetch boost-emblem data from unite-db and export the optimizer's JSON
// (ported from the former Python parser).
//
// Outputs (compact, Python-compatible formatting via lib/pyjson):
//   emblems_data.json       - per-Pokémon stats/colors/icon codes (+ gd added later)
//   emblem_sets_data.json   - color set thresholds/bonuses
//   emblems_source.json     - provenance metadata
//
// Source URLs are configurable via UNITEDB_BASE / EMBLEMS_URL / SETS_URL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emblemsUrl, setsUrl, httpText, UNITEDB_BASE } from './lib/unitedb.mjs';
import { pyStringify } from './lib/pyjson.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const GRADE_MAP = { C: 'bronze', B: 'silver', A: 'gold' };

const STAT_MAP = {
  hp: 'hp',
  attack: 'atk',
  defense: 'def',
  sp_attack: 'spatk',
  sp_defense: 'spdef',
  speed: 'spd',
  crit: 'crit',
  cdr: 'cdr',
};

const COLOR_MAP = {
  Green: 'green',
  White: 'white',
  Brown: 'brown',
  Blue: 'blue',
  Purple: 'purple',
  Red: 'red',
  Black: 'black',
  Yellow: 'yellow',
  Pink: 'pink',
  Navy: 'navy',
  Gray: 'gray',
};

async function fetchJson(url) {
  return JSON.parse(await httpText(url));
}

function parseColors(entry) {
  const colors = [];
  for (const key of ['color1', 'color2']) {
    const raw = entry[key];
    if (raw) {
      const mapped = COLOR_MAP[raw] ?? String(raw).toLowerCase();
      if (!colors.includes(mapped)) colors.push(mapped);
    }
  }
  return colors;
}

function mergeStats(statBlocks) {
  const stats = {};
  for (const block of statBlocks || []) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [rawKey, value] of Object.entries(block)) {
      const key = STAT_MAP[rawKey];
      if (key === undefined) continue;
      const val = Number(value);
      if (val === 0) continue;
      stats[key] = val;
    }
  }
  return stats;
}

function convertEmblems(rawEmblems) {
  const byName = new Map();
  for (const entry of rawEmblems) {
    const name = entry.display_name || entry.name;
    if (!name) continue;
    const grade = GRADE_MAP[entry.grade ?? ''];
    if (!grade) continue;
    if (entry.stats == null) continue;
    const stats = mergeStats(entry.stats);

    const code = entry.name;
    if (!byName.has(name)) {
      byName.set(name, { n: name, c: parseColors(entry), g: {}, codes: {} });
    } else {
      const existing = byName.get(name);
      for (const c of parseColors(entry)) {
        if (!existing.c.includes(c)) existing.c.push(c);
      }
      existing.c = existing.c.slice(0, 2);
    }

    const obj = byName.get(name);
    obj.g[grade] = stats;
    if (code) obj.codes[grade] = code;
  }

  return [...byName.values()].sort((a, b) =>
    a.n.toLowerCase() < b.n.toLowerCase() ? -1 : a.n.toLowerCase() > b.n.toLowerCase() ? 1 : 0,
  );
}

function convertEmblemSets(rawSets) {
  const sets = {};
  for (const row of rawSets) {
    const color = COLOR_MAP[row.color ?? ''] ?? String(row.color ?? '').toLowerCase();
    if (!color) continue;
    const sign = row.math === 'sub' ? -1 : 1;
    sets[color] = {
      thresholds: [row.count1, row.count2, row.count3],
      bonuses: [sign * row.bonus1, sign * row.bonus2, sign * row.bonus3],
      percent: row.percent === undefined ? true : Boolean(row.percent),
      stat: row.stat ?? '',
    };
  }
  return sets;
}

export async function parseEmblems({ log = console.log } = {}) {
  log(`Fetching ${emblemsUrl()} ...`);
  const rawEmblems = await fetchJson(emblemsUrl());
  log(`Fetching ${setsUrl()} ...`);
  const rawSets = await fetchJson(setsUrl());

  const emblems = convertEmblems(rawEmblems);
  const sets = convertEmblemSets(rawSets);

  const meta = {
    source: 'UniteDB',
    source_urls: [emblemsUrl(), setsUrl()],
    fetched_from: UNITEDB_BASE,
  };

  const emblemsOut = path.join(ROOT, 'emblems_data.json');
  const setsOut = path.join(ROOT, 'emblem_sets_data.json');
  const metaOut = path.join(ROOT, 'emblems_source.json');

  // emblem stats are floats (".0"); sets are ints. forceFloat matches Python.
  fs.writeFileSync(emblemsOut, pyStringify(emblems, true));
  fs.writeFileSync(setsOut, pyStringify(sets, false));
  fs.writeFileSync(metaOut, JSON.stringify(meta, null, 2));

  const withGrades = emblems.filter((e) => Object.keys(e.g || {}).length).length;
  log(`Parsed ${emblems.length} Pokémon (${withGrades} with stats) -> ${path.basename(emblemsOut)}`);
  log(`Parsed ${Object.keys(sets).length} color sets -> ${path.basename(setsOut)}`);
  return { emblems, sets };
}

const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isMain) {
  parseEmblems().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
