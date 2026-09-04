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

// Tool/skill/agent/intent gating is Claude-only. Plugins is NOT, and must stay
// shared: a codex seat's `plugins` list gates its grammar and its verbs, so
// moving the entry here would leave that seat with no editor for it.
const CLAUDE_ONLY_ENTRIES = [
  { act: 'tools', label: '🛠 Tools…' },
  { act: 'skills', label: '🧩 Skills…' },
  { act: 'agents', label: '🤖 Agents…' },
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
  if (type === 'claude') return [...CLAUDE_ONLY_ENTRIES, ...SHARED_ENTRIES];
  if (type === 'codex') return [...SHARED_ENTRIES];
  return [];
}

module.exports = { sessionMenuEntries };
