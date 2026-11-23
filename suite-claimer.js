'use strict';

const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { suiteRoute } = require('./suite-dispatch');

const CLAIMER_CONCURRENCY = 4;
const POLL_CONCURRENCY = 8;
const REPLY_RESERVE_MS = 10000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
const JOB_MEMORY = 256;
const RESEND_MIN_MS = 500;
const RESEND_MAX_MS = 2000;
const RESEND_ATTEMPTS = 6;
const RESEND_FLOOR_MS = 1000;
const RESEND_MAX_HELD = 64;
const RESEND_MAX_BYTES = 8 * 1024 * 1024;
const RESENDABLE = new Set([502, 503, 504]);
const OFFER_CLOSED = Object.freeze({ ok: false, error: 'offer closed' });

function verbOf(call) {
  const route = suiteRoute(call);
  return route.row ? route.row.verb : null;
}

function pollWait(call) {
  if (call.method !== 'GET') return null;
  const route = suiteRoute(call);
  if (!route.row || route.row.verb !== 'poll' || !route.query.has('ids')) return null;
  const raw = route.query.get('wait');
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const wait = Number(raw);
  return Number.isSafeInteger(wait) ? wait : null;
}

function withWait(path, ms) {
  const q = path.indexOf('?');
  const query = new URLSearchParams(path.slice(q + 1));
  query.set('wait', String(ms));
  return `${path.slice(0, q)}?${query.toString()}`;
}

function wellFormed(c) {
  return !!c && typeof c === 'object'
    && typeof c.id === 'string' && typeof c.claim === 'string'
    && typeof c.method === 'string' && typeof c.path === 'string'
    && Number.isFinite(c.ttlMs);
}

function unref(h) {
  if (h && typeof h.unref === 'function') h.unref();
  return h;
}

