// intent-registry.js — the intent GRAMMAR table (plugin plan §2.3, R-INT-1).
// One ordered list of rows, each owning a verb's parse function and its
// body-capture mode, so the three consumers that used to hard-code the verb set
// (the regex chain in intent-scanner.parseIntent, the per-(type,sub) allow-set
// in session-manager._extractIntents, the routing switch in _handleIntent) read
// ONE table instead of three parallel lists that could drift apart.
//
// Pure leaf: no electron, no main.js state, no IO. The only requires are the
// other pure leaf (intent-catalog) — so this is unit-tested in isolation and
// leak-scanned like every other extraction.
//
// THREE LAWS this table enforces by construction:
//
//  1. CORE ROWS REPRODUCE TODAY'S BYTES. The parse functions below are the
//     regex chain moved out of intent-scanner.js verbatim, IN THE SAME ORDER —
//     order is load-bearing (`[agent:team-review]` must be tried before
//     `[agent:team …]` would ever see it, and the closed sub-verb alternations
//     depend on falling through to null). test/intent-registry.test.js pins the
//     walk against a frozen copy of the legacy chain over a full corpus.
//
//  2. BODY CAPTURE IS A PREDICATE OVER THE PARSED INTENT, never a type-level
//     flag (plugin plan MUST-FIX 7). `task add` captures a body and `task
//     assign` must not; a per-type boolean cannot express that, and the version
//     that tried silently swallowed the prose after an assign.
//
//  3. PLUGIN VERBS ARE FORCED PRIVILEGED (rule P1). The registry overwrites any
//     `privileged` a caller passes. Everything else follows from semantics that
//     already shipped: an absent allowlist means DISABLED for a privileged verb
//     [intent-catalog.intentEnabled], `withoutPrivilegedIntents` strips it at
//     the spawn-template and peer-wire boundaries for free, and
//     `deniedIntentCount` skips it so no seat grows a phantom lock chip.
//
// NOT here, on purpose:
//   * `escape` and `end` — the scanner shell owns both (they are structural, not
//     verbs: escape is a quote and end is a body terminator that never
//     dispatches). Keeping them out of the table keeps them un-gateable and
//     un-shadowable by a plugin.
//   * `label` / `promptLines` for CORE rows — see the ownership note on
//     `catalogRows` below. Two orderings, two owners; this table is a third
//     consumer, not a third copy.

const {
  GATEABLE_INTENTS,
  PRIVILEGED_INTENTS,
  intentEnabled,
  intentsAllowlistFromChecked,
} = require('./intent-catalog');

// ---------------------------------------------------------------------------
// Core rows — the regex chain, moved from intent-scanner.parseIntent.
// Each `parse` takes the CLEANED, TRIMMED line (the scanner shell owns
// cleanLine/trim and the escape check) and returns an intent object or null.
// ---------------------------------------------------------------------------

// Optional `urgent` flag bypasses the idle/cold-cache dm hold (see
// shouldHoldDm). Old grammar `[agent:dm target]` is untouched — the flag
// only matches as a separate word before the bracket.
function parseDm(cleaned) {
  const m = cleaned.match(/^\[agent:dm\s+(\S+?)(\s+urgent)?\]\s*(.*)/s);
  return m ? { type: 'dm', target: m[1], urgent: !!m[2], body: m[3] } : null;
}

// Escalate a parked-on-hold dm: deliver the parked COPY now, without the
// sender re-emitting the body. Protocol-invisible (not in IPC_PROMPT) — the
// id only exists once a park happens, and the park notice hands the sender the
// exact `[agent:resend <id>]` incantation. Id is the short base36 handle minted
// at park time (see _mintParkId).
function parseResend(cleaned) {
  const m = cleaned.match(/^\[agent:resend\s+([a-z0-9]+)\]\s*$/i);
  return m ? { type: 'resend', id: m[1].toLowerCase() } : null;
}

