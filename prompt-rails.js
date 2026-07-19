// prompt-rails.js — rail classification for library system prompts
// (docs/teams-design.md "Front door"). Pure leaf: no fs, no electron — the
// caller supplies { name, body } rows; this only parses strings.
//
// THE MODEL. The prompt library mixes RAILS: a full replace-class system prompt
// (the whole prompt) vs an APPEND delta that composes onto the append rail. The
// team join picker attaches its pick to the append rail, so it must offer ONLY
// append-rail prompts — otherwise a replace-class prompt silently blends onto an
// append and corrupts the seat's contract. The guard: a prompt qualifies iff it
// is a stock `clodex-team-*` delta (always append by construction) OR its front
// matter explicitly declares `rail: append`. Undeclared prompts are excluded.

'use strict';

// Parse a leading YAML-ish front-matter block (`---\n…\n---`) for a `rail:`
// value. Returns the lowercased value, or null when there's no front matter or
// no rail key.
function railOf(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => /^\s*rail\s*:/.test(l));
  if (!line) return null;
  return line.replace(/^\s*rail\s*:\s*/, '').trim().toLowerCase() || null;
}

// Stock role prompts that are NOT session-class and so must never appear in the
// join picker: the lead prompt (there is one lead, not a join role) and the
// reviewer prompt (subagent-class). Both qualify by the clodex-team-* stock-name
// rule below, but their derived role keys (lead/reviewer) carry defs that differ
// from a custom session role — addRole would refuse with a raw bounce — so the
// picker excludes them. The join picker offers SESSION-CLASS deltas only.
const NON_SESSION_STOCK = new Set(['clodex-team-lead', 'clodex-team-reviewer']);

// Is this prompt offered by the append-rail picker? Stock clodex-team-* deltas
// qualify (except the non-session-class ones above); any other prompt must
// declare rail: append in its front matter.
function isAppendRail(name, body) {
  if (typeof name === 'string' && NON_SESSION_STOCK.has(name)) return false;
  if (typeof name === 'string' && /^clodex-team-/.test(name)) return true;
  return railOf(body) === 'append';
}

// Filter { name, body } rows to the append-rail picker's offering — returns the
// qualifying names (sorted-in order preserved from the input).
function appendRailPrompts(prompts) {
  return (prompts || [])
    .filter((p) => p && isAppendRail(p.name, p.body))
    .map((p) => p.name);
}

module.exports = { railOf, isAppendRail, appendRailPrompts };
