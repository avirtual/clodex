
const crypto = require('crypto');

const PROXY_AGENT_PREFIX = 'clodex-';

// Mint a collision-free proxy agent id: clodex-<name>-<nonce>. The nonce makes
// the id unique-by-construction, so a recycled session name can never inherit
// a dead session's telemetry. `rand` is injectable for deterministic tests.
function mintProxyAgent(name, taken, rand = () => crypto.randomBytes(4).toString('hex')) {
  let id;
  do {
    id = `${PROXY_AGENT_PREFIX}${name}-${rand()}`;
  } while (taken && taken.has(id));
  return id;
}

function resolveProxyAgentId({ name, fork, existing, taken, rand }) {
  if (!fork && existing && existing.proxyAgent) return existing.proxyAgent;
  return mintProxyAgent(name, taken, rand);
}

// Pick the right /_status record when several share one proxy agent id.
// `/clear` (and /compact) KEEP the agent id but mint a new session_id, so the
// proxy reports one ended record per past session plus the live one — all under
// the same `agent`. Last-writer-wins over /_status order would bind us to a dead
// `clear`-ended record (the bug this fixes). Disambiguate by, in order:
//   1. exact session_id == the id Clodex already tracks (JsonlWatcher-fresh) —
//      the authoritative bind; it follows the transcript through /clear.
//   2. a live (not-ended) record, most recently seen.
//   3. failing that, the most recently seen record at all.
function pickProxyRecord(candidates, sessionId) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (sessionId) {
    const exact = candidates.find((r) => r && r.session_id === sessionId);
    if (exact) return exact;
  }
  const live = candidates.filter((r) => r && !r.ended);
  const pool = live.length ? live : candidates;
  return pool.reduce((a, b) => ((b.last_seen ?? 0) > (a.last_seen ?? 0) ? b : a));
}

// --strict-mcp-config is passed with no --mcp-config, i.e. the empty set: on
// this fallback path the user's real project/user MCP servers are dropped too.
// The surgical alternative is a strip-capable wire removing only claude_design.
// The reasons are kept distinct because their remedies differ.
// `probe` is null when unreachable or unrecognized (caller owns the try/catch).
function strictMcpReason(proxyBase, probe) {
  if (!proxyBase) return 'unrouted';
  if (!probe) return 'probe-failed';
  const servers = probe.capabilities && probe.capabilities.strip_mcp
    && probe.capabilities.strip_mcp.servers;
  if (Array.isArray(servers) && servers.includes('claude_design')) return null;
  return 'wire-no-strip';
}

const STRICT_MCP_EXPLANATION = {
  'unrouted': 'session is not routed through a wirescope',
  'wire-no-strip': 'the wire does not strip claude_design — deploy a newer wirescope, or use a stripping port',
  'probe-failed': 'the wire did not answer at spawn — restart the session to retry',
};

// The owner's proxyBase is on their loopback and unreachable from a viewer; a
// box's CLODEX_WIRESCOPE_PUBLIC_URL is host-reachable, so only that may be
// surfaced to peers. Gated on a live base+sessionId so the link never points
// at a session wirescope isn't tracking.
function boxWirescopeView(p, publicUrl) {
  const base = (publicUrl || '').trim().replace(/\/+$/, '');
  if (!base || !p || !p.base || !p.sessionId) return null;
  return { base, sessionId: p.sessionId };
}

function subagentLabel(s, key) {
  if (typeof s.display_name === 'string' && s.display_name) return s.display_name;
  const idName = typeof s.agent_id === 'string' ? s.agent_id.split('@')[0] : '';
  if (idName && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(idName)
      && !/^[0-9a-f]{16,}$/i.test(idName)) return idName;
  if (typeof s.role === 'string' && s.role) return s.role;
  return key;
}