function parseWho(cleaned) {
  return /^\[agent:who\]\s*$/.test(cleaned) ? { type: 'who' } : null;
}

function parseName(cleaned) {
  return /^\[agent:name\]\s*$/.test(cleaned) ? { type: 'name' } : null;
}

// Grouped-grammar self/system intents (spec §12): one top-level verb per
// CATEGORY, dispatched on a sub-command — keeps the namespace small and the
// IPC_PROMPT lean (one documented line per category, not per operation).
// `context` = the context-lifecycle set (compact|clear|reload). compact (and,
// later, reload) may carry an OPTIONAL continuation/handoff body after the
// bracket — native /compact parks waiting for input, so a self-fired compact
// injects this body afterwards to keep working (clear ignores any body). The
// col-1 `^` anchor still rejects backticked/inline mentions; only a genuinely
// bare emission reaches here, so allowing trailing text doesn't weaken the
// guardrail. Body capture (incl. multi-line) is the row's bodyMode, like dm.
function parseContext(cleaned) {
  const m = cleaned.match(/^\[agent:context\s+(\S+)\]\s*(.*)/s);
  return m ? { type: 'context', sub: m[1].toLowerCase(), body: m[2] } : null;
}

// `memory` = the memory-management set (list|remember|recall). Carries a body
// (the unit text for remember; the id/query for recall; empty for list) —
// captured like dm, including multi-line bodies.
function parseMemory(cleaned) {
  const m = cleaned.match(/^\[agent:memory\s+(\S+)\]\s*(.*)/s);
  return m ? { type: 'memory', sub: m[1].toLowerCase(), body: m[2] } : null;
}

// `file` = surface a file on the operator's SCREEN (view = Clodex's peek
// modal over the session's workspace window, open = the default local app
// via shell.openPath). Path may contain spaces — everything between the
// sub-command and the closing bracket. Vetting (cwd-anchored realpath,
// regular-file, no-launchables for open) lives in vetFileIntent; the
// registry only parses.
function parseFile(cleaned) {
  const m = cleaned.match(/^\[agent:file\s+(\S+)\s+(.+?)\]\s*$/);
  return m ? { type: 'file', sub: m[1].toLowerCase(), path: m[2].trim() } : null;
}

// `exec` = fire-and-forget invocation of an OPERATOR-REGISTERED command by id
// (registry lives at ~/.clodex/library/exec/<cmd>.json; agents cannot register
// one). `cmd` names the command; the body is the JSON DATA payload, captured
// to the next col-1 intent — bodyMode 'json', so the capture terminates at the
// complete JSON value instead of swallowing following prose. The payload is
// DATA only: it reaches the command via stdin, NEVER spliced into argv — argv
// comes wholly from the registry entry, so the shell-injection class is gone by
// construction. Registered-only; there is no arbitrary-shell variant.
function parseExec(cleaned) {
  const m = cleaned.match(/^\[agent:exec\s+(\S+)\]\s*(.*)/s);
  return m ? { type: 'exec', cmd: m[1], body: m[2] } : null;
}

// `remind` = schedule a SELF-reminder (see remind-schedule.js for the spec
// grammar: every|in|at|cron|on compact|list|cancel). Unlike every other
// intent the SPEC spans a space (`every 30m`, `on compact`, `at 09:00`), so
// it's captured as everything up to the closing bracket ([^\]]+, not \S+);
// the reminder text is the body, captured greedily like dm. Parse/validation of
// the spec lives in remind-schedule.parseRemindSpec, invoked by the handler.
function parseRemind(cleaned) {
  const m = cleaned.match(/^\[agent:remind\s+([^\]]+)\]\s*(.*)/s);
  return m ? { type: 'remind', spec: m[1].trim(), body: m[2] } : null;
}

