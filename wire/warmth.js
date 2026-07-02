'use strict';

// Prefix-warmth ledger: port of proxylab/warmth.py (W2 step 2,
// CLODEUX-PLAN.md). Warmth lives on the CONTENT-ADDRESSED prefix the
// backend caches, not on the session — a forked keep-warm ping shares the
// prefix but never writes the original session's transcript, so warmth is
// LEARNED from response receipts and stored here.
//
// TWO-STATE SEMANTICS (proxylab decision 2026-06-09): the expiry predicate
// IS the answer. warm = row exists AND expires_at > now; everything else
// is not-warm. The store is durable and stamps every response-confirmed
// cache event, so absence ≈ expiry. Gates:
//   * ping  IFF warm   (anything else declines — never higher cost)
//   * strip IFF NOT warm ('cold'/'absent'); 'error'/'off' decline
//     (absence is evidence, a broken store is not)
// state() reports 'cold' (lapsed row awaiting purge) vs 'absent' (no row)
// for OBSERVABILITY only — no gate distinguishes them.
//
// EXPIRY IS THE GC: correctness lives in the read predicate, never in row
// deletion. sweep() only reclaims disk space, with generous slack, and may
// run late or never without changing any gate decision.
//
// STAMPS ARE RESPONSE-CONFIRMED: a row exists ONLY because the backend
// said a cache does (cache_creation > 0 = written, cache_read > 0 = read
// & TTL slid). A declined sub-min-cacheable prefix is NOT stamped —
// marking it warm would be a lie a later ping would pay for.
//
// Storage: node:sqlite DatabaseSync (decision closed 2026-07-02 — works in
// the shipped Electron, zero native modules). Same schema as proxylab's
// warmth.sqlite but a SEPARATE db file: rows can't be shared with the
// Python lab anyway because the hash differs by construction (see below).
// Single synchronous writer in-process — Python's cross-thread LOCK
// discipline collapses to plain calls.
//
// HASH DEVIATION (deliberate, documented): Python uses
// blake2b(digest_size=20); digest_size is a blake2 PARAMETER, not a
// truncation, and Node's OpenSSL exposes only blake2b512 — equal output is
// impossible without vendoring a JS blake2b (zero-dep rule says no). We
// use blake2b512 truncated to 20 bytes. Canonical JSON also differs on
// Python-only spellings (1.0 vs 1 — JSON.parse collapses them). Warmth
// only needs INTERNAL consistency: same request bytes → same hash,
// turn-over-turn, across app restarts. The golden gate therefore compares
// STATE-FOR-STATE verdicts + hash equivalence classes against proxylab,
// never raw hashes.

const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS warmth (' +
    'hash TEXT PRIMARY KEY, stamped_at REAL NOT NULL, ' +
    'ttl INTEGER NOT NULL, expires_at REAL NOT NULL)',
  'CREATE TABLE IF NOT EXISTS session_head (' +
    'session_id TEXT PRIMARY KEY, hash TEXT NOT NULL, ' +
    'updated_at REAL NOT NULL)',
  // segment index: the session's last-seen leading-breakpoint hashes
  // (marker 1 = tools, marker 2 = tools+system) — display-grade only.
  // Additive migrations, same statements as proxylab (duplicate-column
  // errors swallowed on re-run).
  'ALTER TABLE session_head ADD COLUMN tools_hash TEXT',
  'ALTER TABLE session_head ADD COLUMN sys_hash TEXT',
  // cold-resume counter: real turns that landed on a LAPSED head — the
  // cache went cold between turns and the backend re-wrote the prefix.
  'ALTER TABLE session_head ADD COLUMN cold_resumes INTEGER NOT NULL DEFAULT 0',
];

// --- canonicalization (pure) -------------------------------------------------

// Deep copy with every `cache_control` removed, so an unchanged message
// hashes IDENTICALLY turn-over-turn (the rolling marker hops onto the new
// last message each turn — hashing it would make the 'same' history change
// and a returning session would never match).
function stripCacheControl(node) {
  if (Array.isArray(node)) return node.map(stripCacheControl);
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) {
      if (k !== 'cache_control') out[k] = stripCacheControl(node[k]);
    }
    return out;
  }
  return node;
}

// Canonical JSON: recursively key-sorted, minimal separators — the JS twin
// of json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False).
function canonJson(node) {
  if (Array.isArray(node)) return '[' + node.map(canonJson).join(',') + ']';
  if (node && typeof node === 'object') {
    return '{' + Object.keys(node).sort()
      .map((k) => JSON.stringify(k) + ':' + canonJson(node[k])).join(',') + '}';
  }
  return JSON.stringify(node) ?? 'null';
}

