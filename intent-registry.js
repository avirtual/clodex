// The single table three consumers read (the scanner's parse chain, intent
// extraction in session-manager, and the handler's routing switch). Do not
// reintroduce a parallel verb list in any of them.

const {
  GATEABLE_INTENTS,
  PRIVILEGED_INTENTS,
  intentEnabled,
  intentsAllowlistFromChecked,
  withoutPrivilegedIntents,
} = require('./intent-catalog');
const { DEFAULT_PLUGIN_SCOPE, pluginReaches } = require('./plugin-api');

// `parse` receives the CLEANED, TRIMMED line; the scanner shell owns cleanLine/trim and the escape check.

function parseDm(cleaned) {
  const m = cleaned.match(/^\[agent:dm\s+(\S+?)(\s+urgent)?\]\s*(.*)/s);
  return m ? { type: 'dm', target: m[1], urgent: !!m[2], body: m[3] } : null;
}

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

function parseContext(cleaned) {
  const m = cleaned.match(/^\[agent:context\s+(\S+)\]\s*(.*)/s);
  return m ? { type: 'context', sub: m[1].toLowerCase(), body: m[2] } : null;
}

function parseMemory(cleaned) {
  const m = cleaned.match(/^\[agent:memory\s+(\S+)\]\s*(.*)/s);
  return m ? { type: 'memory', sub: m[1].toLowerCase(), body: m[2] } : null;
}

function parseFile(cleaned) {
  const m = cleaned.match(/^\[agent:file\s+(\S+)\s+(.+?)\]\s*$/);
  return m ? { type: 'file', sub: m[1].toLowerCase(), path: m[2].trim() } : null;
}

function parseExec(cleaned) {
  const m = cleaned.match(/^\[agent:exec\s+(\S+)\]\s*(.*)/s);
  return m ? { type: 'exec', cmd: m[1], body: m[2] } : null;
}

// Body-based, not bracket-based, and that is forced: a shell command contains
// `]`, quotes and arbitrary bytes, so any argument inside the brackets would
// need an escaping scheme the agent has to get right on every command. The body
// takes the line verbatim and drawer-avail's vetTermCommand is what refuses the
// bytes that must not reach a PTY.
// The BODY is taken from the uncleaned line when one is available, and that is
// the whole reason this row reads a second argument. The scanner strips ANSI
// before any row parses, so `[agent:term exec] echo a<ESC>[Kb` would otherwise
// reach vetTermCommand as `echo ab` — a command the agent did not write, quietly
// rewritten and then RUN, which is exactly what "rejected, not stripped" exists
// to prevent. Vetting sees the escape and refuses it instead.
//
// Guarded by re-parsing: the raw line is only trusted when it yields the same
// verb and sub, so a decorator or an escape sitting inside the BRACKETS (where
// the strip is what made the line parse at all) falls back to the cleaned body
// rather than losing the intent.
function parseTerm(cleaned, raw) {
  const RE = /^\[agent:term\s+(\S+)\]\s*(.*)/s;
  const m = cleaned.match(RE);
  if (!m) return null;
  const sub = m[1].toLowerCase();
  let body = m[2];
  if (typeof raw === 'string' && raw !== cleaned) {
    const rm = raw.match(RE);
    if (rm && rm[1].toLowerCase() === sub) body = rm[2];
  }
  return { type: 'term', sub, body };
}

function parseRemind(cleaned) {
  const m = cleaned.match(/^\[agent:remind\s+([^\]]+)\]\s*(.*)/s);
  return m ? { type: 'remind', spec: m[1].trim(), body: m[2] } : null;
}

function parseNotifyUser(cleaned) {
  const m = cleaned.match(/^\[agent:notify-user\]\s*(.*)/s);
  return m ? { type: 'notify-user', body: m[1] } : null;
}

function parseTeamReview(cleaned) {
  const m = cleaned.match(/^\[agent:team-review\]\s*(.*)/s);
  return m ? { type: 'team-review', body: m[1] } : null;
}