function shapeSubagent(s, now) {
  if (!s || typeof s !== 'object') return null;
  const key = typeof s.key === 'string' && s.key ? s.key
    : (typeof s.agent_id === 'string' && s.agent_id ? s.agent_id
      : (typeof s.role === 'string' && s.role ? s.role : null));
  if (!key) return null;
  const lastSeen = typeof s.last_seen === 'number' ? s.last_seen : null;
  const lastActiveS = typeof s.last_active_s === 'number' ? s.last_active_s
    : (lastSeen != null ? Math.max(0, now / 1000 - lastSeen) : null);
  return {
    key,
    agentId: typeof s.agent_id === 'string' ? s.agent_id : null,
    role: typeof s.role === 'string' ? s.role : null,
    label: subagentLabel(s, key),
    model: typeof s.model === 'string' ? s.model : null,
    requests: typeof s.requests === 'number' ? s.requests : null,
    // This subagent's own cost share (wirescope v0.6.22+, gated on
    // capabilities.cost_by_line). null (NEVER 0) = unbilled instance or pre-.22
    // traffic — the renderer must distinguish "no data" from "$0.00".
    estUsd: typeof s.est_usd === 'number' ? s.est_usd : null,
    firstSeen: typeof s.first_seen === 'number' ? s.first_seen : null,
    lastSeen,
    lastActiveS,
  };
}

// Auto-compact fires just before the prompt cache expires: the compact turn
// re-reads context at cache-READ prices and the next real turn cache-writes
// only the summary.
// atPrompt is required because a paused turn that went quiet is usually a
// PERMISSION DIALOG — an injected Enter there would answer the dialog.
// INPUT_QUIET_MS exists because the inject path's Ctrl-U eats a half-typed draft.
// The headroom band must stay TTL-relative: it was a flat 60s, and when the
// proxy moved to ttl_s=3600 that became the last 1.6% of the warm lifetime,
// which the 5s poll never sampled — auto-compact never fired. The 60s floor
// reproduces the old band at the old ~300s TTL.
const AUTO_COMPACT = {
  MIN_INPUT_TOKENS: 100_000,
  WARMTH_HEADROOM_S: 60,      // floor (and fallback when ttl_s is unknown)
  HEADROOM_FRAC: 0.15,        // fire in the last 15% of the warm TTL
  HEADROOM_MAX_S: 900,        // cap so a multi-hour TTL can't create an absurd band
  INPUT_QUIET_MS: 120_000,
  COOLDOWN_MS: 600_000,
};

function headroomBand(ttl_s) {
  if (typeof ttl_s !== 'number' || !(ttl_s > 0)) return AUTO_COMPACT.WARMTH_HEADROOM_S;
  const frac = AUTO_COMPACT.HEADROOM_FRAC * ttl_s;
  return Math.min(Math.max(frac, AUTO_COMPACT.WARMTH_HEADROOM_S), AUTO_COMPACT.HEADROOM_MAX_S);
}

// The Claude CLI enables focus reporting (DECSET 1004) and mouse tracking
// (1000/1006), so merely focusing or scrolling a pane sends \x1b[I / \x1b[O and
// SGR or legacy X10 mouse reports down the same onData path as keystrokes.
// Counting those as human input kills the atPrompt latch and parks every DM to
// the pane. Legacy X10 reports carry 3 arbitrary raw bytes (may include \n).
// Unknown sequences count as human: fail toward a missed compact, never a bad
// injection or a swallowed keystroke.
const PTY_AUTO_REPLY_RE = new RegExp(
  '\\x1b\\[[IO]' // focus in / focus out (mode 1004)
  + '|\\x1b\\[\\d+;\\d+R' // cursor position report (DSR 6 reply)
  + '|\\x1b\\[\\?\\d+;\\d+R' // ?-prefixed cursor position report
  + '|\\x1b\\[0n' // status report ok (DSR 5 reply)
  + '|\\x1b\\[[?>]\\d+(;\\d+)*c' // device attributes reply (DA1/DA2)
  + '|\\x1b\\[<\\d+;\\d+;\\d+[Mm]' // SGR mouse report (mode 1006) — scroll/click/drag
  + '|\\x1b\\[M[\\s\\S]{3}' // legacy X10 mouse — 3 arbitrary raw bytes (may incl \n)
  + '|\\x1b\\[\\?\\d+u' // kitty keyboard protocol flags report
  + '|\\x1b\\[\\?\\d+;\\d+\\$y' // DECRPM mode report (DECRQM reply)
  + '|\\x1b\\[\\?6n' // DECDSR (startup one-shot)
  + '|\\x1b\\[>q' // XTVERSION request (startup one-shot)
  + '|\\x1bP[\\s\\S]*?\\x1b\\\\' // DCS string, terminated by ST (\x1b\\)
  + '|\\x1b\\]\\d+;[^\\x07\\x1b]*(\\x07|\\x1b\\\\)', // OSC query reply (color etc.)
  'g');

