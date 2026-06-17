// Download emblem portrait PNGs into icons/ (ported from the former Python fetcher).
//
// The icon CDN base is resolved dynamically from unite-db by default, so a CDN
// change on their side is picked up automatically. Resolution order:
//   1. dynamic discovery from the live unite-db source (default)
//   2. ICON_CDN_BASE env var (manual override / fallback)
//   3. built-in default constant (last resort)
// Network is only touched when icons are actually missing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIconCdnBase, httpBuffer } from './lib/unitedb.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(ROOT, 'emblems_data.json');
const ICONS_DIR = path.join(ROOT, 'icons');

function collectCodes(emblems) {
  const codes = new Set();
  for (const em of emblems) {
    for (const v of Object.values(em.codes || {})) codes.add(v);
  }
  return [...codes].sort();
}

function isCached(code) {
  const p = path.join(ICONS_DIR, `${code}.png`);
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

export async function fetchIcons({ log = console.log } = {}) {
  const emblems = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const codes = collectCodes(emblems);
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  const missing = codes.filter((c) => !isCached(c));
  if (missing.length === 0) {
    log(`All ${codes.length} icons already cached in icons/ — nothing to download.`);
    return { ok: 0, skip: codes.length, fail: 0 };
  }

  const { base } = await resolveIconCdnBase(log);

  let ok = 0;
  let fail = 0;
  const skip = codes.length - missing.length;
  const t0 = Date.now();
  for (let i = 0; i < missing.length; i++) {
    const code = missing[i];
    try {
      const data = await httpBuffer(`${base}/${code}.png`);
      fs.writeFileSync(path.join(ICONS_DIR, `${code}.png`), data);
      ok++;
    } catch (ex) {
      fail++;
      log(`  fail ${code}: ${ex.message}`);
    }
    if ((i + 1) % 50 === 0 || i + 1 === missing.length) {
      log(`  ${i + 1}/${missing.length} (${ok} new, ${fail} failed)`);
    }
  }
  log(
    `Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
    `${ok} downloaded, ${skip} cached, ${fail} failed`,
  );
  return { ok, skip, fail };
}

const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isMain) {
  fetchIcons().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