// `notify-user` = raise a note into the operator's persistent inbox to get
// Bogdan's attention when the agent is blocked on his decision. No
// sub-command, no target — the whole thing is a free-text body, captured
// greedily like dm. The empty-body bounce + 16KB cap live in the handler.
function parseNotifyUser(cleaned) {
  const m = cleaned.match(/^\[agent:notify-user\]\s*(.*)/s);
  return m ? { type: 'notify-user', body: m[1] } : null;
}

// `team-review` / `review-done` = the ephemeral cold-review handshake (Task
// 24). A team LEAD writes ONLY the review scope (`[agent:team-review] <scope>`)
// and clodex owns the machinery (spawn an ephemeral reviewer seat, brief it,
// inject the scope); the reviewer ends its pass with `[agent:review-done]
// <verdict>`, which clodex routes back to the lead and then retires the seat.
// Both carry a free-text body captured greedily like dm. Sender-role guards
// (lead-only / reviewer-only) + the spawn/retire lifecycle live in the handler.
// ORDER NOTE: both must precede the `team` row — `[agent:team-review]` would
// never reach this row if `team`'s alternation ran first.
function parseTeamReview(cleaned) {
  const m = cleaned.match(/^\[agent:team-review\]\s*(.*)/s);
  return m ? { type: 'team-review', body: m[1] } : null;
}

function parseReviewDone(cleaned) {
  const m = cleaned.match(/^\[agent:review-done\]\s*(.*)/s);
  return m ? { type: 'review-done', body: m[1] } : null;
}

// `reboot` = operator-gated full app relaunch (Task 27). Bodyless-or-body like
// notify-user: the optional body is a free-text REASON (logged only). The
// handler owns the allowlist + rate-limit gates; the registry just parses.
// bodyMode 'none' — the reason is a single line, so a following line stays its
// own intent (like who/name/file).
function parseReboot(cleaned) {
  const m = cleaned.match(/^\[agent:reboot\]\s*(.*)/s);
  return m ? { type: 'reboot', body: m[1] } : null;
}

// `task` = the team ticket protocol (Task 25). Six sub-verbs; a team LEAD opens
// and directs tickets, an ASSIGNEE closes them, and clodex owns the registry +
// lifecycle + stall watchdog. The sub-verb alternation is CLOSED (only the six):
// a typo like `[agent:task foo]` falls through to null → the near-miss bounce,
// exactly like a bad dm. Bracket-arg shapes per verb:
//   add            → optional <role|name> in the bracket (the mint+assign common
//                    case), plus the spec text as a free-text BODY (greedy like dm).
//   assign <id> <role|name> → no body (the spec lives on the ticket).
//   done   <id>    → report text BODY. reject <id> → reason BODY.
//   cancel <id>    → optional reason BODY. list → no args, no body.
// Body capture for add/done/reject/cancel is this row's bodyMode (like dm);
// assign/list deliberately carry no body. All guards + lifecycle live in the
// handler, not here.
function parseTask(cleaned) {
  const m = cleaned.match(/^\[agent:task\s+(add|assign|done|reject|cancel|list)\b([^\]]*)\]\s*(.*)/s);
  if (!m) return null;
  const sub = m[1];
  const argToks = m[2].trim().split(/\s+/).filter(Boolean);
  const body = m[3];
  if (sub === 'add') return { type: 'task', sub, who: argToks[0] || null, id: null, body };
  if (sub === 'assign') return { type: 'task', sub, id: argToks[0] || null, who: argToks[1] || null, body: '' };
  if (sub === 'list') return { type: 'task', sub, id: null, who: null, body: '' };
  // done / reject / cancel — a single <id> arg + a free-text body.
  return { type: 'task', sub, id: argToks[0] || null, who: null, body };
}

