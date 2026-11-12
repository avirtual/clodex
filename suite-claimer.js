'use strict';

const crypto = require('crypto');
const { suiteRoute } = require('./suite-dispatch');

const CLAIMER_CONCURRENCY = 4;
const JOB_MEMORY = 256;
const OFFER_CLOSED = Object.freeze({ ok: false, error: 'offer closed' });

function verbOf(call) {
  const route = suiteRoute(call);
  return route.row ? route.row.verb : null;
}

function wellFormed(c) {
  return !!c && typeof c === 'object'
    && typeof c.id === 'string' && typeof c.claim === 'string'
    && typeof c.method === 'string' && typeof c.path === 'string'
    && Number.isFinite(c.ttlMs);
}

function createSuiteClaimer({
  claim, blob, reply, execute,
  grant = () => ({ admit: true, serve: true }),
  ready = () => true,
  log = () => {},
  now = Date.now,
  session = crypto.randomBytes(16).toString('hex'),
  concurrency = CLAIMER_CONCURRENCY,
} = {}) {
  let claiming = null;
  let again = false;
  let stopped = false;
  let served = false;
  let lastClaim = null;
  let active = 0;
  const waiting = [];
  const jobs = new Set();

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

  function revoke() {
    const ids = [...jobs];
    jobs.clear();
    for (const id of ids) {
      Promise.resolve()
        .then(() => execute({ method: 'DELETE', path: `/api/suite/jobs/${encodeURIComponent(id)}`, headers: {}, body: null }))
        .catch((e) => log(`cancel of job ${id} after the run grant was revoked failed: ${e.message}`));
    }
    if (ids.length) log(`run grant revoked: cancelled ${ids.length} job(s)`);
  }

  async function answerFor(call, bytes) {
    const verb = verbOf(call);
    if (verb === 'submit' && !readGrant().admit) return { status: 503, body: { ...OFFER_CLOSED } };
    const out = await execute({ method: call.method, path: call.path, headers: call.headers || {}, body: call.body == null ? null : call.body, bytes });
    if (verb === 'submit' && out && out.status === 200 && out.body) remember(out.body.id);
    return out;
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
    if (now() >= call.deadline) {
      log(`call ${call.id} (${call.method} ${call.path}) is past its deadline; not executed`);
      return;
    }
    const out = await answerFor(call, bytes);
    if (stopped) return;
    const sent = await reply(call.id, call.claim, { status: out.status, body: out.body });
    if (!sent || sent.status !== 200) log(`call ${call.id}: reply not accepted (${(sent && (sent.error || sent.status)) || 'no answer'})`);
  }

  function run(call, slotted) {
    if (slotted) active += 1;
    Promise.resolve()
      .then(() => handle(call))
      .catch((e) => log(`call ${call.id} failed: ${e.message}`))
      .finally(() => {
        if (!slotted) return;
        active -= 1;
        pump();
      });
  }

  function pump() {
    while (!stopped && active < concurrency && waiting.length) run(waiting.shift(), true);
  }

  function dispatch(raw, receivedAt) {
    if (!wellFormed(raw)) {
      log('claim returned a malformed call; skipped');
      return;
    }
    const call = { ...raw, deadline: receivedAt + raw.ttlMs };
    if (call.method === 'DELETE') return run(call, false);
    waiting.push(call);
    pump();
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
        log(`claim failed (${(got && (got.error || got.status)) || 'no answer'})`);
        return;
      }
      lastClaim = now();
      for (const c of calls) dispatch(c, lastClaim);
      if (calls.length) again = true;
    } while (again && !stopped);
  }

  function ring() {
    if (stopped) return Promise.resolve();
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
    waiting.length = 0;
  }

  function status() {
    return { session, lastClaim, serving: served, active, waiting: waiting.length };
  }

  return { ring, stop, status, session };
}

module.exports = { createSuiteClaimer, CLAIMER_CONCURRENCY };
