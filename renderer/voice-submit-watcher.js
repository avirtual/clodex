// voice-submit-watcher.js — watch one terminal's composer and submit it when a
// draft ends with the configured trigger phrase. One instance per local Claude
// terminal.
//
// The composer is SCREEN STATE: the CLI redraws its input box with ANSI, so the
// text is read out of the buffer rather than reassembled from the PTY stream,
// which carries the redraws and not the contents.
//
// Every decision except "where is the cursor" lives in lib/voice-submit.js;
// this half owns the buffer read, the quiet window and the two writes.
//
// The read is ONE row. The latch keys on that row's content, so an identical
// repaint stays answered and a changed draft re-arms.

const { findSubmit, shouldFire } = require('./lib/voice-submit');

// The quiet window. Streamed transcription lands in segments, so a fire on the
// first write that completes the phrase submits half an utterance. Shorter than
// inject-queue's 2s INJECT_QUIET_MS, which waits out a HUMAN typing; this waits
// out a gap between machine-emitted segments.
const QUIET_MS = 1200;

// The Enter is a separate write from the backspaces for the reason inject-queue
// documents at CTRLU_SETTLE_MS: one chunk carrying control chars and a trailing
// \r is read as a single paste-like event, which leaves the \r in the buffer as
// a literal instead of submitting. Merging these two writes reintroduces that.
const ENTER_SETTLE_MS = 30;

function createVoiceSubmitWatcher(terminal, {
  getConfig, getAttention, write, quietMs = QUIET_MS,
}) {
  let timer = null;
  let enterTimer = null;
  let disposed = false;
  // The composer CONTENT a match was already answered for, not a bare boolean.
  // A boolean makes a second deliberate "over and out" dead for the rest of the
  // draft: the composer still ends with the phrase, so the latch still holds.
  // Keying on the content re-arms when the draft CHANGES — which a repaint of
  // the same text does not do, so the stale-speech case the latch exists for
  // stays killed.
  let answered = null;
  let fires = 0;

  // The cursor row alone, truncated at the cursor column. The phrase ends the
  // utterance, so it is on the row the cursor is on even when the draft wrapped.
  function cursorRow() {
    const buf = terminal.buffer.active;
    // While the alternate buffer is active it IS buffer.active — a full-screen
    // program's cursor row is not a composer, and its contents are not the
    // operator's draft. intent-highlight.js declines the same way.
    if (buf.type !== 'normal') return null;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    if (!line) return null;
    return line.translateToString(false, 0, buf.cursorX);
  }

  function tick() {
    timer = null;
    if (disposed) return;

    let cfg = null;
    try { cfg = getConfig(); } catch { cfg = null; }
    if (!cfg) return;

    const row = cursorRow();
    if (row === null) return;
    const found = findSubmit(row, cfg.phrase);
    if (!found) return;
    if (!found.erase) { answered = null; return; }
    if (answered === found.content) return;
    // Recorded even when the gate REFUSES below, so a blocked match cannot fire
    // later off an unrelated repaint. That is the whole of "no retry after the
    // dialog clears": by then the operator's speech is stale, and the Enter it
    // would send lands on whatever the dialog left behind.
    answered = found.content;

    let attention = null;
    try { attention = getAttention(); } catch { attention = 'permission'; }
    if (!shouldFire({ enabled: cfg.enabled, attention })) return;

    fires += 1;
    write('\x7f'.repeat(found.erase));
    enterTimer = setTimeout(() => {
      enterTimer = null;
      if (!disposed) write('\r');
    }, ENTER_SETTLE_MS);
  }

  // Trailing debounce: every write RESTARTS the window, which is what makes the
  // wait a quiet gate rather than a fixed delay.
  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, quietMs);
  };

  // A write is the ONLY wake, and adding a timer wake does not help: while
  // macOS dictation holds an utterance as marked text it is in xterm's
  // .composition-view overlay, onData has not fired and the buffer row is
  // EMPTY, so there is nothing for a poll to read. Focusing the window is what
  // ends the composition and echoes the text, which is the write below. A timer
  // wake was tried against this and reverted; it observed nothing.
  const subs = [terminal.onWriteParsed(schedule)];

  return {
    refresh: schedule,
    fireCount: () => fires,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (enterTimer) clearTimeout(enterTimer);
      timer = null;
      enterTimer = null;
      for (const s of subs) s.dispose();
    },
  };
}

module.exports = { createVoiceSubmitWatcher, QUIET_MS, ENTER_SETTLE_MS };
