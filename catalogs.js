// catalogs.js — static, stateless constants shared across the store layer and
// the session/IPC code in main.js. No fs, no electron, no state: plain named
// exports. Homed here (rather than in stores.js) because both the stores AND
// main.js reference them, and a constants module keeps the initStores factory
// signature to (userDataPath, {log}) instead of threading them as params.
//
// - CLAUDE_TOOLS / DEFAULT_TOOL_DENY_FLOOR — the tool catalog + shipped deny
//   floor (used by agentDefaults and the tool-gating IPC surface).
// - CLAUDE_SKILLS / SKILL_REENABLE_CONFIRMED — the built-in skill seed + the
//   re-enable empirical gate (used by the skill-gating IPC surface).
// - DEFAULT_WORKSPACE_ID / AGENT_NAME_RE / THEME_KEYS — shared identifiers the
//   stores validate against and main.js reuses.

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

// Shipped default tool-deny floor for NEW sessions (the "*" agent-default seed).
// On 2.1.183 a denied tool's schema is omitted from the wire tools[] (verified
// on live bytes), so a uniform deny set shrinks AND shares the first cache
// segment. This floor is deliberately conservative — only the provably-near-
// universally-unused tools, so override probability (which would re-fragment
// the shared segment) stays ~0: Jupyter-only (NotebookEdit), heavy/niche (LSP),
// Windows-only (PowerShell), onboarding fluff (ShareOnboardingGuide), a connector
// absent from a default session anyway (DesignSync), and Workflow (~5.2k tokens,
// the single biggest reclaim, ~never used in an interactive console). Also:
// TaskOutput (self-described DEPRECATED, ~1.6k ch of "don't call me" shipped
// every request — the redirected paths, Read on the output file + task
// notifications, predate the deprecation, so denying it breaks nothing even
// for orchestration-heavy agents), Artifact (publishes local content to
// claude.ai hosting — egress; deny by default, enable per-session when a
// hosted page is actually wanted), ReportFindings (code-review-host
// plumbing, unused in a console session), and EndConversation (abuse-
// termination affordance with one of the largest always-shipped
// descriptions in the roster; pointless in a managed console where the
// operator kills sessions from the UI), and SendFeedback (~4.7k chars of
// prose + a 27-value enum schema every request, to draft a report that is
// queued locally and needs the operator's approval to go anywhere — the
// operator is right here). Orchestration
// tools (Cron*/other Task*/Monitor/worktrees) are intentionally NOT here — some
// agents genuinely use them, and denying-by-default would force the per-session
// overrides that re-fragment M1. The default is an editable FLOOR, not a ceiling;
// specialized sessions add to it. Not perfect on purpose — adjust via the
// settings panel.
const DEFAULT_TOOL_DENY_FLOOR = [
  'NotebookEdit', 'LSP', 'PowerShell', 'ShareOnboardingGuide', 'DesignSync', 'Workflow',
  'TaskOutput', 'Artifact', 'ReportFindings', 'EndConversation', 'SendFeedback',
];

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
  // Review & analysis
  'code-review', 'security-review', 'review', 'deep-research', 'verify',
  // Codebase setup & config
  'init', 'update-config', 'simplify',
  // Execution & control flow
  'run', 'loop', 'schedule',
  // API & help
  'claude-api', 'keybindings-help', 'fewer-permission-prompts',
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

const DEFAULT_WORKSPACE_ID = 'default';
const AGENT_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/; // mirrors session name rule
const THEME_KEYS = ['midnight', 'claude', 'paper', 'light'];

module.exports = {
  CLAUDE_TOOLS, DEFAULT_TOOL_DENY_FLOOR, CLAUDE_SKILLS, SKILL_REENABLE_CONFIRMED,
  DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, THEME_KEYS,
};
