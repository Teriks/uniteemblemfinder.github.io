const STATS = [
  { id: 'hp', label: 'HP', scale: 1 },
  { id: 'atk', label: 'Attack', scale: 1 },
  { id: 'spatk', label: 'Sp. Atk', scale: 1 },
  { id: 'def', label: 'Defense', scale: 1 },
  { id: 'spdef', label: 'Sp. Def', scale: 1 },
  { id: 'spd', label: 'Move Speed', scale: 0.1 },
  { id: 'crit', label: 'Crit Rate %', scale: 10 },
  { id: 'cdr', label: 'Cooldown %', scale: 10 },
];

const GRADE_ORDER = ['bronze', 'silver', 'gold'];
const COLOR_LABELS = {
  green: 'Green (Sp.Atk)', white: 'White (HP)', brown: 'Brown (Atk)',
  blue: 'Blue (Def)', purple: 'Purple (Sp.Def)', red: 'Red (Atk Spd)',
  black: 'Black (CDR)', yellow: 'Yellow (Move Spd)', pink: 'Pink (Hindrance)',
  navy: 'Navy (Unite)', gray: 'Gray (Dmg Red.)',
};

const COLOR_THRESHOLDS = __COLOR_THRESHOLDS_JS__;

const COLOR_BONUS = __COLOR_BONUS_JS__;

const COLOR_BONUS_STAT = __COLOR_BONUS_STAT_JS__;

// Human-readable labels for the color-bonus effect keys (COLOR_BONUS_STAT),
// used by both the results panel and the proposed-bonuses preview.
const BONUS_EFFECT_LABEL = {
  'spatk%': 'Sp. Atk', 'hp%': 'HP', 'atk%': 'Atk', 'def%': 'Def', 'spdef%': 'Sp. Def',
  'atkspd%': 'Atk Spd', 'cdr%': 'CDR', 'msp%': 'Move Spd', 'hind%': 'Tenacity',
  'unite%': 'Unite Charge', 'dmgflat': 'Dmg Reduction',
};

function formatColorBonusValue(effect, value) {
  const sign = value > 0 ? '+' : '';
  if (effect === 'dmgflat') return `${sign}${value} flat dmg`;
  return `${sign}${value}% ${BONUS_EFFECT_LABEL[effect] || effect}`;
}

let poolSelected = new Set();
/** @type {Map<number, Set<string>>} emIdx -> owned grades (bronze|silver|gold) */
let ownedGrades = new Map();

const GRADE_SHORT = { bronze: 'B', silver: 'S', gold: 'G' };

function emblemIconUrl(em, grade) {
  const code = em?.codes?.[grade];
  return code ? (EMBLEM_ICONS[code] || null) : null;
}

function poolIconGrade(emIdx) {
  const em = EMBLEMS[emIdx];
  if (!em?.g) return 'gold';
  const maxIdx = GRADE_ORDER.indexOf(getMaxGrade());
  const owned = [...getOwnedSet(emIdx)].filter(g => em.g[g] && GRADE_ORDER.indexOf(g) <= maxIdx);
  return GRADE_ORDER.filter(g => owned.includes(g)).pop() || GRADE_ORDER.find(g => em.g[g]) || 'gold';
}

function emblemIconHtml(em, grade, className = 'emblem-icon') {
  const url = emblemIconUrl(em, grade);
  if (!url) return '';
  const px = className.includes('slot') ? 80 : 72;
  return `<img class="${className}" src="${url}" alt="" width="${px}" height="${px}" decoding="async">`;
}
const POOL_SAVE_VERSION = 1;
const SEARCH_WORKER_CODE = __SEARCH_WORKER_JS__;
let optimizeRunning = false;
let searchStartTime = 0;
let searchEtaSmoothed = null;
let searchCancelToken = null;
let searchWorkerUrl = null;
let searchWorkerInstance = null;
let searchWorkerPool = [];

class OptimizeCancelled extends Error {
  constructor() {
    super('Search cancelled');
    this.name = 'OptimizeCancelled';
  }
}

function checkSearchCancelled() {
  if (searchCancelToken?.cancelled) throw new OptimizeCancelled();
}

function requestOptimizeCancel() {
  if (!searchCancelToken || searchCancelToken.cancelled) return;
  searchCancelToken.cancelled = true;
  if (searchCancelToken.rejectWorker) {
    // Covers both the single worker and the worker pool (the active run installs
    // a rejectWorker that broadcasts cancel + tears down all its workers).
    searchCancelToken.rejectWorker();
    searchCancelToken.rejectWorker = null;
  } else if (searchCancelToken.workerId && (searchWorkerInstance || searchWorkerPool.length)) {
    if (searchWorkerInstance) {
      searchWorkerInstance.postMessage({ type: 'cancel', id: searchCancelToken.workerId });
    }
    searchWorkerPool.forEach(w => {
      try { w.postMessage({ type: 'cancel', id: searchCancelToken.workerId }); } catch (e) {}
    });
    terminateSearchWorker();
    terminateSearchWorkerPool();
  }
  setSearchProgress(searchCancelToken.lastPct ?? 0, 'Cancelling…');
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

function getSearchWorker() {
  if (typeof Worker === 'undefined') return null;
  if (!searchWorkerUrl) {
    searchWorkerUrl = URL.createObjectURL(
      new Blob([SEARCH_WORKER_CODE], { type: 'application/javascript' })
    );
  }
  if (!searchWorkerInstance) searchWorkerInstance = new Worker(searchWorkerUrl);
  return searchWorkerInstance;
}

function isHeavySearchPreset(preset) {
  return !!(preset?.budgetMs);
}

function terminateSearchWorker() {
  if (searchWorkerInstance) {
    searchWorkerInstance.terminate();
    searchWorkerInstance = null;
  }
}

// Worker pool for parallelizing the heuristic restart loop across cores. Sized
// to leave one core for the UI; created lazily from the SAME Blob URL as the
// single worker and reused across searches.
function searchPoolSize() {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, hc - 1);
}

function getSearchWorkerPool() {
  if (typeof Worker === 'undefined') return null;
  if (!searchWorkerUrl) {
    searchWorkerUrl = URL.createObjectURL(
      new Blob([SEARCH_WORKER_CODE], { type: 'application/javascript' })
    );
  }
  if (!searchWorkerPool.length) {
    const n = searchPoolSize();
    for (let i = 0; i < n; i++) {
      try {
        searchWorkerPool.push(new Worker(searchWorkerUrl));
      } catch (e) {
        break;
      }
    }
  }
  return searchWorkerPool.length ? searchWorkerPool : null;
}

function terminateSearchWorkerPool() {
  searchWorkerPool.forEach(w => { try { w.terminate(); } catch (e) {} });
  searchWorkerPool = [];
}

async function runOptimizeInWorker(heuristicPool, exactPool, opts, slots, ctx, progress) {
  const worker = getSearchWorker();
  if (!worker) throw new Error('Web Workers unavailable');
  assignPoolIds(heuristicPool);
  assignPoolIds(exactPool);
  const jobId = Date.now();
  searchCancelToken.workerId = jobId;
  const ser = (list) => list.map(c => ({
    emIdx: c.emIdx, name: c.name, grade: c.grade,
    colors: c.colors || [], stats: { ...c.stats }, cid: c.cid, nid: c.nid,
  }));

  const payload = {
    type: 'run',
    id: jobId,
    pool: ser(heuristicPool),
    exactPool: ser(exactPool),
    opts,
    slots,
    preset: {
      useExact: !!ctx.preset.useExact,
      budgetMs: ctx.preset.budgetMs || 0,
      mitmMs: ctx.preset.mitmMs,
      bruteMs: ctx.preset.bruteMs,
      enumMax: ctx.preset.enumMax,
      lookupCap: ctx.lookupCap,
      bruteMaxNames: ctx.preset.bruteMaxNames,
      improvePasses: ctx.preset.improvePasses,
      rounds: ctx.preset.rounds,
      restarts: ctx.restarts,
    },
    heuristicLo: ctx.heuristicLo,
    searchMeta: ctx.searchMeta,
  };

  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const d = ev.data;
      if (d.jobId !== jobId) return;
      if (d.type === 'progress') {
        if (progress) progress(d.pct, d.label);
        if (searchCancelToken) searchCancelToken.lastPct = d.pct;
      } else if (d.type === 'done') {
        worker.removeEventListener('message', onMsg);
        if (d.cancelled) reject(new OptimizeCancelled());
        else resolve(d.result);
      } else if (d.type === 'error') {
        worker.removeEventListener('message', onMsg);
        reject(new Error(d.message || 'Worker search failed'));
      }
    };
    worker.addEventListener('message', onMsg);
    if (searchCancelToken) {
      searchCancelToken.rejectWorker = () => {
        worker.removeEventListener('message', onMsg);
        terminateSearchWorker();
        reject(new OptimizeCancelled());
      };
    }
    worker.postMessage(payload);
  });
}

// Parallel heuristic: fan out `poolSize` shards of the SAME stripped pool/opts,
// one per worker, then reduce shard results to the single best via
// isLoadoutBetter. Shard 0 (primary) runs the exact/MITM phase + heuristic; all
// other shards run heuristic-only (skipExact) so the exact work + IndexedDB
// usage happens exactly once. budgetMs presets give every shard the full budget
// (concurrent); restart-count budgets are divided across shards. Independent
// workers have independent Math.random streams, so shards explore different
// restarts naturally. Throws on pool failure so the caller can fall back.
async function runOptimizeInWorkerPool(heuristicPool, exactPool, opts, slots, ctx, progress) {
  const workers = getSearchWorkerPool();
  if (!workers || !workers.length) throw new Error('Worker pool unavailable');
  const shards = workers.length;
  assignPoolIds(heuristicPool);
  assignPoolIds(exactPool);
  const jobId = Date.now();
  searchCancelToken.workerId = jobId;
  const ser = (list) => list.map(c => ({
    emIdx: c.emIdx, name: c.name, grade: c.grade,
    colors: c.colors || [], stats: { ...c.stats }, cid: c.cid, nid: c.nid,
  }));
  const serH = ser(heuristicPool);
  const serE = ser(exactPool);

  const baseRestarts = ctx.restarts || 0;
  const perShardRestarts = ctx.preset.budgetMs
    ? baseRestarts                                   // concurrent: each gets full budget
    : Math.max(1, Math.ceil(baseRestarts / shards)); // split the restart count

  const makePayload = (idx) => ({
    type: 'run',
    id: jobId,
    shardIndex: idx,
    shardCount: shards,
    skipExact: idx !== 0,
    pool: serH,
    exactPool: serE,
    opts,
    slots,
    preset: {
      useExact: !!ctx.preset.useExact,
      budgetMs: ctx.preset.budgetMs || 0,
      mitmMs: ctx.preset.mitmMs,
      bruteMs: ctx.preset.bruteMs,
      enumMax: ctx.preset.enumMax,
      lookupCap: ctx.lookupCap,
      bruteMaxNames: ctx.preset.bruteMaxNames,
      improvePasses: ctx.preset.improvePasses,
      rounds: ctx.preset.rounds,
      restarts: perShardRestarts,
    },
    heuristicLo: ctx.heuristicLo,
    searchMeta: ctx.searchMeta,
  });

  return new Promise((resolve, reject) => {
    const shardPct = new Array(shards).fill(0);
    const shardEval = new Array(shards).fill(0);
    const results = new Array(shards).fill(null);
    const listeners = new Array(shards).fill(null);
    const doneFlags = new Array(shards).fill(false);
    const poolStart = Date.now();
    let doneCount = 0;
    let cancelledCount = 0;
    let resolved = false;

    const removeAll = () => {
      workers.forEach((w, i) => {
        if (listeners[i]) { w.removeEventListener('message', listeners[i]); listeners[i] = null; }
      });
    };
    // Shards run the same span concurrently → mean pct is a smooth aggregate.
    const aggPct = () => { let s = 0; for (const p of shardPct) s += p; return s / shards; };
    const sumEval = () => { let s = 0; for (const e of shardEval) s += e; return s; };
    // During the heuristic phase, show the total candidate loadouts evaluated
    // across every core (summed); during the exact/MITM phase pass the primary
    // shard's own label through unchanged.
    const heurPoolLabel = () => {
      let label = `Heuristic · ${sumEval().toLocaleString()} candidates tried`;
      if (ctx.preset.budgetMs) {
        const el = Math.floor((Date.now() - poolStart) / 1000);
        label += ` · ${el}s / ${Math.round(ctx.preset.budgetMs / 1000)}s`;
      }
      return label;
    };

    const merge = () => {
      const valid = results.filter(r => r && !r.cancelled && r.loadout && r.loadout.length);
      if (!valid.length) {
        if (cancelledCount > 0) { reject(new OptimizeCancelled()); return; }
        resolve({ loadout: [], ev: { score: -1e12, error: Infinity },
          searchMeta: { ...ctx.searchMeta, shards, parallel: true } });
        return;
      }
      let best = valid[0];
      let totalRestarts = 0;
      let totalCandidates = 0;
      let maxHeuristicMs = 0;
      for (const r of valid) {
        totalRestarts += (r.searchMeta?.restarts || 0);
        totalCandidates += (r.searchMeta?.candidates || 0);
        maxHeuristicMs = Math.max(maxHeuristicMs, r.searchMeta?.heuristicMs || 0);
        if (r !== best && isLoadoutBetter(r.ev, best.ev, r.loadout, best.loadout, opts)) best = r;
      }
      // Start from the primary's meta (carries exact/MITM fields), overlay the
      // winner's, then sum restart counts across all shards.
      const primaryMeta = results[0]?.searchMeta || {};
      const meta = { ...primaryMeta, ...best.searchMeta };
      meta.restarts = totalRestarts;
      meta.candidates = totalCandidates;
      meta.shards = shards;
      meta.parallel = true;
      meta.heuristicMs = maxHeuristicMs || meta.heuristicMs;
      resolve({ loadout: best.loadout, ev: best.ev, searchMeta: meta });
    };

    // A provably-perfect target match lets us stop the other shards early.
    const isTerminal = (res) => {
      if (!res || !res.loadout || !res.loadout.length) return false;
      if (opts.mode === 'target') return (res.ev?.error ?? Infinity) <= SCORE_EPS;
      return false;
    };

    const finalize = () => {
      if (resolved) return;
      resolved = true;
      removeAll();
      // Stop stragglers but keep the pool warm for reuse.
      workers.forEach((w, i) => {
        if (!doneFlags[i]) { try { w.postMessage({ type: 'cancel', id: jobId }); } catch (e) {} }
      });
      if (searchCancelToken) searchCancelToken.rejectWorker = null;
      merge();
    };

    if (searchCancelToken) {
      searchCancelToken.rejectWorker = () => {
        if (resolved) return;
        resolved = true;
        removeAll();
        workers.forEach(w => { try { w.postMessage({ type: 'cancel', id: jobId }); } catch (e) {} });
        terminateSearchWorkerPool();
        reject(new OptimizeCancelled());
      };
    }

    workers.forEach((worker, idx) => {
      const onMsg = (ev) => {
        const d = ev.data;
        if (d.jobId !== jobId || d.shardIndex !== idx) return;
        if (d.type === 'progress') {
          shardPct[idx] = d.pct;
          if (d.phase === 'heuristic') {
            shardEval[idx] = d.evaluated || 0;
            if (searchCancelToken) searchCancelToken.lastPct = aggPct();
            if (progress) progress(aggPct(), heurPoolLabel());
          } else {
            if (searchCancelToken) searchCancelToken.lastPct = aggPct();
            if (progress) progress(aggPct(), idx === 0 ? d.label : null);
          }
        } else if (d.type === 'done') {
          worker.removeEventListener('message', onMsg);
          listeners[idx] = null;
          doneFlags[idx] = true;
          doneCount++;
          if (d.cancelled) cancelledCount++;
          else if (d.result) results[idx] = d.result;
          if (!resolved && d.result && isTerminal(d.result)) { finalize(); return; }
          if (doneCount === shards) finalize();
        } else if (d.type === 'error') {
          worker.removeEventListener('message', onMsg);
          listeners[idx] = null;
          doneFlags[idx] = true;
          if (!resolved) {
            resolved = true;
            removeAll();
            terminateSearchWorkerPool();
            if (searchCancelToken) searchCancelToken.rejectWorker = null;
            reject(new Error(d.message || 'Worker shard failed'));
          }
        }
      };
      listeners[idx] = onMsg;
      worker.addEventListener('message', onMsg);
      worker.postMessage(makePayload(idx));
    });
  });
}

