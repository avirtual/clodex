'use strict';

// Account plan quota off the `anthropic-ratelimit-unified-*` RESPONSE headers.
// Port of vendor/wirescope/proxylab/quota.py, which is proven against ~153k
// captures — follow its shape rather than re-deriving one.
//
// Three properties that make this unlike the rest of the wire's state:
//
//   * SCOPE IS THE ACCOUNT, NOT THE SESSION. Every seat on the box spends the
//     same plan, so this is keyed by organization id and surfaces ONCE, not
//     per session.
//   * IT IS ONLY AS FRESH AS THE LAST FORWARDED TURN. Nothing polls the API.
//     Hence `as_of`/`age_s` on every snapshot — a consumer rendering a
//     percentage without the age is lying by omission.
//   * A 429 CARRIES NO QUOTA HEADERS AT ALL (measured 102/102). The response
//     that proves the wall was hit cannot raise the percentage, so the last
//     good numbers stay the state and the 429 is tracked beside them.
//
// Parsing is DELIBERATELY GENERIC: windows are discovered from the header
// names, never hardcoded, because they demonstrably appear without warning (a
// `7d_oi` meter showed up in 256 of 4k captures). An unrecognized header lands
// in `unmapped` rather than being dropped, so a new meter is visible the day
// it ships.

const PREFIX = 'anthropic-ratelimit-unified-';

// Suffixes whose leading part names a WINDOW (5h / 7d / 7d_oi / overage / …).
const WINDOW_FIELDS = ['surpassed-threshold', 'disabled-reason', 'utilization',
  'status', 'reset'];
// Names that are whole-account rather than per-window.
const TOP_FIELDS = new Set(['status', 'reset', 'representative-claim',
  'fallback-percentage', 'upgrade-paths']);

// The API's word for "this is the window that binds you" -> our window key.
// MEASURED, NOT GUESSED (98,456 captures): the only three claim strings the
// wire has ever sent are `five_hour`, `seven_day` and
// `seven_day_overage_included`. wirescope's earlier version invented
// `seven_day_oi` by analogy with the `7d_oi-*` header prefix — a string the
// wire never sends — which silently nulled `primary` on ~1% of turns. The
// header prefix and the claim word are DIFFERENT vocabularies; do not derive
// one from the other, and add a mapping here only after seeing it in captures.
const CLAIM_WINDOW = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_overage_included: '7d_oi',
  overage: 'overage',
};

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Wire headers -> { fields, windows, unmapped }, or null when the response
// carried no unified-ratelimit headers at all. That null is the whole gate:
// count_tokens, the models stub, EVERY codex turn and every 429 land here, so
// no caller needs to filter by session type to keep a codex seat from
// reporting a Claude plan's numbers.
function parseQuotaHeaders(headers) {
  const fields = {};
  const windows = {};
  const unmapped = {};
  let saw = false;
  for (const [rawKey, value] of Object.entries(headers || {})) {
    const k = String(rawKey).toLowerCase();
    if (!k.startsWith(PREFIX)) continue;
    const rest = k.slice(PREFIX.length);
    if (TOP_FIELDS.has(rest)) {
      fields[rest.replace(/-/g, '_')] = value;
      saw = true;
      continue;
    }
    // Longest-first is not needed here: no WINDOW_FIELDS entry is a suffix of
    // another, so the first match is the only match.
    const field = WINDOW_FIELDS.find((f) => rest.endsWith(`-${f}`));
    if (field) {
      const win = rest.slice(0, rest.length - field.length - 1);
      if (!windows[win]) windows[win] = {};
      windows[win][field.replace(/-/g, '_')] = value;
    } else {
      unmapped[k] = value; // a meter we have never seen — surfaced, not dropped
    }
    saw = true;
  }
  if (!saw) return null;
  return { fields, windows, unmapped };
}