function canonMessage(m) {
  return Buffer.from(canonJson(stripCacheControl(m)), 'utf8');
}

// System text for the warmth fingerprint, EXCLUDING the volatile per-turn
// attribution block (x-anthropic-billing-header) — it changes every turn
// but is out-of-band and does NOT participate in the prompt cache.
function stableSysText(obj) {
  const sys = obj.system;
  if (Array.isArray(sys)) {
    return sys
      .filter((b) => b && typeof b === 'object' && !Array.isArray(b)
        && !String(b.text || '').startsWith('x-anthropic-billing-header'))
      .map((b) => b.text || '')
      .join(' ');
  }
  return sys || '';
}

// A constant lead-in standing in for the tools+system prefix. Folding it
// in means a silent model / tool-set / system-prompt change invalidates
// the key (reads cold) instead of colliding with a different real entry.
function sysToolsFingerprint(obj) {
  const tools = Array.isArray(obj.tools) ? obj.tools : [];
  const names = tools
    .filter((t) => t && typeof t === 'object')
    .map((t) => t.name || '')
    .sort();
  return Buffer.from([obj.model || '', names.join(','), stableSysText(obj)].join('\x1f'), 'utf8');
}

function blake20(buffers) {
  const h = crypto.createHash('blake2b512');
  for (const b of buffers) h.update(b);
  return h.digest('hex').slice(0, 40); // 20 bytes
}

// Chain-hash of the cacheable prefix: tools/system fingerprint + messages
// [0:upto], each canonicalized without cache_control.
function prefixHash(obj, upto) {
  const parts = [sysToolsFingerprint(obj)];
  const msgs = Array.isArray(obj.messages) ? obj.messages : [];
  for (const m of msgs.slice(0, upto)) {
    parts.push(Buffer.from('\x1e'));
    parts.push(canonMessage(m));
  }
  return blake20(parts);
}

// Hashes for the two leading CLI cache breakpoints (both live in system[];
// the CLI marks system blocks, never inside tools[]). marker 1 caches
// tools + preamble → segment "tools"; the LAST marker adds the system
// prompt → segment "system". Single-marker layouts yield only "system".
// DISPLAY-GRADE, NOT GATE-GRADE: no gate may read these rows.
function segmentHashes(obj) {
  const tools = Array.isArray(obj.tools) ? obj.tools : [];
  const sys = Array.isArray(obj.system) ? obj.system : [];
  const markers = [];
  for (let i = 0; i < sys.length; i++) {
    const b = sys[i];
    if (b && typeof b === 'object' && !Array.isArray(b) && b.cache_control) markers.push(i);
  }
  if (!markers.length) return {};
  const model = Buffer.from(obj.model || '', 'utf8');

  const hashUpto = (idx) => {
    // tools (all of them) + system blocks up to & incl. idx, minus the
    // out-of-band billing header; the cumulative prefix the server caches.
    const stable = sys.slice(0, idx + 1).filter((b) =>
      !(b && typeof b === 'object' && !Array.isArray(b)
        && String(b.text || '').startsWith('x-anthropic-billing-header')));
    return blake20([model, Buffer.from('\x1e'), canonMessage(tools), Buffer.from('\x1e'), canonMessage(stable)]);
  };
  const ttlOf = (idx) => ((sys[idx].cache_control || {}).ttl === '1h' ? 3600 : 300);

  const out = {};
  if (markers.length >= 2) {
    out.tools = { hash: hashUpto(markers[0]), ttl: ttlOf(markers[0]) };
  }
  out.system = { hash: hashUpto(markers[markers.length - 1]), ttl: ttlOf(markers[markers.length - 1]) };
  return out;
}

// TTL (seconds) of the message-tail cache breakpoint: 3600 for ttl:'1h',
// else 300. Falls back to the system markers.
function markerTtl(obj) {
  const msgs = Array.isArray(obj.messages) ? obj.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i] && msgs[i].content;
    if (Array.isArray(c)) {
      for (const blk of c) {
        if (blk && typeof blk === 'object' && blk.cache_control) {
          return blk.cache_control.ttl === '1h' ? 3600 : 300;
        }
      }
    }
  }
  const sys = obj.system;
  if (Array.isArray(sys)) {
    for (const b of sys) {
      if (b && typeof b === 'object' && b.cache_control) {
        return b.cache_control.ttl === '1h' ? 3600 : 300;
      }
    }
  }
  return 300;
}

