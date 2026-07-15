// agents-util.js — pure helpers for the clodex custom-subagent library.
//
// clodex stores user-authored subagents as markdown-with-frontmatter files in
// ~/.clodex/agents/*.md (the same on-disk shape as Claude Code's own
// .claude/agents/*.md, so a file is copy-paste portable into a project or
// ~/.claude). At spawn, the enabled subset is transformed into the CLI's
// inline `--agents <json>` flag — a session-only, priority-2 overlay that
// writes nothing to disk and never touches the user's repo or ~/.claude.
//
// Kept dependency-free (no electron, no fs) so it can be unit-tested under
// plain node, mirroring proxy-util.js. The fs-backed library lives in main.js
// and feeds parsed records into buildAgentsArg().

// Parse a leading `---\n ... \n---` frontmatter block. The agent schema only
// needs scalar fields and comma-lists (name/description/tools/model/...), so
// this is a deliberate YAML subset: one `key: value` per line, no nesting,
// no multi-line values. Everything after the closing fence is the body (the
// agent's system prompt). Files without a fence are treated as all-body.
function parseAgentFrontmatter(content) {
  const text = String(content || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[mm[1]] = v;
  }
  return { meta, body: m[2].trim() };
}

const _toList = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

// Transform one parsed agent (frontmatter meta + body) into the object the
// CLI's --agents flag expects. `prompt` is the markdown body, `tools` /
// `disallowedTools` / `skills` become arrays, scalars pass through. Fields
// the CLI doesn't know are simply omitted.
function agentDef(meta, body) {
  meta = meta || {};
  const def = {};
  if (meta.description) def.description = meta.description;
  if (body) def.prompt = String(body);
  if (meta.model) def.model = meta.model;
  if (meta.tools) def.tools = _toList(meta.tools);
  if (meta.disallowedTools) def.disallowedTools = _toList(meta.disallowedTools);
  if (meta.skills) def.skills = _toList(meta.skills);
  if (meta.permissionMode) def.permissionMode = meta.permissionMode;
  if (meta.color) def.color = meta.color;
  if (meta.effort) def.effort = meta.effort;
  if (meta.initialPrompt) def.initialPrompt = meta.initialPrompt;
  if (meta.maxTurns != null && /^\d+$/.test(String(meta.maxTurns).trim())) {
    def.maxTurns = Number(meta.maxTurns);
  }
  return def;
}

// Build the --agents JSON object for a set of enabled agent names against a
// library list ([{ name, meta, body }, ...]). Names no longer on disk are
// skipped silently (a session can outlive a deleted agent). Returns null
// when nothing valid is enabled, so the caller can omit the flag entirely.
function buildAgentsArg(names, library) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const byName = new Map((library || []).map((a) => [a.name, a]));
  const obj = {};
  for (const n of names) {
    const a = byName.get(n);
    if (!a) continue;
    obj[n] = agentDef(a.meta || {}, a.body || '');
  }
  return Object.keys(obj).length ? obj : null;
}

// The built-in subagents the CLI injects into the roster (each costs its
// description line every turn). Denying one via permissions.deny Agent(name)
// filters it out of the injected listing — a real roster trim (traced through
// the listing builder; confirmed on the wire) AND stops delegation to it.
// Names are case-sensitive — exactly the agentType strings, verified present
// across live transcripts. Not every session injects all six (a session
// launched with --agents/append-prompt can drop claude-code-guide/statusline-
// setup), so denying an absent one is a harmless no-op. Shared (main computes
// the enabled roster for the skill-ref check; the renderer checklist offers
// them for denial) — single source, never duplicate.
const BUILTIN_AGENTS = ['Explore', 'Plan', 'general-purpose', 'claude', 'claude-code-guide', 'statusline-setup'];

// permissions.deny rules that suppress built-in subagents. Because --agents is
// ADDITIVE (built-ins stay registered), merely supplying a lean agent does not
// stop the model from falling back to the heavy general-purpose; denying the
// built-ins is what forces the lean choice. The CLI's listing builder filters
// denied agentTypes (Agent(name), case-sensitive) out of the injected roster
// before emitting it, so a deny also reclaims that agent's per-turn description
// tokens — not just an invocation block.
function denyAgentRules(denyBuiltins) {
  if (!Array.isArray(denyBuiltins)) return [];
  return denyBuiltins.filter(Boolean).map((a) => `Agent(${a})`);
}

module.exports = {
  parseAgentFrontmatter, agentDef, buildAgentsArg, denyAgentRules, BUILTIN_AGENTS,
};
