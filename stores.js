
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { envKeyError } = require('./env-scopes');
const { parseAgentFrontmatter } = require('./agents-util');
const { parseSkillFrontmatter } = require('./skills-util');
// The CLI's own context validator, entered by its PUBLIC door (validateEntry).
// Reused rather than re-implemented so a peer's typed cloud transport and a CLI
// context can never drift into two different ideas of a valid ssm block. The
// app may require cli/ because cli/ SHIPS (build.files, t32 step 0); the reverse
// direction stays forbidden — cli/ is a leaf and never requires an app file.
const { validateEntry } = require('./cli/src/contexts');
const { visibleTo } = require('./scope-util');
const { clampSidebarWidth } = require('./sidebar-width');
const { confineOrThrow } = require('./path-confine');
const {
  DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, THEME_KEYS,
  CLAUDE_TOOLS, DEFAULT_TOOL_DENY_FLOOR,
} = require('./catalogs');

const PROMPT_KINDS = ['system', 'append'];
const PROMPT_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/; // mirrors session/agent name rule

const DEFAULT_SANDBOX_CONFIG = {
  workDir: null,
  webPort: 7810,
  wirescopePort: 7811,
  wirePort: 7820,
  autoStart: false,
  image: null,
  mounts: [],
};

// A managed box's id is gated to the docker-compose PROJECT-name charset
// (lowercase, digits, dash/underscore) — sandbox.js pins the box's compose project
// off its id, and project names disallow dots/uppercase. Uniform: creation AND the
// sanitizer both enforce this, so no id that would collide two boxes onto one
// project can ever persist (M6b P2).
const BOX_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Reserved box ids — mirrors sandbox.js RESERVED_BOX_IDS. 'host' is the New Session
// placement selector's Mac value; a persisted box with that id would shadow it, so
// the sanitizer drops it too (creation already rejects it). M6b P3.
const RESERVED_BOX_IDS = new Set(['host']);

// Adding a key here is not enough — several hand-maintained lists repeat it,
// unchecked. Always `uiSettings._load`, or the persisted value is dropped on
// every read, including the one `set` merges onto, so the next unrelated save
// erases it; always `uiSettings.set`, or the key is unwritable and every save
// reverts it. Only if the renderer reads it via `getSettings`: the
// `settings:get` whitelist in ipc-handlers.js, where an omission arrives as
// undefined and reads as off. Only if Preferences' Save writes it: both halves
// of `openPrefs`.
const DEFAULT_UI_SETTINGS = {
  statusline: {
    claude: ['model', 'context', 'cost', 'cwd'],
    claudeCommand: '',
    codex: ['context-used', 'model-name', 'project-root', 'git-branch', 'five-hour-limit', 'current-dir'],
  },
  proxyEnabled: true,
  proxyUrl: 'http://127.0.0.1:7800',
  lastCustomProxyUrl: '',
  wirescopeDir: '',
  wirescopePort: 7800,
  compactOnResume: false,
  contextHints: false,
  semanticHints: false,
  selectionHints: false,
  voiceSubmit: false,
  voiceSubmitComposition: false,
  voiceSubmitRearm: false,
  voiceSubmitPhrase: 'over and out',
  speakReplies: false,
  // A NAME, never a variant: `say -v Daniel` resolves to whichever Daniel is
  // installed, so the free enhanced download upgrades the speech with no code
  // change. Daniel (en_GB) because it was the clearest across a room in the
  // operator's listening test — clarity is the criterion, not warmth.
  speakVoice: 'Daniel',
  // Words per minute. 210, not `say`'s ~175: the operator listened to 175, 210
  // and 240 and picked this one — 175 dragged, 240 was rushed.
  speakRate: 210,
  // New installs get the capability WITHOUT the firehose. Existing ones never
  // reach this value for this key — sanitizeTerminalReports resolves an absent
  // key to 'off' rather than falling through to the default.
  terminalReports: 'asked',
  discoverOnStartup: false,
  recentCwds: [],
  disableClaudeDesignMcp: false,
  theme: 'midnight',
  sidebarWidth: 220,
  remoteEnabled: false,
  remotePort: 7900,
  // Serve peer terminals. Unlike terminalReports there is no second door: the
  // absent-key answer below is the migration's `false`, so a new install and a
  // settings file without the key agree by construction.
  peerShellEnabled: false,
  peers: [],
  // Auto-reattach of peer tabs across app restarts: { [peerId]: [name, ...] }.
  // Kept OUTSIDE the peers array on purpose — the prefs dialog rebuilds that
  // array via collectPeers/sanitizePeers and would clobber any extra fields.
  // Written by the peer:attach / peer:detach handlers, pruned by syncPeerManager.
  peerAttached: {},
  peerVisible: {},
  peerControlled: {},
  boxes: [{ id: 'sandbox', label: 'sandbox', config: { ...DEFAULT_SANDBOX_CONFIG } }],
  lastRebootAt: 0,
  pendingRebootNotice: null,
  plugins: {},
};

// Every read of a default that a caller could MUTATE goes through here. `get()`
// hands its result to callers that edit it in place (the prefs dialog collects a
// settings object, edits, and writes it back), so handing out the module
// singleton or one of its nested arrays lets one caller's edit become the
// process-wide default for every later read — including reads by code that never
// touched settings. Pure JSON data, so the round-trip is the whole clone.
function defaultUiSettings() { return JSON.parse(JSON.stringify(DEFAULT_UI_SETTINGS)); }

// Shape-only, by design (see DEFAULT_UI_SETTINGS.plugins). Anything that isn't
// an object collapses to {} — a corrupt value must not make every plugin
// setting unreadable. Non-string entries in `enabled` are dropped rather than
// coerced: an id is matched by exact string equality downstream, so a coerced
// one would silently never match.
function sanitizePlugins(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { ...raw };
  if ('enabled' in out) {
    out.enabled = Array.isArray(out.enabled) ? out.enabled.filter((x) => typeof x === 'string') : [];
  }
  return out;
}

// `prior` is the CURRENT peers array: an entry that OMITS `token` carries the
// prior token forward by id — the Peers dialog round-trips `hasToken` only, so a
// plain label-edit save must not wipe it. An explicit '' clears it.
// WHITELIST: sanitizePeerCloud rebuilds only the fields named in this table, so
// a sub-key missing here is silently dropped on EVERY write. The names are the
// CLI argv-builders' own names — renaming one changes what gets dialled.
// `optional` fields are OMITTED when unset (never null): the builders test
// presence to decide whether to emit a flag. `reject` marks a field this side
// cannot dial: present ⇒ refuse the whole block rather than half-accept it.
const PEER_CLOUD_KINDS = {
  ssm:     { required: ['target'],   optional: ['region', 'profile'], reject: ['ecs'] },
  kubectl: { required: ['target'],   optional: ['namespace', 'context'] },
  gcloud:  { required: ['instance'], optional: ['zone', 'project'] },
  az:      { required: ['bastion', 'resourceGroup', 'target'] },
};

// DATA ONLY. A raw `tunnel` argv must NEVER become a peer-record field: this
// store is written from the renderer, so a persisted argv would be a
// GUI-editable command line the app later executes.
function sanitizePeerCloud(kind, raw) {
  const spec = PEER_CLOUD_KINDS[kind];
  if (!spec) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 256) : null);
  for (const f of spec.reject || []) {
    if (raw[f] != null && String(raw[f]) !== '') return null;
  }
  const out = {};
  for (const f of spec.required) {
    const v = str(raw[f]);
    if (!v) return null;
    out[f] = v;
  }
  for (const f of spec.optional || []) {
    const v = str(raw[f]);
    if (v) out[f] = v;      // absent, not null — the builders test presence
  }
  try { validateEntry({ [kind]: out }); } catch { return null; }
  return out;
}

// The human-facing name of a cloud destination, for a peer with no label of its
// own. Each kind's FIRST required field is the identifying one (ssm/kubectl
// target, gcloud instance), which is exactly what the table already knows.
function cloudLabel(cloud) {
  if (!cloud) return null;
  return cloud.block[PEER_CLOUD_KINDS[cloud.kind].required[0]] || null;
}