function createSuiteClaimer({
  claim, blob, reply, execute,
  grant = () => ({ admit: true, serve: true }),
  ready = () => true,
  log = () => {},
  now = Date.now,
  clock = () => performance.now(),
  timers = { setTimeout, clearTimeout },
  random = () => 0.5 + Math.random() / 2,
  session = crypto.randomBytes(16).toString('hex'),
  concurrency = CLAIMER_CONCURRENCY,
  pollConcurrency = POLL_CONCURRENCY,
} = {}) {
  let claiming = null;
  let again = false;
  let stopped = false;
  let served = false;
  let lastClaim = null;
  let lastFailure = null;
  let retryTimer = null;
  let retryMs = RETRY_MIN_MS;
  const general = { bound: concurrency, active: 0, queue: [] };
  const polls = { bound: pollConcurrency, active: 0, queue: [] };
  const jobs = new Set();
  const pending = new Map();
  let heldBytes = 0;

  function readGrant() {
    try {
      const g = grant() || {};
      return { admit: g.admit === true, serve: g.serve === true };
    } catch {
      return { admit: false, serve: false };
    }
  }

  function remember(id) {
    if (typeof id !== 'string') return;
    jobs.delete(id);
    jobs.add(id);
    while (jobs.size > JOB_MEMORY) jobs.delete(jobs.values().next().value);
  }

  function cancelJob(id) {
    Promise.resolve()
      .then(() => execute({ method: 'DELETE', path: `/api/suite/jobs/${encodeURIComponent(id)}`, headers: {}, body: null }))
      .catch((e) => log(`cancel of job ${id} after the run grant was revoked failed: ${e.message}`));
  }

  function revoke() {
    const ids = [...jobs];
    jobs.clear();
    for (const id of ids) cancelJob(id);
    if (ids.length) log(`run grant revoked: cancelled ${ids.length} job(s)`);
  }

  async function answerFor(call, bytes) {
    const verb = verbOf(call);
    if (verb === 'submit' && !readGrant().admit) return { status: 503, body: { ...OFFER_CLOSED } };
    const out = await execute({ method: call.method, path: call.path, headers: call.headers || {}, body: call.body == null ? null : call.body, bytes });
    if (verb === 'submit' && out && out.status === 200 && out.body && typeof out.body.id === 'string') {
      if (readGrant().serve) remember(out.body.id);
      else {
        cancelJob(out.body.id);
        log(`run grant revoked while job ${out.body.id} was submitted: cancelled it`);
      }
    }
    return out;
  }

  function expired(call) {
    log(`call ${call.id} (${call.method} ${call.path}) is past its deadline; not executed`);
  }

  function replyLine(call, sent) {
    const why = sent && sent.status === 410 ? ((sent.body && sent.body.error) || sent.error) : null;
    if (why === 'call expired') return `call ${call.id}: reply arrived after the call expired (${Math.round(clock() - call.arrived)} ms)`;
    if (why === 'call already settled') return `call ${call.id}: reply not needed, call already settled`;
    return `call ${call.id}: reply not accepted (${(sent && (sent.error || sent.status)) || 'no answer'})`;
  }

  async function handle(call) {
    let bytes;
    if (call.blob) {
      const got = await blob(call.id, call.claim);
      if (!got || got.status !== 200 || !Buffer.isBuffer(got.bytes)) {
        log(`call ${call.id}: blob fetch failed (${(got && (got.error || got.status)) || 'no answer'})`);
        return;
      }
      bytes = got.bytes;
    }
    const left = call.deadline - clock();
    if (left <= 0) return expired(call);
    const wait = call.pollWait == null ? null : Math.max(0, Math.min(call.pollWait, Math.floor(left - REPLY_RESERVE_MS)));
    const out = await answerFor(wait == null ? call : { ...call, path: withWait(call.path, wait) }, bytes);
    if (stopped) return;
    const entry = { call, answer: { status: out.status, body: out.body }, attempts: 0, timer: null, bytes: 0, why: null };
    const sent = await send(entry);
    settleSend(entry, sent);
  }

  function factorOf() {
    const r = Number(random());
    return Number.isFinite(r) ? Math.min(1, Math.max(0.5, r)) : 1;
  }

  function whyOf(sent) {
    return (sent && (sent.error || sent.status)) || 'no answer';
  }

  async function send(entry) {
    entry.attempts += 1;
    const timeoutMs = Math.max(RESEND_FLOOR_MS, Math.floor(entry.call.deadline - clock()));
    try {
      return await reply(entry.call.id, entry.call.claim, entry.answer, timeoutMs);
    } catch (e) {
      return { status: 0, body: null, error: e.message };
    }
  }

  function release(entry) {
    if (pending.get(entry.call.id) !== entry) return;
    pending.delete(entry.call.id);
    heldBytes -= entry.bytes;
    if (entry.timer != null) timers.clearTimeout(entry.timer);
    entry.timer = null;
  }

  function hold(entry) {
    entry.bytes = Buffer.byteLength(JSON.stringify(entry.answer.body) || '');
    pending.set(entry.call.id, entry);
    heldBytes += entry.bytes;
    while (pending.size > RESEND_MAX_HELD || heldBytes > RESEND_MAX_BYTES) {
      const oldest = pending.values().next().value;
      release(oldest);
      oldest.dropped = true;
      log(`call ${oldest.call.id}: reply not accepted (${oldest.why}) (resend dropped: too many pending)`);
    }
  }

  function settleSend(entry, sent) {
    if (stopped || entry.dropped) return;
    const { call } = entry;
    const status = sent && sent.status;
    if (status === 200) {
      release(entry);
      if (entry.attempts > 1) log(`call ${call.id}: reply delivered on attempt ${entry.attempts}`);
      return;
    }
    if (status && !RESENDABLE.has(status)) {
      release(entry);
      const settled = status === 410 && ((sent.body && sent.body.error) || sent.error) === 'call already settled';
      log(settled && entry.attempts > 1 ? `call ${call.id}: reply delivered (confirmed on resend)` : replyLine(call, sent));
      return;
    }
    entry.why = whyOf(sent);
    const delay = Math.round(Math.min(RESEND_MIN_MS * 2 ** (entry.attempts - 1), RESEND_MAX_MS) * factorOf());
    if (entry.attempts >= RESEND_ATTEMPTS || call.deadline - clock() - delay < RESEND_FLOOR_MS) {
      release(entry);
      log(`call ${call.id}: reply not accepted (${entry.why}) after ${entry.attempts} attempts`);
      return;
    }
    if (entry.attempts === 1) {
      log(`call ${call.id}: reply failed (${entry.why}), resending`);
      hold(entry);
      if (entry.dropped) return;
    }
    entry.timer = unref(timers.setTimeout(() => {
      entry.timer = null;
      send(entry).then((again) => settleSend(entry, again));
    }, delay));
  }

  function run(call, pool) {
    if (pool) pool.active += 1;
    Promise.resolve()
      .then(() => handle(call))
      .catch((e) => log(`call ${call.id} failed: ${e.message}`))
      .finally(() => {
        if (!pool) return;
        pool.active -= 1;
        pump(pool);
      });
  }

  function pump(pool) {
    while (!stopped && pool.active < pool.bound && pool.queue.length) {
      const call = pool.queue.shift();
      timers.clearTimeout(call.expiry);
      call.expiry = null;
      run(call, pool);
    }
  }

  function enqueue(call, pool) {
    const left = call.deadline - clock();
    if (left <= 0) return expired(call);
    call.expiry = unref(timers.setTimeout(() => {
      call.expiry = null;
      const at = pool.queue.indexOf(call);
      if (at < 0) return;
      pool.queue.splice(at, 1);
      expired(call);
    }, left));
    pool.queue.push(call);
    pump(pool);
  }

  function dispatch(raw, receivedAt) {
    if (!wellFormed(raw)) {
      log('claim returned a malformed call; skipped');
      return;
    }
    const call = { ...raw, arrived: receivedAt, deadline: receivedAt + raw.ttlMs, pollWait: pollWait(raw), expiry: null };
    if (call.method === 'DELETE') return run(call, null);
    enqueue(call, call.pollWait == null ? general : polls);
  }

  function clearRetry() {
    if (retryTimer == null) return;
    timers.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    if (stopped || retryTimer != null || !ready()) return;
    const r = Number(random());
    const factor = Number.isFinite(r) ? Math.min(1, Math.max(0.5, r)) : 1;
    const delay = Math.round(retryMs * factor);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    retryTimer = unref(timers.setTimeout(() => {
      retryTimer = null;
      ring();
    }, delay));
  }

  async function loop() {
    do {
      again = false;
      const g = readGrant();
      if (!g.serve) {
        if (served) revoke();
        served = false;
        return;
      }
      served = true;
      if (!ready()) return;
      let got;
      try { got = await claim(session); } catch (e) { got = { status: 0, error: e.message }; }
      if (stopped) return;
      const calls = got && got.status === 200 && got.body && Array.isArray(got.body.calls) ? got.body.calls : null;
      if (!calls) {
        const why = String((got && (got.error || got.status)) || 'no answer');
        if (why !== lastFailure) log(`claim failed (${why})`);
        lastFailure = why;
        scheduleRetry();
        return;
      }
      lastFailure = null;
      retryMs = RETRY_MIN_MS;
      lastClaim = now();
      const receivedAt = clock();
      for (const c of calls) dispatch(c, receivedAt);
      if (calls.length) again = true;
    } while (again && !stopped);
  }

  function ring() {
    if (stopped) return Promise.resolve();
    clearRetry();
    if (claiming) {
      again = true;
      return claiming;
    }
    claiming = loop()
      .catch((e) => log(`claim loop failed: ${e.message}`))
      .finally(() => { claiming = null; });
    return claiming;
  }

  function stop() {
    stopped = true;
    clearRetry();
    for (const pool of [general, polls]) {
      for (const call of pool.queue) timers.clearTimeout(call.expiry);
      pool.queue.length = 0;
    }
    for (const entry of [...pending.values()]) release(entry);
  }

  function status() {
    return {
      session, lastClaim, serving: served,
      active: general.active + polls.active,
      waiting: general.queue.length + polls.queue.length,
      resending: pending.size,
    };
  }

  return { ring, stop, status, session };
}

module.exports = { createSuiteClaimer, CLAIMER_CONCURRENCY, POLL_CONCURRENCY, REPLY_RESERVE_MS };
