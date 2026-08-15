'use strict';

// wire/shadow-log.js — the sink behind SessionManager._shadowLog, plus its
// retention. Pure (fs/path/now injected), Electron-free, unit-testable.
//
// RETENTION IS SPLIT BY RECORD TYPE, NOT BY AGE ALONE, because the volumes are
// two orders of magnitude apart. Measured over 43.6 days at 77181d4: 225,344
// records / 61.6MB, of which four types are 99.4% of the bytes and everything
// else projects to ~3.4MB/YEAR. So:
//
//   bulk  → wire-shadow.jsonl       14-day window   (~26MB steady state)
//   diag  → wire-shadow-diag.jsonl  kept forever    (~3.4MB/yr)
//
// 14 days, not 7: the one analysis this log has ever paid for used 58,659
// samples, which at 5,168 records/day is ~11 days. A 7-day window would have
// destroyed the evidence for the only thing the log has been worth.
//
// UNKNOWN TYPES ARE DIAGNOSTICS. BULK_TYPES is a closed allow-list; anything
// not on it is kept forever. This direction is deliberate and asymmetric: a new
// type is far more likely to be a new rare diagnostic than a new high-volume
// stream, keeping a wrongly-classified one costs bytes the size cap already
// bounds, and classifying a rare one as bulk DELETES exactly the evidence this
// log exists for. Adding a type here is a decision to lose it after 14 days.
//
// THE SIZE CAPS ARE A BACKSTOP, NOT THE PRIMARY CONTROL. A time window does not
// bound a pathological day — a wire failure loop emits orders of magnitude above
// the 4.07MB peak day in an hour. They sit ~4x above steady state so they never
// fire in normal operation.
//
// OBSERVER-GRADE, AND ROTATION MUST NOT CHANGE THAT. append() stays
// fs.appendFile with a swallowed callback: never synchronous, never throwing,
// never blocking a turn. The rotation check is throttled, runs off the hot path,
// and every failure path in it is swallowed too — a rotation that cannot run
// leaves the log growing, which is strictly better than a log that can break a
// turn.
//
// CRASH SAFETY: filter → tmp → atomic rename, with no in-memory hold buffer.
// Records appended DURING a compaction (by us or by a second instance, since
// ~/.clodex is shared) are copied onto the tmp file as raw bytes and the size is
// re-checked until stable, so a concurrent writer is not silently truncated. A
// crash at any point before the rename leaves the ORIGINAL untouched: the
// rotation is lost, never the data. The residual window is an append landing
// between the last stable-size check and the rename itself — sub-millisecond,
// against a ~0.06 records/second arrival rate. Closing it fully would need a
// lock file across instances, which is a lot of machinery for a forensic log.

const BULK_FILE = 'wire-shadow.jsonl';
const DIAG_FILE = 'wire-shadow-diag.jsonl';

// The four measured high-volume types, and ONLY those. See the header before
// adding one: membership here means "delete after 14 days".
const BULK_TYPES = new Set([
  'wire-telemetry-diff',
  'wire-turn',
  'wire-hold',
  'autocompact-suppressed',
]);

const BULK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const BULK_MAX_BYTES = 100 * 1024 * 1024;
const DIAG_MAX_BYTES = 64 * 1024 * 1024;

// A trim drops to half the cap rather than to the cap, so the next check does
// not immediately re-trim — without the gap a file parked at the cap rewrites
// itself every interval forever.
const TRIM_TARGET_RATIO = 0.5;

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Past this we do not parse at all: a runaway can outrun a 15-minute check by
// gigabytes, and readFile would blow memory or hit Node's buffer ceiling. The
// backstop then keeps the newest TRIM_TARGET bytes verbatim and skips
// classification — a runaway is not the case to spend care on.
const HARD_READ_LIMIT = 256 * 1024 * 1024;