function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}m ${s}s`;
}

function resetSearchTimer() {
  searchStartTime = Date.now();
  searchEtaSmoothed = null;
}

// #7: estimated-time-remaining from elapsed time and current pct, lightly
// smoothed (EMA) so it doesn't jump around. Resets per run; clears on done.
function updateSearchEta(v) {
  const etaEls = document.querySelectorAll('.opt-progress-eta');
  if (!etaEls.length) return;
  let txt = '';
  if (searchStartTime && v > 0 && v < 100) {
    const elapsed = (Date.now() - searchStartTime) / 1000;
    if (elapsed >= 0.4 && v >= 2) {
      const remaining = elapsed * (100 - v) / v;
      searchEtaSmoothed = (searchEtaSmoothed == null)
        ? remaining
        : 0.6 * searchEtaSmoothed + 0.4 * remaining;
      txt = `~${formatDuration(searchEtaSmoothed)} remaining · ${formatDuration(elapsed)} elapsed`;
    } else {
      txt = 'Estimating time…';
    }
  } else if (v >= 100 && searchStartTime) {
    txt = `Done in ${formatDuration((Date.now() - searchStartTime) / 1000)}`;
  }
  etaEls.forEach(el => { el.textContent = txt; });
}

function setSearchProgress(pct, label) {
  const v = Math.min(100, Math.max(0, Math.round(pct)));
  document.querySelectorAll('.opt-progress-fill').forEach(el => {
    el.style.width = v + '%';
    el.classList.toggle('bg-success', v >= 100);
    el.classList.toggle('bg-warning', v < 100);
  });
  document.querySelectorAll('[role="progressbar"]').forEach(el => el.setAttribute('aria-valuenow', String(v)));
  if (label) {
    document.querySelectorAll('.opt-progress-label, #optimizeOverlayLabel').forEach(el => {
      el.textContent = label;
    });
  }
  updateSearchEta(v);
}

function showSearchUI(active) {
  optimizeRunning = active;
  const overlay = document.getElementById('optimizeOverlay');
  if (overlay) overlay.hidden = !active;
  document.body.style.cursor = active ? 'wait' : '';
  ['progressBar', 'progressBarFab'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', active);
  });
  const btns = [document.getElementById('btnOptimize'), document.getElementById('btnOptimizeFab')];
  btns.forEach(b => { if (b) b.disabled = active; });
  ['btnCancelOptimize', 'btnCancelOptimizeFab', 'btnCancelOptimizeOverlay'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === 'btnCancelOptimizeOverlay') {
      el.disabled = !active;
    } else {
      el.classList.toggle('d-none', !active);
      el.disabled = false;
    }
  });
  if (!active) { searchStartTime = 0; searchEtaSmoothed = null; setSearchProgress(0, ''); }
}

async function tickProgress(pct, label) {
  checkSearchCancelled();
  if (searchCancelToken) searchCancelToken.lastPct = pct;
  setSearchProgress(pct, label);
  await yieldToBrowser();
  checkSearchCancelled();
}
const EMBLEM_INDEX_BY_NAME = new Map(EMBLEMS.map((e, i) => [e.n, i]));

function emblemGradesAvailable(emIdx) {
  const g = EMBLEMS[emIdx]?.g;
  return g ? GRADE_ORDER.filter(gr => g[gr]) : [];
}

function getOwnedSet(emIdx) {
  if (!ownedGrades.has(emIdx)) {
    ownedGrades.set(emIdx, new Set(emblemGradesAvailable(emIdx)));
  }
  return ownedGrades.get(emIdx);
}

function setOwnedGrade(emIdx, grade, owned) {
  const s = getOwnedSet(emIdx);
  if (owned) s.add(grade); else s.delete(grade);
}

function defaultOwnedForEmblem(emIdx) {
  const avail = emblemGradesAvailable(emIdx);
  const maxIdx = GRADE_ORDER.indexOf(getMaxGrade());
  const s = new Set(avail.filter(g => GRADE_ORDER.indexOf(g) <= maxIdx));
  ownedGrades.set(emIdx, s.size ? s : new Set(avail));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showOptimizeIssue(msg, kind = 'error') {
  const tone = { error: 'danger', warning: 'warning', info: 'info', success: 'success' }[kind] || 'danger';
  const body = document.getElementById('resultsBody');
  if (body) {
    body.innerHTML = `<div class="alert alert-${tone} mb-0 py-2 small" role="alert">${escapeHtml(msg)}</div>`;
  }
  document.getElementById('totalsBody').innerHTML = '';
  document.getElementById('resultsCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setPoolImportStatus(msg, isError) {
  const el = document.getElementById('poolImportStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'small mb-2 ' + (isError ? 'text-danger' : msg ? 'text-success' : 'text-secondary');
}

function exportPoolJson() {
  const emblems = [];
  poolSelected.forEach(emIdx => {
    const em = EMBLEMS[emIdx];
    if (!em) return;
    const grades = [...getOwnedSet(emIdx)].filter(g => em.g?.[g]);
    if (grades.length) emblems.push({ name: em.n, grades });
  });
  emblems.sort((a, b) => a.name.localeCompare(b.name));
  const payload = {
    version: POOL_SAVE_VERSION,
    app: 'unite-emblem-optimizer',
    dataSource: 'UniteDB (https://unite-db.com)',
    exportedAt: new Date().toISOString(),
    emblemCount: emblems.length,
    emblems,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `unite-emblem-pool-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setPoolImportStatus(`Saved ${emblems.length} Pokémon to JSON.`);
}

function importPoolJson(data) {
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data?.emblems && Array.isArray(data.emblems)) list = data.emblems;
  else if (data?.pool && Array.isArray(data.pool)) list = data.pool;
  else throw new Error('Unrecognized pool file format.');

  poolSelected.clear();
  ownedGrades.clear();

  let loaded = 0;
  let skipped = 0;
  const unknown = [];

  list.forEach(entry => {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (!name) { skipped++; return; }
    const emIdx = EMBLEM_INDEX_BY_NAME.get(name);
    if (emIdx === undefined) {
      unknown.push(name);
      skipped++;
      return;
    }
    const em = EMBLEMS[emIdx];
    if (!em.g || !Object.keys(em.g).length) { skipped++; return; }

    poolSelected.add(emIdx);
    const avail = new Set(emblemGradesAvailable(emIdx));
    let grades = typeof entry === 'object' && Array.isArray(entry.grades) ? entry.grades : [];
    grades = grades.filter(g => avail.has(g));
    if (!grades.length && typeof entry === 'object' && entry.grade) {
      const g = entry.grade;
      if (avail.has(g)) grades = [g];
    }
    if (!grades.length) defaultOwnedForEmblem(emIdx);
    else ownedGrades.set(emIdx, new Set(grades));
    loaded++;
  });

  renderPool();
  syncPoolItemStates();
  updatePoolCount();

  let msg = `Loaded ${loaded} Pokémon`;
  if (unknown.length) msg += ` (${unknown.length} unknown: ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? '…' : ''})`;
  else if (skipped) msg += ` (${skipped} skipped)`;
  msg += '.';
  setPoolImportStatus(msg, loaded === 0);
  return { loaded, skipped, unknown };
}

function handlePoolFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      importPoolJson(data);
    } catch (err) {
      setPoolImportStatus(err.message || 'Invalid JSON file.', true);
    }
  };
  reader.onerror = () => setPoolImportStatus('Could not read file.', true);
  reader.readAsText(file);
}

function statLabel(id) {
  return STATS.find(s => s.id === id)?.label || id;
}

function resetColorTargets() {
  document.getElementById('useColorTargets').checked = false;
  document.querySelectorAll('.color-target-use').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.color-target-val').forEach(inp => { inp.value = '0'; });
  updateColorTargetSummary();
}

function resetMaximizeSection() {
  document.querySelectorAll('.max-priority').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.max-weight').forEach(inp => { inp.value = '1'; });
  document.querySelectorAll('.protect-stat').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.protect-min').forEach(inp => { inp.value = '0'; });
  updateColorTargetSummary();
}

function resetTargetSection() {
  document.querySelectorAll('.target-use').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.target-val').forEach(inp => { inp.value = ''; });
  const smart = document.getElementById('smartTargetPool');
  if (smart) smart.checked = true;
}

function initUI() {
  const maxDiv = document.getElementById('maximizeInputs');
  const tgtDiv = document.getElementById('targetInputs');
  STATS.forEach(s => {
    maxDiv.innerHTML += `
      <div class="row g-1 align-items-center mb-2 border-bottom border-secondary pb-2">
        <div class="col-12 fw-semibold">${s.label}</div>
        <div class="col-6">
          <div class="form-check">
            <input class="form-check-input max-priority" type="checkbox" data-stat="${s.id}" id="mp_${s.id}">
            <label class="form-check-label" for="mp_${s.id}">Maximize</label>
          </div>
        </div>
        <div class="col-6">
          <input type="number" class="form-control form-control-sm max-weight" data-stat="${s.id}" value="1" min="0" step="0.5" title="Weight">
        </div>
        <div class="col-12">
          <div class="form-check">
            <input class="form-check-input protect-stat" type="checkbox" data-stat="${s.id}" id="pr_${s.id}">
            <label class="form-check-label" for="pr_${s.id}">Protect (soft)</label>
          </div>
        </div>
        <div class="col-12">
          <input type="number" class="form-control form-control-sm protect-min" data-stat="${s.id}" value="0" step="1" placeholder="Prefer not below" title="Soft floor — search penalizes totals below this but does not require it">
        </div>
      </div>`;
    tgtDiv.innerHTML += `
      <div class="row g-1 align-items-center mb-2">
        <div class="col-1">
          <input class="form-check-input target-use" type="checkbox" data-stat="${s.id}" id="tu_${s.id}">
        </div>
        <div class="col-4"><label for="tu_${s.id}">${s.label}</label></div>
        <div class="col-7">
          <input type="number" class="form-control form-control-sm target-val" data-stat="${s.id}" value="" placeholder="—" step="any">
        </div>
      </div>`;
  });

  document.getElementById('optMode').addEventListener('change', e => {
    const t = e.target.value === 'target';
    document.getElementById('targetPanel').classList.toggle('d-none', !t);
    document.getElementById('maximizePanel').classList.toggle('d-none', t);
  });

  const ct = document.getElementById('colorTargetInputs');
  Object.keys(COLOR_LABELS).forEach(color => {
    const short = color.charAt(0).toUpperCase() + color.slice(1);
    ct.innerHTML += `
      <div class="color-target-row">
        <span class="color-dot c-${color}" title="${COLOR_LABELS[color]}"></span>
        <input class="form-check-input color-target-use color-target-check" type="checkbox" data-color="${color}" id="ctu_${color}" aria-label="Use ${short}">
        <label class="color-target-label" for="ctu_${color}">${short}</label>
        <input type="number" class="form-control form-control-sm color-target-val" data-color="${color}"
          value="0" min="0" max="20" step="1" inputmode="numeric" aria-label="${short} count">
      </div>`;
  });
  document.getElementById('useColorTargets').addEventListener('change', updateColorTargetSummary);
  document.querySelectorAll('.color-target-use, .color-target-val').forEach(el => {
    el.addEventListener('change', updateColorTargetSummary);
    el.addEventListener('input', updateColorTargetSummary);
  });
  // Maximize/protect/color-bonus toggles change whether the lossless collapse
  // applies, so refresh the summary's effective search-size readout too.
  document.getElementById('optMode').addEventListener('change', updateColorTargetSummary);
  document.getElementById('colorBonuses').addEventListener('change', updateColorTargetSummary);
  document.getElementById('colorBonuses').addEventListener('change', updateColorBonusReach);
  document.querySelectorAll('.protect-stat').forEach(el => {
    el.addEventListener('change', updateColorTargetSummary);
  });
  updateColorTargetSummary();
  updateColorBonusReach();

  const cf = document.getElementById('colorFilters');
  Object.keys(COLOR_LABELS).forEach(c => {
    cf.innerHTML += `<button type="button" class="btn btn-outline-secondary btn-sm color-filter-btn" data-color="${c}">${c}</button>`;
  });

  EMBLEMS.forEach((em, i) => {
    if (em.g && Object.keys(em.g).length) defaultOwnedForEmblem(i);
  });
  renderPool();
  poolSelected = new Set(EMBLEMS.map((_, i) => i).filter(i => Object.keys(EMBLEMS[i].g || {}).length > 0));
  syncPoolItemStates();
  updatePoolCount();

  const poolSearchEl = document.getElementById('poolSearch');
  poolSearchEl.addEventListener('input', onPoolSearchInput);
  poolSearchEl.addEventListener('search', onPoolSearchInput);
  document.getElementById('poolSave').onclick = exportPoolJson;
  document.getElementById('poolLoad').onclick = () => document.getElementById('poolFileInput').click();
  document.getElementById('poolFileInput').addEventListener('change', e => {
    const file = e.target.files?.[0];
    handlePoolFile(file);
    e.target.value = '';
  });
  document.getElementById('poolAll').onclick = () => { setPoolVisible(true); };
  document.getElementById('poolNone').onclick = () => { setPoolVisible(false); };
  document.getElementById('poolInvert').onclick = () => {
    document.querySelectorAll('.pool-item:not(.pool-item-hidden)').forEach(item => {
      const i = +item.dataset.idx;
      if (poolSelected.has(i)) poolSelected.delete(i); else poolSelected.add(i);
    });
    syncPoolItemStates();
    updatePoolCount();
  };
  document.getElementById('gradeOwnBronze').onclick = () => bulkSetVisibleGrades('bronze', true);
  document.getElementById('gradeOwnSilver').onclick = () => bulkSetVisibleGrades('silver', true);
  document.getElementById('gradeOwnGold').onclick = () => bulkSetVisibleGrades('gold', true);
  document.getElementById('gradeOwnAll').onclick = () => bulkSetVisibleGrades('all', true);
  document.getElementById('gradeOwnClear').onclick = () => bulkSetVisibleGrades('all', false);
  document.querySelectorAll('input[name=maxGrade]').forEach(r =>
    r.addEventListener('change', () => { syncPoolItemStates(); updatePoolCount(); })
  );
  document.getElementById('mixedGrades')?.addEventListener('change', updatePoolCount);
  document.getElementById('searchEffort')?.addEventListener('change', updateSearchEffortHint);
  updateSearchEffortHint();
  document.getElementById('btnOptimize').onclick = runOptimize;
  document.getElementById('btnOptimizeFab').onclick = runOptimize;
  ['btnCancelOptimize', 'btnCancelOptimizeFab', 'btnCancelOptimizeOverlay'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', requestOptimizeCancel);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && optimizeRunning) requestOptimizeCancel();
  });

  document.getElementById('btnResetColors')?.addEventListener('click', resetColorTargets);
  document.getElementById('btnResetMaximize')?.addEventListener('click', resetMaximizeSection);
  document.getElementById('btnResetTarget')?.addEventListener('click', resetTargetSection);
}

function gradeButtonsHtml(emIdx) {
  const avail = emblemGradesAvailable(emIdx);
  const owned = getOwnedSet(emIdx);
  return GRADE_ORDER.map(g => {
    const has = avail.includes(g);
    const on = owned.has(g);
    const cls = ['grade-btn', g, has ? 'available' : '', on ? 'owned' : ''].filter(Boolean).join(' ');
    return `<span class="${cls}" data-idx="${emIdx}" data-grade="${g}" title="${has ? (on ? 'Own' : 'Do not own') : ''} ${g}">${GRADE_SHORT[g]}</span>`;
  }).join('');
}

function getPoolSearchQuery() {
  return (document.getElementById('poolSearch')?.value || '').trim().toLowerCase();
}

function getActiveColorFilters() {
  return [...document.querySelectorAll('.color-filter-btn.active')].map(b => b.dataset.color);
}

function emblemMatchesPoolFilters(em, q, activeColors) {
  const name = (em.n || '').toLowerCase();
  if (q && !name.includes(q)) return false;
  if (activeColors.length && !(em.c || []).some(c => activeColors.includes(c))) return false;
  return true;
}

function onPoolSearchInput() {
  renderPool();
  updatePoolCount();
}

function renderPool() {
  const q = getPoolSearchQuery();
  const activeColors = getActiveColorFilters();
  const el = document.getElementById('emblemPool');
  const scrollTop = el.scrollTop;
  el.innerHTML = '';
  EMBLEMS.forEach((em, i) => {
    if (!em.g || !Object.keys(em.g).length) return;
    const hidden = !emblemMatchesPoolFilters(em, q, activeColors);
    const colors = (em.c || []).map(c => `<span class="color-dot c-${c}" title="${c}"></span>`).join('');
    const div = document.createElement('div');
    div.className = 'pool-item' + (hidden ? ' pool-item-hidden' : '');
    div.dataset.idx = String(i);
    const iconGrade = poolIconGrade(i);
    div.innerHTML = `
      <input class="form-check-input pool-cb me-1" type="checkbox" data-idx="${i}" id="p${i}">
      ${emblemIconHtml(em, iconGrade)}
      <label class="form-check-label pool-name flex-grow-1 mb-0" for="p${i}">${em.n} ${colors}</label>
      <span class="grade-toggles">${gradeButtonsHtml(i)}</span>`;
    el.appendChild(div);
    div.querySelector('.pool-cb').checked = poolSelected.has(i);
    div.querySelector('.pool-cb').onchange = e => {
      if (e.target.checked) {
        poolSelected.add(i);
        if (getOwnedSet(i).size === 0) defaultOwnedForEmblem(i);
      } else poolSelected.delete(i);
      syncPoolItemStates();
      updatePoolCount();
    };
    div.querySelectorAll('.grade-btn.available').forEach(btn => {
      btn.onclick = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!poolSelected.has(i)) {
          poolSelected.add(i);
          div.querySelector('.pool-cb').checked = true;
        }
        const grade = btn.dataset.grade;
        setOwnedGrade(i, grade, !getOwnedSet(i).has(grade));
        btn.classList.toggle('owned', getOwnedSet(i).has(grade));
        const img = div.querySelector('.emblem-icon');
        if (img && getOwnedSet(i).has(grade)) {
          const url = emblemIconUrl(em, grade);
          if (url) { img.src = url; img.classList.remove('icon-missing'); }
        }
        syncPoolItemStates();
        updatePoolCount();
      };
    });
  });
  syncPoolItemStates();
  el.scrollTop = scrollTop;
}

function syncPoolItemStates() {
  document.querySelectorAll('.pool-item').forEach(item => {
    const i = +item.dataset.idx;
    const inPool = poolSelected.has(i);
    const cb = item.querySelector('.pool-cb');
    if (cb) cb.checked = inPool;
    item.classList.toggle('disabled-pool', !inPool);
    const owned = getOwnedSet(i);
    item.querySelectorAll('.grade-btn.available').forEach(btn => {
      btn.classList.toggle('owned', inPool && owned.has(btn.dataset.grade));
      btn.style.pointerEvents = inPool ? '' : 'none';
      btn.style.opacity = inPool ? '' : '0.35';
    });
  });
}

function bulkSetVisibleGrades(grade, enable) {
  document.querySelectorAll('.pool-item:not(.pool-item-hidden)').forEach(item => {
    const i = +item.dataset.idx;
    if (!poolSelected.has(i) && enable) {
      poolSelected.add(i);
    }
    const avail = emblemGradesAvailable(i);
    if (grade === 'all') {
      avail.forEach(g => setOwnedGrade(i, g, enable));
    } else if (avail.includes(grade)) {
      setOwnedGrade(i, grade, enable);
    }
  });
  renderPool();
  updatePoolCount();
}

function setPoolVisible(on) {
  document.querySelectorAll('.pool-item:not(.pool-item-hidden)').forEach(item => {
    const i = +item.dataset.idx;
    if (on) {
      poolSelected.add(i);
      if (getOwnedSet(i).size === 0) defaultOwnedForEmblem(i);
    } else poolSelected.delete(i);
  });
  syncPoolItemStates();
  updatePoolCount();
}

function getSearchPoolStats() {
  const maxIdx = GRADE_ORDER.indexOf(getMaxGrade());
  const mixed = document.getElementById('mixedGrades')?.checked ?? true;
  let variants = 0;
  const perTier = { bronze: 0, silver: 0, gold: 0 };
  poolSelected.forEach(i => {
    const owned = getOwnedSet(i);
    GRADE_ORDER.forEach((g, gi) => {
      if (gi > maxIdx || !EMBLEMS[i]?.g?.[g] || !owned.has(g)) return;
      perTier[g]++;
      variants++;
    });
  });
  const viableTiers = GRADE_ORDER.filter(g => perTier[g] >= 10);
  return { mixed, variants, perTier, viableTiers, poolSize: poolSelected.size };
}