// `team` = team metadata mutation (T29 Layer A). Five sub-verbs; a team LEAD
// edits the role map + the stall watchdog (the lead-gate lives in the handler).
// CLOSED alternation (only the five): a typo like `[agent:team foo]` falls
// through to null → the near-miss bounce, exactly like a bad task/dm. Bracket
// shapes per verb, modeled on the `task` family + spawn's `key:val` tokens:
//   role-add <name>    → the brief as a free-text BODY (greedy like dm); prompt/
//                        template as key:val tokens in the bracket (like spawn:).
//   role-set <name>    → same shape (edit an existing role's descriptive fields).
//   role-rm   <name>   → no body.
//   role-rename <from> <to> → no body.
//   watchdog <ms>      → no body.
// Body capture for role-add/role-set is this row's bodyMode; the other three
// carry no body (like task assign/list). Guards + the mutators live in the
// handler, not here.
function parseTeam(cleaned) {
  const m = cleaned.match(/^\[agent:team\s+(role-add|role-set|role-rm|role-rename|watchdog)\b([^\]]*)\]\s*(.*)/s);
  if (!m) return null;
  const sub = m[1];
  const argStr = m[2];
  const body = m[3];
  // key:val tokens (prompt:, template:) — whitespace-free by construction (\S+),
  // like spawn's template:. Positional tokens are those WITHOUT a `key:` prefix.
  const promptM = argStr.match(/\bprompt:(\S+)/);
  const templateM = argStr.match(/\btemplate:(\S+)/);
  const positional = argStr.trim().split(/\s+/).filter((t) => t && !/^\w+:/.test(t));
  if (sub === 'role-add' || sub === 'role-set') {
    return { type: 'team', sub, name: positional[0] || null, prompt: promptM ? promptM[1] : null, template: templateM ? templateM[1] : null, body };
  }
  if (sub === 'role-rm') return { type: 'team', sub, name: positional[0] || null, body: '' };
  if (sub === 'role-rename') return { type: 'team', sub, name: positional[0] || null, to: positional[1] || null, body: '' };
  // watchdog <ms> — a single numeric arg; a non-number → null (handler bounces).
  const ms = positional[0] != null ? Number(positional[0]) : null;
  return { type: 'team', sub, ms: Number.isFinite(ms) ? ms : null, body: '' };
}

// `spawn` = mint a NEW persistent top-level peer session (own socket / DM /
// memory / registry) from inside a running agent. `name` + `cwd` are the only
// required args; type/workspace/proxy inherit the spawner and everything else
// takes clodex defaults (see _handleSpawnIntent). New noun (a persistent peer)
// = a genuinely new category, so it earns its own top-level verb. Structural
// creation (sessions.json / sockets / registry) is clodex's job; prompt CONTENT
// deliberately stays out of the grammar (deferred, see spec Piece 2).
function parseSpawn(cleaned) {
  const m = cleaned.match(/^\[agent:spawn\s+(.+)\]\s*$/);
  if (!m) return null;
  const argstr = m[1];
  const nameM = argstr.match(/\bname:(\S+)/);
  const cwdM = argstr.match(/\bcwd:(\S+)/);
  // Optional template: reference — matched by NAME (case-insensitive exact) at
  // apply time. Whitespace-free by construction (\S+), so spaced template
  // names are UI-only and can't be referenced from an intent.
  const tplM = argstr.match(/\btemplate:(\S+)/);
  return {
    type: 'spawn',
    name: nameM ? nameM[1] : null,
    cwd: cwdM ? cwdM[1] : null,
    template: tplM ? tplM[1] : null,
  };
}

const NONE = () => 'none';
const GREEDY = () => 'greedy';