function parseReviewDone(cleaned) {
  const m = cleaned.match(/^\[agent:review-done\]\s*(.*)/s);
  return m ? { type: 'review-done', body: m[1] } : null;
}

function parseReboot(cleaned) {
  const m = cleaned.match(/^\[agent:reboot\]\s*(.*)/s);
  return m ? { type: 'reboot', body: m[1] } : null;
}

function parseTask(cleaned) {
  const m = cleaned.match(/^\[agent:task\s+(add|assign|done|reject|cancel|park|list)\b([^\]]*)\]\s*(.*)/s);
  if (!m) return null;
  const sub = m[1];
  const argToks = m[2].trim().split(/\s+/).filter(Boolean);
  const body = m[3];
  if (sub === 'add') {
    // `park` is a MODIFIER filtered out of the positionals, never `who`. Taking
    // argToks[0] as the assignee would read `add park hand` as a ticket for a
    // seat named "park" and drop the role — a silent misfile, since an
    // unresolvable assignee is rejected but "park" could be a real seat.
    // Position-free because both orders read naturally; the cost is that a seat
    // literally named `park` is unaddressable here and needs `assign`.
    const park = argToks.includes('park');
    const rest = argToks.filter((t) => t !== 'park');
    return { type: 'task', sub, who: rest[0] || null, id: null, park, body };
  }
  if (sub === 'assign') return { type: 'task', sub, id: argToks[0] || null, who: argToks[1] || null, body: '' };
  if (sub === 'list') return { type: 'task', sub, id: null, who: null, filter: argToks[0] || null, body: '' };
  if (sub === 'park') return { type: 'task', sub, id: argToks[0] || null, who: null, body: '' };
  return { type: 'task', sub, id: argToks[0] || null, who: null, body };
}

function parseTeam(cleaned) {
  const m = cleaned.match(/^\[agent:team\s+(role-add|role-set|role-rm|role-rename|watchdog)\b([^\]]*)\]\s*(.*)/s);
  if (!m) return null;
  const sub = m[1];
  const argStr = m[2];
  const body = m[3];
  const promptM = argStr.match(/\bprompt:(\S+)/);
  const templateM = argStr.match(/\btemplate:(\S+)/);
  const positional = argStr.trim().split(/\s+/).filter((t) => t && !/^\w+:/.test(t));
  if (sub === 'role-add' || sub === 'role-set') {
    return { type: 'team', sub, name: positional[0] || null, prompt: promptM ? promptM[1] : null, template: templateM ? templateM[1] : null, body };
  }
  if (sub === 'role-rm') return { type: 'team', sub, name: positional[0] || null, body: '' };
  if (sub === 'role-rename') return { type: 'team', sub, name: positional[0] || null, to: positional[1] || null, body: '' };
  const ms = positional[0] != null ? Number(positional[0]) : null;
  return { type: 'team', sub, ms: Number.isFinite(ms) ? ms : null, body: '' };
}

function parseSpawn(cleaned) {
  const m = cleaned.match(/^\[agent:spawn\s+(.+)\]\s*$/);
  if (!m) return null;
  const argstr = m[1];
  const nameM = argstr.match(/\bname:(\S+)/);
  const cwdM = argstr.match(/\bcwd:(\S+)/);
  const tplM = argstr.match(/\btemplate:(\S+)/);
  const wtM = argstr.match(/\bworktree:(\S+)/);
  return {
    type: 'spawn',
    name: nameM ? nameM[1] : null,
    cwd: cwdM ? cwdM[1] : null,
    template: tplM ? tplM[1] : null,
    worktree: wtM ? wtM[1] : null,
  };
}

const NONE = () => 'none';
const GREEDY = () => 'greedy';

