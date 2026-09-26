'use strict';

const fs = require('fs');
const { RECORD_CAP, recordsOf } = require('./transcript-records');

const MAX_ENTRIES = RECORD_CAP;

function parseTranscript(text, max = MAX_ENTRIES) {
  return recordsOf(text, max).records;
}

const CHANGE_DEBOUNCE_MS = 100;

function createTranscriptSpikeReader({ linkPathFor, watch = fs.watch, onChange = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const cache = new Map();
  let nextRev = 0;

  function drop(name) {
    const c = cache.get(name);
    if (c && c.watcher) { try { c.watcher.close(); } catch {} }
    if (c && c.changeTimer) { clearTimer(c.changeTimer); c.changeTimer = null; }
    cache.delete(name);
  }

  function changed(name, c) {
    c.dirty = true;
    if (!onChange || c.changeTimer || cache.get(name) !== c) return;
    c.changeTimer = setTimer(() => {
      c.changeTimer = null;
      if (cache.get(name) === c) onChange(name);
    }, CHANGE_DEBOUNCE_MS);
  }

  function pull(name) {
    let real;
    try { real = fs.realpathSync(linkPathFor(name)); } catch { drop(name); return { ok: false, reason: 'unavailable' }; }
    let c = cache.get(name);
    if (c && c.path !== real) { drop(name); c = null; }
    if (!c) {
      c = { path: real, rev: nextRev, dirty: true, sig: null, records: [], watcher: null, changeTimer: null };
      try {
        c.watcher = watch(real, () => changed(name, c));
        if (c.watcher && typeof c.watcher.on === 'function') c.watcher.on('error', () => changed(name, c));
      } catch {}
      cache.set(name, c);
    }
    if (c.dirty || !c.watcher) {
      let sig;
      let text = null;
      try {
        const st = fs.statSync(real);
        sig = `${st.size}:${st.mtimeMs}`;
        if (sig !== c.sig) text = fs.readFileSync(real, 'utf8');
      } catch { drop(name); return { ok: false, reason: 'unreadable' }; }
      c.dirty = false;
      if (text !== null) {
        c.sig = sig;
        c.records = parseTranscript(text);
        c.rev = ++nextRev;
      }
    }
    return { ok: true, rev: c.rev, records: c.records };
  }

  function dispose() { for (const name of [...cache.keys()]) drop(name); }

  return { pull, drop, dispose };
}

module.exports = { MAX_ENTRIES, CHANGE_DEBOUNCE_MS, parseTranscript, createTranscriptSpikeReader };
