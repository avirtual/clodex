// stores.js — the persistence layer as a single factory. initStores() builds
// the ten on-disk stores and returns them; main.js calls it once in
// app.whenReady() and destructures the result.
//
// DI seam: initStores(userDataPath, { log, registryDir, resourcesDir }).
//   - userDataPath  — app.getPath('userData'); the eight JSON stores live here.
//   - registryDir   — ~/.clodex; the prompt/agent/skill libraries live under it
//                     (passed in to keep a single REGISTRY_DIR source of truth
//                     in main.js rather than re-deriving os.homedir() here).
//   - resourcesDir  — the shipped library seed root (repo `resources/library/`),
//                     __dirname-relative by default so it rides app.asar in a
//                     packaged build; overridable for hermetic tests. Its tree
//                     is copied into registryDir/library ONCE PER FILE, seed-if-
//                     absent (see seedLibraryDefaults).
//   - log           — reserved; the moved bodies keep their verbatim
//                     console.error on save failure (move-only), so it is
//                     currently unused.
//
// Why a factory: the store file paths are derived INSIDE it from userDataPath,
// so the stores simply do not exist until whenReady runs — which structurally
// retires the old PERSIST_FILE-before-whenReady landmine (there is no module-
// scope *_FILE global left to read too early). createMemoryStore in
// memory-store.js is the in-repo shape template this mirrors.
//
// Gotchas owned:
//   - The legacy prompts.json -> library/prompts migration is one-shot and runs
//     during construction (it used to be an explicit whenReady call after
//     PROMPTS_FILE was assigned); it only touches PROMPTS_FILE + the prompt dir,
//     so its position relative to the other stores is immaterial.
//   - Save failures are swallowed (console.error) exactly as before; a torn
//     write is prevented by fs-util's atomicWriteFileSync, and persistence keeps
//     an extra validated .bak snapshot.

const fs = require('fs');
const path = require('path');
const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { parseAgentFrontmatter } = require('./agents-util');
const { parseSkillFrontmatter } = require('./skills-util');
const { visibleTo } = require('./scope-util');
const { clampSidebarWidth } = require('./sidebar-width');
const {
  DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, THEME_KEYS,
  CLAUDE_TOOLS, DEFAULT_TOOL_DENY_FLOOR,
} = require('./catalogs');

const PROMPT_KINDS = ['system', 'append'];
const PROMPT_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/; // mirrors session/agent name rule

// A managed box's config block (M6b). One shape, N instances — every box row in
// the `boxes` registry carries a copy. workDir null = a named volume; a host path
// = a bind mount. The three ports publish web/wirescope/peer-wire to loopback,
// collision-bumped at compose-generation. image null = default resolution.
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

