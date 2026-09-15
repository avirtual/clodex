// catalogs.js — static, stateless constants shared across the store layer and
// the session/IPC code in main.js. No fs, no electron, no state: plain named
// exports. Homed here (rather than in stores.js) because both the stores AND
// main.js reference them, and a constants module keeps the initStores factory
// signature to (userDataPath, {log}) instead of threading them as params.
//
// - CLAUDE_TOOLS / OPTIMIZED_TOOLS / DEFAULT_TOOL_DENY_FLOOR — the tool catalog,
//   the curated keep-set, and the deny floor derived from the two (used by
//   agentDefaults and the tool-gating IPC surface).
// - CLAUDE_SKILLS / OPTIMIZED_SKILLS / DEFAULT_SKILL_DENY_FLOOR /
//   SKILL_REENABLE_CONFIRMED — the built-in skill seed, its curated keep-set and
//   derived floor, plus the re-enable empirical gate (used by the skill-gating
//   IPC surface).
// - DEFAULT_WORKSPACE_ID / AGENT_NAME_RE / THEME_KEYS — shared identifiers the
//   stores validate against and main.js reuses.

const { deferredSkillDeny } = require('./skills-off');

// Per-session tool gating (Claude-only). The known built-in tool catalog —
// the universe a user picks from when deciding what to disable. This is the
// standalone source of truth: clodex must work without wirescope, so the list
// is maintained here (mirrors Claude Code's tools-reference). When a wirescope
// proxy IS integrated, /_context can enrich this with the session's actually-
// loaded roster + per-tool token costs (and surface session-specific MCP /
// connector tools, e.g. DesignSync, which aren't built-ins and can't live in a
// static list) — but that's optional, never required.
//
// Unchecking a tool adds its name to the session's `disabledTools`, rendered
// into settings.permissions.deny at spawn. Denylist semantics: empty = all
// available, and a future built-in we haven't listed is never accidentally
// excluded. Any tool can also be denied by hand via --disallowedTools in
// Extra CLI args. Ordered by category for the checklist.
const CLAUDE_TOOLS = [
  // Filesystem & code
  'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'LSP',
  // Shell
  'Bash', 'PowerShell', 'Monitor',
  // Web
  'WebFetch', 'WebSearch',
  // Subagents & teams
  'Agent', 'SendMessage', 'ListAgents',
  // Skills & workflows
  'Skill', 'Workflow',
  // Plan mode & worktrees
  'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  // Task list
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'TaskOutput', 'TodoWrite',
  // Scheduling
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup',
  // Notifications, remote & prompts
  'PushNotification', 'RemoteTrigger', 'ShareOnboardingGuide', 'AskUserQuestion',
  // Conversation control
  'EndConversation', 'SendFeedback',
  // Publishing & review (Artifact uploads local content to claude.ai hosting)
  'Artifact', 'ReportFindings',
  // MCP plumbing
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'WaitForMcpServers',
  // Connectors
  'DesignSync',
];

const OPTIMIZED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash',
  'WebFetch', 'WebSearch', 'Agent', 'SendMessage', 'Skill',
];

const DEFAULT_TOOL_DENY_FLOOR = CLAUDE_TOOLS.filter((t) => !OPTIMIZED_TOOLS.includes(t));

// Known CLI-shipped built-in skills. Unlike tools, skills are normally
// DISCOVERED from the transcript (skill_listing attachments) — but a skill
// disabled in another settings source (e.g. a hand-written $cwd/.claude/
// settings.json `skillOverrides`) never reaches the injected roster, so the
// transcript can't surface it. This static seed makes those known built-ins
// visible + toggleable in the popover regardless. Unioned with the live
// roster (which also catches plugin/cortex skills like warm-cache that aren't
// listed here). Same authority model as CLAUDE_TOOLS: clodex tracks only the
// skills IT disabled — one off via a manual settings.json still renders
// checked here (clodex can't see the other source, and only ever writes
// "off" overrides, never "on", so it can't re-enable it).
const CLAUDE_SKILLS = [
  'code-review', 'security-review', 'review', 'deep-research', 'verify',
  'init', 'update-config', 'simplify',
  'run', 'loop', 'schedule',
  'claude-api', 'keybindings-help', 'fewer-permission-prompts',
  'design', 'dataviz', 'artifact-design', 'artifact-diagramming', 'artifact-capabilities',
];

// Empirical gate (Q2): whether our layer-4 `--settings` `skillOverrides:{x:"on"}`
// actually overrides a LOWER-layer "off" in the shipping CLI and re-enables the
// skill. The whole-settings merge is per-key later-wins, but this specific key's
// consumer is closed-source and unverified (a community reimpl has no consumer
// for it at all), so until a live flip-test confirms it we treat a lower-layer-
// off skill as un-re-enableable — rendered disabled with provenance, NEVER a
// silent no-op. Flip to true once the flip-test passes; that also unlocks the
// "on" write path. Q1 (layer-4 "off" removes a loaded skill) needs no gate — it
// is the same mechanism the popover already ships.
const SKILL_REENABLE_CONFIRMED = false;

const OPTIMIZED_SKILLS = [
  'code-review', 'security-review', 'review', 'verify', 'simplify', 'claude-api',
  'dataviz', 'artifact-diagramming',
];

const DEFAULT_SKILL_DENY_FLOOR = deferredSkillDeny(OPTIMIZED_SKILLS);

const DEFAULT_BUILTIN_DENY_FLOOR = ['Plan', 'claude', 'claude-code-guide', 'statusline-setup'];

const DEFAULT_WORKSPACE_ID = 'default';
const AGENT_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/; // mirrors session name rule
const THEME_KEYS = ['midnight', 'claude', 'paper', 'light'];

module.exports = {
  CLAUDE_TOOLS, OPTIMIZED_TOOLS, DEFAULT_TOOL_DENY_FLOOR,
  CLAUDE_SKILLS, OPTIMIZED_SKILLS, DEFAULT_SKILL_DENY_FLOOR, SKILL_REENABLE_CONFIRMED,
  DEFAULT_BUILTIN_DENY_FLOOR,
  DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, THEME_KEYS,
};