// Bounds the stable-tail loop. A writer that keeps the file growing through
// this many rounds is the runaway case; we copy the final tail and rename
// anyway rather than spinning.
const TAIL_ROUNDS = 5;

function isBulkType(type) {
  return BULK_TYPES.has(type);
}

// ts absent or unparseable ⇒ UNDATABLE ⇒ keep. _shadowLog always stamps ts, so
// a missing one means corruption or a hand edit, and nothing can say whether an
// undatable record is inside the window. The size cap still bounds them.
//
// A line that will not parse AT ALL has no type either, so it takes the same
// route every unknown type takes and lands in the diag lane — kept forever
// rather than aged out on a guess. That is the safe direction: a torn line is
// evidence of the kind of failure this log exists to record.
function tsOf(line) {
  try {
    const rec = JSON.parse(line);
    return { ok: true, ts: typeof rec.ts === 'number' ? rec.ts : null, type: rec.type };
  } catch {
    return { ok: false, ts: null, type: undefined };
  }
}

class ShadowLog {
  // deps: { fs, path, dir, now }. `fs` needs appendFile (callback form, for the
  // hot path) and `.promises`.
  constructor({ fs, path, dir, now = Date.now } = {}) {
    this._fs = fs;
    this._path = path;
    this._dir = dir;
    this._now = now;
    this._lastCheck = 0;
    this._rotating = false;
  }

  bulkPath() { return this._path.join(this._dir, BULK_FILE); }
  diagPath() { return this._path.join(this._dir, DIAG_FILE); }

  // THE HOT PATH. Must stay non-throwing and non-blocking; see header.
  append(rec) {
    try {
      const payload = { ts: this._now(), ...rec };
      const target = isBulkType(payload.type) ? this.bulkPath() : this.diagPath();
      this._fs.appendFile(target, JSON.stringify(payload) + '\n', () => {});
      this._maybeRotate();
    } catch { /* shadow only — never surfaces */ }
  }

  // Throttled, fire-and-forget. The FIRST append in a process always checks:
  // that is what makes an already-oversized log start shrinking at launch
  // rather than 15 minutes in.
  _maybeRotate() {
    if (this._rotating) return;
    const now = this._now();
    if (this._lastCheck !== 0 && now - this._lastCheck < CHECK_INTERVAL_MS) return;
    this._lastCheck = now;
    this._rotating = true;
    Promise.resolve()
      .then(() => this.rotate())
      .catch(() => {})
      .then(() => { this._rotating = false; }, () => { this._rotating = false; });
  }

  // Returns a per-lane report; callers other than tests ignore it.
  async rotate() {
    const cutoff = this._now() - BULK_MAX_AGE_MS;
    const bulk = await this._compact(this.bulkPath(), {
      cutoff,
      maxBytes: BULK_MAX_BYTES,
      // Diagnostics found in the bulk lane are MOVED, not dropped. The legacy
      // file is one mixed stream, so the first compaction after an upgrade is
      // also the migration — without this it would delete 43 days of the rare
      // records the split exists to preserve.
      spill: this.diagPath(),
    });
    const diag = await this._compact(this.diagPath(), {
      cutoff: null,
      maxBytes: DIAG_MAX_BYTES,
      spill: null,
    });
    return { bulk, diag };
  }

  async _compact(file, { cutoff, maxBytes, spill }) {
    const fsp = this._fs.promises;
    let size;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      return null; // no file yet — nothing to retain
    }
    if (size === 0) return null;

    const oversize = size > maxBytes;
    if (!oversize && !(await this._hasExpiredHead(file, cutoff))) return null;

    const target = Math.floor(maxBytes * TRIM_TARGET_RATIO);
    const tmp = file + '.rot';
    let kept;
    let report;

