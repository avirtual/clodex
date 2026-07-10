const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Notification, Tray, nativeImage } = require('electron');
const https = require('https');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const pty = require('node-pty');
const { ensureDir, atomicWriteFileSync, readJsonSafe } = require('./fs-util');
const { pathFor, runDirFor } = require('./clodex-paths');
const { runLegacySweep, findOrphans } = require('./legacy-sweep');

// Dock/Finder/Launchpad launches on macOS inherit launchd's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so `claude`/`codex` from ~/.local/bin or
// /opt/homebrew/bin aren't resolvable. Pull PATH from the user's login shell
// and merge it in. Only needed in packaged builds — dev mode inherits the
// shell env already.
function fixPathFromLoginShell() {
  if (!app.isPackaged) return;
  if (process.platform === 'win32') return;
  const userShell = process.env.SHELL || '/bin/bash';
  try {
    const out = execSync(
      `${userShell} -ilc 'printf __CLODEX_PATH__%s__CLODEX_PATH__ "$PATH"'`,
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/__CLODEX_PATH__(.*?)__CLODEX_PATH__/);
    if (!m || !m[1]) return;
    const shellPath = m[1].split(':').filter(Boolean);
    const current = (process.env.PATH || '').split(':').filter(Boolean);
    process.env.PATH = [...new Set([...shellPath, ...current])].join(':');
  } catch (e) {
    console.error('fixPathFromLoginShell failed:', e.message);
  }
}
fixPathFromLoginShell();

// Env self-decontamination. If Clodex was launched (or relaunched — including
// app.relaunch() from the remote restart endpoint) from inside a Claude Code
// session, the whole process tree inherits that session's CLAUDE_* markers.
// The damage is real and subtle: PTY-spawned CLIs see CLAUDE_CODE_SESSION_ID /
// CLAUDE_CODE_CHILD_SESSION and behave as nested child sessions — observed
// 2026-07-05 as every resumed agent silently NOT writing its transcript, which
// blinds the JsonlWatcher (intents dead) and the phone view at once. Strip the
// whole namespace before anything can inherit it; app.relaunch() then carries
// the clean env forward. An inherited ANTHROPIC_BASE_URL is only scrubbed when
// it points at an agent-scoped proxy route (ours or a dead predecessor's tee)
// — a user's own global endpoint override survives.
for (const k of Object.keys(process.env)) {
  if (/^CLAUDE(CODE|_)/.test(k)) delete process.env[k];
}
if (/\/agent\/[^/]+\//.test(process.env.ANTHROPIC_BASE_URL || '')) {
  delete process.env.ANTHROPIC_BASE_URL;
}

// Set once a quit is in flight (before-quit / non-darwin window-all-closed).
// Used to suppress node-pty's native teardown throws during shutdown.
let appQuitting = false;

// Last-resort net for node-pty. Its native layer (and internal socket teardown)
// can throw a Napi::Error asynchronously when a PTY fd closes — outside any
// try/catch we control — which otherwise aborts the whole app with SIGABRT.
// During shutdown that throw is benign (everything is being torn down anyway),
// so swallow it; at runtime we still crash loudly so real bugs aren't masked.
process.on('uncaughtException', (err) => {
  const msg = err && (err.message || String(err));
  const isPtyTeardown = /Napi|pty|ioctl|EBADF|read of closed|file descriptor/i.test(msg || '');
  if (appQuitting && isPtyTeardown) {
    console.error('Suppressed PTY teardown error during quit:', msg);
    try { log.warn('crash', `suppressed PTY teardown during quit: ${msg}`); } catch {}
    return;
  }
  try { log.error('crash', `uncaughtException: ${(err && err.stack) || msg}`); } catch {}
  throw err;
});

// Rejections that reach here are unhandled — record them, but keep Node's
// default behaviour (don't swallow) so nothing is masked.
process.on('unhandledRejection', (reason) => {
  try { log.error('crash', `unhandledRejection: ${(reason && reason.stack) || String(reason)}`); } catch {}
});

// ── Spawn diagnostics ───────────────────────────────────────────────────────
// node-pty's "posix_spawnp failed." (pty.cc:373) is the spawn of its prebuilt
// `spawn-helper`, NOT of claude/codex — the user command is exec'd later by the
// helper. So `which claude` succeeding tells you nothing: the real culprit is
// almost always a spawn-helper arch mismatch (e.g. x86_64 helper under an arm64
// Electron, or running under Rosetta), which posix_spawn rejects with EBADARCH.
// `npx electron-rebuild` is the fix. These helpers turn the opaque error into
// something actionable and log the system state at startup.

// `which`-style PATH lookup: node-pty exec's bare names ('claude'/'codex'), so
// a null here distinguishes "binary missing" from a deeper helper failure.
function whichBin(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/')) { try { fs.accessSync(cmd, fs.constants.X_OK); return cmd; } catch { return null; } }
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// CPU arch from a Mach-O header (first 8 bytes). Naming matches `process.arch`
// expectations via expectedArch() below.
function machoArch(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    const be = buf.readUInt32BE(0), le = buf.readUInt32LE(0);
    if (be === 0xcafebabe || be === 0xcafebabf) return 'universal';
    if (le === 0xfeedfacf) { // MH_MAGIC_64 (little-endian binary)
      const cpu = buf.readUInt32LE(4);
      if (cpu === 0x0100000c) return 'arm64';
      if (cpu === 0x01000007) return 'x86_64';
      return `cputype 0x${cpu.toString(16)}`;
    }
    if (le === 0xfeedface) return '32-bit';
    return 'not Mach-O';
  } catch (e) { return `unreadable (${e.code || e.message})`; }
}

// process.arch uses 'x64'; Mach-O reports 'x86_64'. Normalize to compare.
function expectedArch() { return process.arch === 'x64' ? 'x86_64' : process.arch; }

// Mirror node-pty's helperPath resolution (incl. the asar.unpacked rewrites).
// node-pty (lib/utils.js loadNativeModule) loads pty.node from the first of
// build/Release, build/Debug, prebuilds/<platform>-<arch> that exists, and
// resolves spawn-helper as a sibling of that. When no electron-rebuild has run,
// build/Release is empty and it falls back to the shipped prebuild — so we must
// check the same set, else the diagnostic points at a build/Release helper that
// isn't the one actually being spawned (false "missing", wrong fix suggested).
function unpackAsar(p) {
  return p.replace('app.asar', 'app.asar.unpacked').replace('node_modules.asar', 'node_modules.asar.unpacked');
}
function spawnHelperPath() {
  const root = path.join(path.dirname(require.resolve('node-pty')), '..');
  const candidates = [
    path.join(root, 'build', 'Release', 'spawn-helper'),
    path.join(root, 'build', 'Debug', 'spawn-helper'),
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ].map(unpackAsar);
  return candidates.find(fs.existsSync) || candidates[0];
}

function detectRosetta() {
  if (process.platform !== 'darwin') return false;
  try {
    return execSync('sysctl -n sysctl.proc_translated', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1';
  } catch { return false; }
}

function collectSystemDiagnostics() {
  const helper = spawnHelperPath();
  let helperExecutable = false;
  try { fs.accessSync(helper, fs.constants.X_OK); helperExecutable = true; } catch {}
  return {
    platform: process.platform, procArch: process.arch, rosetta: detectRosetta(),
    electron: process.versions.electron, node: process.versions.node,
    claude: whichBin('claude'), codex: whichBin('codex'),
    helperPath: helper, helperExists: fs.existsSync(helper),
    helperExecutable, helperArch: machoArch(helper),
  };
}

// Compact, single-line summary suitable for embedding in a thrown spawn error.
function diagSummary(d = collectSystemDiagnostics()) {
  return `proc=${d.platform}/${d.procArch}${d.rosetta ? '(rosetta)' : ''} helper=${d.helperArch} `
    + `electron=${d.electron} node=${d.node}`;
}

// The single source of truth for "is this install broken in a way that will
// fail every spawn?". Returns a short, user-facing string (or null when fine)
// shared by the startup log, the thrown spawn error, and the UI banner. The
// node-pty spawn-helper is what posix_spawn actually launches, so any problem
// with it — missing, non-executable, or wrong arch — sinks every session.
function diagWarning(d = collectSystemDiagnostics()) {
  if (d.platform !== 'darwin') return null;
  if (!d.helperExists) {
    return 'node-pty spawn-helper is missing — sessions can\'t start. Fix: npx electron-rebuild';
  }
  if (!d.helperExecutable) {
    return `node-pty spawn-helper is not executable — sessions can't start. Fix: chmod +x "${d.helperPath}"`;
  }
  if (!['universal', '32-bit'].includes(d.helperArch) && d.helperArch !== expectedArch()) {
    return `spawn-helper arch (${d.helperArch}) != app arch (${expectedArch()}) — `
      + 'every session fails with "posix_spawnp failed." Fix: npx electron-rebuild';
  }
  if (d.rosetta) {
    return 'Running under Rosetta — rebuild native modules for the running arch: npx electron-rebuild';
  }
  return null;
}

function logStartupDiagnostics() {
  const d = collectSystemDiagnostics();
  const lines = [
    '── Clodex startup diagnostics ──',
    `process:      ${d.platform}/${d.procArch}${d.rosetta ? '  ⚠ Rosetta-translated' : ''}   electron ${d.electron}  node ${d.node}`,
    `spawn-helper: ${d.helperPath}`,
    `              exists=${d.helperExists} executable=${d.helperExecutable} arch=${d.helperArch}`,
    `claude:       ${d.claude || 'NOT FOUND on PATH'}`,
    `codex:        ${d.codex || 'NOT FOUND on PATH'}`,
  ];
  const warning = diagWarning(d);
  if (warning) lines.push(`⚠ ${warning}`);
  console.log(lines.join('\n'));
  return d;
}

// Clodex-owned runtime dir: registry, sockets, hook scripts, prompt files,
// jsonl symlinks, spilled messages. Lives in $HOME (not /tmp) so macOS's
// 3-day tmp reaper can't delete files under long-running sessions, and kept
// short because run/{name}/agent.sock must fit the 104-char Unix socket path
// limit (the per-agent run/ dir grammar — clodex-paths.js — costs ~10 chars more
// than the old flat {name}.sock; still within budget for a 64-char name under a
// normal $HOME). Moving here (v0.6.6) ended /tmp/wb-wrap interop with Python
// wb-wrap. Per-agent runtime artifacts live under run/<name>/ (clodex-paths).
const REGISTRY_DIR = path.join(os.homedir(), '.clodex');
const MSG_DIR = path.join(REGISTRY_DIR, 'messages');
// Layer-3 delivery parking store (Claude): pending/<name>/ per agent. Deliveries
// that arrive while the operator is composing are parked here and drained as
// UserPromptSubmit additionalContext on the next submit (see pending-store.js).
const PENDING_DIR = path.join(REGISTRY_DIR, 'pending');
// DM federation: per-origin outbox for box→consumer replies over the one-way
// tunnel (a consumer claims its mail on the hello cadence — see peer-outbox.js).
const OUTBOX_DIR = path.join(REGISTRY_DIR, 'peer-outbox');
// Our own label on the peer wire (the box's hostLabel AND the origin our
// outbound DMs carry). Computed once — never per request — so it can't drift.
const SELF_LABEL = os.hostname().replace(/\.local$/, '');
const MAX_MSG = 65536;
const MSG_SPILL_THRESHOLD = 500;
const MSG_MAX_AGE = 1800;
const MSG_CLEANUP_INTERVAL = 5 * 60 * 1000; // ms
// Grace period after creating an ad-hoc deploy-fix session before injecting its
// briefing — lets the fresh Claude CLI reach its input prompt so the keystrokes
// aren't typed into a still-booting TUI.
const DEPLOY_FIX_INJECT_DELAY_MS = 4000;

// ---------------------------------------------------------------------------
// Persistent ops/error log — Clodex mostly runs headless (tray, no console),
// so errors and lifecycle events otherwise vanish. One rolling plain-text file
// in the (already 0700) runtime dir: `ISO  LEVEL  [tag]  message`. Append-only,
// no dependency, no framework. Rotation is deliberately trivial: one generation
// kept, rotated once at startup when the file passes the cap. Only coarse,
// low-frequency events log here (lifecycle, state-mutating intents, autocompact
// decisions, peer transitions, uncaught errors) — never per-keystroke or
// per-telemetry-frame. `initLog()` runs once at startup (rotation + a header);
// every write self-heals the dir so a call before init still lands.
// ---------------------------------------------------------------------------
const LOG_FILE = path.join(REGISTRY_DIR, 'clodex.log');
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function initLog() {
  try {
    ensureDir(REGISTRY_DIR);
    const st = fs.statSync(LOG_FILE);
    if (st.size > LOG_ROTATE_BYTES) {
      try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
    }
  } catch { /* file absent (first run) or unrotatable — writes create it */ }
}

function writeLog(level, tag, message) {
  try {
    const line = `${new Date().toISOString()}  ${level}  [${tag}]  ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Self-heal a missing dir once, then give up — logging must never throw
    // into a caller (it wraps lifecycle paths, the PTY, and the crash net).
    try { ensureDir(REGISTRY_DIR); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${level}  [${tag}]  ${message}\n`); } catch {}
  }
}

