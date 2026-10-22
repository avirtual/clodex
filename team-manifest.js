// Pure leaf — no electron, injected fs.

'use strict';

const path = require('path');
const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { defaultClodexHome } = require('./clodex-paths');
const { badStem, TEAM_STEM_RE } = require('./team-prompt-dir');
const { LISTING_KEYS } = require('./team-template-derive');

const TEAM_FILE = 'team.json';
const ROSTER_FILE = 'roster.json';
const ROSTER_VERSION = 1;
const ROSTER_BAD_PREFIX = `${ROSTER_FILE}.bad-`;
const ROSTER_PRUNE_MIN_AGE_MS = 60 * 1000;
const ROLE_RE = /^[a-zA-Z0-9._-]{1,32}$/;
// A team name is BOTH a directory name AND the `<team>-` seat-name prefix, so it
// must satisfy the session-name grammar (CLAUDE.md).
const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

const SEAT_NAME_MAX = 64;

function defaultLeadSeat(teamName, explicitLead) {
  const seat = explicitLead || `${teamName}-lead`;
  if (!explicitLead && seat.length > SEAT_NAME_MAX) {
    throw new Error(`team name "${teamName}" is too long: its default lead seat name "${seat}" exceeds the ${SEAT_NAME_MAX}-character seat-name limit`);
  }
  return seat;
}

const MANIFEST_VERSION = 3;

// Unmodeled keys are dropped at load with a warning, never a throw: every caller
// resolves teams inside a best-effort catch, so a throw reads as "no team".
const ROLE_KEYS = new Set(['template', 'prompt', 'brief', 'dispatch', 'cwd', 'account']);

const ROLE_DISPATCH_VALUES = new Set(['standing', 'spawn', 'worktree']);
const DEFAULT_ROLE_DISPATCH = 'standing';

// The legibility test asserts EDITABLE_ROLE_FIELDS ∪ this ≡ ROLE_KEYS, so a new
// field is either reachable or listed here. Empty is the steady state; do not
// delete the constant.
const UNREACHABLE_ROLE_FIELDS = new Set([]);

// Named rather than derived as "anything not in ROLE_KEYS": the mutators DELETE
// these from disk, so a derived set would swallow hand-authored keys and the
// migration would become data loss.
const CUT_ROLE_FIELDS = ['instantiate', 'standing', 'tools', 'type', 'ephemeral', 'worktree'];

// Membership is only a gate — "this key can be honored, so measure whether it
// was", never "this occurrence is honored".
const HONORED_CUT_FIELDS = new Map([['worktree', 'dispatch: "worktree"']]);

const EDITABLE_ROLE_FIELDS = ['account', 'brief', 'cwd', 'dispatch', 'prompt', 'template'];

// team.json is agent-writable and these keys are trusted downstream: the mutators
// must never create, destroy or rename them.
const RESERVED_ROLE_KEYS = new Set(['lead', 'reviewer']);
const RESERVED_ROLE_PATCH_FIELDS = new Set(['account']);

const DEFAULT_KIT = 'default';

const LEGACY_KIT = 'clodex';

const WATCHDOG_MIN_MS = 5 * 60 * 1000;
const WATCHDOG_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const STOCK_ROLE_DEFS = {
  lead: { prompt: 'clodex-team-lead', brief: 'team lead; holds durable context, dispatches specs, verifies and integrates the work.', template: 'clodex-team-lead' },
  // The template is what gives the hand's seat a working directory: the shipped
  // clodex-team-hand.json writes "${TEAM_ROOT}", so a new team's hand boots in
  // its own root, not the project the template was authored against.
  hand: { prompt: 'clodex-team-hand', brief: 'implementer; executes a spec to done, one distilled report per task.', template: 'clodex-team-hand', dispatch: 'worktree' },
  scout: { prompt: 'clodex-team-scout', brief: 'lookup scout on Haiku; verifies file:line coordinates, call sites and test pins at a named commit and writes one table; edits nothing, decides nothing.', template: 'clodex-team-scout', dispatch: 'spawn' },
  'page-scout': { prompt: 'clodex-team-page-scout', brief: 'page scout on Haiku; projects one saved web-page snapshot onto a ticket\'s question and writes one file of verbatim cells with line provenance, coverage and notices; Read and Write only, never the browser, edits nothing.', template: 'clodex-team-page-scout', dispatch: 'spawn' },
  reviewer: { prompt: 'clodex-team-reviewer', brief: 'reviewer; an independent verification pass, invoked on demand.', template: 'clodex-team-reviewer' },
};

// A field may live here only if exactly one resolver consumes it and every spawn
// path reaches that resolver; variation belongs in a template.
//
// Fixed key order: addRole's no-op check compares JSON.stringify of two
// normalized defs, so reordering these keys breaks equality.
function normalizeRoleDef(roleName, def, file) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new Error(`role "${roleName}" must be an object (${file})`);
  }
  if (def.template != null && typeof def.template !== 'string') {
    throw new Error(`role "${roleName}" template must be a string (${file})`);
  }
  if (def.prompt != null && typeof def.prompt !== 'string') {
    throw new Error(`role "${roleName}" prompt must be a string (${file})`);
  }
  if (def.brief != null && typeof def.brief !== 'string') {
    throw new Error(`role "${roleName}" brief must be a string (${file})`);
  }
  if (def.dispatch != null && !ROLE_DISPATCH_VALUES.has(def.dispatch)) {
    throw new Error(`role "${roleName}" dispatch must be one of ${[...ROLE_DISPATCH_VALUES].join(', ')} (${file})`);
  }
  if (def.cwd != null && typeof def.cwd !== 'string') {
    throw new Error(`role "${roleName}" cwd must be a string (${file})`);
  }
  if (def.account != null && typeof def.account !== 'string') {
    throw new Error(`role "${roleName}" account must be a string (${file})`);
  }
  if (typeof def.account === 'string' && /[\r\n]/.test(def.account)) {
    throw new Error(`role "${roleName}" account must be a single line (${file})`);
  }
  return {
    template: def.template ?? null,
    prompt: def.prompt ?? null,
    brief: def.brief ?? null,
    // The v2 `worktree: true` boolean is READ here, not merely migrated: migration
    // runs on mutator writes, so a file nobody edits would keep opting a role into
    // a worktree on disk while every dispatch silently went to a standing seat.
    dispatch: def.dispatch
      ?? ((def.worktree === true && !RESERVED_ROLE_KEYS.has(roleName)) ? 'worktree' : DEFAULT_ROLE_DISPATCH),
    // Relative to team.root: an absolute path would let an agent-writable
    // team.json point a seat at another project. Blank normalizes to null —
    // path.resolve(root, '') is root, so '' would mean what its absence means.
    cwd: (typeof def.cwd === 'string' && def.cwd.trim()) ? def.cwd.trim() : null,
    account: (typeof def.account === 'string' && def.account.trim()) ? def.account.trim() : null,
  };
}

// Refused where roles are DEFINED as well as at dispatch: team.json is
// hand-editable. Stated as an inversion so a future fourth value is refused by
// default; a check that lists the bad values admits every value nobody listed.
function assertDispatchAllowed(roleName, def, file) {
  if (!def || typeof def !== 'object') return;
  if (RESERVED_ROLE_KEYS.has(roleName) && def.dispatch != null && def.dispatch !== DEFAULT_ROLE_DISPATCH) {
    throw new Error(`the "${roleName}" role is standing — it cannot dispatch to a worktree or a one-shot spawn seat (got "${def.dispatch}") (${file})`);
  }
}

// Returned rather than warned in place: normalizeRoleDef runs on the write paths
// too, where a drop is the caller's answer, not a console line.
function unknownRoleKeys(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return [];
  return Object.keys(def).filter((k) => !ROLE_KEYS.has(k));
}

// Every mutator writes through this: dropping a key only on the way OUT leaves it
// on disk, where `tools: ["Read"]` reads as a restriction nothing enforces. A
// non-object passes through untouched so a malformed def still reaches the
// validators that throw on it, rather than being laundered into a valid `{}`.
function pickRoleKeys(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return def;
  const out = {};
  for (const [k, v] of Object.entries(def)) {
    // Trimmed so the bytes on disk are the ones the validators saw, which check
    // the trimmed form. Only these two: `brief`/`prompt` are prose whose
    // whitespace is the author's.
    if (ROLE_KEYS.has(k)) out[k] = ((k === 'cwd' || k === 'account') && typeof v === 'string') ? v.trim() : v;
  }
  return out;
}

// One console line per (file, dropped-key-set), for the life of the process:
// resolveTeam loads every team on every call and _sweepTickets runs it every 60s
// per live seat, so an ungated warn is several lines a minute forever.
const warnedDrops = new Set();

const TRUNK_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const TRUNK_HEAD = '@head';

function normalizeTrunk(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === TRUNK_HEAD) return t;
  if (!TRUNK_RE.test(t) || t.startsWith('-') || t.includes('..')) return null;
  return t;
}

const WORKTREES_VALUES = ['sibling', 'in-root'];

function normalizeWorktrees(v) {
  return WORKTREES_VALUES.includes(v) ? v : null;
}

function normalizeMaxHands(v) {
  return (typeof v === 'number' && Number.isInteger(v) && v > 0) ? v : null;
}

function boxCpus(cpuMax, cpus) {
  const [quota, period] = String(cpuMax == null ? '' : cpuMax).trim().split(/\s+/).map(Number);
  if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) return quota / period;
  return cpus;
}

function effectiveHandCap({ maxHands, inBox, cpuMax, cpus } = {}) {
  if (maxHands === null) return { cap: null, source: 'off' };
  const set = normalizeMaxHands(maxHands);
  if (set) return { cap: set, source: 'set' };
  if (!inBox) return { cap: null, source: 'off' };
  const vcpu = boxCpus(cpuMax, Number(cpus) || 1);
  const cap = Math.max(1, Math.floor(vcpu / 2));
  return { cap, source: `box default (${vcpu} vCPU → ${cap})` };
}