function windowView(name, raw) {
  const util = num(raw.utilization);
  const reset = num(raw.reset);
  const out = {
    window: name,
    utilization: util,
    // Both directions spelled out: a status bar wants "7% left", a gauge wants
    // "93% used", and neither should do float math on a percentage string it
    // parsed back out of something it rendered itself.
    used_pct: util != null ? Math.round(util * 1000) / 10 : null,
    remaining_pct: util != null ? Math.round((100 - util * 100) * 10) / 10 : null,
    // The SERVER's escalation against its own surpassed_threshold. Read the
    // field; never re-derive it from a percentage, or we disagree with the
    // CLI's own warnings.
    status: raw.status != null ? String(raw.status) : null,
    // ABSOLUTE epoch seconds. The relative remainder is derived at RENDER time
    // (proxy-util's pickQuota), never stored: a stored countdown freezes the
    // moment traffic stops, and once the window rolls it would render a stale
    // percentage for a window that already reset.
    reset: reset != null ? Math.trunc(reset) : null,
  };
  const th = num(raw.surpassed_threshold);
  if (th != null) out.surpassed_threshold = th;
  if (raw.disabled_reason != null) out.disabled_reason = String(raw.disabled_reason);
  return out;
}

// A parsed entry -> the display-ready block `shapeQuota` consumes. Pure: `now`
// is only used for `age_s`, never to bake a countdown into the output.
function snapshotFrom(entry, accounts, now) {
  if (!entry) return null;
  const f = entry.fields || {};
  const windows = {};
  for (const [k, v] of Object.entries(entry.windows || {})) windows[k] = windowView(k, v);
  const claim = f.representative_claim != null ? String(f.representative_claim) : null;
  let rep = claim != null ? (CLAIM_WINDOW[claim] || null) : null;
  if (rep != null && !windows[rep]) rep = null;
  const reset = num(f.reset);
  const out = {
    as_of: entry.as_of,
    age_s: Math.round((now - entry.as_of) * 10) / 10,
    source: 'response_headers',
    status: f.status != null ? String(f.status) : null,
    reset: reset != null ? Math.trunc(reset) : null,
    representative_claim: claim,
    // Which window the API itself says is the binding one — the number to put
    // on a status bar with room for exactly one.
    representative_window: rep,
    primary: rep ? windows[rep] : null,
    windows,
    org_id: entry.org_id || null,
    workspace_id: entry.workspace_id || null,
    accounts,
  };
  const fb = num(f.fallback_percentage);
  if (fb != null) out.fallback_percentage = fb;
  if (f.upgrade_paths) {
    out.upgrade_paths = String(f.upgrade_paths).split(',').map((p) => p.trim()).filter(Boolean);
  }
  if (entry.last_429) {
    out.last_429 = entry.last_429;
    out.last_429_age_s = Math.round((now - entry.last_429) * 10) / 10;
  }
  if (entry.unmapped && Object.keys(entry.unmapped).length) out.unmapped = entry.unmapped;
  return out;
}

const SCHEMA = 'CREATE TABLE IF NOT EXISTS quota_state (' +
  'account TEXT PRIMARY KEY, as_of REAL NOT NULL, payload TEXT NOT NULL)';

// Per-account readings, in memory and mirrored to disk. The store is
// observer-grade: every persistence failure is reported and swallowed, because
// a broken quota table must never take down the request path it rides on.
class QuotaStore {
  // `path` omitted → memory only (tests, and the degraded path when sqlite is
  // unavailable). `onError` takes a MESSAGE, never the exception: these
  // headers sit beside an authorization header on the same response, and
  // nothing here should hand a logger an object it might serialize whole.
  constructor({ path: dbPath = null, onError = null } = {}) {
    this._byAccount = new Map();
    this._lastAccount = null;
    this._onError = typeof onError === 'function' ? onError : null;
    this._db = null;
    this._put = null;
    if (dbPath) {
      try {
        const { DatabaseSync } = require('node:sqlite');
        this._db = new DatabaseSync(dbPath);
        this._db.exec(SCHEMA);
        // Prepared ONCE, as WarmthStore does: _persist runs on the response
        // path several times per turn per seat, and re-preparing there puts a
        // statement compile between the upstream response and the client.
        this._put = this._db.prepare(
          'INSERT OR REPLACE INTO quota_state (account, as_of, payload) VALUES (?,?,?)');
        this._restore();
      } catch (e) {
        this._db = null;
        this._put = null;
        this._fail(`open: ${e.message}`);
      }
    }
  }

  _fail(message) {
    if (this._onError) {
      try { this._onError(message); } catch { /* a logger must not break the wire */ }
    }
  }