const log = {
  info: (tag, message) => writeLog('INFO', tag, message),
  warn: (tag, message) => writeLog('WARN', tag, message),
  error: (tag, message) => writeLog('ERROR', tag, message),
};
// Phase W1 shadow mode (CLODEUX-PLAN.md): route claude sessions through the
// in-process wire tee (wire/proxy.js): the live intent + telemetry path for
// wire-routed claude sessions. Operational + wire-side events land in
// ~/.clodex/wire-shadow.jsonl (the name is historical — in the default
// full-cutover state the two-sided wire-vs-JSONL diff only runs when intents
// are forced back to JSONL via CLODEX_WIRE_INTENTS=0). An external wirescope
// keeps its role via per-agent upstream chaining. Default ON since v2.0 — the
// tee is the intended steady state (W2/W3 gates green, shipped and stable);
// CLODEX_WIRE_SHADOW=0 is the explicit revert to the pre-wire JsonlWatcher
// path (also the automatic fallback when the tee fails to come up or a session
// isn't wire-routed — see intentSource resolution in create()).
const WIRE_SHADOW = process.env.CLODEX_WIRE_SHADOW !== '0';
// W2 telemetry cutover: overlay the wire-carried fields (cost/turns/
// refusals/inputTokens/warmth + hold ownership) onto each poll payload before
// it reaches the renderer (WireTelemetry.overlay). Requires WIRE_SHADOW (the
// wire must be up). The shadow diff keeps comparing the RAW poll record, so
// validation evidence stays honest while the overlay is live. Defaults ON
// wherever the wire is up — the live-shadow readout passed the reviewer gate
// (0% worst cost delta, 47/47 warmth, CLODEUX-PLAN.md 2026-07-02 evening);
// CLODEX_WIRE_TELEMETRY=0 is the explicit revert to poll-only display.
const WIRE_TELEMETRY_LIVE = process.env.CLODEX_WIRE_TELEMETRY != null
  ? process.env.CLODEX_WIRE_TELEMETRY === '1'
  : WIRE_SHADOW;
// W3 intent cutover: wire turn.completed becomes the LIVE intent path for
// wire-routed claude sessions; the always-on 250ms transcript parse is
// replaced by a TranscriptSentinel (symlink identity + compact rendezvous +
// tee-failure recovery — wire-intents.js). Evidence: W1 shadow gates green
// plus the healthy-epoch differ (7/7 intents both-seen, 0 unmatched; every
// historical unmatched maps to the dead-tee window or JSONL flush latency).
// Codex and wire-failed spawns keep the JsonlWatcher path untouched.
// CLODEX_WIRE_INTENTS=0 reverts to JSONL dispatch (with wire shadow-compare).
const WIRE_INTENTS_LIVE = process.env.CLODEX_WIRE_INTENTS != null
  ? process.env.CLODEX_WIRE_INTENTS === '1'
  : WIRE_SHADOW;
const LONG_TEXT_THRESHOLD = 200;
const LONG_TEXT_DELAY = 1000;
const SHORT_TEXT_DELAY = 50;
// After the compact-summary entry lands, wait this long before injecting the
// self-compact continuation turn — lets the CLI finish settling its post-compact
// prompt so the injected turn isn't swallowed by the in-progress redraw.
const COMPACT_CONTINUATION_DELAY = 1500;
// After a reloaded session first reports a sessionId (CLI booted), wait this long
// before injecting the handoff — a cold boot's input loop settles slower than a
// post-compact redraw, so give it more room than COMPACT_CONTINUATION_DELAY.
const RELOAD_CONTINUATION_DELAY = 2500;
// Safety valve for the inject-hold queue: if the release event never comes
// (compact summary never lands, activity tracker wedged at thinking), force
// the flush rather than holding messages hostage forever. Native /compact on
// a heavy context runs a couple of minutes; this sits well past it. A
// legitimately longer turn just degrades to today's behavior — the flush
// lands mid-turn and becomes the next turn, exactly as an unheld inject would.
const INJECT_HOLD_TIMEOUT = 5 * 60 * 1000;
// Release valve for a self-fired /compact whose summary never lands (the CLI
// errored, the app restarted mid-compaction, the transcript rendezvous missed).
// Without it, _compactGuard + _compactContinuation stay set forever and the
// in-flight guard silently suppresses every future self-compact. 5 min sits
// comfortably past worst-case legitimate big-context compaction time, so it
// only ever fires on a genuinely stuck compact — half the 10-min sentinel arm
// timeout. On fire it clears the stuck state and does NOT auto-retry (a silent
// re-compact minutes later is a worse surprise than the agent re-issuing the
// intent).
const COMPACT_INFLIGHT_TIMEOUT = 5 * 60 * 1000;
// Flushing starts with Ctrl-U, which would eat a half-typed operator draft.
// If a human touched the pane this recently, defer the flush and retry — the
// hold gave US the timing decision, so the draft hazard is ours to avoid
// (immediate injects keep today's behavior; their timing is the sender's).
// Every injection now drains through a per-session InjectQueue (atomicity: one
// Ctrl-U→Enter at a time, no interleave) whose quiet-gate defers the start of an
// item while a human touched the pane within INJECT_QUIET_MS — the leading
// Ctrl-U would eat an un-submitted operator/controller draft. Capped by
// INJECT_QUIET_MAXWAIT so a walked-away draft can't starve deliveries (the cap
// falls back to inject-anyway, never worse than pre-queue behavior). The window
// is short (2s) because it applies to EVERY inject including plain idle
// deliveries; the old 10s value only ever gated post-hold batch flushes.
// MAXWAIT is for the WALKED-AWAY-DRAFT case only. The original 30s misfired
// through LIVE composition — an operator writing a long draft while agents
// report in got spliced mid-word twice (confirmed actively typing). 5min matches
// what layer-3 prompt-parking will set; once parking lands (deliveries park to a
// file instead of injecting while typing), cap-fires should drop to ~zero.
const INJECT_QUIET_MS = 2 * 1000;
const INJECT_QUIET_MAXWAIT = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Stores — persistence, templates, workspaces, the prompt/agent/skill
// libraries, and UI settings. Their objects are built by initStores() in
// stores.js and assigned in app.whenReady() (see below). Declared `let` so
// every module-scope reference resolves at call time, after the factory has
// run — the path derivations now live inside the factory, which retires the
// old PERSIST_FILE-before-whenReady landmine. (memoryStore stays local — it
// is a separate memory-store.js factory, not one of the eight.)
// ---------------------------------------------------------------------------

let persistence, templates, workspaces, promptLibrary,
  agentDefaults, agentLibrary, skillLibrary, uiSettings;
// Workspace-rename → library rescope helper (from initStores). Not one of the
// eight stores — a cross-library maintenance fn used by workspace:setName to
// keep `workspace:`-scoped skills/agents pointing at the renamed workspace.
let renameWorkspaceScope;

// Resolve a session's strip level from its persisted entry, honoring the legacy
// `stripThinking:'on'` field (pre-leveled) as level 1. Single source of truth
// for both the poller's wire re-assert and the IPC/getArgs surface.
function stripLevelOf(entry) {
  if (!entry) return 0;
  if (entry.stripLevel === 1 || entry.stripLevel === 2) return entry.stripLevel;
  if (entry.stripThinking === 'on') return 1; // legacy boolean field
  return 0;
}

// Auto-compact-before-cold: default ON; only an explicit false opts out (so
// every pre-existing entry — and a missing one — is on).
function autoCompactOf(entry) {
  return !(entry && entry.autoCompact === false);
}

// Has this conversation already received the memory boot digest?
function isDigested(entry, sessionId) {
  return !!(entry && sessionId && Array.isArray(entry.digested) && entry.digested.includes(sessionId));
}




