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

// The give-up notification's copy, lifted out of main.js and exported so it can be
// tested by CALLING it. A source pin on the template could only show that the copy
// interpolates SOMETHING — with the attribution wired to a dead value every such
// assertion still passed, which is how the bug below survived a review.
//
// Attribution is APPENDED as its own sentence, never folded into the first one: a
// wait armed from the menu can be JOINED by an agent 25 minutes later, and "the
// pending restart requested by X was dropped" then tells the operator that their
// own restart was someone else's. The appended form is true in all three cases —
// menu-only, agent-only, mixed. No duration for the same reason: a seat that
// joined a wait in progress did not wait the full cap.
function giveUpBody(names) {
  const asked = (Array.isArray(names) ? names : []).filter(Boolean);
  const base = 'Sessions stayed busy — the pending restart was dropped. Try again when work settles.';
  return asked.length ? `${base} Requested by: ${asked.join(', ')}.` : base;
}

// A one-shot waiter that arms a poll loop and fires `restart` only once EVERY live
// session has classified idle for a SUSTAINED window (default 10s) — a single busy
// sample resets the streak, because activityState flickers idle on mid-turn quiet
// gaps and an instant-idle snapshot is not "at rest". A 30-minute cap gives up the
// wait (calling `notify` with the requesting seat names — empty when the menu
// armed it — never forcing a restart). Arming while already armed does
// not restart the window (one waiter); disarm() cancels a pending wait.
function createIdleWaiter({
  getSessions, now, setTimer, clearTimer, restart, notify,
  pollMs = 2000, sustainMs = 10_000, capMs = 30 * 60_000,
}) {
  let timer = null;      // non-null iff armed
  let armedAt = 0;       // when the wait began (drives the cap)
  let quietSince = null; // start of the current all-idle streak, or null if busy
  // Who asked for this wait, and how to tell them it ended without a restart.
  // The agent path ([agent:reboot]) has no operator reading the give-up
  // notification, so a dropped wait it is never told about leaves a seat blocked
  // on a relaunch that will never come. Name and callback live in ONE record
  // because they are cleared on exactly the same events — two parallel arrays
  // would let a restart drop the callbacks and leave a stale name to be reported
  // against the NEXT wait.
  let requests = [];

  function isArmed() { return timer !== null; }

  // Seats that armed this wait, deduped, in arm order. Empty when the wait came
  // from the menu — the operator who pressed the button needs no attribution.
  function requesterNames() {
    const seen = [];
    for (const r of requests) if (r.name && !seen.includes(r.name)) seen.push(r.name);
    return seen;
  }

  // The reason is carried, not inferred: a requester told only "dropped" cannot
  // tell a 30-minute give-up from a human pressing Cancel, and the two demand
  // opposite advice — retry when work settles, versus do not retry, a person
  // said no.
  function drainAbandoned(reason) {
    const rs = requests;
    requests = [];
    for (const r of rs) { if (r.onAbandon) { try { r.onAbandon(reason); } catch {} } }
  }

  // `abandoned` separates the two ways a pending wait ends early: an operator
  // CANCELLING it (watchers must be told) from one consumed by an immediate
  // restart, where the request is about to be fulfilled and "dropped" would be a
  // lie the seat acts on.
  function disarm({ abandoned = false } = {}) {
    if (timer !== null) { clearTimer(timer); timer = null; }
    quietSince = null;
    if (abandoned) drainAbandoned('cancelled');
    else requests = [];
  }

  function tick() {
    timer = null; // consumed; re-armed at the tail unless we fire/give up
    const t = now();
    // Cap first: never wait past the give-up horizon, even if it's still busy.
    // Names BEFORE the drain — draining empties the records the names come from.
    if (t - armedAt >= capMs) {
      quietSince = null;
      const asked = requesterNames();
      try { notify(asked); } catch {}
      drainAbandoned('gave-up');
      return;
    }
    const { busy } = classifyRestart(getSessions());
    if (busy > 0) {
      quietSince = null; // any busy sample resets the sustained window
    } else {
      if (quietSince === null) quietSince = t; // streak begins now
      // Dropping the watchers here treats `restart()` as terminal and irreversible.
      // That holds for a host that quits; a future host whose restart can FAIL
      // asynchronously must re-register them before calling it, or its requesters
      // are left waiting on a restart that already fell over.
      if (t - quietSince >= sustainMs) { quietSince = null; requests = []; restart(); return; }
    }
    timer = setTimer(tick, pollMs);
  }

  // `onAbandon` is registered even when the timer is already armed, and the timer
  // is deliberately NOT re-armed in that case: re-arming resets armedAt, so a
  // stream of requests would push the give-up horizon out forever and the cap
  // would stop being a cap. The pending wait already serves the new request —
  // but every requester still has to learn how it ended.
  function arm({ onAbandon, requester } = {}) {
    const name = typeof requester === 'string' && requester ? requester : null;
    if (typeof onAbandon === 'function' || name) {
      requests.push({ name, onAbandon: typeof onAbandon === 'function' ? onAbandon : null });
    }
    if (timer !== null) return false; // already waiting — one waiter
    armedAt = now();
    quietSince = null;
    timer = setTimer(tick, pollMs);
    return true;
  }

  return { arm, disarm, isArmed };
}

module.exports = { classifyRestart, createIdleWaiter, giveUpBody };
