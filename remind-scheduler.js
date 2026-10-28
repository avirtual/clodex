// remind-scheduler.js — the durable-schedule ENGINE behind `[agent:remind …]`.
// The pure calendar/duration math lives in remind-schedule.js (parse + fire-time
// computation); persistence lives in the `reminders` store (stores.js). This
// module is the runtime that ties them together: it decides WHEN to fire and
// drives the delivery, so it is the only piece with timers — and it takes the
// clock + timer primitives as injected deps so the whole thing is testable with
// a fake clock (no real setTimeout, no wall-clock flakiness).
//
// FACTORY (M3 DI) — createRemindScheduler({ now, setTimer, clearTimer, store,
// deliver }):
//   - now()               — epoch ms (Date.now in prod; a mutable value in tests)
//   - setTimer(fn, ms)    — arm a one-shot timer, returns a handle (setTimeout)
//   - clearTimer(handle)  — cancel one (clearTimeout)
//   - store               — the reminders store; the durable source of truth
//   - deliver(agent, id, spec, body, by, born) — hand ONE fire to the DM pipeline.
// remind-schedule is a pure sibling leaf, required directly (like exec-schema in
// session-manager) — nothing to inject.
//
// SCHEDULING MODEL:
//   * One timer, armed for the NEAREST nextFireAt across every timed schedule.
//     When it fires we deliver every schedule now due (usually one), recompute
//     each, and re-arm for the next nearest. O(1) live timers regardless of how
//     many schedules exist.
//   * The store is the source of truth; the engine re-reads it on every re-arm
//     and re-parses each record's verbatim `spec` on demand (parsed cron Sets
//     never need serializing). No in-memory schedule cache to drift.
//   * MISSED FIRES coalesce: on start(), a schedule whose stored nextFireAt is
//     already past (app was down) fires exactly ONCE, then recomputes forward
//     from now — never a burst of back-dated fires, and recurring never
//     double-fires at launch (the next slot is computed from `now`, not the
//     stale one).
//   * `on compact` schedules carry a null nextFireAt (no timer) — they fire only
//     via fireCompactFor(), the event hook the compact rendezvous calls.
//   * A record may carry a `ticket` binding (the spec's `for <id>` prefix).
//     Nothing here fires on it; it is a selector for cancelForTicket, which the
//     ticket close path calls.

const { parseRemindSpec, nextFireAt } = require('./remind-schedule');

// setTimeout clamps a delay to a 32-bit signed int (~24.855 days); a larger
// delay fires IMMEDIATELY, which would mis-fire a far-future `at`/cron. So a
// delay past this is armed as a bare re-arm hop: sleep the max, wake, re-arm —
// walking down to the real fire in ≤24.8-day steps.
const MAX_TIMER_MS = 2 ** 31 - 1;
const RETRY_MS = 60_000;

// Kinds that recur (recompute a next fire after each) vs fire once vs never
// timer-fire. `in`/`at` are one-shot; `every`/`cron` recur; `oncompact` is
// event-only (fireCompactFor).
const RECURRING = new Set(['every', 'cron']);
const ONESHOT = new Set(['in', 'at']);

