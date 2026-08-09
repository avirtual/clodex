'use strict';

// Route extraction for the per-agent proxy paths. Seeded from clodex2
// lib/route.js (itself a port of agent-workbench/components/proxy/proxy.py).
//
// Agent name charset matches clodex session names ([a-zA-Z0-9._-], max 64, not
// a bare run of dots) so names embed cleanly in URL paths and intent fields
// without escaping. This literal is a MIRROR of catalogs.js's AGENT_NAME_RE —
// the gate that mints the names this router has to carry — re-expressed as a
// path prefix rather than imported, because `wire/` runs on the far side of a
// process boundary and takes no dependency on the app's catalog module.
// `test/agent-name-seam.test.js` runs one name corpus through both and fails if
// they ever disagree again.
//
// The port from clodex2/agent-workbench additionally demanded an alphanumeric
// first character, which clodex's own rule never had. The two halves were
// pinned in different files and nothing held the pair, so `_scratch`, `.hidden`
// and `-dash` were creatable, got a wire base URL from session-manager.js:952,
// looked healthy, and 400'd every request — that agent never reached Anthropic,
// silently and totally (F004). The creation gate is the documented rule
// (CLAUDE.md; the shared grammar behind ~16 name gates and peering/
// clodex-seed.sh, deliberately admitting a leading dot per t115), so the router
// is what moved.
//
// The dot-only guard is anchored to the SEGMENT, not the string: `/agent/..`
// and `/agent/../x` must both stay unroutable, while `..a` and `.hidden` — legal
// names — must not be caught by it.

const AGENT_RE = /^\/agent\/(?!\.+(?:\/|$))([a-zA-Z0-9._-]{1,64})(\/.*)?$/;
const PROVIDERS = new Set(['anthropic', 'openai']);

// `/agent/<name>[/...]` → { agent, rest } or null. Agent name is mandatory
// so every observed turn carries an identity.
function parseAgentPath(pathname) {
  const m = AGENT_RE.exec(pathname);
  if (!m) return null;
  return { agent: m[1], rest: m[2] || '/' };
}

// Provider selection priority: explicit segment > path suffix > anthropic.
//   /anthropic/v1/...          → anthropic, /v1/...
//   /openai/v1/...             → openai, /v1/...
//   /v1/chat/completions       → openai (suffix inference)
//   /v1/responses              → openai (suffix inference)
//   anything else              → anthropic (default)
function inferProvider(rest) {
  const tail = rest.startsWith('/') ? rest.slice(1) : rest;
  const slash = tail.indexOf('/');
  const head = slash === -1 ? tail : tail.slice(0, slash);
  if (PROVIDERS.has(head)) {
    const after = slash === -1 ? '' : tail.slice(slash + 1);
    return { provider: head, upstreamPath: after ? '/' + after : '/' };
  }
  if (
    rest === '/v1/chat/completions' || rest === '/v1/responses' ||
    rest.startsWith('/v1/chat/completions/') || rest.startsWith('/v1/responses/')
  ) {
    return { provider: 'openai', upstreamPath: rest };
  }
  return { provider: 'anthropic', upstreamPath: rest };
}

module.exports = { parseAgentPath, inferProvider, PROVIDERS };