// The parse chain, in the ONE order that reproduces today's bytes. Do not
// reorder: `team-review` before `team`, and the bare-only rows (who/name)
// before the argument-taking ones that could match a superset.
const CORE_ROWS = [
  { type: 'dm', parse: parseDm, bodyMode: GREEDY },
  { type: 'resend', parse: parseResend, bodyMode: NONE },
  { type: 'who', parse: parseWho, bodyMode: NONE },
  { type: 'name', parse: parseName, bodyMode: NONE },
  // `context compact`/`reload` carry an optional continuation body; `clear`
  // ignores any body, so it must NOT capture following lines.
  { type: 'context', parse: parseContext, bodyMode: (i) => (i.sub === 'compact' || i.sub === 'reload' ? 'greedy' : 'none') },
  { type: 'memory', parse: parseMemory, bodyMode: (i) => (i.sub === 'remember' ? 'greedy' : 'none') },
  { type: 'file', parse: parseFile, bodyMode: NONE },
  // 'json' = terminate the capture at the first complete JSON value. The
  // fall-through to a greedy capture when the value never completes is CONTROL
  // FLOW in _extractIntents, not a second mode (it reproduces the bytes an
  // incomplete payload bounced with before the JSON terminator existed).
  { type: 'exec', parse: parseExec, bodyMode: () => 'json' },
  { type: 'remind', parse: parseRemind, bodyMode: GREEDY },
  { type: 'notify-user', parse: parseNotifyUser, bodyMode: GREEDY },
  { type: 'team-review', parse: parseTeamReview, bodyMode: GREEDY },
  { type: 'review-done', parse: parseReviewDone, bodyMode: GREEDY },
  { type: 'reboot', parse: parseReboot, bodyMode: NONE },
  { type: 'task', parse: parseTask, bodyMode: (i) => (i.sub === 'add' || i.sub === 'done' || i.sub === 'reject' || i.sub === 'cancel' ? 'greedy' : 'none') },
  { type: 'team', parse: parseTeam, bodyMode: (i) => (i.sub === 'role-add' || i.sub === 'role-set' ? 'greedy' : 'none') },
  { type: 'spawn', parse: parseSpawn, bodyMode: NONE },
].map((r) => Object.freeze({
  ...r,
  // Derived, never duplicated: the catalog stays the single source of truth for
  // which verbs are gateable and which are privileged.
  gateable: GATEABLE_INTENTS.some((i) => i.type === r.type),
  privileged: PRIVILEGED_INTENTS.has(r.type),
  label: (GATEABLE_INTENTS.find((i) => i.type === r.type) || {}).label || null,
  // NULL for every core row, on purpose. ipc-prompt.js's GRAMMAR_LINES owns the
  // prompt lines and says in terms that its order "is a byte property of
  // IPC_PROMPT and is INDEPENDENT of intent-catalog's GATEABLE_INTENTS order".
  // Copying the lines here would duplicate the bytes IPC_PROMPT is pinned on and
  // collapse two deliberate orderings into one. Plugin rows DO carry their own
  // line — rule P3's `extraGrammarLines` argument is for exactly those.
  promptLines: null,
  handler: null,
  source: 'core',
}));

const CORE_TYPES = new Set(CORE_ROWS.map((r) => r.type));

// Verbs a plugin may never claim. The core set, plus the three the scanner
// shell owns structurally (`end`/`escape`) or synthesizes (`unknown`) — a
// plugin that shadowed any of them could silently eat body terminators,
// escapes, or the near-miss bounce.
const RESERVED_TYPES = new Set([...CORE_TYPES, 'end', 'escape', 'unknown']);

// Rule P5. Mirrors the session-name rule's character class, narrowed to
// lowercase and to a length that stays readable inside `[agent:<verb>]`.
const PLUGIN_VERB_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

// ---------------------------------------------------------------------------
// Mutable plugin half
// ---------------------------------------------------------------------------

// Module-level, deliberately: `parseIntent` and `_extractIntents` read this
// list from three different feeds (jsonl, wire, bash PTY) without any of them
// holding a registry reference. Because registration mutates the ONE list all
// three read, a plugin verb is live on every feed by construction — the
// "registered on one feed only" failure mode cannot be expressed (R-INT-3).
const pluginRows = [];

