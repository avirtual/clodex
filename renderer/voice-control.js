// voice-control.js — the voice-mode state machine (off · tap · hold) and the
// Preferences selector over it.
//
// TWO SURFACES, ONE CORE. `createVoiceCore` owns the whole state machine;
// `createVoiceControl` is the Preferences selector and popovers/voice-popover.js
// is the session-bar button. What each surface is FOR: the bar answers "what is
// the seat I am looking at going to do", read at a glance without opening a
// dialog; Preferences is where the box-wide setting is stated in full, with the
// hint text explaining that it is box-wide at all. The setting itself is one per
// machine either way — it lives in `~/.claude/settings.json`, which every Claude
// session here shares — so the bar button carries the same value the dialog
// does, and neither surface may keep its own copy of it.
//
// STATE COMES FROM THE FILE, never from what we last wrote. The user can type
// `/voice hold` in any terminal, so a last-written mirror goes stale with no
// event to correct it; the read is re-run on window focus and on a slow poll.
// The label reflects the FILE rather than claiming per-session truth the
// renderer cannot have: a session the CLI is not watching (it watches only
// directories that had a settings file when that session started) can sit on a
// mode the file no longer names.
//
// The WRITE goes STRAIGHT TO THE FILE through `settings:setVoiceMode`, the same
// writer the `voice mode` verb uses. There is no session in the path: the
// setting is box-wide and the file is writable with none open, so a control
// keyed to a live seat would refuse a write that was always possible.
//
// WE SKIP THE FOUR GATES the CLI runs before its own `/voice` write (recording
// availability, voice-stream entitlement, audio-tool dependencies, microphone
// permission). Accepted deliberately: a mode is a stored PREFERENCE, the CLI
// re-checks all four when recording actually starts, so the worst case is a
// preference persisted on a box that cannot record — recoverable and honest. Do
// NOT re-implement any of them here; that would be a second, drifting copy of a
// vendor policy we cannot see.
//
// The Preferences row is never HIDDEN: it lives in a modal settings dialog that
// opens with no live Claude session at all, and a row that vanishes from a
// settings dialog reads as a missing feature rather than an unavailable one. The
// BAR button is the opposite case and is absent for a non-Claude seat — an
// always-present bar button would claim the seat under it has a voice mode when
// Codex has no `/voice` at all.
//
// `createVoiceCore` is DOM-free and unit-tested in test/voice-core.test.js; only
// `createVoiceControl`'s paint is DOM-bound per the R1 rule. The read behind
// both is test/voice-settings.test.js.

const VOICE_ITEMS = [
  { mode: 'off', name: 'Off', desc: 'No voice input' },
  { mode: 'tap', name: 'Tap', desc: 'Tap to start dictating, tap again to stop' },
  { mode: 'hold', name: 'Hold', desc: 'Hold the key while speaking, release to send' },
];

const POLL_MS = 15000;
const CHOICE_DEBOUNCE_MS = 250;