function updatePoolCount() {
  const q = getPoolSearchQuery();
  const activeColors = getActiveColorFilters();
  const filtering = !!(q || activeColors.length);
  const visible = filtering
    ? EMBLEMS.filter(e => e.g && Object.keys(e.g).length && emblemMatchesPoolFilters(e, q, activeColors)).length
    : EMBLEMS.filter(e => e.g && Object.keys(e.g).length).length;
  const stats = getSearchPoolStats();
  let text;
  if (stats.mixed) {
    text = `${stats.poolSize} Pokémon · ${stats.variants} grade options (B/S/G can mix)`;
  } else {
    const tierParts = GRADE_ORDER.map(g => `${GRADE_SHORT[g]}:${stats.perTier[g]}`).join(' ');
    const ok = stats.viableTiers.map(g => GRADE_SHORT[g]).join('/') || '—';
    text = `${stats.poolSize} Pokémon · single tier · ${tierParts} · viable: ${ok}`;
  }
  if (filtering) text = `${visible} shown · ${text}`;
  document.getElementById('poolCount').textContent = text;
  updateColorBonusReach();
  updateColorTargetSummary();
}

document.addEventListener('click', e => {
  if (e.target.classList.contains('color-filter-btn')) {
    e.target.classList.toggle('active');
    onPoolSearchInput();
  }
});

function getMaxGrade() {
  return document.querySelector('input[name=maxGrade]:checked').value;
}

function buildCandidatesMixed() {
  const maxIdx = GRADE_ORDER.indexOf(getMaxGrade());
  const list = [];
  poolSelected.forEach(emIdx => {
    const em = EMBLEMS[emIdx];
    if (!em?.g) return;
    const grades = [...getOwnedSet(emIdx)].filter(g => em.g[g] && GRADE_ORDER.indexOf(g) <= maxIdx);
    grades.forEach(grade => {
      list.push({
        emIdx, name: em.n, grade,
        colors: em.c || [],
        stats: { ...em.g[grade] },
      });
    });
  });
  return list;
}

function buildCandidatesForTier(tier) {
  const maxIdx = GRADE_ORDER.indexOf(getMaxGrade());
  const tierIdx = GRADE_ORDER.indexOf(tier);
  if (tierIdx > maxIdx) return [];
  const list = [];
  poolSelected.forEach(emIdx => {
    const em = EMBLEMS[emIdx];
    if (!em?.g?.[tier] || !getOwnedSet(emIdx).has(tier)) return;
    list.push({
      emIdx, name: em.n, grade: tier,
      colors: em.c || [],
      stats: { ...em.g[tier] },
    });
  });
  return list;
}

function buildCandidates() {
  const mixed = document.getElementById('mixedGrades')?.checked ?? true;
  return mixed ? buildCandidatesMixed() : null;
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

function countColors(loadout) {
  const c = {};
  loadout.forEach(item => {
    item.colors.forEach(col => { c[col] = (c[col] || 0) + 1; });
  });
  return c;
}

function getColorTargets() {
  if (!document.getElementById('useColorTargets').checked) return null;
  const targets = {};
  let sum = 0;
  document.querySelectorAll('.color-target-use:checked').forEach(cb => {
    const color = cb.dataset.color;
    const raw = document.querySelector(`.color-target-val[data-color="${color}"]`)?.value;
    const val = parseInt(raw, 10);
    if (!isNaN(val) && val >= 0) {
      targets[color] = val;
      sum += val;
    }
  });
  if (!Object.keys(targets).length) return null;
  return { targets, sum };
}

function binomBig(n, k) {
  if (k < 0 || k > n) return 0n;
  k = Math.min(k, n - k);
  let r = 1n;
  for (let i = 1; i <= k; i++) r = (r * BigInt(n - k + i)) / BigInt(i);
  return r;
}

function formatBuildCount(n) {
  if (n < 1000000000000000n) return Number(n).toLocaleString();
  const s = n.toString();
  return `${s[0]}.${s.slice(1, 3)}\u00d710^${s.length - 1}`;
}

const SLOTS_FIXED = 10;

// Per-color capacity = number of UNIQUE Pokémon names in `pool` carrying that
// color. Colors are grade-independent, so this is the max count of that color
// any 10-slot build from the pool can reach (further bounded by 10 slots).
// Shared by the UI feasibility readouts (#1) and the maximize-with-bonuses DP,
// and used to losslessly bound color enumeration (a color can never exceed its
// capacity, nor 10).
function colorCapacityFromPool(pool) {
  const seen = new Set();
  const cap = new Map();
  for (const c of pool) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    (c.colors || []).forEach(col => cap.set(col, (cap.get(col) || 0) + 1));
  }
  return cap;
}

// For each bonus color, which COLOR_THRESHOLDS tiers are reachable given the
// pool's capacity (and the 10-slot ceiling). Returns
// { color: { cap, reach, tiers:[bool,bool,bool], topReachable, topTier } }.
function bonusTierReachability(capMap) {
  const out = {};
  Object.keys(COLOR_THRESHOLDS).forEach(color => {
    const th = COLOR_THRESHOLDS[color];
    const cap = capMap.get(color) || 0;
    const reach = Math.min(cap, SLOTS_FIXED);
    const tiers = th.map(t => reach >= t);
    let topTier = -1;
    for (let i = tiers.length - 1; i >= 0; i--) { if (tiers[i]) { topTier = i; break; } }
    out[color] = { cap, reach, tiers, topTier, topReachable: tiers[tiers.length - 1] };
  });
  return out;
}

// Pool-keyed memoization of the color capacity / reachability table. Recomputes
// only when the owned-pool selection (names with a usable grade) changes.
let _poolColorCache = { key: '', info: null };
function poolColorKey() {
  const maxIdx = GRADE_ORDER.indexOf(getMaxGrade());
  const ids = [];
  poolSelected.forEach(i => {
    const em = EMBLEMS[i];
    if (!em?.g) return;
    const usable = [...getOwnedSet(i)].some(g => em.g[g] && GRADE_ORDER.indexOf(g) <= maxIdx);
    if (usable) ids.push(i);
  });
  return ids.sort((a, b) => a - b).join(',') + '|' + maxIdx;
}
function getPoolColorInfo() {
  const key = poolColorKey();
  if (_poolColorCache.key === key && _poolColorCache.info) return _poolColorCache.info;
  const capMap = colorCapacityFromPool(buildCandidatesMixed());
  const info = { capMap, reach: bonusTierReachability(capMap) };
  _poolColorCache = { key, info };
  return info;
}

// #1(a): instant feasibility messaging for color-set bonuses, shown near the
// color-bonus toggle. Names colors whose higher bonus tiers your pool can't
// reach (e.g. "blue tier 3 needs 6, pool has 4"). DATASET.colorCapacity gives
// the absolute dataset ceiling for context.
function updateColorBonusReach() {
  const el = document.getElementById('colorBonusReach');
  if (!el) return;
  if (!document.getElementById('colorBonuses')?.checked) { el.textContent = ''; return; }
  const { reach } = getPoolColorInfo();
  const blocked = [];
  Object.keys(COLOR_THRESHOLDS).forEach(color => {
    const r = reach[color];
    if (r.cap <= 0) return;                 // color absent from pool — skip
    if ((COLOR_BONUS[color]?.[0] || 0) < 0) return; // avoid-colors: not a goal
    const th = COLOR_THRESHOLDS[color];
    if (!r.topReachable) {
      const nextTierIdx = r.topTier + 1;    // first unreachable tier
      const dsCap = (DATASET.colorCapacity && DATASET.colorCapacity[color]) || 0;
      const ceil = dsCap > r.cap ? ` (dataset max ${dsCap})` : '';
      blocked.push(`${color} tier ${nextTierIdx + 1} needs ${th[nextTierIdx]}, pool has ${r.cap}${ceil}`);
    }
  });
  if (!blocked.length) {
    el.className = 'small text-secondary mt-1';
    el.textContent = 'Color-set bonus tiers: all reachable for colors in your pool.';
  } else {
    el.className = 'small text-warning mt-1';
    el.textContent = "Can't reach: " + blocked.join('; ') + '.';
  }
}

// Group the pool's unique Pokémon (by name) by their checked-color signature.
// Colors are a property of the Pokémon (not its grade), so the color feasibility
// of a build depends only on which Pokémon names are selected, not their grades.
// Returns an array of { vec, names } where vec[j] is 1 if the group carries the
// j-th checked color.
function colorTargetGroups(pool, checked) {
  const byName = new Map();
  pool.forEach(c => {
    if (!byName.has(c.name)) byName.set(c.name, c.colors || []);
  });
  const groups = new Map();
  byName.forEach((colors, name) => {
    const vec = checked.map(col => (colors.includes(col) ? 1 : 0));
    const key = vec.join(',');
    const g = groups.get(key) || { vec, names: [] };
    g.names.push(name);
    groups.set(key, g);
  });
  return [...groups.values()];
}

// Count distinct sets of 10 unique Pokémon from the given pool whose color
// counts exactly match the checked color targets. Unchecked colors are free.
// Returns a BigInt, or null when the state space is too large to count quickly.
// `pool` defaults to the full mixed-grade candidate list (used by the UI summary).
function countColorTargetBuilds(colorTargets, pool) {
  const SLOTS = 10;
  const checked = Object.keys(colorTargets.targets);
  if (!checked.length || colorTargets.sum > 2 * SLOTS) return 0n;
  const targetVec = checked.map(col => colorTargets.targets[col]);
  if (targetVec.some(t => t > SLOTS)) return 0n;
  const groups = colorTargetGroups(pool || buildCandidatesMixed(), checked);
  let dp = new Map([['0|' + targetVec.map(() => 0).join(','), 1n]]);
  const MAX_STATES = 300000;
  for (const g of groups) {
    const count = g.names.length;
    const binos = [];
    for (let x = 0; x <= count; x++) binos.push(binomBig(count, x));
    const ndp = new Map();
    for (const [key, ways] of dp) {
      const bar = key.indexOf('|');
      const slots = +key.slice(0, bar);
      const counts = key.slice(bar + 1).split(',').map(Number);
      for (let x = 0; x <= count; x++) {
        const ns = slots + x;
        if (ns > SLOTS) break;
        let ok = true;
        const nc = counts.slice();
        for (let j = 0; j < nc.length; j++) {
          nc[j] += x * g.vec[j];
          if (nc[j] > targetVec[j]) { ok = false; break; }
        }
        if (!ok) break;
        const nk = ns + '|' + nc.join(',');
        ndp.set(nk, (ndp.get(nk) || 0n) + ways * binos[x]);
      }
    }
    if (ndp.size > MAX_STATES) return null;
    dp = ndp;
  }
  return dp.get(SLOTS + '|' + targetVec.join(',')) || 0n;
}

// Count the distinct color PATTERNS (group-pick-count vectors k_g) that satisfy
// the targets — i.e. how many builds the lossless maximize "collapse" actually
// evaluates (one best build per pattern). Same DP as the build counter but with
// weight 1 per group choice instead of C(n_g, x), so it counts k-vectors, not
// name-combinations. Returns a BigInt, or null if the state space is too large.
function countColorPatterns(colorTargets, pool) {
  const SLOTS = 10;
  const checked = Object.keys(colorTargets.targets);
  if (!checked.length || colorTargets.sum > 2 * SLOTS) return 0n;
  const targetVec = checked.map(col => colorTargets.targets[col]);
  if (targetVec.some(t => t > SLOTS)) return 0n;
  const groups = colorTargetGroups(pool || buildCandidatesMixed(), checked);
  let dp = new Map([['0|' + targetVec.map(() => 0).join(','), 1n]]);
  const MAX_STATES = 300000;
  for (const g of groups) {
    const count = g.names.length;
    const ndp = new Map();
    for (const [key, ways] of dp) {
      const bar = key.indexOf('|');
      const slots = +key.slice(0, bar);
      const counts = key.slice(bar + 1).split(',').map(Number);
      for (let x = 0; x <= count; x++) {
        const ns = slots + x;
        if (ns > SLOTS) break;
        let ok = true;
        const nc = counts.slice();
        for (let j = 0; j < nc.length; j++) {
          nc[j] += x * g.vec[j];
          if (nc[j] > targetVec[j]) { ok = false; break; }
        }
        if (!ok) break;
        const nk = ns + '|' + nc.join(',');
        ndp.set(nk, (ndp.get(nk) || 0n) + ways);
      }
    }
    if (ndp.size > MAX_STATES) return null;
    dp = ndp;
  }
  return dp.get(SLOTS + '|' + targetVec.join(',')) || 0n;
}

// Caps on how many color-feasible builds we will exhaustively enumerate.
// Each enumerated build costs ~1 evaluate() in the cheap path (single grade per
// name, e.g. single-tier mode or a linear maximize objective), so we allow a
// large cap there. When per-build grade optimization is needed (mixed grades in
// target mode, or maximize with protected stat floors), each build also runs a
// short grade coordinate-ascent (~tens of extra evaluate() calls), so the cap is
// lower to stay responsive in-browser (sub-second to a couple of seconds).
// Exact color-constrained search caps (max color-feasible builds we enumerate).
// COLOR_EXACT_CAP: cheap path — 1 evaluate() per build (maximize w/o polish, or
// the collapsed pattern path). Now that the general enumeration is sharded
// across the worker pool (searchColorExactParallel), throughput is multiplied by
// the core count, so we allow a much higher ceiling (200M). Both values stay
// well within Number-safe integer range (< 2^53), which the parallel unranking
// relies on.
// COLOR_EXACT_CAP_POLISH: the grade-polish path (target mode / protect floor)
// re-optimizes grades per build, so each build is much heavier — kept at ~1/4
// of the cheap cap so worst-case wall-time stays comparable to the cheap path.
const COLOR_EXACT_CAP = 1000000000;
const COLOR_EXACT_CAP_POLISH = 250000000;

// Parallelize the general (non-collapse) exact enumeration across the worker
// pool only when the feasible build count is large enough that the fixed
// worker spin-up + pool/opts serialization overhead (a few ms) is amortized.
// Below this, the main-thread enumerator is faster (no message round-trips).
const COLOR_EXACT_PARALLEL_MIN = 50000;

// Shared Phase 0 (backward feasibility) + Phase 1 (valid k-vector enumeration)
// for the color-exact space. Pure given groups/sizes/targetVec/slots. Used by
// BOTH the main-thread enumerator (searchColorExactExhaustive) and the parallel
// splitter (searchColorExactParallel) so they enumerate the identical space.
// Returns the list of valid group-pick-count vectors, or null when the number
// of distinct color patterns exceeds COLOR_EXACT_CAP (caller falls back).
async function enumerateColorKVectors(groups, sizes, targetVec, slots, progress) {
  const G = groups.length;
  const nColors = targetVec.length;
  const zeros = targetVec.map(() => 0);

  const goalKey = slots + '|' + targetVec.join(',');
  const feasible = new Array(G + 1);
  feasible[G] = new Set([goalKey]);
  for (let gi = G - 1; gi >= 0; gi--) {
    const g = groups[gi];
    const cur = new Set();
    for (const key of feasible[gi + 1]) {
      const bar = key.indexOf('|');
      const su = +key.slice(0, bar);
      const counts = key.slice(bar + 1).split(',').map(Number);
      for (let x = 0; x <= sizes[gi]; x++) {
        const ps = su - x;
        if (ps < 0) break;
        const pc = counts.slice();
        let ok = true;
        for (let j = 0; j < nColors; j++) { pc[j] -= x * g.vec[j]; if (pc[j] < 0) { ok = false; break; } }
        if (!ok) break;
        cur.add(ps + '|' + pc.join(','));
      }
    }
    feasible[gi] = cur;
  }

  const kVectors = [];
  if (feasible[0].has('0|' + zeros.join(','))) {
    const stack = [{ gi: 0, su: 0, counts: zeros, k: [] }];
    let frames = 0;
    let pSlice = Date.now() + 40;
    while (stack.length) {
      if (((++frames) & 8191) === 0 || Date.now() >= pSlice) {
        checkSearchCancelled();
        if (progress) await progress(2, 'Exact search · mapping color patterns…');
        await yieldToBrowser();
        pSlice = Date.now() + 40;
      }
      const fr = stack.pop();
      if (fr.gi === G) {
        kVectors.push(fr.k);
        if (kVectors.length > COLOR_EXACT_CAP) return null;
        continue;
      }
      const g = groups[fr.gi];
      for (let x = 0; x <= sizes[fr.gi]; x++) {
        const ns = fr.su + x;
        if (ns > slots) break;
        const nc = fr.counts.slice();
        let ok = true;
        for (let j = 0; j < nColors; j++) { nc[j] += x * g.vec[j]; if (nc[j] > targetVec[j]) { ok = false; break; } }
        if (!ok) break;
        if (!feasible[fr.gi + 1].has(ns + '|' + nc.join(','))) continue;
        stack.push({ gi: fr.gi + 1, su: ns, counts: nc, k: fr.k.concat(x) });
      }
    }
  }
  return kVectors;
}

