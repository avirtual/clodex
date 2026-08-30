// voice-submit-watcher.js — watch one terminal's composer and submit it when a
// draft ends with the configured trigger phrase. One instance per local Claude
// terminal.
//
// TWO READS, because the operator's words live in two different places.
//
// The composer is SCREEN STATE: the CLI redraws its input box with ANSI, so a
// COMMITTED draft is read out of the buffer rather than reassembled from the PTY
// stream, which carries the redraws and not the contents.
//
// While a COMPOSITION is pending — macOS dictation, an IME, anything that
// composes — the words have not reached the pty at all, so the buffer is empty
// and no write event fires. They are in the DOM: xterm's CompositionHelper puts
// them in the `.composition-view` overlay and in the helper textarea. So the
// composition half POLLS the overlay and, on a match, COMMITS the composition;
// the text then echoes as an ordinary write and the buffer half above takes over
// unchanged. This half never sends Enter itself.
//
// Every decision except "where is the cursor" lives in lib/voice-submit.js;
// this half owns the two reads, the quiet windows and the writes.
//
// The buffer read is ONE row. The latch keys on that row's content, so an
// identical repaint stays answered and a changed draft re-arms.

const { findSubmit, matchTrigger, shouldFire } = require('./lib/voice-submit');

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

// A composition emits no event this side can subscribe to — compositionupdate
// goes to xterm's own listener — so the overlay is sampled instead. Well under
// QUIET_MS: the poll only OBSERVES, and it is the unchanged-for-a-quiet-window
// test that decides, so sampling faster than the window is what gives that test
// its resolution rather than what shortens it.
const COMPOSITION_POLL_MS = 300;

// Provisional boundary #1: where the pending composed text comes from.
// Contract: the text of THIS terminal's pending composition, or null when there
// is none. Everything downstream reads this; nothing else queries the DOM.
//
// Scoped to `terminal.element` rather than the document: every terminal has its
// own `.composition-view`, so a document-wide query returns another session's
// overlay as readily as this one's. `.active` is the composing flag itself —
// compositionstart adds it and _finalizeComposition removes it — so its absence
// is what distinguishes "nothing pending" from "pending but empty".
//
// If xterm renames either the class or the node, this returns null and the
// composition half goes quiet. It does not misfire: null is "no composition".
function readComposition(terminal) {
  const root = terminal && terminal.element;
  if (!root || typeof root.querySelector !== 'function') return null;
  const view = root.querySelector('.composition-view.active');
  if (!view) return null;
  const text = view.textContent;
  if (typeof text !== 'string' || !text.trim()) return null;
  return text;
}

