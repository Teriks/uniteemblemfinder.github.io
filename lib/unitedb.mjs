// Shared unite-db source/CDN configuration, HTTP helpers, and dynamic icon-CDN
// discovery. All source URLs are configurable via env vars with sensible
// defaults so a host change needs no code edit.

const UA = 'UniteOptimizer/1.0 (+https://unite-db.com)';

// Source URLs (env-overridable). UNITEDB_BASE drives all three; individual
// full-URL overrides take precedence if set.
export const UNITEDB_BASE = process.env.UNITEDB_BASE || 'https://unite-db.com';
export const emblemsUrl = () => process.env.EMBLEMS_URL || `${UNITEDB_BASE}/emblems.json`;
export const setsUrl = () => process.env.SETS_URL || `${UNITEDB_BASE}/emblem_sets.json`;
export const pageUrl = () => process.env.UNITEDB_PAGE_URL || `${UNITEDB_BASE}/boost-emblems`;

// Last-resort icon CDN base, used only if dynamic discovery and the env
// override both fail. This is the value unite-db currently serves from.
export const DEFAULT_ICON_CDN_BASE = 'https://d275t8dp8rxb42.cloudfront.net/emblems/pokedex';

export async function httpText(url, ua = UA) {
  const res = await fetch(url, { headers: { 'User-Agent': ua } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function httpBuffer(url, ua = 'UniteOptimizer/1.0') {
  const res = await fetch(url, { headers: { 'User-Agent': ua } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Try to read the icon CDN base directly out of the live unite-db source.
 * The boost-emblems page is a Nuxt app; its JS bundle constructs icon URLs as
 * `https://<cdn>/emblems/pokedex/<name>.png`, so we fetch the page, enumerate
 * its /_nuxt/*.js bundles, and pull the base out of the first match.
 * @returns {Promise<string|null>} the discovered base (no trailing slash) or null
 */
export async function discoverIconCdnBaseFromSource() {
  const page = await httpText(pageUrl());
  const origin = new URL(pageUrl()).origin;
  const bundles = [...new Set(page.match(/\/_nuxt\/[A-Za-z0-9.]+\.js/g) || [])];
  for (const b of bundles) {
    let js;
    try {
      js = await httpText(origin + b);
    } catch {
      continue;
    }
    const m = js.match(/https?:\/\/[^"'`\\\s]+\/emblems\/pokedex/);
    if (m) return m[0];
  }
  return null;
}

/**
 * Resolve the icon CDN base. Resolution order (per project requirements):
 *   1. dynamic discovery from the live unite-db source (default behavior)
 *   2. ICON_CDN_BASE env var (manual override / fallback)
 *   3. DEFAULT_ICON_CDN_BASE constant (last resort)
 * @param {(msg: string) => void} log
 * @returns {Promise<{base: string, source: string}>}
 */
export async function resolveIconCdnBase(log = () => {}) {
  try {
    const discovered = await discoverIconCdnBaseFromSource();
    if (discovered) {
      log(`icon CDN base: ${discovered} (source: dynamic discovery from unite-db)`);
      return { base: discovered, source: 'dynamic' };
    }
    log('icon CDN base: dynamic discovery found no match in unite-db source');
  } catch (e) {
    log(`icon CDN base: dynamic discovery failed (${e.message})`);
  }
  if (process.env.ICON_CDN_BASE) {
    log(`icon CDN base: ${process.env.ICON_CDN_BASE} (source: ICON_CDN_BASE env)`);
    return { base: process.env.ICON_CDN_BASE, source: 'env' };
  }
  log(`icon CDN base: ${DEFAULT_ICON_CDN_BASE} (source: built-in default)`);
  return { base: DEFAULT_ICON_CDN_BASE, source: 'default' };
}