// Parallel EXACT color-constrained search (general non-collapse path only).
// Strategy (b): globally index the feasible space [0, totalCombos) — kVector j
// owns a contiguous block of size W_j = prod_g C(n_g, k_j[g]); prefix sums give
// each kVector's offset. We hand each worker a balanced contiguous slice
// [start, end); the worker UNRANKS its start into a (kVector, per-group
// combination) odometer state (lexicographic combinadic) and enumerates forward
// exactly (end-start) builds, crossing kVector boundaries. This yields perfectly
// even load (every shard scores the same number of builds, including splitting a
// single huge pattern across workers) and, because the global order matches the
// single-thread enumeration, the union of slices is EXACTLY the single-thread
// sequence — verified to 0 mismatches. Each shard returns its slice's best; the
// main thread reduces them with isLoadoutBetter for the guaranteed optimum.
// Returns null (→ caller runs the main-thread enumerator) when not worth
// parallelizing, the pool is unavailable, or patterns exceed COLOR_EXACT_CAP.
async function searchColorExactParallel(pool, opts, slots, totalCombos, progress) {
  if (typeof Worker === 'undefined') return null;
  const workers = getSearchWorkerPool();
  if (!workers || workers.length < 2) return null;
  const shards = workers.length;

  const colorTargets = opts.colorTargets;
  if (!colorTargets) return null;
  const checked = Object.keys(colorTargets.targets);
  if (!checked.length) return null;
  const targetVec = checked.map(col => colorTargets.targets[col]);

  const groups = colorTargetGroups(pool, checked);
  const sizes = groups.map(g => g.names.length);
  const kVectors = await enumerateColorKVectors(groups, sizes, targetVec, slots, progress);
  if (kVectors === null || !kVectors.length) return null;

  // Per-pattern weights + prefix sums. The gated path keeps total <= cap (<= 5M),
  // so every W_j and prefix value is a safe integer (Number(binomBig) is exact).
  const kPrefix = [0];
  for (const k of kVectors) {
    let w = 1;
    for (let gi = 0; gi < groups.length; gi++) w *= Number(binomBig(sizes[gi], k[gi]));
    kPrefix.push(kPrefix[kPrefix.length - 1] + w);
  }
  const total = kPrefix[kPrefix.length - 1];
  if (total < COLOR_EXACT_PARALLEL_MIN) return null; // not worth worker overhead

  const ser = (list) => list.map(c => ({
    emIdx: c.emIdx, name: c.name, grade: c.grade,
    colors: c.colors || [], stats: { ...c.stats },
  }));
  const serPool = ser(pool);
  const serGroups = groups.map(g => ({ vec: g.vec, names: g.names }));
  const statsLite = STATS.map(s => ({ id: s.id, scale: s.scale }));
  const jobId = Date.now();
  searchCancelToken.workerId = jobId;

  // Balanced contiguous slices over [0, total).
  const base = Math.floor(total / shards);
  const bounds = [];
  let acc = 0;
  for (let i = 0; i < shards; i++) {
    const start = acc;
    const end = (i === shards - 1) ? total : Math.min(total, acc + base);
    acc = end;
    bounds.push([start, end]);
  }

  const makePayload = (idx) => ({
    type: 'runExactRange',
    id: jobId,
    shardIndex: idx,
    pool: serPool,
    opts,
    slots,
    groups: serGroups,
    kVectors,
    kPrefix,
    start: bounds[idx][0],
    end: bounds[idx][1],
    total,
    stats: statsLite,
    colorThresholds: COLOR_THRESHOLDS,
    colorBonus: COLOR_BONUS,
    colorBonusStat: COLOR_BONUS_STAT,
  });

  const sliceSizes = bounds.map(b => b[1] - b[0]);

  return new Promise((resolve, reject) => {
    // Per-shard evaluated count; the displayed counter is the SUM across shards
    // so it climbs toward the true global total (not a single shard's slice).
    const shardEval = new Array(shards).fill(0);
    const results = new Array(shards).fill(null);
    const listeners = new Array(shards).fill(null);
    const doneFlags = new Array(shards).fill(false);
    let doneCount = 0;
    let cancelledCount = 0;
    let resolved = false;

    const removeAll = () => {
      workers.forEach((w, i) => {
        if (listeners[i]) { w.removeEventListener('message', listeners[i]); listeners[i] = null; }
      });
    };
    const emitProgress = () => {
      let sum = 0;
      for (const e of shardEval) sum += e;
      sum = Math.min(sum, total);
      const overall = 3 + Math.min(96, (sum / Math.max(1, total)) * 96);
      if (searchCancelToken) searchCancelToken.lastPct = overall;
      if (progress) progress(overall, `Exact search · ${sum.toLocaleString()} / ${total.toLocaleString()} builds`);
    };

    // Every shard owns a DISJOINT slice, so the global optimum needs ALL shards
    // — there is no early-terminal short-circuit here (unlike the heuristic pool).
    const merge = () => {
      const valid = results.filter(r => r && !r.cancelled && r.loadout && r.loadout.length);
      if (!valid.length) {
        if (cancelledCount > 0) { reject(new OptimizeCancelled()); return; }
        resolve(null);
        return;
      }
      let best = valid[0];
      for (const r of valid) {
        if (r !== best && isLoadoutBetter(r.ev, best.ev, r.loadout, best.loadout, opts)) best = r;
      }
      // All shards finished with a valid result → drive the bar to a full 100%.
      // emitProgress() reserves the last 1% for completion (caps in-progress at
      // 99), so without this the bar would visibly stall at 99% until the run
      // tears down. Only fires on success — cancel/reject paths never force 100%.
      if (progress) progress(100, 'Exact search complete');
      resolve({ loadout: best.loadout, ev: best.ev });
    };

    const finalize = () => {
      if (resolved) return;
      resolved = true;
      removeAll();
      workers.forEach((w, i) => {
        if (!doneFlags[i]) { try { w.postMessage({ type: 'cancel', id: jobId }); } catch (e) {} }
      });
      if (searchCancelToken) searchCancelToken.rejectWorker = null;
      merge();
    };

    if (searchCancelToken) {
      searchCancelToken.rejectWorker = () => {
        if (resolved) return;
        resolved = true;
        removeAll();
        workers.forEach(w => { try { w.postMessage({ type: 'cancel', id: jobId }); } catch (e) {} });
        terminateSearchWorkerPool();
        reject(new OptimizeCancelled());
      };
    }

    workers.forEach((worker, idx) => {
      const onMsg = (ev) => {
        const d = ev.data;
        if (d.jobId !== jobId || d.shardIndex !== idx) return;
        if (d.type === 'progress') {
          shardEval[idx] = d.evaluated || 0;
          emitProgress();
        } else if (d.type === 'done') {
          worker.removeEventListener('message', onMsg);
          listeners[idx] = null;
          doneFlags[idx] = true;
          doneCount++;
          if (d.cancelled) cancelledCount++;
          else if (d.result) results[idx] = d.result;
          // A finished shard fully evaluated its slice — count it in full so the
          // aggregate counter reaches the true total as shards complete.
          if (!d.cancelled) shardEval[idx] = sliceSizes[idx];
          emitProgress();
          if (doneCount === shards) finalize();
        } else if (d.type === 'error') {
          worker.removeEventListener('message', onMsg);
          listeners[idx] = null;
          doneFlags[idx] = true;
          if (!resolved) {
            resolved = true;
            removeAll();
            terminateSearchWorkerPool();
            if (searchCancelToken) searchCancelToken.rejectWorker = null;
            reject(new Error(d.message || 'Exact shard failed'));
          }
        }
      };
      listeners[idx] = onMsg;
      worker.addEventListener('message', onMsg);
      worker.postMessage(makePayload(idx));
    });
  });
}

// Exhaustive optimizer for the color-constrained search space. Enumerates EVERY
// set of `slots` unique Pokémon whose checked-color counts exactly match the
// targets, scores each with evaluate(), and returns the best loadout — i.e. the
// guaranteed optimum over the color-feasible space. Grade handling: colors are
// grade-independent, so we enumerate name-sets and choose a grade per Pokémon:
//   - single grade per name (single-tier mode): nothing to choose, exact.
//   - maximize objective: pick the grade with the best per-emblem greedy value
//     (exact for the linear objective; refined by coordinate-ascent when stat
//     floors are protected).
//   - target objective (mixed grades): seed with the grade closest to the
//     per-slot target, then run grade-only coordinate ascent (a strong local
//     optimum per name-set; the name-set enumeration itself is exhaustive).
// Cooperative with the async progress/cancellation machinery.
async function searchColorExactExhaustive(pool, opts, slots, totalCombos, progress) {
  const colorTargets = opts.colorTargets;
  if (!colorTargets) return null;
  const checked = Object.keys(colorTargets.targets);
  if (!checked.length) return null;
  const targetVec = checked.map(col => colorTargets.targets[col]);
  const nColors = targetVec.length;

  const variantsByName = new Map();
  pool.forEach(c => {
    if (!variantsByName.has(c.name)) variantsByName.set(c.name, []);
    variantsByName.get(c.name).push(c);
  });
  const multiVariant = [...variantsByName.values()].some(v => v.length > 1);
  const hasProtect = opts.mode === 'maximize' && opts.protected &&
    Object.keys(opts.protected).length > 0;
  const needsPolish = multiVariant && (opts.mode === 'target' || hasProtect);

  const perSlot = {};
  if (opts.mode === 'target') {
    STATS.forEach(s => { if (opts.targetActive[s.id]) perSlot[s.id] = opts.targets[s.id] / slots; });
  }

  function seedVariant(name) {
    const vs = variantsByName.get(name);
    if (vs.length === 1) return vs[0];
    if (opts.mode === 'maximize') {
      let best = vs[0], bv = candidateGreedyValue(vs[0], opts);
      for (let i = 1; i < vs.length; i++) {
        const v = candidateGreedyValue(vs[i], opts);
        if (v > bv) { bv = v; best = vs[i]; }
      }
      return best;
    }
    let best = vs[0], bd = Infinity;
    for (const c of vs) {
      let d = 0;
      for (const s of STATS) {
        if (opts.targetActive[s.id]) d += Math.abs((c.stats[s.id] || 0) - perSlot[s.id]);
      }
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  function gradePolish(loadout) {
    let best = loadout.slice();
    let bestEv = evaluate(best, opts.mode, opts);
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
          const ev = evaluate(trial, opts.mode, opts);
          if (isLoadoutBetter(ev, bestEv, trial, best, opts)) { best = trial; bestEv = ev; improved = true; }
        }
      }
    }
    return { loadout: best, ev: bestEv };
  }

  let best = { loadout: [], ev: { score: -1e12, error: Infinity } };
  let evaluated = 0;

  function evalNameSet(names) {
    const loadout = names.map(seedVariant);
    const res = needsPolish ? gradePolish(loadout) : { loadout, ev: evaluate(loadout, opts.mode, opts) };
    evaluated++;
    if (res.ev.valid && isLoadoutBetter(res.ev, best.ev, res.loadout, best.loadout, opts)) {
      best = { loadout: res.loadout.slice(), ev: res.ev };
    }
  }

  // ---- Iterative, recursion-free enumeration (closed-form decomposition) ----
  // The feasible builds are exactly: for every group-pick-count vector (k_g)
  // with sum_g k_g == slots and sum_g k_g*vec_g == targetVec (0 <= k_g <= n_g),
  // the Cartesian product over groups of "choose k_g names from names_g". The
  // total is sum_k prod_g C(n_g, k_g) — identical to countColorTargetBuilds.
  const groups = colorTargetGroups(pool, checked);
  const G = groups.length;
  const sizes = groups.map(g => g.names.length);

  // Phase 0 (backward feasibility) + Phase 1 (valid k-vector enumeration) are
  // shared with the parallel splitter so both partition the SAME space; see
  // enumerateColorKVectors. Returns null if patterns exceed COLOR_EXACT_CAP.
  const kVectors = await enumerateColorKVectors(groups, sizes, targetVec, slots, progress);
  if (kVectors === null) return null;

  // Within-group top-k collapse (provably lossless ONLY for a pure-linear
  // maximize objective): with no color-set bonuses and no protected stat floors,
  // the score is colorBonus(checked counts — constant per k-vector) plus a
  // separable per-emblem weighted sum. So for any fixed k-vector the optimal
  // build is exactly the top-k_g Pokémon (by per-emblem value) from each group.
  // We can then skip within-group combinations and evaluate ONE build per
  // k-vector instead of prod_g C(n_g, k_g) — the guaranteed optimum for that
  // color pattern. Any other objective (target mode, color bonuses on, or any
  // protected floor) is non-separable, so we keep the full enumeration.
  const collapse = opts.mode === 'maximize' && !opts.colorBonuses &&
    !(opts.protected && Object.keys(opts.protected).length > 0);
  let sortedNames = null;
  if (collapse) {
    const pval = new Map();
    for (const g of groups) for (const nm of g.names) pval.set(nm, candidateGreedyValue(seedVariant(nm), opts));
    sortedNames = groups.map(g => g.names.slice().sort((a, b) => pval.get(b) - pval.get(a)));
  }

  const workTotal = collapse ? Math.max(1, kVectors.length) : totalCombos;
  let sliceEnd = Date.now() + 40;
  const reportEvery = Math.max(1, Math.floor(workTotal / 50));
  let nextReport = reportEvery;

  async function maybeReport(label) {
    if (evaluated >= nextReport || Date.now() >= sliceEnd) {
      checkSearchCancelled();
      if (progress) {
        const pct = 3 + Math.min(96, (evaluated / Math.max(1, workTotal)) * 96);
        await progress(pct, label);
      }
      await yieldToBrowser();
      sliceEnd = Date.now() + 40;
      nextReport = evaluated + reportEvery;
    }
  }

  if (collapse) {
    for (const k of kVectors) {
      const names = [];
      for (let gi = 0; gi < G; gi++) {
        const kg = k[gi];
        for (let t = 0; t < kg; t++) names.push(sortedNames[gi][t]);
      }
      evalNameSet(names);
      if (evaluated > kVectors.length) return null; // hard safety bound
      await maybeReport(`Exact search · ${evaluated.toLocaleString()} / ${workTotal.toLocaleString()} color patterns`);
    }
    return best.loadout.length === slots ? best : null;
  }

  // General case: iterate every within-group name-combination via an index
  // odometer (iterative "next combination" + mixed-radix carry across groups).
  function resetCombo(idx, k) { for (let i = 0; i < k; i++) idx[i] = i; }
  function nextCombo(idx, k, n) {
    if (k === 0) return false;
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return false;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    return true;
  }

  for (const k of kVectors) {
    const idxs = k.map((kg) => { const a = new Array(kg); for (let i = 0; i < kg; i++) a[i] = i; return a; });
    while (true) {
      const names = [];
      for (let gi = 0; gi < G; gi++) {
        const kg = k[gi];
        if (!kg) continue;
        const idx = idxs[gi];
        const gnames = groups[gi].names;
        for (let t = 0; t < kg; t++) names.push(gnames[idx[t]]);
      }
      evalNameSet(names);

      // Hard safety bound: enumeration must never exceed the closed-form count.
      if (evaluated > totalCombos) return null;
      await maybeReport(`Exact search · ${evaluated.toLocaleString()} / ${totalCombos.toLocaleString()} builds`);

      let carry = true;
      for (let gi = G - 1; gi >= 0 && carry; gi--) {
        if (nextCombo(idxs[gi], k[gi], sizes[gi])) carry = false;
        else resetCombo(idxs[gi], k[gi]);
      }
      if (carry) break;
    }
  }

  return best.loadout.length === slots ? best : null;
}

// Max reachable per-color-count DP states before we abandon the optimal solver
// and let the heuristic take over. (Independent of COLOR_EXACT_CAP.)
const COLOR_BONUS_DP_MAX_STATES = 250000;

// Provably-optimal solver for MAXIMIZE mode with color-set bonuses ON and NO
// protected floor. The objective is colorBonus(counts) — a step/threshold
// function of the per-color count vector — plus a SEPARABLE per-emblem linear
// value (priority weighted stat sum). We DP over the reachable per-color count
// vector (each color capped at its top bonus threshold, or pinned to an exact
// color target when checked), carrying the best linear value to reach each
// state; at slots == 10 the color bonus becomes a constant function of the
// state, so we add it and keep the max. Colors are grade-independent, so within
// a color-signature group we take the top-x names by best-grade value (prefix
// sums). The optimal DP path is reconstructed into a real 10-name loadout and
// scored with evaluate() for shape-identical results. Returns null (→ fall back
// to the existing search) when not applicable or the state space is too large.
async function searchMaximizeColorBonusDP(pool, opts, slots, progress) {
  if (opts.mode !== 'maximize' || !opts.colorBonuses) return null;
  if (opts.protected && Object.keys(opts.protected).length > 0) return null;

  const ct = opts.colorTargets;
  // Names per color (unique) — shared with the UI capacity table (#1). Used to
  // drop colors that can never reach a tier and to cap each color dimension
  // losslessly (a color can never exceed its capacity nor 10 slots).
  const namesWithColor = colorCapacityFromPool(pool);

  // Tracked colors: checked color-target colors (hard constraint) plus any bonus
  // color that can actually reach its first threshold (else its bonus is always
  // 0 and tracking it is pointless — and lossless to omit).
  const colors = [];
  namesWithColor.forEach((nWith, col) => {
    const th = COLOR_THRESHOLDS[col];
    if (!th) return;
    const checked = ct && ct.targets[col] !== undefined;
    if (checked || nWith >= th[0]) colors.push(col);
  });
  if (ct) Object.keys(ct.targets).forEach(col => { if (!colors.includes(col)) colors.push(col); });
  const D = colors.length;
  const colIndex = new Map(colors.map((c, i) => [c, i]));

  const checkedTarget = new Array(D).fill(-1);
  const cap = new Array(D);
  const radix = new Array(D);
  let radixProduct = slots + 1;
  for (let d = 0; d < D; d++) {
    const col = colors[d];
    const th = COLOR_THRESHOLDS[col];
    const top = th[th.length - 1];
    const nWith = namesWithColor.get(col) || 0;
    if (ct && ct.targets[col] !== undefined) {
      checkedTarget[d] = ct.targets[col];
      cap[d] = ct.targets[col];
    } else {
      cap[d] = Math.min(top, nWith);
    }
    radix[d] = cap[d] + 1;
    radixProduct *= radix[d];
    if (radixProduct > 9e15) return null; // numeric key space beyond safe range
  }

  // Best-grade variant per name (no protect in scope ⇒ best per-emblem value).
  const variantsByName = new Map();
  pool.forEach(c => {
    if (!variantsByName.has(c.name)) variantsByName.set(c.name, []);
    variantsByName.get(c.name).push(c);
  });
  function bestVariant(name) {
    const vs = variantsByName.get(name);
    let b = vs[0], bv = candidateGreedyValue(vs[0], opts);
    for (let i = 1; i < vs.length; i++) {
      const v = candidateGreedyValue(vs[i], opts);
      if (v > bv) { bv = v; b = vs[i]; }
    }
    return { cand: b, val: bv };
  }

  // Group names by tracked-color signature; sort desc by value; prefix sums.
  const groupMap = new Map();
  for (const name of variantsByName.keys()) {
    const bv = bestVariant(name);
    const sig = new Array(D).fill(0);
    (bv.cand.colors || []).forEach(col => { const i = colIndex.get(col); if (i !== undefined) sig[i] = 1; });
    const key = sig.join('');
    let g = groupMap.get(key);
    if (!g) { g = { sig, items: [] }; groupMap.set(key, g); }
    g.items.push(bv);
  }
  const groups = [...groupMap.values()];
  groups.forEach(g => {
    g.items.sort((a, b) => b.val - a.val);
    g.prefix = [0];
    for (let i = 0; i < g.items.length; i++) g.prefix.push(g.prefix[i] + g.items[i].val);
    g.n = g.items.length;
  });
  const G = groups.length;

  function encode(slotsUsed, counts) {
    let key = slotsUsed;
    for (let d = 0; d < D; d++) key = key * radix[d] + counts[d];
    return key;
  }

  let layer = new Map();
  const startCounts = new Array(D).fill(0);
  layer.set(encode(0, startCounts), { val: 0, slots: 0, counts: startCounts, px: -1, x: 0 });
  const layers = [layer];

  let ySlice = Date.now() + 30;
  for (let gi = 0; gi < G; gi++) {
    const g = groups[gi];
    const ndp = new Map();
    for (const [pk, e] of layer) {
      const maxX = Math.min(g.n, slots - e.slots);
      for (let x = 0; x <= maxX; x++) {
        const nc = e.counts.slice();
        let ok = true;
        for (let d = 0; d < D; d++) {
          if (!g.sig[d]) continue;
          let v = nc[d] + x;
          if (checkedTarget[d] >= 0) {
            if (v > checkedTarget[d]) { ok = false; break; }
          } else if (v > cap[d]) {
            v = cap[d];
          }
          nc[d] = v;
        }
        if (!ok) break; // larger x only overflows a checked color further
        const ns = e.slots + x;
        const nval = e.val + g.prefix[x];
        const k = encode(ns, nc);
        const cur = ndp.get(k);
        if (!cur || nval > cur.val) ndp.set(k, { val: nval, slots: ns, counts: nc, px: pk, x });
      }
    }
    if (ndp.size > COLOR_BONUS_DP_MAX_STATES) return null;
    layers.push(ndp);
    layer = ndp;
    if (Date.now() >= ySlice) {
      checkSearchCancelled();
      if (progress) await progress(3 + (gi / Math.max(1, G)) * 90, 'Optimal search (color bonuses)…');
      await yieldToBrowser();
      ySlice = Date.now() + 30;
    }
  }
  checkSearchCancelled();

  let bestKey = -1, bestTotal = -Infinity, bestEntry = null;
  for (const [k, e] of layer) {
    if (e.slots !== slots) continue;
    let okc = true;
    for (let d = 0; d < D; d++) if (checkedTarget[d] >= 0 && e.counts[d] !== checkedTarget[d]) { okc = false; break; }
    if (!okc) continue;
    const cm = {};
    for (let d = 0; d < D; d++) cm[colors[d]] = e.counts[d];
    const total = e.val + colorBonusScore(cm, true).score;
    if (total > bestTotal) { bestTotal = total; bestKey = k; bestEntry = e; }
  }
  if (!bestEntry) return null;

  // Reconstruct the picks per group by walking the back-pointers.
  const xs = new Array(G).fill(0);
  let curKey = bestKey;
  for (let gi = G - 1; gi >= 0; gi--) {
    const e = layers[gi + 1].get(curKey);
    xs[gi] = e.x;
    curKey = e.px;
  }
  const loadout = [];
  for (let gi = 0; gi < G; gi++) {
    const g = groups[gi];
    for (let t = 0; t < xs[gi]; t++) loadout.push(g.items[t].cand);
  }
  if (loadout.length !== slots) return null;
  const ev = evaluate(loadout, opts.mode, opts);
  if (!ev.valid) return null;
  return { loadout, ev };
}

