// voice-control.js — the Preferences voice-mode selector: off · tap · hold.
//
// BOX-WIDE, not per-session. `/voice` writes `~/.claude/settings.json`, which
// every Claude session on this machine shares, so a home on the per-session
// proxy bar would look scoped to the seat under it while moving a global.
// #prefs-dialog is box-wide by nature — every setting in it already means "this
// machine" — so the location carries that fact instead of wording having to.
//
// STATE COMES FROM THE FILE, never from what we last injected. The user can type
// `/voice hold` in any terminal, so a last-injected mirror goes stale with no
// event to correct it; the read is re-run when the dialog opens, on window
// focus, and on a slow poll. The CLI reads the setting at ITS startup and holds
// a mode in memory, so a long-running session and a freshly-changed file
// legitimately disagree — the label reflects the FILE and the hint says so,
// rather than claiming per-session truth the renderer cannot have.
//
// The WRITE is an injection, not an fs write: a running CLI would not pick up an
// edited file. Injection is quiet-gated (inject-queue parks it until the agent
// is quiet), so the state line carries a pending affordance — mid-turn the
// command is queued, not lost, and a control that looked dead meanwhile would
// invite a second choice that queues a second command.
//
// The row is never HIDDEN, only disabled: it lives in a modal settings dialog
// that opens with no live Claude session at all, and a row that vanishes from a
// settings dialog reads as a missing feature rather than an unavailable one.
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

function createVoiceControl({ getActiveSession, sessionTypeOf, sessionList, showToast }) {
  const sel = document.getElementById('prefs-voice-mode');
  const stateEl = document.getElementById('prefs-voice-state');
  if (!sel || !stateEl) return { refresh() {} };

  let state = null;        // the last read of settings.json
  let pending = null;      // a mode injected but not yet observed in the file
  let injectTimer = null;  // debounce handle: only the final choice is sent

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

  function render() {
    const target = injectTarget();
    // A pending injection with nowhere to land can never flush: the queue that
    // would carry it belongs to a session that is gone or unreachable, so the
    // intent is dead rather than merely unshowable. Clearing it HERE, not at the
    // one read site below, is what keeps the row's promise that what it shows
    // came from the file — a surviving `pending` would be displayed as the
    // current mode while nothing will ever make it true.
    if (!target) pending = null;
    const mode = pending || (state && state.effective);
    // Never move the selection out from under an open/keyboard-driven picker: a
    // session-row repaint fires this on its own schedule, and rewriting `value`
    // mid-interaction would drag the operator's highlighted option elsewhere.
    // Losing the target is the exception — the row is about to be disabled, which
    // blurs it anyway, and skipping the write there would leave the operator's
    // dead pick on screen under a line saying the value came from the file.
    if (document.activeElement !== sel || !target) {
      sel.value = VOICE_ITEMS.some((i) => i.mode === mode) ? mode : '';
    }
    sel.disabled = !target;
    // The two unreachable cases are told apart because the remedy differs: start
    // a Claude session, versus wait for the one you have. Both keep the row.
    if (!target) {
      stateEl.textContent = anyClaudeRow()
        ? 'No Claude session can be reached right now — the mode is shown from the file but cannot be changed from here.'
        : 'No Claude session on this machine — start one to change the mode. The value shown is read from the settings file.';
    } else if (pending) {
      stateEl.textContent = `Switching to ${pending} — queued until ${target} is between turns.`;
    } else if (!VOICE_ITEMS.some((i) => i.mode === mode)) {
      stateEl.textContent = state && state.source === 'legacy'
        ? 'Only the legacy voiceEnabled key is set in the settings file — pick a mode to set one.'
        : 'Not set in the settings file yet — pick a mode to set one.';
    } else {
      stateEl.textContent = '';
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
      if (pending && r.effective === pending) pending = null;
    }
    render();
  }

  async function sendMode(mode) {
    const target = injectTarget();
    if (!target) { pending = null; render(); return; }
    let r = null;
    try { r = await window.api.injectPrompt(target, `/voice ${mode}`); } catch (err) { r = { ok: false, error: err.message }; }
    if (!r || !r.ok) {
      // Only the injection that still OWNS `pending` may clear it. A slow first
      // attempt can fail after a second choice has already been made and sent;
      // without this it would wipe the live one's affordance and toast a mode
      // the operator has already moved on from.
      if (pending !== mode) return;
      pending = null;
      render();
      showToast(`Setting voice to ${mode} failed: ${(r && r.error) || 'unknown error'}`);
      return;
    }
    // The injection is quiet-gated, so the file changes only once the CLI has
    // actually run the command. Re-read on a short delay AND leave the poll to
    // catch a parked one; the pending affordance stands until a read agrees.
    setTimeout(refresh, 1500);
  }

  sel.addEventListener('change', () => {
    const mode = sel.value;
    // "Not set" is a READING of the file, not a mode — there is no `/voice ` to
    // send for it, so re-picking it is a no-op rather than an injection.
    if (!VOICE_ITEMS.some((i) => i.mode === mode)) { render(); return; }
    const target = injectTarget();
    if (!target) { render(); return; }
    pending = mode;
    render();
    // Coalesce to the FINAL value. On the platforms the web-dist frontend is
    // served to, a closed <select> cycles through its options on arrow keys and
    // fires `change` at each one — so keyboard selection would otherwise inject
    // a slash command per option passed over, landing real commands in a live
    // agent's transcript. Converging eventually is not enough when the
    // intermediate states are things someone has to read in their session.
    if (injectTimer) clearTimeout(injectTimer);
    injectTimer = setTimeout(() => { injectTimer = null; sendMode(mode); }, CHOICE_DEBOUNCE_MS);
  });

  // A `/voice` typed straight into a terminal changes the file with no event of
  // any kind, so focus is the cheapest moment to notice; the poll covers a
  // window that never loses focus.
  window.addEventListener('focus', refresh);
  setInterval(refresh, POLL_MS);
  // Enablement is a function of the session ROWS, and the island owns that watch
  // rather than being re-rendered from a call site in renderer.js: the dialog is
  // modal but a session can still die under it (a PTY exit needs no focus), and
  // the row would then stay enabled over a target that is gone.
  new MutationObserver(render).observe(sessionList, { childList: true, subtree: true });

  refresh();
  return { refresh, render };
}

module.exports = { createVoiceControl, VOICE_ITEMS };
