// env-edit.js — pure parse leaf for the New Session dialog's env section (T46).
//
// The dialog takes scoped env vars as a KEY=value-per-line textarea; this turns
// that free text into the flat `{ KEY: value }` object create() persists and
// merges (env-scopes.js precedence: process.env < global < workspace < session).
// Kept pure (no fs, no env-scopes require — that module pulls in env-file's fs)
// so it unit-tests standalone; the KEY grammar + deny key are mirrored from
// env-scopes.js on purpose (a one-line duplication buys a fs-free leaf). The box
// re-validates every key server-side regardless, so this is a convenience/echo
// filter, not the security boundary.

// Same grammar as env-scopes.ENV_KEY_RE.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DENY = new Set(['CLODEX_REMOTE_TOKEN', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_ENVIRONMENT_KIND', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST']);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

// Parse KEY=value lines into { env, skipped }. Blank lines and lines whose first
// non-space char is `#` are ignored silently (comments). A line with no `=`, an
// empty/invalid KEY, or the deny key is dropped and reported in `skipped` (with a
// reason) so the caller can surface a hint — never thrown, so a stray line can't
// block Create. Value is everything after the first `=` (so values may contain
// `=`), trimmed of surrounding whitespace on neither side except a trailing CR
// (paste from CRLF); leading/trailing spaces in a value are intentional and kept.
// The KEY is trimmed. Later duplicate keys win (last line wins), matching how a
// shell env file would read.
function parseEnvLines(text) {
  const env = {};
  const skipped = [];
  const lines = String(text == null ? '' : text).split(/\r\n?|\n/u);
  for (const raw of lines) {
    const trimmedLead = raw.replace(/^\s+/, '');
    if (!trimmedLead) continue; // blank
    if (trimmedLead[0] === '#') continue; // comment
    const eq = raw.indexOf('=');
    if (eq < 0) { skipped.push({ line: raw, reason: 'no "=" — expected KEY=value' }); continue; }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    if (!KEY_RE.test(key)) { skipped.push({ line: raw, reason: `invalid env key "${key}"` }); continue; }
    if (DENY.has(key)) { skipped.push({ line: raw, reason: `${key} is reserved` }); continue; }
    if (UNSAFE.has(key)) { skipped.push({ line: raw, reason: `${key} is a reserved name` }); continue; }
    env[key] = value;
  }
  return { env, skipped };
}

// Inverse of parseEnvLines: a flat { KEY: value } map back to KEY=value lines,
// keys in insertion order. The symmetric half of the pair — no live caller yet
// (the dialog only parses; env is not a template field), kept + round-trip-tested
// so a future prefill (edit-session env, template env) has the seam ready.
function formatEnvLines(env) {
  if (!env || typeof env !== 'object') return '';
  return Object.keys(env).map((k) => `${k}=${env[k] == null ? '' : env[k]}`).join('\n');
}

module.exports = { parseEnvLines, formatEnvLines };