// The shared state machine. Surfaces subscribe; the core never touches a
// surface's DOM.
function createVoiceCore({ showToast }) {
  let state = null;        // the last read of settings.json
  let pending = null;      // a mode written but not yet observed in the file
  let writeTimer = null;   // debounce handle: only the final choice is sent
  let pollTimer = null;    // runs only while a surface holds the core open
  let holds = 0;           // start/stop refcount — see start()
  const listeners = new Set();

  function isMode(m) { return VOICE_ITEMS.some((i) => i.mode === m); }

  // A PURE read, for a surface that must paint synchronously (the bar button is
  // built inside renderSessionActions).
  function snapshot() {
    return {
      state, pending,
      mode: pending || (state && state.effective),
      force: false,
    };
  }

  function emit(force = false) {
    const snap = {
      state, pending,
      mode: pending || (state && state.effective),
      force,
    };
    // Per-listener guard: the surfaces are notified in subscription order, so an
    // unguarded throw in Preferences (listener #1) permanently starves the bar
    // (#2). Not a bare `catch {}` — before the core/surface split a painter throw
    // reached the console on its own, and swallowing it here would trade one
    // visible bug for a surface that silently stops updating.
    for (const fn of [...listeners]) {
      try { fn(snap); } catch (e) { console.error('[voice] surface paint failed', e); }
    }
  }

  async function refresh() {
    let r = null;
    try { r = await window.api.getVoiceMode(); } catch { r = null; }
    if (r && r.ok) {
      state = r;
      // The file caught up with what we wrote — drop the pending affordance.
      // Only an EQUAL reading clears it: a differing one means the write has not
      // landed yet, not that it was rejected.
      if (pending && r.effective === pending) pending = null;
    }
    emit();
  }

  async function sendMode(mode) {
    let r = null;
    try { r = await window.api.setVoiceMode(mode); } catch (err) { r = { ok: false, error: err.message }; }
    if (!r || !r.ok) {
      // Only the write that still OWNS `pending` may clear it. A slow first
      // attempt can fail after a second choice has already been made and sent;
      // without this it would wipe the live one's affordance and toast a mode
      // the operator has already moved on from.
      if (pending !== mode) return;
      pending = null;
      emit(true);
      showToast(`Setting voice to ${mode} failed: ${(r && r.error) || 'unknown error'}`);
      return;
    }
    // Re-read rather than trusting the write: `effective` is the read's own fold
    // over the two keys, and the poll would otherwise own retiring the
    // affordance 15s later.
    refresh();
  }

  // Returns false when the pick was not actionable, so a surface can repaint
  // itself out of a selection the core is not going to honour.
  function choose(mode) {
    // "Not set" is a READING of the file, not a mode — there is nothing to write
    // for it, so re-picking it is a no-op.
    if (!isMode(mode)) { emit(true); return false; }
    pending = mode;
    emit();
    // Coalesce to the FINAL value. On the platforms the web-dist frontend is
    // served to, a closed <select> cycles through its options on arrow keys and
    // fires `change` at each one — so keyboard selection would otherwise perform
    // one atomic write of the user's global settings file per option passed
    // over. Converging eventually is not enough when each intermediate step
    // rewrites a file the operator shares with every Claude session on the box.
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => { writeTimer = null; sendMode(mode); }, CHOICE_DEBOUNCE_MS);
    return true;
  }

  // REFCOUNTED because the two surfaces have different lifetimes: Preferences
  // holds only while its dialog is open, the bar holds for the life of the
  // window. The dialog closing must not stop the poll under the bar, which is
  // on screen the whole time and whose label is a claim about the file.
  function start() {
    holds++;
    if (holds === 1 && !pollTimer) pollTimer = setInterval(refresh, POLL_MS);
    refresh();
  }

  function stop() {
    if (holds > 0) holds--;
    if (holds > 0) return;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // A `/voice` typed straight into a terminal changes the file with no event of
  // any kind, so focus is the cheapest moment to notice; the poll covers a
  // window that never loses focus.
  window.addEventListener('focus', () => { if (holds > 0) refresh(); });

  // The push-to-talk binding as the CLI resolves it, or null when no plain
  // character is bound to it. Read off the same payload `state` already holds,
  // so it costs no extra IPC and cannot drift from the mode beside it.
  function triggerBinding() {
    return (state && state.trigger && state.trigger.binding) || null;
  }

  return {
    snapshot, subscribe, choose, refresh, repaint: emit, start, stop, isMode,
    triggerBinding,
  };
}

// The Preferences surface: a <select> plus a state line, over the shared core.
function createVoiceControl({ core }) {
  const sel = document.getElementById('prefs-voice-mode');
  const stateEl = document.getElementById('prefs-voice-state');
  // The same SHAPE as the real return below: a method present on one branch and
  // missing on the other gets a TypeError only on the markup-missing path, which
  // is the one nobody exercises.
  if (!sel || !stateEl) return { start() {}, stop() {} };

  function paint(snap) {
    const { state, pending, mode, force } = snap;
    // Never move the selection out from under an open/keyboard-driven picker: a
    // session-row repaint fires this on its own schedule, and rewriting `value`
    // mid-interaction would drag the operator's highlighted option elsewhere.
    if (force || document.activeElement !== sel) {
      sel.value = core.isMode(mode) ? mode : '';
    }
    if (pending) {
      stateEl.textContent = `Switching to ${pending}…`;
    } else if (!core.isMode(mode)) {
      stateEl.textContent = state && state.source === 'legacy'
        ? 'Only the legacy voiceEnabled key is set in the settings file — pick a mode to set one.'
        : 'Not set in the settings file yet — pick a mode to set one.';
    } else {
      stateEl.textContent = '';
    }
  }

  core.subscribe(paint);

  sel.addEventListener('change', () => { core.choose(sel.value); });

  // The value write above is skipped while the picker holds focus, so whatever
  // arrived meanwhile — a failed write reverting the pick, or an external
  // `/voice` the poll read — is unpainted until something repaints. Blur is that
  // moment; without it the row can sit showing a mode the file contradicts.
  sel.addEventListener('blur', () => core.repaint());

  // start/stop ONLY. `refresh` and `render` were exported here with no caller in
  // renderer.js; `render`'s `(force)` parameter was the r4 shape itself, a
  // parameterised function sitting ready for a by-name registration to hand it
  // an Event as `force`. Painting is driven by the core's subscription above.
  return {
    start: () => core.start(),
    stop: () => core.stop(),
  };
}

module.exports = { createVoiceCore, createVoiceControl, VOICE_ITEMS };
