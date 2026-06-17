/* Heavy emblem search worker — compact MITM + IndexedDB spill (same limits as desktop). */
'use strict';

const STATS = [
  { id: 'hp', scale: 1 }, { id: 'atk', scale: 1 }, { id: 'spatk', scale: 1 },
  { id: 'def', scale: 1 }, { id: 'spdef', scale: 1 }, { id: 'spd', scale: 0.1 },
  { id: 'atkspd', scale: 1 }, { id: 'cdr', scale: 1 }, { id: 'crit', scale: 1 },
];
const SCORE_EPS = 1e-9;
let jobId = null;
let shardIndex = 0;
let shardCount = 1;
let cancelled = false;

function post(type, data) {
  self.postMessage({ type, jobId, shardIndex, ...data });
}

function yieldToWorker() {
  return new Promise(r => setTimeout(r, 0));
}

function assignPoolIds(pool) {
  const nameToNid = new Map();
  pool.forEach((c, i) => {
    c.cid = i;
    if (!nameToNid.has(c.name)) nameToNid.set(c.name, nameToNid.size);
    c.nid = nameToNid.get(c.name);
  });
  return pool;
}

function sumStats(loadout) {
  const t = {};
  STATS.forEach(s => { t[s.id] = 0; });
  loadout.forEach(item => {
    Object.entries(item.stats).forEach(([k, v]) => {
      if (t[k] !== undefined) t[k] += v;
    });
  });
  return t;
}

function statTargetDelta(statId, actual, target) {
  const diff = Math.abs(actual - target);
  const tol = (statId === 'crit' || statId === 'cdr') ? 0.05 : 0.51;
  return diff <= tol ? 0 : diff;
}

function targetError(loadout, opts) {
  const totals = sumStats(loadout);
  let err = 0;
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    err += statTargetDelta(s.id, totals[s.id] || 0, opts.targets[s.id]) * (s.scale || 1);
  }
  return err;
}

function colorsMatchTargets(counts, colorTargets) {
  if (!colorTargets) return true;
  for (const [color, need] of Object.entries(colorTargets.targets)) {
    if ((counts[color] || 0) !== need) return false;
  }
  return true;
}

function countColors(loadout) {
  const c = {};
  loadout.forEach(item => {
    (item.colors || []).forEach(col => { c[col] = (c[col] || 0) + 1; });
  });
  return c;
}

function compareCandidates(a, b) {
  const n = a.name.localeCompare(b.name);
  return n !== 0 ? n : (a.grade || '').localeCompare(b.grade || '');
}

function normalizeStatForScore(statId, val) {
  const s = STATS.find(x => x.id === statId);
  return val * (s?.scale || 1);
}

const PROTECT_PENALTY_WEIGHT = 45;

function protectStatPenalty(statId, val, floor) {
  if (val >= floor - SCORE_EPS) return 0;
  const scale = STATS.find(x => x.id === statId)?.scale || 1;
  return (floor - val) * scale * PROTECT_PENALTY_WEIGHT;
}

function candidateGreedyValue(c, opts) {
  let v = 0;
  if (opts.mode === 'maximize') {
    for (const s of STATS) {
      const raw = c.stats[s.id] || 0;
      if (opts.priorities[s.id]) {
        v += normalizeStatForScore(s.id, raw) * (opts.weights[s.id] || 1);
      }
      if (opts.protected[s.id] !== undefined) {
        v -= protectStatPenalty(s.id, raw, opts.protected[s.id]);
      }
    }
  } else {
    v = Object.values(c.stats).reduce((sum, x) => sum + Math.abs(x), 0);
  }
  return v;
}

function colorNeedsRemaining(loadout, colorTargets) {
  const counts = countColors(loadout);
  const needs = {};
  for (const [color, need] of Object.entries(colorTargets.targets)) {
    needs[color] = Math.max(0, need - (counts[color] || 0));
  }
  return needs;
}

function wouldExceedColorTargets(loadout, candidate, colorTargets) {
  if (!colorTargets) return false;
  const counts = countColors(loadout);
  for (const col of candidate.colors || []) {
    const need = colorTargets.targets[col];
    if (need === undefined) continue;
    if ((counts[col] || 0) + 1 > need) return true;
  }
  return false;
}

function candidateColorHelp(c, needs) {
  let help = 0;
  for (const col of c.colors || []) {
    if (needs[col] > 0) help++;
  }
  return help;
}

function sortColorCandidates(cands, opts, needs) {
  const pending = needs && Object.values(needs).some(n => n > 0);
  cands.sort((a, b) => {
    if (pending) {
      const ha = candidateColorHelp(a, needs);
      const hb = candidateColorHelp(b, needs);
      if (hb !== ha) return hb - ha;
    }
    const va = candidateGreedyValue(a, opts);
    const vb = candidateGreedyValue(b, opts);
    if (Math.abs(vb - va) > SCORE_EPS) return vb - va;
    return compareCandidates(a, b);
  });
  return cands;
}

function samplePool(order, maxN) {
  if (!maxN || order.length <= maxN) return order;
  return shufflePool(order).slice(0, maxN);
}

function mutateColorLoadout(loadout, pool, opts, slots) {
  if (!opts.colorTargets || loadout.length !== slots) return loadout.slice();
  const trial = loadout.slice();
  const swaps = 1 + Math.floor(Math.random() * 2);
  for (let s = 0; s < swaps; s++) {
    const slot = Math.floor(Math.random() * slots);
    const names = new Set(trial.map((x, i) => (i === slot ? null : x.name)).filter(Boolean));
    const base = trial.filter((_, i) => i !== slot);
    const cands = samplePool(pool.filter(c => !names.has(c.name)), 40);
    for (const c of cands) {
      if (wouldExceedColorTargets(base, c, opts.colorTargets)) continue;
      const next = trial.slice();
      next[slot] = c;
      if (evaluate(next, opts.mode, opts).valid) {
        trial[slot] = c;
        break;
      }
    }
  }
  return trial;
}

