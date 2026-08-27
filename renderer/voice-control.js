// voice-control.js — the voice-mode state machine (off · tap · hold) and the
// Preferences selector over it.
//
// TWO SURFACES, ONE CORE. `createVoiceCore` owns the whole state machine;
// `createVoiceControl` is the Preferences selector and popovers/voice-popover.js
// is the session-bar button. What each surface is FOR: the bar answers "what is
// the seat I am looking at going to do", read at a glance without opening a
// dialog; Preferences is where the box-wide setting is stated in full, with the
// hint text explaining that it is box-wide at all. The setting itself is one per
// machine either way — `/voice` writes `~/.claude/settings.json`, which every
// Claude session here shares — so the bar button carries the same value the
// dialog does, and neither surface may keep its own copy of it.
//
// The core is what must not be duplicated: the pending/quiet-gate/focus-guard
// reconciliation below is subtle enough that a second copy would diverge. A
// surface owns only its own painting.
//
// STATE COMES FROM THE FILE, never from what we last injected. The user can type
// `/voice hold` in any terminal, so a last-injected mirror goes stale with no
// event to correct it; the read is re-run on window focus and on a slow poll.
// The CLI reads the setting at ITS startup and holds a mode in memory, so a
// long-running session and a freshly-changed file legitimately disagree — the
// label reflects the FILE, rather than claiming per-session truth the renderer
// cannot have.
//
// The WRITE is an injection, not an fs write: a running CLI would not pick up an
// edited file. Injection is quiet-gated (inject-queue parks it until the agent
// is quiet), so every surface must carry a pending affordance — mid-turn the
// command is queued, not lost, and a control that looked dead meanwhile would
// invite a second choice that queues a second command.
//
// The Preferences row is never HIDDEN, only disabled: it lives in a modal
// settings dialog that opens with no live Claude session at all, and a row that
// vanishes from a settings dialog reads as a missing feature rather than an
// unavailable one. The BAR button is the opposite case and is absent for a
// non-Claude seat — an always-present bar button would claim the seat under it
// has a voice mode when Codex has no `/voice` at all.
//
// DOM-bound, so no unit tests per the R1 rule; the read behind it is
// test/voice-settings.test.js.

const VOICE_ITEMS = [
  { mode: 'off', name: 'Off', desc: 'No voice input' },
  { mode: 'tap', name: 'Tap', desc: 'Tap to start dictating, tap again to stop' },
  { mode: 'hold', name: 'Hold', desc: 'Hold the key while speaking, release to send' },
];

const POLL_MS = 15000;
const CHOICE_DEBOUNCE_MS = 250;