// A recognized keep-warm ping: the LAST user message carries the sentinel.
// Such a turn refreshes the shared prefix but its own tail is throwaway,
// so recording hashes UP TO (not including) it.
function isWarmPing(obj, sentinel) {
  if (!sentinel) return false;
  const msgs = Array.isArray(obj.messages) ? obj.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    const c = msgs[i].content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((b) => b && typeof b === 'object').map((b) => b.text || '').join(' ')
        : '';
    return text.includes(sentinel);
  }
  return false;
}

// --- store -------------------------------------------------------------------

class WarmthStore {
  // opts:
  //   path      sqlite file (default ':memory:' — tests/replay)
  //   sentinel  keep-warm ping marker in the tail message (off when unset)
  //   now       clock override, seconds (replay uses capture timestamps)
  constructor(opts = {}) {
    this.sentinel = opts.sentinel || null;
    this._now = opts.now || (() => Date.now() / 1000);
    this.db = new DatabaseSync(opts.path || ':memory:');
    for (const ddl of SCHEMA) {
      try { this.db.exec(ddl); } catch (e) {
        if (!/duplicate column name/.test(e.message)) throw e;
      }
    }
    this._stamp = this.db.prepare(
      'INSERT INTO warmth(hash, stamped_at, ttl, expires_at) VALUES(?,?,?,?) ' +
      'ON CONFLICT(hash) DO UPDATE SET stamped_at=excluded.stamped_at, ' +
      'ttl=excluded.ttl, expires_at=excluded.expires_at');
    this._getRow = this.db.prepare('SELECT stamped_at, ttl, expires_at FROM warmth WHERE hash=?');
    this._getHead = this.db.prepare(
      'SELECT hash, tools_hash, sys_hash, cold_resumes FROM session_head WHERE session_id=?');
    this._putHead = this.db.prepare(
      'INSERT INTO session_head(session_id, hash, updated_at, tools_hash, sys_hash, cold_resumes) ' +
      'VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET ' +
      'hash=excluded.hash, updated_at=excluded.updated_at, tools_hash=excluded.tools_hash, ' +
      'sys_hash=excluded.sys_hash, cold_resumes=excluded.cold_resumes');
  }

  close() {
    this.db.close();
  }

  // 'warm' | 'cold' | 'absent' | 'error'. GATES test === 'warm' only; the
  // strip gate additionally requires 'cold'/'absent' to act ('error'
  // declines — absence is evidence, a broken store is not). The Python
  // 'off' label belongs to the consumer (no store instance = off).
  state(hash) {
    if (!hash) return 'absent';
    let r;
    try { r = this._getRow.get(hash); } catch { return 'error'; }
    if (!r) return 'absent';
    return r.expires_at > this._now() ? 'warm' : 'cold';
  }

  warm(hash) {
    return this.state(hash) === 'warm';
  }

  // Resolve warmth by hash (content-addressed, fork-proof) or session_id
  // (convenience: the session's latest head hash, which a fork's ping
  // refreshes under the hood). Shape mirrors proxylab warmth_query.
  query({ hash = null, session = null } = {}) {
    let h, r;
    try {
      h = hash || (session ? this._headHash(session) : null);
      if (!h) return { found: false, warm: false, session, hash };
      r = this._getRow.get(h);
    } catch (e) {
      return { found: false, warm: false, session, hash, error: `store: ${e.message}` };
    }
    if (!r) return { found: false, warm: false, session, hash: h };
    const now = this._now();
    return { found: true, warm: now < r.expires_at, session, hash: h,
      age_s: Math.round((now - r.stamped_at) * 10) / 10, ttl_s: r.ttl,
      remaining_s: Math.round(Math.max(0, r.expires_at - now) * 10) / 10 };
  }

  _headHash(session) {
    const r = this._getHead.get(session);
    return r ? r.hash : null;
  }

  // Per-segment readout: the session's last-seen leading breakpoint hashes
  // + their live warmth. Content-addressed, so identical tools+system read
  // warm off a sibling session's traffic. Display-grade only.
  segments(session) {
    let head;
    try { head = this._getHead.get(session); } catch { return null; }
    if (!head || !(head.tools_hash || head.sys_hash)) return null;
    const now = this._now();
    const out = {};
    for (const [label, h] of [['tools', head.tools_hash], ['system', head.sys_hash]]) {
      if (!h) continue;
      let row;
      try { row = this._getRow.get(h); } catch { row = null; }
      out[label] = {
        hash: h,
        state: row ? (row.expires_at > now ? 'warm' : 'cold') : 'absent',
        remaining_s: row ? Math.round(Math.max(0, row.expires_at - now) * 10) / 10 : null,
        ttl_s: row ? row.ttl : null,
      };
    }
    return Object.keys(out).length ? out : null;
  }