const DEFAULT_UI_SETTINGS = {
  statusline: {
    claude: ['model', 'context', 'cost', 'cwd'],
    claudeCommand: '',
    codex: ['context-used', 'model-name', 'project-root', 'git-branch', 'five-hour-limit', 'current-dir'],
  },
  // ON by default since the proxy became self-contained (vendored copy +
  // managed venv + autostart): "off" existed to protect users from a manual
  // setup burden that no longer exists. The Traffic optimization toggle is
  // the opt-out; missing python3 degrades to unrouted sessions, no breakage.
  // Users who saved prefs before the flip keep their persisted choice.
  proxyEnabled: true,
  // 7800 — wirescope's conventional port, ON PURPOSE (revisited 2026-07-03):
  // since the managed instance detaches and survives GUI restarts it is a
  // machine-level service, so OTHER agentic systems on this machine sharing
  // it is a feature, not contamination. Detect-first adoption still means an
  // already-running 7800 wins and we never double-spawn.
  proxyUrl: 'http://127.0.0.1:7800',
  // Last CUSTOM proxy URL a New Session picked — a prefill convenience ONLY,
  // decoupled from proxyUrl so remembering it never mutates the global default
  // (which feeds ANTHROPIC_BASE_URL for default-proxy spawns and gates the
  // managed wirescope's autostart on port match). Empty = never set a custom one.
  lastCustomProxyUrl: '',
  // wirescope source override: empty = the vendored copy bundled with Clodex;
  // a power user can point at their own checkout (settings-file-only, no UI).
  wirescopeDir: '',
  wirescopePort: 7800,
  // Cold-resume compaction: when a parked session is resumed (GUI relaunch =
  // cold by construction), ask wirescope to BAKE its transcript down to the
  // safe-to-drop set before --resume. The re-cache is unavoidable on a cold
  // resume, so baking just makes it cheaper + permanently slimmer. OFF by
  // default — it mutates the on-disk transcript (wirescope backs up + integrity-
  // gates; clodex fails safe to the original on any error). Needs a live proxy.
  compactOnResume: false,
  // Startup session discovery: on launch, scan ~/.claude/projects for recent
  // transcripts clodex doesn't track and offer to adopt them. OFF by default —
  // an opt-in convenience; only the focused/most-recent window ever triggers it.
  discoverOnStartup: false,
  // Working-directory MRU for the New Session dialog: the dirs most recently
  // picked as a session cwd, most-recent first, capped at 12. Fed to the
  // cwd-suggestions datalist alongside the popular-across-live-sessions list.
  recentCwds: [],
  // Built-in Claude Design MCP: the CLI auto-injects the claude.ai `claude_design`
  // connector (20 `mcp__claude_design__*` tools, ~4k tok/turn cache carriage) on
  // every launch for entitled accounts, with no honored global opt-out. The PRIMARY
  // fix is surgical and lives on the wire: a routed wirescope strips ONLY the design
  // tools and keeps every real project/user MCP. This setting is just the no-proxy
  // FALLBACK — `--strict-mcp-config`, which makes the CLI ignore ALL mcp config. That
  // is a nuclear option: on an unrouted session sitting in a repo with a real
  // `.mcp.json` it would silently drop those servers too, just to shed claude_design.
  // So it is OFF by default — we don't impose the all-or-nothing flag on anyone who
  // might have real MCPs. Turn it on only if you run unrouted clodex agents that use
  // no MCP and want the ~4k/turn back without a proxy. Claude-only (Codex has no such
  // connector). When routed through a strip-capable wire the gate ignores this entirely
  // and lets the wire do the surgical strip regardless.
  disableClaudeDesignMcp: false,
  // UI theme key (see THEMES in renderer.js). Canonical copy lives here so the
  // View > Theme menu can show the right radio; the renderer mirrors it to
  // localStorage for instant pre-paint application.
  theme: 'midnight',
  // Sidebar width in px (Task 17, GH#7). The drag handle writes it here; every
  // window applies it at startup. Clamped to [160, 560] on read AND write via
  // clampSidebarWidth — a corrupt/out-of-range value can never reach the layout.
  sidebarWidth: 220,
  // Remote access: phone-friendly web UI served on 127.0.0.1 only. OFF by
  // default — it's a door into every agent session, so the user opens it
  // deliberately and pairs it with `tailscale serve` (or an SSH tunnel) for
  // off-machine reach. Port is settings-file-only (no UI), like wirescopePort.
  remoteEnabled: false,
  remotePort: 7900,
  // Peered Clodexes on other machines: [{ id, label, sshHost?, remotePort?,
  // url? }]. The friendly path is sshHost — Clodex spawns and supervises the
  // `ssh -N -L` forward itself (remotePort = peer's phone-access port,
  // settings-file-only like other ports). url is the manual escape hatch
  // (tailnet, custom tunnel): a loopback endpoint reaching the peer's
  // server. sshHost wins when both are set.
  peers: [],
  // Auto-reattach of peer tabs across app restarts: { [peerId]: [name, ...] }.
  // Kept OUTSIDE the peers array on purpose — the prefs dialog rebuilds that
  // array via collectPeers/sanitizePeers and would clobber any extra fields.
  // Written by the peer:attach / peer:detach handlers, pruned by syncPeerManager.
  peerAttached: {},
  // Per-peer session visibility: { [peerId]: [name, ...] }. NO key for a peer =
  // show all (default, zero behavior change); a key restricts the sidebar to
  // just those names. Unlike peerAttached an EMPTY array is meaningful here
  // ("show none") and is kept. Same out-of-band-from-`peers` reasoning as
  // peerAttached. Written by peer:setVisible, pruned by syncPeerManager.
  peerVisible: {},
  // Auto-re-take control of peer tabs across restarts (yours OR the box's via
  // remote restart/update): { [peerId]: [name, ...] }. Same out-of-band-from-
  // `peers` reasoning as peerAttached (empty arrays dropped). Written by the
  // peer:control / peer:detach / peer:forgetControlled handlers, pruned by
  // syncPeerManager. Controlled implies attached, so a name here is always a
  // subset of peerAttached.
  peerControlled: {},
  // Managed-sandbox registry (M6b: N instances, one shape). Each row is
  // { id, label, config } where config is DEFAULT_SANDBOX_CONFIG's shape. The
  // registry is the SOLE source of box state — there is no legacy top-level
  // `sandbox` key and no migration into this list. A fresh install seeds one box
  // (id 'sandbox') so the panel isn't empty; the user can rename/delete/add from
  // there. Deleting every box yields a genuinely empty list (not re-seeded).
  boxes: [{ id: 'sandbox', label: 'sandbox', config: { ...DEFAULT_SANDBOX_CONFIG } }],
  // Timestamp (ms epoch) of the last honored [agent:reboot] (Task 27). Rate-limit
  // backstop: a reboot inside REBOOT_MIN_INTERVAL of this is refused, so a
  // confused resumed transcript can't loop the app. 0 = never rebooted. (Auth is
  // the per-session `intents` allowlist, NOT a key here — Bogdan's call: reuse the
  // existing gate rather than invent a parallel settings surface.)
  lastRebootAt: 0,
  // The one-shot post-reboot notice (Task 28): stamped by [agent:reboot] just
  // before relaunch, delivered to the requesting seat once the app comes back
  // and a workspace restore runs, then cleared. { name, at, reason } or null.
  // Crash-safe by construction: it only fires if the app actually returned; a
  // relaunch that never comes back leaves it set for the next manual launch
  // (the requested-at time in the body self-explains a late one).
  pendingRebootNotice: null,
};

