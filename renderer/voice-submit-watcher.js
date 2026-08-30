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

// The watcher cannot rely on terminal writes alone to wake it. A write is what
// STARTS a quiet window, so after the last one there is never another event —
// and the operator dictating into an unfocused window produces no further
// writes at all, which left the check asleep until a click forced a repaint.
const POLL_MS = 600;

function createVoiceSubmitWatcher(terminal, {
  getConfig, getAttention, write, quietMs = QUIET_MS, pollMs = POLL_MS,
}) {
  let timer = null;
  let enterTimer = null;
  let pollTimer = null;
  let disposed = false;
  // The cursor row as of the last wake, write- or poll-driven. `undefined` is
  // NOT a row: it means unsynced, and the next poll adopts what it finds
  // without scheduling, so re-enabling the feature over a composer that already
  // ends with the phrase does not submit speech from before it was armed.
  let lastRow;
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

  // A write is a wake AND an observation: recording the row it produced is what
  // keeps the poll below from reporting that same text as a change one interval
  // later, which would push every ordinary fire a poll interval past the quiet
  // window it should have fired at.
  const onWrite = () => {
    lastRow = cursorRow();
    schedule();
  };

  // The second wake source, and the only one that survives the composer going
  // quiet. It schedules on a CHANGED row rather than on every tick, which is
  // what preserves the debounce in both directions: calling tick() here would
  // skip the quiet window and submit a half-finished utterance, while
  // scheduling unconditionally would restart the window on every interval and,
  // with pollMs under quietMs, mean it never expired at all.
  const poll = () => {
    if (disposed) return;
    let cfg = null;
    try { cfg = getConfig(); } catch { cfg = null; }
    // Resync rather than sample while disarmed, so the row a re-arm inherits is
    // never mistaken for something the operator just said.
    if (!cfg) { lastRow = undefined; return; }
    const row = cursorRow();
    if (lastRow === undefined) { lastRow = row; return; }
    if (row === lastRow) return;
    lastRow = row;
    schedule();
  };

  lastRow = cursorRow();
  pollTimer = setInterval(poll, pollMs);

  const subs = [terminal.onWriteParsed(onWrite)];

  return {
    refresh: schedule,
    fireCount: () => fires,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (enterTimer) clearTimeout(enterTimer);
      if (pollTimer) clearInterval(pollTimer);
      timer = null;
      enterTimer = null;
      pollTimer = null;
      for (const s of subs) s.dispose();
    },
  };
}

module.exports = { createVoiceSubmitWatcher, QUIET_MS, ENTER_SETTLE_MS, POLL_MS };
