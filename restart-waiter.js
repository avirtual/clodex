// restart-waiter.js — the countable/waitable logic behind the "Restart Clodex"
// dialog (T32). Pure leaf: no electron, no main.js identifiers — everything
// (clock, timers, the session snapshot, the restart/notify actions) is injected,
// so the sustained-idle window logic is unit-testable with a fake clock. main.js
// is the thin shell that wires the real dialog + setTimeout + Notification onto it.
//
// "Running" in the dialog means MID-TURN, not merely alive: an idle agent session
// resumes cleanly (--resume) and loses nothing, so the scary "15 running sessions"
// count should reflect only the seats actually working. activityState is only ever
// 'thinking' or 'idle' (wire ActivityTracker + jsonl-watcher), so "not idle" is the
// conservative busy read — a hypothetical future non-idle state counts as busy (the
// safe side: we'd wait rather than interrupt). Bash/shell sessions carry no turns
// (agentType null, activityState never leaves its 'idle' seed) so they can never be
// busy — the agentType gate makes that explicit rather than leaning on the seed.

// Classify a live-session snapshot into { busy, idle } counts. `sessions` is any
// iterable of session objects (Array.from(manager.sessions.values())). Dead seats
// are ignored entirely (they're already gone, not interruptions).
function classifyRestart(sessions) {
  let busy = 0;
  let idle = 0;
  for (const s of sessions) {
    if (!s || s._dead) continue;
    // Only an agent seat mid-turn counts as an interruption. Bash panes (agentType
    // null) have no turns; an agent at 'idle' resumes cleanly.
    if (s.agentType && s.activityState !== 'idle') busy += 1;
    else idle += 1;
  }
  return { busy, idle };
}

// A one-shot waiter that arms a poll loop and fires `restart` only once EVERY live
// session has classified idle for a SUSTAINED window (default 10s) — a single busy
// sample resets the streak, because activityState flickers idle on mid-turn quiet
// gaps and an instant-idle snapshot is not "at rest". A 30-minute cap gives up the
// wait (calling `notify`, never forcing a restart). Arming while already armed is a
// no-op (one waiter); disarm() cancels a pending wait.
function createIdleWaiter({
  getSessions, now, setTimer, clearTimer, restart, notify,
  pollMs = 2000, sustainMs = 10_000, capMs = 30 * 60_000,
}) {
  let timer = null;      // non-null iff armed
  let armedAt = 0;       // when the wait began (drives the cap)
  let quietSince = null; // start of the current all-idle streak, or null if busy

  function isArmed() { return timer !== null; }

  function disarm() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    quietSince = null;
  }

  function tick() {
    timer = null; // consumed; re-armed at the tail unless we fire/give up
    const t = now();
    // Cap first: never wait past the give-up horizon, even if it's still busy.
    if (t - armedAt >= capMs) { quietSince = null; try { notify(); } catch {} return; }
    const { busy } = classifyRestart(getSessions());
    if (busy > 0) {
      quietSince = null; // any busy sample resets the sustained window
    } else {
      if (quietSince === null) quietSince = t; // streak begins now
      if (t - quietSince >= sustainMs) { quietSince = null; restart(); return; }
    }
    timer = setTimer(tick, pollMs);
  }

  function arm() {
    if (timer !== null) return false; // already waiting — one waiter
    armedAt = now();
    quietSince = null;
    timer = setTimer(tick, pollMs);
    return true;
  }

  return { arm, disarm, isArmed };
}

module.exports = { classifyRestart, createIdleWaiter };
