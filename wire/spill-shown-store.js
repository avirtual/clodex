'use strict';

const fs = require('fs');
const { atomicWriteFileSync, readJsonSafe } = require('../fs-util');

const FORMAT = 1;

class SpillShownStore {
  constructor(opts = {}) {
    if (!opts.path) throw new Error('SpillShownStore needs a path');
    this.path = opts.path;
    this._onError = opts.onError || (() => {});
  }

  save(records) {
    try {
      if (!records || typeof records !== 'object' || !Object.keys(records).length) return this.clear();
      atomicWriteFileSync(this.path, JSON.stringify({ format: FORMAT, records }));
      try { fs.chmodSync(this.path, 0o600); } catch {}
      return true;
    } catch (e) {
      this._onError(`spill shown save failed: ${e.message}`);
      return false;
    }
  }

  load() {
    try {
      const j = readJsonSafe(this.path);
      if (!j || j.format !== FORMAT || !j.records || typeof j.records !== 'object' || Array.isArray(j.records)) return {};
      const out = {};
      for (const [agent, r] of Object.entries(j.records)) {
        if (!r || !Array.isArray(r.shown)) continue;
        out[agent] = {
          shown: r.shown.filter((k) => typeof k === 'string'),
          sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
          lastAt: Number.isFinite(r.lastAt) ? r.lastAt : 0,
        };
      }
      return out;
    } catch (e) {
      this._onError(`spill shown load failed: ${e.message}`);
      return {};
    }
  }

  clear() {
    try { fs.unlinkSync(this.path); } catch {}
    return true;
  }
}

module.exports = { SpillShownStore, FORMAT };
