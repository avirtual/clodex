// session-actions.js — the pure decision for the consolidated session-actions
// menu (the `⚙ session ▾` button on the proxy bar). Which launcher entries a
// session offers depends ONLY on its type, so that mapping lives here as a pure,
// testable leaf rather than inline in the menu-DOM island — the same split as
// intent-catalog vs the checklist popover.
//
// The proxy bar reserves its scarce width for DYNAMIC state (📄 files count, the
// keep-warm control, context/cost segments); these static, seldom-clicked
// launchers collapse behind one button whose menu is built from this list.
// `act` matches the dispatch keys routeSessionAction already routes
// (tools/skills/agents/intents/plugins/edit/history/reload) so the menu reuses
// the exact opener wiring the standalone buttons used.

const { capsFor } = require('./provider-caps');

// Tool and agent gating is Claude-only. Intents, plugins and skills are NOT:
// a codex seat carries all three, so pinning one to claude leaves that seat with
// no editor for something it was configured with and still honours.
const TOOLS_ENTRY = { act: 'tools', label: '🛠 Tools…' };
const AGENTS_ENTRY = { act: 'agents', label: '🤖 Agents…' };
const SKILLS_ENTRY = { act: 'skills', label: '🧩 Skills…' };
const AGENT_ENTRIES = [
  { act: 'intents', label: '🔒 Intents…' },
];
const SHARED_ENTRIES = [
  { act: 'plugins', label: '🔌 Plugins…' },
  { act: 'edit', label: '⚙ Edit Settings…' },
  { act: 'history', label: '🕘 History…' },
  { act: 'reload', label: '🔄 Reload (fresh restart)' },
];

// Ordered menu entries for a session of `type`. Empty for anything that isn't a
// managed agent session (e.g. bash, or a null/absent active session) — the caller
// then renders no consolidated button at all.
function sessionMenuEntries(type) {
  const caps = capsFor(type);
  const skills = (caps.injectSkills || caps.skillRoster) ? [SKILLS_ENTRY] : [];
  if (type === 'claude') return [TOOLS_ENTRY, ...skills, AGENTS_ENTRY, ...AGENT_ENTRIES, ...SHARED_ENTRIES];
  if (type === 'codex') return [...AGENT_ENTRIES, ...skills, ...SHARED_ENTRIES];
  return [];
}

module.exports = { sessionMenuEntries };