function pickVariedCandidate(cands, opts, needs) {
  if (!cands.length) return null;
  const pending = needs && Object.values(needs).some(n => n > 0);
  const scored = cands.map(c => {
    let s = candidateGreedyValue(c, opts);
    if (pending) s += candidateColorHelp(c, needs) * 1e6;
    return { c, s };
  });
  scored.sort((a, b) => b.s - a.s || compareCandidates(a.c, b.c));
  const bestScore = scored[0].s;
  const band = Math.max(20, Math.abs(bestScore) * 0.03);
  const tier = [];
  for (const x of scored) {
    if (x.s < bestScore - band || tier.length >= 8) break;
    tier.push(x.c);
  }
  return tier[Math.floor(Math.random() * tier.length)];
}

function colorExactSeedOnce(pool, opts, slots) {
  const colorTargets = opts.colorTargets;
  if (!colorTargets) return null;
  const loadout = [];
  const names = new Set();

  while (loadout.length < slots) {
    const needs = colorNeedsRemaining(loadout, colorTargets);
    let cands = pool.filter(c =>
      !names.has(c.name) && !wouldExceedColorTargets(loadout, c, colorTargets)
    );
    if (!cands.length) return null;

    const pending = Object.values(needs).some(n => n > 0);
    if (pending) {
      cands = cands.filter(c => candidateColorHelp(c, needs) > 0);
      if (!cands.length) return null;
    }
    const picked = pickVariedCandidate(cands, opts, needs);
    if (!picked) return null;
    loadout.push(picked);
    names.add(picked.name);
  }

  return colorsMatchTargets(countColors(loadout), colorTargets) ? loadout : null;
}

function evaluate(loadout, mode, opts) {
  const totals = sumStats(loadout);
  const counts = countColors(loadout);
  if (!colorsMatchTargets(counts, opts.colorTargets)) {
    return { valid: false, score: -1e12, totals, counts };
  }
  if (mode === 'maximize') {
    let score = 0;
    for (const s of STATS) {
      const v = totals[s.id] || 0;
      if (opts.priorities[s.id]) score += v * (opts.weights[s.id] || 1);
      if (opts.protected[s.id] !== undefined) {
        score -= protectStatPenalty(s.id, v, opts.protected[s.id]);
      }
    }
    return { valid: true, score, totals, counts };
  }
  const err = targetError(loadout, opts);
  return { valid: true, score: -err, totals, counts, error: err };
}

function statTotalsKey(totals, opts) {
  const parts = [];
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    const v = totals[s.id] || 0;
    const step = (s.id === 'crit' || s.id === 'cdr') ? 10 : (s.id === 'atk' ? 10 : 1);
    parts.push(Math.round(v * step));
  }
  return parts.join('|');
}

function neededTotalsKey(totals, opts) {
  const parts = [];
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    const need = opts.targets[s.id] - (totals[s.id] || 0);
    const step = (s.id === 'crit' || s.id === 'cdr') ? 10 : (s.id === 'atk' ? 10 : 1);
    parts.push(Math.round(need * step));
  }
  return parts.join('|');
}

function fuzzyNeighborKeys(needKey) {
  const parts = needKey.split('|').map(x => parseInt(x, 10));
  const out = new Set();
  function build(idx, cur) {
    if (idx === parts.length) {
      out.add(cur.join('|'));
      return;
    }
    for (const d of [-1, 0, 1]) {
      cur[idx] = parts[idx] + d;
      build(idx + 1, cur);
    }
  }
  build(0, parts.slice());
  return [...out];
}

function partialFromLoadout(loadout, opts) {
  const totals = sumStats(loadout);
  let mask = 0n;
  const picks = new Uint16Array(loadout.length);
  for (let i = 0; i < loadout.length; i++) {
    picks[i] = loadout[i].cid;
    mask |= (1n << BigInt(loadout[i].nid));
  }
  return { picks, mask: mask.toString(), totals, key: statTotalsKey(totals, opts) };
}

function expandPicks(picks, pool) {
  const arr = picks instanceof Uint16Array ? picks : Uint16Array.from(picks);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = pool[arr[i]];
  return out;
}

function masksOverlap(a, b) {
  return (BigInt(a) & BigInt(b)) !== 0n;
}

function groupPoolByName(pool) {
  const map = new Map();
  pool.forEach(c => {
    if (!map.has(c.name)) map.set(c.name, []);
    map.get(c.name).push(c);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, variants]) => ({ name, variants }));
}

function fmtSearchCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function idbOpen(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('left')) {
        const store = db.createObjectStore('left', { autoIncrement: true });
        store.createIndex('byKey', 'key', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('idb aborted'));
  });
}

class MitmLeftIndex {
  constructor(opts, dbName) {
    this.opts = opts;
    this.dbName = dbName;
    this.db = null;
    this.ram = new Map();
    this.ramCount = 0;
    this.flushAt = 40000;
    this.totalStored = 0;
  }

  async add(entry) {
    if (!this.ram.has(entry.key)) this.ram.set(entry.key, []);
    this.ram.get(entry.key).push(entry);
    this.ramCount++;
    this.totalStored++;
    if (this.ramCount >= this.flushAt) await this.flush();
  }

  async ensureDb() {
    if (this.db) return;
    this.db = await idbOpen(this.dbName);
  }

  async flush() {
    if (!this.ramCount) return;
    try {
      await this.ensureDb();
      const tx = this.db.transaction('left', 'readwrite');
      const store = tx.objectStore('left');
      for (const list of this.ram.values()) {
        for (const e of list) {
          store.add({ key: e.key, mask: e.mask, picks: Array.from(e.picks) });
        }
      }
      await idbTxDone(tx);
      this.ram.clear();
      this.ramCount = 0;
    } catch (err) {
      this.ramCount = Math.floor(this.ramCount / 2);
    }
  }

  async lookup(needKey, lookupCap) {
    const keys = fuzzyNeighborKeys(needKey);
    const out = [];
    for (const k of keys) {
      const ramList = this.ram.get(k) || [];
      for (const e of ramList) {
        out.push(e);
        if (out.length >= lookupCap) return out;
      }
      if (this.db) {
        const tx = this.db.transaction('left', 'readonly');
        const idx = tx.objectStore('left').index('byKey');
        const req = idx.getAll(k);
        const rows = await new Promise((res, rej) => {
          req.onsuccess = () => res(req.result || []);
          req.onerror = () => rej(req.error);
        });
        await idbTxDone(tx);
        for (const row of rows) {
          out.push({ mask: row.mask, picks: Uint16Array.from(row.picks), totals: null });
          if (out.length >= lookupCap) return out;
        }
      }
    }
    return out;
  }