// Provisional boundary #2: how a pending composition is committed.
// Contract: commit it, and report whether it took.
//
// A synthetic keydown, because that is what the operator's live evidence
// identified: pressing Command commits. That is CompositionHelper.keydown,
// which exempts only 229/Shift/Ctrl/Alt and sends everything else into
// _finalizeComposition(false), reading the text out of the textarea and
// dispatching it immediately. Preferred over calling
// _finalizeComposition directly: it is the same path a real key takes.
//
// Meta specifically, and this is the part not to "simplify": it must be a key
// that finalizes but contributes NO byte of its own, and Meta is the only
// observed one. Shift/Ctrl/Alt are exempt and would not finalize at all; a
// letter would finalize and then type itself into the draft.
//
// The keyCode is belt and braces. `keyCode` in KeyboardEventInit is a Chromium
// extension, so it may arrive as 0 — which is still safe: 0 is not an exempt
// code either, so the finalize happens, and xterm's key evaluation maps neither
// 91 nor 0-with-key-'Meta' to any output. Both outcomes commit and write
// nothing.
//
// bubbles:false is deliberate. xterm's listener is on the textarea itself, so
// it fires in the AT_TARGET phase regardless; letting a Meta keydown loose in
// the document would offer it to every shortcut handler in the renderer for no
// gain.
//
// CLEARING THE TEXTAREA AFTER THE DISPATCH IS LOAD-BEARING, AND THE ORDER IS THE
// WHOLE OF IT. Our keydown reaches _finalizeComposition(false), which sends
// `value.substring(start, end)` and leaves `value` ALONE. macOS then fires its
// own compositionend, which takes the waitForPropagation branch; `_isComposing`
// is false by then, so that branch reads the OPEN-ENDED `value.substring(start)`
// and dispatches the same words A SECOND TIME. The field that exists to dedup
// exactly this (`_dataAlreadySent`, xterm issue #3191) is written only from
// _handleAnyTextareaChanges, which a keydown-driven finalize never reaches, so
// it stays '' and deducts nothing. Emptying `value` is what makes that second
// read return '' — the branch skips a zero-length input.
//
// Safe in both directions: the finalize is SYNCHRONOUS (triggerDataEvent is
// called inline, before dispatchEvent returns), so clearing afterwards cannot
// truncate the first send; and a later compositionstart recomputes `start` from
// the new value length, so nothing is left pointing into a string we emptied.
//
// A synthetic keyUP would be the obvious tidy-up here and MUST NOT be added:
// xterm's _keyUp calls this.focus() for anything wasModifierKeyOnlyEvent()
// rejects, and that helper lists only 16/17/18 — Meta is not among them, so the
// "cleanup" would yank focus to this terminal. See _keyDownSeen below.
function commitComposition(terminal, composed = '', consumed = '') {
  const ta = terminal && terminal.textarea;
  if (!ta || typeof ta.dispatchEvent !== 'function') return false;
  // Send only what has not been sent yet. `start` is private and fixed at
  // compositionstart, so the un-consumed remainder is reached by shortening
  // `value` rather than by moving the offset: substring CLAMPS its end, and the
  // stale `end` a compositionupdate left pointing past the new length therefore
  // yields exactly the remainder. Rewriting after the dispatch instead would
  // send the accumulation this exists to prevent.
  //
  // Both shape checks REFUSE rather than guess. Writing a `value` whose head is
  // not the pre-composition text moves the words under a `start` that cannot
  // move with them, which sends a fragment cut at the wrong byte.
  if (consumed) {
    const value = typeof ta.value === 'string' ? ta.value : '';
    if (!composed || !composed.startsWith(consumed) || !value.endsWith(composed)) return false;
    ta.value = value.slice(0, value.length - composed.length) + composed.slice(consumed.length);
  }
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Meta', code: 'MetaLeft', keyCode: 91, which: 91,
    metaKey: true, bubbles: false, cancelable: true,
  }));
  // Leaves xterm's `_keyDownSeen` stuck true until the operator's next real
  // keyup, because we send no keyup. The only reader is _inputEvent's emoji-IME
  // path, which degrades to `!ev.composed` for that window — accepted as the
  // cheaper of the two, for the focus reason above.
  ta.value = '';
  return readComposition(terminal) === null;
}

