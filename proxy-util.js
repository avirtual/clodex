// Pure, dependency-free helpers for the wirescope integration.
// Kept out of main.js so the identity lifecycle (the reviewed risk surface)
// and the /_status field shaping can be unit-tested without booting Electron.
// See https://github.com/avirtual/wirescope (INTEGRATION.md) for the contract.

const crypto = require('crypto');

// Namespaces Clodex's agents in a proxy shared with other tools (workbench
// etc. run on the same machine). Records are prefiltered on this prefix; the
// real bind is exact equality against a session's minted proxyAgent.
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

// Decide a session's proxy agent id per the lifecycle policy:
//   fresh create / fork / legacy entry → mint a new nonce (fresh ledger)
//   resume / restart / restore / clear → reuse the persisted id (continuity)
// `existing` is the persisted entry (or null on fresh create); `taken` is the
// set of already-used ids for uniqueness.
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

// Normalize one /_status `sub_agents[]` entry (a Task/background subagent that
// shares the parent's session_id on the wire) into the renderer's child-row
// shape. `key` is the instance key (agent_id when the wire carried the
// x-claude-code-agent-id header, else role) — it's BOTH the row key and the
// `/_subagents?child=` detail param, identical by construction (wirescope
// contract). Returns null for an unkeyable/garbage entry so the caller filters.
// `last_active_s` is a server-computed fact (now - last_seen, dodges clock skew
// between the proxy and us); we fall back to our own clock only on a pre-add
// proxy that doesn't emit it yet. Running/idle/done + aging are POLICY and live
// entirely renderer-side — we surface raw facts only (same split as /_health).
// Child-row label, most-specific-first: an explicit display_name; else the
// name part of agent_id (a spawn named through the agent-id header carries the
// given name there — the `@session-…` suffix is a per-spawn disambiguator,
// noise for display) unless that part is just a UUID/hex blob; else the role
// (informative for built-ins like Plan/Explore, whose agent_id IS a bare
// UUID); else the key. Presentation only — no classification happens here.
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

// --- Auto-compact-before-cold ------------------------------------------------
// The moment before the prompt cache expires is the cheapest possible time to
// compact: the compact turn re-reads the big context at cache-READ prices, and
// the next real turn cache-writes only the small summary. Doing nothing pays a
// full cache-write over the whole context on wake-up anyway — so when a session
// is about to go cold with a heavy context and no keep-warm hold, fire /compact
// preemptively. Policy (clodex-side; wirescope only supplies the warmth/context
// FACTS in the poll payload):
//   - enabled: per-session, default ON (opt-out persisted as autoCompact:false)
//   - warm and expiring within the headroom band (see headroomBand), no hold
//     (keep-warm owns that moment — the two are alternatives for the same event)
//   - context >= MIN_INPUT_TOKENS (small contexts aren't worth a lossy compact)
//   - atPrompt: the last main-line stop was terminal (stop.is_turn). A paused
//     turn that went quiet is usually a PERMISSION DIALOG — an injected Enter
//     there would answer the dialog, so never fire without this latch.
//   - INPUT_QUIET_MS since the user's last keystroke in that pane (the Ctrl-U
//     in _injectText would eat a half-typed draft)
//   - COOLDOWN_MS between fires (the 5s poll must not machine-gun /compact)
//
// Headroom band history: WARMTH_HEADROOM_S was a FIXED 60s, tuned when the proxy
// served a ~300s TTL (60s = the last 20% = a sane "about to expire, act now"
// band). Production wirescope moved to ttl_s=3600 (1h) and the constant never
// followed — 60s became the last 1.6% of a warm lifetime, a band the 5s poll
// essentially never sampled (6552 telemetry samples: zero warm-with-low-remaining
// hits; sessions read warm-at-~full then snapped to cold-at-0.0). Auto-compact
// had therefore NEVER fired in production. Fix: a TTL-RELATIVE band — a fraction
// of the actual ttl_s, clamped to [floor, max] — so it scales with whatever TTL
// the proxy serves. The 60s floor preserves the exact old semantics at the old
// ~300s TTL (0.15*300 = 45 → clamps up to 60).
const AUTO_COMPACT = {
  MIN_INPUT_TOKENS: 100_000,
  WARMTH_HEADROOM_S: 60,      // floor (and fallback when ttl_s is unknown)
  HEADROOM_FRAC: 0.15,        // fire in the last 15% of the warm TTL
  HEADROOM_MAX_S: 900,        // cap so a multi-hour TTL can't create an absurd band
  INPUT_QUIET_MS: 120_000,
  COOLDOWN_MS: 600_000,
};