  async close() {
    await this.flush();
    if (this.db) {
      this.db.close();
      await new Promise((resolve) => {
        const del = indexedDB.deleteDatabase(this.dbName);
        del.onsuccess = () => resolve();
        del.onerror = () => resolve();
        del.onblocked = () => resolve();
      });
      this.db = null;
    }
  }
}

async function forEachPartialAsync(groups, k, start, loadout, maxOut, state, onEntry) {
  if (state.count >= maxOut || state.aborted || cancelled) {
    state.aborted = true;
    return;
  }
  if (state.start && state.maxMs && Date.now() - state.start > state.maxMs) {
    state.aborted = true;
    return;
  }
  if (loadout.length === k) {
    state.count++;
    const entry = partialFromLoadout(loadout, state.opts);
    await onEntry(entry);
    if (state.reportProgress) {
      const now = Date.now();
      if (state.count === 1 || state.count % 2000 === 0 || now - (state.lastReport || 0) > 80) {
        state.lastReport = now;
        await state.reportProgress(state.count, maxOut);
      }
    }
    if (state.count >= maxOut) state.aborted = true;
    return;
  }
  const need = k - loadout.length;
  if (groups.length - start < need) return;
  for (let i = start; i < groups.length; i++) {
    if (state.aborted || cancelled) return;
    for (const c of groups[i].variants) {
      loadout.push(c);
      await forEachPartialAsync(groups, k, i + 1, loadout, maxOut, state, onEntry);
      loadout.pop();
      if (state.aborted || cancelled) return;
      if (state.count > 0 && state.count % 400 === 0) await yieldToWorker();
    }
  }
}

async function searchTargetMITM(pool, opts, slots, limits, onProgress) {
  const groups = groupPoolByName(pool);
  const half = Math.floor(slots / 2);
  const rightK = slots - half;
  const maxMs = limits.mitmMs ?? 25000;
  const enumMax = limits.enumMax ?? 3000000;
  const lookupCap = limits.lookupCap ?? 200;
  const t0 = Date.now();
  // Unique IndexedDB name per job AND shard so parallel shards never collide.
  const dbName = 'unite-mitm-' + jobId + '-' + shardIndex;
  const leftIndex = new MitmLeftIndex(opts, dbName);

  const report = async (sub, label) => {
    if (onProgress) await onProgress(sub, label);
  };

  const enumState = {
    aborted: false, start: t0, maxMs, lastReport: 0, count: 0, opts,
  };
  enumState.reportProgress = async (count, max) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const sub = 0.06 + 0.34 * Math.min(1, count / Math.max(1, max));
    await report(sub, `Exact · ${half}-slot combos: ${fmtSearchCount(count)} / ${fmtSearchCount(max)} (${elapsed}s)`);
  };

  await report(0.02, `Exact · building ${half}-slot combinations (${groups.length} Pokémon)…`);
  await forEachPartialAsync(groups, half, 0, [], enumMax, enumState, async (e) => {
    await leftIndex.add(e);
  });
  if (cancelled) { await leftIndex.close(); return null; }
  await leftIndex.flush();

  const rightState = {
    aborted: false, start: t0, maxMs, lastReport: 0, count: 0, opts,
  };
  let best = [];
  let bestErr = Infinity;
  let ri = 0;
  let rightTotal = 0;
  let lastMatchReport = 0;

  rightState.reportProgress = async (count) => {
    rightTotal = count;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const sub = 0.42 + 0.33 * Math.min(1, count / Math.max(1, enumMax));
    await report(sub, `Exact · matching ${rightK}-slot side: ${fmtSearchCount(count)} (${elapsed}s)`);
  };

  await report(0.40, `Exact · ${fmtSearchCount(leftIndex.totalStored)} left halves · streaming ${rightK}-slot side…`);

  await forEachPartialAsync(groups, rightK, 0, [], enumMax, rightState, async (R) => {
    if (cancelled || Date.now() - t0 > maxMs) {
      rightState.aborted = true;
      return;
    }
    ri++;
    const now = Date.now();
    if (now - lastMatchReport > 80) {
      lastMatchReport = now;
      const denom = Math.max(1, rightTotal || enumMax);
      const sub = 0.78 + 0.18 * Math.min(1, ri / denom);
      const bestLbl = bestErr < Infinity ? ` · best error ${bestErr.toFixed(2)}` : '';
      await report(sub, `Exact · matching ${fmtSearchCount(ri)}${bestLbl}`);
      await yieldToWorker();
    }
    const matches = await leftIndex.lookup(neededTotalsKey(R.totals, opts), lookupCap);
    if (!matches.length) return;
    const rightLoadout = expandPicks(R.picks, pool);
    for (const L of matches) {
      if (masksOverlap(L.mask, R.mask)) continue;
      const full = [...expandPicks(L.picks, pool), ...rightLoadout];
      if (!evaluate(full, 'target', opts).valid) continue;
      const err = targetError(full, opts);
      if (err < bestErr - SCORE_EPS) {
        bestErr = err;
        best = full;
        if (err <= SCORE_EPS) {
          rightState.aborted = true;
          return;
        }
      }
    }
  });

  await leftIndex.close();
  if (cancelled) return null;
  if (best.length) {
    await report(0.98, `Exact · MITM done · best error ${bestErr.toFixed(2)}`);
    return { loadout: best, error: bestErr };
  }
  await report(0.98, 'Exact · MITM finished (no valid merge)');
  return null;
}

