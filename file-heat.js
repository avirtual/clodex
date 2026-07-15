// file-heat.js — the boiling pot's tier-1 producer (docs/boiling-pot-plan.md).
// Per-file read/edit heat, day-bucketed, N-day rolling, persisted as ONE json
// per agent at run/<name>/file-heat.json. Pure leaf + a thin factory: the record/
// prune/aggregate/estimate math is electron-free and I/O-free (unit-tested against
// plain objects); the factory adds lazy load, debounced atomic flush (fs-util),
// and fs.promises.stat for the byte weight. NOT in the leak-scanner SCANNED lists
// (clodex-paths pattern — a leaf, not a coordinator extraction).
//
// WHAT WE OPTIMIZE (operator framing): tokens CARRIED in expensive contexts, not
// read COUNTS. So `approxReadTokens` accumulates every read's slice weight —
// a file walked slice-by-slice (session-manager.js read 95× at 95 distinct
// ranges) accumulates carriage each time, which is exactly the grok-skill
// targeting signal. `segments` (distinct ranges over the window) makes that
// walking legible and distinguishes it from the SAME-range re-reading that tier 2
// classifies as redundancy — tier 1 never attempts redundancy (that needs the
// request bodies; redundantReads/redundantTokens stay null here, filled by the
// wirescope-linked tier 2, sinceCompact all-or-nothing).
'use strict';

const fsp = require('fs').promises;
const { atomicWriteFileSync, readJsonSafe } = require('./fs-util');

// Token weight is a RANKING estimate, never a billing number: bytes/4 for a whole
// file, a line-slice approximation when the Read carried offset/limit. The Read
// tool's offset/limit are LINE numbers (default limit 2000 lines); with only
// fs.stat bytes on hand we convert lines→bytes through a nominal average. Honest
// enough to rank; documented as approximate.
const BYTES_PER_TOKEN = 4;
const AVG_BYTES_PER_LINE = 40;
const DEFAULT_READ_LIMIT = 2000;      // Read tool's default line cap
const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_FLUSH_MS = 30_000;      // debounce floor (spec: ≥30s)
const MAX_RANGES_PER_FILE_DAY = 256;  // bound the per-day distinct-range set
const DAY_MS = 86_400_000;
const STATE_VERSION = 1;

// UTC day bucket 'YYYY-MM-DD'. UTC (not local) so buckets are deterministic
// regardless of the host timezone — day granularity over a 14-day window doesn't
// need local-midnight precision, and it keeps the math testable.
function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// A read's ranking weight from the file's byte size + the request's offset/limit.
// null bytes (stat failed) → null weight (uncounted, honestly). Empty file → 0.
function estimateReadTokens(bytes, offset, limit) {
  if (bytes == null || !(bytes >= 0)) return null;
  const whole = Math.ceil(bytes / BYTES_PER_TOKEN);
  const ranged = (Number.isInteger(offset) && offset > 0) || (Number.isInteger(limit) && limit > 0);
  if (!ranged) return whole;
  const effLines = (Number.isInteger(limit) && limit > 0) ? limit : DEFAULT_READ_LIMIT;
  const sliceBytes = Math.min(bytes, effLines * AVG_BYTES_PER_LINE);
  return Math.ceil(sliceBytes / BYTES_PER_TOKEN);
}

// Stable signature for a read's range — 'full' for a whole-file read, else the
// offset:limit pair (either side blank when absent). Distinct sigs = segments.
function rangeSig(offset, limit) {
  const hasO = Number.isInteger(offset) && offset > 0;
  const hasL = Number.isInteger(limit) && limit > 0;
  if (!hasO && !hasL) return 'full';
  return `${hasO ? offset : ''}:${hasL ? limit : ''}`;
}

function emptyState() { return { version: STATE_VERSION, days: {} }; }

// A stored state that isn't our shape (corrupt / older / null) → start empty.
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.days || typeof raw.days !== 'object') return emptyState();
  return { version: STATE_VERSION, days: raw.days };
}

// Fold one event into a state's day bucket (mutates). kind 'read' accumulates
// carriage (tokens) + a distinct-range sig; kind 'edit' bumps the edit count.
function recordInto(state, { file, kind, tokens, sig }, ts) {
  if (!file) return;
  const key = dateKey(ts);
  const day = (state.days[key] ||= {});
  const f = (day[file] ||= { reads: 0, edits: 0, tokens: 0, ranges: [] });
  if (kind === 'edit') { f.edits += 1; return; }
  // kind === 'read'
  f.reads += 1;
  if (typeof tokens === 'number' && tokens > 0) f.tokens += tokens;
  if (sig && !f.ranges.includes(sig) && f.ranges.length < MAX_RANGES_PER_FILE_DAY) f.ranges.push(sig);
}

// Drop day buckets older than the keepDays window (inclusive of today). String
// compare works on 'YYYY-MM-DD'. Mutates + returns the state.
function pruneDays(state, keepDays, nowTs) {
  const cutoff = dateKey(nowTs - (Math.max(1, keepDays) - 1) * DAY_MS);
  for (const key of Object.keys(state.days)) {
    if (key < cutoff) delete state.days[key];
  }
  return state;
}

