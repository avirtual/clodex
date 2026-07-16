// session-actions.js — the pure decision for the consolidated session-actions
// menu (the `⚙ session ▾` button on the proxy bar). Which launcher entries a
// session offers depends ONLY on its type, so that mapping lives here as a pure,
// testable leaf rather than inline in the menu-DOM island — the same split as
// intent-catalog vs the checklist popover.
//
// The proxy bar reserves its scarce width for DYNAMIC state (📄 files count, the
// keep-warm control, context/cost segments); these static, seldom-clicked
// launchers collapse behind one button whose menu is built from this list.
// `act` matches the dispatch keys renderSessionActions already routes
// (tools/skills/agents/intents/edit/history/reload) so the menu reuses the exact
// opener wiring the standalone buttons used.

// Claude exposes the full config surface (tool/skill/agent/intent gating) plus
// the conversation actions; Codex has no per-session gating popovers, so it gets
// only edit/history/reload — the same conditional the old button row encoded.
const CLAUDE_ONLY_ENTRIES = [
  { act: 'tools', label: '🛠 Tools…' },
  { act: 'skills', label: '🧩 Skills…' },
  { act: 'agents', label: '🤖 Agents…' },
  { act: 'intents', label: '🔒 Intents…' },
];
const SHARED_ENTRIES = [
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
