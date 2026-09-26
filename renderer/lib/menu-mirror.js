'use strict';

const { PASTE_OPEN, PASTE_CLOSE } = require('./composer-voice');

const BACKSPACE = '\x7f';
const ESCAPE = '\x1b';
const MIRROR_DRAFT = /^\/\S*$/u;
const ARROWS = { ArrowDown: '\x1b[B', ArrowUp: '\x1b[A' };

const isMirrorDraft = (text) => typeof text === 'string' && MIRROR_DRAFT.test(text);
const paste = (text) => `${PASTE_OPEN}${text}${PASTE_CLOSE}`;
const lengthOf = (text) => Array.from(text).length;
const completionOf = (name) => String(name || '').split(/\s/u)[0];

function createMenuMirror() {
  let on = false;
  let sent = '';
  let slack = 0;
  let read = null;

  const hasRows = () => !!(read && Array.isArray(read.rows) && read.rows.length > 0);

  function reset() {
    on = false;
    sent = '';
    slack = 0;
    read = null;
  }

  function erase() {
    return BACKSPACE.repeat(lengthOf(sent) + slack);
  }

  function draft(text) {
    const next = String(text == null ? '' : text);
    if (!isMirrorDraft(next)) {
      if (!on) return [];
      const writes = [erase()];
      reset();
      return writes;
    }
    if (!on) {
      on = true;
      sent = next;
      slack = 0;
      return [paste(next)];
    }
    if (next === sent) return [];
    const prev = sent;
    sent = next;
    if (!slack && next.startsWith(prev) && lengthOf(next) === lengthOf(prev) + 1) return [next.slice(prev.length)];
    if (!slack && prev.startsWith(next) && lengthOf(prev) === lengthOf(next) + 1) return [BACKSPACE];
    const writes = [BACKSPACE.repeat(lengthOf(prev) + slack), paste(next)];
    slack = 0;
    return writes;
  }

  function submit() {
    reset();
    return ['\r'];
  }

  function key(e) {
    if (!on || !e || e.isComposing || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return null;
    if (ARROWS[e.key]) return hasRows() ? { writes: [ARROWS[e.key]] } : null;
    if (e.key === 'Tab') {
      if (!hasRows()) return { writes: [] };
      const row = read.rows.find((r) => r.selected) || read.rows[0];
      sent = completionOf(row.name);
      slack = 1;
      return { writes: ['\t'], draft: sent };
    }
    if (e.key === 'Escape') return { writes: [ESCAPE] };
    if (e.key === 'Enter') {
      const row = hasRows() ? read.rows.find((r) => r.selected) : null;
      const command = row ? completionOf(row.name) : sent;
      return { writes: submit(), draft: '', command };
    }
    return null;
  }

  return {
    on: () => on,
    sent: () => sent,
    hasRows,
    read: () => read,
    setRead(result) { read = on ? result || null : null; },
    draft,
    key,
    submit,
    dispose: reset,
  };
}

module.exports = { BACKSPACE, isMirrorDraft, createMenuMirror };
