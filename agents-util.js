// agents-util.js — pure helpers for the clodex custom-subagent library.
//
// clodex stores user-authored subagents as markdown-with-frontmatter files in
// ~/.clodex/agents/*.md (the same on-disk shape as Claude Code's own
// .claude/agents/*.md, so a file is copy-paste portable into a project or
// ~/.claude). At spawn, the enabled subset is scaffolded into a session-only
// Claude Code *plugin* directory and injected via a second `--plugin-dir`,
// alongside the skills plugin — writing nothing into the user's repo.
//
// This replaced an inline `--agents <json>` flag (t403), at two costs: the CLI
// namespaces plugin agents `<manifest.name>:<agent>` with NO bare-name alias,
// and reads a narrower field set than the flag did — see qualifiedAgentName
// and PLUGIN_AGENT_FIELDS.
//
// Kept dependency-free (no electron, no fs) so it can be unit-tested under
// plain node, mirroring proxy-util.js. The fs-backed library lives in main.js
// and feeds parsed records into buildAgentPlugin().

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

// NOT the skills plugin's `clodex-skills`, and not an agents/ sibling inside
// it: that scaffolder returns null (skipping the whole dir) when no skill is
// enabled, dropping the agents of a session that enables agents and no skills.
const AGENT_PLUGIN_NAME = 'clodex-agents';

// The only name a library agent answers to as `subagent_type` — the loader
// namespaces every plugin agent and registers no bare-name alias.
const qualifiedAgentName = (name) => `${AGENT_PLUGIN_NAME}:${name}`;

// The frontmatter keys the PLUGIN agent loader reads, verified against the
// installed 2.1.232 binary. Anything else is dropped rather than emitted: the
// loader warns per spawn on three of the four below and ignores the fourth.
const PLUGIN_AGENT_FIELDS = [
  'description', 'when_to_use', 'tools', 'disallowedTools', 'skills',
  'model', 'color', 'effort', 'maxTurns', 'background', 'memory', 'isolation',
];

// What the flag-era encoder mapped and the plugin loader does not. The spawn
// warns on these: silent, an operator keeps believing a permissionMode they
// authored is in force.
const DROPPED_AGENT_FIELDS = ['permissionMode', 'initialPrompt', 'hooks', 'mcpServers'];

// Render one library agent as the file the plugin loader parses. The loader
// prefers a frontmatter `name:` over the file stem, so the canonical name is
// forced here (any authored one dropped), exactly as skillMd does — otherwise
// the library and dispatch names drift. Values are double-quoted via
// JSON.stringify: the CLI parses this as real YAML, where an unquoted `:` or
// `#` re-parses as a map or truncates, silently un-discovering the agent.
function agentMd(name, meta, body) {
  meta = meta || {};
  const lines = [`name: ${JSON.stringify(String(name))}`];
  for (const k of PLUGIN_AGENT_FIELDS) {
    const v = meta[k];
    if (v == null || v === '') continue;
    lines.push(`${k}: ${JSON.stringify(String(v))}`);
  }
  return `---\n${lines.join('\n')}\n---\n${String(body || '').trim()}\n`;
}

// Build the plugin scaffold for enabled agent names against a library list
// ([{ name, meta, body }, ...]), or null when nothing valid is enabled. Names
// no longer on disk are skipped silently (a session can outlive a deleted
// agent). The manifest name MUST differ from the skills plugin's: two
// --plugin-dir entries sharing one both load and collide, last wins, silently.
function buildAgentPlugin(names, library, pluginName = AGENT_PLUGIN_NAME) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const byName = new Map((library || []).map((a) => [a.name, a]));
  const agents = [];
  for (const n of names) {
    const a = byName.get(n);
    if (!a) continue;
    agents.push({ name: n, md: agentMd(n, a.meta || {}, a.body || '') });
  }
  if (!agents.length) return null;
  const manifest = {
    name: pluginName,
    version: '0.0.0',
    description: 'clodex session-injected subagents',
    author: { name: 'clodex' },
  };
  return { manifest, agents };
}

// The built-in subagents the CLI injects into the roster (each costs its
// description line every turn). Denying one via permissions.deny Agent(name)
// filters it out of the injected listing — a real roster trim (traced through
// the listing builder; confirmed on the wire) AND stops delegation to it.
// Names are case-sensitive — exactly the agentType strings, verified present
// across live transcripts. Not every session injects all six (one launched with
// an agent overlay / append-prompt can drop claude-code-guide/statusline-setup),
// so denying an absent one is a harmless no-op. Shared (main computes the
// enabled roster for the skill-ref check; the renderer checklist offers them
// for denial) — single source, never duplicate.
const BUILTIN_AGENTS = ['Explore', 'Plan', 'general-purpose', 'claude', 'claude-code-guide', 'statusline-setup'];

// permissions.deny rules that suppress built-in subagents. Because the agent
// overlay is ADDITIVE (built-ins stay registered), supplying a lean agent does
// not stop the model falling back to the heavy general-purpose; denying the
// built-ins is what forces the lean choice. The CLI's listing builder filters
// denied agentTypes (Agent(name), case-sensitive) out of the injected roster
// before emitting it, so a deny also reclaims that agent's per-turn description
// tokens — not just an invocation block.
function denyAgentRules(denyBuiltins) {
  if (!Array.isArray(denyBuiltins)) return [];
  return denyBuiltins.filter(Boolean).map((a) => `Agent(${a})`);
}

module.exports = {
  parseAgentFrontmatter, agentMd, buildAgentPlugin, qualifiedAgentName,
  denyAgentRules, BUILTIN_AGENTS, AGENT_PLUGIN_NAME,
  PLUGIN_AGENT_FIELDS, DROPPED_AGENT_FIELDS,
};