function updateColorTargetSummary() {
  const el = document.getElementById('colorTargetSummary');
  const bEl = document.getElementById('colorTargetBonuses');

  // Feature B: preview the color-set bonuses the entered counts WOULD yield.
  // Purely informational, so it is INDEPENDENT of the "Require exact color
  // counts" toggle. getColorTargets() returns null when that toggle is off, so
  // we read the checked colors + their count inputs directly here. Unchecked
  // colors are decided by the final build, so they can't be previewed.
  if (bEl) {
    const counts = {};
    document.querySelectorAll('.color-target-use:checked').forEach(cb => {
      const color = cb.dataset.color;
      const raw = document.querySelector(`.color-target-val[data-color="${color}"]`)?.value;
      const val = parseInt(raw, 10);
      if (!isNaN(val) && val > 0) counts[color] = val;
    });
    if (!Object.keys(counts).length) {
      bEl.textContent = '';
      bEl.className = 'small mt-1';
    } else {
      const proposed = colorBonusScore(counts, true);
      if (proposed.details.length) {
        const items = proposed.details.map(d => `${d.color} tier ${d.tier} → ${formatColorBonusValue(d.effect, d.value)}`);
        bEl.innerHTML = 'Proposed bonuses: ' + items.join(', ')
          + ' <span class="text-secondary">(unchecked colors depend on the final build)</span>';
        bEl.className = 'small text-info mt-1';
      } else {
        bEl.textContent = 'Proposed bonuses: none — these counts don’t reach a color tier.';
        bEl.className = 'small text-secondary mt-1';
      }
    }
  }

  const ct = getColorTargets();
  if (!document.getElementById('useColorTargets').checked) {
    el.textContent = 'Enable the switch above, then check colors and set counts (e.g. 6 brown, 6 white).';
    el.className = 'text-secondary mt-1';
    return;
  }
  if (!ct) {
    el.textContent = 'Check at least one color and set its target count.';
    el.className = 'text-warning mt-1';
    return;
  }
  const parts = Object.entries(ct.targets).map(([c, n]) => `${c}:${n}`);
  let msg = `Targets: ${parts.join(', ')} (${ct.sum} color points). Max 20 from 10 slots.`;
  let cls = 'text-secondary mt-1';
  if (ct.sum > 20) {
    cls = 'text-danger mt-1';
    msg += ' Too many — lower counts.';
  } else if (ct.sum > 10) {
    msg += ' Needs dual-color emblems.';
  }
  if (ct.sum <= 20) {
    const pool = buildCandidatesMixed();
    const builds = countColorTargetBuilds(ct, pool);
    const mode = document.getElementById('optMode')?.value;
    const bonuses = document.getElementById('colorBonuses')?.checked;
    const hasProtect = !!document.querySelector('.protect-stat:checked');
    // Mirrors canCollapse in optimizeAsync: pure-linear maximize is separable, so
    // the exact search evaluates just one build per color pattern (lossless).
    const collapse = mode === 'maximize' && !bonuses && !hasProtect;
    if (builds === null) {
      msg += ' Possible builds from your pool: too many to count.';
    } else if (builds === 0n) {
      cls = 'text-warning mt-1';
      msg += ' Possible builds from your pool: 0 (no combination of your pool hits these exact counts).';
    } else if (collapse) {
      const patterns = countColorPatterns(ct, pool);
      if (patterns === null || patterns > BigInt(COLOR_EXACT_CAP)) {
        msg += ` Possible builds: ${formatBuildCount(builds)}. Too many color patterns for exact search — uses fast heuristic search.`;
      } else {
        const one = patterns === 1n;
        msg += ` Maximize exact search evaluates ${formatBuildCount(patterns)} build${one ? '' : 's'} (best per color pattern, collapsed losslessly from ${formatBuildCount(builds)} combinations).`;
      }
    } else {
      msg += ` Possible builds from your pool: ${formatBuildCount(builds)}.`;
      if (mode === 'maximize' && hasProtect) {
        msg += ' Protect is a soft floor — it affects scoring, not the pool size.';
      } else if (mode === 'maximize' && bonuses) {
        msg += ' Color set bonuses affect scoring, not the feasible set.';
      }
    }
  }
  el.className = cls;
  el.textContent = msg;
}

function colorsMatchTargets(counts, colorTargets) {
  if (!colorTargets) return true;
  for (const [color, need] of Object.entries(colorTargets.targets)) {
    if ((counts[color] || 0) !== need) return false;
  }
  return true;
}

function validateColorTargets(colorTargets, candidates) {
  if (colorTargets.sum > 20) {
    return 'Color targets exceed 20 total points (max from 10 dual-color slots).';
  }
  const byName = new Map();
  candidates.forEach(c => {
    if (!byName.has(c.name)) byName.set(c.name, c.colors);
  });
  const maxByColor = {};
  byName.forEach(colors => {
    colors.forEach(col => { maxByColor[col] = (maxByColor[col] || 0) + 1; });
  });
  for (const [color, need] of Object.entries(colorTargets.targets)) {
    const max = maxByColor[color] || 0;
    if (max < need) {
      return `Cannot reach ${need}× ${color} — at most ${max} from your pool (unique Pokémon).`;
    }
    const slots = 10;
    const filler = slots - colorTargets.sum;
    if (filler > 0 && need <= slots) {
      let without = 0;
      byName.forEach(colors => {
        if (!colors.includes(color)) without++;
      });
      if (without < filler) {
        return `Need ${filler} Pokémon without ${color} to hit exactly ${need}× ${color}, but only ${without} in your pool.`;
      }
    }
  }
  return null;
}

// #2: lossless upfront rejection for target mode. Computes the per-stat
// achievable [min,max] total over 10 DISTINCT names, letting each name pick its
// best (max) / worst (min) grade independently. This is an admissible
// relaxation: the true feasible set is a SUBSET (the same 10 names must serve
// every stat and any color constraints at once), so a target outside [min,max]
// is provably impossible (safe to reject). Being inside does NOT prove
// feasibility, so it is never used to claim a target is reachable.
function targetReachabilityError(candidates, opts) {
  const slots = 10;
  const byName = new Map();
  for (const c of candidates) {
    let e = byName.get(c.name);
    if (!e) {
      e = {};
      STATS.forEach(s => { e[s.id] = { hi: -Infinity, lo: Infinity }; });
      byName.set(c.name, e);
    }
    for (const s of STATS) {
      const v = c.stats[s.id] || 0;
      if (v > e[s.id].hi) e[s.id].hi = v;
      if (v < e[s.id].lo) e[s.id].lo = v;
    }
  }
  if (byName.size < slots) return null; // not enough names — handled elsewhere
  const names = [...byName.values()];
  const fmt = (v) => {
    const r = Math.round(v * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    const tgt = opts.targets[s.id];
    const his = names.map(e => e[s.id].hi).sort((a, b) => b - a);
    const los = names.map(e => e[s.id].lo).sort((a, b) => a - b);
    let max = 0, min = 0;
    for (let i = 0; i < slots; i++) { max += his[i]; min += los[i]; }
    const tol = (s.id === 'crit' || s.id === 'cdr') ? 0.05 : 0.51;
    if (tgt > max + tol || tgt < min - tol) {
      const label = STATS.find(x => x.id === s.id)?.label || s.id;
      return `${label} target ${fmt(tgt)} is out of reach — your pool can total `
        + `${fmt(min)} to ${fmt(max)} ${label.toLowerCase()} across 10 emblems. `
        + `Adjust the target or add Pokémon / grades.`;
    }
  }
  return null;
}

const SCORE_EPS = 1e-9;
const PROTECT_PENALTY_WEIGHT = 45;

function compareCandidates(a, b) {
  const n = a.name.localeCompare(b.name);
  return n !== 0 ? n : a.grade.localeCompare(b.grade);
}

function loadoutSignature(loadout) {
  return [...loadout].map(x => `${x.name}\u0001${x.grade}`).sort().join('\u0002');
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
    const w = s.scale || 1;
    err += statTargetDelta(s.id, totals[s.id] || 0, opts.targets[s.id]) * w;
  }
  return err;
}

function isLoadoutBetter(ev, bestEv, loadout, bestLoadout, opts) {
  if (!ev.valid) return false;
  if (!bestLoadout?.length) return true;
  if (opts?.mode === 'target') {
    const errA = ev.error ?? Infinity;
    const errB = bestEv.error ?? Infinity;
    if (errA < errB - SCORE_EPS) return true;
    if (Math.abs(errA - errB) <= SCORE_EPS) {
      return loadoutSignature(loadout) < loadoutSignature(bestLoadout);
    }
    return false;
  }
  if (ev.score > bestEv.score + SCORE_EPS) return true;
  if (Math.abs(ev.score - bestEv.score) <= SCORE_EPS) {
    if (loadoutSignature(loadout) === loadoutSignature(bestLoadout)) return false;
    return Math.random() < 0.55;
  }
  return false;
}

function protectStatPenalty(statId, val, floor) {
  if (val >= floor - SCORE_EPS) return 0;
  return (floor - val) * (STATS.find(x => x.id === statId)?.scale || 1) * PROTECT_PENALTY_WEIGHT;
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

function sortedPoolCopy(pool, restartIdx, opts) {
  const mode = opts.mode === 'target' ? (restartIdx % 3) + 4 : (restartIdx % 4);
  const totals = {};
  STATS.forEach(s => { totals[s.id] = 0; });
  return [...pool].sort((a, b) => {
    if (mode === 4) {
      const ga = candidateGreedyValue(a, opts);
      const gb = candidateGreedyValue(b, opts);
      if (Math.abs(gb - ga) > SCORE_EPS) return gb - ga;
    } else if (mode === 5) {
      const da = STATS.reduce((sum, s) => {
        if (!opts.targetActive[s.id]) return sum;
        return sum + statTargetDelta(s.id, (a.stats[s.id] || 0), opts.targets[s.id]);
      }, 0);
      const db = STATS.reduce((sum, s) => {
        if (!opts.targetActive[s.id]) return sum;
        return sum + statTargetDelta(s.id, (b.stats[s.id] || 0), opts.targets[s.id]);
      }, 0);
      if (Math.abs(da - db) > SCORE_EPS) return da - db;
    }
    if (mode === 0 || mode === 6) {
      const d = candidateGreedyValue(b, opts) - candidateGreedyValue(a, opts);
      if (Math.abs(d) > SCORE_EPS) return d;
    } else if (mode === 1) {
      const sa = Object.values(a.stats).reduce((s, x) => s + Math.abs(x), 0);
      const sb = Object.values(b.stats).reduce((s, x) => s + Math.abs(x), 0);
      if (Math.abs(sb - sa) > SCORE_EPS) return sb - sa;
    } else if (mode === 2) {
      const dc = (b.colors || []).join(',').localeCompare((a.colors || []).join(','));
      if (dc) return dc;
    }
    return compareCandidates(a, b);
  });
}

function targetErrorFromTotals(totals, opts) {
  let err = 0;
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    err += statTargetDelta(s.id, totals[s.id] || 0, opts.targets[s.id]) * (s.scale || 1);
  }
  return err;
}

function groupPoolByName(pool) {
  const map = new Map();
  pool.forEach(c => {
    if (!map.has(c.name)) map.set(c.name, []);
    map.get(c.name).push(c);
  });
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, variants]) => ({ name, variants: variants.sort(compareCandidates) }));
}

function groupOverallDist(g, opts, perSlot) {
  let dist = 0;
  for (const c of g.variants) {
    let d = 0;
    for (const s of STATS) {
      if (!opts.targetActive[s.id]) continue;
      d += Math.abs((c.stats[s.id] || 0) - perSlot[s.id]);
    }
    dist = Math.min(dist, d);
  }
  return dist;
}

function getSmartTargetPoolEnabled() {
  return document.getElementById('smartTargetPool')?.checked ?? true;
}

function getTargetPoolCap(searchEffort) {
  const caps = { quick: 50, normal: 65, thorough: 70, deep: 80, extreme: 90 };
  return caps[searchEffort] || 65;
}

function isVariantUsefulForTarget(stats, opts, slots) {
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    const tgt = opts.targets[s.id];
    const v = stats[s.id] || 0;
    const per = tgt / slots;
    const tol = (s.id === 'crit' || s.id === 'cdr') ? 0.05 : 0.51;
    if (Math.abs(tgt) <= tol) continue;
    if (tgt > tol) {
      const bigNeg = s.id === 'hp' ? 25 : (s.id === 'atk' || s.id === 'spatk' ? 2.5 : 0.55);
      if (v < 0 && Math.abs(v) > Math.max(Math.abs(per) * 2.5, bigNeg)) return false;
    }
    if (tgt < -tol) {
      const bigPos = s.id === 'hp' ? 20 : (s.id === 'atk' || s.id === 'spatk' ? 2 : 0.55);
      if (v > tol && v > Math.max(Math.abs(per) * 2, bigPos)) return false;
    }
  }
  return true;
}

function gradeDominates(statsA, statsB, opts, slots) {
  let strictlyBetter = false;
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    const per = opts.targets[s.id] / slots;
    const da = Math.abs((statsA[s.id] || 0) - per);
    const db = Math.abs((statsB[s.id] || 0) - per);
    if (da > db + 1e-9) return false;
    if (db > da + 1e-9) strictlyBetter = true;
  }
  return strictlyBetter;
}

function pruneDominatedGrades(pool, opts, slots) {
  const groups = groupPoolByName(pool);
  const out = [];
  for (const g of groups) {
    if (g.variants.length <= 1) {
      out.push(...g.variants);
      continue;
    }
    for (const c of g.variants) {
      let dominated = false;
      for (const o of g.variants) {
        if (o === c) continue;
        if (gradeDominates(o.stats, c.stats, opts, slots)) {
          dominated = true;
          break;
        }
      }
      if (!dominated) out.push(c);
    }
  }
  return out;
}

// #3: lossless-for-maximize grade-variant prune using the build-time `gd`
// table. Within a name, drops a grade variant when another grade of the SAME
// name that is also present in the pool dominates it on every emblem stat axis.
// Proof of losslessness (maximize only): a name's color contribution is
// grade-independent; its score contribution is sum of priority*weight (weights
// >= 0 ⇒ monotonic increasing in each stat) minus a protect penalty (monotonic
// non-increasing in each stat). A dominating grade is >= on every stat, so its
// per-emblem contribution is >= the dominated one in every maximize objective.
// NOT applied in target mode (a lower grade can be closer to a target).
function pruneMaximizeDominatedGrades(pool) {
  const byName = new Map();
  for (const c of pool) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }
  const out = [];
  for (const [, variants] of byName) {
    if (variants.length <= 1) { out.push(...variants); continue; }
    const present = new Set(variants.map(c => c.grade));
    for (const c of variants) {
      const doms = EMBLEMS[c.emIdx]?.gd?.[c.grade];
      const dominated = Array.isArray(doms) && doms.some(d => present.has(d));
      if (!dominated) out.push(c);
    }
  }
  return out;
}

function refineCandidatesForTarget(candidates, opts, slots) {
  if (opts.mode !== 'target' || !opts.smartTargetPool) return candidates;
  if (!STATS.some(s => opts.targetActive[s.id])) return candidates;

  let pool = candidates.filter(c => isVariantUsefulForTarget(c.stats, opts, slots));
  pool = pruneDominatedGrades(pool, opts, slots);
  if (new Set(pool.map(c => c.name)).size < 10) return candidates;

  const cap = getTargetPoolCap(opts.searchEffort);
  pool = filterPoolForTarget(pool, opts, slots, cap);
  if (new Set(pool.map(c => c.name)).size < 10) return candidates;
  return pool;
}

function boundStatAdd(rem, statId, need, direction) {
  const vals = rem.map(c => c.stats[statId] || 0);
  const picked = direction === 'max'
    ? vals.filter(v => v > 0).sort((a, b) => b - a)
    : vals.filter(v => v < 0).sort((a, b) => a - b);
  return picked.slice(0, need).reduce((sum, x) => sum + x, 0);
}

function canStillReachTargets(loadout, pool, opts, slots) {
  const need = slots - loadout.length;
  if (need <= 0) return true;
  const usedNames = new Set(loadout.map(x => x.name));
  const rem = pool.filter(c => !usedNames.has(c.name));
  if (rem.length < need) return false;

  const totals = sumStats(loadout);
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    const tgt = opts.targets[s.id];
    const tol = (s.id === 'crit' || s.id === 'cdr') ? 0.05 : 0.51;
    const cur = totals[s.id] || 0;
    if (tgt > tol) {
      const maxAdd = boundStatAdd(rem, s.id, need, 'max');
      if (cur + maxAdd < tgt - tol) return false;
    }
    if (tgt < -tol) {
      const minAdd = boundStatAdd(rem, s.id, need, 'min');
      if (cur + minAdd > tgt + tol) return false;
    }
  }
  return true;
}

