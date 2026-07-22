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

// A managed sandbox box publishes its wirescope on a host-reachable loopback port
// and advertises it via CLODEX_WIRESCOPE_PUBLIC_URL. peerProxyView strips
// base/sessionId for a generic peer — its proxyBase is on the OWNER's loopback,
// unreachable from the viewer — but a BOX's public URL is reachable from the host,
// so the box should surface it (with the live sessionId) to light the viewer's
// wirescope session link. Gated on the box's own wirescope actively tracking the
// session (p.base && p.sessionId — the same gate the cost/bust/report query chips
// use), so the link never points at a session wirescope isn't following. Returns
// { base, sessionId } to merge into the peer view, or null (unset publicUrl — the
// generic-peer case — or no live base/sessionId). Trailing slashes trimmed, matching
// web-host's proxyBase→public rewrite.
function boxWirescopeView(p, publicUrl) {
  const base = (publicUrl || '').trim().replace(/\/+$/, '');
  if (!base || !p || !p.base || !p.sessionId) return null;
  return { base, sessionId: p.sessionId };
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
//
// The worse case is MOUSE TRACKING: the Claude CLI enables it (DECSET 1000/1006),
// so xterm forwards every scroll/click over a Claude pane as an SGR mouse report
// (\x1b[<64;x;yM) — or a legacy X10 report (\x1b[M + 3 raw bytes) — through this
// same path. Scrolling to merely READ a pane then stamps lastUserInputTs, which
// makes _maybeParkDelivery think the operator is composing and parks EVERY DM to
// that agent until the 300s quiet-gate cap drains it ("everything 5 minutes late";
// mouse reports carry no Enter so the draft never closes on its own). So these
// must classify as non-human too. Only data that isn't purely auto-replies counts
// as human; unknown sequences count as human — that fails toward a missed compact
// or an unnecessary take-control, never a bad injection or a swallowed keystroke.
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

// Bracketed-paste markers. Claude Code enables bracketed paste (mode 2004), so a
// multiline paste arrives as ONE human chunk wrapped `\x1b[200~…\x1b[201~`, and
// the CLI treats the interior \r as LITERAL newlines — the paste does NOT submit,
// the draft stays open. A naive "\r ⇒ closed" would false-close the latch and let
// the next parkable delivery splice straight through the open draft (Bogdan's
// paste-logs-into-a-draft workflow — the exact bug this whole fix prevents).
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Draft-close detection, STATEFUL across chunks. A submit/abort key (Enter \r or
// Ctrl-C \x03) closes the draft ONLY when it lands OUTSIDE a bracketed-paste
// region; inside a paste every byte is literal content. node-pty splits a large
// paste across reads, so the 200~/201~ region can SPAN chunks — the caller
// threads the running `inPaste` bit back in each call (main.js keeps it on
// s._inPaste next to the other keystroke stamps).
//
// Returns { closes, inPaste }: `closes` = a real submit/abort happened in this
// chunk; `inPaste` = the paste state to carry into the next chunk. A \r AFTER the
// 201~ closer in the same chunk still closes (we're back outside the region).
//
// \x03 inside a paste: treated as NON-closing (literal pasted byte, not a live
// Ctrl-C — the CLI doesn't abort on it), consistent with the unsafe-false-close
// direction this fix targets. clodex's spec leaned "still closes"; going the
// fail-safe way instead (documented, easily flipped). Only ever consulted for
// input already classified human (isHumanPtyInput), so focus/query replies never
// reach it.
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

// PTY-OUTPUT paste-mode tracker — the flip side of draftChunkSignal, which
// reads INPUT. An application enables/disables bracketed paste by WRITING
// \x1b[?2004h / \x1b[?2004l to its terminal, so the CLI's live paste-mode
// state is readable from the output stream, CLI-agnostically. The inject path
// uses it to decide whether wrapping a multi-line injection in 200~/201~
// markers is safe: wrapped while the mode is OFF, the markers would land as
// literal bytes in the input buffer. Returns the new state; a chunk carrying
// neither sequence returns `prev`; when a chunk carries both, the LAST one
// wins (matches the terminal's view). A sequence split across PTY reads is
// missed — acceptable by fail direction: a missed enable ⇒ unwrapped
// injection = the old behavior; a missed disable only matters in the
// teardown window where the session is dying anyway.
const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';
function pasteModeSignal(chunk, prev = false) {
  const s = chunk == null ? '' : String(chunk);
  const on = s.lastIndexOf(PASTE_MODE_ON);
  const off = s.lastIndexOf(PASTE_MODE_OFF);
  if (on < 0 && off < 0) return !!prev;
  return on > off;
}

// Level-triggered "is the operator mid-draft right now?" latch. True once a
// keystroke has landed more recently than the last submit/abort — and it STAYS
// true across thinking pauses, unlike the time-windowed quiet-gate which
// reopens the instant typing pauses. Callers stamp lastUserInputTs on every
// human keystroke and lastUserSubmitTs when draftChunkSignal closes. Zero/absent
// timestamps read as no-draft. Fail direction is safe for the park divert: a
// stale "still open" parks the delivery (drains on the next submit or the cap),
// which is never worse than a splice.
function isDraftOpen({ lastUserInputTs = 0, lastUserSubmitTs = 0 } = {}) {
  return (lastUserInputTs || 0) > (lastUserSubmitTs || 0);
}

// Parse a version string into a [major, minor, patch] triple. Leading `v` and
// any pre-release tail (after `-`) are dropped; a missing minor/patch reads 0
// (so "2" == "2.0.0"). Returns null when the string isn't version-ish — a
// present-but-non-numeric component (e.g. "2.x.1") or an empty/garbage value —
// so callers can render 'unknown' rather than guess.
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

// Severity of a PEER's version relative to ours — the semver distance, named so
// the UI can tint it. 'current' (equal), 'patch'/'minor'/'major' (peer behind
// us, by the highest differing component), 'newer' (peer AHEAD — we're the stale
// one, so it's informational, never alarming), 'unknown' (either side
// unparseable). Pure; drives both the header tint and the popover's severity
// line.
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

// Does offering "Update Clodex" on a peer make sense at severity `sev`? Show for
// a box genuinely behind us (patch/minor/major) and for 'unknown' — an
// unparseable/dev version we can't rule an update out for, so keep the escape
// hatch. Hide for 'current' (nothing to do) and 'newer' (the deploy script pulls
// latest master, so "updating" a box ahead of us is a pointless restart). Pure.
function updateApplies(sev) {
  return sev !== 'current' && sev !== 'newer';
}

// Best-effort age/behind facts for a peer's version, off a newest-first
// `releases` list ([{tag, published_at}] as cached from GitHub). Finds the
// release whose tag matches `v<version>` (leading `v` optional on either side);
// its index IS the releases-behind count (newest-first). Returns
// { behind, ageDays } — ageDays null when the date is missing/unparseable — or
// null when the version isn't in the list (a dev build / unpublished tag), so
// the popover omits the age line entirely. Pure.
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

// Decision + the reason it went that way — the reason drives the ops-log
// observability ("autocompact suppressed: cache-not-warm") that surfaced the
// silent-never-fired class. shouldAutoCompact stays a thin boolean wrapper so
// existing callers and tests keep their contract. `fire` true ⇒ reason 'fire'.
// `reasonClass` is the reason with any parenthesized live numbers stripped —
// the caller's once-per-transition log dedup MUST key on it, not on `reason`:
// warmth-headroom embeds the decaying countdown, so the full string "changes"
// every poll (this flooded the ops log with one line per 5s tick).
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
// answers the dialog. Codex sessions carry no warmth signal at all, so their
// label never shows one (the poller's 'cold' for them is absence, not fact).
function peerStatusLabel({ state, idleMs, payload, attention = null, agentType = null, now = Date.now() }) {
  if (attention === 'permission') return 'blocked on a permission dialog';
  if (state === 'thinking') return 'working';
  const w = agentType === 'codex' ? null : warmthNow(payload, now);
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
    // Since-compact rollup (wirescope, shape frozen 07-15 per its dm): counters
    // from the last detected compact boundary — or session start when
    // `compacted` is false. Whole-tree like cost. Absent (older proxy) === null
    // (no totals yet); NEVER partial per the contract, so shape all-or-nothing.
    sinceCompact: (r.since_compact && typeof r.since_compact === 'object') ? {
      turns: typeof r.since_compact.turns === 'number' ? r.since_compact.turns : null,
      requests: typeof r.since_compact.requests === 'number' ? r.since_compact.requests : null,
      estUsd: typeof r.since_compact.est_usd === 'number' ? r.since_compact.est_usd : null,
      boundaryTs: typeof r.since_compact.boundary_ts === 'number' ? r.since_compact.boundary_ts : null,
      compacted: r.since_compact.compacted === true,
    } : null,
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
  boxWirescopeView,
  AUTO_COMPACT, headroomBand, shouldAutoCompact, autoCompactDecision, isHumanPtyInput,
  draftChunkSignal, isDraftOpen, pasteModeSignal, PASTE_START, PASTE_END,
  versionSeverity, updateApplies, releaseAgeInfo,
  DM_HOLD_IDLE_MS, peerStatusLabel, shouldHoldDm,
};