async function bruteForceTarget(pool, opts, slots, maxMs, onProgress) {
  const groups = groupPoolByName(pool);
  if (groups.length < slots) return null;
  let best = [];
  let bestErr = Infinity;
  const state = { start: Date.now(), maxMs, lastYield: Date.now() };

  async function dfs(gi, loadout) {
    if (cancelled || Date.now() - state.start > state.maxMs) return;
    if (Date.now() - state.lastYield > 40) {
      state.lastYield = Date.now();
      if (onProgress) {
        const elapsed = Date.now() - state.start;
        await onProgress(Math.min(1, elapsed / Math.max(1, maxMs)),
          `Exact · brute force ${(elapsed / 1000).toFixed(0)}s${bestErr < Infinity ? ` · best error ${bestErr.toFixed(2)}` : ''}`);
      }
      await yieldToWorker();
    }
    if (loadout.length === slots) {
      if (!evaluate(loadout, 'target', opts).valid) return;
      const err = targetError(loadout, opts);
      if (err < bestErr - SCORE_EPS) {
        bestErr = err;
        best = loadout.slice();
      }
      return;
    }
    const need = slots - loadout.length;
    if (groups.length - gi < need) return;
    for (let i = gi; i < groups.length; i++) {
      for (const c of groups[i].variants) {
        loadout.push(c);
        await dfs(i + 1, loadout);
        loadout.pop();
        if (bestErr <= SCORE_EPS || cancelled) return;
      }
    }
  }

  await dfs(0, []);
  if (!best.length) return null;
  return { loadout: best, error: bestErr };
}

async function searchTargetExact(pool, opts, slots, limits, onExactProgress) {
  const report = async (sub, label) => {
    if (onExactProgress) await onExactProgress(sub, label);
  };
  const uniqueNames = new Set(pool.map(c => c.name)).size;
  await report(0, `Exact · ${uniqueNames} Pokémon · ${pool.length} grade options`);
  await report(0.02, 'Exact · recipe signature solver…');
  const recipeHit = searchByRecipes(pool, opts, slots, shufflePool, () => cancelled);
  if (recipeHit?.loadout?.length === slots && recipeHit.error <= SCORE_EPS) {
    await report(0.95, 'Exact · recipe match found');
    return recipeHit;
  }
  if (cancelled) return null;
  const mitm = await searchTargetMITM(pool, opts, slots, limits, async (mitmSub, label) => {
    await report(0.06 + mitmSub * 0.82, label);
  });
  if (cancelled) return null;
  let bf = null;
  const bruteMax = limits.bruteMaxNames ?? 22;
  if (uniqueNames <= bruteMax && limits.bruteMs > 0) {
    await report(0.90, `Exact · brute force on ${uniqueNames} Pokémon…`);
    bf = await bruteForceTarget(pool, opts, slots, limits.bruteMs, async (bruteSub, label) => {
      await report(0.90 + bruteSub * 0.08, label);
    });
  }
  if (cancelled) return null;
  if (bf && bf.error <= SCORE_EPS) return bf;
  if (mitm && mitm.error <= SCORE_EPS) return mitm;
  if (!bf && !mitm) return null;
  if (!bf) return mitm;
  if (!mitm) return bf;
  return bf.error <= mitm.error ? bf : mitm;
}

function shufflePool(arr) {
  return arr.slice().sort(() => Math.random() - 0.5);
}

function isLoadoutBetter(ev, bestEv, opts) {
  if (!ev.valid) return false;
  if (!bestEv || !bestEv.valid) return true;
  if (opts.mode === 'target') {
    const errA = ev.error ?? Infinity;
    const errB = bestEv.error ?? Infinity;
    return errA < errB - SCORE_EPS;
  }
  if (ev.score > bestEv.score + SCORE_EPS) return true;
  if (Math.abs(ev.score - bestEv.score) <= SCORE_EPS) return Math.random() < 0.55;
  return false;
}