  // Record the quota headers off a finished upstream response. Cheap enough to
  // sit on the response path: a scan of ~30 header keys.
  note(headers, { status = null, now = Date.now() / 1000 } = {}) {
    // Callers pass whatever the http library handed them; normalize casing
    // once so the org lookup and the parse agree.
    const lower = {};
    for (const [k, v] of Object.entries(headers || {})) lower[String(k).toLowerCase()] = v;
    // A response that omits the org header files under the literal 'default'
    // and persists as its own row, so one real org that intermittently omits it
    // reads as two accounts. Faithful to the reference and nothing surfaces the
    // account count today — for whoever does.
    const acct = lower['anthropic-organization-id'] || 'default';
    const parsed = parseQuotaHeaders(lower);
    if (!parsed) {
      if (status === 429) {
        // A quota rejection with no numbers on it. Keep it beside whatever the
        // last good reading was and NEVER let it overwrite one.
        // ATTRIBUTION: a 429 need not carry the org header either, and filing
        // it under 'default' would park it beside no reading at all — the bar
        // would show a stale percentage with no sign of the wall being hit.
        // Fall back to the account we last read from.
        const key = this._byAccount.has(acct) ? acct : this._lastAccount;
        const cur = key != null ? this._byAccount.get(key) : null;
        if (cur) {
          cur.last_429 = now;
          this._persist(key, cur);
          // A refusal is the moment the chip most needs to change, so this
          // returns a snapshot like any other reading — the CALLER cannot
          // distinguish "nothing to say" from "refused" if both return null.
          return this.snapshot(now);
        }
      }
      return null;
    }
    const prev = this._byAccount.get(acct);
    const entry = {
      fields: parsed.fields,
      windows: parsed.windows,
      unmapped: parsed.unmapped,
      as_of: now,
      org_id: lower['anthropic-organization-id'] || null,
      workspace_id: lower['anthropic-workspace-id'] || null,
    };
    // A 429 is a fact about the account, not about this reading — it must
    // survive the good response that follows it, or the chip would stop
    // reporting refusals the moment one turn got through.
    if (prev && prev.last_429) entry.last_429 = prev.last_429;
    this._byAccount.set(acct, entry);
    this._lastAccount = acct;
    this._persist(acct, entry);
    return this.snapshot(now);
  }

  // The most recently seen account's numbers, display-ready. Null when nothing
  // has been observed yet.
  snapshot(now = Date.now() / 1000) {
    if (!this._byAccount.size) return null;
    let acct = this._lastAccount;
    if (acct == null || !this._byAccount.has(acct)) {
      let best = null;
      let bestTs = -Infinity;
      for (const [k, v] of this._byAccount) {
        if ((v.as_of || 0) > bestTs) { bestTs = v.as_of || 0; best = k; }
      }
      acct = best;
    }
    if (acct == null) return null;
    return snapshotFrom(this._byAccount.get(acct), this._byAccount.size, now);
  }

  _persist(acct, entry) {
    if (!this._put) return;
    try {
      this._put.run(acct, entry.as_of, JSON.stringify(entry));
    } catch (e) {
      this._fail(`persist: ${e.message}`);
    }
  }

  // A restart otherwise shows no quota at all until the next forwarded turn,
  // which for an idle fleet can be a long time. A stale-but-stamped reading
  // beats a blank one because `age_s` makes the staleness legible, and the
  // absolute reset keeps the countdown honest with no traffic at all.
  _restore() {
    let rows = [];
    try {
      rows = this._db.prepare('SELECT account, as_of, payload FROM quota_state').all();
    } catch (e) {
      this._fail(`restore: ${e.message}`);
      return;
    }
    let best = null;
    let bestTs = -Infinity;
    for (const row of rows) {
      try {
        this._byAccount.set(row.account, JSON.parse(row.payload));
      } catch {
        continue; // one unreadable row must not lose the others
      }
      if (row.as_of > bestTs) { bestTs = row.as_of; best = row.account; }
    }
    if (best != null) this._lastAccount = best;
  }

  close() {
    if (!this._db) return;
    try { this._db.close(); } catch { /* closing a broken handle is not news */ }
    this._db = null;
    this._put = null;
  }
}

module.exports = { QuotaStore, parseQuotaHeaders, snapshotFrom, CLAIM_WINDOW };