const CORE_ROWS = [
  { type: 'dm', parse: parseDm, bodyMode: GREEDY },
  { type: 'resend', parse: parseResend, bodyMode: NONE },
  { type: 'who', parse: parseWho, bodyMode: NONE },
  { type: 'name', parse: parseName, bodyMode: NONE },
  { type: 'context', parse: parseContext, bodyMode: (i) => (i.sub === 'compact' || i.sub === 'reload' || i.sub === 'clear' ? 'greedy' : 'none') },
  { type: 'memory', parse: parseMemory, bodyMode: (i) => (i.sub === 'remember' ? 'greedy' : 'none') },
  { type: 'file', parse: parseFile, bodyMode: NONE },
  // Line-scoped, unlike every other body-carrying row here: the command is
  // whatever follows the bracket on THAT line and nothing after it. Greedy
  // capture (how this shipped) could only ever swallow the agent's next lines
  // into the command, and vetTermCommand rejects any body with a newline — so
  // prose written under a correct command turned it into a refusal instead of
  // running it. A body that must survive vetting cannot span lines, which is
  // what makes this row different from dm/memory/task.
  { type: 'term', parse: parseTerm, bodyMode: NONE },
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
  gateable: GATEABLE_INTENTS.some((i) => i.type === r.type),
  privileged: PRIVILEGED_INTENTS.has(r.type),
  label: (GATEABLE_INTENTS.find((i) => i.type === r.type) || {}).label || null,
// NULL for every core row on purpose: ipc-prompt.js owns the core grammar
// lines and its order is independent of GATEABLE_INTENTS. Filling this in
// would duplicate the bytes IPC_PROMPT is pinned on.
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

const PLUGIN_VERB_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;


// Module-level, deliberately: `parseIntent` and `_extractIntents` read this
// list from three different feeds (jsonl, wire, bash PTY) without any of them
// holding a registry reference. Because registration mutates the ONE list all
// three read, a plugin verb is live on every feed by construction — the
// "registered on one feed only" failure mode cannot be expressed (R-INT-3).
const pluginRows = [];

function registerIntent(spec, source, opts = {}) {
  const src = String(source || '').trim();
  if (!src) throw new Error('intent registration requires a source plugin id');
  const type = String((spec && (spec.verb || spec.type)) || '');
  if (!PLUGIN_VERB_RE.test(type)) throw new Error(`invalid intent verb: ${JSON.stringify(type)}`);
  if (RESERVED_TYPES.has(type)) throw new Error(`intent verb "${type}" is reserved by core`);
// `code`/`heldBy` are what the loader branches on to tell a taken verb from a
// broken plugin; the message keeps the `already registered` substring two tests pin.
  const holder = pluginRows.find((r) => r.type === type);
  if (holder) {
    const err = new Error(`intent verb "${type}" is already registered by plugin "${holder.source}"`);
    err.code = 'EVERBTAKEN';
    err.verb = type;
    err.heldBy = holder.source;
    throw err;
  }
  if (typeof spec.parse !== 'function') throw new Error(`intent verb "${type}" needs a parse function`);
  if (spec.bodyMode != null && typeof spec.bodyMode !== 'function') {
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
// The MANIFEST's scope, threaded by the host at register() — never read off
// `spec`, which is the plugin's own argument. A plugin that could declare its
// own scope could declare itself global and undo the operator's decision.
    scope: opts.scope === 'session' ? 'session' : DEFAULT_PLUGIN_SCOPE,
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

function unregisterSource(source) {
  for (let i = pluginRows.length - 1; i >= 0; i--) {
    if (pluginRows[i].source === source) pluginRows.splice(i, 1);
  }
}

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

// The SURFACING gate (t190), and only that — enforcement stays with
// `intentEnabledFor`, which is already strict and is deliberately NOT
// scope-aware. The two answer different questions: this one is "should this
// session's operator ever be shown this row?", that one is "may this session
// fire this verb?". A session-scoped plugin's verb is refused by the second
// whether or not this one hid it, so hiding can never be the only thing
// standing between a seat and a verb.
//
// A `global` row is visible to everything, which is what makes the shipped four
// byte-identical: they declare no scope, `scopeOf` resolves them to `global`,
// and this returns true for every grants value including the absent one.
function rowVisibleTo(row, grants) {
  if (!row || row.scope !== 'session') return true;
  return pluginReaches(row.source, grants);
}

function visiblePluginRows(grants) {
  return pluginRows.filter((r) => rowVisibleTo(r, grants));
}


// R-INT-1: the parse walk. Core rows first, ALWAYS — a plugin can never shadow
// a core verb even before P5's collision check fires.
// `raw` is the same line with the decorator prefix stripped but the ANSI
// sequences still IN it, and it is optional: every row but `term` ignores it and
// a one-argument call still parses. It exists because the shell's ANSI strip
// runs before any row sees the line, which for a verb whose body is executed
// would silently REWRITE the command rather than refuse it — see parseTerm.
function parseWithRegistry(cleaned, raw) {
  for (const r of CORE_ROWS) {
    const out = r.parse(cleaned, raw);
    if (out) return out;
  }
  for (const r of pluginRows) {
    const out = r.parse(cleaned, raw);
    if (out) return out;
  }
  return null;
}

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

// withoutPrivilegedIntents filters against PRIVILEGED_INTENTS, a Set that never
// learns plugin verbs, so it silently passes them through. Every agent-initiated
// or over-the-wire writer of `intents` MUST call this wrapper, never the catalog's.
function withoutPrivilegedIntentsFor(intentsList) {
  if (!Array.isArray(intentsList)) return intentsList;
  return withoutPrivilegedIntents(intentsList).filter((t) => !pluginRowFor(t));
}

// R-INT-4: the checklist projection. GATEABLE_INTENTS in ITS order (which owns
// checklist row order), then plugin rows in registration order — so the
// existing checklist is byte-identical and simply grows a plugin tail.
function catalogRows(grants) {
  return [
    ...GATEABLE_INTENTS.map((i) => ({ type: i.type, label: i.label, privileged: PRIVILEGED_INTENTS.has(i.type), source: 'core' })),
    ...visiblePluginRows(grants).map((r) => ({ type: r.type, label: r.label, privileged: true, source: r.source })),
  ];
}

// If any plugin verb is checked the result MUST be an explicit array: an absent
// allowlist reads as "privileged off" and would silently drop the grant.
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

// Two filters, not one, and the scope filter is the OUTER of the two: a
// session-scoped plugin whose verb was somehow left in an old `intents` array
// must still contribute no grammar line to a session that has not granted it.
// Collapsing these into a single condition would make that depend on which
// stale list wins.
function pluginGrammarLines(intentsList, grants) {
  return visiblePluginRows(grants)
    .filter((r) => r.promptLines && intentEnabledFor(r.type, intentsList))
    .map((r) => r.promptLines);
}

// Explicit const, not a projection of the rows: user-visible copy in neither
// parse nor catalog order, and its omission of `team` is a known gap left as-is.
// `end` stays last.
const CORE_VALID_INTENT_NAMES = [
  'dm', 'resend', 'who', 'name', 'context', 'memory', 'spawn', 'file', 'exec',
  'remind', 'notify-user', 'team-review', 'review-done', 'task', 'term', 'reboot',
];

// Feeds the near-miss bounce, which is user-visible text: naming a verb here
// that the session cannot see would advertise a scoped plugin's existence to
// exactly the agents it is meant to be invisible to.
function validIntentNames(grants) {
  return [...CORE_VALID_INTENT_NAMES, ...visiblePluginRows(grants).map((r) => r.type), 'end'];
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
  rowVisibleTo,
  visiblePluginRows,
  parseWithRegistry,
  bodyModeFor,
  intentEnabledFor,
  withoutPrivilegedIntentsFor,
  catalogRows,
  allowlistFromChecked,
  pluginGrammarLines,
  validIntentNames,
  _resetPluginRows,
};