async function runHeuristic(pool, opts, slots, preset, heuristicLo, onProgress) {
  const SLOTS = slots;
  let globalBest = { loadout: [], ev: { score: -1e12, error: Infinity } };
  const t0 = Date.now();
  // User-facing counter: number of full loadouts actually scored via evaluate().
  // Every candidate (random seed, hill-climb neighbour, SA move) increments this,
  // so the progress label climbs fast and reflects true work across the pool.
  let heurEvals = 0;
  const score = (L) => { heurEvals++; return evaluate(L, opts.mode, opts); };
  const span = 100 - heuristicLo;
  const heurLabel = (suffix) =>
    `Heuristic · ${heurEvals.toLocaleString()} candidates tried${suffix || ''}`;

  if (opts.colorTargets) {
    const seeded = colorExactSeedOnce(shufflePool(pool), opts, SLOTS);
    if (seeded?.length === SLOTS) {
      const ev = score(seeded);
      if (ev.valid) globalBest = { loadout: seeded, ev };
    }
  }

  function greedySeed() {
    const shuffled = shufflePool(pool);
    const loadout = [];
    const names = new Set();
    for (const c of shuffled) {
      if (loadout.length >= SLOTS) break;
      if (names.has(c.name)) continue;
      const trial = [...loadout, c];
      if (!score(trial).valid) continue;
      loadout.push(c);
      names.add(c.name);
    }
    return loadout;
  }

  function improve(loadout, candidateOrder) {
    let best = loadout.slice();
    let bestEv = score(best);
    const order = candidateOrder || pool;
    const maxRounds = opts.colorTargets ? 1 : 3;
    const maxCands = opts.colorTargets ? 48 : pool.length;
    let improved = true;
    let rounds = 0;
    while (improved && !cancelled && rounds < maxRounds) {
      improved = false;
      rounds++;
      const scan = samplePool(order, maxCands);
      for (let slot = 0; slot < best.length; slot++) {
        const names = new Set(best.map((x, i) => i === slot ? null : x.name).filter(Boolean));
        for (const cand of scan) {
          if (names.has(cand.name)) continue;
          const trial = best.slice();
          trial[slot] = cand;
          const ev = score(trial);
          if (ev.valid && isLoadoutBetter(ev, bestEv, opts)) {
            best = trial;
            bestEv = ev;
            improved = true;
          }
        }
      }
    }
    return { loadout: best, ev: bestEv };
  }

  function runOneTry() {
    let L;
    if (opts.colorTargets) {
      if (globalBest.loadout.length === SLOTS && Math.random() < 0.9) {
        L = mutateColorLoadout(globalBest.loadout, pool, opts, SLOTS);
      } else {
        L = colorExactSeedOnce(shufflePool(pool), opts, SLOTS) || [];
      }
    } else {
      L = greedySeed();
    }
    if (L.length < SLOTS) {
      const names = new Set(L.map(x => x.name));
      for (const c of shufflePool(pool)) {
        if (L.length >= SLOTS) break;
        if (names.has(c.name)) continue;
        const trial = [...L, c];
        if (score(trial).valid) { L = trial; names.add(c.name); }
      }
    }
    let best = L;
    let bestEv = score(best);
    if (opts.colorTargets && best.length === SLOTS && bestEv.valid) {
      return { loadout: best, ev: bestEv };
    }
    const passes = opts.colorTargets ? 1 : (preset.improvePasses || 1);
    for (let p = 0; p < passes; p++) {
      const res = improve(best, shufflePool(pool));
      if (res.ev.valid && isLoadoutBetter(res.ev, bestEv, opts)) {
        best = res.loadout;
        bestEv = res.ev;
      }
    }
    return { loadout: best, ev: score(best) };
  }

  // ---- Simulated-annealing metaheuristic (no-color huge-pool case) ----
  // Greedy-seeded SA over slot-replace + grade-change neighbourhoods, with
  // Metropolis acceptance + geometric cooling per segment and a fresh anneal
  // each segment. It escapes the local optima that independent random restarts
  // kept rediscovering. Each shard uses a different temperature scale
  // (parallel-tempering style) so the worker pool diversifies its exploration.
  const useAnneal = !opts.colorTargets && new Set(pool.map(c => c.name)).size >= SLOTS;
  const annealOrdered = useAnneal
    ? pool.slice().sort((a, b) => candidateGreedyValue(b, opts) - candidateGreedyValue(a, opts))
    : null;
  const annealVariants = new Map();
  if (useAnneal) {
    for (const c of pool) {
      if (!annealVariants.has(c.name)) annealVariants.set(c.name, []);
      annealVariants.get(c.name).push(c);
    }
  }
  const annealTempScale = shardCount > 1 ? (0.5 + 1.5 * (shardIndex / (shardCount - 1))) : 1.0;
  const annealMoves = Math.max(400, Math.min(4000, pool.length * 4));
  const annealEnergy = (ev) => opts.mode === 'target' ? (ev.error == null ? Infinity : ev.error) : -ev.score;

  function annealSeed() {
    const used = new Set();
    const L = [];
    const start = (Math.random() * Math.min(annealOrdered.length, 6)) | 0;
    for (let i = start; i < annealOrdered.length && L.length < SLOTS; i++) {
      const c = annealOrdered[i];
      if (used.has(c.name)) continue;
      used.add(c.name); L.push(c);
    }
    for (let i = 0; i < annealOrdered.length && L.length < SLOTS; i++) {
      const c = annealOrdered[i];
      if (!used.has(c.name)) { used.add(c.name); L.push(c); }
    }
    return L;
  }

  function annealNeighbor(cur, curNames) {
    const slot = (Math.random() * SLOTS) | 0;
    if (Math.random() < 0.78) {
      for (let a = 0; a < 6; a++) {
        const c = Math.random() < 0.6
          ? annealOrdered[(Math.random() * Math.min(annealOrdered.length, 120)) | 0]
          : pool[(Math.random() * pool.length) | 0];
        if (!c) continue;
        if (c.name !== cur[slot].name && curNames.has(c.name)) continue;
        const trial = cur.slice(); trial[slot] = c;
        return { trial, oldName: cur[slot].name, newName: c.name };
      }
      return null;
    }
    const vs = annealVariants.get(cur[slot].name);
    if (!vs || vs.length < 2) return null;
    let v = vs[(Math.random() * vs.length) | 0];
    if (v === cur[slot]) v = vs[(vs.indexOf(v) + 1) % vs.length];
    const trial = cur.slice(); trial[slot] = v;
    return { trial, oldName: cur[slot].name, newName: v.name };
  }

  function annealSegment() {
    let cur = annealSeed();
    let curEv = score(cur);
    if (!curEv.valid || cur.length < SLOTS) return { loadout: cur, ev: curEv };
    let best = cur.slice(), bestEv = curEv;
    let curNames = new Set(cur.map(x => x.name));
    let acc = 0, n = 0;
    for (let i = 0; i < 24; i++) {
      const nb = annealNeighbor(cur, curNames);
      if (!nb) continue;
      const ev = score(nb.trial);
      acc += Math.abs(annealEnergy(ev) - annealEnergy(curEv)); n++;
    }
    let T0 = (n ? acc / n : Math.max(1, Math.abs(annealEnergy(curEv)) * 0.05)) * annealTempScale;
    if (!(T0 > 0)) T0 = 1;
    const Tmin = Math.max(T0 * 1e-3, 1e-9);
    const alpha = Math.exp(Math.log(Tmin / T0) / annealMoves);
    let T = T0;
    for (let m = 0; m < annealMoves && !cancelled; m++) {
      const nb = annealNeighbor(cur, curNames);
      if (nb) {
        const ev = score(nb.trial);
        const dE = annealEnergy(ev) - annealEnergy(curEv);
        if (dE <= 0 || Math.random() < Math.exp(-dE / T)) {
          cur = nb.trial; curEv = ev;
          if (nb.oldName !== nb.newName) { curNames.delete(nb.oldName); curNames.add(nb.newName); }
          if (isLoadoutBetter(curEv, bestEv, opts)) { best = cur.slice(); bestEv = curEv; }
        }
      }
      T *= alpha; if (T < Tmin) T = Tmin;
    }
    return { loadout: best, ev: bestEv };
  }

  const oneTry = () => useAnneal ? annealSegment() : runOneTry();

  if (preset.budgetMs) {
    let tries = 0;
    while (Date.now() - t0 < preset.budgetMs && !cancelled) {
      const sliceEnd = Date.now() + 48;
      while (Date.now() - t0 < preset.budgetMs && Date.now() < sliceEnd && !cancelled) {
        const res = oneTry();
        if (isLoadoutBetter(res.ev, globalBest.ev, opts)) globalBest = res;
        tries++;
      }
      const elapsed = Date.now() - t0;
      const pct = heuristicLo + (elapsed / preset.budgetMs) * span;
      if (onProgress) await onProgress(pct, heurLabel(` · ${(elapsed / 1000).toFixed(0)}s / ${Math.round(preset.budgetMs / 1000)}s`), heurEvals);
      else await yieldToWorker();
    }
    return { ...globalBest, tries, candidates: heurEvals };
  }

  const restarts = preset.restarts || 100;
  const rounds = preset.rounds || 1;
  let done = 0;
  const total = restarts * rounds;
  for (let round = 0; round < rounds && !cancelled; round++) {
    let r = 0;
    while (r < restarts && !cancelled) {
      const sliceEnd = Date.now() + 48;
      while (r < restarts && Date.now() < sliceEnd && !cancelled) {
        const res = oneTry();
        if (isLoadoutBetter(res.ev, globalBest.ev, opts)) globalBest = res;
        r++;
        done++;
      }
      const pct = heuristicLo + (done / Math.max(1, total)) * span;
      if (onProgress) await onProgress(pct, heurLabel(), heurEvals);
      else await yieldToWorker();
    }
  }
  return { ...globalBest, tries: done, candidates: heurEvals };
}

