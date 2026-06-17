/* Stat-signature recipe solver for target emblem totals (shared main + worker). */
'use strict';

const RECIPE_MAX_TYPES = 56;
const RECIPE_SOLVER_MAX_STEPS = 400000;

function roundStatVal(statId, v) {
  if (statId === 'hp') return Math.round(v);
  return Math.round(v * 10) / 10;
}

function candidateSignature(stats) {
  const parts = [];
  for (const s of STATS) {
    const v = stats[s.id] || 0;
    if (Math.abs(v) < 1e-9) continue;
    parts.push(`${s.id}:${roundStatVal(s.id, v)}`);
  }
  return parts.sort().join('|');
}

function buildSignatureCatalog(pool) {
  const cat = new Map();
  pool.forEach(c => {
    const sig = candidateSignature(c.stats);
    if (!cat.has(sig)) cat.set(sig, []);
    cat.get(sig).push(c);
  });
  return cat;
}

function recipeTargetError(totals, opts) {
  let err = 0;
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    err += statTargetDelta(s.id, totals[s.id] || 0, opts.targets[s.id]) * (s.scale || 1);
  }
  return err;
}

function targetTol(statId) {
  return (statId === 'crit' || statId === 'cdr') ? 0.05 : 0.51;
}

function filterRelevantRecipes(catalog, opts) {
  const recipes = [];
  for (const [sig, cands] of catalog) {
    const stats = cands[0].stats;
    let relevant = false;
    for (const s of STATS) {
      if (!opts.targetActive[s.id]) continue;
      const v = stats[s.id] || 0;
      const tgt = opts.targets[s.id];
      const tol = targetTol(s.id);
      if (Math.abs(v) < 1e-9) continue;
      if (Math.abs(tgt) <= tol) continue;
      if (tgt > tol && v > 0) relevant = true;
      if (tgt < -tol && v < 0) relevant = true;
    }
    if (relevant) {
      recipes.push({
        sig,
        cands,
        stats,
        nameCount: new Set(cands.map(x => x.name)).size,
      });
    }
  }
  return recipes;
}

function scoreRecipeRelevance(r, opts) {
  let score = r.nameCount * 8;
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    const v = r.stats[s.id] || 0;
    if (Math.abs(v) < 1e-9) continue;
    const tgt = opts.targets[s.id];
    const tol = targetTol(s.id);
    if (Math.abs(tgt) <= tol) continue;
    if ((tgt > tol && v > 0) || (tgt < -tol && v < 0)) {
      score += Math.abs(v) * (s.scale || 1);
    }
  }
  return score;
}

function capRecipeList(recipes, opts) {
  recipes.sort((a, b) =>
    scoreRecipeRelevance(b, opts) - scoreRecipeRelevance(a, opts) ||
    b.nameCount - a.nameCount ||
    a.sig.localeCompare(b.sig)
  );
  if (recipes.length <= RECIPE_MAX_TYPES) return recipes;
  return recipes.slice(0, RECIPE_MAX_TYPES);
}

function recipeStatSumBound(remStats, statId, need, direction) {
  const vals = remStats.map(st => st[statId] || 0);
  const sorted = direction === 'max'
    ? vals.slice().sort((a, b) => b - a)
    : vals.slice().sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < need && i < sorted.length; i++) sum += sorted[i];
  return sum;
}

function canStillReachRecipeTotals(totals, recipes, idx, used, slots, opts) {
  const need = slots - used;
  if (need <= 0) return true;
  const rem = recipes.slice(idx).map(r => r.stats);
  if (rem.length < need) return false;
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    const tgt = opts.targets[s.id];
    const tol = targetTol(s.id);
    const cur = totals[s.id] || 0;
    const lo = tgt - tol;
    const hi = tgt + tol;
    const minReach = cur + recipeStatSumBound(rem, s.id, need, 'min');
    const maxReach = cur + recipeStatSumBound(rem, s.id, need, 'max');
    if (maxReach < lo - 1e-9 || minReach > hi + 1e-9) return false;
  }
  return true;
}

function solveRecipeCountsSync(recipes, opts, slots, shouldAbort) {
  if (!recipes.length) return null;
  let bestCounts = null;
  let bestErr = Infinity;
  const counts = new Array(recipes.length).fill(0);
  const totals = {};
  STATS.forEach(s => { totals[s.id] = 0; });
  let steps = 0;
  let aborted = false;

  function addRecipe(idx, k, sign) {
    const st = recipes[idx].stats;
    for (const s of STATS) {
      totals[s.id] += sign * (st[s.id] || 0) * k;
    }
  }

  function dfs(idx, used) {
    if (shouldAbort?.()) { aborted = true; return; }
    if (++steps > RECIPE_SOLVER_MAX_STEPS) { aborted = true; return; }
    if (bestErr <= SCORE_EPS) return;
    if (idx === recipes.length) {
      if (used !== slots) return;
      const err = recipeTargetError(totals, opts);
      if (err < bestErr - SCORE_EPS) {
        bestErr = err;
        bestCounts = counts.slice();
      }
      return;
    }
    if (!canStillReachRecipeTotals(totals, recipes, idx, used, slots, opts)) return;
    const remaining = slots - used;
    const r = recipes[idx];
    const maxK = Math.min(remaining, r.nameCount);
    for (let k = maxK; k >= 0; k--) {
      counts[idx] = k;
      addRecipe(idx, k, 1);
      dfs(idx + 1, used + k);
      addRecipe(idx, k, -1);
      counts[idx] = 0;
      if (aborted || bestErr <= SCORE_EPS) return;
    }
  }

  dfs(0, 0);
  if (bestCounts == null) return null;
  return { counts: bestCounts, error: bestErr, recipes, capped: aborted };
}

