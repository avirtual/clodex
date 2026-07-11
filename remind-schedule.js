// remind-schedule.js — the pure parse/timing leaf for the `[agent:remind …]`
// scheduler (like exec-schema / clodex-paths / args-model): no electron, no I/O,
// no coordinator state. Turns a remind SPEC string (everything between
// `[agent:remind ` and `]`) into a normalized schedule object, and computes the
// next fire time for a timed schedule against an injected `now`. The scheduler
// engine (remind-scheduler.js) owns persistence + timers and calls in here for
// every scheduling decision, so ALL of the calendar/duration math is unit-tested
// in isolation with a fake clock.
//
// Spec grammar (v1, self-reminders only):
//   every <interval>   recurring   — Ns/Nm/Nh/Nd, minimum 60s (runaway guard)
//   in <duration>      one-shot    — Ns/Nm/Nh/Nd, must be > 0
//   at <HH:MM|ISO>     one-shot    — clock time (past today rolls to tomorrow)
//                                     or an absolute ISO datetime
//   cron <m h dom mon dow>  recurring — 5-field, subset: * fixed */step a-b a,b
//   on compact         event       — fired by the compact rendezvous, not a timer
//   list               management  — enumerate this agent's schedules
//   cancel <id>        management   — drop one schedule by id
//
// parseRemindSpec returns { ok: true, kind, … } or { ok: false, error }; the
// error string is what the handler bounces loudly (exec's tone). nextFireAt
// returns epoch-ms for the next timed fire strictly after `fromMs`, or null for
// the event/management kinds and for an absolute one-shot already in the past.

// Recurring floor: a sub-minute self-reminder loop is a runaway generator into
// the DM pipeline, so `every` under this bounces (in/at/cron are one-shot or
// naturally minute-grained, so they need no such floor).
const MIN_EVERY_MS = 60 * 1000;

const DURATION_RE = /^(\d+)\s*([smhd])$/;
const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const ID_RE = /^[a-z0-9]+$/i;

// A cron field's inclusive value bounds, in field order.
const CRON_BOUNDS = [
  { lo: 0, hi: 59 }, // minute
  { lo: 0, hi: 23 }, // hour
  { lo: 1, hi: 31 }, // day-of-month
  { lo: 1, hi: 12 }, // month
  { lo: 0, hi: 6 },  // day-of-week (0 = Sunday)
];

function err(error) { return { ok: false, error }; }

// "<n><unit>" → milliseconds, or null if malformed. Single unit only (no
// compound like 1h30m — kept deliberately narrow so the grammar is unambiguous).
function parseDuration(str) {
  const m = String(str || '').trim().match(DURATION_RE);
  if (!m) return null;
  return parseInt(m[1], 10) * UNIT_MS[m[2]];
}

// Expand one cron field ("*", "5", "*/15", "1-5", "0,30", "1-5/2", comma lists
// of those) into { set: Set<int>, restricted } within [lo, hi], or { error }.
// `restricted` is false ONLY for a bare "*" — it drives the standard dom/dow OR
// rule in cronMatches. NOTE: this deliberately deviates from Vixie cron, which
// treats any field STARTING with "*" (e.g. "*/2") as unrestricted; here "*/step"
// counts as restricted (the more intuitive reading for our subset), so an
// every-other-day-of-month expression participates in the dom/dow OR.
function parseCronField(field, lo, hi) {
  const restricted = field !== '*';
  const set = new Set();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return { error: `bad cron field "${field}"` };
    const step = m[3] != null ? parseInt(m[3], 10) : 1;
    if (step < 1) return { error: `bad cron step in "${field}"` };
    let start, end;
    if (m[1] === '*') {
      start = lo; end = hi;
    } else {
      start = parseInt(m[1], 10);
      // "a-b" → explicit range; "a/step" → a..hi step; bare "a" → just a.
      end = m[2] != null ? parseInt(m[2], 10) : (m[3] != null ? hi : start);
    }
    if (start < lo || end > hi || start > end) {
      return { error: `cron value out of range in "${field}" (${lo}-${hi})` };
    }
    for (let v = start; v <= end; v += step) set.add(v);
  }
  return { set, restricted };
}

// 5-field cron expression → { min, hour, dom, mon, dow, domRestricted,
// dowRestricted } of Sets, or { error }. Named months/DOW and L/# are out of the
// v1 subset and bounce via parseCronField's regex.
function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    return { error: `cron needs 5 fields (m h dom mon dow), got ${fields.length}` };
  }
  const parsed = [];
  for (let i = 0; i < 5; i++) {
    const r = parseCronField(fields[i], CRON_BOUNDS[i].lo, CRON_BOUNDS[i].hi);
    if (r.error) return { error: r.error };
    parsed.push(r);
  }
  return {
    min: parsed[0].set, hour: parsed[1].set, dom: parsed[2].set,
    mon: parsed[3].set, dow: parsed[4].set,
    domRestricted: parsed[2].restricted, dowRestricted: parsed[4].restricted,
  };
}

