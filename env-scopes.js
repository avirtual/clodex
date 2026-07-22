// env-scopes.js — merge the GUI-managed environment scopes over the engine's
// base process env for a wrapper PTY. Pure fs/path (reuses env-file.js for the
// node-local override file); NO electron, NO main.js state — so it unit-tests
// under plain node and session-manager stays electron-free (it receives the
// scope data through its existing store DI seams).
//
// CANONICAL PRECEDENCE (single source — documented here on purpose):
//
//     process.env  <  global  <  workspace  <  session  <  node-local override
//
// - process.env       the engine's base env (already post-
//                     scrubInheritedClaudeMarkers at startup — main.js:54 /
//                     headless-main.js:103). We do NOT re-scrub: a scope-set
//                     CLAUDE_* value is deliberate operator config and must
//                     survive, only the INHERITED base is scrubbed.
// - global            GUI-managed, applies to every wrapper PTY on this node.
// - workspace         keyed by workspaceId, applies to that workspace's sessions.
// - session           per-spawn, rides create()'s env param (+ the wire + the CLI)
//                     and persists on the sessions.json entry so --resume respawns
//                     with the same env.
// - node-local override  <userData>/env-override.env (env-file.js format), applied
//                     LAST — read at spawn, no GUI/watcher. Rationale: on a
//                     deployed node the box operator's local file beats anything a
//                     remote viewer pushes over the wire; the box owner has final
//                     say. This is the "remote drop-in" slot in the chain.
//
// App-owned keys (TERM, WB_WRAP_NAME for codex, …) are applied by the caller
// AFTER this merge so they always win — they are NOT this module's concern.
//
// KEY RULES (enforced on every write surface — GUI, wire, CLI — and re-enforced
// here defensively): a key matches [A-Za-z_][A-Za-z0-9_]* ; a value is an opaque
// string with NO newline (env-file.js can't carry one, and a truncated
// credential is worse than a rejection — reject, never truncate). DENY_KEYS may
// not be set in ANY scope (the wire gate must not be clobberable through the
// surface it gates).

const { readEnvFile } = require('./env-file');

// A key that may never be set through any env scope. CLODEX_REMOTE_TOKEN gates
// the wire; letting a scope override it would let the gated surface rewrite its
// own gate. Overriding CLAUDE_CODE_OAUTH_TOKEN et al. is a FEATURE (per-session
// identity), so the deny-list is deliberately just this one key.
const DENY_KEYS = new Set(['CLODEX_REMOTE_TOKEN']);

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Is (key, value) a legal env var to set through a scope? Returns null when OK,
// else a short human reason. Shared by the store/IPC/wire/CLI write paths so the
// rejection message reads the same everywhere.
function envKeyError(key, value) {
  if (typeof key !== 'string' || !ENV_KEY_RE.test(key)) {
    return `invalid env key "${key}" — must match [A-Za-z_][A-Za-z0-9_]*`;
  }
  if (DENY_KEYS.has(key)) {
    return `env key "${key}" is not allowed (reserved)`;
  }
  if (value != null && /[\n\r]/.test(String(value))) {
    return `env value for "${key}" contains a newline — not allowed`;
  }
  return null;
}

// Flatten a stored scope object ({ KEY: { value, secret } }) into a plain
// { KEY: value } map, DROPPING any key that fails validation (deny-listed,
// malformed, or a newline value) — a merge input is never a validation surface,
// so junk from a hand-edited store can't reach a PTY. A null/non-object scope
// yields {}. Entries whose value is null/undefined are dropped (unset).
function flattenScope(scope) {
  const out = {};
  if (!scope || typeof scope !== 'object') return out;
  for (const [key, rec] of Object.entries(scope)) {
    const value = rec && typeof rec === 'object' ? rec.value : rec;
    if (value == null) continue;
    if (envKeyError(key, value)) continue;
    out[key] = String(value);
  }
  return out;
}

// Sanitize a flat { KEY: value } map (the session-scope shape carried by
// create()/wire/CLI) into a validated { KEY: value }, dropping invalid/denied/
// newline entries. Same defensive stance as flattenScope for the flat shape.
function sanitizeFlat(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [key, value] of Object.entries(map)) {
    if (value == null) continue;
    if (envKeyError(key, value)) continue;
    out[key] = String(value);
  }
  return out;
}

// Merge the scopes over the base per the canonical precedence and return a plain
// object suitable as a PTY env. Every scope input is flattened+validated first,
// so no malformed/denied key can survive into the result. With empty global/
// workspace/session and an absent/empty override file, the result is exactly
// `{ ...base }` — the no-scopes identity the caller relies on to keep today's
// `{ ...process.env }` byte-identical.
//
//   base         plain env object (process.env)
//   global       stored scope object ({ KEY: { value, secret } }) or a flat map
//   workspace    stored scope object or a flat map
//   session      flat { KEY: value } map or null
//   overrideFile path to the node-local env-override.env (read via readEnvFile),
//                or null/absent to skip. A missing file reads as {}.
function mergeSessionEnv({ base = {}, global = null, workspace = null, session = null, overrideFile = null } = {}) {
  const merged = { ...base };
  Object.assign(merged, flattenScope(global));
  Object.assign(merged, flattenScope(workspace));
  Object.assign(merged, sanitizeFlat(session));
  if (overrideFile) {
    // The override file's keys are still gated (it's a write surface too — a
    // local drop-in could carry CLODEX_REMOTE_TOKEN); sanitizeFlat drops any.
    Object.assign(merged, sanitizeFlat(readEnvFile(overrideFile)));
  }
  return merged;
}

module.exports = {
  DENY_KEYS,
  ENV_KEY_RE,
  envKeyError,
  flattenScope,
  sanitizeFlat,
  mergeSessionEnv,
};
