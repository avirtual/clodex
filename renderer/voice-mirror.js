'use strict';

const { readRowsToCursor } = require('./lib/cursor-row');
const { composerHasDraft, composerIsEmpty, composerContinues } = require('./lib/voice-submit');

const HEAD = /^[❯>][  ]/u;
const TAIL_JUNK = /[\s█]+$/u;

function draftFromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const parts = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (typeof row !== 'string') return null;
    if (composerIsEmpty(row)) return parts.length ? null : '';
    if (composerHasDraft(row)) {
      parts.unshift(row.replace(HEAD, ''));
      return parts.join(' ').replace(TAIL_JUNK, '').trim();
    }
    if (!composerContinues(row)) return null;
    parts.unshift(row.slice(2));
  }
  return null;
}

function createVoiceMirror(terminal, { onDraft, onRelease = () => {}, readRows = () => readRowsToCursor(terminal) } = {}) {
  let armed = false;
  let disposed = false;
  let baseline = '';
  let last = null;
  let releasing = false;

  function read() {
    try {
      if (terminal.buffer.active.type !== 'normal') return null;
      return draftFromRows(readRows());
    } catch { return null; }
  }

  function check() {
    if (!armed || disposed) return;
    const draft = read();
    if (draft === '' && releasing && last !== null) {
      armed = false;
      releasing = false;
      try { onRelease(); } catch {}
      return;
    }
    if (!draft) return;
    let text = draft;
    if (baseline && text.startsWith(baseline)) text = text.slice(baseline.length).trim();
    if (!text || text === last) return;
    last = text;
    try { onDraft(text); } catch {}
  }

  const sub = typeof terminal.onWriteParsed === 'function' ? terminal.onWriteParsed(check) : null;

  return {
    arm() {
      baseline = read() || '';
      last = null;
      releasing = false;
      armed = true;
    },
    release() { if (armed) releasing = true; },
    disarm() { armed = false; releasing = false; },
    isArmed: () => armed,
    check,
    dispose() {
      disposed = true;
      armed = false;
      try { if (sub) sub.dispose(); } catch {}
    },
  };
}

module.exports = { createVoiceMirror, draftFromRows };