function isHumanPtyInput(data) {
  if (!data) return false;
  return String(data).replace(PTY_AUTO_REPLY_RE, '').length > 0;
}

// Claude Code enables bracketed paste (mode 2004): a multiline paste arrives as
// one chunk wrapped \x1b[200~…\x1b[201~ and the CLI treats the interior \r as
// literal — the paste does not submit, so "\r ⇒ draft closed" is wrong.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// node-pty splits a large paste across reads, so a 200~/201~ region can span
// chunks: the caller must thread the returned `inPaste` back in each call.
// A \r or \x03 closes the draft only OUTSIDE a paste region; \x03 inside a
// paste is treated as a literal pasted byte (the CLI does not abort on it).
function draftChunkSignal(chunk, inPaste = false) {
  const s = chunk == null ? '' : String(chunk);
  let paste = !!inPaste;
  let closes = false;
  let i = 0;
  while (i < s.length) {
    if (!paste && s.startsWith(PASTE_START, i)) { paste = true; i += PASTE_START.length; continue; }
    if (paste && s.startsWith(PASTE_END, i)) { paste = false; i += PASTE_END.length; continue; }
    if (!paste) { const c = s[i]; if (c === '\r' || c === '\x03') closes = true; }
    i++;
  }
  return { closes, inPaste: paste };
}

// An application enables/disables bracketed paste by WRITING \x1b[?2004h /
// \x1b[?2004l, so the CLI's live paste mode is readable off the output stream.
// Wrapping an injection in 200~/201~ while the mode is OFF lands the markers as
// literal bytes in the input buffer. A sequence split across reads is missed.
const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';
function pasteModeSignal(chunk, prev = false) {
  const s = chunk == null ? '' : String(chunk);
  const on = s.lastIndexOf(PASTE_MODE_ON);
  const off = s.lastIndexOf(PASTE_MODE_OFF);
  if (on < 0 && off < 0) return !!prev;
  return on > off;
}

function isDraftOpen({ lastUserInputTs = 0, lastUserSubmitTs = 0 } = {}) {
  return (lastUserInputTs || 0) > (lastUserSubmitTs || 0);
}

function parseSemverTriple(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^v/i, '');
  if (!s) return null;
  const parts = s.split(/[.-]/);
  const out = [];
  for (let i = 0; i < 3; i++) {
    if (i >= parts.length) { out.push(0); continue; } // absent trailing ⇒ 0
    if (!/^\d+$/.test(parts[i])) return null;          // present but non-numeric
    out.push(parseInt(parts[i], 10));
  }
  return out;
}

function versionSeverity(ours, theirs) {
  const us = parseSemverTriple(ours);
  const peer = parseSemverTriple(theirs);
  if (!us || !peer) return 'unknown';
  const [uM, um, up] = us;
  const [pM, pm, pp] = peer;
  if (pM === uM && pm === um && pp === up) return 'current';
  const peerNewer = pM > uM || (pM === uM && (pm > um || (pm === um && pp > up)));
  if (peerNewer) return 'newer';
  if (pM !== uM) return 'major';
  if (pm !== um) return 'minor';
  return 'patch';
}

function updateApplies(sev) {
  return sev !== 'current' && sev !== 'newer';
}