function createVoiceSubmitWatcher(terminal, {
  getConfig, getAttention, write, quietMs = QUIET_MS,
  pollMs = COMPOSITION_POLL_MS,
  readComposition: readPending = readComposition,
  commitComposition: commitPending = commitComposition,
  now = Date.now,
}) {
  let timer = null;
  let enterTimer = null;
  let pollTimer = null;
  let disposed = false;
  // The composer CONTENT a match was already answered for, not a bare boolean.
  // A boolean makes a second deliberate "over and out" dead for the rest of the
  // draft: the composer still ends with the phrase, so the latch still holds.
  // Keying on the content re-arms when the draft CHANGES — which a repaint of
  // the same text does not do, so the stale-speech case the latch exists for
  // stays killed.
  let answered = null;
  let fires = 0;

  // The composition half's own state. `pending` is the composed text as of the
  // last sample and `pendingAt` when it last CHANGED, which together are the
  // quiet window: an utterance still arriving keeps resetting pendingAt.
  let pending = null;
  let pendingAt = 0;
  let committed = null;
  // macOS re-fills the composition with EVERYTHING said since it began, so
  // sample N+1 carries sample N's words again. `committed` cannot catch that —
  // an equality latch never bites on text that keeps growing — so what has
  // already been sent is tracked as a consumed PREFIX and only the remainder is
  // ever dispatched.
  //
  // `desynced` is the answer to a revision: dictation rewrites what it already
  // transcribed, so the accumulation is not always an extension of what we
  // consumed. When the prefix stops matching, the offset is meaningless and this
  // composition sends nothing further. Dropping words is recoverable — the
  // operator says them again; re-sending sentences already submitted is not.
  let consumed = '';
  let desynced = false;
  let commits = 0;
  let commitFailures = 0;

  // The cursor row alone, truncated at the cursor column. The phrase ends the
  // utterance, so it is on the row the cursor is on even when the draft wrapped.
  // While the alternate buffer is active it IS buffer.active — a full-screen
  // program's cursor row is not a composer, and its contents are not the
  // operator's draft. intent-highlight.js declines the same way. BOTH halves
  // ask, which is why it is not folded back into cursorRow(): the composition
  // half never reads the buffer, so it would inherit no decline from a check
  // that lives in the buffer read.
  function onNormalBuffer() {
    try { return terminal.buffer.active.type === 'normal'; } catch { return false; }
  }

  function cursorRow() {
    if (!onNormalBuffer()) return null;
    const buf = terminal.buffer.active;
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

  // Reset rather than remember whenever there is nothing to watch, so the text
  // a re-arm inherits is never mistaken for something the operator just said —
  // the composition equivalent of the content latch.
  function forgetPending() {
    pending = null;
    pendingAt = 0;
    committed = null;
    consumed = '';
    desynced = false;
  }

  function pollComposition() {
    if (disposed) return;

    let cfg = null;
    try { cfg = getConfig(); } catch { cfg = null; }
    if (!cfg || cfg.composition !== true) { forgetPending(); return; }
    // Before the overlay is touched: a composition over a full-screen program is
    // not a draft for this feature to submit, whatever it says. Forgetting
    // rather than merely returning means the words cannot be adopted as
    // already-stable the moment the program exits.
    if (!onNormalBuffer()) { forgetPending(); return; }

    let text = null;
    try { text = readPending(terminal); } catch { text = null; }
    if (text === null) { forgetPending(); return; }

    if (text !== pending) { pending = text; pendingAt = now(); return; }
    // The words are still un-finalised, so the quiet window is doing more work
    // here than on the buffer side: it is the only thing standing between a
    // transcriber that emits the phrase mid-utterance and a submit the operator
    // cannot undo. A composition that is still growing never reaches this line.
    if (now() - pendingAt < quietMs) return;

    if (desynced) return;
    if (!text.startsWith(consumed)) { desynced = true; return; }
    const fresh = text.slice(consumed.length);

    // Dictation prepends a space to the overlay text. It cannot affect a match
    // anchored at the tail, but trimming keeps what is matched identical to
    // what the buffer half will see once this commits. Matched on the REMAINDER:
    // the phrase that ended an already-sent utterance is still sitting in the
    // accumulation, and matching the whole text would re-fire on it forever.
    if (!matchTrigger(fresh.trim(), cfg.phrase)) return;
    if (committed === text) return;
    // Both recorded ahead of the gate for the same reason as `answered`: a match
    // blocked by a dialog must die, not sit waiting for the dialog to clear.
    // `consumed` advances here rather than after a successful commit so that a
    // refusal buries those words too — the next accumulation carries them again,
    // and re-sending them is the harm this whole prefix exists to prevent.
    committed = text;
    const alreadySent = consumed;
    consumed = text;

    let attention = null;
    try { attention = getAttention(); } catch { attention = 'permission'; }
    if (!shouldFire({ enabled: cfg.enabled, attention })) return;

    // Commit only. The committed text echoes to the pty as an ordinary write,
    // which wakes the buffer half above, and THAT is what erases the phrase and
    // sends Enter — through every gate it already applies. Sending Enter here
    // as well would submit the draft twice.
    //
    // A commit that reports failure is RECORDED AND NOT RETRIED, deliberately.
    // The latch above is already set, and that is the safe end state: retrying
    // means dispatching Meta keydowns at the terminal once per poll for as long
    // as the composition sits there, and the failure mode that would produce it
    // — xterm no longer finalizing on this key — is exactly the one where
    // retrying cannot work. It stays visible through commitFailureCount()
    // instead of being discarded.
    commits += 1;
    let took = false;
    try { took = commitPending(terminal, text, alreadySent) !== false; } catch { took = false; }
    if (!took) commitFailures += 1;
  }

  // Trailing debounce: every write RESTARTS the window, which is what makes the
  // wait a quiet gate rather than a fixed delay.
  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, quietMs);
  };

  // A write is the only wake the BUFFER half needs: nothing else changes what
  // is on screen. The composition half cannot use it — while a composition is
  // pending onData has not fired and the buffer does not hold the text — so it
  // polls the overlay instead, on its own timer.
  const subs = [terminal.onWriteParsed(schedule)];
  pollTimer = setInterval(pollComposition, pollMs);

  return {
    refresh: schedule,
    fireCount: () => fires,
    commitCount: () => commits,
    commitFailureCount: () => commitFailures,
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

module.exports = {
  createVoiceSubmitWatcher, readComposition, commitComposition,
  QUIET_MS, ENTER_SETTLE_MS, COMPOSITION_POLL_MS,
};
