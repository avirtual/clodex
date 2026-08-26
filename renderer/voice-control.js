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

function createVoiceControl({ getActiveSession, sessionTypeOf, sessionList, showToast }) {
  const sel = document.getElementById('prefs-voice-mode');
  const stateEl = document.getElementById('prefs-voice-state');
  if (!sel || !stateEl) return { refresh() {} };

  let state = null;      // the last read of settings.json
  let pending = null;    // a mode injected but not yet observed in the file

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
    const mode = pending || (state && state.effective);
    sel.value = VOICE_ITEMS.some((i) => i.mode === mode) ? mode : '';
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

  sel.addEventListener('change', async () => {
    const mode = sel.value;
    // "Not set" is a READING of the file, not a mode — there is no `/voice ` to
    // send for it, so re-picking it is a no-op rather than an injection.
    if (!VOICE_ITEMS.some((i) => i.mode === mode)) { render(); return; }
    const target = injectTarget();
    if (!target) { render(); return; }
    pending = mode;
    render();
    let r = null;
    try { r = await window.api.injectPrompt(target, `/voice ${mode}`); } catch (err) { r = { ok: false, error: err.message }; }
    if (!r || !r.ok) {
      pending = null;
      render();
      showToast(`Setting voice to ${mode} failed: ${(r && r.error) || 'unknown error'}`);
      return;
    }
    // The injection is quiet-gated, so the file changes only once the CLI has
    // actually run the command. Re-read on a short delay AND leave the poll to
    // catch a parked one; the pending affordance stands until a read agrees.
    setTimeout(refresh, 1500);
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