// `prior` (optional) is the CURRENT peers array — used to carry a peer's auth
// token forward by id when an incoming entry OMITS `token` (docs/remote-auth-plan.md
// §4). The Peers dialog round-trips `hasToken` only, never the value, so a plain
// label-edit save omits `token` and must not wipe it. An incoming string SETS the
// token (trimmed, cap 256); an explicit `''` CLEARS it; a dropped row drops its
// token with the row. On a fresh disk load `prior` is absent — the persisted
// string simply passes through the same set-on-string branch.
function sanitizePeers(raw, prior) {
  if (!Array.isArray(raw)) return null;
  const priorById = new Map(
    (Array.isArray(prior) ? prior : []).map((p) => [String(p && p.id), p]),
  );
  const out = [];
  for (const p of raw) {
    if (!p || typeof p.id !== 'string') continue;
    const url = typeof p.url === 'string' && /^https?:\/\//.test(p.url) ? p.url : null;
    // ssh host or user@host — same charset ssh_config aliases allow.
    const sshHost = typeof p.sshHost === 'string' && /^[a-zA-Z0-9._@-]{1,128}$/.test(p.sshHost) ? p.sshHost : null;
    if (!url && !sshHost) continue;
    // Optional per-peer deploy folder override (the clone dir on the box). Kept
    // as the raw operator string (~/… or /abs) — validated/rendered at deploy
    // time by classifyDeployFolder, not here; a blank/invalid value just falls
    // back to the script's own $HOME/wb-wrap-ui default. Cap length defensively.
    const deployFolder = typeof p.deployFolder === 'string' && p.deployFolder.trim()
      ? p.deployFolder.trim().slice(0, 256) : null;
    const entry = {
      id: p.id,
      label: typeof p.label === 'string' && p.label ? p.label : (sshHost || url),
      url, sshHost,
      remotePort: Number.isInteger(p.remotePort) ? p.remotePort : 7900,
      deployFolder,
      // Pause flag: preserved STRICTLY. setDisabled's enable path deletes the
      // key, so absence = enabled — never write `disabled: false` (would defeat
      // the absence invariant syncPeerManager reads). Only a hard `=== true`
      // survives; truthy-but-not-true is dropped.
      ...(p.disabled === true ? { disabled: true } : {}),
      // Relay-mesh membership (hub-relay federation): SAME presence-encoding as
      // disabled — setRelayAllowed's off path deletes the key, so absence = not
      // in the mesh (the symmetric gate's default-deny). MUST be preserved here
      // or every settings write strips it and the flag never persists (the gate
      // then stays OFF forever and no roster is ever pushed).
      ...(p.relayAllowed === true ? { relayAllowed: true } : {}),
    };
    // Operator auth token — presence-encoded like disabled/relayAllowed (only a
    // truthy value is written). Set on an incoming string, cleared on '', else
    // carried forward from prior by id when omitted (see the header note).
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
    const clean = names.filter((n) => typeof n === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(n));
    if (clean.length || keepEmpty) out[id] = clean;
  }
  return out;
}

// Persisted peer-tab attachments: empty arrays dropped (see keepEmpty above).
function sanitizePeerAttached(raw) {
  return sanitizePeerNameMap(raw, { keepEmpty: false });
}

// Persisted per-peer visibility selection: empty arrays kept ("show none").
function sanitizePeerVisible(raw) {
  return sanitizePeerNameMap(raw, { keepEmpty: true });
}

// Persisted control claims: empty arrays dropped, like peerAttached.
function sanitizePeerControlled(raw) {
  return sanitizePeerNameMap(raw, { keepEmpty: false });
}

// A managed box's config block (docs/sandbox-plan.md, M6b). Bounds every field so
// a hand-edited settings file can't feed sandbox.js junk: ports coerced to ints in
// the ephemeral/registered range (else the default), workDir/image as non-empty
// strings-or-null, autoStart a strict boolean, mounts a sanitized array (M6a).
// Returns null on a non-object so the caller falls back to DEFAULT_SANDBOX_CONFIG.
// Junk/extra keys are dropped by reconstruction (same stance as sanitizePeers).
// Consumed per-box by sanitizeBoxes — there is no top-level `sandbox` key.
//
// CRITICAL: this store is a WHITELIST — any key NOT reconstructed here is silently
// dropped on every write. `mounts` (M6a) shipped without a line here and vanished
// on every round-trip; every persisted box-config sub-key MUST appear below.
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

// M6a mount list → the persisted shape { host: non-empty string, ro: boolean,
// container?: non-empty string }. Malformed entries (missing/blank host, non-object)
// are dropped; a container is carried only when it's a non-empty string (an omitted
// target stays dynamic — sandbox.js derives it). Non-array input → []. The store
// only guards SHAPE; sandbox.js's normalizeMounts re-validates paths/shadows/dupes.
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

// Managed-sandbox registry (M6b P2). Each row is { id, label, config } — id gated
// UNIFORMLY to BOX_ID_RE (the compose project-name charset; a row failing it is
// DROPPED, since box creation enforces the same rule so nothing valid can regress
// to a bad id), label a non-empty display string (falls back to id), config the
// sanitizeSandbox shape. Duplicate ids — and the reserved 'host' id — drop all but
// the first / drop entirely. There is NO
// migration and NO guaranteed 'sandbox' row: the registry is the sole source, an
// empty/garbage input sanitizes to an empty list (the missing-key path in _load
// supplies the fresh-install default instead). Returns null on non-array input so
// the caller can pick between the persisted-empty [] and the default seed.
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