// Register a plugin verb. Returns a dispose function (idempotent). Throws on a
// bad shape or a collision — activation errors are the plugin author's problem
// and must be loud, not a silently-dropped verb.
function registerIntent(spec, source) {
  const src = String(source || '').trim();
  if (!src) throw new Error('intent registration requires a source plugin id');
  const type = String((spec && (spec.verb || spec.type)) || '');
  if (!PLUGIN_VERB_RE.test(type)) throw new Error(`invalid intent verb: ${JSON.stringify(type)}`);
  if (RESERVED_TYPES.has(type)) throw new Error(`intent verb "${type}" is reserved by core`);
  if (pluginRows.some((r) => r.type === type)) throw new Error(`intent verb "${type}" is already registered`);
  if (typeof spec.parse !== 'function') throw new Error(`intent verb "${type}" needs a parse function`);
  if (spec.bodyMode != null && typeof spec.bodyMode !== 'function') {
    // MUST-FIX 7 again, at the boundary: a plugin passing a STRING here would be
    // asking for the type-level flag the whole design rejects.
    throw new Error(`intent verb "${type}": bodyMode must be a function of the parsed intent`);
  }
  const row = Object.freeze({
    type,
    // Wrapped so a plugin's parse can neither throw into the scanner nor return
    // an intent claiming to be some OTHER verb (which would route into a core
    // case in _handleIntent's switch).
    parse: (cleaned) => {
      let out;
      try { out = spec.parse(cleaned); } catch { return null; }
      if (!out || typeof out !== 'object') return null;
      return { ...out, type };
    },
    bodyMode: (intent) => {
      if (!spec.bodyMode) return 'none';
      let m;
      try { m = spec.bodyMode(intent); } catch { return 'none'; }
      return m === 'greedy' || m === 'json' ? m : 'none';
    },
    gateable: true,
    privileged: true,              // FORCED (rule P1) — any manifest claim is ignored
    label: String(spec.label || `${type} (plugin: ${src})`),
    promptLines: spec.promptLines != null ? String(spec.promptLines) : null,
    handler: typeof spec.handler === 'function' ? spec.handler : null,
    source: src,
  });
  pluginRows.push(row);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const idx = pluginRows.indexOf(row);
    if (idx >= 0) pluginRows.splice(idx, 1);
  };
}

// Drop every row a plugin registered (deactivation / teardown).
function unregisterSource(source) {
  for (let i = pluginRows.length - 1; i >= 0; i--) {
    if (pluginRows[i].source === source) pluginRows.splice(i, 1);
  }
}

// Test-only escape hatch: the module-level list is shared process-wide, so a
// test that registers a verb must be able to put the table back.
function _resetPluginRows() {
  pluginRows.length = 0;
}

function rows() {
  return [...CORE_ROWS, ...pluginRows];
}

function rowFor(type) {
  return CORE_ROWS.find((r) => r.type === type) || pluginRows.find((r) => r.type === type) || null;
}

function pluginRowFor(type) {
  return pluginRows.find((r) => r.type === type) || null;
}

// ---------------------------------------------------------------------------
// The four things the rest of the app asks this table
// ---------------------------------------------------------------------------

// R-INT-1: the parse walk. Core rows first, ALWAYS — a plugin can never shadow
// a core verb even before P5's collision check fires.
function parseWithRegistry(cleaned) {
  for (const r of CORE_ROWS) {
    const out = r.parse(cleaned);
    if (out) return out;
  }
  for (const r of pluginRows) {
    const out = r.parse(cleaned);
    if (out) return out;
  }
  return null;
}

// MUST-FIX 7: 'none' | 'greedy' | 'json', decided from the PARSED intent.
function bodyModeFor(intent) {
  if (!intent || !intent.type) return 'none';
  const r = rowFor(intent.type);
  if (!r) return 'none';
  try { return r.bodyMode(intent) || 'none'; } catch { return 'none'; }
}