function sanitizePeers(raw, prior) {
  if (!Array.isArray(raw)) return null;
  const priorById = new Map(
    (Array.isArray(prior) ? prior : []).map((p) => [String(p && p.id), p]),
  );
  const out = [];
  for (const p of raw) {
    if (!p || typeof p.id !== 'string') continue;
    const url = typeof p.url === 'string' && /^https?:\/\//.test(p.url) ? p.url : null;
    const sshHost = typeof p.sshHost === 'string' && /^[a-zA-Z0-9._@-]{1,128}$/.test(p.sshHost) ? p.sshHost : null;
    let cloud = null;
    for (const kind of Object.keys(PEER_CLOUD_KINDS)) {
      const block = sanitizePeerCloud(kind, p[kind]);
      if (!block) continue;
      if (cloud) { cloud = null; break; }   // conflicting transports → drop both
      cloud = { kind, block };
    }
    if (!url && !sshHost && !cloud) continue;
    const deployFolder = typeof p.deployFolder === 'string' && p.deployFolder.trim()
      ? p.deployFolder.trim().slice(0, 256) : null;
    const entry = {
      id: p.id,
      label: typeof p.label === 'string' && p.label ? p.label : (sshHost || url || cloudLabel(cloud)),
      url, sshHost,
      ...(cloud ? { [cloud.kind]: cloud.block } : {}),
      remotePort: Number.isInteger(p.remotePort) ? p.remotePort : 7900,
      deployFolder,
      // Pause flag: preserved STRICTLY. setDisabled's enable path deletes the
      // key, so absence = enabled — never write `disabled: false` (would defeat
      // the absence invariant syncPeerManager reads). Only a hard `=== true`
      // survives; truthy-but-not-true is dropped.
      ...(p.disabled === true ? { disabled: true } : {}),
      ...(p.relayAllowed === true ? { relayAllowed: true } : {}),
      // No `shellAllowed` here on purpose: the peer-terminal grant is a
      // SERVING-side setting (top-level `peerShellEnabled`) and never belonged
      // on an outbound record. legacyShellGrant below reads the raw input for
      // it once, on upgrade; putting it back in this whitelist would give the
      // flag two homes that disagree.
    };
    let token;
    if (typeof p.token === 'string') {
      token = p.token.trim().slice(0, 256) || null;   // '' / whitespace clears
    } else {
      const prev = priorById.get(String(p.id));
      token = (prev && typeof prev.token === 'string' && prev.token) ? prev.token : null;
    }
    if (token) entry.token = token;
    out.push(entry);
  }
  return out;
}

// UPGRADE PATH for the peer-terminal grant, which used to live as
// `shellAllowed` on individual outbound peer records and is now the top-level
// `peerShellEnabled`. A version bump must never grant a capability the operator
// did not enable, nor revoke one they did — so any record that carried it means
// the box was serving and keeps serving, and no record means it does not start.
//
// MUST BE HANDED THE RAW `peers` INPUT, never the output of sanitizePeers:
// `shellAllowed` is no longer in that whitelist, so the sanitized array has
// already lost the flag. Reading it there silently revokes every upgrading
// box's grant, and the suite stays green because both halves live in this file
// and the wrong order reads as correct.
function legacyShellGrant(rawPeers) {
  return (Array.isArray(rawPeers) ? rawPeers : []).some((p) => !!(p && p.shellAllowed === true));
}

// Shared shape for the per-peer name maps (peerAttached, peerVisible): a plain
// object of peerId -> array of session names held to the same regex sessions
// use elsewhere. `keepEmpty` distinguishes the two callers: peerAttached drops
// empty arrays (an empty attach set is just noise), peerVisible keeps them (an
// empty array means "show none", which is meaningful). A non-object returns
// null so the caller can fall back to {}.
function sanitizePeerNameMap(raw, { keepEmpty }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [id, names] of Object.entries(raw)) {
    if (!Array.isArray(names)) continue;
    const clean = names.filter((n) => typeof n === 'string' && /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(n));
    if (clean.length || keepEmpty) out[id] = clean;
  }
  return out;
}

function sanitizePeerAttached(raw) {
  return sanitizePeerNameMap(raw, { keepEmpty: false });
}

function sanitizePeerVisible(raw) {
  return sanitizePeerNameMap(raw, { keepEmpty: true });
}

function sanitizePeerControlled(raw) {
  return sanitizePeerNameMap(raw, { keepEmpty: false });
}

// CRITICAL: this store is a WHITELIST — any key NOT reconstructed here is
// silently dropped on every write. `mounts` shipped without a line here and
// vanished on every round-trip; every persisted box-config sub-key must appear.
function sanitizeSandbox(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const port = (v, dflt) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? v : dflt);
  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    workDir: strOrNull(raw.workDir),
    webPort: port(raw.webPort, 7810),
    wirescopePort: port(raw.wirescopePort, 7811),
    wirePort: port(raw.wirePort, 7820),
    autoStart: raw.autoStart === true,
    image: strOrNull(raw.image),
    mounts: sanitizeSandboxMounts(raw.mounts),
  };
}

function sanitizeSandboxMounts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const host = typeof m.host === 'string' && m.host.trim() ? m.host.trim() : null;
    if (!host) continue;
    const entry = { host, ro: m.ro === true };
    if (typeof m.container === 'string' && m.container.trim()) entry.container = m.container.trim();
    out.push(entry);
  }
  return out;
}

// Returns null ONLY for non-array input: a persisted-but-empty `boxes: []` (the
// user deleted every box) must survive, while a MISSING key falls back to the
// default seed. Collapsing both to [] would re-seed an intentionally empty list.
function sanitizeBoxes(rawBoxes) {
  if (!Array.isArray(rawBoxes)) return null;
  const out = [];
  const seen = new Set();
  for (const b of rawBoxes) {
    if (!b || typeof b !== 'object') continue;
    const id = typeof b.id === 'string' && BOX_ID_RE.test(b.id) ? b.id : null;
    if (!id || seen.has(id) || RESERVED_BOX_IDS.has(id)) continue;
    seen.add(id);
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 64) : id;
    const config = sanitizeSandbox(b.config) ?? { ...DEFAULT_SANDBOX_CONFIG };
    out.push({ id, label, config });
  }
  return out;
}

// `attempts` is the retry ceiling's ONLY durable counter, so it has to survive
// this round-trip: the notice is re-written to settings after each delivery
// attempt, and a sanitizer that dropped the field would reset the count to 0
// every time and turn a bounded retry into an unbounded one.
function sanitizeRebootNotice(v) {
  if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name) return null;
  return {
    name: v.name,
    at: Number.isFinite(v.at) ? v.at : 0,
    reason: (typeof v.reason === 'string' ? v.reason : '').slice(0, 500),
    attempts: Number.isFinite(v.attempts) && v.attempts > 0 ? Math.floor(v.attempts) : 0,
  };
}

// Terminal reporting is a TRI-STATE because the old boolean conflated two
// independent things: whether the shell emits OSC 133 marks at all (capability
// — `[agent:term exec]` cannot answer without them) and whether the operator's
// own commands are pushed to the agent unasked (disclosure). "Let the agent run
// a command, but stop narrating everything I type" was unexpressable, and is
// almost certainly what most operators want.
const TERMINAL_REPORTS = ['off', 'asked', 'all'];

// The upgrade path, and the one place a version bump could hand an agent a
// capability nobody enabled. Both directions are deliberate:
//   true  -> 'all'  — they had the firehose and keep it.
//   false -> 'off'  — NOT 'asked'. They declined the capability too, as far as
//     anyone can tell from a boolean, and granting a privileged one during an
//     upgrade they did not ask for is the wrong default even when it is
//     probably what they want. One control, one click, once.
// A settings file carrying NEITHER key predates the feature entirely and lands
// on 'off' for the same reason — `_load`'s per-key fallback to the DEFAULT
// would otherwise let the new 'asked' default in through the other door.
function sanitizeTerminalReports(raw) {
  if (TERMINAL_REPORTS.includes(raw?.terminalReports)) return raw.terminalReports;
  if (typeof raw?.terminalReporting === 'boolean') return raw.terminalReporting ? 'all' : 'off';
  return 'off';
}

// The speech rate, resolved rather than rejected. `say -r` accepts any integer
// and speaks at it — 5 wpm narrates one sentence for minutes and looks exactly
// like a wedged box — so an out-of-range or non-integer value falls back to the
// chosen default instead of reaching the argv. Bounds match speaker.js's
// MIN_RATE/MAX_RATE; they are duplicated rather than imported because stores.js
// is loaded before whenReady and must stay free of the process side.
function sanitizeSpeakRate(raw) {
  return Number.isInteger(raw) && raw >= 80 && raw <= 400 ? raw : DEFAULT_UI_SETTINGS.speakRate;
}