// The remaining_s threshold at/under which a warm session is "about to cool".
// TTL-relative (HEADROOM_FRAC of ttl_s), clamped to [floor, max]. A missing or
// non-numeric ttl_s degrades to the flat floor — never NaN the comparison.
function headroomBand(ttl_s) {
  if (typeof ttl_s !== 'number' || !(ttl_s > 0)) return AUTO_COMPACT.WARMTH_HEADROOM_S;
  const frac = AUTO_COMPACT.HEADROOM_FRAC * ttl_s;
  return Math.min(Math.max(frac, AUTO_COMPACT.WARMTH_HEADROOM_S), AUTO_COMPACT.HEADROOM_MAX_S);
}

// Human-vs-terminal-chatter classifier for PTY-bound data. xterm doesn't only
// forward keystrokes: when the CLI enables focus reporting (DECSET 1004 — the
// Claude CLI does) every pane focus/blur emits \x1b[I / \x1b[O through the same
// onData path, and terminal query replies (cursor position, device attributes,
// OSC color reports) arrive with no human at the keyboard at all. Treating
// those as "a human touched this pane" killed the atPrompt latch whenever the
// user merely LOOKED at a session — an idle agent never turns again, so the
// latch stayed dead and auto-compact could never fire (live miss 2026-07-08).
// Only data that isn't purely auto-replies counts as human. Unknown sequences
// count as human — that fails toward a missed compact, never a bad injection.
const PTY_AUTO_REPLY_RE = new RegExp(
  '\\x1b\\[[IO]' // focus in / focus out (mode 1004)
  + '|\\x1b\\[\\d+;\\d+R' // cursor position report (DSR 6 reply)
  + '|\\x1b\\[0n' // status report ok (DSR 5 reply)
  + '|\\x1b\\[[?>]\\d+(;\\d+)*c' // device attributes reply (DA1/DA2)
  + '|\\x1b\\]\\d+;[^\\x07\\x1b]*(\\x07|\\x1b\\\\)', // OSC query reply (color etc.)
  'g');

function isHumanPtyInput(data) {
  if (!data) return false;
  return String(data).replace(PTY_AUTO_REPLY_RE, '').length > 0;
}

