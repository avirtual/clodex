'use strict';

const START_MATCH_MS = 2000;
const EXIT_WAIT_MS = 3000;
const POLL_MS = 100;

function reapDecision({ record, alive, startTime }) {
  if (!alive) return 'dead';
  const recorded = record ? record.startTime : null;
  if (Number.isFinite(recorded) && Number.isFinite(startTime)
      && Math.abs(startTime - recorded) <= START_MATCH_MS) {
    return 'kill';
  }
  return 'recycled';
}

function waitUntil(done, timeoutMs, stepMs = POLL_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (done()) { resolve(true); return; }
      if (Date.now() - started >= timeoutMs) { resolve(false); return; }
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

async function reapBeforeResume({ record, kill, isAlive, startTimeOf, wait = waitUntil }) {
  if (!record || !(record.pid > 0)) return 'dead';
  const pid = record.pid;
  const alive = !!isAlive(pid);
  const decision = reapDecision({ record, alive, startTime: alive ? startTimeOf(pid) : null });
  if (decision !== 'kill') return decision;
  kill(pid, 'SIGTERM');
  const gone = await wait(() => !isAlive(pid), EXIT_WAIT_MS);
  if (!gone) kill(pid, 'SIGKILL');
  return decision;
}

module.exports = { reapDecision, reapBeforeResume, waitUntil, START_MATCH_MS, EXIT_WAIT_MS };
