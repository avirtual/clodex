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

const {
  findSubmit, matchTrigger, shouldFire, shouldRearm, composerIsEmpty,
  composerHasDraftRows, recorderBlocksRearm, isVoiceOriginated, recordingObserved,
} = require('./lib/voice-submit');
// The SAME classifier the main process and typeToTakeControl use. A second
// predicate here would drift from the one that already decides what counts as a
// human keystroke, and this one has to agree with it: xterm's onData carries
// mouse reports and query replies too, and treating those as typing would wipe
// the microphone evidence on scroll alone.
const { isHumanPtyInput } = require('../proxy-util');

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

// The gap between the submit's `\r` and the trigger key that stops the recorder.
//
// Its own write for the same reason ENTER_SETTLE_MS exists: a chunk carrying
// `\r` with a character behind it is read as one paste-like event, which leaves
// the `\r` in the buffer as a literal and the key riding in with it.
//
// Much longer than that 30ms floor, and the extra is for the READ, not the
// write. The gate re-reads the indicator to decide whether to send this key at
// all, and the cells it reads are the ones painted BEFORE our Enter until the
// CLI repaints. A stale lit `\u23faREC` read there sends the key into a recorder
// that has already stopped, which ARMS a new recording — the inverted failure
// this design exists to avoid. The turn is running and the composer is empty,
// so waiting costs nothing.
//
// This does NOT widen ENTER_SETTLE_MS, which is 30 for the erase/Enter pair;
// it is a second gap AFTER the Enter, so nothing above it is delayed.
//
// COUPLED TO REARM_ABANDON_MS, which a tuning pass would not guess: if the
// CLI's post-Enter repaint ever lags past this gap, the composer still holds
// the draft at the read below and the stop silently never fires. What recovers
// the mic then is the abandon deadline outlasting the recorder's own timeout.
// Shortening that deadline and this gap independently is what removes both.
const STOP_SETTLE_MS = 250;

// How long a consumed prefix outlives the composition it came from.
//
// PROVISIONAL AND NOT MEASURED: nobody on this team can dictate, so this number
// is a judgement, not an observation. It is long relative to a pause between
// sentences and short relative to walking away, because both errors are real:
// too short resends an utterance, too long buries the first words of a genuinely
// new session. The operator's probe showed `.composition-view.active` flapping
// mid-session — composing, unselected, composing — without the machine being
// touched, so gaps of seconds are ORDINARY and this cannot be tightened toward
// the poll interval. It measures SILENCE: the stamp refreshes on every live
// overlay read, so a long utterance cannot age the prefix out while it is still
// being spoken.
const CONSUMED_IDLE_MS = 90_000;

// A composition emits no event this side can subscribe to — compositionupdate
// goes to xterm's own listener — so the overlay is sampled instead. Well under
// QUIET_MS: the poll only OBSERVES, and it is the unchanged-for-a-quiet-window
// test that decides, so sampling faster than the window is what gives that test
// its resolution rather than what shortens it.
const COMPOSITION_POLL_MS = 300;

// The re-arm waits this long after the idle edge before writing, and re-checks
// every gate when it lands. Two separate jobs, and the LONGER of the two needs
// is what sets the number.
//
// One: the permission interlock reads a sidebar row written by the
// `session-attention` event, which travels from a different watcher (an
// fs.watch on the attention log) than the activity event does (the transcript
// poll). The orderings are not synchronised, so an idle edge can arrive just
// BEFORE the notice that a dialog is open, and the fence is only as good as
// the row it reads.
//
// Two, and this is why it is seconds rather than milliseconds: `turnEnd` gates
// the WIRE emitter's mid-turn idle, but the jsonl emitter passes
// `notify = state === 'idle'` unconditionally, so on that path every 1s text
// flush between tool calls arrives here looking like a turn end. The only
// evidence this side has that the turn really ended is that the terminal then
// STAYS quiet — a CLI still working repaints. This window is how long it must
// stay quiet for.
//
// The window is a QUIET GAP, not a delay: `attemptRearm` reschedules itself
// while the terminal is still painting, so the size of this number does not
// decide whether the re-arm happens, only how long a lull has to be before it
// counts as one. That is why it is not tuned to a measured repaint cadence —
// which the author could not establish from the binary anyway. Too short reads
// a gap between two paints of one turn as a turn end and writes mid-turn, where
// the key is LIVE and ARMS a recording nobody asked for — the CLI's handler
// gates on panels/overlays, not on whether a turn is running. Too long only
// delays the write.
const REARM_SETTLE_MS = 3000;

// How long a single idle edge may keep rescheduling before it is abandoned.
//
// The deadline is not tight, and must not be tightened here: it is consulted
// only on the still-painting branch, so a paint at `deadline - 1` still
// schedules an attempt that may write up to `rearmMs` past it. Do NOT hoist
// the check to the top of `attemptRearm` — the `abandonMs: 0` re-arm in `MF1:
// one edge cannot reschedule forever` depends on the current placement.
//
// Twenty seconds: it must outlast the CLI's tap-recorder silence timeout, which
// is 15000ms exactly (measured — see below), or a turn ending while the recorder
// is still lit ALWAYS abandons before the indicator clears and the mic never
// comes back without a keypress — the regression cutting this to 10000 caused.
// Do not lower it back under that timeout.
//
// The deadline is the recording-hazard exposure window, which is why it was cut
// in the first place: for as long as it stands, one idle edge can still reschedule
// an attempt. Raising it is safe here only because the submit-time stop above
// removes the case that made a long window dangerous — the recorder is stopped at
// the submit, so the usual path never reaches turn end lit at all, and this is
// the net for the paths that do. It is still bounded, and every gate is
// re-evaluated when the timer lands.
//
// The trailing window below re-arms its own timer on every paint, so without a
// deadline a terminal that never goes quiet — a spinner, a tailing log, an agent
// that went straight back to work without an activity event — would reschedule
// off one edge forever. Abandoning is the safe end: the next real turn end
// starts a fresh attempt.
const REARM_ABANDON_MS = 20000;