// The gate, registry-aware (rule P1). Core types delegate to intent-catalog
// unchanged; a PLUGIN verb is privileged by construction, and privileged
// semantics are exactly "explicit grant or nothing" — an absent list is a
// refusal, never the living all-enabled default. This wrapper exists because
// intent-catalog returns TRUE for any type outside its catalog (the
// "ungateable by omission" rule), which for a plugin verb would be a
// retroactive grant to every seat that ever existed.
function intentEnabledFor(type, intentsList) {
  if (pluginRowFor(type)) return Array.isArray(intentsList) && intentsList.includes(type);
  return intentEnabled(type, intentsList);
}

// R-INT-4: the checklist projection. GATEABLE_INTENTS in ITS order (which owns
// checklist row order), then plugin rows in registration order — so the
// existing checklist is byte-identical and simply grows a plugin tail.
function catalogRows() {
  return [
    ...GATEABLE_INTENTS.map((i) => ({ type: i.type, label: i.label, privileged: PRIVILEGED_INTENTS.has(i.type), source: 'core' })),
    ...pluginRows.map((r) => ({ type: r.type, label: r.label, privileged: true, source: r.source })),
  ];
}

// Rule P2, computed ENGINE-side. The core half is intent-catalog's
// `intentsAllowlistFromChecked` untouched — including its null-collapse, whose
// `nonPrivCount` counts non-privileged CORE rows only, so enabling a plugin can
// never change what "absence" means. The plugin half is appended; if any plugin
// verb is checked the result MUST be an explicit array, because absence reads
// as "privileged off" and would silently drop the grant (the same bug the
// reboot collapse-guard fixes for core).
function allowlistFromChecked(checkedTypes) {
  const checked = new Set(checkedTypes);
  const pluginChecked = pluginRows.filter((r) => checked.has(r.type)).map((r) => r.type);
  const core = intentsAllowlistFromChecked(checkedTypes);
  if (!pluginChecked.length) return core;
  const coreEnabled = Array.isArray(core)
    ? core
    : GATEABLE_INTENTS.filter((i) => checked.has(i.type)).map((i) => i.type);
  return [...coreEnabled, ...pluginChecked];
}

// Rule P3: the extra grammar lines for a seat, i.e. the promptLines of every
// PLUGIN verb this seat has actually been granted. Empty for a seat with no
// grant and for a run with no plugins — so `buildIpcPrompt`'s third argument is
// absent-equivalent and both byte-pins hold.
function pluginGrammarLines(intentsList) {
  return pluginRows
    .filter((r) => r.promptLines && intentEnabledFor(r.type, intentsList))
    .map((r) => r.promptLines);
}

// Rule P4: the "Valid intents: …" near-miss bounce list.
//
// CORE_VALID_INTENT_NAMES is an explicit const, not a projection of the parse
// order, because it is USER-VISIBLE COPY that shipped: it is in neither parse
// nor catalog order, and it omits `team` (a pre-existing gap — flagged, not
// silently fixed here, since Phase 1 is a zero-behavior-change refactor).
// Rotting is prevented by a test asserting every name is a real registry type
// rather than by regenerating the string. Plugin verbs are appended before the
// trailing `end`, which stays last because it reads as the terminator it is.
const CORE_VALID_INTENT_NAMES = [
  'dm', 'resend', 'who', 'name', 'context', 'memory', 'spawn', 'file', 'exec',
  'remind', 'notify-user', 'team-review', 'review-done', 'task', 'reboot',
];

function validIntentNames() {
  return [...CORE_VALID_INTENT_NAMES, ...pluginRows.map((r) => r.type), 'end'];
}

module.exports = {
  CORE_ROWS,
  CORE_TYPES,
  RESERVED_TYPES,
  PLUGIN_VERB_RE,
  CORE_VALID_INTENT_NAMES,
  registerIntent,
  unregisterSource,
  rows,
  rowFor,
  pluginRowFor,
  parseWithRegistry,
  bodyModeFor,
  intentEnabledFor,
  catalogRows,
  allowlistFromChecked,
  pluginGrammarLines,
  validIntentNames,
  _resetPluginRows,
};
