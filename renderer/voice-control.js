// voice-control.js — the voice-mode state machine (off · tap · hold) and the
// Preferences selector over it.

const VOICE_ITEMS = [
  { mode: 'off', name: 'Off', desc: 'No voice input' },
  { mode: 'tap', name: 'Tap', desc: 'Tap to start dictating, tap again to stop' },
  { mode: 'hold', name: 'Hold', desc: 'Hold the key while speaking, release to send' },
];

const POLL_MS = 15000;
const CHOICE_DEBOUNCE_MS = 250;

// The shared state machine. Surfaces subscribe; the core never touches a
// surface's DOM.
function createVoiceCore({ showToast, getSeat = () => null }) {
  let state = null;
  let pending = null;
  let pendingSeat = null;
  let writeTimer = null;   // debounce handle: only the final choice is sent
  let pollTimer = null;    // runs only while a surface holds the core open
  let holds = 0;           // start/stop refcount — see start()
  const listeners = new Set();

  function isMode(m) { return VOICE_ITEMS.some((i) => i.mode === m); }

  function capable() { return !(state && state.capable === false); }

  function cause() { return (state && state.capable === false && state.cause) || null; }

  // A PURE read, for a surface that must paint synchronously (the bar button is
  // built inside renderSessionActions).
  function snapshot() {
    return {
      state, pending,
      mode: pending || (state && state.effective),
      capable: capable(), cause: cause(),
      force: false,
    };
  }

  function emit(force = false) {
    const snap = {
      state, pending,
      mode: pending || (state && state.effective),
      capable: capable(), cause: cause(),
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
    let seat = null;
    try { seat = getSeat() || null; } catch { seat = null; }
    try { r = await window.api.getVoiceMode(seat); } catch { r = null; }
    if (r && r.ok) {
      if (pending && pendingSeat !== (r.seat || null)) pending = null;
      state = r;
      if (pending && r.effective === pending) pending = null;
    }
    emit();
  }

  async function sendMode(mode, seat) {
    let r = null;
    try { r = await window.api.setVoiceMode(mode, seat); } catch (err) { r = { ok: false, error: err.message }; }
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
    refresh();
  }

  // Returns false when the pick was not actionable, so a surface can repaint
  // itself out of a selection the core is not going to honour.
  function choose(mode) {
    if (!isMode(mode)) { emit(true); return false; }
    pending = mode;
    try { pendingSeat = getSeat() || null; } catch { pendingSeat = null; }
    emit();
    const seat = pendingSeat;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => { writeTimer = null; sendMode(mode, seat); }, CHOICE_DEBOUNCE_MS);
    return true;
  }

  // REFCOUNTED because the two surfaces have different lifetimes: Preferences
  // holds only while its dialog is open, the bar holds for the life of the
  // window.
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
    const { pending, mode, force } = snap;
    // Never move the selection out from under an open/keyboard-driven picker:
    // the 15s poll and a window-focus refresh fire this on their own schedule,
    // and rewriting `value` mid-interaction would drag the operator's
    // highlighted option elsewhere.
    if (force || document.activeElement !== sel) {
      sel.value = core.isMode(mode) ? mode : '';
    }
    if (pending) {
      stateEl.textContent = `Switching to ${pending}…`;
    } else if (!core.isMode(mode)) {
      stateEl.textContent = 'No seat is focused — open a seat to set its voice mode.';
    } else {
      stateEl.textContent = '';
    }
  }

  core.subscribe(paint);

  sel.addEventListener('change', () => { core.choose(sel.value); });

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