  // How many real turns this session resumed from a COLD cache — each one
  // a full prefix re-write at the write premium. Display/analytics-grade.
  coldResumes(session) {
    if (!session) return 0;
    try {
      const r = this._getHead.get(session);
      return r && r.cold_resumes != null ? Number(r.cold_resumes) : 0;
    } catch { return 0; }
  }

  // If this request is a keep-warm ping whose target prefix is NOT warm,
  // return a decline record (caller short-circuits, never forwards). A
  // ping only pays off on a WARM prefix; on anything else forwarding is a
  // cache WRITE at the premium for no gain. Forward IFF warm.
  coldPingDecision(obj) {
    if (!isWarmPing(obj, this.sentinel)) return null;
    const msgs = Array.isArray(obj.messages) ? obj.messages : [];
    const upto = msgs.length - 1; // same basis as record()'s ping path
    if (upto <= 0) return null;
    const h = prefixHash(obj, upto);
    const state = this.state(h);
    if (state === 'warm') return null;
    return { ping: true, blocked: true, warmth_state: state, hash: h,
      n_messages_hashed: upto,
      note: `declined ping: prefix is '${state}', not warm; forwarding ` +
        'would write the prefix at the premium for no gain' };
  }

  // Refresh the ledger for the prefix this response just (re)cached.
  // obj = the FORWARDED request body (exactly what the backend addressed);
  // usage = the response's usage record (merged view is fine — the cache
  // fields ride message_start on both parsers); sessionId = the caller's
  // extracted session identity (Python derives it in-module; the wire
  // already has it in the turn context).
  record(obj, usage, sessionId) {
    const msgs = Array.isArray(obj.messages) ? obj.messages : [];
    if (!msgs.length) return null;
    const created = (usage || {}).cache_creation_input_tokens || 0;
    const read = (usage || {}).cache_read_input_tokens || 0;
    if (created <= 0 && read <= 0) return null; // no cache confirmed → nothing to stamp
    const ping = isWarmPing(obj, this.sentinel);
    const upto = ping ? msgs.length - 1 : msgs.length;
    if (upto <= 0) return null;
    const h = prefixHash(obj, upto);
    const ttl = markerTtl(obj);
    // leading-breakpoint segment rows ride the same stamp: every breakpoint
    // in a cache-confirmed request was read or re-written, TTLs slid too.
    const segs = segmentHashes(obj);
    const now = this._now();
    let resumed = false;
    let newResumes = 0;
    let size;
    try {
      // COLD-RESUME detection (before we restamp): a real turn whose
      // session we've seen before, arriving while that session's last head
      // had LAPSED, means the cache went cold between turns. First turn of
      // a session (no head row) is an initial cold start, NOT a resume.
      if (sessionId && !ping) {
        const prev = this._getHead.get(sessionId);
        if (prev) {
          const pe = this._getRow.get(prev.hash);
          resumed = !pe || pe.expires_at <= now;
          newResumes = Number(prev.cold_resumes || 0) + (resumed ? 1 : 0);
        }
      }
      this._stamp.run(h, now, ttl, now + ttl);
      for (const s of Object.values(segs)) this._stamp.run(s.hash, now, s.ttl, now + s.ttl);
      // a real turn advances this session's head; a fork's ping only
      // refreshes the shared hashes above.
      if (sessionId && !ping) {
        this._putHead.run(sessionId, h, now,
          (segs.tools || {}).hash || null,
          (segs.system || {}).hash || null,
          newResumes);
      }
      size = Number(this.db.prepare('SELECT COUNT(*) AS n FROM warmth').get().n);
    } catch (e) {
      // A failed stamp must be LOUD: it silently degrades a warm prefix to
      // 'absent', which the strip gate acts on.
      console.error(`[warmth] STORE WRITE FAILED ${h.slice(0, 12)}…: ${e.message}`);
      return null;
    }
    return { hash: h, ttl, ts: Math.round(now * 1000) / 1000, ping,
      n_messages_hashed: upto, cache_read_input_tokens: read,
      cache_creation_input_tokens: created,
      warm_on_arrival: read > 0, ledger_size: size,
      cold_resume: resumed, cold_resumes: newResumes,
      segments: Object.keys(segs).length ? segs : null };
  }

  // Hygiene only — reclaims disk for rows lapsed past `slack` seconds.
  // Correctness never depends on this running.
  sweep(slackSeconds = 7 * 24 * 3600) {
    const cutoff = this._now() - slackSeconds;
    this.db.prepare('DELETE FROM warmth WHERE expires_at < ?').run(cutoff);
  }
}

module.exports = {
  WarmthStore, stripCacheControl, canonJson, canonMessage, stableSysText,
  sysToolsFingerprint, prefixHash, segmentHashes, markerTtl, isWarmPing,
};
