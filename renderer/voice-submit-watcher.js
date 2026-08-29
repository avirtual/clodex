// voice-submit-watcher.js — watch one terminal's composer and submit it when a
// dictated utterance ends with the configured trigger phrase. One instance per
// local Claude terminal.
//
// The composer is SCREEN STATE: the CLI redraws its input box with ANSI, so the
// text is read out of the buffer rather than reassembled from the PTY stream,
// which carries the redraws and not the contents.
//
// Every decision except "where is the cursor" lives in lib/voice-submit.js;
// this half owns the buffer read, the quiet window and the two writes.

const { composerTail, matchTrigger, shouldFire } = require('./lib/voice-submit');

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
  getConfig, getVoiceMode, getAttention, write, quietMs = QUIET_MS,
}) {
  let timer = null;
  let enterTimer = null;
  let disposed = false;
  // One fire per match: set by ANY match, cleared only by a composer that no
  // longer matches. See the gate-failure case in tick().
  let latched = false;
  let fires = 0;

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
    const content = composerTail(row);
    if (content === null) return;   // no prompt on this row — not a composer

    const hit = matchTrigger(content, cfg.phrase);
    if (!hit) { latched = false; return; }
    if (latched) return;
    // Latched even when the gate REFUSES, so a blocked match cannot fire later
    // off an unrelated repaint. That is the whole of "no retry after the dialog
    // clears": by then the operator's speech is stale, and the Enter it would
    // send lands on whatever the dialog left behind. Re-arming needs the
    // composer to stop matching.
    latched = true;

    let voiceMode = null;
    let attention = null;
    try { voiceMode = getVoiceMode(); } catch { voiceMode = null; }
    try { attention = getAttention(); } catch { attention = 'permission'; }
    if (!shouldFire({ enabled: cfg.enabled, voiceMode, attention })) return;

    fires += 1;
    write('\x7f'.repeat(hit.erase));
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