function releaseAgeInfo(version, releases, now = Date.now()) {
  if (version == null || !Array.isArray(releases) || !releases.length) return null;
  const want = String(version).trim().replace(/^v/i, '');
  if (!want) return null;
  const idx = releases.findIndex(
    (r) => r && String(r.tag || '').trim().replace(/^v/i, '') === want,
  );
  if (idx < 0) return null;
  const rel = releases[idx];
  let ageDays = null;
  const t = rel.published_at ? Date.parse(rel.published_at) : NaN;
  if (Number.isFinite(t)) ageDays = Math.max(0, Math.floor((now - t) / 86400000));
  return { behind: idx, ageDays };
}

// Callers deduping this decision per transition MUST key on `reasonClass`, not
// `reason`: warmth-headroom embeds a decaying countdown, so the full string
// changes on every 5s poll and floods the log.
function reasonClassOf(reason) { return reason.replace(/\(.*\)$/, ''); }
function autoCompactDecision(args) {
  const d = _autoCompactDecision(args);
  d.reasonClass = reasonClassOf(d.reason);
  return d;
}
function _autoCompactDecision({ payload, enabled, atPrompt, lastInputTs = 0, lastFiredTs = 0, now = Date.now() }) {
  if (!enabled) return { fire: false, reason: 'disabled' };
  if (!atPrompt) return { fire: false, reason: 'not-at-prompt' };
  if (!payload) return { fire: false, reason: 'no-payload' };
  if (!payload.linked) return { fire: false, reason: 'unlinked' };
  if (payload.hold) return { fire: false, reason: 'keep-warm-hold' };
  const w = payload.warmth;
  if (!w || w.state !== 'warm' || typeof w.remaining_s !== 'number') return { fire: false, reason: 'cache-not-warm' };
  const band = headroomBand(w.ttl_s);
  if (w.remaining_s > band) return { fire: false, reason: `warmth-headroom(${w.remaining_s}s/band ${band}s)`, band };
  const ctx = payload.context;
  if (!ctx || typeof ctx.inputTokens !== 'number') return { fire: false, reason: 'no-context-tokens', band };
  if (ctx.inputTokens < AUTO_COMPACT.MIN_INPUT_TOKENS) return { fire: false, reason: `below-min-tokens(${ctx.inputTokens})`, band };
  if (now - lastInputTs < AUTO_COMPACT.INPUT_QUIET_MS) return { fire: false, reason: 'recent-user-input', band };
  if (now - lastFiredTs < AUTO_COMPACT.COOLDOWN_MS) return { fire: false, reason: 'cooldown', band };
  return { fire: true, reason: 'fire', band, remaining_s: w.remaining_s };
}

function shouldAutoCompact(args) {
  return autoCompactDecision(args).fire;
}


const DM_HOLD_IDLE_MS = 30 * 60_000;

function warmthNow(payload, now = Date.now()) {
  if (!payload || !payload.linked || !payload.warmth) return 'unknown';
  const w = payload.warmth;
  if (w.state === 'warm' && typeof w.remaining_s === 'number') {
    return (w.remaining_s - (now - (payload.ts || now)) / 1000 > 0) ? 'warm' : 'cold';
  }
  return w.state === 'cold' ? 'cold' : 'unknown';
}