function serializeLoadout(loadout) {
  return loadout.map(c => ({
    emIdx: c.emIdx, name: c.name, grade: c.grade,
    colors: c.colors, stats: c.stats,
  }));
}

// ---------------------------------------------------------------------------
// EXACT color-constrained enumeration — parallel shard worker.
// Scoring is built ENTIRELY from constants passed in the payload (STATS scales +
// color-bonus tables) rather than the worker's own STATS/evaluate, so a shard's
// objective is byte-identical to the main thread's evaluate(); this is what
// makes the parallel result exact. See searchColorExactParallel on the main thread.
// ---------------------------------------------------------------------------
const xeBinomCache = new Map();
function xeBinomial(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const key = n + ',' + k;
  const c = xeBinomCache.get(key);
  if (c !== undefined) return c;
  k = Math.min(k, n - k);
  let num = 1;
  for (let i = 0; i < k; i++) num = (num * (n - i)) / (i + 1);
  num = Math.round(num);
  xeBinomCache.set(key, num);
  return num;
}

// lexicographic unranking of the rank-th k-subset of {0..n-1} (ascending),
// matching the order produced by xeNextCombo starting at [0,1,...,k-1].
function xeUnrankCombination(n, k, rank) {
  const result = new Array(k);
  let r = rank;
  let start = 0;
  for (let i = 0; i < k; i++) {
    for (let v = start; v < n; v++) {
      const cnt = xeBinomial(n - 1 - v, k - 1 - i);
      if (r < cnt) { result[i] = v; start = v + 1; break; }
      r -= cnt;
    }
  }
  return result;
}

function xeNextCombo(idx, k, n) {
  if (k === 0) return false;
  let i = k - 1;
  while (i >= 0 && idx[i] === n - k + i) i--;
  if (i < 0) return false;
  idx[i]++;
  for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  return true;
}
function xeResetCombo(idx, k) { for (let i = 0; i < k; i++) idx[i] = i; }

function xeMakeContext(payload) {
  const XS = payload.stats;                 // [{id, scale}]
  const TH = payload.colorThresholds || {};
  const BON = payload.colorBonus || {};
  const PROTECT_W = 45;
  const EPS = SCORE_EPS;
  const scaleOf = {};
  XS.forEach(s => { scaleOf[s.id] = s.scale || 1; });

  const normalize = (id, val) => val * (scaleOf[id] || 1);
  const sumStats = (loadout) => {
    const t = {};
    for (const s of XS) t[s.id] = 0;
    for (const it of loadout) {
      const st = it.stats;
      for (const kk in st) { if (t[kk] !== undefined) t[kk] += st[kk]; }
    }
    return t;
  };
  const countColors = (loadout) => {
    const c = {};
    for (const it of loadout) {
      const cs = it.colors || [];
      for (const col of cs) c[col] = (c[col] || 0) + 1;
    }
    return c;
  };
  const colorsMatch = (counts, ct) => {
    if (!ct) return true;
    for (const col in ct.targets) { if ((counts[col] || 0) !== ct.targets[col]) return false; }
    return true;
  };
  const colorBonusScore = (counts, include) => {
    if (!include) return 0;
    let score = 0;
    for (const color in counts) {
      const th = TH[color];
      if (!th) continue;
      const n = counts[color];
      const bon = BON[color];
      let tier = -1;
      for (let i = th.length - 1; i >= 0; i--) { if (n >= th[i]) { tier = i; break; } }
      if (tier >= 0) { score += bon[tier] * (color === 'gray' ? 8 : 15); }
    }
    return score;
  };
  const protectPenalty = (id, val, floor) => {
    if (val >= floor - EPS) return 0;
    return (floor - val) * (scaleOf[id] || 1) * PROTECT_W;
  };
  const statDelta = (id, actual, target) => {
    const diff = Math.abs(actual - target);
    const tol = (id === 'crit' || id === 'cdr') ? 0.05 : 0.51;
    return diff <= tol ? 0 : diff;
  };
  const targetError = (loadout, opts) => {
    const totals = sumStats(loadout);
    let err = 0;
    for (const s of XS) {
      if (!opts.targetActive[s.id]) continue;
      err += statDelta(s.id, totals[s.id] || 0, opts.targets[s.id]) * (scaleOf[s.id] || 1);
    }
    return err;
  };
  const evaluate = (loadout, opts) => {
    const totals = sumStats(loadout);
    const counts = countColors(loadout);
    if (!colorsMatch(counts, opts.colorTargets)) {
      return { valid: false, score: -1e12, totals, counts, error: Infinity };
    }
    if (opts.mode === 'maximize') {
      let score = colorBonusScore(counts, opts.colorBonuses);
      for (const s of XS) {
        const v = totals[s.id] || 0;
        if (opts.priorities[s.id]) score += normalize(s.id, v) * (opts.weights[s.id] || 1);
        if (opts.protected[s.id] !== undefined) score -= protectPenalty(s.id, v, opts.protected[s.id]);
      }
      return { valid: true, score, totals, counts };
    }
    const err = targetError(loadout, opts);
    return { valid: true, score: -err, totals, counts, error: err };
  };
  const greedyValue = (c, opts) => {
    let v = 0;
    if (opts.mode === 'maximize') {
      for (const s of XS) {
        const raw = c.stats[s.id] || 0;
        if (opts.priorities[s.id]) v += normalize(s.id, raw) * (opts.weights[s.id] || 1);
        if (opts.protected[s.id] !== undefined) v -= protectPenalty(s.id, raw, opts.protected[s.id]);
      }
    } else {
      for (const kk in c.stats) v += Math.abs(c.stats[kk]);
    }
    return v;
  };
  const loadoutSignature = (loadout) =>
    loadout.map(x => x.name + '\u0001' + x.grade).sort().join('\u0002');
  const isLoadoutBetter = (ev, bestEv, loadout, bestLoadout, opts) => {
    if (!ev.valid) return false;
    if (!bestLoadout || !bestLoadout.length) return true;
    if (opts.mode === 'target') {
      const a = ev.error == null ? Infinity : ev.error;
      const b = bestEv.error == null ? Infinity : bestEv.error;
      if (a < b - EPS) return true;
      if (Math.abs(a - b) <= EPS) return loadoutSignature(loadout) < loadoutSignature(bestLoadout);
      return false;
    }
    if (ev.score > bestEv.score + EPS) return true;
    if (Math.abs(ev.score - bestEv.score) <= EPS) {
      if (loadoutSignature(loadout) === loadoutSignature(bestLoadout)) return false;
      return Math.random() < 0.55;
    }
    return false;
  };
  return { XS, scaleOf, evaluate, greedyValue, isLoadoutBetter };
}