async function solveRecipeCountsAsync(recipes, opts, slots, shouldAbort, onYield) {
  if (!recipes.length) return null;
  let bestCounts = null;
  let bestErr = Infinity;
  const counts = new Array(recipes.length).fill(0);
  const totals = {};
  STATS.forEach(s => { totals[s.id] = 0; });
  let steps = 0;
  let aborted = false;

  function addRecipe(idx, k, sign) {
    const st = recipes[idx].stats;
    for (const s of STATS) {
      totals[s.id] += sign * (st[s.id] || 0) * k;
    }
  }

  async function dfs(idx, used) {
    if (shouldAbort?.()) { aborted = true; return; }
    if (++steps > RECIPE_SOLVER_MAX_STEPS) { aborted = true; return; }
    if (steps % 1200 === 0) {
      if (shouldAbort?.()) { aborted = true; return; }
      if (onYield) await onYield();
    }
    if (bestErr <= SCORE_EPS) return;
    if (idx === recipes.length) {
      if (used !== slots) return;
      const err = recipeTargetError(totals, opts);
      if (err < bestErr - SCORE_EPS) {
        bestErr = err;
        bestCounts = counts.slice();
      }
      return;
    }
    if (!canStillReachRecipeTotals(totals, recipes, idx, used, slots, opts)) return;
    const remaining = slots - used;
    const r = recipes[idx];
    const maxK = Math.min(remaining, r.nameCount);
    for (let k = maxK; k >= 0; k--) {
      counts[idx] = k;
      addRecipe(idx, k, 1);
      await dfs(idx + 1, used + k);
      addRecipe(idx, k, -1);
      counts[idx] = 0;
      if (aborted || bestErr <= SCORE_EPS) return;
    }
  }

  await dfs(0, 0);
  if (bestCounts == null) return null;
  return { counts: bestCounts, error: bestErr, recipes, capped: aborted };
}

function assignFromRecipeCounts(solved, opts, slots, shuffleFn) {
  const { counts, recipes } = solved;
  const loadout = [];
  const names = new Set();
  const order = recipes.map((r, i) => ({ r, n: counts[i] })).filter(x => x.n > 0);
  order.sort((a, b) => b.n - a.n);

  for (const { r, n } of order) {
    const variants = shuffleFn(r.cands);
    let picked = 0;
    for (const c of variants) {
      if (picked >= n) break;
      if (names.has(c.name)) continue;
      loadout.push(c);
      names.add(c.name);
      picked++;
    }
    if (picked < n) return null;
  }
  if (loadout.length !== slots) return null;
  if (!evaluate(loadout, 'target', opts).valid) return null;
  return loadout;
}

function polishRecipeLoadout(loadout, pool, opts, slots, shuffleFn) {
  let best = loadout.slice();
  let bestErr = targetError(best, opts);
  const tries = Math.min(120, pool.length);
  for (let t = 0; t < tries; t++) {
    const slot = Math.floor(Math.random() * slots);
    const names = new Set(best.map((x, i) => (i === slot ? null : x.name)).filter(Boolean));
    const cand = shuffleFn(pool)[0];
    if (!cand || names.has(cand.name)) continue;
    const trial = best.slice();
    trial[slot] = cand;
    if (!evaluate(trial, 'target', opts).valid) continue;
    const err = targetError(trial, opts);
    if (err < bestErr - SCORE_EPS) {
      best = trial;
      bestErr = err;
      if (bestErr <= SCORE_EPS) break;
    }
  }
  return { loadout: best, error: bestErr };
}

function assignBestFromSolved(solved, pool, opts, slots, shuffleFn, shouldAbort) {
  let best = null;
  let bestErr = solved.error;
  const shuf = shuffleFn || (arr => arr.slice().sort(() => Math.random() - 0.5));

  for (let attempt = 0; attempt < 80; attempt++) {
    if (shouldAbort?.()) return null;
    const L = assignFromRecipeCounts(solved, opts, slots, shuf);
    if (!L) continue;
    const polished = polishRecipeLoadout(L, pool, opts, slots, () => shuf(pool));
    const err = polished.error;
    if (err < bestErr - SCORE_EPS || (Math.abs(err - bestErr) <= SCORE_EPS && !best)) {
      bestErr = err;
      best = polished.loadout;
    }
    if (bestErr <= SCORE_EPS) break;
  }

  if (!best) return null;
  return { loadout: best, error: bestErr };
}

function searchByRecipes(pool, opts, slots, shuffleFn, shouldAbort) {
  if (shouldAbort?.()) return null;
  const catalog = buildSignatureCatalog(pool);
  const recipes = capRecipeList(filterRelevantRecipes(catalog, opts), opts);
  if (!recipes.length) return null;
  const solved = solveRecipeCountsSync(recipes, opts, slots, shouldAbort);
  if (!solved) return null;
  return assignBestFromSolved(solved, pool, opts, slots, shuffleFn, shouldAbort);
}

async function searchByRecipesAsync(pool, opts, slots, shuffleFn, shouldAbort, onYield) {
  if (shouldAbort?.()) return null;
  const catalog = buildSignatureCatalog(pool);
  const recipes = capRecipeList(filterRelevantRecipes(catalog, opts), opts);
  if (!recipes.length) return null;
  const solved = await solveRecipeCountsAsync(recipes, opts, slots, shouldAbort, onYield);
  if (!solved) return null;
  return assignBestFromSolved(solved, pool, opts, slots, shuffleFn, shouldAbort);
}