function addTargetArchetypes(essential, groups, opts, slots) {
  const perSlot = {};
  STATS.forEach(s => {
    if (opts.targetActive[s.id]) perSlot[s.id] = opts.targets[s.id] / slots;
  });
  for (const g of groups) {
    for (const c of g.variants) {
      const s = c.stats;
      const hp = Math.round(s.hp || 0);
      const sp = Math.round((s.spatk || 0) * 10) / 10;
      const atk = s.atk || 0;
      const cr = s.crit || 0;
      if (opts.targetActive.hp && perSlot.hp >= 25) {
        if (hp === 40 && Math.abs(sp + 2.4) < 0.05) essential.add(g.name);
        if (hp === 50 && (Math.abs(sp + 3.0) < 0.05 || atk < 0)) essential.add(g.name);
        if (hp === 30 && (Math.abs(cr + 0.3) < 0.05 || Math.abs(sp + 1.8) < 0.05)) essential.add(g.name);
      }
      if (opts.targetActive.atk && opts.targets.atk > 0.1 && atk >= 2.0) essential.add(g.name);
      if (opts.targetActive.spatk && opts.targets.spatk < -5) {
        if (sp === -3.6 || sp === -3.0 || sp === -2.4 || sp === -1.8) essential.add(g.name);
      }
      if (opts.targetActive.crit && opts.targets.crit < -0.05) {
        if (Math.abs(cr + 0.3) < 0.05 || Math.abs(cr + 0.5) < 0.05) essential.add(g.name);
      }
      if (opts.targetActive.crit && opts.targets.crit > 0.05) {
        if (cr === 0.3 || cr === 0.5 || cr === 0.6) essential.add(g.name);
      }
    }
  }
}

function candidateKey(c) {
  return `${c.name}\u0001${c.grade}`;
}

function getExactSearchPool(candidates, opts, slots) {
  if (opts.mode !== 'target' || !STATS.some(s => opts.targetActive[s.id])) return candidates;
  let pool = candidates.filter(c => isVariantUsefulForTarget(c.stats, opts, slots));
  if (new Set(pool.map(c => c.name)).size < 10) pool = candidates;

  const groups = groupPoolByName(pool);
  const essential = new Set();
  addTargetArchetypes(essential, groups, opts, slots);

  const uniqueNames = new Set(pool.map(c => c.name)).size;
  const cap = Math.min(uniqueNames, 300);
  let filtered = uniqueNames <= cap
    ? pool
    : filterPoolForTarget(pool, opts, slots, cap);

  const keepKeys = new Set(filtered.map(candidateKey));
  pool.forEach(c => {
    if (!essential.has(c.name)) return;
    const k = candidateKey(c);
    if (!keepKeys.has(k)) {
      filtered.push(c);
      keepKeys.add(k);
    }
  });
  return new Set(filtered.map(c => c.name)).size >= 10 ? filtered : candidates;
}

function filterPoolForTarget(pool, opts, slots, maxNames) {
  const uniqueNames = new Set(pool.map(c => c.name)).size;
  if (uniqueNames <= maxNames) return pool;

  const perSlot = {};
  STATS.forEach(s => {
    if (opts.targetActive[s.id]) perSlot[s.id] = opts.targets[s.id] / slots;
  });
  const groups = groupPoolByName(pool);
  const essential = new Set();
  addTargetArchetypes(essential, groups, opts, slots);

  const needBreadth = essential.size < 15;
  for (const s of STATS) {
    if (!opts.targetActive[s.id]) continue;
    const tgt = opts.targets[s.id];
    if (needBreadth) {
      const ranked = groups.map(g => {
        let best = Infinity;
        for (const c of g.variants) {
          const d = Math.abs((c.stats[s.id] || 0) - perSlot[s.id]);
          if (d < best) best = d;
        }
        return { name: g.name, best };
      });
      ranked.sort((a, b) => a.best - b.best || a.name.localeCompare(b.name));
      ranked.slice(0, 15).forEach(r => essential.add(r.name));
    }
    if (s.id === 'crit' || s.id === 'cdr') {
      const tolHits = groups.map(g => {
        let ok = false;
        for (const c of g.variants) {
          if (statTargetDelta(s.id, c.stats[s.id] || 0, tgt) === 0) { ok = true; break; }
        }
        return ok ? g.name : null;
      }).filter(Boolean);
      tolHits.sort((a, b) => a.localeCompare(b));
      tolHits.slice(0, 8).forEach(n => essential.add(n));
    }
    if (essential.size < 28) {
      const picks = groups.flatMap(g =>
        g.variants.map(c => ({ name: g.name, v: c.stats[s.id] || 0 }))
      );
      if (tgt > 0.1) {
        picks.filter(p => p.v > 0).sort((a, b) => b.v - a.v)
          .slice(0, 8).forEach(p => essential.add(p.name));
      }
      if (tgt < -0.1) {
        picks.filter(p => p.v < 0).sort((a, b) => a.v - b.v)
          .slice(0, 10).forEach(p => essential.add(p.name));
      }
    }
  }

  const targetSize = Math.min(maxNames, essential.size + (essential.size < 15 ? 10 : 6));
  const ranked = groups.map(g => ({ name: g.name, dist: groupOverallDist(g, opts, perSlot) }));
  ranked.sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name));

  const keep = new Set(essential);
  for (const r of ranked) {
    if (keep.size >= targetSize) break;
    keep.add(r.name);
  }
  return pool.filter(c => keep.has(c.name));
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

function fmtSearchCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

async function enumeratePartialAsync(groups, k, start, loadout, out, maxOut, state) {
  if (out.length >= maxOut || state.aborted) return;
  if (searchCancelToken?.cancelled) {
    state.aborted = true;
    return;
  }
  if (state.start && state.maxMs && Date.now() - state.start > state.maxMs) {
    state.aborted = true;
    return;
  }
  if (loadout.length === k) {
    out.push({
      loadout: loadout.slice(),
      totals: sumStats(loadout),
      names: new Set(loadout.map(x => x.name)),
    });
    if (state.reportProgress) {
      const now = Date.now();
      if (out.length === 1 || out.length % 2500 === 0 || now - (state.lastReport || 0) > 120) {
        state.lastReport = now;
        await state.reportProgress(out.length, maxOut);
      }
    }
    return;
  }
  const need = k - loadout.length;
  if (groups.length - start < need) return;
  for (let i = start; i < groups.length; i++) {
    if (state.aborted || searchCancelToken?.cancelled) {
      state.aborted = true;
      return;
    }
    for (const c of groups[i].variants) {
      loadout.push(c);
      await enumeratePartialAsync(groups, k, i + 1, loadout, out, maxOut, state);
      loadout.pop();
      if (out.length >= maxOut || state.aborted) return;
      state.enumSteps = (state.enumSteps || 0) + 1;
      if (state.enumSteps % 400 === 0) {
        if (searchCancelToken?.cancelled) {
          state.aborted = true;
          return;
        }
        await yieldToBrowser();
      }
    }
  }
}

async function bruteForceTarget(pool, opts, slots, maxMs = 12000, onProgress) {
  const groups = groupPoolByName(pool);
  if (groups.length < slots) return null;
  let best = [];
  let bestErr = Infinity;
  const state = { start: Date.now(), maxMs, lastYield: Date.now(), checked: 0 };

  async function reportBrute() {
    if (!onProgress) return;
    const elapsed = Date.now() - state.start;
    const sub = Math.min(1, elapsed / Math.max(1, state.maxMs));
    const bestLbl = bestErr < Infinity ? ` · best error ${bestErr.toFixed(2)}` : '';
    await onProgress(sub, `Exact · brute force ${(elapsed / 1000).toFixed(0)}s${bestLbl}`);
  }

  async function dfs(gi, loadout) {
    if (searchCancelToken?.cancelled) return;
    if (Date.now() - state.start > state.maxMs) return;
    if (Date.now() - state.lastYield > 40) {
      state.lastYield = Date.now();
      await reportBrute();
      await yieldToBrowser();
    }
    if (loadout.length === slots) {
      state.checked++;
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
        if (bestErr <= SCORE_EPS) return;
      }
    }
  }

  await dfs(0, []);
  if (!best.length) return null;
  return { loadout: best, error: bestErr };
}

function getSearchPreset(effort) {
  const presets = {
    quick: { mult: 0.45, min: 15, max: 50, rounds: 1, useExact: false },
    // `parallel` opts the restart-count presets into the worker pool (heavy
    // budgetMs presets already use it). quick stays single-thread to keep its
    // sub-second latency (worker spin-up + pool serialization isn't worth it).
    normal: { mult: 1, min: 30, max: 120, rounds: 1, useExact: false, parallel: true },
    thorough: {
      mult: 2.2, min: 80, max: 280, rounds: 2, useExact: true,
      mitmMs: 45000, bruteMs: 25000, enumMax: 5000000, filterMax: 50,
      targetSeedChance: 0.2, improvePasses: 2, parallel: true,
    },
    deep: {
      mult: 1, min: 500, max: 500, rounds: 1, useExact: true,
      mitmMs: 120000, bruteMs: 90000, enumMax: 12000000, filterMax: 55,
      budgetMs: 120000, deepBrute: true, bruteMaxNames: 30,
      targetSeedChance: 0.35, improvePasses: 3, polishTries: 80,
    },
    extreme: {
      mult: 1, min: 500, max: 500, rounds: 1, useExact: true,
      mitmMs: 240000, bruteMs: 150000, enumMax: 20000000, filterMax: 60,
      budgetMs: 300000, deepBrute: true, bruteMaxNames: 34,
      targetSeedChance: 0.45, improvePasses: 4, polishTries: 200,
    },
  };
  return presets[effort] || presets.normal;
}

function computeRestarts(poolLen, opts) {
  const preset = getSearchPreset(opts.searchEffort || 'normal');
  if (preset.budgetMs) {
    return { restarts: null, preset, useBudget: true };
  }
  let n = Math.floor((8000 / (poolLen + 1)) * preset.mult);
  n = Math.min(preset.max, Math.max(preset.min, n));
  if (opts.colorTargets) n = Math.max(n, Math.floor(preset.min * 1.6));
  if (opts.mode === 'target') n = Math.max(n, Math.floor(preset.min * 1.2));
  return { restarts: n, preset, useBudget: false };
}

async function searchTargetMITM(pool, opts, slots, limits, onProgress) {
  const groups = groupPoolByName(pool);
  const half = Math.floor(slots / 2);
  const rightK = slots - half;
  const maxMs = limits?.mitmMs ?? 25000;
  const enumMax = limits?.enumMax ?? 3000000;
  const lookupCap = limits?.lookupCap ?? 200;
  const t0 = Date.now();
  const report = async (sub, label) => {
    if (onProgress) await onProgress(sub, label);
  };

  const left = [];
  const enumState = {
    aborted: false, start: t0, maxMs, lastReport: 0, lastYield: Date.now(),
  };
  enumState.reportProgress = async (count, max) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const cap = enumState.aborted ? ' · cap reached' : '';
    const sub = 0.06 + 0.34 * Math.min(1, count / Math.max(1, max));
    await report(sub, `Exact · ${half}-slot combos: ${fmtSearchCount(count)} / ${fmtSearchCount(max)} (${elapsed}s)${cap}`);
  };
  await report(0.02, `Exact · building ${half}-slot combinations (${groups.length} Pokémon)…`);
  await enumeratePartialAsync(groups, half, 0, [], left, enumMax, enumState);
  if (enumState.aborted && !left.length) return null;
  checkSearchCancelled();

  const right = [];
  const enumStateR = {
    aborted: false, start: t0, maxMs, lastReport: 0, lastYield: Date.now(),
  };
  enumStateR.reportProgress = async (count, max) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const cap = enumStateR.aborted ? ' · cap reached' : '';
    const sub = 0.42 + 0.33 * Math.min(1, count / Math.max(1, max));
    await report(sub, `Exact · ${rightK}-slot combos: ${fmtSearchCount(count)} / ${fmtSearchCount(max)} (${elapsed}s)${cap}`);
  };
  await report(0.40, `Exact · ${fmtSearchCount(left.length)} left halves · building ${rightK}-slot side…`);
  await enumeratePartialAsync(groups, rightK, 0, [], right, enumMax, enumStateR);
  checkSearchCancelled();

  await report(0.76, `Exact · indexing ${fmtSearchCount(left.length)} left halves…`);
  const index = new Map();
  for (const L of left) {
    const key = statTotalsKey(L.totals, opts);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(L);
  }

  let best = [];
  let bestErr = Infinity;
  function lookupLeft(needKey) {
    const hits = index.get(needKey);
    if (hits) return hits;
    const parts = needKey.split('|').map(x => parseInt(x, 10));
    const out = [];
    for (const [k, list] of index) {
      const kp = k.split('|').map(x => parseInt(x, 10));
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        if (Math.abs(kp[i] - parts[i]) > 1) { ok = false; break; }
      }
      if (ok) out.push(...list);
      if (out.length > lookupCap) break;
    }
    return out.length ? out : null;
  }

  const rightLen = Math.max(1, right.length);
  let ri = 0;
  let lastMatchReport = 0;
  for (const R of right) {
    if (searchCancelToken?.cancelled) break;
    if (Date.now() - t0 > maxMs) break;
    ri++;
    const now = Date.now();
    if (now - lastMatchReport > 100) {
      lastMatchReport = now;
      const pct = Math.round((100 * ri) / rightLen);
      const sub = 0.78 + 0.18 * (ri / rightLen);
      const bestLbl = bestErr < Infinity ? ` · best error ${bestErr.toFixed(2)}` : '';
      await report(sub, `Exact · matching ${pct}% (${fmtSearchCount(ri)}/${fmtSearchCount(right.length)})${bestLbl}`);
      await yieldToBrowser();
    }
    const matches = lookupLeft(neededTotalsKey(R.totals, opts));
    if (!matches) continue;
    for (const L of matches) {
      let overlap = false;
      for (const n of R.names) {
        if (L.names.has(n)) { overlap = true; break; }
      }
      if (overlap) continue;
      const full = [...L.loadout, ...R.loadout];
      if (!evaluate(full, 'target', opts).valid) continue;
      const err = targetError(full, opts);
      if (err < bestErr - SCORE_EPS) {
        bestErr = err;
        best = full;
        if (err <= SCORE_EPS) return { loadout: best, error: bestErr };
      }
    }
  }

  if (best.length) {
    await report(0.98, `Exact · MITM done · best error ${bestErr.toFixed(2)}`);
  } else {
    await report(0.98, 'Exact · MITM finished (no valid merge)');
  }
  if (!best.length) return null;
  return { loadout: best, error: bestErr };
}

async function searchTargetExact(pool, opts, slots, limits, onExactProgress) {
  if (!limits?.useExact) return null;
  const report = async (sub, label) => {
    if (onExactProgress) await onExactProgress(sub, label);
    checkSearchCancelled();
  };
  const uniqueNames = new Set(pool.map(c => c.name)).size;
  const variants = pool.length;
  await report(0, `Exact · ${uniqueNames} Pokémon · ${variants} grade options`);
  await report(0.02, 'Exact · recipe signature solver…');
  const recipeHit = await searchByRecipesAsync(pool, opts, slots, shufflePool, () => searchCancelToken?.cancelled, () => yieldToBrowser());
  if (recipeHit?.loadout?.length === slots && recipeHit.error <= SCORE_EPS) {
    await report(0.95, 'Exact · recipe match found');
    return recipeHit;
  }
  checkSearchCancelled();
  const mitmLimits = { ...limits, lookupCap: limits.lookupCap ?? (limits.deepBrute ? 800 : 400) };
  const mitm = await searchTargetMITM(pool, opts, slots, mitmLimits, async (mitmSub, label) => {
    await report(0.06 + mitmSub * 0.82, label);
  });
  checkSearchCancelled();
  let bf = null;
  const bruteMax = limits.bruteMaxNames ?? (limits.deepBrute ? 28 : 22);
  if (uniqueNames <= bruteMax && limits.bruteMs > 0) {
    await report(0.90, `Exact · brute force on ${uniqueNames} Pokémon…`);
    bf = await bruteForceTarget(pool, opts, slots, limits.bruteMs, async (bruteSub, label) => {
      await report(0.90 + bruteSub * 0.08, label);
    });
  }
  checkSearchCancelled();
  if (bf && bf.error <= SCORE_EPS) return bf;
  if (mitm && mitm.error <= SCORE_EPS) return mitm;
  if (!bf && !mitm) return null;
  if (!bf) return mitm;
  if (!mitm) return bf;
  const pick = bf.error <= mitm.error ? bf : mitm;
  await report(1, pick.error <= SCORE_EPS ? 'Exact · perfect match found' : `Exact · best error ${pick.error.toFixed(2)}`);
  return pick;
}

function targetAwareSeed(pool, opts, slots) {
  const loadout = [];
  const names = new Set();

  for (let s = 0; s < slots; s++) {
    let best = null;
    let bestErr = Infinity;
    for (const c of pool) {
      if (names.has(c.name)) continue;
      const trial = [...loadout, c];
      if (opts.smartTargetPool && !canStillReachTargets(trial, pool, opts, slots)) continue;
      if (!evaluate(trial, 'target', opts).valid) continue;
      const err = targetError(trial, opts);
      if (err < bestErr - SCORE_EPS || (Math.abs(err - bestErr) <= SCORE_EPS && (!best || compareCandidates(c, best) < 0))) {
        bestErr = err;
        best = c;
      }
    }
    if (!best) {
      const remaining = pool.filter(c => !names.has(c.name)).sort(compareCandidates);
      best = remaining[0];
    }
    if (!best) break;
    loadout.push(best);
    names.add(best.name);
  }
  return loadout;
}

function pickBetterCandidate(score, bestScore, c, best) {
  if (score > bestScore + SCORE_EPS) return true;
  if (Math.abs(score - bestScore) <= SCORE_EPS && best) return compareCandidates(c, best) < 0;
  if (Math.abs(score - bestScore) <= SCORE_EPS && !best) return true;
  return false;
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
  for (const col of candidate.colors) {
    const need = colorTargets.targets[col];
    if (need === undefined) continue;
    if ((counts[col] || 0) + 1 > need) return true;
  }
  return false;
}