async function searchColorExactRange(payload) {
  const ctx = xeMakeContext(payload);
  const opts = payload.opts;
  const slots = payload.slots;
  const groups = payload.groups;            // [{ vec, names }]
  const kVectors = payload.kVectors;
  const prefix = payload.kPrefix;
  const G = groups.length;
  const sizes = groups.map(g => g.names.length);
  const start = payload.start;
  const end = payload.end;
  const total = payload.total;

  const variantsByName = new Map();
  for (const c of payload.pool) {
    if (!variantsByName.has(c.name)) variantsByName.set(c.name, []);
    variantsByName.get(c.name).push(c);
  }
  const multiVariant = [...variantsByName.values()].some(v => v.length > 1);
  const hasProtect = opts.mode === 'maximize' && opts.protected &&
    Object.keys(opts.protected).length > 0;
  const needsPolish = multiVariant && (opts.mode === 'target' || hasProtect);

  const perSlot = {};
  if (opts.mode === 'target') {
    for (const s of ctx.XS) { if (opts.targetActive[s.id]) perSlot[s.id] = opts.targets[s.id] / slots; }
  }

  function seedVariant(name) {
    const vs = variantsByName.get(name);
    if (vs.length === 1) return vs[0];
    if (opts.mode === 'maximize') {
      let best = vs[0], bv = ctx.greedyValue(vs[0], opts);
      for (let i = 1; i < vs.length; i++) {
        const v = ctx.greedyValue(vs[i], opts);
        if (v > bv) { bv = v; best = vs[i]; }
      }
      return best;
    }
    let best = vs[0], bd = Infinity;
    for (const c of vs) {
      let d = 0;
      for (const s of ctx.XS) { if (opts.targetActive[s.id]) d += Math.abs((c.stats[s.id] || 0) - perSlot[s.id]); }
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  function gradePolish(loadout) {
    let best = loadout.slice();
    let bestEv = ctx.evaluate(best, opts);
    let improved = true, passes = 0;
    while (improved && passes < 4) {
      improved = false; passes++;
      for (let slot = 0; slot < best.length; slot++) {
        const vs = variantsByName.get(best[slot].name);
        if (vs.length <= 1) continue;
        for (const v of vs) {
          if (v === best[slot]) continue;
          const trial = best.slice();
          trial[slot] = v;
          const ev = ctx.evaluate(trial, opts);
          if (ctx.isLoadoutBetter(ev, bestEv, trial, best, opts)) { best = trial; bestEv = ev; improved = true; }
        }
      }
    }
    return { loadout: best, ev: bestEv };
  }

  let best = { loadout: [], ev: { score: -1e12, error: Infinity } };
  function evalNameSet(names) {
    const loadout = names.map(seedVariant);
    const res = needsPolish ? gradePolish(loadout) : { loadout, ev: ctx.evaluate(loadout, opts) };
    if (res.ev.valid && ctx.isLoadoutBetter(res.ev, best.ev, res.loadout, best.loadout, opts)) {
      best = { loadout: res.loadout.slice(), ev: res.ev };
    }
  }

  const sliceSize = Math.max(1, end - start);
  // Locate the starting kVector (largest j with prefix[j] <= start) and unrank
  // the within-pattern local index into a per-group combination odometer.
  let lo = 0, hi = kVectors.length - 1, j = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid] <= start) { j = mid; lo = mid + 1; } else hi = mid - 1;
  }
  let k = kVectors[j];
  let idxs = unrankLocalState(groups, sizes, k, start - prefix[j]);

  let processed = 0;
  let g = start;
  let sliceEnd = Date.now() + 40;
  const reportEvery = Math.max(1, Math.floor(sliceSize / 50));
  let nextReport = reportEvery;

  while (g < end) {
    const names = [];
    for (let gi = 0; gi < G; gi++) {
      const kg = k[gi];
      if (!kg) continue;
      const idx = idxs[gi];
      const gnames = groups[gi].names;
      for (let t = 0; t < kg; t++) names.push(gnames[idx[t]]);
    }
    evalNameSet(names);
    processed++;
    g++;

    if (processed >= nextReport || Date.now() >= sliceEnd) {
      if (cancelled) return null;
      // Report THIS shard's evaluated count (tagged with shardIndex by post()).
      // The main thread SUMS evaluated across shards over the true global total,
      // so the displayed counter climbs toward totalCombos rather than a slice.
      post('progress', { evaluated: processed });
      await yieldToWorker();
      sliceEnd = Date.now() + 40;
      nextReport = processed + reportEvery;
    }

    if (g >= end) break;
    // advance the within-pattern odometer; on rollover, step to the next kVector.
    let carry = true;
    for (let gi = G - 1; gi >= 0 && carry; gi--) {
      if (xeNextCombo(idxs[gi], k[gi], sizes[gi])) carry = false;
      else xeResetCombo(idxs[gi], k[gi]);
    }
    if (carry) {
      j++;
      if (j >= kVectors.length) break;
      k = kVectors[j];
      idxs = k.map(kg => { const a = new Array(kg); for (let i = 0; i < kg; i++) a[i] = i; return a; });
    }
  }

  if (cancelled) return null;
  if (best.loadout.length !== slots) return { loadout: [], ev: best.ev };
  return { loadout: serializeLoadout(best.loadout), ev: best.ev };
}