// Resolve a session's system-prompt ref to an absolute, readable file path (for
// --system-prompt-file), or null to fall back to the CLI default. A deleted/
// renamed ref degrades to default rather than blocking the spawn.
function resolveSystemPromptFile(stem) {
  if (!stem) return null;
  const p = promptLibrary._file('system', stem);
  try { fs.accessSync(p, fs.constants.R_OK); return p; }
  catch { return null; }
}

// Resolve a session's ordered append refs to their bodies. Missing/empty stems
// are skipped silently (a deleted shared prompt must never break a spawn).
function readAppendBodies(stems) {
  const out = [];
  for (const stem of stems || []) {
    const body = promptLibrary.raw('append', stem);
    if (body != null && body.trim()) out.push(body);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agent memory store (spec §10) — store + boot-digest composer live in
// memory-store.js (extracted for Electron-free tests; the design rationale
// moved with the code). What stays HERE is the delivery plumbing: the
// SessionStart hook ships the digest to NEW conversations (source
// startup/clear — see setupClaudeHook), and the digest ledger in
// sessions.json (`digested: [sessionIds]`) makes sure a conversation gets it
// exactly ONCE across GUI restarts — resumed conversations that predate the
// feature receive a single tail append instead (_maybeDeliverDigest).
// ---------------------------------------------------------------------------

const MEMORY_DIR = path.join(REGISTRY_DIR, 'library', 'memory');
const { createMemoryStore, composeDigest } = require('./memory-store');
const memoryStore = createMemoryStore(MEMORY_DIR);



// clodex skill-injection library: user-authored SKILL.md files in
// ~/.clodex/skills/*.md. At spawn the enabled subset is scaffolded into a
// per-session plugin under ~/.clodex/skill-plugins/<name>/ and injected via
// --plugin-dir (see skills-util.js). Claude-only.
const SKILL_PLUGINS_DIR = path.join(REGISTRY_DIR, 'skill-plugins');
const SKILL_PLUGIN_NAME = 'clodex-skills';



// Scaffold the per-session injection plugin from the enabled skill names and
// return its directory (for --plugin-dir), or null when nothing is injected.
// The dir is rebuilt from scratch each spawn so a removed/edited library skill
// can't linger. Writes only under ~/.clodex — never the repo or ~/.claude.
function writeSkillPlugin(name, injectSkills) {
  const lib = skillLibrary.list();
  // Auto-include `sessions:`-scoped library skills for this session (assignment =
  // intent) — a spawn-time UNION with the persisted injectSkills, never written
  // back to the record. skillLibrary.list() carries the raw file as `content`, so
  // parse the scope frontmatter here to feed autoEnabledFor (its list() shape has
  // no meta, kept lean for the wire).
  const scoped = lib.map((s) => ({ name: s.name, meta: parseSkillFrontmatter(s.content).meta }));
  const effective = unionEnabled(injectSkills, scoped, name);
  const plugin = buildSkillPlugin(effective, lib, SKILL_PLUGIN_NAME);
  const dir = path.join(SKILL_PLUGINS_DIR, name);
  // Clear any prior scaffold (set shrank, or nothing injected now).
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!plugin) return null;
  const manifestDir = path.join(dir, '.claude-plugin');
  ensureDir(manifestDir);
  fs.writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify(plugin.manifest, null, 2), { mode: 0o600 });
  for (const s of plugin.skills) {
    const sdir = path.join(dir, 'skills', s.name);
    ensureDir(sdir);
    fs.writeFileSync(path.join(sdir, 'SKILL.md'), s.skillMd, { mode: 0o600 });
  }
  return dir;
}

function cleanupSkillPlugin(name) {
  try { fs.rmSync(path.join(SKILL_PLUGINS_DIR, name), { recursive: true, force: true }); } catch {}
}


const CLAUDE_SL_COMPONENTS = ['model', 'context', 'cost', 'cwd', 'git-branch'];
const CODEX_SL_COMPONENTS = [
  'context-used', 'model-name', 'project-root', 'git-branch',
  'five-hour-limit', 'weekly-limit', 'current-dir', 'context-remaining',
  'model-with-reasoning',
];

// Per-session raw-output ring buffer replayed on peer attach.
const SCROLLBACK_MAX = 256 * 1024;


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// isAlive + peer registry + Unix-socket Transport live in agent-transport.js
// (M3). REGISTRY_DIR + MAX_MSG are injected; isAlive is reused by SessionManager.
const { createAgentTransport } = require('./agent-transport');
const { isAlive, registry, Transport } = createAgentTransport({ REGISTRY_DIR, MAX_MSG });

// ---------------------------------------------------------------------------
// JSONL Watcher (port of jsonl_watcher.py)
// ---------------------------------------------------------------------------

// IPC protocol prompt + default compact-continuation live in ipc-prompt.js
// (moved out in M3 — the sole protocol source of truth). Pure strings.
const { IPC_PROMPT, DEFAULT_COMPACT_CONTINUATION } = require('./ipc-prompt');