function fmtIdle(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function peerStatusLabel({ state, idleMs, payload, attention = null, agentType = null, now = Date.now() }) {
  if (attention === 'permission') return 'blocked on a permission dialog';
  if (state === 'thinking') return 'working';
  const w = agentType === 'codex' ? null : warmthNow(payload, now);
  let label = `idle ${fmtIdle(idleMs)}`;
  if (w === 'warm') label += ', warm';
  else if (w === 'cold') label += ', cache cold';
  return label;
}

// The dialog gate holds even URGENT: injection ends with Enter, which would
// ANSWER the open permission dialog. It is a safety hold with no override.
// A verifiably warm peer is never held, however long it has been idle.
function shouldHoldDm({ urgent, state, idleMs, payload, attention = null, now = Date.now() }) {
  if (attention === 'permission') {
    return {
      hold: true,
      noUrgent: true,
      reason: 'blocked on a permission dialog — injecting now would answer the dialog',
    };
  }
  if (urgent || state === 'thinking' || idleMs < DM_HOLD_IDLE_MS) return { hold: false };
  if (warmthNow(payload, now) === 'warm') return { hold: false };
  const w = warmthNow(payload, now);
  return {
    hold: true,
    reason: `idle ${fmtIdle(idleMs)}${w === 'cold' ? ' with a cold cache' : ''} — waking it re-bills its full context`,
  };
}

// Account plan quota, off the top level of /_status (NOT per-session — it is
// the whole account's, and the same block rides every session's poll).
//
// Gated on capabilities.quota rather than on the block being present: a proxy
// too old to compute it answers /_status without the key, and an absent key
// must degrade to showing nothing rather than to a confidently empty chip.
//
// `status` is the SERVER's escalation, published per-window against its own
// `surpassed_threshold` — never re-derive it from a percentage here, or the
// chip disagrees with the CLI's own warnings.
function shapeQuota(q, capabilities) {
  if (!capabilities || !capabilities.quota) return null;
  if (!q || typeof q !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const p = (q.primary && typeof q.primary === 'object') ? q.primary : {};
  return {
    status: typeof q.status === 'string' ? q.status : null,
    window: typeof p.window === 'string' ? p.window
      : (typeof q.representative_window === 'string' ? q.representative_window : null),
    usedPct: num(p.used_pct),
    remainingPct: num(p.remaining_pct),
    resetsInS: num(p.resets_in_s) ?? num(q.resets_in_s),
    // Nothing polls the API — every reading is only as fresh as the last
    // forwarded turn, so the renderer needs this to mark it stale.
    ageS: num(q.age_s),
    // A 429 carries NO ratelimit headers at all, so the response that proves
    // the wall was hit cannot raise the percentage. A recent last_429 beside a
    // sub-100% figure is the EXPECTED shape, not a contradiction.
    last429AgeS: num(q.last_429_age_s),
  };
}

// Past this the reading predates the last few polls of turn traffic and is
// rendered dimmed — see shapeQuota's age note.
const QUOTA_STALE_S = 120;
// A 429 this recent outranks whatever `status` says, for the header reason above.
const QUOTA_429_RECENT_S = 300;

function fmtQuotaReset(s) {
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// The whole render decision, DOM-free. Returns null for "render nothing at
// all" — the element appearing IS the signal, so a comfortable reading must
// produce no element rather than a quiet one. A permanent readout showing a
// comfortable number is furniture that stops being read.
//
// `clientAgeS` is how long since WE received the payload, and it is not
// redundant with the server's age_s: age_s stops advancing the moment the
// poller stops delivering (proxy down, machine asleep, every base idle), so a
// reading frozen at age_s 3.4 would render at full confidence forever. Both
// ages must be young for the chip to read as live.
function quotaChip(q, clientAgeS = 0) {
  if (!q) return null;
  const hot429 = q.last429AgeS != null && q.last429AgeS <= QUOTA_429_RECENT_S;
  let level = null;
  if (q.status === 'rejected' || hot429) level = 'loud';
  else if (q.status === 'allowed_warning') level = 'warn';
  // 'allowed', an unknown status, or no status at all → nothing. Degrading an
  // unrecognized value to silence keeps a vocabulary change from inventing a
  // permanent chip nobody can dismiss.
  if (!level) return null;

  const pct = q.usedPct != null ? `${Math.round(q.usedPct)}%` : null;
  const reset = fmtQuotaReset(q.resetsInS);
  const parts = [];
  // "rate limited" named a past event without saying what it means now; the
  // operator's actual question is whether requests are landing.
  if (hot429) parts.push('requests being refused');
  if (pct) parts.push(q.window ? `${pct} of ${q.window}` : pct);
  else if (q.window) parts.push(q.window);
  if (reset) parts.push(`resets in ${reset}`);
  if (!parts.length) return null;

  const serverAge = q.ageS != null ? q.ageS : 0;
  const stale = Math.max(serverAge, clientAgeS || 0) > QUOTA_STALE_S;
  const tip = [
    'Account plan quota, not this session.',
    q.remainingPct != null ? `${Math.round(q.remainingPct)}% of the ${q.window || 'window'} left.` : null,
    hot429 ? 'A request was rate-limited recently; a 429 carries no quota headers, so the figure beside it can lag.' : null,
    stale ? 'Stale — nothing polls this, it updates only on a forwarded turn.' : null,
    // Distinct from the line above: that one is "the API has not spoken", this
    // one is "we are not receiving". The remedy differs, so the wording must.
    (clientAgeS || 0) > QUOTA_STALE_S ? 'The proxy has not reported in — this figure may be far older than it looks.' : null,
  ].filter(Boolean).join(' ');

  return { level, text: parts.join(' · '), tip, stale };
}

function shapeProxyRecord(r, probe, now = Date.now()) {
  const base = { ts: now, version: probe.version, capabilities: probe.capabilities };
  if (!r) return { ...base, linked: false };
  const w = r.warmth || null;
  return {
    ...base,
    linked: true,
    sessionId: r.session_id || null,
    model: r.model || null,
    title: r.title || null,
    summary: r.summary || null,
    cost: r.cost ? {
      usd: r.cost.est_usd ?? null,
      mainUsd: typeof r.cost.main_est_usd === 'number' ? r.cost.main_est_usd : null,
      requests: r.cost.requests ?? null,
    } : null,
    turns: typeof r.turns_completed === 'number' ? r.turns_completed : null,
    sinceCompact: (r.since_compact && typeof r.since_compact === 'object') ? {
      turns: typeof r.since_compact.turns === 'number' ? r.since_compact.turns : null,
      requests: typeof r.since_compact.requests === 'number' ? r.since_compact.requests : null,
      estUsd: typeof r.since_compact.est_usd === 'number' ? r.since_compact.est_usd : null,
      boundaryTs: typeof r.since_compact.boundary_ts === 'number' ? r.since_compact.boundary_ts : null,
      compacted: r.since_compact.compacted === true,
    } : null,
    refusals: typeof r.refusals === 'number' ? r.refusals : 0,
    pingable: r.pingable === true,
    context: r.context ? {
      turns: r.context.turns_in_context ?? null,
      messages: r.context.n_messages ?? null,
      inputTokens: typeof r.context.input_tokens === 'number' ? r.context.input_tokens : null,
    } : null,
    warmth: w ? {
      state: w.state || null,
      remaining_s: typeof w.remaining_s === 'number' ? w.remaining_s : null,
      ttl_s: typeof w.ttl_s === 'number' ? w.ttl_s : null,
    } : null,
    strip: r.strip ? {
      configuredLevel: typeof r.strip.configured_level === 'number' ? r.strip.configured_level : null,
      source: r.strip.source || null,
      globalDefaultLevel: typeof r.strip.global_default_level === 'number' ? r.strip.global_default_level : 0,
      ridersAvailable: r.strip.riders_available === true,
    } : null,
    hold: r.hold || null,
    busts: (r.busts && typeof r.busts === 'object') ? r.busts : null,
    subagents: Array.isArray(r.sub_agents)
      ? r.sub_agents.map((s) => shapeSubagent(s, now)).filter(Boolean)
      : [],
  };
}

module.exports = {
  PROXY_AGENT_PREFIX, mintProxyAgent, resolveProxyAgentId, pickProxyRecord, shapeProxyRecord, shapeSubagent,
  shapeQuota, quotaChip, fmtQuotaReset, QUOTA_STALE_S, QUOTA_429_RECENT_S,
  boxWirescopeView, strictMcpReason, STRICT_MCP_EXPLANATION,
  AUTO_COMPACT, headroomBand, shouldAutoCompact, autoCompactDecision, isHumanPtyInput,
  draftChunkSignal, isDraftOpen, pasteModeSignal, PASTE_START, PASTE_END,
  versionSeverity, updateApplies, releaseAgeInfo,
  DM_HOLD_IDLE_MS, peerStatusLabel, shouldHoldDm,
};
