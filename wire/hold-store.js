'use strict';

// wire/hold-store.js — the ONLY thing about a keep-warm hold that touches disk.
//
// A ping is a replay of the session's own last request (wire/hold.js header),
// so the bytes it replays are conversation content and the headers it replays
// carry a bearer token. That is why this is a separate module with one job: the
// keeper stays in-memory by design, and every rule about what may be written
// lives here rather than being spread through it.
//
// WHAT MAY BE WRITTEN: entries for seats holding PERPETUALLY (keepWarmAlways)
// and nothing else. The keeper's entry map is capped at 2000 (maxEntries) and
// spilling it here would put every conversation that crossed the wire on disk
// to fix a bug about a handful of armed seats. A timed hold is deliberately not
// covered: it re-arms on the seat's next turn, and a seat with a deadline is an
// attended seat that will have one.
//
// WHERE: the caller passes an absolute path under the app's userData dir. NOT
// ~/.clodex/run/<name>/ — cleanupClaudeHook rm -rf's that on every exit path,
// so anything that must outlive a restart cannot live there (clodex-paths.js's
// header is the authority on that split).
//
// MODE 0600, and re-asserted on every write: atomicWriteFileSync creates its
// temp with 0600 but an operator's umask or a file restored from a backup could
// leave an existing path more open, and the rename keeps the TEMP's mode only
// because the temp is what gets renamed. The explicit chmod costs one syscall
// and removes the question.
//
// NOT LOGGED, EVER. Callers pass an onError that receives a MESSAGE, never a
// record — the shadow log must not gain a line carrying request bytes or an
// authorization header. Every failure here is swallowed into that callback:
// losing restart-survival is a degradation, breaking the keeper is an outage.

const fs = require('fs');
const { atomicWriteFileSync, readJsonSafe } = require('../fs-util');

const FORMAT = 1;

class HoldEntryStore {
  // opts:
  //   path     absolute file path (REQUIRED)
  //   onError  (message:string) => void — message only, never the record
  constructor(opts = {}) {
    if (!opts.path) throw new Error('HoldEntryStore needs a path');
    this.path = opts.path;
    this._onError = opts.onError || (() => {});
  }

  // records: [{ sessionId, obj, headers, url, ts }]
  // An empty list REMOVES the file rather than writing `[]`: the point of the
  // file is to hold a token, so not having one to hold means not having a file.
  save(records) {
    try {
      if (!Array.isArray(records) || !records.length) return this.clear();
      atomicWriteFileSync(this.path, JSON.stringify({ format: FORMAT, records }));
      try { fs.chmodSync(this.path, 0o600); } catch { /* best effort, see header */ }
      return true;
    } catch (e) {
      this._onError(`hold entry save failed: ${e.message}`);
      return false;
    }
  }

  // Returns [] for every failure mode — absent file, unparseable JSON, a
  // format from a future version. A hold that does not survive the restart is
  // the bug this fixes; a hold that resumes off bytes we cannot read is worse.
  load() {
    try {
      const j = readJsonSafe(this.path);
      if (!j || j.format !== FORMAT || !Array.isArray(j.records)) return [];
      return j.records.filter((r) => r && r.sessionId && r.obj && typeof r.obj === 'object');
    } catch (e) {
      this._onError(`hold entry load failed: ${e.message}`);
      return [];
    }
  }

  clear() {
    try { fs.unlinkSync(this.path); } catch { /* absent is the goal state */ }
    return true;
  }
}

module.exports = { HoldEntryStore, FORMAT };