// THE INDICATOR IS NOT EVIDENCE THAT *THIS DRAFT* WAS SPOKEN, which is why the
// clear below exists and why it is not optional.
//
// t571's re-arm writes the trigger character at every turn end, so the recorder
// is lit at the START of an ordinary turn, and it stays lit for ~15s of silence.
// Typing into that lit composer would submit the operator's exact typed words
// carrying a marker saying they were dictated — a mislabel of his own words, the
// one thing this feature must never do. So typing is POSITIVE EVIDENCE OF
// NOT-VOICE: it clears the stamp AND mutes the indicator path.
//
// THE MUTE IS WHAT MAKES THE CLEAR STICK. The stamp is level-triggered, so a
// clear alone is undone by the next 300ms poll while the recorder is still lit —
// which is how a narrower version of this fix left the defect open.
//
// This does not cost tap-listening, which is the workflow that matters: the tap
// keypress mutes, the recorder then LIGHTS, and that rising edge unmutes and
// stamps before the transcription lands.

// How long evidence that the operator was DICTATING keeps a submit eligible for
// the voice-origin marker.
//
// It spans one gap: the last moment this side can see the microphone (a
// composition commit, or the recording indicator painted on screen) to the
// Enter that submits those words. The buffer half's own QUIET_MS sits inside
// that gap, so the window cannot be tightened toward it — a fire happens a
// quiet window AFTER the last write, and on the CLI's voice path the indicator
// comes down when the recorder stops, before the transcription is even painted.
//
// Generous rather than tight because the two errors are not symmetric and the
// tight side is not the safe one here: too short silently drops the marker on
// genuinely spoken text (the case the feature exists for), while too long can
// only mark a message typed within seconds of dictating — which is text the
// operator spoke into moments earlier anyway. It is a staleness bound, not a
// discriminator: the discrimination is done by requiring evidence AT ALL.
const VOICE_EVIDENCE_MS = 20_000;