function initStores(userDataPath, { log, registryDir, resourcesDir } = {}) {
  // Path locals — derived here so nothing needs app.getPath before whenReady.
  const PERSIST_FILE = path.join(userDataPath, 'sessions.json');
  const TEMPLATES_FILE = path.join(userDataPath, 'templates.json'); // legacy — migration only
  const TEMPLATES_DIR = path.join(registryDir, 'library', 'templates');
  const WORKSPACES_FILE = path.join(userDataPath, 'workspaces.json');
  const PROMPTS_FILE = path.join(userDataPath, 'prompts.json'); // legacy — migration only
  const AGENT_DEFAULTS_FILE = path.join(userDataPath, 'agent-defaults.json');
  const UI_SETTINGS_FILE = path.join(userDataPath, 'ui-settings.json');
  const REMINDERS_FILE = path.join(userDataPath, 'reminders.json');
  const NOTIFICATIONS_FILE = path.join(userDataPath, 'notifications.json');
  const ENV_SCOPES_FILE = path.join(userDataPath, 'env-scopes.json');
  const PROMPTS_DIR = path.join(registryDir, 'library', 'prompts');
  const AGENTS_DIR = path.join(registryDir, 'agents');
  const SKILLS_LIB_DIR = path.join(registryDir, 'skills');
  const EXEC_DIR = path.join(registryDir, 'library', 'exec');

  const persistence = {
    _load() {
      let all;
      try {
        all = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf-8'));
      } catch {
        try {
          all = JSON.parse(fs.readFileSync(PERSIST_FILE + '.bak', 'utf-8'));
          console.error('sessions.json unreadable; recovered from .bak');
        } catch {
          return [];
        }
      }
      if (!Array.isArray(all)) return [];
      let changed = false;
      for (const e of all) {
        if (!e.workspaceId) { e.workspaceId = DEFAULT_WORKSPACE_ID; changed = true; }
      }
      if (changed) this._save(all);
      return all;
    },
    _save(entries) {
      try {
        try {
          const cur = fs.readFileSync(PERSIST_FILE, 'utf-8');
          JSON.parse(cur);
          atomicWriteFileSync(PERSIST_FILE + '.bak', cur);
        } catch {}
        atomicWriteFileSync(PERSIST_FILE, JSON.stringify(entries, null, 2));
      } catch (e) {
        console.error('persistence save failed:', e);
      }
    },
    list() {
      return this._load();
    },
    listForWorkspace(workspaceId) {
      return this._load().filter(s => s.workspaceId === workspaceId);
    },
    upsert(entry) {
      const all = this._load();
      const idx = all.findIndex(s => s.name === entry.name);
      if (idx >= 0) all[idx] = { ...all[idx], ...entry };
      else all.push(entry);
      this._save(all);
    },
    remove(name) {
      this._save(this._load().filter(s => s.name !== name));
    },
    setSessionId(name, sessionId) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry && entry.sessionId !== sessionId) {
        entry.sessionId = sessionId;
        const hist = (Array.isArray(entry.sessionIds) ? entry.sessionIds : []).filter((id) => id !== sessionId);
        hist.push(sessionId);
        entry.sessionIds = hist;
        this._save(all);
      }
    },
    setHoldUntil(name, holdUntil) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (!entry) return;
      if (holdUntil && holdUntil > 0) entry.holdUntil = holdUntil;
      else delete entry.holdUntil;
      this._save(all);
    },
    // Perpetual keep-warm is a SEAT property, not a duration: it is stored as its
    // own boolean rather than a very large holdUntil, because rearmPlan and the
    // renderer both treat holdUntil as a real timestamp and would render a
    // sentinel as a date far in the future.
    setKeepWarmAlways(name, on) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (!entry) return;
      if (on) entry.keepWarmAlways = true;
      else delete entry.keepWarmAlways;
      this._save(all);
    },
    setLabel(name, label) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        entry.label = label;
        this._save(all);
      }
    },
    setWorktree(name, worktree) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (!entry) return;
      if (worktree && worktree.path) entry.worktree = worktree;
      else delete entry.worktree;
      this._save(all);
    },
    setArchived(name, archived) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (!entry) return;
      if (archived) entry.archivedAt = Date.now();
      else delete entry.archivedAt;
      this._save(all);
    },
    setExtraArgs(name, extraArgs) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        entry.extraArgs = extraArgs;
        this._save(all);
      }
    },
    setRosterSent(name) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (!entry) return;
      entry.rosterSentAt = Date.now();
      this._save(all);
    },
    setProxy(name, proxy) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        entry.proxy = proxy;
        this._save(all);
      }
    },
    setSystemPrompt(name, body) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        entry.systemPrompt = body || null;
        this._save(all);
      }
    },
    setPromptRefs(name, systemPromptFile, appendPromptFiles) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        entry.systemPromptFile = systemPromptFile || null;
        entry.appendPromptFiles = Array.isArray(appendPromptFiles) ? appendPromptFiles : [];
        this._save(all);
      }
    },
    setAgents(name, agents, denyBuiltins) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        entry.agents = Array.isArray(agents) ? agents : [];
        entry.denyBuiltins = Array.isArray(denyBuiltins) ? denyBuiltins : [];
        this._save(all);
      }
    },
    setDisabledTools(name, disabledTools) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        entry.disabledTools = Array.isArray(disabledTools) ? disabledTools : [];
        this._save(all);
      }
    },
    setDisabledSkills(name, disabledSkills) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        entry.disabledSkills = Array.isArray(disabledSkills) ? disabledSkills : [];
        this._save(all);
      }
    },
    setInjectSkills(name, injectSkills) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        entry.injectSkills = Array.isArray(injectSkills) ? injectSkills : [];
        this._save(all);
      }
    },
    // Per-session intent-gate allowlist (send-side; see intent-catalog). Like
    // setStripLevel this stores the DIVERGENCE only: an ARRAY (incl. [] =
    // everything gated) persists; NULL removes the key so the seat reverts to the
    // living all-enabled default — never a frozen array. The fire-time gate reads
    // this fresh, so writing it applies immediately (no respawn needed).
    setIntents(name, intents) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        if (Array.isArray(intents)) entry.intents = intents.map(String);
        else delete entry.intents;
        this._save(all);
      }
    },
    // Per-session plugin capability grants (t190) — `<pluginId>:<capability>`
    // tokens. Same file and the same divergence-only rule as setIntents, but the
    // polarity is inverted and that is deliberate: an ABSENT key means NO plugin
    // reaches this session, never the living all-enabled default. A scoped
    // plugin that defaulted to granted would reach every seat created before it
    // was installed.
    //
    // There is no agent-facing writer for this, by omission. `intents` has one
    // (filtered through withoutPrivilegedIntentsFor) because a seat asking for
    // its own verbs is meaningful; a seat granting a plugin the right to read
    // its own thinking is not a decision the seat gets to make.
    setPluginGrants(name, grants) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        if (Array.isArray(grants) && grants.length) entry.pluginGrants = grants.map(String);
        else delete entry.pluginGrants;
        this._save(all);
      }
    },
    setExecCommands(name, execCommands) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        if (Array.isArray(execCommands) && execCommands.length) entry.execCommands = execCommands.map(String);
        else delete entry.execCommands;
        this._save(all);
      }
    },
    setEnv(name, env) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        if (env && typeof env === 'object' && Object.keys(env).length) entry.env = { ...env };
        else delete entry.env;
        this._save(all);
      }
    },
    // Per-session wirescope strip-aggressiveness LEVEL (a cumulative ladder, not
    // independent toggles): 0 = off, 1 = strip prior thinking, 2 = + strip
    // superseded tool results. Each level is a superset of the one below. clodex
    // is authoritative — the proxy's overrides are in-memory, so the poller
    // re-asserts the level's wire state on relink (see ProxyPoller._tick).
    setStripLevel(name, level) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        const lvl = (level === 1 || level === 2) ? level : 0;
        if (lvl > 0) entry.stripLevel = lvl; else delete entry.stripLevel;
        delete entry.stripThinking; // migrate off the old boolean field
        this._save(all);
      }
    },
    // Auto-compact-before-cold is default ON, so only the opt-OUT is stored
    // (autoCompact:false); enabling deletes the field. Legacy entries without
    // the field are therefore on — see autoCompactOf.
    setAutoCompact(name, on) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        if (on === false) entry.autoCompact = false; else delete entry.autoCompact;
        this._save(all);
      }
    },
    markDigested(name, sessionId) {
      if (!sessionId) return;
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (!entry) return;
      const d = (Array.isArray(entry.digested) ? entry.digested : []).filter((id) => id !== sessionId);
      d.push(sessionId);
      entry.digested = d.slice(-50);
      this._save(all);
    },
    get(name) {
      return this._load().find(s => s.name === name) || null;
    },
  };

  // The keys the New/Edit dialog FULLY controls — a maintained pair with
  // collectFormConfig()'s return object in renderer.js. save()'s merge-preserve
  // treats these as editor-owned, so an OMITTED owned key on an edit save means
  // "the user cleared it", not "preserve the stored value"; only NON-owned keys
  // are carried forward. A new conditionally-omitted key in collectFormConfig
  // MUST be added here too, or merge-preserve resurrects it after a clear.
  const EDITOR_OWNED = new Set([
    'type', 'cwd', 'extraArgs', 'proxy', 'agents', 'execCommands', 'intents',
    'autoCompact', 'noWire', 'denyBuiltins', 'disabledTools', 'disabledSkills',
    'injectSkills', 'stripLevel', 'systemPromptFile', 'appendPromptFiles',
  ]);
  const templates = {
    // Confines the SUFFIXED basename, not the bare name: `${name}.json` is what
    // actually becomes a path, and a bare-name check would pass `../evil` only
    // to have the suffix land it outside anyway.
    _file(name) { return confineOrThrow(TEMPLATES_DIR, `${name}.json`, 'template name'); },
    _read(name) {
      try { const o = JSON.parse(fs.readFileSync(this._file(name), 'utf-8')); return (o && typeof o === 'object') ? o : null; }
      catch { return null; }
    },
    list() {
      let files;
      try { files = fs.readdirSync(TEMPLATES_DIR); }
      catch { return []; } // dir absent (nothing saved yet) → empty
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8'));
          if (!obj || typeof obj !== 'object') continue;
          const stem = f.slice(0, -'.json'.length);
          out.push({ ...obj, name: stem, id: stem });
        } catch { /* skip a malformed file, like agentLibrary */ }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    _write(name, template) {
      ensureDir(TEMPLATES_DIR);
      const { id, ...body } = template;
      body.name = name; // portability hint; read treats the filename as canonical
      fs.writeFileSync(this._file(name), JSON.stringify(body, null, 2), { mode: 0o600 });
    },
    // Rename-in-place: the caller passes the OLD name as `id` and the NEW one as
    // `name`. When they differ, write the new file and unlink the old or it
    // orphans. Dest-collision is the caller's check; this trusts it.
    save(template) {
      const prior = this._read(template.id);
      const merged = {};
      if (prior) for (const [k, v] of Object.entries(prior)) {
        if (!EDITOR_OWNED.has(k)) merged[k] = v;
      }
      Object.assign(merged, template);
      this._write(template.name, merged);
      if (template.id && template.id !== template.name) {
        // Rename cleanup. A refused `id` is swallowed here and that is not the
        // false-green the other verbs had: _write() confines on the way IN, so
        // a name-illegal id can never name a file this store wrote, and there
        // is nothing for a caller to learn from the refusal.
        try { fs.unlinkSync(this._file(template.id)); } catch {}
      }
    },
    // Case-insensitive scan that overwrites the matching EXACT filename, keeping
    // its original casing — otherwise a case-sensitive FS ends up holding both
    // Foo.json and foo.json.
    saveByName(template) {
      const wanted = (template.name || '').toLowerCase();
      let target = template.name;
      try {
        for (const f of fs.readdirSync(TEMPLATES_DIR)) {
          if (f.endsWith('.json') && f.slice(0, -'.json'.length).toLowerCase() === wanted) {
            target = f.slice(0, -'.json'.length); // keep original casing
            break;
          }
        }
      } catch { /* dir absent → first save under template.name */ }
      this._write(target, template);
      return { ...template, name: target, id: target };
    },
    remove(id) {
      const file = this._file(id); // refused id throws; ENOENT does not
      try { fs.unlinkSync(file); } catch {}
    },
  };

  const workspaces = {
    _load() {
      try {
        const all = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf-8'));
        return Array.isArray(all) ? all : [];
      } catch { return []; }
    },
    _save(entries) {
      try {
        atomicWriteFileSync(WORKSPACES_FILE, JSON.stringify(entries, null, 2));
      } catch (e) { console.error('workspaces save failed:', e); }
    },
    list() {
      const all = this._load();
      if (all.length === 0) {
        const def = { id: DEFAULT_WORKSPACE_ID, name: 'Workspace', bounds: null };
        this._save([def]);
        return [def];
      }
      return all;
    },
    get(id) { return this._load().find(w => w.id === id) || null; },
    upsert(ws) {
      const all = this._load();
      const idx = all.findIndex(w => w.id === ws.id);
      if (idx >= 0) all[idx] = { ...all[idx], ...ws };
      else all.push(ws);
      this._save(all);
    },
    remove(id) {
      const all = this._load().filter(w => w.id !== id);
      this._save(all);
    },
    setName(id, name) {
      const all = this._load();
      const w = all.find(x => x.id === id);
      if (w) { w.name = name; this._save(all); }
    },
    setBounds(id, bounds) {
      const all = this._load();
      const w = all.find(x => x.id === id);
      if (w) { w.bounds = bounds; this._save(all); }
    },
    setView(id, view) {
      const all = this._load();
      const w = all.find(x => x.id === id);
      if (!w) return;
      w.view = { ...(w.view || {}), ...(view || {}) };
      this._save(all);
    },
    setZoomFactor(id, factor) {
      const all = this._load();
      const w = all.find(x => x.id === id);
      if (w) {
        if (typeof factor === 'number' && factor !== 1) w.zoomFactor = factor;
        else delete w.zoomFactor;
        this._save(all);
      }
    },
    touch(id) {
      const all = this._load();
      const w = all.find(x => x.id === id);
      if (w) { w.lastFocusedAt = Date.now(); this._save(all); }
    },
    setOpen(id, open) {
      const all = this._load();
      const w = all.find(x => x.id === id);
      if (w) {
        if (open) w.open = true; else delete w.open;
        this._save(all);
      }
    },
    sortedByRecent() {
      return this.list().slice().sort((a, b) =>
        (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0),
      );
    },
  };

  // Prompts library — ~/.clodex/library/prompts/{system,append}/*.md.
  // kind = subfolder, NOT frontmatter: a `system` file is handed to the CLI
  // verbatim via --system-prompt-file, so there must be nothing to strip.
  // Identity is the filename stem, and appends apply in filename sort order.
  const promptLibrary = {
    // BOTH segments are caller-supplied. `kind` is allow-listed on save()
    // (PROMPT_KINDS, a closed set — correct, and stronger than a regex), but
    // list/raw/remove take it unchecked, so the containment has to be here.
    _dir(kind) { return confineOrThrow(PROMPTS_DIR, kind, 'prompt kind'); },
    _file(kind, stem) { return confineOrThrow(this._dir(kind), `${stem}.md`, 'prompt name'); },
    list(kind) {
      const kinds = kind ? [kind] : PROMPT_KINDS;
      const out = [];
      for (const k of kinds) {
        let files;
        try { files = fs.readdirSync(this._dir(k)); }
        catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.md')) continue;
          const stem = f.replace(/\.md$/, '');
          let body = '';
          try { body = fs.readFileSync(path.join(this._dir(k), f), 'utf-8'); }
          catch { continue; }
          out.push({ name: stem, kind: k, body, file: f });
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    raw(kind, stem) {
      try { return fs.readFileSync(this._file(kind, stem), 'utf-8'); }
      catch { return null; }
    },
    save(kind, stem, content) {
      if (!PROMPT_KINDS.includes(kind)) throw new Error(`invalid prompt kind: ${kind}`);
      if (!PROMPT_NAME_RE.test(stem)) throw new Error(`invalid prompt name: ${stem}`);
      ensureDir(this._dir(kind));
      fs.writeFileSync(this._file(kind, stem), String(content ?? ''), { mode: 0o600 });
      return this.list();
    },
    remove(kind, stem) {
      const file = this._file(kind, stem); // refused kind/name throws; ENOENT does not
      try { fs.unlinkSync(file); } catch {}
      return this.list();
    },
  };

  function slugifyPromptName(s) {
    const slug = String(s || '').trim().toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    return slug || `prompt-${Date.now()}`;
  }

  function migratePromptsJson() {
    let entries;
    try { entries = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf-8')); }
    catch { return; }
    if (!Array.isArray(entries) || !entries.length) return;
    ensureDir(promptLibrary._dir('append'));
    for (const p of entries) {
      const stem = slugifyPromptName(p.title || p.id);
      const dest = promptLibrary._file('append', stem);
      if (fs.existsSync(dest)) continue;
      try { fs.writeFileSync(dest, String(p.body ?? ''), { mode: 0o600 }); } catch {}
    }
    try { fs.renameSync(PROMPTS_FILE, `${PROMPTS_FILE}.migrated`); } catch {}
  }

  function migrateTemplatesJson() {
    let entries;
    try { entries = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8')); }
    catch { return; }
    if (!Array.isArray(entries) || !entries.length) return;
    ensureDir(TEMPLATES_DIR);
    for (const t of entries) {
      if (!t || typeof t !== 'object') continue;
      // slugifyPromptName's charset, but WITHOUT its prompt-<ts> fallback: an
      // empty slug drops the entry (no template-<ts> junk in the library).
      const stem = String(t.name || '').trim().toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
      if (!stem) continue; // empty slug → drop (recoverable from .migrated)
      const dest = templates._file(stem);
      if (fs.existsSync(dest)) continue; // first-wins on a slug collision
      const { id, ...body } = t; // strip the vestigial synthetic id
      body.name = stem;
      try { fs.writeFileSync(dest, JSON.stringify(body, null, 2), { mode: 0o600 }); } catch {}
    }
    try { fs.renameSync(TEMPLATES_FILE, `${TEMPLATES_FILE}.migrated`); } catch {}
  }

  const agentDefaults = {
    _load() {
      try {
        const obj = JSON.parse(fs.readFileSync(AGENT_DEFAULTS_FILE, 'utf-8'));
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
      } catch { return {}; }
    },
    _save(map) {
      try {
        atomicWriteFileSync(AGENT_DEFAULTS_FILE, JSON.stringify(map, null, 2));
      } catch (e) { console.error('agent-defaults save failed:', e); }
    },
    getStrip(name) {
      const e = this._load()[name];
      return (e && (e.strip === 1 || e.strip === 2)) ? e.strip : 0;
    },
    setStrip(name, level) {
      const map = this._load();
      const lvl = (level === 1 || level === 2) ? level : 0;
      const e = map[name] || {};
      if (lvl > 0) e.strip = lvl; else delete e.strip;
      if (Object.keys(e).length) map[name] = e; else delete map[name];
      this._save(map);
    },
    // Tri-state: key ABSENT -> the in-code DEFAULT_TOOL_DENY_FLOOR; key PRESENT
    // with a deny array (including EMPTY) -> the user's explicit choice wins, so
    // [] means "deny nothing", not "fall back to the floor". Keyed "*", which is
    // not a legal session name and so cannot collide with a per-agent entry.
    getDefaultDeny() {
      const e = this._load()['*'];
      if (e && Array.isArray(e.deny)) return e.deny.filter((t) => CLAUDE_TOOLS.includes(t));
      return DEFAULT_TOOL_DENY_FLOOR.slice();
    },
    setDefaultDeny(list) {
      const map = this._load();
      const clean = Array.isArray(list)
        ? [...new Set(list.filter((t) => CLAUDE_TOOLS.includes(t)))]
        : [];
      const e = map['*'] || {};
      e.deny = clean;
      map['*'] = e;
      this._save(map);
    },
  };


  const agentLibrary = {
    _file(name) { return confineOrThrow(AGENTS_DIR, `${name}.md`, 'agent name'); },
    list() {
      let files;
      try { files = fs.readdirSync(AGENTS_DIR); }
      catch { return []; }
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        try {
          const raw = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8');
          const { meta, body } = parseAgentFrontmatter(raw);
          // Identity is the filename stem (canonical: raw()/remove() and the
          // --agents JSON key all use it). Frontmatter `name` stays purely
          // informational/portable (it matters when a file is copied into a
          // real .claude/agents dir, but clodex never keys off it).
          const name = f.replace(/\.md$/, '');
          out.push({
            name,
            description: meta.description || '',
            model: meta.model || '',
            tools: meta.tools || '',
            disallowedTools: meta.disallowedTools || '',
            file: f, meta, body,
          });
        } catch { /* skip unreadable/garbled file */ }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    // Scope-filtered view of list() for the OFFER surfaces (Agents popover, the
    // Edit Session agents catalog): only items visible to the given
    // { session, workspace } context. list() itself stays unfiltered so the
    // library DRAWER keeps showing everything. Same per-item shape as list().
    listFor(ctx) {
      return this.list().filter((a) => visibleTo(a.meta, ctx || {}));
    },
    raw(name) {
      try { return fs.readFileSync(this._file(name), 'utf-8'); } catch { return null; }
    },
    save(name, content) {
      if (!AGENT_NAME_RE.test(name)) throw new Error(`invalid agent name: ${name}`);
      ensureDir(AGENTS_DIR);
      fs.writeFileSync(this._file(name), String(content ?? ''), { mode: 0o600 });
      return this.list();
    },
    remove(name) {
      // _file() is resolved OUTSIDE the try on purpose: a refused NAME must
      // propagate, while a missing FILE stays silent (delete is idempotent).
      // Folding both into one catch is what made a rejected name and a
      // successful delete return the same value.
      const file = this._file(name);
      try { fs.unlinkSync(file); } catch {}
      return this.list();
    },
  };

  const skillLibrary = {
    _file(name) { return confineOrThrow(SKILLS_LIB_DIR, `${name}.md`, 'skill name'); },
    list() {
      let files;
      try { files = fs.readdirSync(SKILLS_LIB_DIR); }
      catch { return []; }
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        try {
          const raw = fs.readFileSync(path.join(SKILLS_LIB_DIR, f), 'utf-8');
          const { meta } = parseSkillFrontmatter(raw);
          const name = f.replace(/\.md$/, '');
          out.push({ name, description: meta.description || '', content: raw, file: f });
        } catch { /* skip unreadable */ }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    listFor(ctx) {
      return this.list().filter((s) => visibleTo(parseSkillFrontmatter(s.content).meta, ctx || {}));
    },
    raw(name) {
      try { return fs.readFileSync(this._file(name), 'utf-8'); } catch { return null; }
    },
    save(name, content) {
      if (!AGENT_NAME_RE.test(name)) throw new Error(`invalid skill name: ${name}`);
      ensureDir(SKILLS_LIB_DIR);
      fs.writeFileSync(this._file(name), String(content ?? ''), { mode: 0o600 });
      return this.list();
    },
    remove(name) {
      // _file() is resolved OUTSIDE the try on purpose: a refused NAME must
      // propagate, while a missing FILE stays silent (delete is idempotent).
      // Folding both into one catch is what made a rejected name and a
      // successful delete return the same value.
      const file = this._file(name);
      try { fs.unlinkSync(file); } catch {}
      return this.list();
    },
  };

  const execLibrary = {
    _file(name) { return confineOrThrow(EXEC_DIR, `${name}.json`, 'exec command name'); },
    list() {
      let files;
      try { files = fs.readdirSync(EXEC_DIR); }
      catch { return []; }
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(EXEC_DIR, f), 'utf-8'));
          if (!obj || typeof obj !== 'object') continue;
          const name = f.replace(/\.json$/, '');
          out.push({
            name,
            argv: Array.isArray(obj.argv) ? obj.argv : [],
            cwd: typeof obj.cwd === 'string' ? obj.cwd : '',
            file: f,
          });
        } catch { /* skip unreadable/garbled file */ }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    raw(name) {
      try { return fs.readFileSync(this._file(name), 'utf-8'); } catch { return null; }
    },
    save(name, content) {
      if (!AGENT_NAME_RE.test(name)) throw new Error(`invalid exec command name: ${name}`);
      ensureDir(EXEC_DIR);
      fs.writeFileSync(this._file(name), String(content ?? ''), { mode: 0o600 });
      return this.list();
    },
    remove(name) {
      // _file() is resolved OUTSIDE the try on purpose: a refused NAME must
      // propagate, while a missing FILE stays silent (delete is idempotent).
      // Folding both into one catch is what made a rejected name and a
      // successful delete return the same value.
      const file = this._file(name);
      try { fs.unlinkSync(file); } catch {}
      return this.list();
    },
  };

  // Ids must be pure lowercase base36 with no separators: a
  // `[agent:remind cancel <id>]` token has to satisfy the scheduler's ID_RE
  // ([a-z0-9]+). `nextFireAt` is null for oncompact (event-driven, no timer);
  // this store does no timing — it mints id + createdAt and round-trips fields.
  // `ticket` is the optional `for <id>` binding: present only on bound records,
  // and what the scheduler's cancelForTicket selects on when a ticket is
  // accepted or cancelled.
  const reminders = {
    _load() {
      try {
        const all = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf-8'));
        return Array.isArray(all) ? all : [];
      } catch { return []; }
    },
    _save(entries) {
      try {
        atomicWriteFileSync(REMINDERS_FILE, JSON.stringify(entries, null, 2));
      } catch (e) { console.error('reminders save failed:', e); }
    },
    _mintId(all) {
      for (let i = 0; i < 50; i++) {
        const id = Math.random().toString(36).slice(2, 8);
        if (id && !all.some((r) => r.id === id)) return id;
      }
      return Date.now().toString(36).slice(-6);
    },
    list() { return this._load(); },
    listForAgent(agent) {
      return this._load().filter((r) => r.agent === agent);
    },
    add({ agent, kind, spec, body = '', nextFireAt = null, ticket = null }) {
      const all = this._load();
      const id = this._mintId(all);
      const rec = {
        id, agent, kind, spec, body,
        nextFireAt: (typeof nextFireAt === 'number' ? nextFireAt : null),
        createdAt: Date.now(),
        lastFiredAt: null,
        // Present only when bound. A conditional spread rather than a null
        // field: every unbound record stays byte-identical to what this store
        // wrote before bindings existed, so the on-disk file does not churn.
        ...(ticket ? { ticket } : {}),
      };
      all.push(rec);
      this._save(all);
      return rec;
    },
    remove(id) {
      const all = this._load();
      const next = all.filter((r) => r.id !== id);
      if (next.length === all.length) return false;
      this._save(next);
      return true;
    },
    markFired(id, firedAtMs, nextFireAt) {
      const all = this._load();
      const rec = all.find((r) => r.id === id);
      if (!rec) return false;
      rec.lastFiredAt = firedAtMs;
      rec.nextFireAt = (typeof nextFireAt === 'number' ? nextFireAt : null);
      this._save(all);
      return true;
    },
    get(id) { return this._load().find((r) => r.id === id) || null; },
  };

  const notifications = {
    _load() {
      try {
        const all = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
        return Array.isArray(all) ? all : [];
      } catch { return []; }
    },
    _save(entries) {
      try {
        atomicWriteFileSync(NOTIFICATIONS_FILE, JSON.stringify(entries, null, 2));
      } catch (e) { console.error('notifications save failed:', e); }
    },
    _mintId(all) {
      for (let i = 0; i < 50; i++) {
        const id = Math.random().toString(36).slice(2, 8);
        if (id && !all.some((n) => n.id === id)) return id;
      }
      return Date.now().toString(36).slice(-6);
    },
    list() { return this._load(); },
    add({ from, workspaceId = null, body = '' }) {
      const all = this._load();
      const id = this._mintId(all);
      const rec = {
        id, from,
        workspaceId: (workspaceId == null ? null : String(workspaceId)),
        body: String(body == null ? '' : body),
        createdAt: Date.now(),
        readAt: null,
      };
      all.push(rec);
      this._save(all);
      return rec;
    },
    markRead(id) {
      const all = this._load();
      const rec = all.find((n) => n.id === id);
      if (!rec) return false;
      if (rec.readAt == null) { rec.readAt = Date.now(); this._save(all); }
      return true;
    },
    markAllRead() {
      const all = this._load();
      const now = Date.now();
      let count = 0;
      for (const n of all) { if (n.readAt == null) { n.readAt = now; count++; } }
      if (count) this._save(all);
      return count;
    },
    remove(id) {
      const all = this._load();
      const next = all.filter((n) => n.id !== id);
      if (next.length === all.length) return false;
      this._save(next);
      return true;
    },
    unreadCount() { return this._load().reduce((n, r) => n + (r.readAt == null ? 1 : 0), 0); },
  };

  // This file holds SECRETS (peer auth tokens). Every write we make lands 0600
  // via atomicWriteFileSync; the check catches a file that arrived some other
  // way (restore, copy off another machine, stray chmod -R). Warn, don't fail.
  // Checked once per process on purpose: _load runs on every settings read, and
  // a statSync per read is a syscall per read for a file that is 0600 normally.
  let uiSettingsModeChecked = false;
  function warnUiSettingsMode() {
    if (uiSettingsModeChecked) return;
    uiSettingsModeChecked = true;
    try {
      const mode = fs.statSync(UI_SETTINGS_FILE).mode & 0o777;
      if (mode & 0o077) {
        console.warn(`ui-settings.json is mode ${mode.toString(8)} — peer tokens are group/world-readable; run: chmod 600 ${UI_SETTINGS_FILE}`);
      }
    } catch {}
  }

  const uiSettings = {
    _load() {
      try {
        const raw = JSON.parse(fs.readFileSync(UI_SETTINGS_FILE, 'utf-8'));
        warnUiSettingsMode();
        // Bound BEFORE the object literal so the migration below cannot reach
        // it by accident: `peerShellEnabled` must read `raw.peers`, and having
        // the sanitized array under a different name is what makes the wrong
        // read a visible substitution rather than an invisible one.
        const peers = sanitizePeers(raw?.peers) ?? defaultUiSettings().peers;
        return {
          statusline: {
            claude: Array.isArray(raw?.statusline?.claude) ? raw.statusline.claude : defaultUiSettings().statusline.claude,
            claudeCommand: typeof raw?.statusline?.claudeCommand === 'string' ? raw.statusline.claudeCommand : '',
            codex: Array.isArray(raw?.statusline?.codex) ? raw.statusline.codex : defaultUiSettings().statusline.codex,
          },
          proxyEnabled: typeof raw?.proxyEnabled === 'boolean' ? raw.proxyEnabled : DEFAULT_UI_SETTINGS.proxyEnabled,
          proxyUrl: typeof raw?.proxyUrl === 'string' ? raw.proxyUrl : DEFAULT_UI_SETTINGS.proxyUrl,
          lastCustomProxyUrl: typeof raw?.lastCustomProxyUrl === 'string' ? raw.lastCustomProxyUrl : DEFAULT_UI_SETTINGS.lastCustomProxyUrl,
          wirescopeDir: typeof raw?.wirescopeDir === 'string' ? raw.wirescopeDir : DEFAULT_UI_SETTINGS.wirescopeDir,
          wirescopePort: Number.isInteger(raw?.wirescopePort) ? raw.wirescopePort : DEFAULT_UI_SETTINGS.wirescopePort,
          compactOnResume: typeof raw?.compactOnResume === 'boolean' ? raw.compactOnResume : DEFAULT_UI_SETTINGS.compactOnResume,
          contextHints: typeof raw?.contextHints === 'boolean' ? raw.contextHints : DEFAULT_UI_SETTINGS.contextHints,
          semanticHints: typeof raw?.semanticHints === 'boolean' ? raw.semanticHints : DEFAULT_UI_SETTINGS.semanticHints,
          selectionHints: typeof raw?.selectionHints === 'boolean' ? raw.selectionHints : DEFAULT_UI_SETTINGS.selectionHints,
          voiceSubmit: typeof raw?.voiceSubmit === 'boolean' ? raw.voiceSubmit : DEFAULT_UI_SETTINGS.voiceSubmit,
          voiceSubmitComposition: typeof raw?.voiceSubmitComposition === 'boolean'
            ? raw.voiceSubmitComposition : DEFAULT_UI_SETTINGS.voiceSubmitComposition,
          voiceSubmitRearm: typeof raw?.voiceSubmitRearm === 'boolean'
            ? raw.voiceSubmitRearm : DEFAULT_UI_SETTINGS.voiceSubmitRearm,
          // A blank or non-string phrase resolves to the DEFAULT, never to '':
          // an empty trigger matches the end of every composer, so the value
          // that disarms the feature is `voiceSubmit`, never the phrase.
          voiceSubmitPhrase: (typeof raw?.voiceSubmitPhrase === 'string' && raw.voiceSubmitPhrase.trim())
            ? raw.voiceSubmitPhrase.trim()
            : DEFAULT_UI_SETTINGS.voiceSubmitPhrase,
          speakReplies: typeof raw?.speakReplies === 'boolean' ? raw.speakReplies : DEFAULT_UI_SETTINGS.speakReplies,
          // Blank resolves to the DEFAULT rather than to '', which would be an
          // empty `-v` argument. NOT validated against the installed set here:
          // `say` substitutes the system voice for an unknown name and still
          // speaks, and a read that rejected an uninstalled name would silence
          // the feature instead of degrading it.
          speakVoice: (typeof raw?.speakVoice === 'string' && raw.speakVoice.trim())
            ? raw.speakVoice.trim()
            : DEFAULT_UI_SETTINGS.speakVoice,
          speakRate: sanitizeSpeakRate(raw?.speakRate),
          terminalReports: sanitizeTerminalReports(raw),
          discoverOnStartup: typeof raw?.discoverOnStartup === 'boolean' ? raw.discoverOnStartup : DEFAULT_UI_SETTINGS.discoverOnStartup,
          recentCwds: Array.isArray(raw?.recentCwds) ? raw.recentCwds.filter((c) => typeof c === 'string').slice(0, 12) : defaultUiSettings().recentCwds,
          disableClaudeDesignMcp: typeof raw?.disableClaudeDesignMcp === 'boolean' ? raw.disableClaudeDesignMcp : DEFAULT_UI_SETTINGS.disableClaudeDesignMcp,
          theme: THEME_KEYS.includes(raw?.theme) ? raw.theme : DEFAULT_UI_SETTINGS.theme,
          sidebarWidth: clampSidebarWidth(raw?.sidebarWidth),
          remoteEnabled: typeof raw?.remoteEnabled === 'boolean' ? raw.remoteEnabled : DEFAULT_UI_SETTINGS.remoteEnabled,
          remotePort: Number.isInteger(raw?.remotePort) ? raw.remotePort : DEFAULT_UI_SETTINGS.remotePort,
          // `raw.peers`, NOT `peers` — see legacyShellGrant. The sanitized
          // array no longer carries `shellAllowed`.
          //
          // Keyed on the key's PRESENCE, not on its type: a junk value must
          // resolve to `false`, never fall through to the legacy source. "This
          // value is malformed, so go ask the old storage" is a rule that means
          // nothing today (shellCapGranted demands `=== true`) and would mean
          // something the first time a reader relaxes that.
          peerShellEnabled: (raw && typeof raw === 'object' && 'peerShellEnabled' in raw)
            ? raw.peerShellEnabled === true
            : legacyShellGrant(raw?.peers),
          peers,
          peerAttached: sanitizePeerAttached(raw?.peerAttached) ?? {},
          peerVisible: sanitizePeerVisible(raw?.peerVisible) ?? {},
          peerControlled: sanitizePeerControlled(raw?.peerControlled) ?? {},
          boxes: sanitizeBoxes(raw?.boxes) ?? defaultUiSettings().boxes,
          lastRebootAt: Number.isFinite(raw?.lastRebootAt) ? raw.lastRebootAt : DEFAULT_UI_SETTINGS.lastRebootAt,
          pendingRebootNotice: sanitizeRebootNotice(raw?.pendingRebootNotice),
          plugins: sanitizePlugins(raw?.plugins) ?? defaultUiSettings().plugins,
        };
      } catch { return defaultUiSettings(); }
    },
    get() { return this._load(); },
    set(partial) {
      const cur = this._load();
      const next = {
        statusline: {
          claude: partial?.statusline?.claude ?? cur.statusline.claude,
          claudeCommand: partial?.statusline?.claudeCommand ?? cur.statusline.claudeCommand,
          codex: partial?.statusline?.codex ?? cur.statusline.codex,
        },
        proxyEnabled: partial?.proxyEnabled ?? cur.proxyEnabled,
        proxyUrl: partial?.proxyUrl ?? cur.proxyUrl,
        lastCustomProxyUrl: partial?.lastCustomProxyUrl ?? cur.lastCustomProxyUrl,
        wirescopeDir: partial?.wirescopeDir ?? cur.wirescopeDir,
        wirescopePort: partial?.wirescopePort ?? cur.wirescopePort,
        compactOnResume: partial?.compactOnResume ?? cur.compactOnResume,
        contextHints: partial?.contextHints ?? cur.contextHints,
        semanticHints: partial?.semanticHints ?? cur.semanticHints,
        selectionHints: partial?.selectionHints ?? cur.selectionHints,
        voiceSubmit: typeof partial?.voiceSubmit === 'boolean' ? partial.voiceSubmit : cur.voiceSubmit,
        voiceSubmitComposition: typeof partial?.voiceSubmitComposition === 'boolean'
          ? partial.voiceSubmitComposition : cur.voiceSubmitComposition,
        voiceSubmitRearm: typeof partial?.voiceSubmitRearm === 'boolean'
          ? partial.voiceSubmitRearm : cur.voiceSubmitRearm,
        // Key ABSENT means "no opinion" and keeps the current value; key present
        // and BLANK is the operator clearing the field, which Preferences offers
        // as the way back to the default. Collapsing those two makes that
        // promise false — the custom phrase survives the clear and reappears.
        voiceSubmitPhrase: typeof partial?.voiceSubmitPhrase === 'string'
          ? (partial.voiceSubmitPhrase.trim() || DEFAULT_UI_SETTINGS.voiceSubmitPhrase)
          : cur.voiceSubmitPhrase,
        // Validated on the way IN, not just on the way out: an unrecognised
        // string written here would read back as itself, and every gate
        // downstream compares against a literal — so `'On'` would silently mean
        // neither 'all' nor 'off' and disclosure would depend on a typo.
        speakReplies: typeof partial?.speakReplies === 'boolean' ? partial.speakReplies : cur.speakReplies,
        // Same absent-vs-blank split as voiceSubmitPhrase: absent keeps the
        // current value, blank is the operator clearing the field back to the
        // default.
        speakVoice: typeof partial?.speakVoice === 'string'
          ? (partial.speakVoice.trim() || DEFAULT_UI_SETTINGS.speakVoice)
          : cur.speakVoice,
        // Absent keeps the current value; anything present goes through the same
        // clamp the read uses, so a junk write cannot land a rate that reads
        // back as itself and is then SPOKEN at — `say` accepts any integer and
        // narrates at 5 wpm without complaint.
        speakRate: partial?.speakRate === undefined ? cur.speakRate : sanitizeSpeakRate(partial.speakRate),
        terminalReports: TERMINAL_REPORTS.includes(partial?.terminalReports) ? partial.terminalReports : cur.terminalReports,
        discoverOnStartup: partial?.discoverOnStartup ?? cur.discoverOnStartup,
        recentCwds: Array.isArray(partial?.recentCwds) ? partial.recentCwds.filter((c) => typeof c === 'string').slice(0, 12) : cur.recentCwds,
        disableClaudeDesignMcp: partial?.disableClaudeDesignMcp ?? cur.disableClaudeDesignMcp,
        theme: THEME_KEYS.includes(partial?.theme) ? partial.theme : cur.theme,
        sidebarWidth: clampSidebarWidth(partial?.sidebarWidth ?? cur.sidebarWidth),
        remoteEnabled: partial?.remoteEnabled ?? cur.remoteEnabled,
        remotePort: Number.isInteger(partial?.remotePort) ? partial.remotePort : cur.remotePort,
        // Booleans only: `cur` already carries the migrated value, so a junk
        // partial must not be able to write a non-boolean that reads back as
        // itself and makes the grant depend on truthiness.
        peerShellEnabled: typeof partial?.peerShellEnabled === 'boolean' ? partial.peerShellEnabled : cur.peerShellEnabled,
        peers: sanitizePeers(partial?.peers, cur.peers) ?? cur.peers,
        peerAttached: sanitizePeerAttached(partial?.peerAttached) ?? cur.peerAttached,
        peerVisible: sanitizePeerVisible(partial?.peerVisible) ?? cur.peerVisible,
        peerControlled: sanitizePeerControlled(partial?.peerControlled) ?? cur.peerControlled,
        boxes: sanitizeBoxes(partial?.boxes ?? cur.boxes) ?? cur.boxes,
        lastRebootAt: Number.isFinite(partial?.lastRebootAt) ? partial.lastRebootAt : cur.lastRebootAt,
        // null is a REAL value here (the one-shot clear), so undefined-means-keep
        // can't use the Number.isFinite pattern — key the merge on presence.
        pendingRebootNotice: (partial && 'pendingRebootNotice' in partial)
          ? sanitizeRebootNotice(partial.pendingRebootNotice)
          : cur.pendingRebootNotice,
        // WHOLE-BAG replace, not a merge: every writer already spreads the
        // current bag, and merging here would make a deletion unrepresentable.
        plugins: (partial && 'plugins' in partial)
          ? (sanitizePlugins(partial.plugins) ?? cur.plugins)
          : cur.plugins,
      };
      try {
        atomicWriteFileSync(UI_SETTINGS_FILE, JSON.stringify(next, null, 2));
      } catch (e) { console.error('ui-settings save failed:', e); }
      return next;
    },
  };

  // A `workspace:`-scoped skill/agent keys off the workspace DISPLAY name, so a
  // rename must rewrite those files in the same motion or they orphan. Exact
  // match on the trimmed old name — the same comparison visibleTo makes.
  function renameWorkspaceScope(oldName, newName) {
    const from = String(oldName == null ? '' : oldName).trim();
    const to = String(newName == null ? '' : newName).trim();
    if (!from || from === to) return 0;
    let count = 0;
    for (const dir of [AGENTS_DIR, SKILLS_LIB_DIR]) {
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        const p = path.join(dir, f);
        let raw;
        try { raw = fs.readFileSync(p, 'utf-8'); } catch { continue; }
        // Only the leading frontmatter fence carries scope; never touch the body.
        const fence = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        if (!fence) continue;
        const block = fence[0];
        const nextBlock = block.replace(/^(\s*workspace:\s*)(.*)$/m, (whole, pre, val) => {
          let v = val.trim();
          if ((v.startsWith('"') && v.endsWith('"')) ||
              (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          return v === from ? `${pre}${to}` : whole;
        });
        if (nextBlock === block) continue;
        try {
          atomicWriteFileSync(p, nextBlock + raw.slice(block.length));
          count++;
        } catch { /* leave the file as-is on a write error */ }
      }
    }
    return count;
  }

  // Version-stamped reconciliation against .seed-state.json ({ relPath: sha256
  // of the shipped bytes we last wrote }), so an upgrade replaces an UNEDITED
  // shipped copy but never an operator-edited one:
  //   dest absent           -> copy, stamp shippedHash.
  //   present + stamped     -> overwrite only if sha256(dest) === stamp AND
  //                            shippedHash !== stamp; else leave it.
  //   present, NO stamp     -> legacy: cannot prove pristine, so never
  //                            overwrite; adopt sha256(dest) instead.
  // A dest that matches NEITHER its stamp nor the shipped bytes is STRANDED:
  // permanently off the upgrade path. That is correct for an operator edit and
  // wrong for a stale shipped copy, and a hash mismatch cannot tell the two
  // apart -- so it is reported, never repaired (see the branch for why).
  // Best-effort: a failed read/copy is logged and skipped, never thrown.
  const SEED_SRC = resourcesDir || path.join(__dirname, 'resources', 'library');
  const SEED_STATE_NAME = '.seed-state.json';
  // Sibling of .seed-state.json, deliberately NOT a reserved key inside it:
  // .seed-state.json is documented as a flat relPath -> hash map, and a reserved
  // key would have to be skipped by every present and future consumer of it. The
  // walk iterates SEED_SRC, so a file existing only under destRoot is never
  // visited and needs no skip.
  const SEED_REPORT_NAME = '.seed-report.json';
  // Cannot collide with a session name (the name grammar has no space), so the
  // inbox drawer's path links resolve as an ordinary miss rather than against
  // some unrelated live seat.
  const SEED_REPORT_FROM = 'Clodex library';
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  function seedLibraryDefaults() {
    const destRoot = path.join(registryDir, 'library');
    // Safety net, NOT a substitute for the registryDir seam (t359): under
    // `node --test`, refuse to seed the operator's real home. The suite seeded
    // the live library from whatever branch happened to be checked out, and a
    // future caller that forgets the seam would silently do it again. A test
    // that means to exercise seeding passes a temp registryDir, so this only
    // ever fires on the path that is already a mistake.
    //
    // Keys on whatever homedir() says NOW, so a test that fakes HOME and then
    // passes a registryDir matching it (terminal-reports-pref does) has its
    // seeding silently suppressed — expect an unseeded library there rather
    // than debugging it as a seed bug.
    if (process.env.NODE_TEST_CONTEXT
        && registryDir === path.join(os.homedir(), '.clodex')) {
      // Optional-call: several initStores callers pass {info, error} only, so a
      // bare log.warn would make the safety net itself the crash.
      if (log) log.warn?.('stores', 'refusing to seed the real ~/.clodex under node --test; pass seams.registryDir');
      return;
    }
    let src;
    try { src = fs.statSync(SEED_SRC); } catch { return; } // no seed tree shipped
    if (!src.isDirectory()) return;
    const statePath = path.join(destRoot, SEED_STATE_NAME);
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) || {}; }
    catch { state = {}; } // absent or corrupt -> conservative empty manifest
    if (typeof state !== 'object' || Array.isArray(state)) state = {};
    let changed = false;
    const stranded = [];
    const stack = [''];
    while (stack.length) {
      const rel = stack.pop();
      const absSrc = path.join(SEED_SRC, rel);
      let entries;
      try { entries = fs.readdirSync(absSrc, { withFileTypes: true }); }
      catch (e) { if (log) log.info?.('seed', `readdir skipped ${rel} (${e && e.message})`); continue; }
      for (const ent of entries) {
        const childRel = path.join(rel, ent.name);
        if (ent.isDirectory()) { stack.push(childRel); continue; }
        if (!ent.isFile()) continue;
        if (ent.name === SEED_STATE_NAME) continue;
        const dest = path.join(destRoot, childRel);
        try {
          const srcBytes = fs.readFileSync(path.join(SEED_SRC, childRel));
          const shippedHash = sha256(srcBytes);
          if (!fs.existsSync(dest)) {
            ensureDir(path.dirname(dest));
            atomicWriteFileSync(dest, srcBytes);
            state[childRel] = shippedHash; changed = true;
            continue;
          }
          const stamped = state[childRel];
          if (stamped === undefined) {
            state[childRel] = sha256(fs.readFileSync(dest)); changed = true;
            continue;
          }
          const destHash = sha256(fs.readFileSync(dest));
          if (destHash === stamped) {
            if (shippedHash !== stamped) {
              atomicWriteFileSync(dest, srcBytes);
              state[childRel] = shippedHash; changed = true;
            }
          } else if (shippedHash !== stamped) {
            // Diverged from the stamp AND the ship moved on: every future
            // update to this file is withheld, silently and forever. Two
            // causes produce this exact hash shape -- a real operator edit,
            // and a stale shipped copy whose stamp ran ahead of it -- and
            // overwriting on the second would destroy config on the first.
            // Nothing here can distinguish them (the bytes are all we have,
            // and the packaged app ships resources/ WITHOUT .git, so shipped
            // history is unavailable exactly where operators run). So repair
            // only the case that writes no content, and report the rest.
            if (destHash === shippedHash) {
              // Live already IS the shipped bytes; only the stamp lags, so
              // converging it destroys nothing and is what puts a
              // hand-repaired file back on the upgrade path for the NEXT ship.
              state[childRel] = shippedHash; changed = true;
            } else {
              stranded.push({ rel: childRel, shippedHash });
            }
          }
        } catch (e) {
          if (log) log.info?.('seed', `copy skipped ${childRel} (${e && e.message})`);
        }
      }
    }
    stranded.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    // Two channels, two cadences, because the two failure modes are opposite.
    // The log is the forensic record and is cheap, so it restates the whole
    // stranded set every run. The operator inbox INTERRUPTS, and the steady
    // state here is a file that is correct to leave alone -- the measured
    // real-world instance is genuine operator config needing no action -- so it
    // fires only when a shipped update is withheld that was not withheld
    // before. Keying that on the SHIPPED hash (not on the file's presence in
    // the set) is what makes it fire again when the ship next moves.
    // Scope coupling, deliberate and worth knowing: this dedupe token lives
    // under registryDir while the inbox it gates lives under userData. Two
    // hosts pointed at different CLODEX_DATA_DIRs therefore share the token but
    // not the channel, so the second one records an announcement the operator
    // never saw. Defaults put both on the same path, so this is a note, not a
    // move -- the file's location is settled.
    const reportPath = path.join(destRoot, SEED_REPORT_NAME);
    let reported = {};
    try { reported = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) || {}; }
    catch { reported = {}; } // absent or corrupt -> announce, never swallow
    if (typeof reported !== 'object' || Array.isArray(reported)) reported = {};
    // Rebuilt from the CURRENT stranded set, never merged into what was read: a
    // file that stops being stranded must LOSE its entry, or stranding again
    // later at the same shipped hash would be silently never announced.
    const nextReport = {};
    for (const s of stranded) nextReport[s.rel] = s.shippedHash;

    if (stranded.length) {
      const rels = stranded.map((s) => s.rel);
      // Takes the count because the two channels carry different SETS: the log
      // restates every stranded file, the note lists only the fresh ones. A
      // single string built from `rels` says "them" in a note listing one file.
      const advice = (n) => `If you edited ${n > 1 ? 'them' : 'it'} deliberately, nothing needs doing. To take the shipped version instead, copy yours aside first, then delete ${n > 1 ? 'them' : 'it'} under ${destRoot} and relaunch.`;
      const fixIt = advice(rels.length);
      // warn, not info: a withheld upgrade was invisible for 8 days and 20
      // shipped revisions once, and the silence WAS the bug.
      if (log) log.warn?.('seed', `${stranded.length} library file(s) differ from both the shipped copy and their seed stamp, so they will never receive shipped updates: ${rels.join(', ')}. ${fixIt}`);
      const fresh = stranded.filter((s) => reported[s.rel] !== s.shippedHash);
      if (fresh.length && notifications) {
        // Recording a hash as announced is a promise that the operator was
        // told, and only a note that survived to disk keeps it. `add` cannot
        // report the failure that matters -- `_save` swallows a write error and
        // `add` returns the record regardless -- so read the record back rather
        // than trusting the return. On any doubt the hash is NOT advanced, so
        // the next launch retries: the same "announce, never swallow" direction
        // the corrupt-state read above takes, for the same reason.
        let delivered = false;
        try {
          const rec = notifications.add({
            from: SEED_REPORT_FROM,
            workspaceId: null,
            body: `A shipped update is being withheld from ${fresh.length} file(s) in your Clodex library, because each differs from both the shipped copy and the version Clodex last wrote there:\n\n${fresh.map((s) => s.rel).join('\n')}\n\n${advice(fresh.length)}`,
          });
          delivered = !!(rec && notifications.list().some((n) => n.id === rec.id));
        } catch (e) { if (log) log.info?.('seed', `inbox note skipped (${e && e.message})`); }
        if (!delivered) {
          if (log) log.warn?.('seed', 'the inbox note was not written, so the report state is left for the next launch to retry');
          // Carry the PREVIOUS token forward (or drop the key when there was
          // none), so an undelivered announcement is never banked.
          for (const s of fresh) {
            if (reported[s.rel] === undefined) delete nextReport[s.rel];
            else nextReport[s.rel] = reported[s.rel];
          }
        }
      }
    }
    // Write only on a real change, so the healthy case (nothing stranded, no
    // report file) never creates one.
    const reportKeys = Object.keys(nextReport);
    const reportSame = reportKeys.length === Object.keys(reported).length
      && reportKeys.every((k) => reported[k] === nextReport[k]);
    if (!reportSame) {
      try { ensureDir(destRoot); atomicWriteFileSync(reportPath, JSON.stringify(nextReport, null, 2)); }
      catch (e) { if (log) log.info?.('seed', `report state write skipped (${e && e.message})`); }
    }
    if (changed) {
      try { ensureDir(destRoot); atomicWriteFileSync(statePath, JSON.stringify(state, null, 2)); }
      catch (e) { if (log) log.info?.('seed', `state write skipped (${e && e.message})`); }
    }
  }

  // Holds secret VALUES at rest: every write chmods 0600. Reads NEVER mask (the
  // pure merge needs the values) — masking is an IPC-layer concern.
  // Prototype-pollution guard: the workspace path does
  // `data.workspaces[scope] = data.workspaces[scope] || {}`, so a scope of
  // '__proto__' / 'constructor' / 'prototype' would reach Object.prototype.
  // Workspace ids are UUIDs; reject these at every door.
  const UNSAFE_SCOPE = new Set(['__proto__', 'constructor', 'prototype']);
  const safeScope = (scope) => scope === 'global' || !UNSAFE_SCOPE.has(String(scope));

  const envScopes = {
    _load() {
      try {
        const obj = JSON.parse(fs.readFileSync(ENV_SCOPES_FILE, 'utf-8'));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { global: {}, workspaces: {} };
        return {
          global: (obj.global && typeof obj.global === 'object' && !Array.isArray(obj.global)) ? obj.global : {},
          workspaces: (obj.workspaces && typeof obj.workspaces === 'object' && !Array.isArray(obj.workspaces)) ? obj.workspaces : {},
        };
      } catch { return { global: {}, workspaces: {} }; }
    },
    _save(data) {
      try {
        atomicWriteFileSync(ENV_SCOPES_FILE, JSON.stringify(data, null, 2));
        // Reassert 0600 on the final file — a secret store must never be group/
        // world-readable, and the atomic rename can land on an older lax-mode file.
        try { fs.chmodSync(ENV_SCOPES_FILE, 0o600); } catch { /* best-effort */ }
      } catch (e) { console.error('env-scopes save failed:', e); }
    },
    getScope(scope) {
      if (!safeScope(scope)) return {};
      const data = this._load();
      if (scope === 'global') return data.global || {};
      return (data.workspaces && data.workspaces[scope]) || {};
    },
    all() { return this._load(); },
    set(scope, key, value, secret) {
      if (!safeScope(scope)) throw new Error(`invalid scope "${scope}"`);
      const err = envKeyError(key, value);
      if (err) throw new Error(err);
      const data = this._load();
      const target = scope === 'global'
        ? (data.global = data.global || {})
        : ((data.workspaces = data.workspaces || {}), (data.workspaces[scope] = data.workspaces[scope] || {}));
      target[key] = { value: String(value == null ? '' : value), secret: secret === true };
      this._save(data);
    },
    remove(scope, key) {
      if (!safeScope(scope)) return;
      const data = this._load();
      if (scope === 'global') {
        if (data.global) delete data.global[key];
      } else if (data.workspaces && data.workspaces[scope]) {
        delete data.workspaces[scope][key];
        if (!Object.keys(data.workspaces[scope]).length) delete data.workspaces[scope];
      }
      this._save(data);
    },
    removeWorkspace(workspaceId) {
      if (!safeScope(workspaceId)) return;
      const data = this._load();
      if (data.workspaces && data.workspaces[workspaceId]) {
        delete data.workspaces[workspaceId];
        this._save(data);
      }
    },
  };

  migratePromptsJson(); // one-shot: prompts.json -> library/prompts/append/*.md
  migrateTemplatesJson(); // one-shot: templates.json -> library/templates/*.json
  seedLibraryDefaults(); // seed-if-absent: shipped library defaults -> ~/.clodex/library

  return {
    persistence, templates, workspaces, promptLibrary,
    agentDefaults, agentLibrary, skillLibrary, execLibrary, reminders, notifications, uiSettings,
    envScopes,
    renameWorkspaceScope,
  };
}

module.exports = { initStores };