// The one-shot post-reboot notice (Task 28). null unless a well-formed object
// with a string seat name; `at` coerces to a finite ms stamp (0 if junk) and
// `reason` to a string (''), so a delivered notice can always format its
// requested-at time and optional reason. A missing/malformed value → null (no
// notice pending), which is also the cleared state.
function sanitizeRebootNotice(v) {
  if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name) return null;
  return {
    name: v.name,
    at: Number.isFinite(v.at) ? v.at : 0,
    // Bound the stored reason so an unbounded settings write (or a hand-edited
    // ui-settings.json) can't park a huge blob. Delivery still de-newlines and
    // trims to its own 200-char display bound; this is just a storage sanity cap.
    reason: (typeof v.reason === 'string' ? v.reason : '').slice(0, 500),
  };
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
  const PROMPTS_DIR = path.join(registryDir, 'library', 'prompts');
  const AGENTS_DIR = path.join(registryDir, 'agents');
  const SKILLS_LIB_DIR = path.join(registryDir, 'skills');
  // Exec-command registry — operator-authored `[agent:exec <cmd>]` command defs.
  // The exec DISPATCHER (session-manager `_handleExecIntent`) independently joins
  // this same `library/exec/<cmd>.json` path to read a def at invocation; the two
  // agree by construction (like AGENTS_DIR / the --agents key). This store is the
  // authoring surface only — it never runs a command.
  const EXEC_DIR = path.join(registryDir, 'library', 'exec');

  // ---------------------------------------------------------------------------
  // Persistence — remember sessions across app restarts
  // ---------------------------------------------------------------------------
  const persistence = {
    _load() {
      let all;
      try {
        all = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf-8'));
      } catch {
        // Primary missing or corrupt — fall back to the last known-good copy
        // before giving up (catches a bad hand-edit, not just a torn write).
        try {
          all = JSON.parse(fs.readFileSync(PERSIST_FILE + '.bak', 'utf-8'));
          console.error('sessions.json unreadable; recovered from .bak');
        } catch {
          return [];
        }
      }
      if (!Array.isArray(all)) return [];
      // Migrate entries without a workspaceId → assign to default
      let changed = false;
      for (const e of all) {
        if (!e.workspaceId) { e.workspaceId = DEFAULT_WORKSPACE_ID; changed = true; }
      }
      if (changed) this._save(all);
      return all;
    },
    _save(entries) {
      try {
        // Snapshot the current known-good file to .bak before overwriting, so a
        // logically-bad-but-valid write (or a hand-edit slip) stays recoverable —
        // atomicWriteFileSync only protects against torn writes. Validate first
        // so we never back up garbage.
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
        // Ordered history of observed conversation ids (oldest → newest). Each
        // /clear mints a new id and JsonlWatcher reports it here, so this chain
        // accumulates every conversation the agent has had — authoritative, no
        // cwd guessing. Dedup + move-to-end so re-resuming an old id marks it
        // most-recent. Powers the session picker (session:history).
        const hist = (Array.isArray(entry.sessionIds) ? entry.sessionIds : []).filter((id) => id !== sessionId);
        hist.push(sessionId);
        entry.sessionIds = hist;
        this._save(all);
      }
    },
    // Keep-warm hold INTENT, epoch ms. The in-process HoldKeeper is memory-only
    // by design (wire/hold.js header) — persisting the deadline (never the
    // last-request bytes/auth headers) lets the first main-line turn after a
    // restart re-arm it. A falsy value CLEARS to an absent key (explicit
    // disarm / lapse), so a dormant session carries no stale field.
    setHoldUntil(name, holdUntil) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (!entry) return;
      if (holdUntil && holdUntil > 0) entry.holdUntil = holdUntil;
      else delete entry.holdUntil;
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
    // Per-session git worktree provenance ({ path, branch, base, repo }), stamped
    // after a worktree-backed create so a later teardown can offer to remove it. A
    // falsy value clears the key (a session that no longer owns a worktree carries
    // none).
    setWorktree(name, worktree) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (!entry) return;
      if (worktree && worktree.path) entry.worktree = worktree;
      else delete entry.worktree;
      this._save(all);
    },
    // Manual archive: an archived session keeps its record (so it can be resumed
    // later) but has no running PTY and is skipped by restore-spawn. Stamps
    // archivedAt for the sidebar's status filter + sort/display; clearing it
    // (unarchive) drops the key so a resumed session carries none.
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
    // Teams: stamp the one-time initial-roster DELIVERY. create() reads this
    // pre-upsert to gate the team-context wiring: present → this seat already
    // got its roster on a prior spawn, so a resume/restart must NOT re-inject it
    // (the resumed context already carries it) or re-announce the seat to
    // teammates (N seats each re-firing 'spawned' on app restart = N×N delta
    // spam for a team that never changed). Written at delivery (not decision) so
    // a seat that died before its roster landed carries no stamp and retries next
    // spawn. Delete drops the whole record, so a delete+recreate is a genuine
    // first spawn again. Absence, not value, is the signal — see the mint-vs-
    // resume note in create() (resumeId's VALUE is not the axis; task 15).
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
    // Per-session exec-command GRANT allowlist (the capability the fire-time exec
    // dispatcher checks fresh on every [agent:exec], session-manager _handleExecIntent).
    // Divergence-only like setIntents: a non-empty ARRAY persists; an empty grant
    // REMOVES the key so "no grants" is stored as ABSENCE — matching create(), which
    // only writes execCommands when non-empty. Written by the Edit dialog; agents can
    // never reach it (no exec-write intent verb — grants ride operator templates).
    setExecCommands(name, execCommands) {
      const all = this._load();
      const entry = all.find(s => s.name === name);
      if (entry) {
        if (Array.isArray(execCommands) && execCommands.length) entry.execCommands = execCommands.map(String);
        else delete entry.execCommands;
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
    // Boot-digest ledger: conversation ids that have received the memory digest
    // (via the SessionStart hook at birth, or the append-once path). Durable so
    // GUI restarts — which --resume the same conversation — never re-deliver.
    // Capped like a ring: an evicted ancient id would at worst earn a harmless
    // duplicate digest if that conversation is ever resumed again.
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

  // ---------------------------------------------------------------------------
  // Templates — saved session configs, one portable JSON object per file under
  // library/templates/<name>.json. A structural twin of agentLibrary: the
  // FILENAME is the identity (mirrors _file(name)), and because the on-disk
  // object is exactly the shape spawn's `template:./x.json` consumes, a library
  // template literally IS a spawn-able file template. The stored file carries NO
  // synthetic id — list() re-injects `id = <filename stem>` on read so the
  // renderer/IPC (which key on `.id`) work unchanged against a name identity.
  // Config subset: type/cwd/extraArgs/proxy/agents/execCommands/denyBuiltins/
  // disabledTools/disabledSkills/injectSkills/systemPromptFile/appendPromptFiles
  // + opt-out stripLevel/autoCompact/intents. NEVER a per-session identity (proxyAgent) or runtime
  // state (sessionId). Schemaless: unknown fields load verbatim, missing config
  // = clodex defaults at spawn (so pre-config / pre-prompt-refs templates load).
  // ---------------------------------------------------------------------------
  // The keys the New/Edit dialog FULLY controls — the exact set
  // collectFormConfig() returns (renderer.js). Cross-pinned: this list and that
  // return object are a maintained pair. `save()`'s merge-preserve treats these as
  // editor-owned, so an OMITTED owned key on an edit save means "the user cleared
  // it" (e.g. re-checked auto-compact / all intents), NOT "preserve the stored
  // value" — only NON-owned keys (unknown/future fields) are carried forward. A
  // new conditionally-omitted key in collectFormConfig MUST be added here too, or
  // merge-preserve will resurrect it after the user clears it.
  const EDITOR_OWNED = new Set([
    'type', 'cwd', 'extraArgs', 'proxy', 'agents', 'execCommands', 'intents',
    'autoCompact', 'denyBuiltins', 'disabledTools', 'disabledSkills',
    'injectSkills', 'stripLevel', 'systemPromptFile', 'appendPromptFiles',
  ]);
  const templates = {
    _file(name) { return path.join(TEMPLATES_DIR, `${name}.json`); },
    // Raw parsed body of an existing template file (no id/name re-injection), or
    // null if absent/malformed — used by save()'s merge-preserve.
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
          // Filename is authoritative identity: a hand-renamed file's name (and
          // id) follow its filename, whatever the in-file `name` hint says.
          const stem = f.slice(0, -'.json'.length);
          out.push({ ...obj, name: stem, id: stem });
        } catch { /* skip a malformed file, like agentLibrary */ }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    // Write the portable object (id/name stripped from the body — filename is the
    // identity, `name` re-added on read as a hint only). Overwrites <name>.json.
    _write(name, template) {
      ensureDir(TEMPLATES_DIR);
      const { id, ...body } = template;
      body.name = name; // portability hint; read treats the filename as canonical
      fs.writeFileSync(this._file(name), JSON.stringify(body, null, 2), { mode: 0o600 });
    },
    // Rename-in-place (drawer Edit / dialog template-mode): the renderer passes
    // both the OLD name as `id` and the NEW `name`. When they differ it's a
    // rename — write the new file and unlink the old so it can't orphan (the
    // rename-leak). The renderer's clash-check already refuses a rename onto
    // ANOTHER template's name (verified renderer saveTemplateFromForm), so this
    // trusts the caller and does no dest-collision check. Same name → plain
    // overwrite. This is the sole caller that needs id-vs-name semantics.
    save(template) {
      // Merge-preserve: carry forward keys the stored file has that the incoming
      // cfg does NOT own (EDITOR_OWNED), so an export-only field (autoCompact
      // pre-U9) or an unknown future key survives an edit round-trip instead of
      // being wiped by the full-object overwrite. Owned keys come SOLELY from
      // `template` — an omitted owned key is a clear, not a preserve.
      const prior = this._read(template.id);
      const merged = {};
      if (prior) for (const [k, v] of Object.entries(prior)) {
        if (!EDITOR_OWNED.has(k)) merged[k] = v;
      }
      Object.assign(merged, template);
      this._write(template.name, merged);
      if (template.id && template.id !== template.name) {
        try { fs.unlinkSync(this._file(template.id)); } catch {}
      }
    },
    // Name-keyed upsert for the user-facing save paths (export-from-session, the
    // form's "Save as Template", template-mode New). Scans existing filenames
    // case-insensitively and overwrites the matching EXACT filename (preserving
    // its original casing) so we never birth both Foo.json and foo.json on a
    // case-sensitive FS. No match → write <name>.json. Returns the stored object
    // (with id = its resolved filename stem) so callers can select it.
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
      try { fs.unlinkSync(this._file(id)); } catch {}
    },
  };

  // ---------------------------------------------------------------------------
  // Workspaces — each window owns one, sessions are scoped to workspaces
  // ---------------------------------------------------------------------------
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
      // Ensure at least one workspace exists
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
    // Per-workspace sidebar view state (group/sort/status/activity/search).
    // Merged so a partial update from the toolbar keeps the other keys; restored
    // on window create via workspace:getView.
    setView(id, view) {
      const all = this._load();
      const w = all.find(x => x.id === id);
      if (!w) return;
      w.view = { ...(w.view || {}), ...(view || {}) };
      this._save(all);
    },
    // Per-window UI zoom (View-menu zoom items), restored on window create.
    // 1.0 clears the key so untouched workspaces stay clean.
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
    // Live open-window marker, so quit + relaunch restores the same window SET.
    // Maintained by createWindow (true) and the closed handler (false); the
    // closed handler skips the clear while a quit is in flight — quit tears
    // every window down, and wiping the flags then would collapse the next
    // launch back to a single window.
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

  // ---------------------------------------------------------------------------
  // Prompts library — user-authored prompts as plain .md files under
  // ~/.clodex/library/prompts/{system,append}/*.md. On-disk (not a JSON blob) so
  // they're human-inspectable, portable, and — crucially — REFERENCEABLE: a
  // session points at a prompt by its filename stem, so one shared prompt (e.g.
  // the clodex syntax) can be reused across many sessions and edited once.
  //
  //   kind = subfolder, not frontmatter — so a `system` prompt file can be handed
  //   to the CLI verbatim via --system-prompt-file with nothing to strip.
  //     system — REPLACES the CLI's default system prompt (a full base persona)
  //     append — a composable fragment appended (non-system) on every spawn
  //
  // Spawn ordering for appends = filename sort, so prefix a stem (00-, 50-) to
  // control order; shared/stable appends first keeps the cache prefix aligned
  // across sessions. The IPC protocol is always prepended ahead of all of them.
  // ---------------------------------------------------------------------------
  const promptLibrary = {
    _dir(kind) { return path.join(PROMPTS_DIR, kind); },
    _file(kind, stem) { return path.join(this._dir(kind), `${stem}.md`); },
    // Every *.md across both kinds (or one kind if given). Identity is the
    // filename stem; save() keys by it so the file and the ref stay in sync.
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
      try { fs.unlinkSync(this._file(kind, stem)); } catch {}
      return this.list();
    },
  };

  // Slugify a legacy prompt title into a valid filename stem for migration.
  function slugifyPromptName(s) {
    const slug = String(s || '').trim().toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    return slug || `prompt-${Date.now()}`;
  }

  // One-shot migration: the pre-library prompts.json held {id,title,body} entries,
  // all append-kind by nature (they were --append-system-prompt material). Write
  // each out as append/<slug>.md, then rename the JSON aside so this never re-runs.
  // Non-destructive: never clobbers a file that already exists.
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

  // One-shot: the legacy templates.json blob (misfiled in userData) → per-file
  // library/templates/<name>.json. Existence-gated like migratePromptsJson.
  // Names predate validation, so slugify to the filename charset; a dup slug or
  // an already-present dest is SKIPPED (first-wins), and an empty slug drops the
  // entry. None of that is data loss: templates.json is RENAMED to .migrated,
  // never deleted, so any skipped/dropped entry stays recoverable on disk.
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

  // ---------------------------------------------------------------------------
  // Per-agent defaults — standing preferences keyed by agent NAME that outlive
  // any single session. Unlike sessions.json (whose entry a kill-from-UI
  // deletes), this store survives kill/recreate, so a strip level the user picks
  // in the bottom-bar menu becomes the default every FUTURE session of that name
  // is seeded with — applied only at (cold) session birth, never re-imposed on a
  // reload. Shape: { [name]: { strip: 1|2 } }, room to grow other per-agent prefs.
  // ---------------------------------------------------------------------------
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
    // Standing strip level for an agent name (0 if never set).
    getStrip(name) {
      const e = this._load()[name];
      return (e && (e.strip === 1 || e.strip === 2)) ? e.strip : 0;
    },
    // Record the agent's standing strip level; level 0 clears it (and prunes the
    // entry when no other prefs remain).
    setStrip(name, level) {
      const map = this._load();
      const lvl = (level === 1 || level === 2) ? level : 0;
      const e = map[name] || {};
      if (lvl > 0) e.strip = lvl; else delete e.strip;
      if (Object.keys(e).length) map[name] = e; else delete map[name];
      this._save(map);
    },
    // Global default tool-deny set that NEW sessions inherit when the create
    // dialog didn't pass an explicit one. Keyed by "*" (not a legal session name,
    // so it can't collide with a per-agent entry). A uniform deny set across
    // sessions yields a byte-identical, lean first cache segment (tools[] sits
    // before the M1 cache breakpoint), so sessions share one warm tools segment
    // instead of each cold-writing its own — measured cross-instance + cross-type.
    //
    // Tri-state: key ABSENT -> the in-code DEFAULT_TOOL_DENY_FLOOR (shipped
    // default); key PRESENT with a deny array (incl. EMPTY) -> the user's explicit
    // choice wins, so "" means "deny nothing" not "fall back to the floor".
    getDefaultDeny() {
      const e = this._load()['*'];
      if (e && Array.isArray(e.deny)) return e.deny.filter((t) => CLAUDE_TOOLS.includes(t));
      return DEFAULT_TOOL_DENY_FLOOR.slice();
    },
    // Persist the global default deny set. An explicit [] is recorded as-is (the
    // user opting out of the floor), distinct from clearing the key.
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

  // ---------------------------------------------------------------------------
  // Custom subagent library — user-authored agents as markdown-with-frontmatter
  // files under ~/.clodex/agents/. On-disk (not in a JSON blob) so they're
  // human-inspectable and portable into a project's .claude/agents or
  // ~/.claude/agents. At spawn the enabled subset becomes the CLI's inline
  // --agents flag (see agents-util.js). Claude-only; Codex has no equivalent.
  // ---------------------------------------------------------------------------

  const agentLibrary = {
    _file(name) { return path.join(AGENTS_DIR, `${name}.md`); },
    // Parsed metadata for every *.md in the folder. Identity is the frontmatter
    // `name` (falling back to the filename); save() keys the file by name so the
    // two stay in sync and duplicates can't arise by construction.
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
      try { fs.unlinkSync(this._file(name)); } catch {}
      return this.list();
    },
  };

  // Skill-injection library — same fs shape as agentLibrary, over
  // ~/.clodex/skills/*.md. Each file is a SKILL.md (frontmatter name/description
  // + instruction body); identity is the filename stem (the frontmatter `name`
  // is normalized to it at scaffold time, see skills-util.skillMd).
  const skillLibrary = {
    _file(name) { return path.join(SKILLS_LIB_DIR, `${name}.md`); },
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
    // Scope-filtered view for the OFFER surfaces (the Skills popover's inject
    // catalog, local + over the wire). The scope keys live in each file's
    // frontmatter, which list() carries verbatim as `content` — re-parse it here
    // rather than widen the list() item shape, so the remote skillLib payload
    // stays byte-for-byte what it was. list() itself stays unfiltered (drawer).
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
      try { fs.unlinkSync(this._file(name)); } catch {}
      return this.list();
    },
  };

  // Exec-command library — operator-authored command defs as JSON files under
  // ~/.clodex/library/exec/*.json. A STRING twin of agentLibrary (raw/save do
  // format-agnostic string I/O; the JSON validation lives above the store, in
  // the IPC layer, so the SAME exec-schema guard covers both authoring and a
  // hand-edited file's next load). Identity is the filename stem — the exact
  // token the `[agent:exec <cmd>]` dispatcher paths on. list() parses each file
  // for a summary row (name + argv preview) but skips a malformed one like the
  // other libraries, so a bad hand-edit never breaks the drawer.
  const execLibrary = {
    _file(name) { return path.join(EXEC_DIR, `${name}.json`); },
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
      try { fs.unlinkSync(this._file(name)); } catch {}
      return this.list();
    },
  };

  // ---------------------------------------------------------------------------
  // Reminders — durable self-schedules for the `[agent:remind …]` scheduler
  // (remind-scheduler.js owns the timers/clock; this is persistence ONLY, no
  // timing logic). A flat JSON array under userData, same _load/_save idiom as
  // persistence/workspaces. One record per schedule:
  //   { id, agent, kind, spec, body, nextFireAt, createdAt, lastFiredAt }
  // `spec` is the ORIGINAL spec string (re-parsed at load by the scheduler and
  // shown verbatim by `remind list`); `kind` is its parsed head; `nextFireAt`
  // is the epoch-ms the scheduler last computed (null for oncompact — event-
  // driven, no timer). The store trusts its sole caller (the scheduler) and does
  // no timing — it only assigns an id + createdAt and round-trips the fields.
  //
  // Ids are pure lowercase base36 (no separators) so a `[agent:remind cancel
  // <id>]` token satisfies remind-schedule's ID_RE ([a-z0-9]+); minted with a
  // collision retry against the live set.
  // ---------------------------------------------------------------------------
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
      // Astronomically unlikely fallback — timestamp tail keeps it unique + base36.
      return Date.now().toString(36).slice(-6);
    },
    list() { return this._load(); },
    listForAgent(agent) {
      return this._load().filter((r) => r.agent === agent);
    },
    // Persist a new schedule. Caller supplies agent/kind/spec/body/nextFireAt;
    // the store owns id + createdAt and initializes lastFiredAt. Returns the
    // stored record (with its minted id) so the caller can arm a timer for it.
    add({ agent, kind, spec, body = '', nextFireAt = null }) {
      const all = this._load();
      const id = this._mintId(all);
      const rec = {
        id, agent, kind, spec, body,
        nextFireAt: (typeof nextFireAt === 'number' ? nextFireAt : null),
        createdAt: Date.now(),
        lastFiredAt: null,
      };
      all.push(rec);
      this._save(all);
      return rec;
    },
    // Drop one schedule by id. Returns true if it existed (so `cancel` can be
    // silent on success and bounce a truly-unknown id).
    remove(id) {
      const all = this._load();
      const next = all.filter((r) => r.id !== id);
      if (next.length === all.length) return false;
      this._save(next);
      return true;
    },
    // Record a fire: stamp lastFiredAt and store the recomputed nextFireAt (null
    // for a spent one-shot the caller will remove separately, or an event kind).
    // No-op if the id is gone (cancelled between fire and mark).
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

  // ---------------------------------------------------------------------------
  // Operator inbox — [agent:notify-user] notes an agent raises to get Bogdan's
  // attention when it's blocked on his decision. Chronological by createdAt (the
  // store appends, so file order already IS chronological); the UI renders the
  // list newest-first. Ids are base36 like reminders (no cancel-token contract
  // here, but same _mintId keeps the two stores symmetric). readAt=null is the
  // unread state; unreadCount() drives the sidebar badge.
  // ---------------------------------------------------------------------------
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
    // Append a note. Caller supplies from/workspaceId/body; the store owns id +
    // createdAt and initializes readAt=null. Returns the stored record.
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
    // Stamp one note read. Returns true if it existed and flipped (a no-op on an
    // already-read note still returns true — the row IS read).
    markRead(id) {
      const all = this._load();
      const rec = all.find((n) => n.id === id);
      if (!rec) return false;
      if (rec.readAt == null) { rec.readAt = Date.now(); this._save(all); }
      return true;
    },
    // Stamp every unread note read at once. Returns the count flipped.
    markAllRead() {
      const all = this._load();
      const now = Date.now();
      let count = 0;
      for (const n of all) { if (n.readAt == null) { n.readAt = now; count++; } }
      if (count) this._save(all);
      return count;
    },
    // Drop one note by id. Returns true if it existed.
    remove(id) {
      const all = this._load();
      const next = all.filter((n) => n.id !== id);
      if (next.length === all.length) return false;
      this._save(next);
      return true;
    },
    unreadCount() { return this._load().reduce((n, r) => n + (r.readAt == null ? 1 : 0), 0); },
  };

  // ---------------------------------------------------------------------------
  // UI preferences — statusline components per CLI, global
  // ---------------------------------------------------------------------------
  const uiSettings = {
    _load() {
      try {
        const raw = JSON.parse(fs.readFileSync(UI_SETTINGS_FILE, 'utf-8'));
        return {
          statusline: {
            claude: Array.isArray(raw?.statusline?.claude) ? raw.statusline.claude : DEFAULT_UI_SETTINGS.statusline.claude,
            claudeCommand: typeof raw?.statusline?.claudeCommand === 'string' ? raw.statusline.claudeCommand : '',
            codex: Array.isArray(raw?.statusline?.codex) ? raw.statusline.codex : DEFAULT_UI_SETTINGS.statusline.codex,
          },
          proxyEnabled: typeof raw?.proxyEnabled === 'boolean' ? raw.proxyEnabled : DEFAULT_UI_SETTINGS.proxyEnabled,
          proxyUrl: typeof raw?.proxyUrl === 'string' ? raw.proxyUrl : DEFAULT_UI_SETTINGS.proxyUrl,
          lastCustomProxyUrl: typeof raw?.lastCustomProxyUrl === 'string' ? raw.lastCustomProxyUrl : DEFAULT_UI_SETTINGS.lastCustomProxyUrl,
          wirescopeDir: typeof raw?.wirescopeDir === 'string' ? raw.wirescopeDir : DEFAULT_UI_SETTINGS.wirescopeDir,
          wirescopePort: Number.isInteger(raw?.wirescopePort) ? raw.wirescopePort : DEFAULT_UI_SETTINGS.wirescopePort,
          compactOnResume: typeof raw?.compactOnResume === 'boolean' ? raw.compactOnResume : DEFAULT_UI_SETTINGS.compactOnResume,
          discoverOnStartup: typeof raw?.discoverOnStartup === 'boolean' ? raw.discoverOnStartup : DEFAULT_UI_SETTINGS.discoverOnStartup,
          recentCwds: Array.isArray(raw?.recentCwds) ? raw.recentCwds.filter((c) => typeof c === 'string').slice(0, 12) : DEFAULT_UI_SETTINGS.recentCwds,
          disableClaudeDesignMcp: typeof raw?.disableClaudeDesignMcp === 'boolean' ? raw.disableClaudeDesignMcp : DEFAULT_UI_SETTINGS.disableClaudeDesignMcp,
          theme: THEME_KEYS.includes(raw?.theme) ? raw.theme : DEFAULT_UI_SETTINGS.theme,
          sidebarWidth: clampSidebarWidth(raw?.sidebarWidth),
          remoteEnabled: typeof raw?.remoteEnabled === 'boolean' ? raw.remoteEnabled : DEFAULT_UI_SETTINGS.remoteEnabled,
          remotePort: Number.isInteger(raw?.remotePort) ? raw.remotePort : DEFAULT_UI_SETTINGS.remotePort,
          peers: sanitizePeers(raw?.peers) ?? DEFAULT_UI_SETTINGS.peers,
          peerAttached: sanitizePeerAttached(raw?.peerAttached) ?? {},
          peerVisible: sanitizePeerVisible(raw?.peerVisible) ?? {},
          peerControlled: sanitizePeerControlled(raw?.peerControlled) ?? {},
          // No top-level `sandbox` key — the boxes registry is the sole source.
          // A present-but-empty `boxes: []` (user deleted every box) is preserved;
          // a MISSING key (fresh install / pre-M6b file) falls to the default seed.
          boxes: sanitizeBoxes(raw?.boxes) ?? DEFAULT_UI_SETTINGS.boxes,
          lastRebootAt: Number.isFinite(raw?.lastRebootAt) ? raw.lastRebootAt : DEFAULT_UI_SETTINGS.lastRebootAt,
          pendingRebootNotice: sanitizeRebootNotice(raw?.pendingRebootNotice),
        };
      } catch { return DEFAULT_UI_SETTINGS; }
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
        discoverOnStartup: partial?.discoverOnStartup ?? cur.discoverOnStartup,
        recentCwds: Array.isArray(partial?.recentCwds) ? partial.recentCwds.filter((c) => typeof c === 'string').slice(0, 12) : cur.recentCwds,
        disableClaudeDesignMcp: partial?.disableClaudeDesignMcp ?? cur.disableClaudeDesignMcp,
        theme: THEME_KEYS.includes(partial?.theme) ? partial.theme : cur.theme,
        sidebarWidth: clampSidebarWidth(partial?.sidebarWidth ?? cur.sidebarWidth),
        remoteEnabled: partial?.remoteEnabled ?? cur.remoteEnabled,
        remotePort: Number.isInteger(partial?.remotePort) ? partial.remotePort : cur.remotePort,
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
      };
      try {
        atomicWriteFileSync(UI_SETTINGS_FILE, JSON.stringify(next, null, 2));
      } catch (e) { console.error('ui-settings save failed:', e); }
      return next;
    },
  };

  // Workspace rename → rescope the libraries. A `workspace:`-scoped skill/agent
  // keys off the workspace DISPLAY name, so renaming a workspace would orphan its
  // scoped files unless we rewrite them in the same motion. Exact-match on the old
  // trimmed name (what visibleTo compares); rewrites only the `workspace:`
  // frontmatter line's value, leaving the body and every other key byte-identical.
  // Returns the count rewritten. No-op when the name is unchanged/blank.
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

  // Seed the shipped library defaults (e.g. the clodex-team-lead system prompt) into
  // ~/.clodex/library on every launch, SEED-IF-ABSENT: a file the operator
  // already has is never touched, so operator edits always win over an upgrade's
  // shipped copy. The source tree rides app.asar (__dirname-relative), copied
  // out because a packaged read lives sealed inside the asar — the same reason
  // pot-bin materializes the pot CLI. Best-effort: a copy failure is logged and
  // skipped, never thrown (a missing seed degrades a feature, it never blocks a
  // launch). v2 GAP: this is presence-only — a version-STAMPED upgrade (overwrite
  // an unedited shipped copy when the app ships a newer one) needs a per-file
  // provenance marker and is deliberately out of v1.
  const SEED_SRC = resourcesDir || path.join(__dirname, 'resources', 'library');
  function seedLibraryDefaults() {
    const destRoot = path.join(registryDir, 'library');
    let src;
    try { src = fs.statSync(SEED_SRC); } catch { return; } // no seed tree shipped
    if (!src.isDirectory()) return;
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
        const dest = path.join(destRoot, childRel);
        if (fs.existsSync(dest)) continue; // seed-if-absent: never clobber
        try {
          ensureDir(path.dirname(dest));
          fs.copyFileSync(path.join(SEED_SRC, childRel), dest);
        } catch (e) {
          if (log) log.info?.('seed', `copy skipped ${childRel} (${e && e.message})`);
        }
      }
    }
  }

  migratePromptsJson(); // one-shot: prompts.json -> library/prompts/append/*.md
  migrateTemplatesJson(); // one-shot: templates.json -> library/templates/*.json
  seedLibraryDefaults(); // seed-if-absent: shipped library defaults -> ~/.clodex/library

  return {
    persistence, templates, workspaces, promptLibrary,
    agentDefaults, agentLibrary, skillLibrary, execLibrary, reminders, notifications, uiSettings,
    renameWorkspaceScope,
  };
}

module.exports = { initStores };