// How long a non-empty composer stays attributed to DICTATION after the
// recorder was last seen lit. It bounds the ATTRIBUTION, not the protection:
// the operator's exposure is the minutes he spends re-reading a long
// transcription before sending it, so this has to outlast reading rather than
// speaking, and 3s (the recorder's own stale window) is far too short for that
// — a stale window sized for "is he talking right now" cannot answer "is what
// he dictated still on screen".
//
// Bounded rather than open-ended because there is no event that says he
// abandoned it. Past this, a composer with words in it is treated as ordinary
// text: he may well have typed it, and the delivery he is owed is not held
// forever on evidence this old. The 5-minute inject cap bounds it again from
// the main side regardless of what this says.
const VOICE_DRAFT_SITTING_MS = 120_000;

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
// identified: pressing Command commits. CompositionHelper.keydown
// exempts only 229/Shift/Ctrl/Alt and sends everything else into
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
    if (!composed || !composed.startsWith(consumed)) return false;
    // The overlay text and `value` need not be byte-identical: dictation
    // PREPENDS A SPACE to the overlay that the textarea may not carry. Demanding
    // an exact suffix would refuse every commit after the first — and since the
    // prefix advances at the latch, each refusal BURIES an utterance instead of
    // merely dropping it. So fall back to the trimmed form and take the offset
    // from whichever actually matches.
    const held = value.endsWith(composed) ? composed
      : (value.endsWith(composed.trimStart()) ? composed.trimStart() : null);
    if (held === null) return false;
    const already = held.length - (composed.length - consumed.length);
    ta.value = value.slice(0, value.length - held.length) + held.slice(already);
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
  getVoiceMode = () => null,
  getTriggerKey = () => null,
  rearmMs = REARM_SETTLE_MS,
  abandonMs = REARM_ABANDON_MS,
  // Marks the submit as voice-originated. Absent, the feature is simply off and
  // every other path here is unchanged — the marker is an annotation on a
  // submit, never a precondition for one.
  markVoiceOrigin = null,
  // Reports the CLI's recording indicator to main, which defers injection while
  // it is lit. Resent on every poll that sees it, never paired with an off —
  // main expires the stamp, so a watcher disposed mid-utterance releases the
  // deferral instead of stranding it.
  noteVoiceRecording = null,
  // Reports that a DICTATED draft is sitting in the composer, which outlives the
  // recorder: the indicator goes dark the moment he stops talking, and that is
  // when he starts READING what was transcribed. Reported on the level like the
  // recorder above and expired by main the same way, so every way this watcher
  // can stop — disposed, seat switched, window closed, screen unreadable —
  // releases the protection rather than stranding the seat.
  noteVoiceDraft = null,
  // How long after the recorder was last seen lit a non-empty composer is still
  // attributed to dictation. Bounds the attribution, not the protection: past
  // it the text is just text, and a draft he typed was never this feature's.
  voiceDraftMs = VOICE_DRAFT_SITTING_MS,
  // Whether this seat is one whose recorder is worth reporting at all. Distinct
  // from `getConfig`, which additionally requires hands-free SUBMIT to be
  // switched on: the operator dictates whether or not that feature is enabled,
  // and gating his protection on an unrelated checkbox would fix the bug only
  // for the seats that had opted into something else.
  recorderScope = () => false,
  evidenceMs = VOICE_EVIDENCE_MS,
  now = Date.now,
}) {
  let timer = null;
  let enterTimer = null;
  let stopTimer = null;
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
  // Submits that found the recorder still lit afterwards and stopped it.
  let stops = 0;
  // Taps written for an EXTERNAL ensure-on request, counted apart from the
  // re-arm's: the two answer different questions about the same byte, and one
  // number could not say which of them wrote it.
  let externalTaps = 0;
  // Taps written to STOP the recorder at the operator's request, counted apart
  // from the two that arm it: a single number could not say which direction the
  // byte went, and direction is the only thing that differs between them.
  let offTaps = 0;
  // When the microphone was last seen. Written ONLY where dictation is proven
  // (a composition commit, or the CLI's recording indicator on screen) and read
  // only by the marker — never by a gate, so a wrong value here can cost the
  // annotation and nothing else.
  let voiceEvidenceAt = null;
  // THE INDICATOR STAMP IS LEVEL-TRIGGERED, so clearing the evidence on a
  // keystroke is not enough on its own: the recorder stays lit for ~15s after
  // t571's re-arm lights it, and the 300ms poll would re-stamp the cleared
  // evidence again and again while the operator types a reply. These two make
  // the clear STICK until the recorder next RISES.
  //
  // Not a bare rising-edge stamp instead, which is the obvious simplification
  // and is wrong: a 30s utterance would then age out of VOICE_EVIDENCE_MS with
  // nothing to refresh it, and long dictations would silently stop being marked.
  // The level stamp is what refreshes them; this only suppresses it after typing.
  let mutedByTyping = false;
  let prevObserved = false;
  // When the recorder was last seen lit, anchoring the dictated-draft report.
  let lastLitAt = 0;
  let marks = 0;
  // What the gates saw on their last look, for DISPLAY only. Derived from the
  // same rows in the same pass as `observed` below, never re-scraped: a second
  // read would be a second opinion, and a display that can disagree with the
  // gate it reports on is worse than no display.
  //
  // 'out' rather than a reading whenever the seat is out of scope, because the
  // scan does not run then — reporting 'off' there would claim a dark recorder
  // was measured on a seat nothing looked at.
  let reading = 'out';

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
  //
  // THE TWO LIFETIMES, and conflating them is the bug this had first time round.
  // `pending`/`pendingAt`/`committed` belong to ONE COMPOSITION and must reset
  // whenever the overlay goes quiet. `consumed`/`desynced` belong to the whole
  // DICTATION SESSION and must SURVIVE that: a successful commit removes
  // `.active` — commitComposition reports success by observing exactly that — so
  // a null read after every commit is guaranteed, and a prefix cleared there is
  // erased seconds before macOS refills the composition with the words it
  // described. `consumedAt` bounds the survival, since nothing else can.
  let consumed = '';
  let consumedAt = 0;
  let desynced = false;
  let commits = 0;
  let commitFailures = 0;

  // The previous activity state, which is the whole of the edge test. Seeded
  // null so the FIRST event a watcher ever sees cannot look like an arrival
  // from 'thinking' — a seat that is merely idle when its terminal is built
  // has not just finished a turn, and re-arming it would write into whatever
  // draft is already sitting there.
  let activity = null;
  let rearms = 0;
  let rearmTimer = null;
  // When the terminal last painted anything. The turn-end evidence on the
  // jsonl path, where every 1s text flush claims to be a turn end.
  let lastWriteAt = 0;
  // When the edge currently being waited on arrived, for the abandon deadline.
  let rearmDeadline = 0;

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

  // The rows the recording indicator could be on: the cursor row and the ones
  // BELOW it, each read WHOLE rather than truncated at the cursor.
  //
  // Whole because the indicator paints to the RIGHT of the cursor, so the
  // truncation that protects the composer read would cut off the very thing
  // this is looking for. Downward because everything ABOVE the composer is
  // transcript, where U+23FA opens every ordinary tool bullet — a scan that
  // walks up hits arbitrary scrollback, measured.
  //
  // Null, not [], when the screen cannot be read: `recorderBlocksRearm` maps
  // that to "blocked", and an empty array would mean "read it, saw nothing".
  function indicatorRows() {
    if (!onNormalBuffer()) return null;
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

  // The composer rows ending at the CURSOR's row, top→bottom, each read WHOLE.
  // Upward because a long draft's head — the row carrying the marker, which is
  // the only evidence a draft exists — is ABOVE the cursor; `indicatorRows`
  // scans downward for the opposite reason, the indicator painting to the right
  // and below.
  //
  // Bounded by `terminal.rows`, so a screen with no marker anywhere costs one
  // screen of reads and not a walk through scrollback. Null (never []) when the
  // screen cannot be read, so `composerHasDraftRows` declines rather than
  // guessing — an unreadable screen must not park deliveries.
  function composerRows() {
    if (!onNormalBuffer()) return null;
    try {
      const buf = terminal.buffer.active;
      const out = [];
      for (let y = buf.cursorY; y >= 0 && out.length < terminal.rows; y--) {
        const line = buf.getLine(buf.baseY + y);
        if (!line) break;
        out.unshift(line.translateToString(true));
      }
      return out.length ? out : null;
    } catch { return null; }
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
    // BEFORE the writes, and that ordering is the whole of it: the marker has
    // to be registered at the proxy before the submitted text reaches the
    // model, or it rides the wrong turn — or no turn. It is not awaited (it
    // must never delay the keystroke), so what buys the margin is the
    // ENTER_SETTLE_MS gap that already sits between the erase and the \r, plus
    // the CLI's own time from Enter to its request. Measured against a live
    // proxy the arm POST is a median 0.45ms and a p95 4.6ms on loopback,
    // against a 30ms floor. Do NOT widen ENTER_SETTLE_MS to buy more: it is 30
    // for a different reason (t566) and merging those writes breaks the submit.
    if (markVoiceOrigin
      && isVoiceOriginated({ evidenceAt: voiceEvidenceAt, now: now(), windowMs: evidenceMs })) {
      marks += 1;
      // Consumed, so one utterance marks one submit. A second submit needs its
      // own evidence rather than inheriting this one.
      voiceEvidenceAt = null;
      try { markVoiceOrigin(); } catch {}
    }
    write('\x7f'.repeat(found.erase));
    enterTimer = setTimeout(() => {
      enterTimer = null;
      if (disposed) return;
      write('\r');
      // AFTER the Enter, never merged into it, and never at turn end.
      //
      // A recorder still lit after our Enter would otherwise stay lit for the
      // rest of its 15000ms silence timeout, and the re-arm cannot clear it:
      // writing the trigger key into what looks like a live recording would
      // stop the operator mid-sentence, so the gate declines and the mic sits
      // stuck until it is tapped by hand.
      //
      // Stopping it HERE is what makes that safe, and the safety is positional,
      // not a heuristic: at this instant the operator has just completed an
      // utterance ending in the trigger phrase, so the recording is complete BY
      // CONSTRUCTION and the key can cut nothing off. The same write at turn end
      // is forbidden — there a lit indicator is indistinguishable from the
      // operator mid-sentence, and cutting them off loses what they are saying.
      //
      // The turn-end re-arm then taps it back through its existing path; this
      // adds no second way to arm the recorder.
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (disposed) return;
        // Read LATE, not at match time: the CLI may have stopped the recorder
        // itself in the meantime, and this must reflect the screen as it is when
        // the key would land.
        //
        // `recordingObserved`, NOT the re-arm's gate: unreadable must read as
        // NOT lit here. The two mistakes are inverted relative to the re-arm —
        // there a missed indicator stops a live recording, here a phantom one
        // ARMS a recording the operator never asked for, and an armed mic that
        // nobody knows is running is worse than the stuck state this fixes.
        if (!recordingObserved(indicatorRows())) return;
        // The "complete BY CONSTRUCTION" argument above has one hole: the
        // operator can keep talking past the trigger phrase, and interim
        // transcript for the NEW utterance lands after our `\r`. Stopping then
        // would cut them off mid-sentence. An empty composer is the evidence
        // that nothing new has arrived; anything else and we skip the stop and
        // inherit the pre-t587 behaviour, which is the safe direction.
        if (!composerIsEmpty(cursorRow())) return;
        if (tapTrigger()) stops += 1;
      }, STOP_SETTLE_MS);
    }, ENTER_SETTLE_MS);
  }

  // Reset rather than remember whenever there is nothing to watch, so the text
  // a re-arm inherits is never mistaken for something the operator just said —
  // the composition equivalent of the content latch.
  function forgetPending() {
    pending = null;
    pendingAt = 0;
    committed = null;
  }

  // The session-scoped half, reset only where the DICTATION SESSION itself is
  // over: the COMPOSITION setting going off (the master switch produces a null
  // config instead, and is handled above as an out-of-scope seat), and the idle
  // expiry. Not on a null overlay read, an out-of-scope seat, or a full-screen
  // program — each is a gap WITHIN one session, the OS accumulation intact.
  function forgetConsumed() {
    consumed = '';
    consumedAt = 0;
    desynced = false;
  }

  function pollComposition() {
    if (disposed) return;

    let cfg = null;
    try { cfg = getConfig(); } catch { cfg = null; }
    // The CLI's own voice path, which never produces a composition: it records
    // and paints the transcription straight into the composer, so the indicator
    // is the only moment the microphone is visible from here. Sampled ABOVE the
    // composition gate because that path does not need the composition setting,
    // and on this timer rather than per write — the indicator stands for
    // seconds, so 300ms resolves it, while a scan on every write parse would
    // run orders of magnitude more often for the same answer.
    //
    // Sampled above the CONFIG BAIL too, and that is the wider of the two
    // hoists: a null config means hands-free submit is off or this is not the
    // active seat, and the operator dictates into seats regardless of whether he
    // opted into an unrelated feature. `recorderScope` is what re-narrows it, so
    // a non-null config still samples exactly what it sampled before.
    //
    // `recorderBlocksRearm` makes the re-arm's own decision from the same rows
    // and is deliberately untouched here.
    let inScope = false;
    try { inScope = !!cfg || !!recorderScope(); } catch {}
    // ONE read, shared by the gate below and by the display. Two calls would
    // sample the screen twice and could straddle a repaint, which is exactly
    // the disagreement the display exists to expose rather than to create.
    const indRows = inScope ? indicatorRows() : null;
    const observed = inScope ? recordingObserved(indRows) : false;
    // THREE STATES, and the third is the reason this exists. `recordingObserved`
    // and `recorderBlocksRearm` disagree in precisely two places, and both are
    // states the operator cannot see today: the CLI's processing window (busy,
    // not lit) and an unreadable screen (blocks every re-arm while looking
    // exactly like "off"). Collapsing either into 'off' returns the display to
    // the blindness it was built to end.
    //
    // Ordered unreadable → lit → busy → off, and the null test comes FIRST for
    // the same reason it does in `externalTap`: `recordingObserved(null)` is
    // false and `recorderBlocksRearm(null)` is true, so asking either one first
    // would report a definite state about a screen nobody could read.
    if (!inScope) reading = 'out';
    else if (!Array.isArray(indRows)) reading = 'unreadable';
    else if (observed) reading = 'lit';
    else if (recorderBlocksRearm(indRows)) reading = 'busy';
    else reading = 'off';
    // Reported on the LEVEL, every poll it stays lit, because main expires the
    // stamp rather than waiting for an off. Before the bail for the reason
    // above: this is the operator's protection from being spliced mid-sentence,
    // not part of the submit feature.
    if (observed && noteVoiceRecording) { try { noteVoiceRecording(); } catch {} }
    if (observed) lastLitAt = now();

    // The DRAFT report, and the reason it is not the recorder report: the
    // indicator goes dark the instant he stops talking, which is the instant he
    // starts re-reading the transcription. This keeps the protection alive for
    // as long as the dictated words are still sitting in the composer unsent.
    //
    // `composerHasDraft` is a POSITIVE read, never `!composerIsEmpty`: that
    // negation is true of every row this cannot read (null off the alternate
    // buffer, a dialog interior, a mid-repaint screen), and main PARKS on this
    // answer — an unreadable screen must not park deliveries nobody can then
    // release. Doubt delivers, as it does for the recorder gate.
    //
    // Anchored on the recorder having been lit RECENTLY, which is what makes it
    // a dictated draft rather than any draft: without the anchor this reports on
    // every seat with text in its composer and quietly reroutes injection
    // box-wide.
    if (inScope && noteVoiceDraft && lastLitAt && now() - lastLitAt < voiceDraftMs) {
      let rows = null;
      try { rows = composerRows(); } catch { rows = null; }
      if (composerHasDraftRows(rows)) { try { noteVoiceDraft(); } catch {} }
    }

    // A null config is an out-of-scope SEAT, not a stop: getConfig returns it
    // for any seat that is not the active claude session, and also whenever
    // hands-free submit is off at all — so clicking another sidebar row
    // produces one. Clearing the prefix here would resend the whole
    // accumulation the moment the operator clicks back and keeps dictating —
    // the same shape as the alt-screen arm, and the same answer.
    if (!cfg) { forgetPending(); return; }

    // A RISE is the recorder starting, which is the operator reaching for the
    // microphone: it clears the mute so tap-listening marks normally (the tap
    // keypress mutes, the recorder then lights, and this unmutes on that edge).
    // After the re-arm lit it by machine there is no second rise, so typing into
    // an already-lit composer stays muted — which is the defect this closes.
    if (observed && !prevObserved) mutedByTyping = false;
    prevObserved = observed;
    if (observed && !mutedByTyping) voiceEvidenceAt = now();

    // The COMPOSITION checkbox going off is the operator saying stop, and that
    // does end the session. The master switch never reaches here.
    if (cfg.composition !== true) { forgetPending(); forgetConsumed(); return; }
    // Before the overlay is touched: a composition over a full-screen program is
    // not a draft for this feature to submit, whatever it says. Forgetting
    // rather than merely returning means the words cannot be adopted as
    // already-stable the moment the program exits.
    //
    // Only the per-composition half is forgotten. A pager opening and closing
    // does not end the OS's dictation session — the accumulation is fully intact
    // when it exits — so clearing the prefix here would resend every utterance
    // already submitted. The decline to COMMIT while the program is up is
    // untouched; it is only the session state that survives.
    if (!onNormalBuffer()) { forgetPending(); return; }

    let text = null;
    try { text = readPending(terminal); } catch { text = null; }
    if (text === null) {
      forgetPending();
      // NOT forgetConsumed(): this null is the ordinary gap between two
      // utterances of one dictation session — every successful commit produces
      // one — and dropping the prefix here is what made the first fix a no-op.
      // Only a gap long enough to be a different sitting clears it.
      if (consumed && now() - consumedAt >= CONSUMED_IDLE_MS) forgetConsumed();
      return;
    }

    if (desynced) return;
    if (!text.startsWith(consumed)) { desynced = true; return; }
    // AN ACTIVE OVERLAY IS THE EVIDENCE THE SESSION IS ALIVE, and the expiry
    // measures silence, not time since the last submit. Stamped here rather than
    // at commit time so that dictating one long utterance — overlay active
    // throughout, which is positive proof the session never ended — cannot age
    // the prefix out and resend everything on the next flap. Above the growth
    // return, so words still arriving refresh it too.
    //
    // A DESYNCED session returns before this and therefore still expires. That
    // is deliberate: it is the one state where letting the prefix die is how the
    // feature comes back.
    consumedAt = now();

    if (text !== pending) { pending = text; pendingAt = now(); return; }
    // The words are still un-finalised, so the quiet window is doing more work
    // here than on the buffer side: it is the only thing standing between a
    // transcriber that emits the phrase mid-utterance and a submit the operator
    // cannot undo. A composition that is still growing never reaches this line.
    if (now() - pendingAt < quietMs) return;

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
    // A composition IS the microphone on macOS: these words were dictated into
    // the overlay, never typed.
    //
    // STAMPED AFTER THE COMMIT, and the order is load-bearing. commitPending
    // dispatches the keydown that makes xterm fire onData synchronously with the
    // dictated text, which reaches noteInput and CLEARS the stamp — so a stamp
    // written before the commit is wiped by its own echo and macOS dictation
    // silently stops being marked.
    //
    // Stamped even when the commit REPORTS FAILURE: the evidence is about where
    // the text came from, not about whether finalising it worked.
    voiceEvidenceAt = now();
  }

  function rearmAllowed(from, to) {
    let cfg = null;
    try { cfg = getConfig(); } catch { cfg = null; }
    if (!cfg) return false;
    let mode = null;
    try { mode = getVoiceMode(); } catch { mode = null; }
    let attention = null;
    try { attention = getAttention(); } catch { attention = 'permission'; }
    return shouldRearm({
      enabled: cfg.enabled, rearm: cfg.rearm, voiceMode: mode, attention, from, to,
    });
  }

  // The re-arm, driven by the sidebar's activity state rather than by anything
  // this file can observe.
  //
  // NOT because the key is dead mid-turn — it is not. Measured in CLI 2.1.251:
  // the handler's only top guards are the voice auth gate and `isActive`, and
  // `isActive` at the main REPL is `!panelOpen` (a selector over the panel
  // store's `open` list), never a busy/streaming flag. With no panel open the
  // key is LIVE for the whole turn.
  //
  // The reason is what the live key would DO: mid-turn the composer is empty
  // and the recorder idle, so the tap branch ARMS a recording — one nobody
  // asked for, minutes before the operator is ready to speak. Arming is
  // deliberately confined to the turn-end edge, which is the transition
  // reported here.
  // A TRAILING window, not a one-shot delay, and that distinction is the whole
  // of it. The condition being waited on is "the terminal has stopped
  // painting", and on the wire path the composer repaint ALWAYS lands after
  // the edge — `turnCompleted` fires when the tee finishes the upstream
  // stream, so the CLI cannot have drawn its answer yet. A version of this
  // that RETURNED on a recent paint therefore declined permanently on the one
  // path that carries a truthful `turnEnd`, and no value of the constant fixed
  // it. Rescheduling is what turns "not yet" back into "later".
  //
  // Same shape as `schedule()` on the submit half, for the same reason.
  function attemptRearm() {
    rearmTimer = null;
    if (disposed) return;
    // The edge being waited on is stale: re-check it rather than trusting the
    // timer, since a dialog that opened means the byte would answer it.
    if (activity !== 'idle' || !rearmAllowed('thinking', 'idle')) return;

    const quietFor = now() - lastWriteAt;
    if (quietFor < rearmMs) {
      // Still painting. Give up only at the deadline, so one edge cannot
      // reschedule forever behind a spinner or a tailing log.
      if (now() >= rearmDeadline) return;
      rearmTimer = setTimeout(attemptRearm, rearmMs - quietFor);
      return;
    }

    // Last, because it is the only gate that reads the screen, and the reason
    // it is not optional: the CLI's tap handler bails on a NON-EMPTY composer
    // BEFORE it swallows the key, so the character would be INSERTED into the
    // operator's draft and would arm nothing. cursorRow() returns null off the
    // normal buffer, which composerIsEmpty declines too.
    if (!composerIsEmpty(cursorRow())) return;

    // The recorder is ALREADY running, so the trigger character would STOP it.
    // The CLI's tap recorder auto-finishes after ~15s of silence and only then
    // does our character arm it; a turn ending within that window leaves it
    // recording, and this is the read that tells the two apart.
    if (recorderBlocksRearm(indicatorRows())) return;

    if (tapTrigger()) rearms += 1;
  }

  // THE ONLY PLACE A TRIGGER CHARACTER IS WRITTEN. Four callers reach the
  // recorder through it — the turn-end re-arm, the submit-time stop, the
  // external ensure-on tap, and the operator's ensure-off click — and each
  // carries its OWN screen gate, which is the part that differs between them
  // and must stay at the call site. What is shared is only
  // what it takes to put the byte out, and a fourth caller open-coding that is
  // how this subsystem's polarity bugs started.
  //
  // TAP mode only, for the reason `shouldRearm` gives: the swallow-and-toggle
  // measured in the CLI is the tap branch specifically, and in hold mode a
  // single written character cannot reach the auto-repeat threshold, so it
  // lands in the draft as a literal instead of toggling anything. Reported
  // rather than thrown, so a caller can count what it actually wrote.
  function tapTrigger() {
    let mode = null;
    try { mode = getVoiceMode(); } catch { mode = null; }
    if (mode !== 'tap') return false;
    let key = null;
    // No plain character is bound to push-to-talk, so no byte can arm the
    // recorder — a space written in hope would just type into the draft.
    try { key = getTriggerKey(); } catch { key = null; }
    if (typeof key !== 'string' || key.length !== 1) return false;
    write(key);
    return true;
  }

  // ENSURE-ON, asked for from outside the app — a Voice Control wake word that
  // reached this seat over the agent socket rather than as a keystroke aimed at
  // whatever window happened to be frontmost.
  //
  // AN UNREADABLE SCREEN MUST NOT WRITE, and that is why this reads the rows
  // ONCE and tests the null ITSELF instead of asking `recordingObserved`. That
  // predicate answers `false` for an unreadable screen — correct where it feeds
  // the marker, fatal here: `if (!recordingObserved(rows)) tap()` sends the key
  // into a screen that may well be recording, and STOPS the operator
  // mid-sentence. The errors are not symmetric. Declining while the mic was
  // dark costs him one repeated phrase; writing while it was lit costs him the
  // sentence he was speaking.
  //
  // ENSURE-ON rather than toggle, and there is no off half to add: Voice
  // Control goes deaf while the recorder is live, so no wake word can be heard
  // to ask for one.
  //
  // Deliberately NOT gated on the turn-end edge the re-arm confines itself to.
  // That gate exists because arming mid-turn is a live microphone nobody asked
  // for; here the operator asked, out loud, which is the entire event.
  function externalTap() {
    if (disposed) return false;
    // A byte written into an open permission dialog ANSWERS it. The re-arm
    // declines there through `shouldRearm` and this owes the same interlock,
    // which it cannot inherit — the re-arm's gate also requires hands-free
    // submit to be switched on, and this feature is not that one.
    let attention = null;
    try { attention = getAttention(); } catch { attention = 'permission'; }
    if (attention === 'permission') return false;

    const rows = indicatorRows();
    // REDUNDANT TODAY AND KEPT ON PURPOSE: `recorderBlocksRearm(null)` is true,
    // so the line below already declines here and DELETING THIS LEAVES THE
    // SUITE GREEN. It stays because it states the polarity rule where the
    // decision is made rather than one file away, and because it is the defence
    // if that predicate is ever swapped for one whose null answers the other
    // way. Unpinned by construction — no fixture where the two predicates
    // disagree exists, and inventing one would pin an unreachable state.
    if (!Array.isArray(rows)) return false;      // unreadable: never write
    // BUSY, not merely lit — two reasons, and the second is not obvious from
    // here. A lit recorder means ensure-on is already met. But the CLI REPLACES
    // the lit indicator with `Voice: processing…` rather than adding to it, and
    // through that whole window its tap handler does NOT swallow a
    // single-character binding: the byte falls through as a LITERAL into the
    // composer, and a non-empty composer then blocks every later re-arm and
    // every later tap until it is cleared by hand.
    if (recorderBlocksRearm(rows)) return false;

    // The CLI's tap handler bails on a NON-EMPTY composer BEFORE it swallows
    // the key, so the character would be inserted into his draft and arm
    // nothing — the same read the re-arm makes, for the same reason.
    if (!composerIsEmpty(cursorRow())) return false;

    if (!tapTrigger()) return false;
    externalTaps += 1;
    return true;
  }

  // ENSURE-OFF, asked for by a CLICK on the indicator. The operator can see the
  // recorder is running and wants it stopped; lit stops it, anything else
  // declines and writes nothing.
  //
  // THE POLARITY IS NOT THE MIRROR OF `externalTap`'s, and reasoning it out is
  // the whole of this function. Both refuse an unreadable screen, and they do it
  // for DIFFERENT reasons — a symmetry that is a coincidence of this call site,
  // not a rule to factor out.
  //
  // The three errors, stated where the decision is made:
  //
  //   Write while LIT — the intended action. This is the only good branch.
  //   Write while DARK and the composer empty — arms a microphone he asked to
  //     turn OFF, the inverted failure, and one nobody is watching for because
  //     he believes he just stopped it.
  //   Write while DARK and the composer non-empty, or during PROCESSING — the
  //     byte is not swallowed and lands as a LITERAL in the draft (measured in
  //     2.1.251, see PROCESSING in lib/voice-submit.js). From then on every
  //     re-arm and every tap declines on the non-empty composer: a permanently
  //     stuck mic that only a manual clear escapes.
  //
  // So an unreadable screen DECLINES: two of its three outcomes are bad, one of
  // them permanent, while declining costs only that the recorder keeps running
  // until the CLI's own ~15s silence auto-finish or until he taps the key
  // himself. Recoverable beats permanent, the same direction every other writer
  // in this file chose.
  //
  // `recordingObserved` happens to answer false for null, which is the branch
  // this wants — but the null is tested EXPLICITLY above it anyway, because
  // "the convention happened to point the right way here" is not a reason a
  // reader can check, and it is what makes this line survive a predicate swap.
  function tapOff() {
    if (disposed) return false;
    // Same interlock as the ensure-on half and for the same reason: a byte
    // written into an open permission dialog ANSWERS it.
    let attention = null;
    try { attention = getAttention(); } catch { attention = 'permission'; }
    if (attention === 'permission') return false;

    const rows = indicatorRows();
    if (!Array.isArray(rows)) return false;   // unreadable: never write — redundant today (recordingObserved(null) is false); see above
    // LIT, not merely busy. During PROCESSING the recorder has already stopped,
    // so ensure-off is met and there is nothing to write for; the byte would
    // only land as the literal described above.
    if (!recordingObserved(rows)) return false;

    // The CLI paints `tap to send` beside the lit indicator, and that is what
    // the key does: while recording it stops AND SUBMITS. An empty composer is
    // what keeps this an ensure-off rather than a send of whatever is sitting
    // there unsent.
    if (!composerIsEmpty(cursorRow())) return false;

    if (!tapTrigger()) return false;
    offTaps += 1;
    return true;
  }

  // Every byte the local onData branch sends to the pty. The ONLY writer that
  // clears voice evidence, and it is what makes the marker mean "spoken" rather
  // than "the recorder happened to be on".
  //
  // Gated on isHumanPtyInput because onData also carries terminal chatter; a
  // clear on a mouse report would silently un-mark genuinely spoken text.
  function noteInput(data) {
    if (disposed) return;
    if (!isHumanPtyInput(data)) return;
    voiceEvidenceAt = null;
    mutedByTyping = true;
  }

  function noteActivity(state, turnEnd) {
    if (disposed) return;
    const from = activity;
    activity = state;
    if (from !== 'thinking' || state !== 'idle') return;
    // NOT merely idle. Two emitters produce `idle` mid-turn: the wire tracker's
    // gap-idle timer, when a tool runs longer than its gap with nothing in
    // flight, and the jsonl watcher's flush between tool calls. The key is LIVE
    // mid-turn (the handler gates on panels, not on busy), so a byte written on
    // one of these edges ARMS the recorder in the middle of a turn — a live
    // microphone the operator did not ask for and has no reason to expect.
    // Acting on the bare state edge does that on every long turn, which are the
    // ones this feature is for.
    if (turnEnd !== true) return;

    // Every gate is evaluated HERE and again when the timer lands. Cheap, and
    // it keeps the edge test where the edge actually is: by the time the timer
    // fires, `activity` may already have moved on.
    if (!rearmAllowed(from, state)) return;
    if (rearmTimer) clearTimeout(rearmTimer);
    rearmDeadline = now() + abandonMs;
    rearmTimer = setTimeout(attemptRearm, rearmMs);
  }

  // Trailing debounce: a write that CHANGES the composer restarts the window,
  // which is what makes the wait a quiet gate rather than a fixed delay.
  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, quietMs);
  };

  // The composer row as of the last write. Restarting the window on every write
  // instead starves it to death under tap recording: while the microphone is
  // live the CLI animates an audio level meter on a 50ms tick, far under
  // quietMs, so the window never elapsed and the submit fired only once the
  // operator STOPPED recording.
  //
  // Comparing what the gate READS, rather than counting frames or capping the
  // window, is what keeps the gate's purpose intact: the wait exists so that a
  // transcriber emitting the phrase mid-utterance cannot fire an unrecallable
  // submit, and every arrival of further speech changes this string. An
  // absolute ceiling would be the opposite trade — it would fire PRECISELY in
  // the state where the row is still changing, which is the state the wait is
  // for.
  //
  // The meter is not on a row of its own: the CLI renders it as the composer
  // input's `cursorChar`, so it animates INSIDE the cursor cell. cursorRow()
  // ends its read AT cursorX, exclusive, so that cell is already outside the
  // string compared here — which is why no glyph filtering is needed, and why
  // moving this comparison off cursorRow() onto an untruncated read would
  // restore the starvation.
  let lastRow = null;
  // A write is the only wake the BUFFER half needs: nothing else changes what
  // is on screen. The composition half cannot use it — while a composition is
  // pending onData has not fired and the buffer does not hold the text — so it
  // polls the overlay instead, on its own timer.
  //
  // lastWriteAt is stamped on EVERY write, unchanged: the re-arm half reads it
  // as "the terminal is still painting", and an animation is exactly the paint
  // it must keep waiting out.
  const subs = [terminal.onWriteParsed(() => {
    lastWriteAt = now();
    // A throw here would escape into xterm's onWriteParsed fire loop. No
    // reachable throw is known; a null read is already the "off the normal
    // buffer" case the compare below handles.
    let row = null;
    try { row = cursorRow(); } catch {}
    if (row === lastRow) return;
    lastRow = row;
    schedule();
  })];
  pollTimer = setInterval(pollComposition, pollMs);

  return {
    refresh: schedule,
    noteActivity,
    noteInput,
    externalTap,
    tapOff,
    // A GETTER over the existing 300ms poll, never a scan of its own: the
    // display must report what the gates last saw, and a fresh read on every
    // paint could answer differently from the decision it is describing.
    recorderReading: () => reading,
    fireCount: () => fires,
    stopCount: () => stops,
    rearmCount: () => rearms,
    externalTapCount: () => externalTaps,
    offTapCount: () => offTaps,
    commitCount: () => commits,
    commitFailureCount: () => commitFailures,
    markCount: () => marks,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (enterTimer) clearTimeout(enterTimer);
      if (stopTimer) clearTimeout(stopTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (rearmTimer) clearTimeout(rearmTimer);
      timer = null;
      enterTimer = null;
      stopTimer = null;
      pollTimer = null;
      rearmTimer = null;
      for (const s of subs) s.dispose();
    },
  };
}

module.exports = {
  createVoiceSubmitWatcher, readComposition, commitComposition,
  QUIET_MS, ENTER_SETTLE_MS, STOP_SETTLE_MS, COMPOSITION_POLL_MS, CONSUMED_IDLE_MS,
  REARM_SETTLE_MS, REARM_ABANDON_MS, VOICE_EVIDENCE_MS,
};