// Does a local Date match a parsed cron? Standard Vixie dom/dow semantics: when
// BOTH are restricted the day matches if EITHER matches; otherwise the single
// restricted one (or neither) governs.
function cronMatches(cron, date) {
  if (!cron.min.has(date.getMinutes())) return false;
  if (!cron.hour.has(date.getHours())) return false;
  if (!cron.mon.has(date.getMonth() + 1)) return false;
  const domOk = cron.dom.has(date.getDate());
  const dowOk = cron.dow.has(date.getDay());
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

// Parse a remind SPEC (the bracket interior after `remind `) into a normalized
// schedule. Pure — no clock read; timing that depends on "now" is deferred to
// nextFireAt.
function parseRemindSpec(spec) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s) return err('empty remind spec');

  const m = s.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const head = m[1].toLowerCase();
  const rest = (m[2] || '').trim();

  switch (head) {
    case 'list':
      if (rest) return err(`unexpected text after "list": "${rest}"`);
      return { ok: true, kind: 'list' };

    case 'cancel':
      if (!rest) return err('cancel needs a schedule id');
      if (!ID_RE.test(rest)) return err(`invalid schedule id "${rest}"`);
      return { ok: true, kind: 'cancel', id: rest.toLowerCase() };

    case 'on':
      if (rest.toLowerCase() === 'compact') return { ok: true, kind: 'oncompact' };
      return err(`unknown remind form "on ${rest}" (did you mean "on compact"?)`);

    case 'every': {
      const ms = parseDuration(rest);
      if (ms == null) return err(`bad interval "${rest}" (use e.g. 30m, 2h, 90s)`);
      if (ms < MIN_EVERY_MS) return err('every interval must be at least 60s');
      return { ok: true, kind: 'every', intervalMs: ms };
    }

    case 'in': {
      const ms = parseDuration(rest);
      if (ms == null) return err(`bad duration "${rest}" (use e.g. 10m, 1h, 45s)`);
      if (ms <= 0) return err('in duration must be greater than 0');
      return { ok: true, kind: 'in', delayMs: ms };
    }

    case 'at': {
      if (!rest) return err('at needs a time (HH:MM or ISO)');
      const hm = rest.match(HHMM_RE);
      if (hm) return { ok: true, kind: 'at', hh: parseInt(hm[1], 10), mm: parseInt(hm[2], 10) };
      const abs = Date.parse(rest);
      if (Number.isNaN(abs)) return err(`bad time "${rest}" (use HH:MM or an ISO datetime)`);
      return { ok: true, kind: 'at', atMs: abs };
    }

    case 'cron': {
      const c = parseCron(rest);
      if (c.error) return err(c.error);
      return { ok: true, kind: 'cron', cron: c };
    }

    default:
      return err(`unknown remind form "${head}"`);
  }
}

// Next fire time (epoch ms) strictly after `fromMs` for a timed schedule, or
// null when nothing is due:
//   every  — one interval past fromMs (recurring recomputes forward from now,
//            so callers pass the just-fired time as fromMs).
//   in     — fromMs + delay (computed once at creation).
//   at     — clock form rolls to tomorrow when today's HH:MM has passed; ISO
//            form fires once if still in the future, else null (past one-shot).
//   cron   — the next matching local minute, searched up to ~366 days out.
//   oncompact / list / cancel — null (no timer).
function nextFireAt(schedule, fromMs) {
  if (!schedule || !schedule.ok) return null;
  switch (schedule.kind) {
    case 'every':
      return fromMs + schedule.intervalMs;

    case 'in':
      return fromMs + schedule.delayMs;

    case 'at': {
      if (typeof schedule.atMs === 'number') {
        return schedule.atMs > fromMs ? schedule.atMs : null;
      }
      const d = new Date(fromMs);
      d.setHours(schedule.hh, schedule.mm, 0, 0);
      if (d.getTime() <= fromMs) {
        // Calendar day bump, NOT `+ 24h`: a wall-clock time must stay wall-clock
        // across a DST transition. Adding a fixed 86_400_000ms would land an hour
        // off on a spring-forward/fall-back night; re-pinning setHours AFTER the
        // date bump keeps the reminder at HH:MM local (same reason the cron walker
        // steps via setMinutes). Do not "simplify" this back to += UNIT_MS.d.
        d.setDate(d.getDate() + 1);
        d.setHours(schedule.hh, schedule.mm, 0, 0);
      }
      return d.getTime();
    }

    case 'cron': {
      // Start at the next whole minute after fromMs and walk forward. The cap is
      // a full leap year of minutes — enough for any 5-field expression that can
      // match at all; a truly impossible field combo (e.g. Feb 30) returns null.
      const d = new Date(fromMs);
      d.setSeconds(0, 0);
      d.setMinutes(d.getMinutes() + 1);
      const MAX_MINUTES = 366 * 24 * 60;
      for (let i = 0; i < MAX_MINUTES; i++) {
        if (cronMatches(schedule.cron, d)) return d.getTime();
        d.setMinutes(d.getMinutes() + 1);
      }
      return null;
    }

    default:
      return null; // oncompact / list / cancel
  }
}

module.exports = {
  MIN_EVERY_MS,
  parseDuration,
  parseCronField,
  parseCron,
  cronMatches,
  parseRemindSpec,
  nextFireAt,
};
