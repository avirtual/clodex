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
function giveUpBody(names, { suiteJobs = 0, sessionsBusy = true } = {}) {
  const asked = (Array.isArray(names) ? names : []).filter(Boolean);
  const { text, total: n } = suiteJobsPhrase(suiteJobs);
  const jobs = `${text} did not finish`;
  const why = !n ? 'Sessions stayed busy' : sessionsBusy ? `Sessions stayed busy and ${jobs}` : jobs.charAt(0).toUpperCase() + jobs.slice(1);
  const base = `${why} — the pending restart was dropped. Try again when work settles.`;
  return asked.length ? `${base} Requested by: ${asked.join(', ')}.` : base;
}

const TEAM_LABEL_MAX = 32;
const SUITE_LINE_MAX = 160;

function plainLabel(s, max) {
  const t = String(s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function outboundPhrase(jobs) {
  const by = new Map();
  for (const j of jobs) {
    const where = plainLabel(j.runner, TEAM_LABEL_MAX);
    if (!by.has(where)) by.set(where, []);
    by.get(where).push(plainLabel([j.team, j.ticket, j.kind].filter((x) => x != null && x !== '').join(' '), TEAM_LABEL_MAX));
  }
  const parts = [...by].map(([where, labels]) => {
    const named = labels.filter(Boolean);
    return `${labels.length} run${labels.length === 1 ? '' : 's'} on ${where}${named.length ? ` (${named.join(', ')})` : ''}`;
  });
  const text = parts.join(', ');
  return text.length > SUITE_LINE_MAX ? `${text.slice(0, SUITE_LINE_MAX - 1)}…` : text;
}

function splitSuiteJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  return { local: list.filter((j) => j.runner == null), outbound: list.filter((j) => j.runner != null) };
}

function suiteJobsLine(jobs) {
  const { local, outbound } = splitSuiteJobs(jobs);
  const away = outbound.length ? `${outboundPhrase(outbound)} ${outbound.length === 1 ? 'is' : 'are'} in flight.` : '';
  const line = localJobsLine(local);
  return [line, away].filter(Boolean).join('\n');
}

function localJobsLine(list) {
  if (!list.length) return '';
  const teams = [];
  for (const j of list) {
    const name = j.team == null ? '' : plainLabel(j.team, TEAM_LABEL_MAX);
    if (name && !teams.includes(name)) teams.push(name);
  }
  const n = list.length;
  const head = `${n} suite job${n === 1 ? '' : 's'} this machine is running for other teams ${n === 1 ? 'is' : 'are'} in flight`;
  const line = teams.length ? `${head} (${teams.join(', ')}).` : `${head}.`;
  return line.length > SUITE_LINE_MAX ? `${line.slice(0, SUITE_LINE_MAX - 1)}…` : line;
}

function suiteWaitClause(jobs) {
  const { local, outbound } = splitSuiteJobs(jobs);
  const n = Array.isArray(jobs) ? local.length : Number.isInteger(jobs) && jobs > 0 ? jobs : 0;
  const parts = [
    ...(n > 0 ? [`${n} suite job${n === 1 ? '' : 's'} this machine is running for other teams`] : []),
    ...(outbound.length ? [outboundPhrase(outbound)] : []),
  ];
  if (!parts.length) return '';
  const one = parts.length === 1 && (n || outbound.length) === 1;
  return ` and ${parts.join(' and ')} finish${one ? 'es' : ''}`;
}

function suiteJobsPhrase(jobs) {
  const { local, outbound } = splitSuiteJobs(jobs);
  const n = Array.isArray(jobs) ? local.length : Number.isInteger(jobs) && jobs > 0 ? jobs : 0;
  const parts = [...(n > 0 ? [suiteJobsCount(n)] : []), ...(outbound.length ? [outboundPhrase(outbound)] : [])];
  return { text: parts.join(' and '), total: n + outbound.length };
}

function restartDetail({ busy = 0, idle = 0, jobs = [] } = {}) {
  const line = suiteJobsLine(jobs);
  const restored = idle ? `${idle} idle session${idle === 1 ? '' : 's'} will be restored cleanly` : '';
  const seats = busy
    ? `${busy} session${busy === 1 ? ' is' : 's are'} mid-turn${restored ? `; ${restored}` : ''}.`
    : restored ? `${restored.charAt(0).toUpperCase()}${restored.slice(1)}.` : '';
  const tail = line
    ? 'Restart When Idle waits until work settles and the suite jobs finish; Restart Now interrupts and cuts the suite jobs.'
    : 'Restart When Idle waits until work settles; Restart Now interrupts.';
  if (!line) return `${seats} ${tail}`;
  return [seats, line, tail].filter(Boolean).join('\n');
}

function pendingDetail(jobs) {
  return `Clodex will restart once every session and the keyboard are idle${suiteWaitClause(Array.isArray(jobs) ? jobs.filter(Boolean) : 0)}. Restart now anyway, cancel the pending restart, or keep waiting?`;
}

// A one-shot waiter that arms a poll loop and fires `restart` only once EVERY live
// session has classified idle for a SUSTAINED window (default 10s) — a single busy
// sample resets the streak, because activityState flickers idle on mid-turn quiet
// gaps and an instant-idle snapshot is not "at rest". A 30-minute cap gives up the
// wait (calling `notify` with the requesting seat names — empty when the menu
// armed it — never forcing a restart). Arming while already armed does
// not restart the window (one waiter); disarm() cancels a pending wait.
function createIdleWaiter({
  getSessions, now, setTimer, clearTimer, restart, notify, lastInputAt,
  inFlightRuns = () => [], suiteJobs = () => [], fence = null, log = null,
  pollMs = 2000, sustainMs = 10_000, capMs = 30 * 60_000, operatorQuietMs = sustainMs,
  runCapMs = 10 * 60_000,
}) {
  let timer = null;      // non-null iff armed
  let armedAt = 0;       // when the wait began (drives the cap)
  let quietSince = null; // start of the current all-idle streak, or null if busy
  let heldOnRuns = '';
  let fenced = false;
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
    setFence(false);
  }

  function setFence(on) {
    if (fenced === on) return;
    fenced = on;
    if (fence) { try { fence(on); } catch {} }
  }

  function liveSuiteJobs() {
    try {
      const jobs = suiteJobs();
      return Array.isArray(jobs) ? jobs : [];
    } catch { return []; }
  }

  function tick() {
    timer = null; // consumed; re-armed at the tail unless we fire/give up
    const t = now();
    // Cap first: never wait past the give-up horizon, even if it's still busy.
    // Names BEFORE the drain — draining empties the records the names come from.
    if (t - armedAt >= capMs) {
      quietSince = null;
      const asked = requesterNames();
      let held = [];
      try { held = inFlightRuns() || []; } catch { held = []; }
      const sessionsBusy = classifyRestart(getSessions()).busy > 0 || held.length > 0 || t - lastInputAt() < operatorQuietMs;
      try { notify(asked, { suiteJobs: liveSuiteJobs(), sessionsBusy }); } catch {}
      drainAbandoned('gave-up');
      setFence(false);
      return;
    }
    const { busy } = classifyRestart(getSessions());
    const suiteHold = liveSuiteJobs().length > 0;
    let runs = [];
    try { runs = inFlightRuns() || []; } catch { runs = []; }
    const runsPastCap = runs.length > 0 && t - armedAt >= runCapMs;
    const runsHold = runs.length > 0 && !runsPastCap;
    if (runsHold) {
      const key = runs.join(', ');
      if (key !== heldOnRuns) {
        heldOnRuns = key;
        if (log) { try { log.info('app', `restart waiting on in-flight exec runs: ${key}`); } catch {} }
      }
    }
    if (busy > 0 || runsHold || suiteHold || t - lastInputAt() < operatorQuietMs) {
      quietSince = null; // any busy sample resets the sustained window
    } else {
      if (quietSince === null) quietSince = t; // streak begins now
      // Dropping the watchers here treats `restart()` as terminal and irreversible.
      // That holds for a host that quits; a future host whose restart can FAIL
      // asynchronously must re-register them before calling it, or its requesters
      // are left waiting on a restart that already fell over.
      if (t - quietSince >= sustainMs) {
        quietSince = null;
        requests = [];
        if (runsPastCap && log) {
          try { log.warn('app', `restart proceeding past the ${Math.round(runCapMs / 60_000)}m exec-run ceiling — abandoning: ${runs.join(', ')}`); } catch {}
        }
        restart();
        return;
      }
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
    heldOnRuns = '';
    setFence(true);
    timer = setTimer(tick, pollMs);
    return true;
  }

  return { arm, disarm, isArmed };
}

const QUIT_CAP_MS = 30 * 60_000;

function quitDialog(jobs) {
  return {
    kind: 'quit',
    type: 'warning',
    message: 'Clodex is running tests for another team',
    detail: `${suiteJobsLine(jobs)}\nQuit When Finished waits for them (up to 30 minutes) and accepts no new suite meanwhile; Quit Now cuts them.`,
    buttons: ['Quit When Finished', 'Quit Now', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  };
}

function waitingQuitDialog(jobs) {
  return {
    kind: 'waiting',
    type: 'warning',
    message: 'Clodex will quit when the tests finish',
    detail: `${suiteJobsLine(jobs)}\nQuit Now cuts them; Cancel Quit keeps Clodex running and accepts new suites again.`,
    buttons: ['Quit Now', 'Keep Waiting', 'Cancel Quit'],
    defaultId: 1,
    cancelId: 1,
  };
}

function quitGiveUpBody(jobs) {
  const { text, total } = suiteJobsPhrase(jobs);
  return `${total ? text : suiteJobsCount(0)} did not finish within 30 minutes — the quit was dropped. Quit again to choose.`;
}

function suiteJobsCount(n) {
  return `${n} suite job${n === 1 ? '' : 's'} this machine is running for other teams`;
}

function runnerBusyError(n) {
  return `Not restarted: ${suiteJobsCount(n)} would be cut — send wait (clodexctl restart node --wait) to restart once they finish, or cutJobs (--cut-jobs) to cut them now.`;
}

function planRemoteRestart(opts, { fence, fenced, jobs, restart, restartWhenIdle, log = () => {} }) {
  const { wait = false, cutJobs = false } = opts || {};
  const count = () => { try { const j = jobs(); return Array.isArray(j) ? j.filter(Boolean).length : 0; } catch { return 0; } };
  if (wait) {
    const n = count();
    log(n ? `restart requested remotely — waiting for ${suiteJobsCount(n)}` : 'restart requested remotely — waiting for idle');
    return { status: 202, body: { ok: true, waiting: true, jobs: n }, go: () => restartWhenIdle({}) };
  }
  const was = !!fenced();
  fence(true);
  const n = count();
  if (n > 0 && !cutJobs) {
    if (!was) fence(false);
    const error = runnerBusyError(n);
    log(`restart requested remotely — refused: ${error}`);
    return { status: 409, body: { ok: false, code: 'runner-busy', jobs: n, error } };
  }
  log(n ? `restart requested remotely; cutting ${suiteJobsCount(n)}` : 'restart requested remotely');
  return { status: 200, body: { ok: true }, go: restart };
}

function createQuitGuard({
  suiteJobs = () => [], fence = null, quit, ask, notify, now, setTimer, clearTimer,
  pollMs = 2000, capMs = QUIT_CAP_MS,
}) {
  let passing = false;
  let waiting = false;
  let asking = false;
  let sealed = false;
  let timer = null;
  let armedAt = 0;
  let applied = false;
  const holds = new Set();

  function apply() {
    if (sealed) return;
    const on = holds.size > 0;
    if (on === applied) return;
    applied = on;
    if (fence) { try { fence(on); } catch {} }
  }

  function hold(key, on) {
    if (on) holds.add(key); else holds.delete(key);
    apply();
  }

  function live() {
    try {
      const jobs = suiteJobs();
      return Array.isArray(jobs) ? jobs.filter(Boolean) : [];
    } catch { return []; }
  }

  function stopWait() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    waiting = false;
  }

  function proceed() {
    stopWait();
    passing = true;
    quit();
  }

  function tick() {
    timer = null;
    if (!waiting) return;
    const jobs = live();
    if (!jobs.length) { proceed(); return; }
    if (now() - armedAt >= capMs) {
      stopWait();
      hold('quit', false);
      try { notify(jobs); } catch {}
      return;
    }
    timer = setTimer(tick, pollMs);
  }

  function answer(kind, response) {
    if (kind === 'quit') {
      if (response === 0) {
        if (waiting) return;
        waiting = true;
        armedAt = now();
        hold('quit', true);
        timer = setTimer(tick, pollMs);
      } else if (response === 1) proceed();
      else { stopWait(); hold('quit', false); }
      return;
    }
    if (response === 0) proceed();
    else if (response === 2) { stopWait(); hold('quit', false); }
  }

  function show(model) {
    asking = true;
    Promise.resolve()
      .then(() => ask(model))
      .then((r) => { asking = false; answer(model.kind, r && r.response); },
        () => { asking = false; });
  }

  function beforeQuit(event) {
    if (!passing) {
      const jobs = live();
      if (jobs.length) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!asking) show(waiting ? waitingQuitDialog(jobs) : quitDialog(jobs));
        return false;
      }
      stopWait();
      passing = true;
    }
    sealed = true;
    return true;
  }

  return {
    beforeQuit,
    passThrough: () => { passing = true; },
    restartFence: (on) => hold('restart', on),
    isWaiting: () => waiting,
  };
}

module.exports = {
  classifyRestart, createIdleWaiter, giveUpBody, suiteJobsLine, restartDetail, pendingDetail, suiteWaitClause,
  createQuitGuard, quitDialog, waitingQuitDialog, quitGiveUpBody, suiteJobsPhrase,
  runnerBusyError, planRemoteRestart,
};
