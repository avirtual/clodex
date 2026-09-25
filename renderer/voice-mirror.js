'use strict';

const { readRowsToCursor } = require('./lib/cursor-row');
const { composerHasDraft, composerIsEmpty, composerContinues, recordingObserved, processingObserved } = require('./lib/voice-submit');

const HEAD = /^[❯>][  ]/u;
const TAIL_JUNK = /[\s\u2581-\u2588]+$/u;

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

function createVoiceMirror(terminal, { onDraft, onRelease = () => {}, readRows = () => readRowsToCursor(terminal), trace = () => {} } = {}) {
  let armed = false;
  let disposed = false;
  let baseline = '';
  let last = null;
  let releasing = false;
  const note = (line) => { try { trace(line); } catch {} };

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
      note('mirror row cleared, released');
      try { onRelease(); } catch {}
      return;
    }
    if (draft === '' && baseline) { note('mirror baseline dropped: row cleared'); baseline = ''; }
    if (!draft) return;
    let text = draft;
    if (baseline) {
      if (text.startsWith(baseline)) text = text.slice(baseline.length).trim();
      else { note('mirror baseline dropped: row no longer extends it'); baseline = ''; }
    }
    if (!text || text === last) return;
    last = text;
    note(`mirror draft ${JSON.stringify(text)}`);
    try { onDraft(text); } catch {}
  }

  const sub = typeof terminal.onWriteParsed === 'function' ? terminal.onWriteParsed(check) : null;

  return {
    arm() {
      baseline = read() || '';
      last = null;
      releasing = false;
      armed = true;
      note(`mirror arm baseline=${JSON.stringify(baseline)}`);
    },
    release() { if (armed) releasing = true; note(`mirror release armed=${armed}`); },
    disarm() { if (armed) note('mirror disarm'); armed = false; releasing = false; },
    isArmed: () => armed,
    check,
    dispose() {
      disposed = true;
      armed = false;
      try { if (sub) sub.dispose(); } catch {}
    },
  };
}

function readFooterRows(terminal) {
  try {
    const buf = terminal.buffer.active;
    const out = [];
    for (let y = buf.cursorY; y < terminal.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      if (line) out.push(line.translateToString(true));
    }
    return out;
  } catch { return null; }
}

function engineObserved(view) {
  if (!view || !view.terminal) return null;
  const rows = readFooterRows(view.terminal);
  if (!rows) return null;
  return { recording: recordingObserved(rows), processing: processingObserved(rows) };
}

module.exports = { createVoiceMirror, draftFromRows, engineObserved };