// Decision + the reason it went that way — the reason drives the ops-log
// observability ("autocompact suppressed: cache-not-warm") that surfaced the
// silent-never-fired class. shouldAutoCompact stays a thin boolean wrapper so
// existing callers and tests keep their contract. `fire` true ⇒ reason 'fire'.
function autoCompactDecision({ payload, enabled, atPrompt, lastInputTs = 0, lastFiredTs = 0, now = Date.now() }) {
  if (!enabled) return { fire: false, reason: 'disabled' };
  if (!atPrompt) return { fire: false, reason: 'not-at-prompt' };
  if (!payload) return { fire: false, reason: 'no-payload' };
  if (!payload.linked) return { fire: false, reason: 'unlinked' };
  if (payload.hold) return { fire: false, reason: 'keep-warm-hold' };
  const w = payload.warmth;
  if (!w || w.state !== 'warm' || typeof w.remaining_s !== 'number') return { fire: false, reason: 'cache-not-warm' };
  // TTL-relative headroom (see headroomBand): the band scales with the proxy's
  // actual ttl_s so a 1h TTL doesn't make the fire window unreachable. `band` is
  // returned either way so the caller can log "remaining Ns / band Ms".
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

// --- Peer visibility ([agent:who] labels + dm hold gate) ----------------------
// A DM injection into a long-idle peer with a cold cache re-bills that peer's
// ENTIRE context as a cache write — often dollars for a one-line message. So:
// [agent:who] tells agents which peers are cheap to reach, and a non-urgent DM
// to an expensive one bounces with instructions to resend `urgent` (sender's
// judgment call, not ours). Facts: activityState/activityTs (stamped in
// _emitActivity, both intent paths) + the poller's last payload for warmth.

const DM_HOLD_IDLE_MS = 30 * 60_000;

// Effective cache state NOW from a poll payload: remaining_s decays between
// polls, so age it by payload.ts before trusting 'warm'. 'unknown' (unlinked /
// no proxy / codex) is NOT 'cold' — the two are labeled differently and only
// verifiable warmth counts as cheap-to-reach.
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

// One peer's [agent:who] status suffix: 'working' | 'idle 5h, cache cold' |
// 'idle 12m, warm' | 'idle 3m'. Warmth only shown when known. A session
// blocked on a permission dialog trumps everything — it is neither working
// nor reachable, and peers should know a reply isn't coming until the human
// answers the dialog.
function peerStatusLabel({ state, idleMs, payload, attention = null, now = Date.now() }) {
  if (attention === 'permission') return 'blocked on a permission dialog';
  if (state === 'thinking') return 'working';
  const w = warmthNow(payload, now);
  let label = `idle ${fmtIdle(idleMs)}`;
  if (w === 'warm') label += ', warm';
  else if (w === 'cold') label += ', cache cold';
  return label;
}

// Hold a DM? Two independent gates:
//   DIALOG gate — target is blocked on a permission dialog. Holds even
//   URGENT: message injection ends with Enter, which would ANSWER the open
//   dialog. This is a safety hold, not a cost hold — there is no override.
//   COST gate — holds only when ALL of: not urgent, target not mid-turn, idle
//   past the threshold, and not verifiably warm (a kept-warm peer is cheap no
//   matter how long it's been idle — that's what keep-warm is FOR). Unknown
//   warmth on a long-idle peer holds: 5h idle is cold in every realistic TTL
//   regime, and urgent is a one-line retry if the sender disagrees.
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

// Normalize one /_status record into the renderer payload. `r` is null when no
// proxy record matches the session (unlinked). `probe` carries version + caps.
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
    // `usd` = whole-tree cost (unchanged semantics). `mainUsd` = the main line's
    // OWN share (wirescope v0.6.22+ cost.main_est_usd, gated on cost_by_line);
    // null (never 0) on pre-.22. With per-subagent estUsd, this lets the popover
    // attribute where a fan-out run's cost actually went instead of one opaque
    // whole-tree number.
    cost: r.cost ? {
      usd: r.cost.est_usd ?? null,
      mainUsd: typeof r.cost.main_est_usd === 'number' ? r.cost.main_est_usd : null,
      requests: r.cost.requests ?? null,
    } : null,
    turns: typeof r.turns_completed === 'number' ? r.turns_completed : null,
    refusals: typeof r.refusals === 'number' ? r.refusals : 0,
    // Armed holds only fire pings once a real turn donates auth + a cache to
    // replay; pingable=false means "armed but pending the next turn".
    pingable: r.pingable === true,
    context: r.context ? {
      turns: r.context.turns_in_context ?? null,
      messages: r.context.n_messages ?? null,
      // Live input-token count (cache_read + cache_write + uncached input of the
      // last turn). null on pre-v0.3.1 proxies — renderer falls back to the CLI
      // side-channel. The window SIZE stays CLI-sourced (off-wire here).
      inputTokens: typeof r.context.input_tokens === 'number' ? r.context.input_tokens : null,
    } : null,
    warmth: w ? {
      state: w.state || null,
      remaining_s: typeof w.remaining_s === 'number' ? w.remaining_s : null,
      ttl_s: typeof w.ttl_s === 'number' ? w.ttl_s : null,
    } : null,
    // Proxy-truth strip config (wirescope v0.6.10+). The poller reconciles our
    // persisted intent against `configuredLevel`/`source` here instead of
    // fire-once asserting; `source` must be "override" for a level>=1 to be a
    // durable, recorded intent (a coincidental global-default match isn't).
    // null on pre-v0.6.10 proxies → poller skips assertion (degrades to off).
    strip: r.strip ? {
      configuredLevel: typeof r.strip.configured_level === 'number' ? r.strip.configured_level : null,
      source: r.strip.source || null,
      globalDefaultLevel: typeof r.strip.global_default_level === 'number' ? r.strip.global_default_level : 0,
      ridersAvailable: r.strip.riders_available === true,
    } : null,
    hold: r.hold || null,
    // Cache-bust forensics summary (wirescope v0.6.19+ `bust_summary`). Passed
    // through verbatim — clodex RENDERS, wirescope CLASSIFIES (fault/fix_hint are
    // its call, never re-derived here). Shape: {total, actionable, by_class,
    // classes:[{class,count,fault,fix_hint}], last_bust}. `fault` ∈ {environment
    // (expected cold), content (a real injected-prefix change — model swap, date
    // rollover, CLAUDE.md edit), self (designed strip cost)}. The chip goes loud
    // only on a `content` fault. null on pre-v0.6.19 proxies.
    busts: (r.busts && typeof r.busts === 'object') ? r.busts : null,
    // Task/background subagents nested under this session (share its session_id
    // on the wire). Empty until a real subagent makes a wire turn. Sorted
    // newest-active first to match wirescope's emission order.
    subagents: Array.isArray(r.sub_agents)
      ? r.sub_agents.map((s) => shapeSubagent(s, now)).filter(Boolean)
      : [],
  };
}

module.exports = {
  PROXY_AGENT_PREFIX, mintProxyAgent, resolveProxyAgentId, pickProxyRecord, shapeProxyRecord, shapeSubagent,
  AUTO_COMPACT, headroomBand, shouldAutoCompact, autoCompactDecision, isHumanPtyInput,
  DM_HOLD_IDLE_MS, peerStatusLabel, shouldHoldDm,
};