function candidateColorHelp(c, needs) {
  let help = 0;
  for (const col of c.colors) {
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

function colorBonusScore(counts, includeBonuses) {
  if (!includeBonuses) return { score: 0, details: [] };
  let score = 0;
  const details = [];
  Object.entries(counts).forEach(([color, n]) => {
    const th = COLOR_THRESHOLDS[color];
    const bon = COLOR_BONUS[color];
    if (!th) return;
    let tier = -1;
    for (let i = th.length - 1; i >= 0; i--) {
      if (n >= th[i]) { tier = i; break; }
    }
    if (tier >= 0) {
      const val = bon[tier];
      const w = color === 'gray' ? 8 : 15;
      score += val * w;
      details.push({ color, n, tier: tier + 1, effect: COLOR_BONUS_STAT[color], value: val });
    }
  });
  return { score, details };
}

function normalizeStatForScore(statId, val) {
  const s = STATS.find(x => x.id === statId);
  return val * (s?.scale || 1);
}

function evaluate(loadout, mode, opts) {
  const totals = sumStats(loadout);
  const counts = countColors(loadout);
  if (!colorsMatchTargets(counts, opts.colorTargets)) {
    return { valid: false, score: -1e12, totals, counts, cb: { score: 0, details: [] } };
  }
  const cb = colorBonusScore(counts, opts.colorBonuses);

  if (mode === 'maximize') {
    let score = cb.score;
    for (const s of STATS) {
      const v = totals[s.id] || 0;
      if (opts.priorities[s.id]) {
        score += normalizeStatForScore(s.id, v) * opts.weights[s.id];
      }
      if (opts.protected[s.id] !== undefined) {
        score -= protectStatPenalty(s.id, v, opts.protected[s.id]);
      }
    }
    return { valid: true, score, totals, counts, cb };
  }

  const err = targetError(loadout, opts);
  const score = -err;
  return { valid: true, score, totals, counts, cb, error: err };
}

__RECIPE_SEARCH_JS__

function getOpts() {
  const mode = document.getElementById('optMode').value;
  const colorBonuses = document.getElementById('colorBonuses').checked;
  const colorTargets = getColorTargets();
  if (mode === 'maximize') {
    const priorities = {}, weights = {}, protected = {};
    STATS.forEach(s => {
      priorities[s.id] = document.querySelector(`.max-priority[data-stat="${s.id}"]`).checked;
      weights[s.id] = parseFloat(document.querySelector(`.max-weight[data-stat="${s.id}"]`).value) || 1;
      if (document.querySelector(`.protect-stat[data-stat="${s.id}"]`).checked) {
        protected[s.id] = parseFloat(document.querySelector(`.protect-min[data-stat="${s.id}"]`).value) || 0;
      }
    });
    return { mode, colorBonuses, colorTargets, priorities, weights, protected, searchEffort: getSearchEffort(), searchVariant: Math.random() };
  }
  const targets = {}, targetActive = {};
  STATS.forEach(s => {
    const inp = document.querySelector(`.target-val[data-stat="${s.id}"]`);
    const raw = (inp?.value ?? '').trim();
    const hasVal = raw !== '' && !isNaN(parseFloat(raw));
    const use = document.querySelector(`.target-use[data-stat="${s.id}"]`)?.checked;
    targetActive[s.id] = hasVal && use;
    targets[s.id] = hasVal ? parseFloat(raw) : 0;
  });
  return {
    mode, colorBonuses, colorTargets, targets, targetActive,
    searchEffort: getSearchEffort(),
    smartTargetPool: getSmartTargetPoolEnabled(),
    searchVariant: Math.random(),
  };
}

function getSearchEffort() {
  return document.getElementById('searchEffort')?.value || 'normal';
}

function updateSearchEffortHint() {
  const el = document.getElementById('searchEffortHint');
  if (!el) return;
  const preset = getSearchPreset(getSearchEffort());
  const parts = [];
  if (preset.budgetMs) {
    parts.push(`runs for ${Math.round(preset.budgetMs / 1000)}s wall-clock (try count varies by device)`);
  } else {
    parts.push(`fixed ${preset.min}–${preset.max} random builds (not a time limit — may finish in under a second)`);
    if (preset.rounds > 1) parts.push(`${preset.rounds} rounds`);
  }
  if (preset.useExact) parts.push('long exact target pass first');
  if (document.getElementById('optMode')?.value === 'target' && getSmartTargetPoolEnabled()) {
    parts.push('smart target pool on');
  }
  el.textContent = parts.join(' · ') + '.';
}

function shufflePool(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

async function optimizeAsync(candidates, opts, progress) {
  const SLOTS = 10;
  let pool = candidates.filter(() => true);
  const searchMeta = {
    effort: opts.searchEffort || 'normal',
    restarts: 0,
    rounds: 0,
    exact: false,
    budgetMs: 0,
  };
  // #3: drop maximize-dominated grade variants (lossless for maximize). Shrinks
  // the pool the exact enumerator + heuristic explore; the DP already takes the
  // best grade per name, so this only helps the non-DP maximize paths.
  if (opts.mode === 'maximize') {
    const before = pool.length;
    pool = pruneMaximizeDominatedGrades(pool);
    if (pool.length !== before) searchMeta.maxGradePrune = before - pool.length;
  }
  const fullPool = pool;
  let heuristicPool = pool;
  if (opts.mode === 'target' && opts.smartTargetPool && STATS.some(s => opts.targetActive[s.id])) {
    const refined = refineCandidatesForTarget(pool, opts, SLOTS);
    const names = new Set(refined.map(c => c.name)).size;
    if (names >= 10) {
      heuristicPool = refined;
      searchMeta.smartPool = true;
      searchMeta.poolNames = names;
      searchMeta.poolVariants = refined.length;
    }
  }
  const exactPool = (opts.mode === 'target' && STATS.some(s => opts.targetActive[s.id]))
    ? getExactSearchPool(fullPool, opts, SLOTS)
    : heuristicPool;
  pool = heuristicPool;
  const tSearch0 = Date.now();

  // Optimal maximize-with-color-bonuses solver: DP over the per-color count
  // vector (the only non-separable term is the threshold color bonus). Provably
  // optimal; works with or without exact color targets. Skipped when a protect
  // floor is set (breaks separability) or color bonuses are off; falls through
  // to the existing search when the state space is too large.
  if (opts.mode === 'maximize' && opts.colorBonuses &&
      !(opts.protected && Object.keys(opts.protected).length > 0)) {
    if (progress) await progress(2, 'Optimal search (color bonuses)…');
    const dpRes = await searchMaximizeColorBonusDP(fullPool, opts, SLOTS, progress);
    checkSearchCancelled();
    if (dpRes?.loadout?.length === SLOTS && dpRes.ev.valid) {
      searchMeta.colorBonusDp = true;
      searchMeta.totalMs = Date.now() - tSearch0;
      if (progress) await progress(100, 'Done — optimal (color bonuses)');
      return { loadout: dpRes.loadout, ev: dpRes.ev, searchMeta };
    }
  }

  // Exhaustive color-constrained search: when color counts are required and the
  // number of color-feasible builds is tractable, enumerate and score them all
  // for a guaranteed optimum (over the full pool, not the refined heuristic one),
  // instead of random sampling. Falls through to the heuristic search otherwise.
  if (opts.colorTargets) {
    const buildCount = countColorTargetBuilds(opts.colorTargets, fullPool);
    searchMeta.colorBuildCount = buildCount === null ? 'large' : buildCount.toString();
    const fullMulti = new Set(fullPool.map(c => c.name)).size < fullPool.length;
    const hasProtect = opts.mode === 'maximize' && opts.protected &&
      Object.keys(opts.protected).length > 0;
    const needsPolish = fullMulti && (opts.mode === 'target' || hasProtect);
    // Pure-linear maximize collapses to one build per color pattern (lossless),
    // so its work is bounded by the (small) number of patterns, not the build
    // count — we can run it exactly even when the raw build count exceeds the cap.
    const canCollapse = opts.mode === 'maximize' && !opts.colorBonuses &&
      !(opts.protected && Object.keys(opts.protected).length > 0);
    const cap = BigInt(needsPolish ? COLOR_EXACT_CAP_POLISH : COLOR_EXACT_CAP);
    if (buildCount !== null && buildCount > 0n && (buildCount <= cap || canCollapse)) {
      const combos = Number(buildCount);
      if (progress) await progress(3, `Exact search · enumerating ${formatBuildCount(buildCount)} builds…`);
      let exactRes = null;
      let usedParallel = false;
      // Parallelize the GENERAL (non-collapse) enumeration across the worker pool
      // when the space is large enough to amortize worker overhead. The lossless
      // collapse fast-path and the maximize-with-bonuses DP are left untouched
      // (collapse already evaluates one build per pattern). Any failure or a
      // single-core / no-Worker environment falls back to the main-thread
      // enumerator below, unchanged.
      if (!canCollapse && combos >= COLOR_EXACT_PARALLEL_MIN &&
          typeof Worker !== 'undefined' && searchPoolSize() > 1) {
        try {
          exactRes = await searchColorExactParallel(fullPool, opts, SLOTS, combos, progress);
          if (exactRes) { usedParallel = true; }
        } catch (parErr) {
          if (parErr?.name === 'OptimizeCancelled') throw parErr;
          console.warn('Parallel exact search failed, using main thread:', parErr);
          exactRes = null;
        }
        checkSearchCancelled();
      }
      if (!exactRes) {
        exactRes = await searchColorExactExhaustive(fullPool, opts, SLOTS, combos, progress);
        checkSearchCancelled();
      }
      if (exactRes?.loadout?.length === SLOTS && exactRes.ev.valid) {
        searchMeta.colorExactEnum = true;
        searchMeta.colorExactCollapse = canCollapse;
        searchMeta.colorExactParallel = usedParallel;
        if (usedParallel) searchMeta.exactShards = searchPoolSize();
        searchMeta.exactCombos = combos;
        searchMeta.totalMs = Date.now() - tSearch0;
        if (progress) await progress(100, `Done — exact search of ${formatBuildCount(buildCount)} builds`);
        return { loadout: exactRes.loadout, ev: exactRes.ev, searchMeta };
      }
    }
  }

  if (opts.mode === 'target' && STATS.some(s => opts.targetActive[s.id])) {
    if (progress) await progress(1, 'Exact · recipe signature solver…');
    const recipeHit = await searchByRecipesAsync(exactPool, opts, SLOTS, shufflePool, () => searchCancelToken?.cancelled, () => yieldToBrowser());
    checkSearchCancelled();
    if (recipeHit?.loadout?.length === SLOTS && recipeHit.error <= SCORE_EPS) {
      const ev = evaluate(recipeHit.loadout, opts.mode, opts);
      if (ev.valid) {
        searchMeta.recipeExact = true;
        searchMeta.exactError = recipeHit.error;
        if (progress) await progress(100, 'Done — exact recipe match');
        searchMeta.heuristicSkipped = 'recipe exact';
        searchMeta.totalMs = Date.now() - tSearch0;
        return { loadout: recipeHit.loadout, ev, searchMeta };
      }
    }
  }
  const { restarts, preset, useBudget } = computeRestarts(pool.length, opts);
  searchMeta.restarts = restarts ?? 0;
  searchMeta.rounds = preset.rounds;
  searchMeta.budgetMs = preset.budgetMs || 0;
  const useExactPhase = opts.mode === 'target' && STATS.some(s => opts.targetActive[s.id]) && preset.useExact;
  const heuristicLo = useExactPhase ? 48 : 8;
  const heuristicSpan = 100 - heuristicLo;

  let globalBest = { loadout: [], ev: { score: -1e12, error: Infinity } };

  if (opts.colorTargets) {
    if (progress) await progress(2, 'Color · building exact count loadout…');
    const seeded = colorExactSeedOnce(shufflePool(pool), opts, SLOTS);
    checkSearchCancelled();
    if (seeded?.length === SLOTS) {
      const ev = evaluate(seeded, opts.mode, opts);
      if (ev.valid) {
        globalBest = { loadout: seeded, ev };
        searchMeta.colorExact = true;
      }
    }
  }

  // Route the heuristic through the worker pool when it pays off:
  //  - heavy (budgetMs) presets always offload to a worker (parallel if multi-
  //    core, single-worker on 1 core) — keeps the UI responsive, as before.
  //  - restart-count presets flagged `parallel` (normal/thorough) only when the
  //    machine is genuinely multi-core, so we get real fan-out without paying
  //    worker overhead on single-core devices (those stay on the main thread).
  // quick is intentionally excluded to preserve its instant latency.
  const multiCore = typeof Worker !== 'undefined' && searchPoolSize() > 1;
  const useWorkerHeuristic = isHeavySearchPreset(preset) || (preset.parallel && multiCore);
  if (useWorkerHeuristic) {
    const ctx = {
      preset,
      restarts,
      heuristicLo,
      lookupCap: preset.deepBrute ? 800 : 400,
      searchMeta: { ...searchMeta },
    };
    try {
      // Parallelize the heuristic across a worker pool; fall back to the single
      // worker if the pool can't be created or a shard fails to start.
      let workerResult;
      try {
        workerResult = await runOptimizeInWorkerPool(heuristicPool, exactPool, opts, SLOTS, ctx, progress);
      } catch (poolErr) {
        if (poolErr?.name === 'OptimizeCancelled') throw poolErr;
        console.warn('Worker pool unavailable, falling back to single worker:', poolErr);
        workerResult = await runOptimizeInWorker(heuristicPool, exactPool, opts, SLOTS, ctx, progress);
      }
      checkSearchCancelled();
      if (progress) await progress(100, 'Finishing…');
      const wLoadout = workerResult.loadout || [];
      const wEv = workerResult.ev || { score: -1e12, error: Infinity };
      const meta = workerResult.searchMeta || searchMeta;
      const workerWins = wLoadout.length && (
        !globalBest.loadout.length ||
        isLoadoutBetter(wEv, globalBest.ev, wLoadout, globalBest.loadout, opts)
      );
      if (workerWins) {
        return { loadout: wLoadout, ev: wEv, searchMeta: meta };
      }
      if (globalBest.loadout.length) {
        return { loadout: globalBest.loadout, ev: globalBest.ev, searchMeta: { ...meta, colorExact: true } };
      }
      return { loadout: wLoadout, ev: wEv, searchMeta: meta };
    } catch (err) {
      if (err?.name === 'OptimizeCancelled') throw err;
      console.warn('Worker search unavailable, using main thread:', err);
      if (globalBest.loadout.length) {
        if (progress) await progress(100, 'Finishing…');
        searchMeta.totalMs = Date.now() - tSearch0;
        return { ...globalBest, searchMeta };
      }
    }
  }

  // Candidate counter (main-thread fallback; mirrors search_worker.js).
  // "candidates tried" = full loadouts scored via evaluate(); every seed,
  // hill-climb neighbour and SA move increments it so the progress label climbs
  // quickly and reflects real work.
  let heurEvals = 0;
  const score = (L) => { heurEvals++; return evaluate(L, opts.mode, opts); };
  const heurLabel = (suffix) =>
    `Heuristic · ${heurEvals.toLocaleString()} candidates tried${suffix || ''}`;

  function greedySeed() {
    const shuffled = shufflePool(pool);
    if (opts.mode === 'target' && preset.targetSeedChance && Math.random() < preset.targetSeedChance) {
      const seeded = targetAwareSeed(shuffled, opts, SLOTS);
      if (seeded.length === SLOTS && score(seeded).valid) return seeded;
    }
    const loadout = [];
    const names = new Set();
    for (const c of shuffled) {
      if (loadout.length >= SLOTS) break;
      if (names.has(c.name)) continue;
      const trial = [...loadout, c];
      if (opts.mode === 'target' && opts.smartTargetPool &&
          !canStillReachTargets(trial, pool, opts, SLOTS)) continue;
      const ev = score(trial);
      if (!ev.valid) continue;
      loadout.push(c);
      names.add(c.name);
    }
    return loadout;
  }

  function improve(loadout, candidateOrder) {
    let best = loadout.slice();
    let bestEv = score(best);
    if (!bestEv.valid) bestEv = { score: -1e12 };
    const order = candidateOrder || pool;
    const maxRounds = opts.colorTargets ? 1 : 8;
    const maxCands = opts.colorTargets ? 48 : pool.length;

    let improved = true;
    let rounds = 0;
    while (improved && rounds < maxRounds) {
      improved = false;
      rounds++;
      const scan = samplePool(order, maxCands);
      for (let slot = 0; slot < best.length; slot++) {
        const names = new Set(best.map((x, i) => i === slot ? null : x.name).filter(Boolean));
        for (const cand of scan) {
          if (names.has(cand.name)) continue;
          const trial = best.slice();
          trial[slot] = cand;
          if (opts.mode === 'target' && opts.smartTargetPool &&
              !canStillReachTargets(trial, pool, opts, SLOTS)) continue;
          const ev = score(trial);
          if (ev.valid && isLoadoutBetter(ev, bestEv, trial, best, opts)) {
            best = trial;
            bestEv = ev;
            improved = true;
          }
        }
      }
      if (best.length < SLOTS) {
        const names = new Set(best.map(x => x.name));
        for (const cand of scan) {
          if (names.has(cand.name)) continue;
          const trial = [...best, cand];
          if (opts.mode === 'target' && opts.smartTargetPool &&
              !canStillReachTargets(trial, pool, opts, SLOTS)) continue;
          const ev = score(trial);
          if (ev.valid && isLoadoutBetter(ev, bestEv, trial, best, opts)) {
            best = trial;
            bestEv = ev;
            names.add(cand.name);
            improved = true;
          }
        }
      }
    }
    return { loadout: best, ev: bestEv };
  }

  function polishLoadout(loadout) {
    if (!preset.polishTries || loadout.length < SLOTS) return loadout;
    const tries = opts.colorTargets ? Math.min(16, preset.polishTries) : preset.polishTries;
    let best = loadout.slice();
    let bestEv = score(best);
    for (let t = 0; t < tries; t++) {
      const slot = Math.floor(Math.random() * SLOTS);
      const names = new Set(best.map((x, i) => i === slot ? null : x.name).filter(Boolean));
      const cand = pool[Math.floor(Math.random() * pool.length)];
      if (names.has(cand.name)) continue;
      const trial = best.slice();
      trial[slot] = cand;
      const ev = score(trial);
      if (ev.valid && isLoadoutBetter(ev, bestEv, trial, best, opts)) {
        best = trial;
        bestEv = ev;
      }
    }
    return best;
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
        if (opts.mode === 'target' && opts.smartTargetPool &&
            !canStillReachTargets(trial, pool, opts, SLOTS)) continue;
        if (score(trial).valid) { L = trial; names.add(c.name); }
      }
    }
    let best = L;
    let bestEv = score(best);
    if (opts.colorTargets && best.length === SLOTS && bestEv.valid) {
      best = polishLoadout(best);
      return { loadout: best, ev: score(best) };
    }
    const passes = opts.colorTargets ? 1 : (preset.improvePasses || 1);
    for (let p = 0; p < passes; p++) {
      const res = improve(best, shufflePool(pool));
      if (res.ev.valid && isLoadoutBetter(res.ev, bestEv, res.loadout, best, opts)) {
        best = res.loadout;
        bestEv = res.ev;
      }
    }
    best = polishLoadout(best);
    return { loadout: best, ev: score(best) };
  }

  // ---- Simulated-annealing metaheuristic (no-color huge-pool case; mirrors
  // search_worker.js). Greedy-seeded SA over slot-replace + grade-change
  // neighbourhoods with Metropolis acceptance + geometric cooling, a fresh
  // anneal each segment. Escapes the local optima random restarts rediscover.
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
    let T0 = (n ? acc / n : Math.max(1, Math.abs(annealEnergy(curEv)) * 0.05));
    if (!(T0 > 0)) T0 = 1;
    const Tmin = Math.max(T0 * 1e-3, 1e-9);
    const alpha = Math.exp(Math.log(Tmin / T0) / annealMoves);
    let T = T0;
    for (let m = 0; m < annealMoves; m++) {
      const nb = annealNeighbor(cur, curNames);
      if (nb) {
        const ev = score(nb.trial);
        const dE = annealEnergy(ev) - annealEnergy(curEv);
        if (dE <= 0 || Math.random() < Math.exp(-dE / T)) {
          cur = nb.trial; curEv = ev;
          if (nb.oldName !== nb.newName) { curNames.delete(nb.oldName); curNames.add(nb.newName); }
          if (isLoadoutBetter(curEv, bestEv, cur, best, opts)) { best = cur.slice(); bestEv = curEv; }
        }
      }
      T *= alpha; if (T < Tmin) T = Tmin;
    }
    return { loadout: best, ev: bestEv };
  }

  const oneTry = () => useAnneal ? annealSegment() : runOneTry();

  if (opts.mode === 'target' && STATS.some(s => opts.targetActive[s.id]) && preset.useExact) {
    const limits = {
      ...preset,
      deepBrute: !!preset.deepBrute,
      lookupCap: preset.deepBrute ? 800 : 400,
    };
    const tExact0 = Date.now();
    const exactProgress = async (sub, label) => {
      if (progress) await progress(2 + sub * (heuristicLo - 2), label);
    };
    const exact = await searchTargetExact(exactPool, opts, SLOTS, limits, exactProgress);
    checkSearchCancelled();
    searchMeta.exactMs = Date.now() - tExact0;
    searchMeta.exact = true;
    if (exact?.loadout?.length === SLOTS) {
      const ev = evaluate(exact.loadout, opts.mode, opts);
      if (ev.valid) {
        globalBest = { loadout: exact.loadout, ev };
        searchMeta.exactError = exact.error;
        if (exact.error <= SCORE_EPS) {
          if (progress) await progress(100, 'Done — exact match');
          searchMeta.heuristicSkipped = 'exact match';
          searchMeta.totalMs = Date.now() - tSearch0;
          return { ...globalBest, searchMeta };
        }
      }
    }
    if (progress) await progress(heuristicLo, 'Heuristic search…');
  } else if (progress) {
    await progress(heuristicLo, 'Searching random builds…');
  }

  const plannedTries = useBudget ? null : restarts * preset.rounds;
  searchMeta.plannedTries = plannedTries;

  if (useBudget && preset.budgetMs) {
    const t0 = Date.now();
    let tries = 0;
    while (Date.now() - t0 < preset.budgetMs) {
      checkSearchCancelled();
      const sliceEnd = Date.now() + 48;
      while (Date.now() - t0 < preset.budgetMs && Date.now() < sliceEnd) {
        const res = oneTry();
        if (isLoadoutBetter(res.ev, globalBest.ev, res.loadout, globalBest.loadout, opts)) globalBest = res;
        tries++;
      }
      const elapsed = Date.now() - t0;
      const pct = heuristicLo + (elapsed / preset.budgetMs) * heuristicSpan;
      if (progress) {
        await progress(pct, heurLabel(` · ${(elapsed / 1000).toFixed(0)}s / ${Math.round(preset.budgetMs / 1000)}s`));
      } else {
        await yieldToBrowser();
      }
    }
    searchMeta.restarts = tries;
    searchMeta.candidates = heurEvals;
    searchMeta.heuristicMs = Date.now() - t0;
  } else {
    const tHeuristic0 = Date.now();
    const total = restarts * preset.rounds;
    let done = 0;
    for (let round = 0; round < preset.rounds; round++) {
      checkSearchCancelled();
      let r = 0;
      while (r < restarts) {
        checkSearchCancelled();
        const sliceEnd = Date.now() + 48;
        while (r < restarts && Date.now() < sliceEnd) {
          const res = oneTry();
          if (isLoadoutBetter(res.ev, globalBest.ev, res.loadout, globalBest.loadout, opts)) globalBest = res;
          r++;
          done++;
        }
        const pct = heuristicLo + (done / Math.max(1, total)) * heuristicSpan;
        if (progress) {
          await progress(pct, heurLabel());
        } else {
          await yieldToBrowser();
        }
      }
    }
    searchMeta.restarts = done;
    searchMeta.candidates = heurEvals;
    searchMeta.heuristicMs = Date.now() - tHeuristic0;
  }

  if (globalBest.loadout.length < SLOTS && pool.length >= SLOTS) {
    let L = opts.colorTargets ? colorExactSeedOnce(shufflePool(pool), opts, SLOTS) : null;
    if (!L?.length) {
      L = [];
      const names = new Set();
      for (const c of shufflePool(pool)) {
        if (L.length >= SLOTS) break;
        if (names.has(c.name)) continue;
        const trial = [...L, c];
        if (evaluate(trial, opts.mode, opts).valid) { L.push(c); names.add(c.name); }
      }
    }
    if (L.length) {
      const res = improve(L, shufflePool(pool));
      if (isLoadoutBetter(res.ev, globalBest.ev, res.loadout, globalBest.loadout, opts)) globalBest = res;
    }
  }

  checkSearchCancelled();
  searchMeta.totalMs = Date.now() - tSearch0;
  if (progress) await progress(100, 'Finishing…');
  return { ...globalBest, searchMeta };
}