// Re-render statusline scripts for all running Claude sessions. Called when
// the user updates preferences — Claude re-reads the script on each status
// update, so changes show up within a tick.
function rebuildAllStatusScripts(manager) {
  for (const [name, s] of manager.sessions) {
    if (s.agentType !== 'claude') continue;
    const p = pathFor(REGISTRY_DIR, name, 'statusline');
    try { fs.writeFileSync(p, renderClaudeStatusScript(name, !!s.proxyBase, uiSettings, REGISTRY_DIR), { mode: 0o700 }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// wirescope integration — identity probe + per-session telemetry pull
// ---------------------------------------------------------------------------
// Agent sessions route through a local analytical proxy at
// <base>/agent/<proxyAgent>/…. When that proxy is the real wirescope we can
// PULL live per-session cost / cache-warmth / context off the wire — data the
// statusline can't surface for an idle session (its script only runs while the
// user is interacting). One /_status poll per base, fanned out to sessions by
// EXACT proxyAgent match. We deliberately do not subscribe (push is for
// streaming/refusals, a clodex2 concern).
// See https://github.com/avirtual/wirescope (INTEGRATION.md).

const { PROXY_AGENT_PREFIX, mintProxyAgent, resolveProxyAgentId, pickProxyRecord, shapeProxyRecord, AUTO_COMPACT, shouldAutoCompact, autoCompactDecision, isHumanPtyInput, draftChunkSignal, isDraftOpen, peerStatusLabel, shouldHoldDm, updateApplies } = require('./proxy-util');
const { buildAgentsArg, denyAgentRules } = require('./agents-util');
const { extractFileTouches, noteFileTouches, vetFileIntent } = require('./file-touch');
const { classifyNotification } = require('./attention');
const { InjectQueue, isInjectInFlight } = require('./inject-queue');
const { parkDelivery, drainPending, hasPending, parkIdInUse, claimParkedById } = require('./pending-store');
const { enqueueOutbox, claimOutbox, outboxHasOrigin, listOutboxOrigins } = require('./peer-outbox');
const { parseIntent, shadowIntentKey } = require('./intent-scanner');
const { mergeClaudeSystemPrompt, mergeCodexInstructions, parseCtxFile } = require('./argv-merge');
const { renderClaudeStatusScript, codexStatusLineArg, normalizeProxyBase, resolveProxyBase } = require('./statusline');
const { jsonlToMarkdown, jsonlToMessages, extractText } = require('./transcript');
const { initStores } = require('./stores');
const { CLAUDE_TOOLS, CLAUDE_SKILLS, SKILL_REENABLE_CONFIRMED, DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, THEME_KEYS } = require('./catalogs');

// Short lowercase base36 token (park/resend handles). Concatenates random
// draws so trailing-zero truncation can't shorten the result below `len`.
function randBase36(len) {
  let s = '';
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}
const { ctxReminderFor } = require('./ctx-reminder');
const { buildSkillPlugin, parseSkillFrontmatter } = require('./skills-util');
const { unionEnabled } = require('./scope-util');
const { sshRun } = require('./ssh-run');
const { probePeer, fixSessionName, buildDeployFixBriefing, classifyDeployFolder, homeRelativize, resolveDeployFolder } = require('./peer-deploy');
const { resolveSessionArgsPatch } = require('./session-args');
// wirescope client/poller live in wirescope-proxy.js and the supervisor in
// wirescope-supervisor.js (M3). ProxyClient needs no injection; ProxyPoller +
// the supervisor take log / stripLevelOf / WIRE_TELEMETRY_LIVE / ProxyClient by
// value and uiSettings via getter. PROXY_* tuning consts moved into the proxy
// module; PROXY_REPORT_TIMEOUT is re-imported (one /_report call still needs it).
const { ProxyClient, createProxyPoller, PROXY_REPORT_TIMEOUT } = require('./wirescope-proxy');
const ProxyPoller = createProxyPoller({
  log, stripLevelOf, WIRE_TELEMETRY_LIVE,
  // M3-leak fix deps: helpers by value (hoisted fn declarations), whenReady-
  // assigned singletons as getters, and SessionManager's static command map
  // deferred past the class construction below.
  autoCompactOf, peerProxyView,
  getPersistence: () => persistence,
  getRemoteServer: () => remoteServer,
  getContextCommands: () => SessionManager.CONTEXT_COMMANDS,
});
const { createWirescopeSupervisor } = require('./wirescope-supervisor');
const { WirescopeSupervisor } = createWirescopeSupervisor({ log, ProxyClient, getUiSettings: () => uiSettings });
const wirescope = new WirescopeSupervisor();

// Parse the current skill roster from a Claude session's transcript. The CLI
// records the available-skills list as `attachment` entries of type
// "skill_listing", each carrying a structured `names` array; the latest one
// reflects what's loaded now. Returns [] when there's no transcript yet (a
// fresh session) or no skill_listing recorded. This is clodex's STANDALONE
// catalog source for the Skills popover — no proxy needed; wirescope only
// enriches with the aggregate per-turn token cost (the `skills` composition
// category). A skill turned off via skillOverrides vanishes from later
// listings, so callers union this with the persisted disabled set.
function parseSkillRoster(name) {
  try {
    const linkPath = pathFor(REGISTRY_DIR, name, 'transcript');
    const real = fs.realpathSync(linkPath);
    const lines = fs.readFileSync(real, 'utf8').split('\n');
    let names = [];
    for (const line of lines) {
      if (!line || line.indexOf('skill_listing') === -1) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const att = obj && obj.type === 'attachment' ? obj.attachment : null;
      if (att && att.type === 'skill_listing' && Array.isArray(att.names)) {
        names = att.names; // last one wins — reflects the current roster
      }
    }
    return names;
  } catch { return []; }
}

// Read the EFFECTIVE lower-layer skill state for a session's cwd by merging the
// three editable settings layers the CLI loads BELOW our generated --settings
// (layer 4), per-key later-wins: user (~/.claude/settings.json) < project
// (<cwd>/.claude/settings.json) < local (<cwd>/.claude/settings.local.json).
// Also probes the macOS managed-settings file for a policy lock on the skills
// surface (strictPluginOnlyCustomization). This lets the popover render a skill
// that is off in a lower layer as unchecked + disabled + labeled with its
// provenance, instead of misleadingly showing it checked — and lets us avoid a
// silent no-op re-enable clodex can't actually perform (see SKILL_REENABLE_
// CONFIRMED). Pure file reads; standalone, no proxy. policy/MDM is read-only
// from a UI's perspective and only the lock matters here.
function readEffectiveSkillState(cwd) {
  const layers = [
    { src: 'global', file: path.join(os.homedir(), '.claude', 'settings.json') },
    { src: 'project', file: cwd ? path.join(cwd, '.claude', 'settings.json') : null },
    { src: 'local', file: cwd ? path.join(cwd, '.claude', 'settings.local.json') : null },
  ];
  const overrides = {}; // name -> { value:'off'|'on', source } — later layer wins
  for (const { src, file } of layers) {
    if (!file) continue;
    const data = readJsonSafe(file);
    const so = data && data.skillOverrides;
    if (so && typeof so === 'object') {
      for (const [k, v] of Object.entries(so)) {
        if (v === 'off' || v === 'on') overrides[k] = { value: v, source: src };
      }
    }
  }
  let skillsLocked = false;
  if (process.platform === 'darwin') {
    const managed = readJsonSafe('/Library/Application Support/ClaudeCode/managed-settings.json');
    const lock = managed && managed.strictPluginOnlyCustomization;
    if (lock === true) skillsLocked = true;
    else if (Array.isArray(lock) && lock.includes('skills')) skillsLocked = true;
  }
  return { overrides, skillsLocked };
}

// Tools mirror of readEffectiveSkillState: reads permissions.deny across the
// same settings chain (user < project < local) plus the macOS managed file, so
// the tools popover can render a tool disabled in a layer clodex doesn't own as
// unchecked + read-only + labeled, instead of a checked toggle that silently
// does nothing. Only a BARE tool name ("SendMessage") turns the whole tool off;
// a SCOPED entry ("Agent(foo)", "Bash(rm:*)") denies a slice and leaves the tool
// available, so it's ignored here. permissions.deny is UNION (deny always wins,
// no allow overrides it), so such a deny is unrevokable from clodex's own
// layer-4 settings — hence always read-only (skills' canReenable has no analog).
function readEffectiveToolState(cwd) {
  const layers = [
    { src: 'global', file: path.join(os.homedir(), '.claude', 'settings.json') },
    { src: 'project', file: cwd ? path.join(cwd, '.claude', 'settings.json') : null },
    { src: 'local', file: cwd ? path.join(cwd, '.claude', 'settings.local.json') : null },
  ];
  if (process.platform === 'darwin') {
    layers.push({ src: 'policy', file: '/Library/Application Support/ClaudeCode/managed-settings.json' });
  }
  const overrides = {}; // tool -> { value:'off', source, locked } — later layer wins
  for (const { src, file } of layers) {
    if (!file) continue;
    const data = readJsonSafe(file);
    const deny = data && data.permissions && data.permissions.deny;
    if (!Array.isArray(deny)) continue;
    for (const entry of deny) {
      if (typeof entry !== 'string' || entry.includes('(')) continue; // bare names only
      overrides[entry] = { value: 'off', source: src, locked: src === 'policy' };
    }
  }
  return { overrides };
}

// Claude Code stores transcripts under ~/.claude/projects/<slug>/<uuid>.jsonl,
// where the slug is the cwd with every '/' and '.' turned into '-'. Used only
// as a FALLBACK for the session picker when the live run/<name>/transcript.jsonl
// symlink can't be resolved (e.g. a never-run / dead session); the symlink's
// real directory is preferred and authoritative when present.
function claudeProjectDir(cwd) {
  if (!cwd) return null;
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}

// When was this session last actually active? The resumed transcript's mtime
// is the last real turn, and it survives GUI restarts (unlike the ~/.clodex
// symlink, which _cleanup unlinks on exit). Claude-only: codex rollout paths
// aren't derivable from the sessionId, so those fall back to spawn time.
function lastTranscriptWrite(agentType, cwd, sessionId) {
  if (agentType !== 'claude' || !sessionId) return null;
  const dir = claudeProjectDir(cwd);
  if (!dir) return null;
  try { return fs.statSync(path.join(dir, `${sessionId}.jsonl`)).mtimeMs; } catch { return null; }
}

// Resume-time transcript bake. Before --resume, ask wirescope to bake the
// session's on-disk transcript down to its safe-to-drop set so the prefix the
// CLI replays is already slim — moving the strip from per-turn-on-the-wire to
// once-on-disk.
//
// Warmth is IRRELEVANT, and that's the whole point. The prefix cache is keyed
// on the WIRE bytes wirescope sends the API, not on what the CLI reads off
// disk. With live-strip active, a plain resume sends the fat transcript and
// wirescope strips it to X; a baked resume sends the slim transcript and
// wirescope strips it to the SAME X (the bake is idempotent under the strip).
// Same wire bytes → same cache key → the bake can't bust a warm cache. So
// there is no cold-only gate: the safety isn't warmth, it's the invariant
// bake ⊆ live-strip — the bake removes ONLY what the wire already drops, which
// is what keeps the result byte-identical to the live wire (asserted by
// wire_delta.byte_identical_to_live_wire). We pass the session's strip level so
// wirescope matches bake depth to it; wirescope owns the transform and MUST
// fail-safe (!ok, no rewrite) on anything it can't guarantee identical.
// FAIL-SAFE throughout: opt-in, proxy-gated, and ANY error / !ok returns
// quietly so the caller resumes the ORIGINAL transcript untouched.
async function maybeCompactBeforeResume(entry) {
  try {
    if (!uiSettings.get().compactOnResume) return;     // opt-in — off by default
    if (!entry || entry.type !== 'claude' || !entry.sessionId) return;
    const base = resolveProxyBase(entry.proxy, uiSettings);        // null when proxy disabled → skip
    if (!base) return;
    // Fire only once the proxy actually answers /_identity — robust against the
    // launch race (proxy not up yet at restore → skip → resume original), rather
    // than relying on auto-start ordering. /_compact is wirescope-only.
    const probe = await ProxyClient.probe(base);
    if (!probe || probe.product !== 'wirescope') return;
    const dir = claudeProjectDir(entry.cwd);
    if (!dir) return;
    const tpath = path.join(dir, `${entry.sessionId}.jsonl`);
    if (!fs.existsSync(tpath)) return;
    const r = await ProxyClient.compact(base, entry.sessionId, tpath, stripLevelOf(entry));
    const j = (r && r.json) || {};
    if (j.ok && !j.noop) {
      // wire_delta (wirescope v0.6.12+) reports the byte-identity readout: how
      // many pure-thinking turns bake out-stripped live-strip (each re-caches
      // once) and whether the baked source is byte-identical to the live wire.
      const wd = j.wire_delta || {};
      const ptt = wd.pure_thinking_turns;
      const bid = wd.byte_identical_to_live_wire;
      const tag = ptt != null
        ? ` [pure_thinking_turns:${ptt}, byte_identical:${bid}]`
        : '';
      console.log(`compact ${entry.name}: ${j.lines_in ?? '?'}→${j.lines_out ?? '?'} lines, ~${j.tokens_removed ?? '?'} tok removed${tag}`);
    } else if (j.ok === false) {
      console.warn(`compact ${entry.name} skipped (${j.reason || 'unknown'}) — resuming original`);
    }
  } catch (e) {
    console.warn(`compact ${entry?.name} failed (${e.message}) — resuming original`);
  }
}

// Pull picker metadata out of one transcript file: the generated title (last
// ai-title entry — they're rewritten as the session grows, latest wins), the
// first/last activity timestamps, and a user-turn count. Tolerant of partial
// lines (file may be mid-write) — bad lines are skipped, never thrown.
function readSessionMeta(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = raw.split('\n');
  let first = null, last = null, title = null, turns = 0;
  const ts = (ln) => { try { return JSON.parse(ln).timestamp || null; } catch { return null; } };
  for (let i = 0; i < lines.length && !first; i++) first = ts(lines[i]);
  for (let i = lines.length - 1; i >= 0 && !last; i--) last = ts(lines[i]);
  for (let i = lines.length - 1; i >= 0 && !title; i--) {
    if (lines[i].includes('"type":"ai-title"')) {
      try { title = JSON.parse(lines[i]).aiTitle || null; } catch {}
    }
  }
  for (const ln of lines) if (ln.includes('"type":"user"')) turns++;
  if (!first && !last && !title) return null;
  return { title, first, last, turns };
}

// Digest-bearing SessionStart output: agent name + the memory boot digest
// (memory-store.js composeDigest). Rewritten on every store mutation for the
// agent so a later /clear cats a CURRENT digest, not the spawn-time one.
// Returns whether a digest is present (main.js's birth-marking needs to know
// if the hook actually had anything to deliver — an empty store must leave
// the conversation unmarked so units saved later still reach it).
// Per-session CLI hook wiring lives in cli-hooks.js (M3). REGISTRY_DIR +
// memoryStore injected by value; uiSettings via getter (assigned in whenReady).
const { createCliHooks } = require('./cli-hooks');
const {
  writeClaudeDigestFile, setupClaudeHook, setupCodexHook,
  cleanupClaudeHook, cleanupCodexHook,
} = createCliHooks({ REGISTRY_DIR, memoryStore, getUiSettings: () => uiSettings });

// JsonlWatcher lives in jsonl-watcher.js (M3). REGISTRY_DIR injected; text +
// file-touch extraction delegated to transcript.js / file-touch.js.
const { createJsonlWatcher } = require('./jsonl-watcher');
const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR });

// ---------------------------------------------------------------------------
// Message spilling
// ---------------------------------------------------------------------------

let msgCounter = 0;

function cleanupOldMessages() {
  if (!fs.existsSync(MSG_DIR)) return;
  const now = Date.now();
  // Spilled messages live one level deep, in a per-recipient subfolder.
  // Walk both the subfolders and (for back-compat) any stray files at the root.
  for (const entry of fs.readdirSync(MSG_DIR, { withFileTypes: true })) {
    try {
      const epath = path.join(MSG_DIR, entry.name);
      if (entry.isDirectory()) {
        for (const fname of fs.readdirSync(epath)) {
          try {
            const fpath = path.join(epath, fname);
            if ((now - fs.statSync(fpath).mtimeMs) / 1000 > MSG_MAX_AGE) fs.unlinkSync(fpath);
          } catch {}
        }
      } else if ((now - fs.statSync(epath).mtimeMs) / 1000 > MSG_MAX_AGE) {
        fs.unlinkSync(epath);
      }
    } catch {}
  }
}

function spillToFile(sender, body, recipient) {
  // Each recipient gets its own subfolder so two agents never appear to share
  // an inbox — names are already constrained to [a-zA-Z0-9._-], safe as a path.
  const dir = path.join(MSG_DIR, recipient);
  ensureDir(dir);
  msgCounter++;
  const fname = `msg-${process.pid}-${msgCounter}.txt`;
  const fpath = path.join(dir, fname);
  const header = `From: ${sender}\nTime: ${new Date().toTimeString().slice(0, 8)}\nSize: ${body.length} bytes\n\n`;
  fs.writeFileSync(fpath, header + body);
  return fpath;
}

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

// SessionManager (M4): the class lives in session-manager.js behind a
// createSessionManager(deps) factory. Constructed just below the app-lifecycle
// banner, where every injected dep is in scope. deps shapes: value (bound once),
// getter (whenReady-assigned stores/singletons), and four electron seam fns —
// see session-manager.js's header for the full contract.
const { createSessionManager } = require('./session-manager');

// ---------------------------------------------------------------------------
// Update checker — queries GitHub Releases, notifies if newer version
// ---------------------------------------------------------------------------

const UPDATE_REPO = 'avirtual/clodex';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

// Update-checker data layer (fetch + semver compare + the sanctioned
// return-values transform) lives in update-checker.js (M3). main.js keeps the
// updateInfo / releasesCache state and every electron side effect below.
const { refreshReleases, fetchLatestUpdate } = require('./update-checker');

let updateInfo = null; // { version, url }
// Newest-first [{tag, published_at}] from GitHub, refreshed on the update-check
// cadence. In-memory only (persisting a release list is overkill) — feeds the
// peer-identity popover's best-effort "released N days ago · N behind" line via
// the update:releases IPC. Empty until the first successful fetch / when offline.
let releasesCache = [];

async function checkForUpdate(silent = true) {
  // Refresh the release list on the same cadence, decoupled from the latest-
  // version logic (a releases failure must not suppress the banner, and vice
  // versa). Fire-and-forget; null means keep the prior cache.
  refreshReleases(UPDATE_REPO).then((rels) => { if (rels) releasesCache = rels; });
  try {
    const { updateInfo: latest, current } = await fetchLatestUpdate(UPDATE_REPO, () => app.getVersion());
    if (latest) {
      updateInfo = latest;
      // Notify the renderer so it can show a banner / menu indicator
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update-available', updateInfo);
      }
      if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
      // Native notification (only the first time per session, unless user manually checks)
      if (silent && Notification.isSupported()) {
        const n = new Notification({
          title: `Clodex ${latest.version} is available`,
          body: `You have ${current}. Click to view the release.`,
        });
        n.on('click', () => shell.openExternal(updateInfo.url));
        n.show();
      }
    } else if (!silent) {
      // Manual check — confirm we're on the latest
      if (Notification.isSupported()) {
        new Notification({
          title: 'Clodex is up to date',
          body: `You're on the latest version (${current}).`,
        }).show();
      }
    }
  } catch (err) {
    if (!silent) console.error('Update check failed:', err.message);
  }
}

// Full app relaunch — the one code path shared by the phone endpoint, the
// File menu, and the tray. Normal quit lifecycle: sessions --resume on the
// way back, the managed wirescope survives detached, and the fresh launch's
// version check applies any pending vendor bump. Boot-time env sanitize
// keeps the relaunched process clean even when the trigger came from inside
// an agent session.
function restartClodex() {
  setTimeout(() => { app.relaunch(); app.quit(); }, 500);
}

// Menu/tray front door: confirm with the live session count first (the
// remote page fronts its own confirm; direct callers skip none).
async function confirmRestartClodex() {
  const n = Array.from(manager.sessions.values()).filter(s => !s._dead).length;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Restart', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Restart Clodex?',
    detail: n
      ? `${n} running session${n === 1 ? '' : 's'} will be interrupted and resumed after the restart.`
      : 'The app will quit and reopen.',
  });
  if (response === 0) restartClodex();
}