// The shared state machine. Surfaces subscribe; the core never touches a
// surface's DOM.
function createVoiceCore({ getActiveSession, sessionTypeOf, sessionList, showToast }) {
  let state = null;        // the last read of settings.json
  let pending = null;      // a mode injected but not yet observed in the file
  let pendingTarget = null; // the session `pending` was queued into
  let injectTimer = null;  // debounce handle: only the final choice is sent
  let pollTimer = null;    // runs only while a surface holds the core open
  let holds = 0;           // start/stop refcount — see start()
  const listeners = new Set();

  // Which live LOCAL Claude session to inject into: the active tab when it is
  // one, else the first in the sidebar. A peer row is skipped — its `/voice`
  // would move the OTHER machine's settings, which this control does not claim
  // to reflect — as are archived and failed rows, which have no process to type
  // into.
  function injectTarget() {
    const active = getActiveSession();
    if (active && sessionTypeOf(active) === 'claude') return active;
    for (const el of sessionList.querySelectorAll('.session-item[data-type="claude"]')) {
      if (el.dataset.peerUi || el.dataset.failed) continue;
      if (el.classList.contains('archived') || el.classList.contains('peer-item')) continue;
      if (el.dataset.name) return el.dataset.name;
    }
    return null;
  }

  function anyClaudeRow() {
    return !!sessionList.querySelector('.session-item[data-type="claude"]');
  }

  function isMode(m) { return VOICE_ITEMS.some((i) => i.mode === m); }

  // A PURE read, for a surface that must paint synchronously (the bar button is
  // built inside renderSessionActions). It reports the pending that `emit` would
  // keep, without performing the drop itself — reconciling here would let
  // whichever surface happened to read first consume `pickJustDied` and leave
  // the other one painting a stale pick.
  function snapshot() {
    const target = injectTarget();
    const live = target === pendingTarget ? pending : null;
    return {
      target, state, pending: live,
      mode: live || (state && state.effective),
      anyClaudeRow: anyClaudeRow(),
      pickJustDied: false,
      force: false,
    };
  }

  // The one place the pending/target reconciliation happens, so it happens once
  // per change no matter how many surfaces are mounted.
  function emit(force = false) {
    const target = injectTarget();
    // The pick no longer points at the session the command is parked in, so the
    // affordance can no longer describe anything a surface can observe.
    const hadPending = pending !== null;
    if (target !== pendingTarget) { pending = null; pendingTarget = null; }
    const snap = {
      target, state, pending,
      mode: pending || (state && state.effective),
      anyClaudeRow: anyClaudeRow(),
      pickJustDied: hadPending && pending === null,
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
      // The file caught up with what we injected — drop the pending affordance.
      // Only an EQUAL reading clears it: a differing one means the command has
      // not landed yet, not that it was rejected.
      if (pending && r.effective === pending) { pending = null; pendingTarget = null; }
    }
    emit();
  }

  async function sendMode(mode) {
    const target = injectTarget();
    if (!target) { pending = null; pendingTarget = null; emit(); return; }
    let r = null;
    try { r = await window.api.injectPrompt(target, `/voice ${mode}`); } catch (err) { r = { ok: false, error: err.message }; }
    if (!r || !r.ok) {
      // Only the injection that still OWNS `pending` may clear it. A slow first
      // attempt can fail after a second choice has already been made and sent;
      // without this it would wipe the live one's affordance and toast a mode
      // the operator has already moved on from.
      if (pending !== mode) return;
      pending = null;
      pendingTarget = null;
      emit(true);
      showToast(`Setting voice to ${mode} failed: ${(r && r.error) || 'unknown error'}`);
      return;
    }
    // The injection is quiet-gated, so the file changes only once the CLI has
    // actually run the command. Re-read on a short delay AND leave the poll to
    // catch a parked one; the pending affordance stands until a read agrees.
    setTimeout(refresh, 1500);
  }

  // Returns false when the pick was not actionable, so a surface can repaint
  // itself out of a selection the core is not going to honour.
  function choose(mode) {
    // "Not set" is a READING of the file, not a mode — there is no `/voice ` to
    // send for it, so re-picking it is a no-op rather than an injection.
    if (!isMode(mode)) { emit(true); return false; }
    const target = injectTarget();
    if (!target) { emit(true); return false; }
    pending = mode;
    pendingTarget = target;
    emit();
    // Coalesce to the FINAL value. On the platforms the web-dist frontend is
    // served to, a closed <select> cycles through its options on arrow keys and
    // fires `change` at each one — so keyboard selection would otherwise inject
    // a slash command per option passed over, landing real commands in a live
    // agent's transcript. Converging eventually is not enough when the
    // intermediate states are things someone has to read in their session.
    if (injectTimer) clearTimeout(injectTimer);
    injectTimer = setTimeout(() => { injectTimer = null; sendMode(mode); }, CHOICE_DEBOUNCE_MS);
    return true;
  }

  // Enablement is a function of the session ROWS, and the core owns that watch
  // rather than being re-rendered from a call site in renderer.js: a session can
  // die with no focus change and no user action (a PTY exit needs neither), and
  // a surface would then keep offering a target that is gone.
  const observer = new MutationObserver(() => emit());

  // REFCOUNTED because the two surfaces have different lifetimes: Preferences
  // holds only while its dialog is open, the bar holds for the life of the
  // window. The dialog closing must not stop the poll under the bar, which is
  // on screen the whole time and whose label is a claim about the file.
  function start() {
    holds++;
    if (holds === 1) {
      if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
      observer.observe(sessionList, { childList: true, subtree: true });
    }
    refresh();
  }

  function stop() {
    if (holds > 0) holds--;
    if (holds > 0) return;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    observer.disconnect();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // A `/voice` typed straight into a terminal changes the file with no event of
  // any kind, so focus is the cheapest moment to notice; the poll covers a
  // window that never loses focus.
  window.addEventListener('focus', () => { if (holds > 0) refresh(); });

  return { snapshot, subscribe, choose, refresh, repaint: emit, start, stop, isMode };
}

// The Preferences surface: a <select> plus a state line, over the shared core.
function createVoiceControl({ core }) {
  const sel = document.getElementById('prefs-voice-mode');
  const stateEl = document.getElementById('prefs-voice-state');
  // Both no-ops: a caller that finds `render` on one branch and not the other
  // gets a TypeError only on the markup-missing path, which is the one nobody
  // exercises.
  if (!sel || !stateEl) return { refresh() {}, render() {}, start() {}, stop() {} };

  function paint(snap) {
    const { target, state, pending, mode, pickJustDied, force } = snap;
    // Never move the selection out from under an open/keyboard-driven picker: a
    // session-row repaint fires this on its own schedule, and rewriting `value`
    // mid-interaction would drag the operator's highlighted option elsewhere.
    // The exception is the pick dying UNDER the operator — where skipping the
    // write would leave that dead pick on screen beneath a line saying the value
    // came from the file.
    if (force || document.activeElement !== sel || pickJustDied) {
      sel.value = core.isMode(mode) ? mode : '';
    }
    sel.disabled = !target;
    // The two unreachable cases are told apart because the remedy differs: start
    // a Claude session, versus wait for the one you have. Both keep the row.
    if (!target) {
      stateEl.textContent = snap.anyClaudeRow
        ? 'No Claude session can be reached right now — the mode is shown from the file but cannot be changed from here.'
        : 'No Claude session on this machine — start one to change the mode. The value shown is read from the settings file.';
    } else if (pending) {
      stateEl.textContent = `Switching to ${pending} — queued until ${target} is between turns.`;
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
  // arrived meanwhile — a failed injection reverting the pick, or an external
  // `/voice` the poll read — is unpainted until something repaints. Blur is that
  // moment; without it the row can sit showing a mode the file contradicts.
  sel.addEventListener('blur', () => core.repaint());

  return {
    refresh: () => core.refresh(),
    render: (force) => core.repaint(!!force),
    start: () => core.start(),
    stop: () => core.stop(),
  };
}

module.exports = { createVoiceCore, createVoiceControl, VOICE_ITEMS };