function fmtStat(v, id) {
  if (Math.abs(v) < 0.001) return '0';
  if (id === 'crit' || id === 'cdr') return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  return (v > 0 ? '+' : '') + (Number.isInteger(v) ? v : v.toFixed(1));
}

function renderResults(result) {
  if (!result?.ev) {
    showOptimizeIssue('Optimization finished without a valid result. Try again or lower search constraints.', 'error');
    return;
  }
  const { loadout, ev, searchMeta } = result;
  const body = document.getElementById('resultsBody');
  if (!loadout.length) {
    showOptimizeIssue(
      'No valid loadout found. Expand your pool or adjust color count targets.',
      'warning'
    );
    return;
  }

  let html = '<div class="row g-2">';
  loadout.forEach((item, i) => {
    const gains = [], losses = [];
    Object.entries(item.stats).forEach(([k, v]) => {
      const lbl = statLabel(k);
      if (v > 0) gains.push(`${lbl} ${fmtStat(v,k)}`);
      else if (v < 0) losses.push(`${lbl} ${fmtStat(v,k)}`);
    });
    const cols = item.colors.map(c => `<span class="color-dot c-${c}"></span>`).join('');
    const em = EMBLEMS[item.emIdx] || EMBLEMS[EMBLEM_INDEX_BY_NAME.get(item.name)];
    const icon = em ? emblemIconHtml(em, item.grade, 'emblem-icon slot-icon') : '';
    html += `<div class="col-12"><div class="card slot-card bg-black border-secondary p-2">
      <div class="d-flex align-items-start gap-2">
        ${icon}
        <div class="flex-grow-1 min-w-0">
      <div class="d-flex justify-content-between">
        <strong>${i+1}. ${item.name}</strong>
        <span class="grade-${item.grade} text-uppercase small">${item.grade}</span>
      </div>
      <div>${cols}</div>
      <div class="small stat-pos">${gains.join(' · ') || '—'}</div>
      <div class="small stat-neg">${losses.join(' · ') || '—'}</div>
        </div>
      </div>
    </div></div>`;
  });
  html += '</div>';
  if (!ev.valid) html += '<p class="text-warning mt-2">Partial loadout — constraints could not be fully satisfied.</p>';
  if (ev.error !== undefined && document.getElementById('optMode')?.value === 'target') {
    const match = ev.error < SCORE_EPS;
    html += `<p class="small mt-2 ${match ? 'stat-pos' : 'text-warning'}">` +
      (match ? 'All target stats matched (within tolerance).' : `Target mismatch score: ${ev.error.toFixed(2)} — see totals below.`) +
      '</p>';
  }
  if (searchMeta) {
    const effortLabel = { quick: 'Quick', normal: 'Normal', thorough: 'Thorough', deep: 'Deep', extreme: 'Extreme' }[searchMeta.effort] || searchMeta.effort;
    const tries = searchMeta.restarts ?? 0;
    const planned = searchMeta.plannedTries;
    let sm = (searchMeta.candidates)
      ? `Search: ${effortLabel} · ${searchMeta.candidates.toLocaleString()} candidates tried`
      : `Search: ${effortLabel} · ${tries}${planned ? ` / ${planned}` : ''} tries`;
    if (searchMeta.exactMs) sm += ` · exact ${(searchMeta.exactMs / 1000).toFixed(1)}s`;
    if (searchMeta.heuristicMs != null) sm += ` · heuristic ${(searchMeta.heuristicMs / 1000).toFixed(1)}s`;
    else if (searchMeta.heuristicSkipped) sm += ' · heuristic skipped';
    if (searchMeta.budgetMs) sm += ` (budget ${Math.round(searchMeta.budgetMs / 1000)}s)`;
    if (!searchMeta.budgetMs && searchMeta.rounds > 1 && !searchMeta.heuristicSkipped) sm += ` × ${searchMeta.rounds} rounds`;
    if (searchMeta.exact) {
      sm += (searchMeta.exactError !== undefined && searchMeta.exactError <= SCORE_EPS)
        ? ' · exact match' : ' · exact pass (heuristic finish)';
    }
    if (searchMeta.colorExact) sm += ' · exact color match';
    if (searchMeta.smartPool && searchMeta.poolNames) {
      sm += ` · smart pool ${searchMeta.poolNames} Pokémon`;
      if (searchMeta.poolVariants) sm += ` (${searchMeta.poolVariants} variants)`;
    }
    if (searchMeta.worker) sm += ' · background worker';
    html += `<p class="small text-secondary mt-1 mb-0">${sm}</p>`;
  }
  body.innerHTML = html;

  const totals = ev.totals;
  let tHtml = '<table class="table table-sm table-dark mb-2"><tbody>';
  const optsMode = document.getElementById('optMode')?.value;
  const tgtOpts = optsMode === 'target' ? getOpts() : null;
  STATS.forEach(s => {
    const v = totals[s.id] || 0;
    let cls = v > 0 ? 'stat-pos' : v < 0 ? 'stat-neg' : '';
    let extra = '';
    if (tgtOpts?.targetActive[s.id]) {
      const tgt = tgtOpts.targets[s.id];
      const d = statTargetDelta(s.id, v, tgt);
      if (d > 0) {
        cls = 'text-warning';
        extra = ` <span class="text-secondary">(target ${fmtStat(tgt, s.id)})</span>`;
      }
    }
    tHtml += `<tr><td>${s.label}</td><td class="${cls}">${fmtStat(v, s.id)}${extra}</td></tr>`;
  });
  tHtml += '</tbody></table>';
  // ALWAYS show the color-set bonuses the build actually earns, recomputed from
  // its color counts independent of the "include in scoring" toggle (ev.cb is
  // empty when scoring is off). Includes negative bonuses (pink/navy/gray).
  const counts = ev.counts || {};
  const achievedBonuses = colorBonusScore(counts, true);
  if (achievedBonuses.details.length) {
    tHtml += '<p class="small fw-semibold mb-1">Color set bonuses</p><ul class="small mb-0">';
    achievedBonuses.details.forEach(d => {
      const lbl = COLOR_LABELS[d.color] || d.color;
      const val = formatColorBonusValue(d.effect, d.value);
      tHtml += `<li><span class="color-dot c-${d.color}"></span>${lbl}: ×${d.n} (tier ${d.tier}) → ${val}</li>`;
    });
    tHtml += '</ul>';
    if (!document.getElementById('colorBonuses')?.checked) {
      tHtml += '<p class="small text-secondary mb-0">Shown for reference — color bonuses are currently off in scoring.</p>';
    }
  }
  const ct = getColorTargets();
  const countParts = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => {
    const need = ct?.targets?.[c];
    if (need !== undefined) {
      const ok = n === need;
      return `<span class="${ok ? 'stat-pos' : 'stat-neg'}">${c}:${n}/${need}</span>`;
    }
    return `${c}:${n}`;
  });
  tHtml += '<p class="small text-secondary mt-2 mb-0">Color counts: ' + countParts.join(', ') + '</p>';
  if (ct && !colorsMatchTargets(counts, ct)) {
    tHtml += '<p class="small text-warning mb-0">Color targets were not fully met.</p>';
  }
  document.getElementById('totalsBody').innerHTML = tHtml;
}

function runOptimize() {
  const mixed = document.getElementById('mixedGrades')?.checked ?? true;
  const stats = getSearchPoolStats();
  if (!mixed && !stats.viableTiers.length) {
    showOptimizeIssue(
      'Single-tier mode needs at least 10 Pokémon with the same owned grade (all B, all S, or all G). Mark more grades or enable mixed grades.'
    );
    return;
  }
  const candidates = buildCandidates();
  if (candidates) {
    if (candidates.length < 10) {
      showOptimizeIssue(
        'Need at least 10 usable grade options: select more Pokémon, mark grades you own (B/S/G), and check max grade settings.'
      );
      return;
    }
    const uniqueNames = new Set(candidates.map(c => c.name));
    if (uniqueNames.size < 10) {
      showOptimizeIssue(
        `Only ${uniqueNames.size} Pokémon have owned grades — enable more emblems or mark additional B/S/G grades you possess.`
      );
      return;
    }
  }
  if (document.getElementById('optMode').value === 'target') {
    STATS.forEach(s => {
      const inp = document.querySelector(`.target-val[data-stat="${s.id}"]`);
      const raw = (inp?.value ?? '').trim();
      const hasVal = raw !== '' && !isNaN(parseFloat(raw));
      const cb = document.querySelector(`.target-use[data-stat="${s.id}"]`);
      if (cb) cb.checked = hasVal;
    });
  }
  const opts = getOpts();
  const hasMax = opts.mode === 'maximize' && STATS.some(s => opts.priorities[s.id]);
  const hasTgt = opts.mode === 'target' && STATS.some(s => opts.targetActive[s.id]);
  const hasColors = !!opts.colorTargets;
  if (!hasMax && !hasTgt && !hasColors) {
    const msg = opts.mode === 'target'
      ? 'Enter at least one target stat value (e.g. HP, Sp. Atk) in the Target panel, or enable color counts.'
      : 'Enable at least one stat to maximize, set target values, or require color counts.';
    showOptimizeIssue(msg);
    return;
  }
  if (hasTgt) {
    // Lossless per-stat reachability gate (admissible relaxation — only rejects
    // provably-impossible targets). Use the mixed-grade list (a superset of any
    // single tier) so single-tier-feasible targets are never wrongly rejected.
    const gateCands = candidates || buildCandidatesMixed();
    const reachErr = targetReachabilityError(gateCands, opts);
    if (reachErr) {
      showOptimizeIssue(reachErr);
      return;
    }
  }
  if (opts.colorTargets) {
    let colorErr = null;
    if (mixed) {
      colorErr = validateColorTargets(opts.colorTargets, candidates);
    } else {
      for (const tier of GRADE_ORDER) {
        if (GRADE_ORDER.indexOf(tier) > GRADE_ORDER.indexOf(getMaxGrade())) continue;
        const tierCands = buildCandidatesForTier(tier);
        if (new Set(tierCands.map(c => c.name)).size < 10) continue;
        colorErr = validateColorTargets(opts.colorTargets, tierCands);
        if (!colorErr) break;
      }
      if (!colorErr && !stats.viableTiers.length) {
        colorErr = 'Color targets cannot be met at any single grade tier.';
      }
    }
    if (colorErr) {
      showOptimizeIssue(colorErr);
      return;
    }
  }
  if (optimizeRunning) {
    showOptimizeIssue('A search is already running. Use Cancel or wait for it to finish.', 'info');
    return;
  }

  searchCancelToken = { cancelled: false, lastPct: 0 };
  resetSearchTimer();
  showSearchUI(true);
  setSearchProgress(0, 'Starting…');

  (async () => {
    try {
      let result;
      const progress = tickProgress;
      if (mixed) {
        result = await optimizeAsync(candidates, opts, progress);
      } else {
        let best = { loadout: [], ev: { score: -1e12, error: Infinity } };
        const tiers = GRADE_ORDER.filter(t => GRADE_ORDER.indexOf(t) <= GRADE_ORDER.indexOf(getMaxGrade()));
        let ti = 0;
        for (const tier of tiers) {
          checkSearchCancelled();
          const tierCands = buildCandidatesForTier(tier);
          if (new Set(tierCands.map(c => c.name)).size < 10) continue;
          await progress(5 + (ti / tiers.length) * 85, `Searching ${tier} tier…`);
          const res = await optimizeAsync(tierCands, opts, (pct, label) =>
            progress(5 + ((ti + pct / 100) / tiers.length) * 85, label || `${tier} tier`)
          );
          if (isLoadoutBetter(res.ev, best.ev, res.loadout, best.loadout, opts)) best = res;
          ti++;
        }
        result = best;
        if (!result.loadout.length) {
          showOptimizeIssue(
            'Could not build a full loadout at any single grade tier. Try mixed grades or mark more B/S/G ownership.'
          );
          return;
        }
      }
      checkSearchCancelled();
      await progress(100, 'Done');
      renderResults(result);
      if (window.matchMedia('(max-width: 991.98px)').matches) {
        document.getElementById('resultsCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      if (result.searchMeta && document.getElementById('optMode')?.value === 'target' &&
          result.ev?.error > SCORE_EPS && !['deep', 'extreme'].includes(getSearchEffort())) {
        const hint = document.createElement('p');
        hint.className = 'small text-secondary mt-2 mb-0';
        hint.textContent = 'Still off target? Try Search effort: Thorough or Deep, or click Optimize again for another build.';
        document.getElementById('resultsBody')?.appendChild(hint);
      }
    } catch (err) {
      if (err?.name === 'OptimizeCancelled') {
        setSearchProgress(0, 'Search cancelled');
        showOptimizeIssue('Search cancelled. Adjust settings and run Optimize again.', 'info');
        return;
      }
      console.error(err);
      showOptimizeIssue('Optimization failed: ' + (err?.message || err));
    } finally {
      searchCancelToken = null;
      showSearchUI(false);
    }
  })();
}

document.addEventListener('DOMContentLoaded', initUI);
