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
  const m = cleaned.match(/^\[agent:task\s+(add|assign|done|reject|cancel|list)\b([^\]]*)\]\s*(.*)/s);
  if (!m) return null;
  const sub = m[1];
  const argToks = m[2].trim().split(/\s+/).filter(Boolean);
  const body = m[3];
  if (sub === 'add') return { type: 'task', sub, who: argToks[0] || null, id: null, body };
  if (sub === 'assign') return { type: 'task', sub, id: argToks[0] || null, who: argToks[1] || null, body: '' };
  if (sub === 'list') return { type: 'task', sub, id: null, who: null, filter: argToks[0] || null, body: '' };
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
  return {
    type: 'spawn',
    name: nameM ? nameM[1] : null,
    cwd: cwdM ? cwdM[1] : null,
    template: tplM ? tplM[1] : null,
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

function registerIntent(spec, source) {
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
function catalogRows() {
  return [
    ...GATEABLE_INTENTS.map((i) => ({ type: i.type, label: i.label, privileged: PRIVILEGED_INTENTS.has(i.type), source: 'core' })),
    ...pluginRows.map((r) => ({ type: r.type, label: r.label, privileged: true, source: r.source })),
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

function pluginGrammarLines(intentsList) {
  return pluginRows
    .filter((r) => r.promptLines && intentEnabledFor(r.type, intentsList))
    .map((r) => r.promptLines);
}

// Explicit const, not a projection of the rows: user-visible copy in neither
// parse nor catalog order, and its omission of `team` is a known gap left as-is.
// `end` stays last.
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
  withoutPrivilegedIntentsFor,
  catalogRows,
  allowlistFromChecked,
  pluginGrammarLines,
  validIntentNames,
  _resetPluginRows,
};