// Read-time aggregation across one OR MORE states (per-agent files merge here,
// never at write time — no shared-write contention). Sums reads/edits/carriage
// per file, unions ranges into a segment count, and ranks by approxReadTokens
// DESC (carriage, not read count — the operator framing). tier-2 columns stay
// null. Returns { window, files: [record…] }.
function aggregateStates(states, { now = Date.now(), topN = 10, keepDays = DEFAULT_KEEP_DAYS } = {}) {
  const cutoff = dateKey(now - (Math.max(1, keepDays) - 1) * DAY_MS);
  const acc = new Map(); // file -> { reads, edits, tokens, ranges:Set, firstDay, lastDay }
  for (const state of (Array.isArray(states) ? states : [states])) {
    const days = (state && state.days) || {};
    for (const key of Object.keys(days)) {
      if (key < cutoff) continue; // honor the window even if a state wasn't pruned
      const day = days[key] || {};
      for (const file of Object.keys(day)) {
        const e = day[file];
        if (!e) continue;
        let a = acc.get(file);
        if (!a) { a = { reads: 0, edits: 0, tokens: 0, ranges: new Set(), firstDay: key, lastDay: key }; acc.set(file, a); }
        a.reads += e.reads || 0;
        a.edits += e.edits || 0;
        a.tokens += e.tokens || 0;
        for (const sig of (Array.isArray(e.ranges) ? e.ranges : [])) a.ranges.add(sig);
        if (key < a.firstDay) a.firstDay = key;
        if (key > a.lastDay) a.lastDay = key;
      }
    }
  }
  const files = [...acc.entries()].map(([file, a]) => ({
    file,
    window: { from: a.firstDay, to: a.lastDay },
    reads: a.reads,
    edits: a.edits,
    approxReadTokens: a.tokens,
    segments: a.ranges.size,          // distinct ranges — the walk-vs-reread signal
    redundantReads: null,             // tier 2 (wirescope-linked) fills these
    redundantTokens: null,
    lastSuggestion: null,             // no suggestions engine in v1
  }));
  // Carriage-ranked; ties broken by reads then path so the order is stable.
  files.sort((x, y) => (y.approxReadTokens - x.approxReadTokens)
    || (y.reads - x.reads)
    || (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
  const top = Number.isInteger(topN) && topN > 0 ? files.slice(0, topN) : files;
  return { window: { from: cutoff, to: dateKey(now) }, files: top };
}

// ── Factory ─────────────────────────────────────────────────────────────────
// Per-agent recorder: lazy load, debounced atomic flush, async stat for the byte
// weight. `filePath` is the resolved run/<name>/file-heat.json (caller uses
// clodex-paths.pathFor). Injected seams keep it unit-testable with no real FS.
function createFileHeat(deps = {}) {
  const filePath = deps.filePath;
  const now = deps.now || Date.now;
  const keepDays = Number.isInteger(deps.keepDays) ? deps.keepDays : DEFAULT_KEEP_DAYS;
  const flushMs = Number.isInteger(deps.flushMs) ? deps.flushMs : DEFAULT_FLUSH_MS;
  // stat → byte size, or null on any error (a read we can't weigh still counts,
  // with a null token contribution — honest, per the spec).
  const statBytes = deps.statBytes || (async (p) => {
    try { const st = await fsp.stat(p); return st.isFile() ? st.size : null; } catch { return null; }
  });
  const read = deps.read || (() => readJsonSafe(filePath));
  const write = deps.write || ((state) => atomicWriteFileSync(filePath, JSON.stringify(state)));
  const setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const clearTimer = deps.clearTimer || clearTimeout;

  let state = null;      // loaded lazily
  let dirty = false;
  let timer = null;

  function ensureLoaded() {
    if (state) return state;
    state = normalizeState(read());
    pruneDays(state, keepDays, now());
    return state;
  }

  function scheduleFlush() {
    dirty = true;
    if (timer) return;
    timer = setTimer(() => { timer = null; flush(); }, flushMs);
  }

  function flush() {
    if (timer) { clearTimer(timer); timer = null; }
    if (!state || !dirty) return;
    pruneDays(state, keepDays, now());
    try { write(state); dirty = false; } catch { /* best-effort; retried next flush */ }
  }

  async function recordRead(path, offset, limit) {
    if (!path) return;
    ensureLoaded();
    const bytes = await statBytes(path);
    const tokens = estimateReadTokens(bytes, offset, limit);
    recordInto(state, { file: path, kind: 'read', tokens, sig: rangeSig(offset, limit) }, now());
    scheduleFlush();
  }

  function recordEdit(path) {
    if (!path) return;
    ensureLoaded();
    recordInto(state, { file: path, kind: 'edit' }, now());
    scheduleFlush();
  }

  // The agent's own ranked view (cross-agent merge is the surface's job, over
  // several loaded states). Prunes first so a stale bucket never ranks.
  function snapshot(topN) {
    ensureLoaded();
    pruneDays(state, keepDays, now());
    return aggregateStates([state], { now: now(), topN, keepDays });
  }

  function close() { flush(); }

  return { recordRead, recordEdit, snapshot, flush, close, _state: () => state };
}

module.exports = {
  createFileHeat,
  // pure leaf surface (exported for the tier-1 tests + the read-time aggregator)
  dateKey, estimateReadTokens, rangeSig, emptyState, normalizeState,
  recordInto, pruneDays, aggregateStates,
  DEFAULT_KEEP_DAYS, DEFAULT_FLUSH_MS, MAX_RANGES_PER_FILE_DAY,
  BYTES_PER_TOKEN, AVG_BYTES_PER_LINE, DEFAULT_READ_LIMIT,
};