    if (size > HARD_READ_LIMIT) {
      kept = await this._readRange(file, Math.max(0, size - target), size);
      const nl = kept.indexOf(0x0a); // drop the leading partial record
      kept = nl === -1 ? Buffer.alloc(0) : kept.subarray(nl + 1);
      report = { runaway: true, keptBytes: kept.length, droppedBytes: size - kept.length };
    } else {
      const raw = await fsp.readFile(file);
      size = raw.length; // what we actually consumed, not what stat guessed
      const res = this._filter(raw, cutoff, !!spill);
      if (spill && res.spilled.length) {
        try { await fsp.appendFile(spill, res.spilled.join('')); } catch { /* keep going */ }
      }
      kept = Buffer.from(res.kept.join(''), 'utf8');
      if (kept.length > maxBytes) kept = trimFront(kept, target);
      report = { runaway: false, kept: res.keptCount, dropped: res.droppedCount, spilled: res.spilled.length };
    }

    try {
      await fsp.writeFile(tmp, kept);
      // Stable-tail: copy anything appended while we were filtering, then
      // re-check, so a concurrent writer's records ride onto the new file
      // instead of being cut off by the rename.
      let consumed = size;
      for (let i = 0; i < TAIL_ROUNDS; i++) {
        let now;
        try { now = (await fsp.stat(file)).size; } catch { break; }
        if (now <= consumed) break;
        await fsp.appendFile(tmp, await this._readRange(file, consumed, now));
        consumed = now;
      }
      await fsp.rename(tmp, file);
    } catch {
      try { await fsp.unlink(tmp); } catch { /* best effort */ }
      return null;
    }
    return report;
  }

  // Cheap age probe: reads only the first record, so the common "nothing has
  // expired" answer costs one small read rather than a full parse of a 26MB
  // file every 15 minutes.
  //
  // ASSUMES THE FILE IS APPEND-ORDERED BY ts, which it is by construction —
  // append() stamps ts at write time and only ever appends. If a clock jump
  // ever put a fresh record at the head of an otherwise-stale file, the effect
  // is a DELAYED compaction, not a wrong one: the filter still judges every
  // record on its own ts, and the next check after the head expires does the
  // work. The size backstop is unaffected either way, since it is checked
  // before this probe.
  async _hasExpiredHead(file, cutoff) {
    if (cutoff == null) return false;
    let head;
    try {
      head = (await this._readRange(file, 0, 4096)).toString('utf8');
    } catch {
      return false;
    }
    const nl = head.indexOf('\n');
    if (nl === -1) return false;
    const { ts } = tsOf(head.slice(0, nl));
    return ts != null && ts < cutoff;
  }

  async _readRange(file, from, to) {
    const fh = await this._fs.promises.open(file, 'r');
    try {
      const len = Math.max(0, to - from);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, from);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  _filter(raw, cutoff, splitting) {
    const kept = [];
    const spilled = [];
    let droppedCount = 0;
    const text = raw.toString('utf8');
    // A trailing partial record (a writer mid-append) has no newline yet; it is
    // NOT dropped — it rides through as-is and the rest arrives on the tail copy.
    const lines = text.split('\n');
    const tail = lines.pop();
    for (const line of lines) {
      if (line === '') continue;
      const { ts, type } = tsOf(line);
      if (splitting && !isBulkType(type)) { spilled.push(line + '\n'); continue; }
      if (cutoff != null && isBulkType(type) && ts != null && ts < cutoff) { droppedCount++; continue; }
      kept.push(line + '\n');
    }
    if (tail) kept.push(tail);
    return { kept, spilled, keptCount: kept.length, droppedCount };
  }
}

// Drop whole records off the front until under `target`, newest kept.
function trimFront(buf, target) {
  if (buf.length <= target) return buf;
  const from = buf.length - target;
  const nl = buf.indexOf(0x0a, from);
  return nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1);
}

module.exports = {
  ShadowLog,
  isBulkType,
  BULK_FILE,
  DIAG_FILE,
  BULK_TYPES,
  BULK_MAX_AGE_MS,
  BULK_MAX_BYTES,
  DIAG_MAX_BYTES,
  CHECK_INTERVAL_MS,
};
