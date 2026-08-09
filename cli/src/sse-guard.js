// sse-guard.js — a staleness watchdog + bounded-reconnect wrapper over
// openEventStream, shared by attach.js and logs -f. ONE place owns the
// half-open-socket bug that bit the GUI's peer-client.js: an SSE that stops
// delivering bytes (data OR the 25s `: ping` heartbeat) is stale-as-live, so we
// arm a 60s watchdog (>2× heartbeat), destroy the socket when it fires, and
// reconnect with a bounded backoff. The consumer re-establishes its own state
// (attach re-replays + re-acquires; logs re-snapshots) on each (re)connect.
//
// Zero deps; the timer/wait seams are injectable so tests drive the schedule
// without real sleeps.
'use strict';

const { CliError, EXIT } = require('./errors');

const STALE_MS = 60000;          // 60s: >2× the server's 25s SSE heartbeat
const BACKOFF = [1000, 2000, 4000]; // 3 reconnect attempts, exponential

// Pure: the backoff delays for `attempts` reconnect tries, doubling from `base`.
function backoffSchedule(attempts = BACKOFF.length, base = 1000) {
  return Array.from({ length: attempts }, (_, i) => base * (2 ** i));
}

// A one-shot staleness timer. pet() restarts the countdown; onStale fires once
// if staleMs elapses without a pet. timers = { setTimeout, clearTimeout } is
// injectable (default global) so tests advance it deterministically.
function makeWatchdog(staleMs, onStale, timers = { setTimeout, clearTimeout }) {
  let handle = null;
  let fired = false;
  const stop = () => { if (handle != null) { timers.clearTimeout(handle); handle = null; } };
  const pet = () => {
    if (fired) return;
    stop();
    handle = timers.setTimeout(() => { fired = true; handle = null; onStale(); }, staleMs);
  };
  return { pet, stop };
}

// A promise that resolves after `ms`, over an injectable timer. `onHandle`, if
// given, receives the timer handle so the caller can cancel a pending wait.
function defaultWait(ms, timers = { setTimeout }, onHandle) {
  return new Promise((resolve) => {
    const h = timers.setTimeout(resolve, ms);
    if (onHandle) onHandle(h);
  });
}

// openGuarded — open an event stream and keep it alive across drops. Options:
//   onOpen()            — a (re)connect reached 200. May be async; a throw is
//                         treated as a retryable drop (e.g. re-acquire failed).
//   onEvent(name,data)  — a parsed frame (same shape as openEventStream).
//   onNotice(attempt)   — a reconnect is about to be tried (attempt is 1-based).
//   onGiveUp(err)       — terminal: attempts exhausted, or a definitive non-
//                         CONNECT error (404/401/403) that reconnecting can't fix.
//   staleMs, backoff    — override the defaults.
//   timers, wait        — injectable for tests.
//
// A successful (re)connect resets the attempt counter, so an unrelated later
// drop gets a fresh set of tries. "Successful" means the 200 AND `onOpen`
// returning without throwing — a connect whose onOpen fails has not earned a
// fresh budget, or the budget could never be spent. Returns { close() } — an idempotent,
// user-initiated teardown that suppresses further reconnects and callbacks.
function openGuarded(client, pathAndQuery, verb, opts = {}) {
  const {
    onOpen, onEvent, onNotice, onGiveUp,
    staleMs = STALE_MS,
    backoff = BACKOFF,
    timers = { setTimeout, clearTimeout },
    wait,
  } = opts;

  let closed = false;
  let stream = null;
  let watchdog = null;
  let backoffTimer = null; // pending reconnect-sleep handle (cleared on close)
  let attempt = 0;         // reconnect attempts since the last good connect
  let settled = false;     // onGiveUp already delivered — no more callbacks

  const stopWatch = () => { if (watchdog) { watchdog.stop(); watchdog = null; } };
  const closeStream = () => { try { if (stream) stream.close(); } catch {} stream = null; };
  const stopBackoff = () => { if (backoffTimer != null) { try { timers.clearTimeout(backoffTimer); } catch {} backoffTimer = null; } };

  // The backoff sleep. An injected `wait` (tests) owns its own timing; the
  // default tracks its timer handle so close() can cancel a pending sleep and
  // let the process exit promptly instead of hanging out the backoff window.
  const waitFn = wait || ((ms) => defaultWait(ms, timers, (h) => { backoffTimer = h; }));

  const giveUp = (err) => {
    if (settled || closed) return;
    settled = true;
    stopWatch();
    closeStream();
    if (onGiveUp) onGiveUp(err);
  };

  // A drop = the current stream died (transport error, server end, or the
  // watchdog fired). Reconnect if it looks transient; give up on a definitive
  // status or once the backoff is spent.
  const handleDrop = (err) => {
    if (closed || settled) return;
    stopWatch();
    closeStream();
    // A definitive error (not a bare connect/transport death) won't heal by
    // retrying — surface it. Everything CONNECT-coded is treated as transient.
    if (err instanceof CliError && err.exitCode !== EXIT.CONNECT) return giveUp(err);
    attempt += 1;
    if (attempt > backoff.length) {
      return giveUp(new CliError(EXIT.CONNECT, `event stream lost — ${backoff.length} reconnect attempts failed`));
    }
    if (onNotice) onNotice(attempt);
    Promise.resolve(waitFn(backoff[attempt - 1])).then(() => { backoffTimer = null; if (!closed && !settled) connect(); });
  };

  function connect() {
    if (closed || settled) return;
    watchdog = makeWatchdog(staleMs, () => handleDrop(new CliError(EXIT.CONNECT, 'event stream went silent (no data or heartbeat)')), timers);
    watchdog.pet();
    stream = client.openEventStream(pathAndQuery, verb, {
      onChunk: () => { if (watchdog) watchdog.pet(); },
      onOpen: () => {
        // The retry budget clears only once the connect is known GOOD, and with
        // a consumer onOpen "good" is not the 200 — it is the 200 plus that
        // callback succeeding. Clearing on the bare 200 (the pre-fix shape) let
        // a consistently-failing onOpen re-arm the budget on every cycle: the
        // throw routes to handleDrop, which takes attempt from 0 to 1, so the
        // `attempt > backoff.length` test at :104 is never reached and the
        // schedule stays pinned at backoff[0] forever. Measured before the fix:
        // 12 onOpen failures → 13 reconnects, all at 1000ms, onGiveUp silent.
        //
        // With NO consumer onOpen there is nothing further to be good, so the
        // 200 is the whole of it and the reset stays synchronous — deferring it
        // to a microtask there would mean a drop arriving in the same tick as
        // the open was charged against the PREVIOUS connect's budget.
        if (!onOpen) { attempt = 0; return; }
        Promise.resolve().then(() => onOpen())
          .then(() => { attempt = 0; })
          .catch((e) => handleDrop(e instanceof CliError ? e : new CliError(EXIT.CONNECT, `reconnect setup failed: ${e.message}`)));
      },
      onEvent: (name, data) => { if (!closed && !settled && onEvent) onEvent(name, data); },
      onError: (e) => handleDrop(e),
    });
  }

  connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      stopWatch();
      stopBackoff();
      closeStream();
    },
  };
}

module.exports = { STALE_MS, BACKOFF, backoffSchedule, makeWatchdog, defaultWait, openGuarded };
