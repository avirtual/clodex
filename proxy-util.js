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
    cost: r.cost ? { usd: r.cost.est_usd ?? null, requests: r.cost.requests ?? null } : null,
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
    hold: r.hold || null,
  };
}

module.exports = { PROXY_AGENT_PREFIX, mintProxyAgent, resolveProxyAgentId, pickProxyRecord, shapeProxyRecord };