// Unrank a within-pattern local index into per-group lexicographic combination
// odometers. Group G-1 is least significant (matches the carry order above).
function unrankLocalState(groups, sizes, k, local) {
  const G = groups.length;
  const radix = k.map((kg, gi) => xeBinomial(sizes[gi], kg));
  const r = new Array(G).fill(0);
  for (let gi = G - 1; gi >= 0; gi--) {
    const R = radix[gi] || 1;
    r[gi] = local % R;
    local = Math.floor(local / R);
  }
  return k.map((kg, gi) => xeUnrankCombination(sizes[gi], kg, r[gi]));
}

async function runExactRange(msg) {
  jobId = msg.id;
  shardIndex = msg.shardIndex || 0;
  cancelled = false;
  const res = await searchColorExactRange(msg);
  if (cancelled) return { cancelled: true };
  return res;
}

async function runJob(msg) {
  jobId = msg.id;
  shardIndex = msg.shardIndex || 0;
  shardCount = msg.shardCount || 1;
  cancelled = false;
  // skipExact: non-primary pool shards run HEURISTIC ONLY so the exact/MITM/
  // brute phase (and its IndexedDB usage) runs once, on the primary shard.
  const { pool: rawHeuristic, exactPool: rawExact, opts, slots, preset, heuristicLo, searchMeta, skipExact } = msg;
  const mapPool = (raw) => assignPoolIds(raw.map(c => ({ ...c, stats: { ...c.stats } })));
  const pool = mapPool(rawHeuristic);
  const exactPool = rawExact ? mapPool(rawExact) : pool;
  const SLOTS = slots;
  let globalBest = { loadout: [], ev: { score: -1e12, error: Infinity } };
  const meta = { ...searchMeta };
  const tSearch0 = Date.now();

  const mapExactSub = (sub) => 2 + sub * (heuristicLo - 2);
  const onExact = async (sub, label) => {
    post('progress', { pct: mapExactSub(sub), label });
  };

  if (!skipExact && opts.mode === 'target' && STATS.some(s => opts.targetActive[s.id]) && preset.useExact) {
    const limits = {
      mitmMs: preset.mitmMs,
      bruteMs: preset.bruteMs,
      enumMax: preset.enumMax,
      lookupCap: preset.lookupCap ?? 200,
      bruteMaxNames: preset.bruteMaxNames,
    };
    const tExact0 = Date.now();
    const exact = await searchTargetExact(exactPool, opts, SLOTS, limits, onExact);
    meta.exactMs = Date.now() - tExact0;
    meta.exact = true;
    if (cancelled) return { cancelled: true };
    if (exact?.loadout?.length === SLOTS) {
      const ev = evaluate(exact.loadout, opts.mode, opts);
      if (ev.valid) {
        globalBest = { loadout: exact.loadout, ev };
        meta.exactError = exact.error;
        if (exact.error <= SCORE_EPS) {
          meta.heuristicSkipped = 'exact match';
          meta.totalMs = Date.now() - tSearch0;
          post('progress', { pct: 100, label: 'Done — exact match' });
          return { loadout: serializeLoadout(globalBest.loadout), ev: globalBest.ev, searchMeta: meta };
        }
      }
    }
    post('progress', { pct: heuristicLo, label: 'Heuristic search…' });
  } else {
    post('progress', { pct: heuristicLo, label: 'Searching random builds…' });
  }

  // evaluated = this shard's running count of candidate loadouts scored; the
  // main thread sums it across shards for the "candidates tried" counter.
  const onHeuristic = async (pct, label, evaluated) => {
    post('progress', { pct, label, evaluated, phase: 'heuristic' });
  };

  const tHeuristic0 = Date.now();
  const hres = await runHeuristic(pool, opts, SLOTS, preset, heuristicLo, onHeuristic);
  if (cancelled) return { cancelled: true };
  if (hres.loadout?.length) {
    if (!globalBest.loadout.length || isLoadoutBetter(hres.ev, globalBest.ev, opts)) globalBest = hres;
    if (opts.colorTargets && !meta.colorExact && colorsMatchTargets(countColors(hres.loadout), opts.colorTargets)) {
      meta.colorExact = true;
    }
  }
  meta.restarts = hres.tries;
  meta.candidates = hres.candidates || 0;
  meta.heuristicMs = Date.now() - tHeuristic0;
  meta.totalMs = Date.now() - tSearch0;
  meta.plannedTries = preset.budgetMs ? null : (preset.restarts || 0) * (preset.rounds || 1);
  meta.worker = true;

  return {
    loadout: serializeLoadout(globalBest.loadout),
    ev: globalBest.ev,
    searchMeta: meta,
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    if (msg.id === jobId) cancelled = true;
    return;
  }
  if (msg.type === 'runExactRange') {
    try {
      const result = await runExactRange(msg);
      if (result && result.cancelled) post('done', { cancelled: true });
      else post('done', { result });
    } catch (err) {
      post('error', { message: err?.message || String(err) });
    }
    return;
  }
  if (msg.type !== 'run') return;
  try {
    const result = await runJob(msg);
    if (result.cancelled) post('done', { cancelled: true });
    else post('done', { result });
  } catch (err) {
    post('error', { message: err?.message || String(err) });
  }
};