function createTeamManifest({ fs, clodexHome, log = null, now = () => Date.now() } = {}) {
  const home = clodexHome || defaultClodexHome();
  const teamsDir = path.join(home, 'teams');
  const kitsDir = path.join(home, 'library', 'kits');
  let seatLookup = null;
  const loggedOnce = new Set();
  const inferPending = new Set();
  let rosterChain = Promise.resolve();
  let staleSeen = new Set();

  function logLine(level, msg, onceKey = null) {
    if (onceKey) {
      if (loggedOnce.has(onceKey)) return;
      loggedOnce.add(onceKey);
    }
    if (log && typeof log[level] === 'function') log[level]('team', msg);
    else if (level === 'error') console.error(msg);
    else console.log(msg);
  }

  function listKits() {
    let ents;
    try { ents = fs.readdirSync(kitsDir, { withFileTypes: true }); } catch { return []; }
    return ents
      .filter((e) => e.isDirectory() && TEAM_STEM_RE.test(e.name) && !badStem(e.name))
      .map((e) => e.name)
      .filter((n) => { try { return !!fs.readFileSync(path.join(kitsDir, n, 'kit.json'), 'utf-8'); } catch { return false; } })
      .sort();
  }

  function readKit(name) {
    if (badStem(name) || !TEAM_STEM_RE.test(name)) return null;
    let obj;
    try { obj = JSON.parse(fs.readFileSync(path.join(kitsDir, name, 'kit.json'), 'utf-8')); }
    catch { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const roles = (obj.roles && typeof obj.roles === 'object' && !Array.isArray(obj.roles)) ? obj.roles : {};
    return {
      name,
      dir: path.join(kitsDir, name),
      description: typeof obj.description === 'string' ? obj.description : '',
      roles,
    };
  }

  function kitCatalog() {
    return listKits().map((n) => {
      const k = readKit(n);
      return `${n} — ${(k && k.description) || 'no description'}`;
    });
  }

  function resolveKit(kit) {
    if (kit == null) return readKit(DEFAULT_KIT);
    const name = String(kit);
    const found = readKit(name);
    if (!found) throw new Error(`unknown kit "${name}" (available: ${listKits().join(', ') || 'none'})`);
    return found;
  }

  // fs-util's atomicWriteFileSync, not a local write+rename: a bare rename is
  // atomic but not durable, and it fsyncs the bytes and the directory entry. Not
  // taken from the injected `fs` — durability is not a seam a caller may vary.
  // ensureDir stays: atomicWriteFileSync's own mkdir carries no mode, and
  // ~/.clodex/teams/<name>/ must not widen to the umask default.
  function atomicWrite(file, data) {
    ensureDir(path.dirname(file));
    atomicWriteFileSync(file, data);
  }

  function sourceDirs(opts, ...segments) {
    const kitDir = opts && typeof opts.kitDir === 'string' && opts.kitDir ? opts.kitDir : null;
    return [
      ...(kitDir ? [path.join(kitDir, ...segments)] : []),
      path.join(home, 'library', ...segments),
    ];
  }

  function readFirst(dirs, file) {
    for (const d of dirs) {
      try { return fs.readFileSync(path.join(d, file), 'utf-8'); } catch {}
    }
    return null;
  }

  function unwindTemplateCopies(teamName, roleNames) {
    for (const r of roleNames) {
      try { fs.unlinkSync(path.join(teamsDir, teamName, 'templates', `${r}.json`)); } catch {}
    }
    try { fs.rmdirSync(path.join(teamsDir, teamName, 'templates')); } catch {}
  }

  function unwindExecCopies(teamName, names) {
    for (const n of names || []) {
      try { fs.unlinkSync(path.join(teamsDir, teamName, 'exec', `${n}.json`)); } catch {}
    }
    try { fs.rmdirSync(path.join(teamsDir, teamName, 'exec')); } catch {}
  }

  function unwindPromptCopies(teamName, roleNames) {
    for (const r of roleNames) {
      try { fs.unlinkSync(path.join(teamsDir, teamName, 'prompts', 'system', `${r}.md`)); } catch {}
    }
    try { fs.rmdirSync(path.join(teamsDir, teamName, 'prompts', 'system')); } catch {}
    try { fs.rmdirSync(path.join(teamsDir, teamName, 'prompts')); } catch {}
  }

  function copyRolePrompts(teamName, roles, opts) {
    const repointOnly = !!(opts && opts.repointOnly === true);
    const copied = [];
    if (typeof teamName !== 'string' || !TEAM_STEM_RE.test(teamName)) return copied;
    try {
      for (const [roleName, def] of Object.entries(roles)) {
        if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
        const stem = def.prompt;
        if (typeof stem !== 'string' || !stem) continue;
        if (badStem(stem) || !TEAM_STEM_RE.test(stem)) continue;
        if (badStem(roleName) || !TEAM_STEM_RE.test(roleName)) continue;
        const target = path.join(teamsDir, teamName, 'prompts', 'system', `${roleName}.md`);
        let own = false;
        try { fs.readFileSync(target, 'utf-8'); own = true; } catch {}
        if (own) { def.prompt = roleName; continue; }
        if (repointOnly) continue;
        const body = readFirst(sourceDirs(opts, 'prompts', 'system'), `${stem}.md`);
        if (body == null) continue;
        atomicWrite(target, body);
        def.prompt = roleName;
        copied.push(roleName);
      }
    } catch (err) {
      unwindPromptCopies(teamName, copied);
      throw err;
    }
    return copied;
  }

  function copyKitExec(teamName, kitDir) {
    if (!kitDir) return [];
    if (typeof teamName !== 'string' || !TEAM_STEM_RE.test(teamName)) return [];
    let ents;
    try { ents = fs.readdirSync(path.join(kitDir, 'exec')); } catch { return []; }
    const copied = [];
    try {
      for (const f of ents) {
        if (!f.endsWith('.json')) continue;
        const stem = f.slice(0, -'.json'.length);
        if (badStem(stem) || !TEAM_STEM_RE.test(stem)) continue;
        const target = path.join(teamsDir, teamName, 'exec', f);
        try { fs.readFileSync(target, 'utf-8'); continue; } catch {}
        let body;
        try { body = fs.readFileSync(path.join(kitDir, 'exec', f), 'utf-8'); } catch { continue; }
        atomicWrite(target, body);
        copied.push(stem);
      }
    } catch (err) {
      unwindExecCopies(teamName, copied);
      throw err;
    }
    return copied;
  }

  function copyRoleTemplates(teamName, roles, opts) {
    const repointOnly = !!(opts && opts.repointOnly === true);
    const copied = [];
    if (typeof teamName !== 'string' || !TEAM_STEM_RE.test(teamName)) return copied;
    try {
      for (const [roleName, def] of Object.entries(roles)) {
        if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
        const stem = def.template;
        if (typeof stem !== 'string' || !stem) continue;
        if (badStem(stem) || !TEAM_STEM_RE.test(stem)) continue;
        if (badStem(roleName) || !TEAM_STEM_RE.test(roleName)) continue;
        const target = path.join(teamsDir, teamName, 'templates', `${roleName}.json`);
        let own = false;
        try { fs.readFileSync(target, 'utf-8'); own = true; } catch {}
        if (own) { def.template = roleName; continue; }
        if (repointOnly) continue;
        const raw = readFirst(sourceDirs(opts, 'templates'), `${stem}.json`);
        if (raw == null) continue;
        let base;
        try { base = JSON.parse(raw); } catch { continue; }
        if (!base || typeof base !== 'object' || Array.isArray(base)) continue;
        const body = { ...base };
        for (const k of LISTING_KEYS) delete body[k];
        body.name = roleName;
        atomicWrite(target, `${JSON.stringify(body, null, 2)}\n`);
        def.template = roleName;
        copied.push(roleName);
      }
    } catch (err) {
      unwindTemplateCopies(teamName, copied);
      throw err;
    }
    return copied;
  }

  // Run on EVERY mutator write, not conditionally: a conditional stamp could
  // never fire on a legacy file, since every mutator refuses the reserved roles
  // the v1 scaffold put the stale keys on. Scoped to CUT_ROLE_FIELDS, not
  // ROLE_KEYS: keys we do not model are hand-authored data and stay untouched.
  function migrateRoles(raw) {
    const roles = (raw && raw.roles && typeof raw.roles === 'object' && !Array.isArray(raw.roles))
      ? raw.roles : null;
    if (!roles) return raw;
    for (const [roleName, def] of Object.entries(roles)) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
      // Must run BEFORE the delete loop: `worktree` is in CUT_ROLE_FIELDS, so
      // reading it afterwards yields undefined and every role that opted into a
      // worktree silently becomes standing, with no error anywhere.
      if (def.worktree === true && def.dispatch == null && !RESERVED_ROLE_KEYS.has(roleName)) {
        def.dispatch = 'worktree';
      }
      for (const k of CUT_ROLE_FIELDS) {
        if (k in def) delete def[k];
      }
      roles[roleName] = def;
    }
    // Conditional: a hand-authored key outside the cut set is not ours to delete,
    // and a file carrying one has not finished migrating.
    const clean = Object.values(roles).every((d) => unknownRoleKeys(d).length === 0);
    if (clean) raw.version = MANIFEST_VERSION;
    return raw;
  }

  function stashOf(raw) {
    const s = raw && raw.removedRoleAccounts;
    return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
  }

  function dropStash(raw, roleName) {
    const s = stashOf(raw);
    delete s[roleName];
    if (Object.keys(s).length) raw.removedRoleAccounts = s;
    else delete raw.removedRoleAccounts;
  }

  function carryAccount(raw, roleName) {
    const label = stashOf(raw)[roleName];
    dropStash(raw, roleName);
    return (typeof label === 'string' && label.trim()) ? label.trim() : null;
  }

  function listTeams() {
    let entries;
    try {
      entries = fs.readdirSync(teamsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  }

  function loadManifest(name) {
    return loadManifestFull(name).team;
  }

  function loadManifestFull(name) {
    const file = path.join(teamsDir, name, TEAM_FILE);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      throw new Error(`no team manifest at ${file}: ${err.message}`);
    }
    let m;
    try {
      m = JSON.parse(raw);
    } catch (err) {
      throw new Error(`team.json is not valid JSON (${file}): ${err.message}`);
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new Error(`team.json must be an object (${file})`);
    }
    const root = m.root;
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new Error(`team.json "root" must be an absolute path (${file})`);
    }
    const lead = m.lead;
    if (typeof lead !== 'string' || !NAME_RE.test(lead)) {
      throw new Error(`team.json "lead" must be a seat name matching ${NAME_RE} (${file})`);
    }
    const rolesIn = m.roles;
    if (!rolesIn || typeof rolesIn !== 'object' || Array.isArray(rolesIn)) {
      throw new Error(`team.json "roles" must be an object (${file})`);
    }
    if (!('lead' in rolesIn)) {
      throw new Error(`team.json roles must include a "lead" role (${file})`);
    }
    const roles = {};
    // Built once and rendered twice — the warns below and formatRoster both read
    // it; a surface that re-decides `honored` for itself is the drift this
    // prevents. 'ignored' and 'honored' may never be merged into one line: the
    // second's text is the negation of the first's.
    //
    // This rides on the object `team:get` returns, so it crosses into the
    // nodeIntegration renderer. `field` is safe by construction only for the two
    // retired statuses; an 'unknown' field name is an arbitrary agent-authored
    // string out of team.json, so a UI consumer inherits the security rule in
    // renderer/popovers/team-roles-popover.js and a text surface rendering
    // 'unknown' must refuse newlines.
    const droppedFields = [];
    for (const [roleName, def] of Object.entries(rolesIn)) {
      if (!ROLE_RE.test(roleName)) {
        throw new Error(`role name "${roleName}" must match ${ROLE_RE} (${file})`);
      }
      // Partitioned by MEASURED EFFECT, not by key name: honoring is conditional
      // on the value and the role, so a name-only test claims "this still takes
      // effect" where it does not, and the remedy it carries is harmful there.
      // Sound because `without` is a subset of `def` and `k` is never in
      // ROLE_KEYS, so no validator that passed on `def` can throw on `without`.
      const normalized = normalizeRoleDef(roleName, def, file);
      for (const k of unknownRoleKeys(def)) {
        let honored = false;
        if (HONORED_CUT_FIELDS.has(k)) {
          const without = { ...def };
          delete without[k];
          honored = JSON.stringify(normalizeRoleDef(roleName, without, file)) !== JSON.stringify(normalized);
        }
        // Per occurrence: one line may name several keys, so a hardcoded
        // "write X instead" is wrong once the map holds two entries.
        if (honored) {
          droppedFields.push({
            role: roleName, field: k, status: 'honored', remedy: HONORED_CUT_FIELDS.get(k),
          });
          continue;
        }
        droppedFields.push({
          role: roleName, field: k, remedy: null,
          status: CUT_ROLE_FIELDS.includes(k) ? 'ignored' : 'unknown',
        });
      }
      roles[roleName] = normalized;
    }
    const named = (st) => droppedFields
      .filter((d) => d.status === st)
      // Keyed on status, never on `remedy`'s truthiness: an empty remedy would
      // drop the suffix here while the roster rendered a bare "write `` instead".
      .map((d) => (d.status === 'honored' ? `${d.role}.${d.field} (write \`${d.remedy}\` instead)` : `${d.role}.${d.field}`));
    const dropped = named('unknown');
    const droppedCut = named('ignored');
    const droppedHonored = named('honored');
    // Absent reads as 1: defaulting to current would let a stale manifest claim a
    // schema it was never checked against.
    const version = (typeof m.version === 'number' && Number.isInteger(m.version) && m.version > 0)
      ? m.version : 1;
    // Warn, never throw: a manifest that refuses to load reads as "this cwd is on
    // no team" at every call site. Version-gated: this is for the migration, not
    // a linter.
    if (dropped.length && version < MANIFEST_VERSION) {
      const seen = `unknown|${file}|${dropped.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": ignoring role keys this schema no longer models — ${dropped.join(', ')} (${file})`);
      }
    }
    // NOT under the version gate, unlike the warn above: a file claiming the
    // current schema while carrying a retired field would drop it in silence.
    if (droppedCut.length) {
      const seen = `cut|${file}|${droppedCut.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": these role keys are IGNORED — they are retired fields this schema no longer honors, and setting them enforces or configures nothing: ${droppedCut.join(', ')} (${file})`);
      }
    }
    // Ungated like the line above, but the opposite message: this key still takes
    // effect, so the only safe edit is a rewrite, not a delete.
    if (droppedHonored.length) {
      const seen = `honored|${file}|${droppedHonored.join(',')}`;
      if (!warnedDrops.has(seen)) {
        warnedDrops.add(seen);
        console.warn(`team "${name}": these role keys are RETIRED but STILL READ — they are not modeled by this schema, yet a compatibility branch honors them HERE, so deleting one CHANGES BEHAVIOUR: ${droppedHonored.join(', ')}; a future schema will stop reading them (${file})`);
      }
    }
    // Clamped at READ, the choke point every consumer passes, since team.json is
    // agent-writable. Never throw: one bad number must not break the whole team.
    const rawWatchdog = m.watchdogMs;
    const watchdogMs = (typeof rawWatchdog === 'number' && Number.isFinite(rawWatchdog) && rawWatchdog > 0)
      ? Math.min(WATCHDOG_MAX_MS, Math.max(WATCHDOG_MIN_MS, rawWatchdog))
      : null;
    const kit = (typeof m.kit === 'string' && !badStem(m.kit) && TEAM_STEM_RE.test(m.kit)) ? m.kit : LEGACY_KIT;
    const trunk = normalizeTrunk(m.trunk);
    const worktrees = normalizeWorktrees(m.worktrees);
    const maxHands = m.maxHands === null ? null : (normalizeMaxHands(m.maxHands) || undefined);
    const rosterState = readRoster(name, roles, lead);
    const team = { name, root: path.resolve(root), sandboxed: m.sandboxed === true, lead, roles, kit, file, dir: path.dirname(file), watchdogMs, trunk, ...(worktrees ? { worktrees } : {}), ...(maxHands !== undefined ? { maxHands } : {}), version, droppedFields, roster: rosterState.rows };
    return { team, rosterState };
  }

  function rosterPath(teamName) {
    return path.join(teamsDir, teamName, ROSTER_FILE);
  }

  function seatsNamedIn(text) {
    const out = [];
    const add = (x) => { if (typeof x === 'string' && NAME_RE.test(x) && !out.includes(x)) out.push(x); };
    const src = String(text || '');
    const re = /"seat"\s*:\s*"([^"\\]{1,64})"/g;
    let m;
    while ((m = re.exec(src))) add(m[1]);
    let held = null;
    try {
      const obj = JSON.parse(src);
      held = obj && obj.quarantine && Array.isArray(obj.quarantine.seats) ? obj.quarantine.seats : null;
    } catch {}
    if (held) held.forEach(add);
    else {
      const q = /"quarantine"\s*:\s*\{[^}]*?"seats"\s*:\s*\[([^\]]*)\]/.exec(src);
      if (q) for (const n of q[1].matchAll(/"([^"\\]{1,64})"/g)) add(n[1]);
    }
    return out;
  }

  function parseRoster(text, roles) {
    let obj;
    try { obj = JSON.parse(text); } catch (err) { return { bad: `not valid JSON (${err.message})` }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Array.isArray(obj.seats)) {
      return { bad: 'not an object with a "seats" array' };
    }
    const rows = [];
    for (const r of obj.seats) {
      if (!r || typeof r !== 'object' || typeof r.seat !== 'string' || !NAME_RE.test(r.seat) || typeof r.role !== 'string') {
        return { bad: `malformed row ${JSON.stringify(r)}` };
      }
      if (!Object.prototype.hasOwnProperty.call(roles, r.role)) {
        return { bad: `seat ${r.seat} names role "${r.role}", which is not in team.roles` };
      }
      if (rows.some((x) => x.seat === r.seat)) return { bad: `seat ${r.seat} has two rows` };
      rows.push({
        seat: r.seat,
        role: r.role,
        gen: typeof r.gen === 'number' ? r.gen : null,
        since: typeof r.since === 'number' ? r.since : 0,
        by: typeof r.by === 'string' ? r.by : 'unknown',
        ...(typeof r.ticket === 'string' && r.ticket ? { ticket: r.ticket } : {}),
      });
    }
    const q = obj.quarantine;
    if (q !== undefined && (!q || typeof q.file !== 'string' || !Array.isArray(q.seats) || !q.seats.every((x) => typeof x === 'string' && NAME_RE.test(x)))) {
      return { bad: 'malformed "quarantine" record' };
    }
    const held = q ? q.seats.filter((x) => !rows.some((r) => r.seat === x)) : [];
    return { rows, quarantine: held.length ? { file: q.file, seats: held } : null };
  }

  function quarantineFiles(teamName) {
    let names = [];
    try { names = fs.readdirSync(path.join(teamsDir, teamName)); } catch { return []; }
    return names.filter((n) => n.startsWith(ROSTER_BAD_PREFIX)).sort();
  }

  function readRoster(teamName, roles, lead) {
    const st = readRosterRaw(teamName, roles);
    if (st.quarantine) {
      const seats = st.quarantine.seats.filter((x) => x !== lead);
      st.quarantine = seats.length ? { ...st.quarantine, seats } : null;
    }
    return st;
  }

  function readRosterRaw(teamName, roles) {
    const file = rosterPath(teamName);
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      const bad = quarantineFiles(teamName);
      if (!bad.length) return { rows: [], quarantine: null, absent: true };
      const badFile = path.join(teamsDir, teamName, bad[bad.length - 1]);
      let badText = '';
      try { badText = fs.readFileSync(badFile, 'utf-8'); } catch {}
      return { rows: [], quarantine: { file: badFile, seats: seatsNamedIn(badText) }, absent: false };
    }
    const parsed = parseRoster(text, roles);
    if (parsed.rows) return { rows: parsed.rows, quarantine: parsed.quarantine, absent: false };
    const badFile = `${file}.bad-${now()}`;
    let moved = true;
    try { fs.renameSync(file, badFile); } catch { moved = false; }
    const where = moved ? badFile : file;
    logLine('error', `team "${teamName}": roster quarantined — ${parsed.bad}; ${moved ? `moved to ${badFile}` : `could not move ${file}`}; every seat it named is on no team until a lead binds it again`, moved ? null : `quarantine|${file}|${text.length}`);
    return { rows: [], quarantine: { file: where, seats: seatsNamedIn(text) }, absent: false };
  }

  function rewriteRosterRows(teamName, fn) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(rosterPath(teamName), 'utf-8')); } catch { return; }
    if (!obj || !Array.isArray(obj.seats)) return;
    writeRoster(teamName, fn(obj.seats));
  }

  function heldQuarantine(teamName) {
    try {
      const obj = JSON.parse(fs.readFileSync(rosterPath(teamName), 'utf-8'));
      return obj && obj.quarantine && Array.isArray(obj.quarantine.seats) ? obj.quarantine : null;
    } catch {}
    const bad = quarantineFiles(teamName);
    if (!bad.length) return null;
    const file = path.join(teamsDir, teamName, bad[bad.length - 1]);
    let text = '';
    try { text = fs.readFileSync(file, 'utf-8'); } catch {}
    return { file, seats: seatsNamedIn(text) };
  }

  function leadOf(teamName) {
    try { return JSON.parse(fs.readFileSync(path.join(teamsDir, teamName, TEAM_FILE), 'utf-8')).lead; } catch { return null; }
  }

  function writeRoster(teamName, rows, carried) {
    const q = carried !== undefined ? carried : heldQuarantine(teamName);
    const lead = leadOf(teamName);
    const held = q ? q.seats.filter((x) => x !== lead && !rows.some((r) => r.seat === x)) : [];
    atomicWrite(rosterPath(teamName), JSON.stringify({
      version: ROSTER_VERSION, seats: rows, ...(held.length ? { quarantine: { file: q.file, seats: held } } : {}),
    }, null, 2));
  }

  function setSeatLookup(lookup) {
    seatLookup = lookup && typeof lookup.record === 'function' ? lookup : null;
  }

  function seatRecord(seat) {
    if (!seatLookup) return undefined;
    try { return seatLookup.record(seat) || null; } catch { return null; }
  }

  function genOf(seat) {
    const rec = seatRecord(seat);
    return rec && typeof rec.createdAt === 'number' ? rec.createdAt : null;
  }

  function seatExists(seat) {
    if (!seatLookup) return true;
    if (seatRecord(seat)) return true;
    try { return !!(seatLookup.live && seatLookup.live(seat)); } catch { return false; }
  }

  function rowState(row) {
    if (!seatLookup) return 'live';
    const rec = seatRecord(row.seat);
    if (rec) {
      const gen = typeof rec.createdAt === 'number' ? rec.createdAt : null;
      return (row.gen != null && gen != null && row.gen !== gen) ? 'replaced' : 'live';
    }
    let live = false;
    try { live = !!(seatLookup.live && seatLookup.live(row.seat)); } catch { live = false; }
    if (live || now() - row.since < ROSTER_PRUNE_MIN_AGE_MS) return 'live';
    return 'stale';
  }

  function loadAll() {
    const out = [];
    for (const name of listTeams()) {
      try { out.push(loadManifestFull(name)); } catch {}
    }
    return out;
  }

  function onChain(fn) {
    const p = rosterChain.then(fn);
    rosterChain = p.catch(() => {});
    return p;
  }

  function seatClaim(seat, loaded) {
    for (const { team } of loaded) {
      if (team.lead === seat) return { team, row: team.roster.find((r) => r.seat === seat) || null, lead: true };
    }
    let quarantined = null;
    for (const { team, rosterState } of loaded) {
      const row = team.roster.find((r) => r.seat === seat);
      if (!row) {
        if (!quarantined && rosterState.quarantine && rosterState.quarantine.seats.includes(seat)) quarantined = team;
        continue;
      }
      const st = rowState(row);
      if (st === 'live') return { team, row };
      if (st === 'replaced') {
        logLine('info', `team ${team.name}: seat ${seat} was recreated (record ${genOf(seat)} ≠ row ${row.gen}) — on no team until a lead binds it again`, `replaced|${team.name}|${seat}|${genOf(seat)}`);
        return { team: null, blocked: 'replaced', holder: team.name, row };
      }
    }
    if (quarantined) return { team: null, blocked: 'quarantine', holder: quarantined.name };
    return null;
  }

  function containsPath(root, cwd) {
    const rel = path.relative(path.resolve(root), path.resolve(cwd));
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  }

  // A security boundary: `cwd` flows to create() as a PTY working directory and
  // team.json is agent-writable. Confinement is decided by resolving and
  // comparing (containsPath), never a prefix match — a check for a leading ".."
  // misses `api/../../elsewhere`. Not in normalizeRoleDef, because a LOAD must
  // not throw: loadManifest runs inside every caller's best-effort catch.
  function assertRoleCwd(roleName, def, root, file) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return;
    const raw = def.cwd;
    if (raw == null || (typeof raw === 'string' && !raw.trim())) return;
    if (typeof raw !== 'string') {
      throw new Error(`role "${roleName}" cwd must be a string (${file})`);
    }
    const rel = raw.trim();
    // resolveSeatShape is never called with roleKey 'lead', so a cwd here is inert
    // but believed.
    if (roleName === 'lead') {
      throw new Error(`role "lead" cannot take a cwd: the lead's seat is not spawned by the team, so its directory is set when the operator creates the seat (${file})`);
    }
    if (path.isAbsolute(rel)) {
      throw new Error(`role "${roleName}" cwd must be RELATIVE to the team root — "${rel}" is absolute, and an absolute cwd could point a seat at another project (${file})`);
    }
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, rel);
    if (!containsPath(resolvedRoot, resolved)) {
      throw new Error(`role "${roleName}" cwd "${rel}" resolves outside the team root ${resolvedRoot} (${file})`);
    }
    // Refused, never created: a seat in an invented empty directory looks exactly
    // like one working correctly.
    let isDir = false;
    try { isDir = fs.statSync(resolved).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      throw new Error(`role "${roleName}" cwd "${rel}" is not an existing directory under the team root (${resolvedRoot}) — create it first; Clodex never makes it for you (${file})`);
    }
    // Re-decided on the REAL paths: containsPath compares strings, so `cwd: "link"`
    // pointing at another project satisfies it while aiming a PTY out of the tree.
    // BOTH sides are realpath'd — a project root under /tmp is itself a symlink on
    // macOS, so realpathing only the candidate refuses every legitimate role cwd.
    let realRoot = null;
    let realCwd = null;
    try { realRoot = fs.realpathSync(resolvedRoot); } catch { realRoot = null; }
    try { realCwd = fs.realpathSync(resolved); } catch { realCwd = null; }
    if (!realRoot || !realCwd) {
      throw new Error(`role "${roleName}" cwd "${rel}" is not an existing directory under the team root (${resolvedRoot}) — create it first; Clodex never makes it for you (${file})`);
    }
    if (!containsPath(realRoot, realCwd)) {
      throw new Error(`role "${roleName}" cwd "${rel}" resolves outside the team root ${resolvedRoot} — it is a symlink to ${realCwd} (${file})`);
    }
  }

  // A linked worktree's `.git` is a FILE reading `gitdir: <main>/.git/worktrees/
  // <id>`, so one read derives the main checkout. No `git` subprocess: resolveTeam
  // runs on every roster render and every ticket resolution.
  const WORKTREE_MARKER = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  function mainCheckoutOf(cwd) {
    let dir = path.resolve(cwd);
    // Bounded: an unbounded walk on a symlink cycle would hang the caller.
    for (let i = 0; i < 64; i++) {
      let raw;
      try {
        const st = fs.lstatSync(path.join(dir, '.git'));
        // A directory `.git` is the main checkout, which containsPath already
        // handled; returning it here would mask a genuine miss.
        if (!st.isFile()) return null;
        raw = fs.readFileSync(path.join(dir, '.git'), 'utf-8');
      } catch {
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
        continue;
      }
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(raw);
      if (!m) return null;
      const gitdir = path.resolve(dir, m[1]);
      const at = gitdir.indexOf(WORKTREE_MARKER);
      if (at < 0) return null;   // a `.git` file that is not a linked worktree
      // The marker leads with the separator, so the prefix is exactly the main
      // checkout with no trailing slash to strip.
      return gitdir.slice(0, at);
    }
    return null;
  }

  // Path containment alone excludes worktrees: git's default puts one at
  // `<repo>/../<repo>-<branch>`, a SIBLING of the root, so a seat working in one
  // falls off its team — no roster entry, and `_ticketAssigneeSeat` returns null.
  function cwdInProject(cwd, root) {
    if (!cwd || !root) return false;
    if (containsPath(root, cwd)) return true;
    const main = mainCheckoutOf(cwd);
    if (!main) return false;
    if (containsPath(root, main)) return true;
    let realMain;
    let realRoot;
    try {
      realMain = fs.realpathSync(main);
      realRoot = fs.realpathSync(root);
    } catch {
      return false;
    }
    return containsPath(realRoot, realMain);
  }

  // Deepest root wins: a containing pair is always ancestor/descendant, so the
  // longer resolved root is the descendant. One broken manifest must not throw.
  function cwdCandidates(cwd, loaded = loadAll()) {
    if (!cwd) return [];
    let best = [];
    for (const { team: m } of loaded) {
      if (m.sandboxed) continue;
      if (!cwdInProject(cwd, m.root)) continue;
      if (!best.length || m.root.length > best[0].root.length) best = [m];
      else if (m.root.length === best[0].root.length) best.push(m);
    }
    return best;
  }

  function teamOfCwd(cwd) {
    const c = cwdCandidates(cwd);
    return c.length === 1 ? c[0] : null;
  }

  function teamsOfCwd(cwd) {
    return cwdCandidates(cwd).map((t) => t.name);
  }

  function teamOfSeat(seat) {
    if (!seat) return null;
    const claim = seatClaim(seat, loadAll());
    return claim && claim.team ? claim.team : null;
  }

  function teamOf({ name, cwd } = {}) {
    const loaded = loadAll();
    if (name) {
      const claim = seatClaim(name, loaded);
      if (claim) {
        const gen = claim.team ? genOf(name) : null;
        if (claim.row && gen != null && (claim.row.gen == null || (claim.lead && claim.row.gen !== gen))) stampGen(claim.team.name, name);
        return claim.team || null;
      }
    }
    const cands = cwdCandidates(cwd, loaded);
    if (cands.length !== 1) return null;
    const team = cands[0];
    if (name) inferSeat(team, name, loaded);
    return team;
  }

  function inferSeat(team, seat, loaded) {
    if (!seatLookup || inferPending.has(seat)) return;
    const own = loaded.find((l) => l.team.name === team.name);
    if (!own || own.rosterState.quarantine) return;
    const role = nameRole(team, seat);
    if (!role || !seatExists(seat)) return;
    inferPending.add(seat);
    bindSeat(team.name, seat, role, { by: 'inferred' })
      .then((r) => { if (r && r.ok && !r.unchanged) logLine('info', `team ${team.name}: seat ${seat} inferred as ${role} from its name`); })
      .catch(() => {})
      .finally(() => inferPending.delete(seat));
  }

  function stampGen(teamName, seat) {
    onChain(() => {
      let team;
      try { team = loadManifest(teamName); } catch { return; }
      const gen = genOf(seat);
      const row = team.roster.find((r) => r.seat === seat);
      if (!row || gen == null || row.gen === gen || (row.gen != null && team.lead !== seat)) return;
      writeRoster(teamName, team.roster.map((r) => (r.seat === seat ? { ...r, gen } : r)));
    }).catch(() => {});
  }

  function liveHolder(seat, exceptTeam) {
    for (const { team } of loadAll()) {
      if (team.name === exceptTeam) continue;
      if (team.lead === seat) return { team: team.name, role: 'lead' };
      const row = team.roster.find((r) => r.seat === seat);
      if (row && rowState(row) === 'live') return { team: team.name, role: row.role };
    }
    return null;
  }

  function bindNow(teamName, seat, role, { by = 'unknown', ticket = null, gen } = {}) {
    if (typeof seat !== 'string' || !NAME_RE.test(seat)) return { ok: false, error: `seat name "${seat}" must match ${NAME_RE}` };
    const loaded = loadAll();
    const own = loaded.find((l) => l.team.name === teamName);
    if (!own) return { ok: false, error: `no team "${teamName}"` };
    if (!Object.prototype.hasOwnProperty.call(own.team.roles, role)) {
      return { ok: false, error: `role "${role}" is not on team ${teamName} (roles: ${Object.keys(own.team.roles).join(', ')})` };
    }
    const mine = own.team.roster.find((r) => r.seat === seat);
    if (by === 'inferred') {
      if (own.rosterState.quarantine) return { ok: false, error: `team ${teamName}'s roster is quarantined (${own.rosterState.quarantine.file}) — a lead binds ${seat} with [agent:team bind ${seat} ${role}]` };
      if (mine && rowState(mine) === 'live') return { ok: true, team: teamName, row: mine, unchanged: true };
    }
    const leads = loaded.find((l) => l.team.name !== teamName && l.team.lead === seat);
    if (leads) return { ok: false, error: `${seat} is team ${leads.team.name}'s lead — set another lead there first`, holder: leads.team.name, role: 'lead' };
    const drops = [];
    for (const { team } of loaded) {
      if (team.name === teamName) continue;
      const held = team.roster.find((r) => r.seat === seat);
      if (!held) continue;
      const st = rowState(held);
      if (st === 'live') return { ok: false, error: `${seat} is on team ${team.name}'s roster (role ${held.role}) — unbind it there first`, holder: team.name, role: held.role };
      drops.push({ team, held, st });
    }
    for (const { team, held, st } of drops) {
      writeRoster(team.name, team.roster.filter((r) => r.seat !== seat));
      logLine('info', `team ${team.name}: ${st} row ${seat} (role ${held.role}) dropped — ${seat} now bound to ${teamName}`);
    }
    const prior = mine;
    if (prior && rowState(prior) !== 'live') {
      logLine('info', `team ${teamName}: ${rowState(prior)} row ${seat} (role ${prior.role}) overwritten by ${by}`);
    }
    const row = {
      seat, role, gen: gen !== undefined ? gen : genOf(seat), since: now(), by,
      ...(ticket ? { ticket } : {}),
    };
    writeRoster(teamName, [...own.team.roster.filter((r) => r.seat !== seat), row]);
    return { ok: true, team: teamName, row };
  }

  function bindSeat(teamName, seat, role, opts = {}) {
    return onChain(() => bindNow(teamName, seat, role, opts));
  }

  function unbindSeat(teamName, seat) {
    return onChain(() => {
      let team;
      try { team = loadManifest(teamName); } catch (err) { return { ok: false, error: err.message }; }
      if (seat === team.lead) return { ok: false, error: `${seat} is team ${teamName}'s lead — set-lead another seat first` };
      const row = team.roster.find((r) => r.seat === seat);
      if (!row) return { ok: false, error: `${seat} is not on team ${teamName}'s roster` };
      writeRoster(teamName, team.roster.filter((r) => r.seat !== seat));
      return { ok: true, team: teamName, row };
    });
  }

  function renameSeatRow(oldName, newName) {
    return onChain(() => {
      const moved = [];
      for (const { team } of loadAll()) {
        const q = heldQuarantine(team.name);
        const held = !!(q && q.seats.includes(oldName));
        if (!held && !team.roster.some((r) => r.seat === oldName)) continue;
        const carried = q ? { file: q.file, seats: q.seats.map((x) => (x === oldName ? newName : x)) } : null;
        writeRoster(team.name, team.roster.filter((r) => r.seat !== newName).map((r) => (r.seat === oldName ? { ...r, seat: newName } : r)), carried);
        moved.push(team.name);
      }
      return { ok: true, teams: moved };
    });
  }

  function rosterOf(teamName) {
    const { team, rosterState } = loadManifestFull(teamName);
    return {
      team,
      rows: team.roster.map((r) => ({ ...r, state: rowState(r) })),
      quarantine: rosterState.quarantine,
    };
  }

  function pruneStaleRows() {
    return onChain(() => {
      const pruned = [];
      const seenNow = new Set();
      for (const { team } of loadAll()) {
        const stale = team.roster.filter((r) => r.seat !== team.lead && rowState(r) === 'stale');
        for (const r of stale) seenNow.add(`${team.name}\0${r.seat}`);
        const drop = stale.filter((r) => staleSeen.has(`${team.name}\0${r.seat}`));
        if (!drop.length) continue;
        writeRoster(team.name, team.roster.filter((r) => !drop.includes(r)));
        for (const r of drop) {
          pruned.push({ team: team.name, seat: r.seat });
          logLine('info', `team ${team.name}: stale row ${r.seat} (role ${r.role}) pruned — no record, no session`);
        }
      }
      staleSeen = seenNow;
      return pruned;
    });
  }

  function synthesiseRosters(records, { dryRun = false } = {}) {
    const loaded = loadAll();
    const lines = [];
    const fresh = new Map();
    for (const l of loaded) if (l.rosterState.absent) fresh.set(l.team.name, []);
    if (!fresh.size) return { lines, rosters: {} };
    const claimed = new Map();
    for (const { team } of loaded) for (const r of team.roster) claimed.set(r.seat, team.name);
    const at = now();
    const recs = (Array.isArray(records) ? records : []).filter((r) => r && typeof r.name === 'string' && NAME_RE.test(r.name));
    const recGen = (seat) => {
      const r = recs.find((x) => x.name === seat);
      return r && typeof r.createdAt === 'number' ? r.createdAt : null;
    };
    const add = (teamName, seat, role) => {
      if (claimed.has(seat)) {
        if (claimed.get(seat) !== teamName) lines.push(`ambiguous: ${seat} → ${claimed.get(seat)} (already claimed; not added to ${teamName})`);
        return;
      }
      claimed.set(seat, teamName);
      fresh.get(teamName).push({ seat, role, gen: recGen(seat), since: at, by: 'migration' });
      lines.push(`team ${teamName}: roster synthesised — ${seat} as ${role}`);
    };
    for (const { team } of loaded) if (fresh.has(team.name)) add(team.name, team.lead, 'lead');
    for (const rec of recs) {
      if (typeof rec.cwd !== 'string' || !rec.cwd) continue;
      const cands = loaded.map((l) => l.team)
        .filter((t) => !t.sandboxed && cwdInProject(rec.cwd, t.root))
        .sort((a, b) => (b.root.length - a.root.length) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (!cands.length) continue;
      const pick = cands[0];
      if (!fresh.has(pick.name) || rec.name === pick.lead) continue;
      const role = nameRole(pick, rec.name);
      if (!role) continue;
      if (cands.length > 1) lines.push(`ambiguous: ${rec.name} → ${pick.name} (deepest root)`);
      add(pick.name, rec.name, role);
    }
    const rosters = Object.fromEntries(fresh);
    if (!dryRun) {
      for (const [teamName, rows] of fresh) writeRoster(teamName, rows);
      for (const l of lines) logLine('info', l);
    }
    return { lines, rosters };
  }

  function findProjectRoot(cwd) {
    const team = teamOfCwd(cwd);
    return team ? team.root : null;
  }

  function assertTeamName(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`team name "${name}" must match ${NAME_RE}`);
    }
    // NAME_RE accepts `.hidden`, but listTeams skips dot-directories — so a
    // dot-named team would be written and then never listed, never resolved for
    // any cwd, while loadManifest still opens it by path.
    if (name.startsWith('.')) {
      throw new Error(`team name "${name}" must not start with "." — listTeams skips dot-directories, so the team would be invisible`);
    }
  }

  function createTeam({ name, root, lead, roles, kit, sandboxed, dryRun } = {}) {
    assertTeamName(name);
    const resolvedKit = resolveKit(kit);
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new Error(`team "${name}" root must be an absolute path`);
    }
    if (typeof lead !== 'string' || !NAME_RE.test(lead)) {
      throw new Error(`team "${name}" lead must be a seat name matching ${NAME_RE}`);
    }
    const file = path.join(teamsDir, name, TEAM_FILE);
    let exists = false;
    try { fs.readFileSync(file, 'utf-8'); exists = true; } catch {}
    if (exists) throw new Error(`team "${name}" already exists`);
    const resolvedRoot = path.resolve(root);
    for (const other of listTeams()) {
      let m;
      try { m = loadManifest(other); } catch { continue; }
      if (m.root === resolvedRoot) {
        throw new Error(`team "${other}" already owns root ${resolvedRoot}`);
      }
    }
    const holder = liveHolder(lead, name);
    if (holder) throw new Error(`${lead} is on team ${holder.team}'s roster (role ${holder.role}) — unbind it there first`);
    if (dryRun) return null;
    const kitRoles = resolvedKit && Object.keys(resolvedKit.roles).length ? resolvedKit.roles : null;
    const defaultRoles = kitRoles || {
      lead: { ...STOCK_ROLE_DEFS.lead },
      hand: { ...STOCK_ROLE_DEFS.hand },
      scout: { ...STOCK_ROLE_DEFS.scout },
      'page-scout': { ...STOCK_ROLE_DEFS['page-scout'] },
      // No `tools` here: the reviewer's cap is REVIEWER_TOOL_CAP in
      // session-manager, the one path that can enforce it.
      reviewer: { ...STOCK_ROLE_DEFS.reviewer },
    };
    const callerRoles = roles && typeof roles === 'object' && !Array.isArray(roles) && Object.keys(roles).length
      ? roles : null;
    const seedRoles = {};
    for (const [k, v] of Object.entries(callerRoles || defaultRoles)) {
      seedRoles[k] = pickRoleKeys(v);
      // createTeam takes an arbitrary caller `roles` object, so it is a write path
      // too: without this a new file could be born naming lead a worktree role.
      assertDispatchAllowed(k, seedRoles[k], file);
      assertRoleCwd(k, seedRoles[k], resolvedRoot, file);
    }
    const kitDir = resolvedKit ? resolvedKit.dir : null;
    const templatesCopied = copyRoleTemplates(name, seedRoles, { kitDir });
    let promptsCopied;
    try {
      promptsCopied = copyRolePrompts(name, seedRoles, { kitDir });
    } catch (err) {
      unwindTemplateCopies(name, templatesCopied);
      throw err;
    }
    let execCopied;
    try {
      execCopied = copyKitExec(name, kitDir);
    } catch (err) {
      unwindTemplateCopies(name, templatesCopied);
      unwindPromptCopies(name, promptsCopied);
      throw err;
    }
    const manifest = {
      version: MANIFEST_VERSION,
      lead,
      root: resolvedRoot,
      ...(sandboxed === true ? { sandboxed: true } : {}),
      ...(resolvedKit ? { kit: resolvedKit.name } : {}),
      roles: seedRoles,
    };
    let loaded;
    try {
      atomicWrite(file, JSON.stringify(manifest, null, 2));
      const leadBind = bindNow(name, lead, 'lead', { by: 'create' });
      if (!leadBind.ok) logLine('warn', `team ${name}: lead row not written — ${leadBind.error}`);
      loaded = loadManifest(name);
    } catch (err) {
      try { fs.unlinkSync(rosterPath(name)); } catch {}
      try { fs.unlinkSync(file); } catch {}
      unwindTemplateCopies(name, templatesCopied);
      unwindPromptCopies(name, promptsCopied);
      unwindExecCopies(name, execCopied);
      try { fs.rmdirSync(path.join(teamsDir, name)); } catch {}
      throw err;
    }
    return { ...loaded, templatesCopied, promptsCopied, execCopied, kitSeeded: resolvedKit ? resolvedKit.name : null };
  }

  function addRole(teamName, roleName, def, opts) {
    const team = loadManifest(teamName); // throws if the team is missing
    const operator = !!(opts && opts.operator === true);
    const teamKit = readKit(team.kit);
    const kitDir = teamKit ? teamKit.dir : null;
    if (!ROLE_RE.test(roleName)) {
      throw new Error(`role name "${roleName}" must match ${ROLE_RE} (${team.file})`);
    }
    // `def` is IGNORED, not merged and not validated, so remove-then-re-add gains
    // an attacker nothing. Do not "fix" this into honouring the caller's def; that
    // hands back the bypass. Ahead of the def validation below, so a def nobody
    // reads cannot refuse the write.
    if (operator && RESERVED_ROLE_KEYS.has(roleName) && !team.roles[roleName]) {
      const kitDef = (teamKit && teamKit.roles[roleName]) || null;
      const stock = kitDef || STOCK_ROLE_DEFS[roleName];
      if (!stock) {
        throw new Error(`no stock definition ships for the "${roleName}" role (${team.file})`);
      }
      const rawMint = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
      rawMint.roles = rawMint.roles || {};
      rawMint.roles[roleName] = pickRoleKeys({ ...stock });
      const accountCarried = carryAccount(rawMint, roleName);
      if (accountCarried) rawMint.roles[roleName].account = accountCarried;
      // Inert while the stock defs carry only prompt/brief, but this is the one
      // write path that would not otherwise refuse a reserved role paired with
      // `dispatch: "worktree"`.
      assertDispatchAllowed(roleName, rawMint.roles[roleName], team.file);
      assertRoleCwd(roleName, rawMint.roles[roleName], team.root, team.file);
      const mintCopied = copyRoleTemplates(teamName, { [roleName]: rawMint.roles[roleName] }, { kitDir });
      let mintPrompts;
      try {
        mintPrompts = copyRolePrompts(teamName, { [roleName]: rawMint.roles[roleName] }, { kitDir });
      } catch (err) {
        unwindTemplateCopies(teamName, mintCopied);
        throw err;
      }
      try {
        atomicWrite(team.file, JSON.stringify(migrateRoles(rawMint), null, 2));
      } catch (err) {
        unwindTemplateCopies(teamName, mintCopied);
        unwindPromptCopies(teamName, mintPrompts);
        throw err;
      }
      return {
        ...loadManifest(teamName), templatesCopied: mintCopied, promptsCopied: mintPrompts,
        minted: kitDef ? `kit:${teamKit.name}` : 'stock', accountCarried,
      };
    }
    // Read on the load path, but must never enter through a WRITE: pickRoleKeys
    // drops it and emits no `dispatch`, so an addRole carrying `worktree: true`
    // would store a standing role and answer {ok:true}.
    if (def && typeof def === 'object' && !Array.isArray(def) && 'worktree' in def) {
      throw new Error(`role "${roleName}": "worktree" was replaced by "dispatch" — use dispatch: "worktree" (${team.file})`);
    }
    const normalized = normalizeRoleDef(roleName, def, team.file);
    assertDispatchAllowed(roleName, normalized, team.file);
    assertRoleCwd(roleName, normalized, team.root, team.file);
    if (normalized.template != null && !NAME_RE.test(normalized.template)) {
      throw new Error(`role "${roleName}" template must be a library-template name matching ${NAME_RE} (${team.file})`);
    }
    copyRoleTemplates(teamName, { [roleName]: normalized }, { repointOnly: true, kitDir });
    copyRolePrompts(teamName, { [roleName]: normalized }, { repointOnly: true, kitDir });
    const existing = team.roles[roleName];
    // Never mint an absent reserved key from a def: loadManifest only requires
    // `lead`, so a hand-deleted `reviewer` could otherwise be re-added with an
    // attacker-authored def.
    if (RESERVED_ROLE_KEYS.has(roleName) && !existing) {
      throw new Error(`the "${roleName}" role is operator-owned topology; add it via the app, not an intent/mutator (${team.file})`);
    }
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(normalized)) return { ...team, templatesCopied: [], promptsCopied: [] }; // no-op
      throw new Error(`role "${roleName}" already exists on team "${teamName}" with a different definition`);
    }
    // Re-read raw to preserve hand-authored fields on the OTHER roles. The new
    // role goes through pickRoleKeys, not verbatim: a verbatim write lands
    // `tools: ["Read"]` on disk, where read-back drops it but the file reads as
    // a policy.
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    raw.roles[roleName] = pickRoleKeys(def);
    const stashed = carryAccount(raw, roleName);
    const ownAccount = raw.roles[roleName].account;
    const accountCarried = (typeof ownAccount === 'string' && ownAccount.trim()) ? null : stashed;
    if (accountCarried) raw.roles[roleName].account = accountCarried;
    const templatesCopied = copyRoleTemplates(teamName, { [roleName]: raw.roles[roleName] }, { kitDir });
    let promptsCopied;
    try {
      promptsCopied = copyRolePrompts(teamName, { [roleName]: raw.roles[roleName] }, { kitDir });
    } catch (err) {
      unwindTemplateCopies(teamName, templatesCopied);
      throw err;
    }
    try {
      atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    } catch (err) {
      unwindTemplateCopies(teamName, templatesCopied);
      unwindPromptCopies(teamName, promptsCopied);
      throw err;
    }
    return { ...loadManifest(teamName), templatesCopied, promptsCopied, accountCarried };
  }

  function setRole(teamName, roleName, patch, opts = {}) {
    const team = loadManifest(teamName); // throws if the team is missing
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error(`setRole patch must be an object (${team.file})`);
    }
    if (RESERVED_ROLE_KEYS.has(roleName)) {
      const ownDerived = (k) => k === 'template' && !!(opts && opts.ownDerivedTemplate) && patch.template === roleName;
      const operatorPick = (k) => k === 'template' && roleName === 'reviewer' && !!(opts && opts.operator === true);
      const outside = Object.keys(patch).filter((k) => !RESERVED_ROLE_PATCH_FIELDS.has(k) && !ownDerived(k) && !operatorPick(k));
      if (outside.length) {
        throw new Error(`the "${roleName}" role is operator-owned topology; edit it via the app, not an intent/mutator — only ${[...RESERVED_ROLE_PATCH_FIELDS].join(', ')} may be patched here, not ${outside.join(', ')} (${team.file})`);
      }
    }
    if (!team.roles[roleName]) {
      throw new Error(`role "${roleName}" not found on team "${teamName}" — use addRole (${team.file})`);
    }
    const EDITABLE = EDITABLE_ROLE_FIELDS;
    const clean = {};
    for (const k of EDITABLE) {
      if (k in patch) clean[k] = patch[k];
    }
    // `template` is descriptive-only: validated as a name here and resolved
    // nowhere. Any future consumption must go through the normal spawn gate.
    if ('template' in clean && (typeof clean.template !== 'string' || !NAME_RE.test(clean.template))) {
      throw new Error(`role "${roleName}" template must be a library-template name matching ${NAME_RE} (${team.file})`);
    }
    if ('dispatch' in clean && !ROLE_DISPATCH_VALUES.has(clean.dispatch)) {
      throw new Error(`role "${roleName}" dispatch must be one of ${[...ROLE_DISPATCH_VALUES].join(', ')} (${team.file})`);
    }
    // Validated on `clean` (the patch), not the merged def, which preserves an
    // EXISTING cwd a stale check could re-refuse. Gated on CHANGE, not presence:
    // the popover's save patch always carries `cwd`, so re-validating an unchanged
    // value makes an unrelated edit fail once that directory is deleted.
    const storedCwd = typeof team.roles[roleName].cwd === 'string' ? team.roles[roleName].cwd : '';
    const patchCwd = typeof clean.cwd === 'string' ? clean.cwd.trim() : null;
    if ('cwd' in clean && !(patchCwd !== null && patchCwd === storedCwd)) {
      assertRoleCwd(roleName, clean, team.root, team.file);
    }
    // Trimmed AFTER the gate: this write does not go through pickRoleKeys, so
    // without it the merge below lands untrimmed bytes assertRoleCwd never saw.
    if (typeof clean.cwd === 'string') clean.cwd = clean.cwd.trim();
    if (typeof clean.account === 'string') clean.account = clean.account.trim();
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    // NOT picked down to the schema, unlike addRole's new role: this preserves an
    // existing role's hand-authored keys, and `clean` is already EDITABLE-only.
    raw.roles[roleName] = { ...raw.roles[roleName], ...clean };
    // A blank cwd is a CLEAR and deletes the key rather than storing '':
    // path.resolve(root, '') is the root, so '' means what its absence means.
    if ('cwd' in clean && !String(clean.cwd == null ? '' : clean.cwd).trim()) {
      delete raw.roles[roleName].cwd;
    }
    if ('account' in clean && !String(clean.account == null ? '' : clean.account).trim()) {
      delete raw.roles[roleName].account;
    }
    normalizeRoleDef(roleName, raw.roles[roleName], team.file);
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  // `opts.operator` is the renderer's opt-in and nothing else passes it: the
  // `[agent:team role-rm]` intent calls this with two args, so an agent still gets
  // the refusal below.
  function removeRole(teamName, roleName, opts) {
    const team = loadManifest(teamName);
    const operator = !!(opts && opts.operator === true);
    // Non-removable for everyone, operator included: loadManifest hard-requires
    // the key and every caller resolves teams in a best-effort catch, so a team
    // that lost its lead would read as "no team at all" everywhere at once.
    if (roleName === 'lead') {
      throw new Error(`the "lead" role cannot be removed: a team.json without it fails to load, and the team would read as missing everywhere (${team.file})`);
    }
    if (RESERVED_ROLE_KEYS.has(roleName) && !operator) {
      throw new Error(`the "${roleName}" role is operator-owned topology; remove it via the app, not an intent/mutator (${team.file})`);
    }
    if (!team.roles[roleName]) {
      throw new Error(`role "${roleName}" not found on team "${teamName}" (${team.file})`);
    }
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    const label = team.roles[roleName].account;
    if (typeof label === 'string' && label.trim()) {
      raw.removedRoleAccounts = { ...stashOf(raw), [roleName]: label.trim() };
    } else {
      dropStash(raw, roleName);
    }
    if (raw.roles) delete raw.roles[roleName];
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    rewriteRosterRows(teamName, (rows) => rows.filter((r) => !(r && r.role === roleName)));
    return loadManifest(teamName);
  }

  function deleteTeam(teamName) {
    assertTeamName(teamName);
    const dir = path.join(teamsDir, teamName);
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch {}
    if (!isDir) throw new Error(`team "${teamName}" does not exist`);
    fs.rmSync(dir, { recursive: true, force: true });
    return { name: teamName, dir };
  }

  function renameRole(teamName, fromName, toName) {
    const team = loadManifest(teamName);
    if (RESERVED_ROLE_KEYS.has(fromName) || RESERVED_ROLE_KEYS.has(toName)) {
      throw new Error(`the "lead"/"reviewer" roles are operator-owned topology and cannot be renamed (${team.file})`);
    }
    if (!ROLE_RE.test(toName)) {
      throw new Error(`role name "${toName}" must match ${ROLE_RE} (${team.file})`);
    }
    if (!team.roles[fromName]) {
      throw new Error(`role "${fromName}" not found on team "${teamName}" (${team.file})`);
    }
    if (team.roles[toName]) {
      throw new Error(`role "${toName}" already exists on team "${teamName}" (${team.file})`);
    }
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.roles = raw.roles || {};
    const def = raw.roles[fromName];
    const owned = [['template', 'templates', '.json'], ['prompt', path.join('prompts', 'system'), '.md']]
      .filter(([key]) => def && def[key] === fromName
        && !Object.entries(raw.roles).some(([k, d]) => k !== fromName && d && d[key] === fromName))
      .map(([key, sub, ext]) => ({
        key,
        from: path.join(teamsDir, teamName, sub, `${fromName}${ext}`),
        to: path.join(teamsDir, teamName, sub, `${toName}${ext}`),
      }))
      .filter((mv) => fs.existsSync(mv.from));
    for (const mv of owned) {
      if (fs.existsSync(mv.to)) {
        throw new Error(`role "${fromName}" cannot be renamed to "${toName}": ${mv.to} already exists (${team.file})`);
      }
    }
    const moved = [];
    try {
      for (const mv of owned) {
        fs.renameSync(mv.from, mv.to);
        moved.push(mv);
        def[mv.key] = toName;
      }
      raw.roles[toName] = def;
      delete raw.roles[fromName];
      atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
      rewriteRosterRows(teamName, (rows) => rows.map((r) => (r && r.role === fromName ? { ...r, role: toName } : r)));
    } catch (err) {
      for (const mv of moved.reverse()) {
        try { fs.renameSync(mv.to, mv.from); } catch {}
      }
      throw err;
    }
    return loadManifest(teamName);
  }

  // Re-points the lead SEAT pointer, NOT the `lead` role, which stays reserved.
  // Only the charset is gated — every team has a stopped lead sometimes, so an
  // existence check would refuse the legitimate case.
  function setLead(teamName, seatName) {
    const team = loadManifest(teamName); // throws if the team is missing
    if (typeof seatName !== 'string' || !NAME_RE.test(seatName)) {
      throw new Error(`team "${teamName}" lead must be a seat name matching ${NAME_RE} (${team.file})`);
    }
    const holder = liveHolder(seatName, teamName);
    if (holder) throw new Error(`${seatName} is on team ${holder.team}'s roster (role ${holder.role}) — unbind it there first`);
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.lead = seatName;
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    const prior = team.lead;
    onChain(() => {
      let cur;
      try { cur = loadManifest(teamName); } catch { return; }
      const rows = cur.roster.filter((r) => !(r.seat === prior && r.role === 'lead' && prior !== seatName));
      if (rows.length !== cur.roster.length) writeRoster(teamName, rows);
      const r = bindNow(teamName, seatName, 'lead', { by: 'set-lead' });
      if (!r.ok) logLine('warn', `team ${teamName}: lead row for ${seatName} not written — ${r.error}`);
    }).catch(() => {});
    return loadManifest(teamName);
  }

  function setTeamWatchdog(teamName, ms) {
    const team = loadManifest(teamName); // throws if the team is missing
    if (ms != null && (typeof ms !== 'number' || !Number.isFinite(ms))) {
      throw new Error(`watchdogMs must be a finite number or null (${team.file})`);
    }
    if (ms != null && ms <= 0) {
      throw new Error(`watchdogMs must be positive, or null to clear it (${team.file})`);
    }
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    if (ms == null) delete raw.watchdogMs;
    else raw.watchdogMs = ms;
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  function setTeamTrunk(teamName, branch) {
    const team = loadManifest(teamName);
    const blank = branch == null || (typeof branch === 'string' && !branch.trim());
    const trunk = blank ? null : normalizeTrunk(branch);
    if (!blank && !trunk) {
      throw new Error(`trunk must be a branch name matching ${TRUNK_RE}, not starting with "-" and without ".." (${team.file})`);
    }
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    if (trunk == null) delete raw.trunk;
    else raw.trunk = trunk;
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  function setTeamWorktrees(teamName, value) {
    const team = loadManifest(teamName);
    const v = normalizeWorktrees(value);
    if (!v) throw new Error(`worktrees must be one of ${WORKTREES_VALUES.join(' | ')} (${team.file})`);
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.worktrees = v;
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  function setTeamMaxHands(teamName, value) {
    const team = loadManifest(teamName);
    const n = value === null ? null : normalizeMaxHands(value);
    if (value !== null && !n) throw new Error(`maxHands must be a positive integer, or null for off (${team.file})`);
    const raw = JSON.parse(fs.readFileSync(team.file, 'utf-8'));
    raw.maxHands = n;
    atomicWrite(team.file, JSON.stringify(migrateRoles(raw), null, 2));
    return loadManifest(teamName);
  }

  return {
    resolveTeam: teamOfCwd, teamOfCwd, teamsOfCwd, teamOfSeat, teamOf, findProjectRoot, loadManifest, listTeams, cwdInProject,
    bindSeat, unbindSeat, renameSeatRow, rosterOf, pruneStaleRows, synthesiseRosters, setSeatLookup,
    createTeam, deleteTeam, addRole, setRole, removeRole, renameRole, setTeamWatchdog, setTeamTrunk, setTeamWorktrees, setTeamMaxHands, setLead,
    listKits, kitCatalog, resolveKit,
    teamsDir, TEAM_FILE, ROSTER_FILE,
  };
}

function matchSeatRole(team, seatName) {
  if (!team || !seatName || !team.roles) return null;
  if (seatName === team.lead) return 'lead' in team.roles ? 'lead' : null;
  const row = Array.isArray(team.roster) ? team.roster.find((r) => r && r.seat === seatName) : null;
  if (row && Object.prototype.hasOwnProperty.call(team.roles, row.role)) return row.role;
  return nameRole(team, seatName);
}

// A name this cannot decompose resolves to no role at all — off the roster, no
// role prompt, and past the fail-CLOSED `_roleInUse` guard in session-manager.js.
//
// The collision suffix is not only `-N`: `shop-hand2` must strip too. EXACT MATCH
// WINS before any stripping, since a role may be named `hand2`. Only digit
// suffixes strip. `-rN` is the one lettered tail, stripped ahead of the numeric
// one — a ticket's reviewer is `<team>-reviewer-<ticket>-r<round>` and both tails
// must go or the key keeps the ticket number.
function nameRole(team, seatName) {
  if (!team || !seatName || !team.roles) return null;
  if (seatName === team.lead) return 'lead' in team.roles ? 'lead' : null;
  const prefix = `${team.name}-`;
  if (!seatName.startsWith(prefix)) return null;
  // hasOwnProperty, not `in`: `in` walks the prototype, so a seat named
  // `<team>-toString` would otherwise "resolve" to a role that is Object's method.
  const has = (k) => Object.prototype.hasOwnProperty.call(team.roles, k);
  const suffix = seatName.slice(prefix.length);
  if (has(suffix)) return suffix;
  const key = suffix.replace(/-r\d+$/, '').replace(/[-_]?\d+$/, '');
  return key && has(key) ? key : null;
}

function rosterExecPayload(seatName) {
  // Serialized, not interpolated: this pure leaf cannot see the caller's name
  // grammar, so an unvalidated seat name could break the JSON.
  return `[agent:exec clodex-team] ${JSON.stringify({ action: 'roster', agent: seatName || '<your name>' })}`;
}

// Per-role invariants ONLY — this text is part of the cache-stable system prompt,
// so the roster listing stays out and the output carries the role, never the
// seat name.
function formatTeamBlock(team, seatName) {
  const mine = matchSeatRole(team, seatName);
  const yourRole = mine || 'none — not a manifest role';
  return [
    '# Team',
    `You are on team ${team.name} (root ${team.root}). Your role: ${yourRole}.`,
    `Team composition arrives in your context. Ground truth on demand: ${rosterExecPayload(null)}`,
  ].join('\n');
}

// Derived from the manifest rather than stored on the def: reachability is a
// consequence of the reserved `reviewer` key plus the code that routes the spawn.
function leadActionLine(team) {
  const sessionRoles = [];
  let hasReviewer = false;
  for (const role of Object.keys(team.roles || {})) {
    // `team.lead` is a SEAT name — comparing against it here would drop an
    // unrelated role from a team whose lead seat shares its name.
    if (role === 'lead') continue;
    if (role === 'reviewer') { hasReviewer = true; continue; }
    sessionRoles.push(role);
  }
  const parts = [];
  // The "Dispatch:" prefix is the token three roster tests assert the ABSENCE of
  // for a non-lead seat. Rewording the line without it defangs all three silently.
  if (sessionRoles.length) parts.push('Dispatch: TWO steps, or one. [agent:task add <role>] <spec> writes the ticket and starts NOTHING, then [agent:task start <id>] mints its tree and seat and delivers the spec; [agent:task add <role> start] <spec> does both in one intent and tells you the id in a single reply. A "do not start" line in the body is NOT read by anything — an unstarted ticket is simply one you have not started.');
  // Spells out that the intent does the spawning: a lead that reaches for its
  // harness subagent tool instead gets a reviewer with no tools cap, no verdict
  // intent, and no seat the operator can see.
  if (hasReviewer) parts.push('Review: [agent:team-review] <scope> — the intent spawns the cold reviewer seat itself; do NOT spawn or subagent one by hand.');
  if (sessionRoles.length) {
    parts.push(`New session seat: [agent:spawn name:${team.name}-<role> template:<tmpl>].`);
  }
  return parts.length ? parts.join(' ') : null;
}

// The two statuses never share a line: 'ignored' says the field configures
// nothing, 'honored' says deleting it changes behaviour.
//
// 'unknown' is rendered by neither, and that exclusion is what keeps this SAFE:
// an 'unknown' field name is an arbitrary agent-authored string from team.json,
// this roster is baked into the digest re-read on every context reset, and the
// intent parser is `^`-anchored — a key carrying a newline and a column-1 verb
// would fire in the lead's context. A surface that renders 'unknown' must refuse
// newlines first.
function retiredFieldLines(team, role) {
  const all = Array.isArray(team && team.droppedFields) ? team.droppedFields : [];
  const mine = all.filter((d) => d && d.role === role);
  const lines = [];
  const inert = mine.filter((d) => d.status === 'ignored').map((d) => d.field);
  if (inert.length) {
    lines.push(`  retired, configures nothing: ${inert.map((f) => `${role}.${f}`).join(', ')} — this schema does not read ${inert.length > 1 ? 'them' : 'it'}`);
  }
  for (const d of mine.filter((x) => x.status === 'honored')) {
    lines.push(`  retired but STILL READ here: ${role}.${d.field} — deleting it CHANGES BEHAVIOUR; write \`${d.remedy}\` instead`);
  }
  return lines;
}

const ROSTER_DEFINITIONS_LINE = 'Roles without a live seat are definitions; briefs live in team.json.';

// The label is never computed here — team-manifest is a pure leaf and warmth is a
// wire-layer property, so it arrives as data.
function formatRoster(team, liveSeats = [], { seat = null, grants = null, efforts = null, brief = false } = {}) {
  if (brief) {
    const role = seat ? matchSeatRole(team, seat) : null;
    return [
      `[team ${team.name}] roster (lead: ${team.lead})`,
      `- you: ${role ? `${role} (ticket seat)` : 'ticket seat'}; your lead: ${team.lead} — dm it with [agent:dm ${team.lead}]; the full roster is not shipped to a ticket seat`,
    ].join('\n');
  }
  const byRole = new Map();
  const roleless = [];
  for (const entry of liveSeats) {
    const name = typeof entry === 'string' ? entry : (entry && entry.name);
    if (!name) continue;
    const label = typeof entry === 'string' ? null : (entry && entry.label) || null;
    const suffix = name === seat ? ' (you)' : (label ? ` (${label})` : '');
    const role = matchSeatRole(team, name);
    if (!role) { roleless.push(`${name}${suffix}`); continue; }
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(`${name}${suffix}`);
  }
  const lines = [`[team ${team.name}] roster (lead: ${team.lead})`];
  let definitionsOnly = false;
  for (const [role, def] of Object.entries(team.roles)) {
    // Name [agent:team-review] ONLY to the seat allowed to use it:
    // _handleTeamReview bounces a non-lead.
    const cls = role !== 'reviewer' ? 'session'
      : (seat && seat === team.lead ? 'via [agent:team-review]' : 'lead-only');
    // Suppressed on the reviewer: [agent:team-review] resolves the template
    // itself, so printing one invites the hand-spawn the row exists to prevent.
    const tmpl = (role !== 'reviewer' && def && typeof def.template === 'string' && def.template) ? `, tmpl ${def.template.replace(/[\r\n]+/g, ' ')}` : '';
    const brief = def && def.brief ? ` — ${String(def.brief).replace(/[\r\n]+/g, ' ')}` : '';
    const live = byRole.get(role);
    const isLive = !!(live && live.length);
    const full = isLive || role === 'lead';
    if (!full) definitionsOnly = true;
    const liveStr = isLive
      ? ` · live: ${live.join(', ')}`
      : (full ? ' · no live seat — role definition only, not addressable' : '');
    const account = (def && typeof def.account === 'string' && def.account) ? ` · account: ${def.account.replace(/[\r\n]+/g, ' ')}` : '';
    const effortStr = (efforts && typeof efforts[role] === 'string' && efforts[role]) ? ` · effort ${efforts[role].replace(/[\r\n]+/g, ' ')}` : '';
    lines.push(`- ${role} (${cls}${tmpl})${effortStr}${account}${full ? brief : ''}${liveStr}`);
    for (const l of retiredFieldLines(team, role)) lines.push(l);
  }
  if (definitionsOnly) lines.push(ROSTER_DEFINITIONS_LINE);
  if (roleless.length) lines.push(`also live, no role: ${roleless.join(', ')}`);
  if (seat && seat === team.lead) {
    const action = leadActionLine(team);
    if (action) lines.push(action);
  }
  lines.push(Array.isArray(grants) && !grants.includes('clodex-team')
    ? 'Ground truth on demand: [agent:exec clodex-team] is NOT granted to this seat'
      + ' — Edit Session ▸ Exec commands, or respawn on a template that carries it (clodex-team-lead does)'
    : `Ground truth on demand: ${rosterExecPayload(seat)}`);
  return lines.join('\n');
}

function formatCompositionDelta(teamName, verb, { seat = null, role = null } = {}) {
  if (verb === 'added') return `[team ${teamName}] role ${role} added (no seat)`;
  return `[team ${teamName}] seat ${seat} ${verb}${role ? ` (role: ${role})` : ''}`;
}

module.exports = {
  createTeamManifest, matchSeatRole, nameRole, formatTeamBlock, formatRoster,
  formatCompositionDelta, defaultLeadSeat, ROSTER_DEFINITIONS_LINE, SEAT_NAME_MAX, STOCK_ROLE_DEFS, TEAM_FILE, ROSTER_FILE, ROSTER_PRUNE_MIN_AGE_MS,
  // Exported so the retired-field warn test iterates the REAL list — a copy in
  // the test would keep passing over a field added here and never warned about.
  ROLE_KEYS, CUT_ROLE_FIELDS, HONORED_CUT_FIELDS, EDITABLE_ROLE_FIELDS, UNREACHABLE_ROLE_FIELDS, MANIFEST_VERSION,
  ROLE_DISPATCH_VALUES, DEFAULT_ROLE_DISPATCH, normalizeTrunk, TRUNK_HEAD, WORKTREES_VALUES, normalizeWorktrees, normalizeMaxHands, effectiveHandCap,
  ROLE_RE, RESERVED_ROLE_KEYS, RESERVED_ROLE_PATCH_FIELDS, NAME_RE,
};