function createRemindScheduler({ now, setTimer, clearTimer, store, deliver }) {
  return {
    _timer: null,

    // Re-parse a record's verbatim spec back into a schedule object. Records are
    // validated at add(), so a parse failure here means a hand-edited store file
    // — skip that record defensively rather than throw the whole engine down.
    _schedFor(rec) {
      const s = parseRemindSpec(rec.spec);
      return s.ok ? s : null;
    },

    _deliver(rec) {
      try { return deliver(rec.agent, rec.id, rec.spec, rec.body, rec.by, rec.born); } catch { return undefined; }
    },

    // Timed records (in/at/every/cron) with a concrete pending fire time.
    _timedPending() {
      return store.list().filter((r) => typeof r.nextFireAt === 'number');
    },

    // Deliver one schedule and advance its state: recurring recomputes forward
    // from `nowMs` (so a normal fire and a coalesced late fire both resume from
    // the actual fire instant, never the stale slot); a
    // recurring whose next fire is unreachable (e.g. an impossible cron) is
    // treated as spent and removed. An UNPARSEABLE record (only reachable via a
    // hand-edited store file) is dropped WITHOUT delivering — matching
    // _schedFor's "skip defensively": we don't spam the agent with a garbage
    // spec, we just remove the bad row so the timer stops re-selecting it.
    _fireRecord(rec, nowMs) {
      const sched = this._schedFor(rec);
      if (!sched) { store.remove(rec.id); return; } // corrupt row → silent drop
      const status = this._deliver(rec);
      if (status === 'gone') { store.remove(rec.id); return; }
      if (status === 'deferred' || (!RECURRING.has(rec.kind) && (status === 'error' || status === undefined))) {
        store.markFired(rec.id, typeof rec.lastFiredAt === 'number' ? rec.lastFiredAt : null, nowMs + RETRY_MS);
        return;
      }
      if (RECURRING.has(rec.kind)) {
        const next = nextFireAt(sched, nowMs);
        if (typeof next === 'number') store.markFired(rec.id, nowMs, next);
        else store.remove(rec.id); // recurring with no reachable next → spent
      } else {
        store.remove(rec.id); // one-shot (in/at)
      }
    },

    // Arm the single timer for the nearest pending fire. Clears any existing
    // timer first. A delay beyond the setTimeout clamp becomes a re-arm hop.
    _rearm() {
      if (this._timer !== null) { try { clearTimer(this._timer); } catch {} this._timer = null; }
      const pending = this._timedPending();
      if (!pending.length) return;
      const nowMs = now();
      const nearest = pending.reduce((m, r) => (r.nextFireAt < m ? r.nextFireAt : m), Infinity);
      const delay = Math.max(0, nearest - nowMs);
      if (delay > MAX_TIMER_MS) {
        this._timer = setTimer(() => { this._timer = null; this._rearm(); }, MAX_TIMER_MS);
      } else {
        this._timer = setTimer(() => { this._timer = null; this._onTimer(); }, delay);
      }
    },

    // Timer elapsed: fire everything now due (there may be ties), then re-arm.
    _onTimer() {
      const nowMs = now();
      for (const rec of this._timedPending()) {
        if (rec.nextFireAt <= nowMs) this._fireRecord(rec, nowMs);
      }
      this._rearm();
    },

    // Launch: coalesce every missed fire to one late fire, then arm the timer.
    // Called once after construction (main.js, post-whenReady). Idempotent-ish:
    // a second call just re-catches-up (nothing is due) and re-arms.
    start() {
      const nowMs = now();
      for (const rec of this._timedPending()) {
        if (rec.nextFireAt <= nowMs) this._fireRecord(rec, nowMs); // one late fire, forward-recompute
      }
      this._rearm();
    },

    // Stop the timer (clean shutdown / test teardown). Schedules stay on disk.
    stop() {
      if (this._timer !== null) { try { clearTimer(this._timer); } catch {} this._timer = null; }
    },

    // `spec` is the raw bracket-interior string; parsed here (the authority that a schedule is valid) and stored verbatim
    // for `list` + reload. Returns { ok: true, record } or { ok: false, error }
    // with the loud-bounce message. list/cancel are dispatched by the handler,
    // not here — reaching add() with one is a caller bug, reported as such.
    add(agent, spec, body = '', { by, born } = {}) {
      const sched = parseRemindSpec(spec);
      if (!sched.ok) return { ok: false, error: sched.error };
      if (sched.kind === 'list' || sched.kind === 'cancel') {
        return { ok: false, error: `"${sched.kind}" is a management command, not a schedule` };
      }
      const nowMs = now();
      let first = null;
      if (sched.kind !== 'oncompact') {
        first = nextFireAt(sched, nowMs);
        if (typeof first !== 'number') {
          return { ok: false, error: 'that time is already in the past' };
        }
      }
      const record = store.add({ agent, kind: sched.kind, spec, body, nextFireAt: first, ticket: sched.ticket || null, by: by || null, born: typeof born === 'number' ? born : null });
      this._rearm();
      return { ok: true, record };
    },

    cancel(agent, id, { force = false } = {}) {
      const rec = store.get(id);
      if (!rec) return false;
      if (!force && (rec.agent !== agent || rec.by === 'operator')) return false;
      store.remove(id);
      this._rearm();
      return true;
    },

    // Drop every schedule this agent owns that is BOUND to `ticketId` — the
    // `for <id>` prefix. Called when a ticket reaches a terminal close (accept
    // or cancel, NOT done: a reject reopens a done ticket and the reminder is
    // still wanted through the rework round).
    //
    // Returns the ids removed (possibly none) so the caller can say so; one
    // _rearm at the end rather than per-record, since a cancelled fire may have
    // been the nearest.
    cancelForTicket(agent, ticketId) {
      if (!agent || !ticketId) return [];
      const want = String(ticketId).toLowerCase();
      const doomed = store.listForAgent(agent).filter((r) => r.ticket && String(r.ticket).toLowerCase() === want);
      for (const rec of doomed) store.remove(rec.id);
      if (doomed.length) this._rearm();
      return doomed.map((r) => r.id);
    },

    cancelLoopWatch(agent, ticketId) {
      if (!agent || !ticketId) return [];
      const want = String(ticketId).toLowerCase();
      const doomed = store.listForAgent(agent).filter((r) => r.by === 'ticket-loop' && r.ticket && String(r.ticket).toLowerCase() === want);
      for (const rec of doomed) store.remove(rec.id);
      if (doomed.length) this._rearm();
      return doomed.map((r) => r.id);
    },

    // Every schedule this agent owns (for `remind list`). Verbatim records —
    // the handler renders id + spec.
    listForAgent(agent) {
      return store.listForAgent(agent);
    },

    renameAgent(oldAgent, newAgent) {
      if (!oldAgent || !newAgent || oldAgent === newAgent) return 0;
      return store.renameAgent(oldAgent, newAgent);
    },

    removeForAgent(agent) {
      if (!agent) return 0;
      const n = store.removeForAgent(agent);
      if (n) this._rearm();
      return n;
    },

    // Event trigger: fire this agent's `on compact` reminders. Called by the
    // compact rendezvous (both manual /compact and auto-compact ride the same
    // isCompactSummary signal). No timer involved; the schedule persists (a
    // standing trigger), only its lastFiredAt is stamped. Returns the count.
    fireCompactFor(agent) {
      const nowMs = now();
      const recs = store.listForAgent(agent).filter((r) => r.kind === 'oncompact');
      for (const rec of recs) {
        if (this._deliver(rec) === 'gone') store.remove(rec.id);
        else store.markFired(rec.id, nowMs, null);
      }
      return recs.length;
    },

    fireNow(agent, id) {
      const rec = store.get(id);
      if (!rec || rec.agent !== agent) return { ok: false, error: 'no such reminder' };
      if (!this._schedFor(rec)) {
        store.remove(rec.id);
        this._rearm();
        return { ok: false, error: 'no such reminder' };
      }
      const nowMs = now();
      if (rec.kind === 'oncompact') {
        if (this._deliver(rec) === 'gone') store.remove(rec.id);
        else store.markFired(rec.id, nowMs, null);
      } else {
        this._fireRecord(rec, nowMs);
      }
      this._rearm();
      return { ok: true, kept: !!store.get(rec.id) };
    },
  };
}

function reminderText(id, spec, body, by) {
  const prefix = by === 'operator' ? `[${id} ${spec}, set by your operator]`
    : by === 'ticket-loop' ? `[${id} ${spec}, set by the ticket loop]`
      : `[${id} ${spec}]`;
  return body ? `${prefix} ${body}` : prefix;
}

function reminderLibraryKinds({ scheduler, seatExists }) {
  return {
    remove: (ref) => (scheduler.cancel(ref.agent, ref.id, { force: true })
      ? { ok: true }
      : { ok: false, error: 'no such reminder' }),
    fire: (ref) => scheduler.fireNow(ref.agent, ref.id),
    add: (ref, payload) => {
      if (!seatExists(ref.agent)) return { ok: false, error: 'no such seat' };
      const parsed = parseRemindSpec(payload.spec);
      if (parsed.ok && parsed.ticket) return { ok: false, error: 'a ticket binding is not available from the panel' };
      const res = scheduler.add(ref.agent, payload.spec, payload.body || '', { by: 'operator' });
      return res.ok ? { ok: true, id: res.record.id } : { ok: false, error: res.error };
    },
  };
}

module.exports = { createRemindScheduler, MAX_TIMER_MS, reminderText, reminderLibraryKinds };
