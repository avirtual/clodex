'use strict';

// Shadow-mode differ between the wire intent path and the JSONL intent
// path. Both sides report every intent sighting; the differ pairs them by
// key and emits artifacts rich enough to judge the cutover — not just
// semantic equality (reviewer condition):
//
//   { type: 'sighting',  source, key, ... }        every report, both sides
//   { type: 'match',     key, first, latencyMs, dupes, ... }
//                        first = which side saw it first; latencyMs = gap
//   { type: 'dupe',      source, key, count }      same side re-reported
//   { type: 'unmatched', source, key, waitedMs, ... }
//                        one side never showed up within the window
//
// The sink receives plain records (timestamped); the caller decides where
// they go (wire-shadow.jsonl). Pure and Electron-free — unit-testable.

class ShadowDiff {
  constructor(sink, opts = {}) {
    this.sink = sink;
    this.windowMs = opts.windowMs ?? 20_000;
    this._pending = new Map(); // key → { source, ts, meta, timer, dupes }
  }

  // source: 'wire' | 'jsonl'. key: stable identity of one intent occurrence
  // (agent + intent shape + body). meta rides into the emitted records.
  record(source, key, meta = {}) {
    const now = Date.now();
    this._emit({ type: 'sighting', source, key, ...meta });
    const p = this._pending.get(key);
    if (p && p.source !== source) {
      clearTimeout(p.timer);
      this._pending.delete(key);
      this._emit({
        type: 'match', key, first: p.source, latencyMs: now - p.ts,
        dupes: p.dupes, ...p.meta, ...meta,
      });
      return;
    }
    if (p) {
      p.dupes += 1;
      this._emit({ type: 'dupe', source, key, count: p.dupes });
      return;
    }
    const entry = { source, ts: now, meta, dupes: 0 };
    entry.timer = setTimeout(() => {
      this._pending.delete(key);
      this._emit({ type: 'unmatched', source, key, waitedMs: this.windowMs, ...meta });
    }, this.windowMs);
    if (entry.timer.unref) entry.timer.unref();
    this._pending.set(key, entry);
  }

  stop() {
    for (const p of this._pending.values()) clearTimeout(p.timer);
    this._pending.clear();
  }

  // A sink exception must never reach the caller's intent path.
  _emit(rec) {
    try { this.sink({ ts: Date.now(), ...rec }); } catch { /* observer only */ }
  }
}

module.exports = { ShadowDiff };