// ---------------------------------------------------------------------------
// Menu bar (tray) + app menu — extracted to app-menus.js (M5). createAppMenus
// returns the tray/menu builders; we destructure them so the ~30 existing call
// sites below stay byte-identical. Electron-heavy by design (app-menus requires
// electron directly). The getter deps cross manager/peerManager/stores/
// updateInfo, none of which are initialized yet at this point in module eval.
// ---------------------------------------------------------------------------
const { createAppMenus } = require('./app-menus');
const {
  buildTrayMenu, initTray, refreshTrayMenu, scheduleTrayRefresh,
  buildAgentsSubmenu, buildSkillsSubmenu, setUiTheme, buildAppMenu,
  refreshAppMenu, scheduleAppMenuRefresh, sendToFocused,
} = createAppMenus({
  // value deps (hoisted fns / early consts — stable at call time)
  DEFAULT_WORKSPACE_ID, LOG_FILE, THEME_KEYS, path,
  checkForUpdate, confirmRestartClodex, createWindow,
  // getter deps (TDZ / whenReady-assigned — lazy)
  getManager: () => manager,
  getPeerManager: () => peerManager,
  getUpdateInfo: () => updateInfo,
  getUiSettings: () => uiSettings,
  getWorkspaces: () => workspaces,
  getAgentLibrary: () => agentLibrary,
  getSkillLibrary: () => skillLibrary,
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const SessionManager = createSessionManager({
  // value deps — bound once at construction (native modules, dirs, timing
  // consts, M3 infra, and the pure module-level helpers).
    AGENT_NAME_RE,
    COMPACT_CONTINUATION_DELAY,
    COMPACT_INFLIGHT_TIMEOUT,
    DEFAULT_COMPACT_CONTINUATION,
    DEFAULT_WORKSPACE_ID,
    INJECT_HOLD_TIMEOUT,
    INJECT_QUIET_MAXWAIT,
    INJECT_QUIET_MS,
    IPC_PROMPT,
    InjectQueue,
    JsonlWatcher,
    LONG_TEXT_DELAY,
    LONG_TEXT_THRESHOLD,
    MSG_DIR,
    MSG_SPILL_THRESHOLD,
    OUTBOX_DIR,
    PENDING_DIR,
    ProxyClient,
    REGISTRY_DIR,
    RELOAD_CONTINUATION_DELAY,
    SCROLLBACK_MAX,
    SHORT_TEXT_DELAY,
    Transport,
    WIRE_INTENTS_LIVE,
    WIRE_SHADOW,
    buildAgentsArg,
    claimParkedById,
    classifyNotification,
    cleanupClaudeHook,
    cleanupCodexHook,
    cleanupSkillPlugin,
    codexStatusLineArg,
    collectSystemDiagnostics,
    composeDigest,
    ctxReminderFor,
    diagSummary,
    diagWarning,
    draftChunkSignal,
    drainPending,
    enqueueOutbox,
    ensureDir,
    fs,
    isAlive,
    isDigested,
    isDraftOpen,
    isHumanPtyInput,
    isInjectInFlight,
    lastTranscriptWrite,
    log,
    memoryStore,
    mergeClaudeSystemPrompt,
    mergeCodexInstructions,
    normalizeProxyBase,
    noteFileTouches,
    os,
    outboxHasOrigin,
    parkDelivery,
    parkIdInUse,
    parseCtxFile,
    parseIntent,
    path,
    pathFor,
    peerStatusLabel,
    pty,
    randBase36,
    readAppendBodies,
    refreshAppMenu,
    refreshTrayMenu,
    registry,
    resolveProxyAgentId,
    resolveProxyBase,
    resolveSystemPromptFile,
    runDirFor,
    scheduleTrayRefresh,
    setupClaudeHook,
    setupCodexHook,
    shadowIntentKey,
    shouldHoldDm,
    spillToFile,
    stripLevelOf,
    unionEnabled,
    vetFileIntent,
    whichBin,
    writeClaudeDigestFile,
    writeSkillPlugin,
  // getter deps — stores + late-bound singletons are assigned in
  // app.whenReady(), after this line runs, so they cross as getters.
  getPersistence: () => persistence,
  getUiSettings: () => uiSettings,
  getPromptLibrary: () => promptLibrary,
  getAgentLibrary: () => agentLibrary,
  getRemoteServer: () => remoteServer,
  getPeerManager: () => peerManager,
  // electron seam fns — the only route from the class to electron. Keeping
  // these here is what lets session-manager.js never require('electron').
  getUserDataPath: () => app.getPath('userData'),
  openPath: (p) => shell.openPath(p),
  notifyOS: (opts) => {
    try {
      const { Notification } = require('electron');
      if (Notification.isSupported()) new Notification(opts).show();
    } catch {}
  },
  setAppQuitting: (v) => { appQuitting = v; },
});
const manager = new SessionManager();
const proxyPoller = new ProxyPoller(manager);
// Back-ref for the intent handlers: [agent:who] labels and the dm hold gate
// read warmth off the poller's last-emitted payloads (facts only — the policy
// is peerStatusLabel/shouldHoldDm in proxy-util).
manager._proxyPoller = proxyPoller;

// ---------------------------------------------------------------------------
// Remote access server (remote.js) — phone web UI on 127.0.0.1. Module-level
// `let` because SessionManager's activity/lifecycle fan-outs poke it directly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Popover data sources — shared by the local IPC handlers and the peer query
// endpoint, so a remote viewer's popup is fed by exactly the code path the
// owner's own popup uses. All read-only snapshots.
// ---------------------------------------------------------------------------

async function fetchProxyContext(name, opts) {
  const s = manager.sessions.get(name);
  if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
  const snap = proxyPoller.snapshot(name);
  if (!snap || !snap.linked || !snap.sessionId) {
    return { ok: false, error: 'No live proxy session (unlinked)' };
  }
  try {
    // utilization=1 opts into wirescope's capture-scan (tool used-counts +
    // deadweight rollup) — heavier I/O, so only requested when the popover
    // will render it (gated on the context_utilization capability).
    let q = `/_context?session=${encodeURIComponent(snap.sessionId)}`;
    if (opts && opts.utilization) q += '&utilization=1';
    const r = await ProxyClient._getJson(s.proxyBase, q);
    if (r.status !== 200 || !r.json) return { ok: false, error: `proxy returned ${r.status}` };
    return { ok: true, data: r.json };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function fetchProxyReport(name, opts) {
  const s = manager.sessions.get(name);
  if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
  const snap = proxyPoller.snapshot(name);
  if (!snap || !snap.linked || !snap.sessionId) {
    return { ok: false, error: 'No live proxy session (unlinked)' };
  }
  if (snap.capabilities && snap.capabilities.context_report === false) {
    return { ok: false, error: 'This proxy does not produce session reports' };
  }
  try {
    let q = `/_report?session=${encodeURIComponent(snap.sessionId)}`;
    if (opts && opts.detail) q += '&detail=1';
    const r = await ProxyClient._getJson(s.proxyBase, q, PROXY_REPORT_TIMEOUT);
    if (r.status !== 200 || !r.json) return { ok: false, error: `proxy returned ${r.status}` };
    return { ok: true, data: r.json };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function fetchProxyBust(name) {
  const s = manager.sessions.get(name);
  if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
  const snap = proxyPoller.snapshot(name);
  if (!snap || !snap.linked || !snap.sessionId) {
    return { ok: false, error: 'No live proxy session (unlinked)' };
  }
  try {
    const r = await ProxyClient.bustSeries(s.proxyBase, snap.sessionId);
    if (r.status !== 200 || !r.json) return { ok: false, error: `proxy returned ${r.status}` };
    return { ok: true, data: r.json };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function fetchSessionFiles(name) {
  const s = manager.sessions.get(name);
  if (!s) return { ok: false, error: 'Session not running' };
  return { ok: true, cwd: s.cwd || null, files: s.fileTouches || [] };
}

function fetchFilePeek(filePath) {
  const PEEK_MAX_BYTES = 512 * 1024;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: 'Not a regular file' };
    const fd = fs.openSync(filePath, 'r');
    let buf;
    try {
      const n = Math.min(st.size, PEEK_MAX_BYTES);
      buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, 0);
    } finally { fs.closeSync(fd); }
    // NUL in the head = binary; the viewer shows a stub instead of garbage.
    const binary = buf.subarray(0, 8192).includes(0);
    return {
      ok: true, size: st.size, mtime: st.mtimeMs,
      truncated: st.size > PEEK_MAX_BYTES, binary,
      content: binary ? null : buf.toString('utf-8'),
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function fetchFileDiff(name, filePath) {
  const s = manager.sessions.get(name);
  const cwd = (s && s.cwd) || path.dirname(filePath);
  const git = (args) => new Promise((resolve) => {
    require('child_process').execFile('git', ['-C', cwd, ...args],
      { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
  const status = await git(['status', '--porcelain', '--', filePath]);
  if (status == null) return { ok: false, error: 'Not in a git repository (or git unavailable)' };
  if (status.startsWith('??')) return { ok: true, untracked: true, clean: false, diff: '' };
  // HEAD-relative catches staged edits too; fresh repos without a HEAD
  // degrade to worktree-vs-index.
  let diff = await git(['diff', 'HEAD', '--no-color', '--', filePath]);
  if (diff == null) diff = await git(['diff', '--no-color', '--', filePath]);
  if (diff == null) return { ok: false, error: 'git diff failed' };
  return { ok: true, untracked: false, clean: !status.trim(), diff };
}

let remoteServer = null;
let remoteError = null;

// Shape a session's proxy telemetry for the peer wire: the INFO the owner's
// status bar shows, none of the reach-back. Dropping base/sessionId/
// capabilities is load-bearing — it's what makes every owner-local control
// (keep-warm, strip level, wirescope links, ctx/cost/bust popovers) degrade
// to plain text on the viewer instead of firing requests at endpoints that
// only exist on the owner's machine.
function peerProxyView(p) {
  if (!p) return null;
  // `queries` advertises which popovers the peer query endpoint can answer
  // for this session — the viewer lights those chips as clickable without
  // ever holding base/sessionId/capabilities itself. Computed with the same
  // gates the owner's own bar uses.
  const caps = p.capabilities || {};
  const queries = [];
  if (caps.context_composition || caps.context_view || caps.context_utilization) queries.push('ctx');
  if (caps.context_timeline && p.base && p.sessionId) queries.push('cost');
  if (p.base && p.sessionId) queries.push('bust');
  if (caps.context_report && p.base && p.sessionId) queries.push('report');
  return {
    linked: !!p.linked,
    model: p.model || null,
    context: p.context || null,
    turns: p.turns != null ? p.turns : null,
    cost: p.cost ? {
      usd: p.cost.usd != null ? p.cost.usd : null,
      requests: p.cost.requests != null ? p.cost.requests : null,
    } : null,
    warmth: p.warmth || null,
    refusals: p.refusals || 0,
    busts: p.busts || null,
    // Info-only extras the popovers render: the strip level annotates the
    // composition breakdown; queries is the clickability contract above.
    stripLevel: typeof p.stripLevel === 'number' ? p.stripLevel : 0,
    queries,
  };
}

// kill() only sends the signal — removal from manager.sessions happens in the
// PTY's onExit, which can land well after a fixed sleep (kill() falls back to
// SIGKILL at 5s). Spinning until the slot is actually free is the only safe
// pre-respawn wait; a fixed 300ms caused "session already exists" on respawn,
// which lost the session entirely.
async function waitForSessionExit(name, timeoutMs = 8000) {
  const start = Date.now();
  while (manager.sessions.has(name) && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  return !manager.sessions.has(name);
}

// Restart a session in place: kill the PTY and respawn from the persisted
// entry. Shared by the local IPC handler (session:restart) and the peer
// restart-session endpoint so the strip-level re-assert and the failed-respawn
// safety net stay single-source. `wsId` is the workspace the respawn lands in
// (IPC derives it from the sender window; the peer path passes the entry's own
// workspaceId). Returns a distinguishable-error ack — not-found in persistence
// vs a respawn failure whose message says the entry was kept.
async function restartSession(name, opts = {}, wsId = DEFAULT_WORKSPACE_ID) {
  const entry = persistence.get(name);
  if (!entry) return { ok: false, error: 'Session not found in persistence' };
  // A "fresh" restart starts a NEW conversation (no --resume). Required to apply
  // a skill change: the skill roster is evaluated when a conversation is
  // created, so --resume replays the roster frozen before the change (proven
  // live — skillOverrides never lands on a resumed session). Costs the
  // conversation history; the caller is responsible for warning the user.
  // opts.resumeId switches to a chosen PAST conversation (the session picker):
  // respawn with --resume <that id> and make it the active id so subsequent
  // restarts continue from there (setSessionId also moves it to the head of
  // the history chain). Falls back to the current id for a plain restart.
  if (opts && opts.resumeId && opts.resumeId !== entry.sessionId) {
    persistence.setSessionId(name, opts.resumeId);
  }
  const resumeId = opts && opts.fresh ? null : ((opts && opts.resumeId) || entry.sessionId || null);
  try {
    if (manager.sessions.has(name)) {
      await manager.kill(name);
      if (!await waitForSessionExit(name)) throw new Error('old process did not exit in time');
    }
    await manager.create(name, entry.type, entry.cwd, entry.extraArgs || [], resumeId, wsId, entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [], entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [], entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || []);
    // kill() removed the persistence entry (incl. stripLevel) and create()
    // re-wrote it from spawn args only — re-assert the session's OWN level so
    // a restart doesn't silently turn stripping off. (Birth-time agentDefaults
    // seeding lives in session:create; this preserves the actual level.)
    const restartLvl = stripLevelOf(entry);
    if (restartLvl >= 1) persistence.setStripLevel(name, restartLvl);
    if (entry.label) persistence.setLabel(name, entry.label);
    return { ok: true, restarted: true };
  } catch (err) {
    // Same safety net as setArgs: never let a failed respawn eat the entry.
    persistence.upsert(entry);
    return { ok: false, error: `${err.message} — session kept; it will respawn on next workspace open.` };
  }
}

// The scope context for a session: its own name + its workspace's DISPLAY name
// (resolved through the entry's workspaceId → workspace record; unknown/headless
// entries fall back to the default workspace name). Single source for every
// offer-surface scope filter (Agents popover, Edit Session agents catalog, Skills
// popover) so local + over-the-wire reads resolve scope identically.
function sessionScopeCtx(name) {
  const entry = persistence.get(name);
  const wsId = (entry && entry.workspaceId) || DEFAULT_WORKSPACE_ID;
  const ws = workspaces.get(wsId);
  return { session: name, workspace: (ws && ws.name) || null };
}

// Read a session's editable args (the Edit Session dialog's source of truth).
// Shared by the session:getArgs IPC handler and the peer session-args GET
// endpoint (remote-wiring) so the local + over-the-wire reads can't drift — the
// remote path just appends the box's catalogs. `agentCatalog` is the SCOPE-
// FILTERED agent library for this session (the dialog's agents checklist renders
// from it, local and remote alike), so a workspace/personal-scoped agent isn't
// offered to a session it doesn't belong to. Returns { ok:false } for an unknown
// name, mirroring the old inline handler.
function readSessionArgs(name) {
  const entry = persistence.get(name);
  return entry ? {
    ok: true,
    extraArgs: entry.extraArgs || [],
    type: entry.type,
    proxy: entry.proxy ?? null,
    systemPrompt: entry.systemPrompt || null,
    systemPromptFile: entry.systemPromptFile || null,
    appendPromptFiles: entry.appendPromptFiles || [],
    agents: entry.agents || [],
    denyBuiltins: entry.denyBuiltins || [],
    disabledTools: entry.disabledTools || [],
    effectiveTools: readEffectiveToolState(entry.cwd).overrides, // lower-layer deny, per tool
    disabledSkills: entry.disabledSkills || [],
    injectSkills: entry.injectSkills || [],
    agentCatalog: agentLibrary.listFor(sessionScopeCtx(name)), // scope-filtered offer list
    stripLevel: stripLevelOf(entry),
  } : { ok: false };
}

// Apply edited args to a session (persist always; kill+respawn when restart).
// Extracted verbatim from the session:setArgs IPC closure so the peer session-
// args POST endpoint shares the exact undefined-means-untouched semantics, the
// stripLevel/label re-assert, and the catch-and-upsert recovery (restartSession
// precedent). `patch` carries the twelve fields the dialog sends; wsId is the
// respawn target — the IPC handler passes the sender's workspace, the remote path
// passes the entry's own workspaceId (no window to inherit from). Undefined patch
// fields keep the persisted value; an explicit value (incl. [] / null) overwrites.
async function applySessionArgs(name, patch = {}, wsId = DEFAULT_WORKSPACE_ID) {
  const { extraArgs, restart, proxy } = patch;
  const beforeKill = persistence.get(name);
  // Undefined-means-untouched resolution lives in the pure (unit-tested) core.
  const {
    agents: nextAgents, denyBuiltins: nextDeny, disabledTools: nextTools,
    disabledSkills: nextSkills, injectSkills: nextInject,
    systemPrompt: nextInline, systemPromptFile: nextSysFile, appendPromptFiles: nextAppend,
  } = resolveSessionArgsPatch(patch, beforeKill);
  persistence.setExtraArgs(name, extraArgs);
  persistence.setProxy(name, proxy ?? null);
  persistence.setSystemPrompt(name, nextInline);
  persistence.setPromptRefs(name, nextSysFile, nextAppend);
  persistence.setAgents(name, nextAgents, nextDeny);
  persistence.setDisabledTools(name, nextTools);
  persistence.setDisabledSkills(name, nextSkills);
  persistence.setInjectSkills(name, nextInject);
  if (!restart) return { ok: true, restarted: false };
  if (!beforeKill) return { ok: false, error: 'Session not found in persistence' };
  try {
    if (manager.sessions.has(name)) {
      await manager.kill(name);
      if (!await waitForSessionExit(name)) throw new Error('old process did not exit in time');
    }
    await manager.create(name, beforeKill.type, beforeKill.cwd, extraArgs, beforeKill.sessionId || null, wsId, nextInline, false, proxy ?? null, nextAgents, nextDeny, nextTools, nextSkills, nextInject, nextSysFile, nextAppend);
    // kill() dropped the entry's stripLevel; re-assert the session's own level
    // (see session:restart) so editing args doesn't reset stripping.
    const argsLvl = stripLevelOf(beforeKill);
    if (argsLvl >= 1) persistence.setStripLevel(name, argsLvl);
    if (beforeKill.label) persistence.setLabel(name, beforeKill.label);
    return { ok: true, restarted: true };
  } catch (err) {
    // kill() dropped the persistence entry and create() failed before
    // re-adding it. Put it back (with the edited settings) so the session
    // survives as a restorable entry instead of vanishing.
    persistence.upsert({ ...beforeKill, extraArgs, proxy: proxy ?? null, systemPrompt: nextInline, systemPromptFile: nextSysFile, appendPromptFiles: nextAppend, agents: nextAgents, denyBuiltins: nextDeny, disabledTools: nextTools, disabledSkills: nextSkills, injectSkills: nextInject });
    return { ok: false, error: `${err.message} — session kept; it will respawn on next workspace open.` };
  }
}

// Build the Skills-popover catalog for a session (Phase 2 shared reader).
// Extracted verbatim from the session:skillCatalog IPC closure so the peer
// skill-catalog GET endpoint returns EXACTLY the same shape — the transcript
// roster is parsed BOX-side (parseSkillRoster reads the box's own ~/.clodex
// transcript) and skillLib is the box's library, both semantically correct for a
// peer edit because inject-skills materialize at spawn time on the box. Never
// empty for Claude (the static seed floors it).
function readSkillCatalog(name) {
  const entry = persistence.get(name);
  const disabled = entry && Array.isArray(entry.disabledSkills) ? entry.disabledSkills : [];
  const eff = readEffectiveSkillState(entry ? entry.cwd : null);
  const names = [...new Set([
    ...CLAUDE_SKILLS,
    ...parseSkillRoster(name),
    ...disabled,
    ...Object.keys(eff.overrides),
  ])].sort();
  return {
    ok: true,
    names,
    disabledSkills: disabled,        // the session's own layer-4 off list
    effective: eff.overrides,        // lower-layer state, per skill (value+source)
    skillsLocked: eff.skillsLocked,  // managed-policy lock on the skills surface
    canReenable: SKILL_REENABLE_CONFIRMED,
    skillLib: skillLibrary.listFor(sessionScopeCtx(name)), // scope-filtered inject offer list
    injectSkills: entry && Array.isArray(entry.injectSkills) ? entry.injectSkills : [],
  };
}

// Persist a session's skill gating (persist-only — restart is a SEPARATE call the
// popover makes when the user asks; the roster is frozen at conversation
// creation). Extracted verbatim from the session:setSkills IPC closure so the
// peer session-skills POST endpoint shares the exact semantics: injectSkills is
// optional (only the library section sends it) and left untouched when absent.
function applySessionSkills(name, disabledSkills, injectSkills) {
  if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
  persistence.setDisabledSkills(name, Array.isArray(disabledSkills) ? disabledSkills : []);
  if (injectSkills !== undefined) persistence.setInjectSkills(name, Array.isArray(injectSkills) ? injectSkills : []);
  return { ok: true };
}

// syncRemoteServer — extracted to remote-wiring.js (M5). createRemoteWiring
// returns { syncRemoteServer }; the callback object it builds shares the
// fetch*/restartSession/peerProxyView helpers (kept in main.js, injected).
// manager/proxyPoller value-inject (const above); persistence/uiSettings/
// workspaces cross as getters (whenReady-assigned); remoteServer/remoteError
// cross as get+set (this fn writes them, main.js reads them elsewhere).
const { createRemoteWiring } = require('./remote-wiring');
const { syncRemoteServer } = createRemoteWiring({
  path, fs, os, log,
  DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, REGISTRY_DIR, OUTBOX_DIR, SELF_LABEL,
  parseCtxFile, jsonlToMessages, ensureDir, homeRelativize,
  claimOutbox, listOutboxOrigins,
  manager, proxyPoller,
  restartClodex, restartSession, peerProxyView,
  fetchProxyContext, fetchProxyReport, fetchProxyBust,
  fetchSessionFiles, fetchFilePeek, fetchFileDiff,
  // Edit Session over the wire: the shared read/apply helpers + the box's
  // catalogs the dialog's checklists need (agents/prompts via getters — stores
  // assigned in whenReady; CLAUDE_TOOLS is a load-time const).
  readSessionArgs, applySessionArgs, CLAUDE_TOOLS,
  // Skills over the wire (Phase 2, same 'args' cap): the shared skill-catalog
  // reader + persist helper. readSkillCatalog parses the roster BOX-side and
  // exposes the box's own skillLibrary — both correct for a remote edit.
  readSkillCatalog, applySessionSkills,
  getPromptLibrary: () => promptLibrary,
  getPersistence: () => persistence,
  getUiSettings: () => uiSettings,
  getWorkspaces: () => workspaces,
  getRemoteServer: () => remoteServer,
  setRemoteServer: (v) => { remoteServer = v; },
  setRemoteError: (v) => { remoteError = v; },
});

// ---------------------------------------------------------------------------
// Peer manager (peer-client.js) — outbound connections to other Clodexes.
// Module-level like remoteServer; reconciled from settings.
// ---------------------------------------------------------------------------

let peerManager = null;
let tunnelManager = null;
// Peer wiring — the peerOnlineLog map + the five reconcile/attach helpers moved
// to peer-wiring.js (M5). peerManager/tunnelManager stay as the lets above and
// cross as get+set; uiSettings crosses as a getter; scheduleAppMenuRefresh comes
// from the app-menus destructure. The five fns destructure back so the whenReady
// + ipc call sites stay byte-identical.
const { createPeerWiring } = require('./peer-wiring');
const {
  forgetPeerAttached, forgetPeerControlled, rememberPeerControlled,
  syncPeerManager, resolvePeerUrls,
} = createPeerWiring({
  manager, log, SELF_LABEL, scheduleAppMenuRefresh,
  getUiSettings: () => uiSettings,
  getPeerManager: () => peerManager,
  setPeerManager: (v) => { peerManager = v; },
  getTunnelManager: () => tunnelManager,
  setTunnelManager: (v) => { tunnelManager = v; },
});

function createWindow(workspaceId = DEFAULT_WORKSPACE_ID) {
  // If a window for this workspace already exists, just bring it forward
  const existing = manager.windowForWorkspace(workspaceId);
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  // Ensure the workspace record exists
  let ws = workspaces.get(workspaceId);
  if (!ws) {
    ws = {
      id: workspaceId,
      name: workspaceId === DEFAULT_WORKSPACE_ID ? 'Workspace' : 'New Workspace',
      bounds: null,
    };
    workspaces.upsert(ws);
  }

  const bounds = ws.bounds || { width: 1200, height: 800 };

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width || 1200,
    height: bounds.height || 800,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      // Pass the workspaceId to the renderer via an additional preload argument
      additionalArguments: [`--workspace-id=${workspaceId}`],
    },
  });

  manager.registerWindow(workspaceId, win);

  // Save bounds when the user resizes/moves the window
  const saveBounds = () => {
    if (win.isDestroyed()) return;
    workspaces.setBounds(workspaceId, win.getBounds());
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Track recency for startup ordering + the open-window set for restore.
  workspaces.touch(workspaceId);
  workspaces.setOpen(workspaceId, true);
  win.on('focus', () => workspaces.touch(workspaceId));

  win.on('closed', () => {
    // An EXPLICIT close drops the workspace from the restore set; quit teardown
    // must not (quit closes every window — clearing here would collapse the
    // next launch to one window).
    if (!appQuitting) workspaces.setOpen(workspaceId, false);
    manager.unregisterWindow(workspaceId);
    refreshAppMenu();
    refreshTrayMenu();
  });

  // Electron 35 replaced the positional (event, level, message) args with a
  // single event object; `level` is now a string ('info'|'warning'|'error'|
  // 'debug'), not a numeric index.
  win.webContents.on('console-message', (e) => {
    console.log(`[RENDERER ${String(e.level).toUpperCase()}]`, e.message);
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--devtools')) {
    win.webContents.openDevTools({ mode: 'bottom' });
  }
  return win;
}

// A single reusable window that renders a wirescope page (e.g. /_session) with
// clodex-style chrome — "in the middle" between an inline popover and a system
// browser tab. The page content is whatever wirescope serves; we only dress the
// frame (a normal titled title bar so the mac traffic-lights don't float over
// content + the caller's active theme bg) so it sits like a clodex window.
// Hardened webPreferences: this loads REMOTE content, so it must
// NOT inherit the main window's nodeIntegration/contextIsolation:false.
let wirescopeWindow = null;
function openWirescopeWindow(url, backgroundColor) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  const bg = (typeof backgroundColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(backgroundColor.trim()))
    ? backgroundColor.trim()
    : '#1a1a2e';
  if (wirescopeWindow && !wirescopeWindow.isDestroyed()) {
    wirescopeWindow.setBackgroundColor(bg);
    wirescopeWindow.loadURL(url);
    wirescopeWindow.show();
    wirescopeWindow.focus();
    return;
  }
  wirescopeWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: bg,
    title: 'wirescope',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  wirescopeWindow.on('closed', () => { wirescopeWindow = null; });
  wirescopeWindow.loadURL(url);
}

// Find the workspace ID that owns the renderer that sent an IPC event.
function workspaceOfSender(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return DEFAULT_WORKSPACE_ID;
  for (const [wsId, w] of manager.windows) {
    if (w === win) return wsId;
  }
  return DEFAULT_WORKSPACE_ID;
}

// Prevent two Clodex instances from racing on ~/.clodex sockets and
// persistence files. If a second instance launches, focus the existing one.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Bring the most-recently-used existing window forward
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    if (wins.length > 0) {
      const w = wins[0];
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  });
}

app.whenReady().then(() => {
  ({ persistence, templates, workspaces, promptLibrary,
    agentDefaults, agentLibrary, skillLibrary, uiSettings, renameWorkspaceScope } =
    initStores(app.getPath('userData'), { log, registryDir: REGISTRY_DIR }));
  proxyPoller.start();

  initLog();
  log.info('app', `startup — Clodex ${app.getVersion()} (electron ${process.versions.electron}, pid ${process.pid})`);

  logStartupDiagnostics();

  // Zero-setup proxy: when sessions are configured to route through the
  // managed local port, bring wirescope up ourselves (detect-first inside
  // start() adopts an already-running instance instead of double-spawning).
  // Fire-and-forget: a first-run venv install can take tens of seconds and
  // sessions degrade gracefully (wire → Anthropic direct) until it's up.
  if (wirescope.autoStartWanted()) wirescope.start().catch(() => {});

  // Remote access web UI (phone) — no-op unless remoteEnabled in settings.
  syncRemoteServer();

  // Outbound connections to peered Clodexes — no-op with no peers configured.
  syncPeerManager();

  // Mid-run watchdog. Autostart only fires at launch and on the settings
  // toggle, so a managed wirescope that dies BETWEEN launches (crash, OOM,
  // external kill) would stay dead — and every routed session bakes the proxy
  // into its ANTHROPIC_BASE_URL at spawn, so a dead proxy means connection-
  // refused on the next turn until relaunch. This poll refills that gap; a
  // respawn on the same port lets in-flight sessions self-heal on their next
  // turn (same host:port, no session restart).
  //
  // Safe by construction: start() is detect-first, so if anything is already
  // serving the port (our survivor OR an adopted external) it adopts rather
  // than double-spawning — we only ever spawn into a genuinely empty port, and
  // only when autoStartWanted (proxy enabled + pointed at the managed local
  // port; a toggle-off or remote proxyUrl silences it). Exponential backoff
  // (15s→5min cap) throttles a crash-looping/broken-venv install without ever
  // permanently giving up; a healthy probe resets it to fast recovery.
  let wsFails = 0;          // consecutive respawn attempts since last healthy
  let wsNextAttempt = 0;    // epoch ms gate for the next attempt
  const WS_WATCHDOG_INTERVAL = 10000;   // ms between health checks
  const WS_WATCHDOG_BASE = 15000;       // ms first backoff step
  const WS_WATCHDOG_MAX = 300000;       // ms backoff cap
  setInterval(async () => {
    if (!wirescope.autoStartWanted()) { wsFails = 0; wsNextAttempt = 0; return; }
    let st;
    try { st = await wirescope.status(); } catch { return; }
    if (st.state === 'managed' || st.state === 'external') {
      wsFails = 0; wsNextAttempt = 0; return;   // healthy — nothing to do
    }
    if (st.state === 'installing' || st.state === 'starting') return; // mid-launch
    // state === 'stopped': nothing serving the wanted port.
    const now = Date.now();
    if (now < wsNextAttempt) return;
    wsFails++;
    wsNextAttempt = now + Math.min(WS_WATCHDOG_BASE * 2 ** (wsFails - 1), WS_WATCHDOG_MAX);
    wirescope.start().catch(() => {});
  }, WS_WATCHDOG_INTERVAL);

  cleanupOldMessages();
  setInterval(cleanupOldMessages, MSG_CLEANUP_INTERVAL);
  registry.cleanup();

  // One-time migration of the OLD flat ~/.clodex artifacts into run/<name>/
  // (clodex-paths grammar), plus a log-only orphan pass. Candidate names =
  // sessions.json (all workspaces) ∪ any live session — at startup the
  // SessionManager map is still empty, so persistence is the source. The sweep
  // is name-driven (deletes only {knownName}{knownSuffix}) and marker-gated
  // (run/.migrated), so it runs at most once; the orphan pass is diagnostic and
  // never deletes. Best-effort — a failure here must not block launch.
  try {
    const candidateNames = new Set([
      ...persistence.list().map((e) => e.name),
      ...manager.sessions.keys(),
    ]);
    const names = [...candidateNames];
    runLegacySweep({ root: REGISTRY_DIR, names, log });
    let runEntries = [];
    let rootEntries = [];
    try { runEntries = fs.readdirSync(path.join(REGISTRY_DIR, 'run')); } catch {}
    try { rootEntries = fs.readdirSync(REGISTRY_DIR); } catch {}
    const { orphanDirs, orphanRootFiles } = findOrphans({ runEntries, rootEntries, candidates: candidateNames });
    if (orphanDirs.length) log.info('migrate', `orphan run dirs (no session entry, log-only): ${orphanDirs.join(', ')}`);
    if (orphanRootFiles.length) log.info('migrate', `stray root-level flat artifacts (log-only): ${orphanRootFiles.join(', ')}`);
  } catch (e) {
    log.info('migrate', `legacy sweep skipped (${e && e.message})`);
  }

  // Check for updates on startup and every 6 hours
  checkForUpdate(true);
  setInterval(() => checkForUpdate(true), UPDATE_CHECK_INTERVAL);

  initTray();

  // ipcMain handlers — extracted to ipc-handlers.js (M5). registerIpcHandlers
  // runs every ipcMain.handle/on registration; called here (after store init)
  // in place of the ~1260-line blob. Electron names are required inside that
  // module; everything else is injected — value for the stable names, getters
  // for the six read-only mutable singletons.
  const { registerIpcHandlers } = require('./ipc-handlers');
  registerIpcHandlers({
    CLAUDE_SKILLS, CLAUDE_SL_COMPONENTS, CLAUDE_TOOLS, CODEX_SL_COMPONENTS,
    DEPLOY_FIX_INJECT_DELAY_MS, ProxyClient, REGISTRY_DIR, SKILL_REENABLE_CONFIRMED,
    UPDATE_REPO, buildDeployFixBriefing, checkForUpdate, classifyDeployFolder,
    claudeProjectDir, collectSystemDiagnostics, createWindow, diagSummary,
    diagWarning, fetchFileDiff, fetchFilePeek, fetchProxyBust,
    fetchProxyContext, fetchProxyReport, fetchSessionFiles, fixSessionName,
    forgetPeerAttached, forgetPeerControlled, fs, https,
    jsonlToMarkdown, log, manager, maybeCompactBeforeResume,
    openWirescopeWindow, os, parseCtxFile,
    path, persistence, probePeer, proxyPoller,
    pty, readEffectiveSkillState, readEffectiveToolState, readSessionMeta,
    rebuildAllStatusScripts, refreshAppMenu, refreshTrayMenu, rememberPeerControlled,
    resolveDeployFolder, restartSession, readSessionArgs, applySessionArgs,
    readSkillCatalog, applySessionSkills, setUiTheme, sshRun,
    stripLevelOf, syncPeerManager, syncRemoteServer, updateApplies,
    waitForSessionExit, wirescope, workspaceOfSender,
    // Skill/agent scope: the per-session scope context resolver (offer filters)
    // and the workspace-rename → library rescope helper.
    sessionScopeCtx, renameWorkspaceScope,
    templates, workspaces, promptLibrary, agentDefaults,
    agentLibrary, skillLibrary, uiSettings,
    getRemoteServer: () => remoteServer,
    getRemoteError: () => remoteError,
    getPeerManager: () => peerManager,
    getTunnelManager: () => tunnelManager,
    getUpdateInfo: () => updateInfo,
    getReleasesCache: () => releasesCache,
  });

  buildAppMenu();

  // Restore the window SET that was open at quit (the `open` flags survive
  // quit because the closed handler skips its clear while appQuitting). Open
  // least-recent first so the most recently focused window ends up on top.
  // No flags (fresh install / pre-flag upgrade / all windows were explicitly
  // closed) → IDE-style fallback: just the most recently used workspace.
  const sortedWorkspaces = workspaces.sortedByRecent();
  const toRestore = sortedWorkspaces.filter((w) => w.open);
  if (toRestore.length > 0) {
    for (const w of toRestore.reverse()) createWindow(w.id);
  } else if (sortedWorkspaces.length === 0) {
    createWindow(DEFAULT_WORKSPACE_ID);
  } else {
    createWindow(sortedWorkspaces[0].id);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(DEFAULT_WORKSPACE_ID);
    }
  });
});

// On macOS, apps stay running when all windows are closed (accessible via tray).
// Sessions keep running too — reopen a window via the tray to see them again.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    appQuitting = true;
    manager.killAll();
    app.quit();
  }
});

app.on('before-quit', () => {
  appQuitting = true;
  try { log.info('app', 'shutdown — before-quit, killing all sessions'); } catch {}
  if (remoteServer) { try { remoteServer.stop(); } catch {} remoteServer = null; }
  if (peerManager) { try { peerManager.stopAll(); } catch {} peerManager = null; }
  if (tunnelManager) { try { tunnelManager.stopAll(); } catch {} tunnelManager = null; }
  manager.killAll();
});
