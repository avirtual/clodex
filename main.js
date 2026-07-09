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
// short because {name}.sock must fit the 104-char Unix socket path limit.
// Moving here (v0.6.6) ended /tmp/wb-wrap interop with the Python wb-wrap.
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
const POLL_INTERVAL = 250; // ms
const TURN_COMPLETE_TIMEOUT = 1000; // ms
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
  const plugin = buildSkillPlugin(injectSkills, skillLibrary.list(), SKILL_PLUGIN_NAME);
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
    const p = path.join(REGISTRY_DIR, `${name}-statusline.sh`);
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
const { buildSkillPlugin } = require('./skills-util');
const { sshRun } = require('./ssh-run');
const { probePeer, fixSessionName, buildDeployFixBriefing, classifyDeployFolder, homeRelativize, resolveDeployFolder } = require('./peer-deploy');
// wirescope client/poller live in wirescope-proxy.js and the supervisor in
// wirescope-supervisor.js (M3). ProxyClient needs no injection; ProxyPoller +
// the supervisor take log / stripLevelOf / WIRE_TELEMETRY_LIVE / ProxyClient by
// value and uiSettings via getter. PROXY_* tuning consts moved into the proxy
// module; PROXY_REPORT_TIMEOUT is re-imported (one /_report call still needs it).
const { ProxyClient, createProxyPoller, PROXY_REPORT_TIMEOUT } = require('./wirescope-proxy');
const ProxyPoller = createProxyPoller({ log, stripLevelOf, WIRE_TELEMETRY_LIVE });
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
    const linkPath = path.join(REGISTRY_DIR, `${name}.jsonl`);
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
// as a FALLBACK for the session picker when the live ~/.clodex/<name>.jsonl
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
// Menu bar (tray) icon
// ---------------------------------------------------------------------------

let tray = null;

function buildTrayMenu() {
  const sessions = manager.list();
  const wsList = workspaces.list();
  const template = [];

  // Show all windows
  if (manager.allLiveWindows().length === 0) {
    template.push({
      label: 'Show Clodex',
      click: () => createWindow(DEFAULT_WORKSPACE_ID),
    });
  } else {
    template.push({
      label: 'Show Clodex',
      click: () => {
        for (const w of manager.allLiveWindows()) {
          if (w.isMinimized()) w.restore();
          w.show();
        }
        const focused = manager.allLiveWindows()[0];
        if (focused) focused.focus();
      },
    });
  }
  template.push({ type: 'separator' });

  // Sessions grouped by workspace
  if (sessions.length > 0) {
    const byWs = new Map();
    for (const s of sessions) {
      if (!byWs.has(s.workspaceId)) byWs.set(s.workspaceId, []);
      byWs.get(s.workspaceId).push(s);
    }
    for (const [wsId, list] of byWs) {
      const ws = wsList.find(w => w.id === wsId);
      const wsName = ws ? (ws.name || 'Workspace') : 'Workspace';
      template.push({ label: wsName, enabled: false });
      for (const s of list) {
        // Native menus can't color text without per-item images, so the
        // state rides the glyph: ! blocked on the human · ● mid-turn ·
        // ○ parked at its prompt. Bash sessions have no turn concept.
        const indicator = s.type === 'bash' ? '•'
          : s.attention ? '!'
          : s.activity === 'thinking' ? '●' : '○';
        template.push({
          label: `  ${indicator} ${s.name} (${s.type})`,
          click: () => {
            let win = manager.windowForWorkspace(s.workspaceId);
            if (!win) win = createWindow(s.workspaceId);
            win.show();
            win.focus();
            win.webContents.send('request-switch-session', s.name);
          },
        });
      }
      template.push({ type: 'separator' });
    }
  } else {
    template.push({ label: 'No sessions', enabled: false });
    template.push({ type: 'separator' });
  }

  template.push({
    label: 'New Session…',
    click: () => {
      let win = BrowserWindow.getFocusedWindow() || manager.allLiveWindows()[0];
      if (!win) win = createWindow(DEFAULT_WORKSPACE_ID);
      win.show();
      win.focus();
      win.webContents.send('request-open-new-dialog');
    },
  });
  template.push({
    label: 'New Workspace',
    accelerator: 'Shift+Cmd+N',
    click: () => {
      const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createWindow(id);
      refreshAppMenu();
      refreshTrayMenu();
    },
  });

  // Recent Workspaces — all of them, open or closed, sorted by recency.
  // Each is a submenu with Open/Rename/Delete so users can manage them
  // without needing to open a window first.
  const recent = workspaces.sortedByRecent();
  if (recent.length > 0) {
    template.push({
      label: 'Recent Workspaces',
      submenu: recent.map(ws => {
        const isOpen = !!manager.windowForWorkspace(ws.id);
        const indicator = isOpen ? '●' : '○';
        const wsSessions = sessions.filter(s => s.workspaceId === ws.id).length;
        const suffix = wsSessions > 0 ? ` — ${wsSessions} session${wsSessions === 1 ? '' : 's'}` : '';
        return {
          label: `${indicator}  ${ws.name || ws.id}${suffix}`,
          submenu: [
            {
              label: isOpen ? 'Focus Window' : 'Open',
              click: () => {
                const win = manager.windowForWorkspace(ws.id);
                if (win) { win.show(); win.focus(); }
                else createWindow(ws.id);
              },
            },
            {
              label: 'Rename…',
              click: () => {
                let win = manager.windowForWorkspace(ws.id);
                if (!win) win = createWindow(ws.id);
                win.show();
                win.focus();
                win.webContents.send('request-rename-workspace');
              },
            },
            { type: 'separator' },
            {
              label: 'Delete Workspace…',
              click: async () => {
                const result = await dialog.showMessageBox({
                  type: 'warning',
                  buttons: ['Delete', 'Cancel'],
                  defaultId: 1,
                  cancelId: 1,
                  message: `Delete workspace "${ws.name || ws.id}"?`,
                  detail: wsSessions > 0
                    ? `This will kill ${wsSessions} running session${wsSessions === 1 ? '' : 's'} and remove the workspace.`
                    : 'This removes the empty workspace record.',
                });
                if (result.response !== 0) return;
                for (const s of manager.listForWorkspace(ws.id)) manager.kill(s.name);
                workspaces.remove(ws.id);
                const win = manager.windowForWorkspace(ws.id);
                if (win) win.close();
                refreshAppMenu();
                refreshTrayMenu();
              },
            },
          ],
        };
      }),
    });
  }

  if (updateInfo) {
    template.push({ type: 'separator' });
    template.push({
      label: `Update to v${updateInfo.version}`,
      click: () => shell.openExternal(updateInfo.url),
    });
  }

  template.push({ type: 'separator' });
  template.push({ label: 'Check for Updates', click: () => checkForUpdate(false) });
  template.push({ label: 'Restart Clodex', click: () => { confirmRestartClodex(); } });
  template.push({ label: 'Quit Clodex', role: 'quit' });
  return Menu.buildFromTemplate(template);
}

function initTray() {
  const iconPath = path.join(__dirname, 'build', 'tray-iconTemplate.png');
  const img = nativeImage.createFromPath(iconPath);
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Clodex');
  tray.setContextMenu(buildTrayMenu());
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// Activity/attention transitions want the tray's state glyphs fresh, but they
// fire on every turn boundary — trailing-edge debounce so a burst of
// transitions costs one rebuild. (macOS snapshots an already-open tray menu,
// so a rebuild never yanks it out from under the user.)
let trayRefreshTimer = null;
function scheduleTrayRefresh() {
  if (trayRefreshTimer || !tray) return;
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null;
    refreshTrayMenu();
  }, 500);
}

// ---------------------------------------------------------------------------
// Application menu (File > New Window, etc.)
// ---------------------------------------------------------------------------

function buildAgentsSubmenu() {
  // The custom-subagent library (the reusable agent *types*), not running
  // sessions — those already live in the sidebar. Each entry opens its editor.
  const lib = agentLibrary.list();
  const items = [];

  const openDrawer = (name) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('request-open-agents-drawer', name || null);
  };

  if (lib.length > 0) {
    for (const a of lib) {
      const label = a.description ? `${a.name}  —  ${a.description}` : a.name;
      items.push({
        // Menu labels don't wrap; keep long descriptions from blowing out width.
        label: label.length > 60 ? label.slice(0, 57) + '…' : label,
        click: () => openDrawer(a.name),
      });
    }
  } else {
    items.push({ label: '(no agents in library)', enabled: false });
  }

  items.push(
    { type: 'separator' },
    {
      label: 'New Agent…',
      accelerator: 'CmdOrCtrl+Shift+A',
      // Sentinel (a colon is invalid in an agent name, so it can't collide)
      // tells the renderer to open a blank editor rather than load a type.
      click: () => openDrawer(':new'),
    },
    {
      label: 'Manage Agent Types…',
      click: () => openDrawer(null),
    },
    { type: 'separator' },
    {
      label: 'Show IPC Traffic…',
      accelerator: 'CmdOrCtrl+Shift+B',
      click: () => {
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send('request-open-ipc-log');
      },
    }
  );

  return items;
}

// Parallel to buildAgentsSubmenu, over the skill-injection library. Each entry
// opens its editor; the library skills are what a session can selectively
// inject via --plugin-dir.
function buildSkillsSubmenu() {
  const lib = skillLibrary.list();
  const items = [];

  const openDrawer = (name) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('request-open-skills-drawer', name || null);
  };

  if (lib.length > 0) {
    for (const s of lib) {
      const label = s.description ? `${s.name}  —  ${s.description}` : s.name;
      items.push({
        label: label.length > 60 ? label.slice(0, 57) + '…' : label,
        click: () => openDrawer(s.name),
      });
    }
  } else {
    items.push({ label: '(no skills in library)', enabled: false });
  }

  items.push(
    { type: 'separator' },
    {
      label: 'New Skill…',
      accelerator: 'CmdOrCtrl+Shift+S',
      click: () => openDrawer(':new'),
    },
    {
      label: 'Manage Skill Library…',
      click: () => openDrawer(null),
    }
  );

  return items;
}

// Theme change from anywhere (View menu or a renderer's Preferences picker):
// persist the canonical copy, refresh the menu radios, and push to every
// window so all open workspaces retint together. exceptWc skips the renderer
// that already applied it locally (the Preferences picker), avoiding a needless
// re-apply round-trip.
function setUiTheme(name, exceptWc) {
  if (!THEME_KEYS.includes(name)) return;
  uiSettings.set({ theme: name });
  refreshAppMenu();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents === exceptWc) continue;
    w.webContents.send('set-theme', name);
  }
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win) win.webContents.send('request-open-preferences');
          },
        },
        { label: 'Check for Updates…', click: () => checkForUpdate(false) },
        { label: 'Restart Clodex', click: () => { confirmRestartClodex(); } },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workspace',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            createWindow(id);
            refreshAppMenu();
            refreshTrayMenu();
          },
        },
        {
          label: 'New Session…',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win) win.webContents.send('request-open-new-dialog');
          },
        },
        {
          label: 'Prompts…',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win) win.webContents.send('request-open-prompts-drawer');
          },
        },
        { type: 'separator' },
        {
          label: 'Rename Workspace…',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send('request-rename-workspace');
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Agents',
      submenu: buildAgentsSubmenu(),
    },
    {
      label: 'Skills',
      submenu: buildSkillsSubmenu(),
    },
    {
      // macOS wires Cmd+C/V/X/A through these roles via the responder chain —
      // the menu must stay present and visible or clipboard shortcuts break in
      // the terminal and dialog inputs. (Looks inapplicable, but it's load-bearing.)
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            { key: 'midnight', label: 'Midnight' },
            { key: 'claude', label: 'Claude' },
            { key: 'light', label: 'Light' },
          ].map((t) => ({
            label: t.label,
            type: 'radio',
            checked: uiSettings.get().theme === t.key,
            click: () => setUiTheme(t.key),
          })),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' },
        ] : []),
      ],
    },
  ];

  // Per-workspace submenu under Window menu: Open / Rename / Delete
  const wsMenu = template.find(m => m.label === 'Window');
  if (wsMenu) {
    const all = workspaces.sortedByRecent();
    if (all.length > 0) {
      wsMenu.submenu.push({ type: 'separator' }, { label: 'Workspaces', enabled: false });
      for (const ws of all) {
        const isOpen = !!manager.windowForWorkspace(ws.id);
        const indicator = isOpen ? '●' : '○';
        const sessionCount = manager.listForWorkspace(ws.id).length;
        const countSuffix = sessionCount > 0
          ? ` — ${sessionCount} session${sessionCount === 1 ? '' : 's'}`
          : '';
        wsMenu.submenu.push({
          label: `${indicator}  ${ws.name || ws.id}${countSuffix}`,
          submenu: [
            {
              label: isOpen ? 'Focus Window' : 'Open',
              click: () => {
                const win = manager.windowForWorkspace(ws.id);
                if (win) { win.show(); win.focus(); }
                else createWindow(ws.id);
              },
            },
            {
              label: 'Rename…',
              click: () => {
                let win = manager.windowForWorkspace(ws.id);
                if (!win) win = createWindow(ws.id);
                win.show();
                win.focus();
                win.webContents.send('request-rename-workspace');
              },
            },
            { type: 'separator' },
            {
              label: isOpen ? 'Close Window (keep workspace)' : 'Already closed',
              enabled: isOpen,
              click: () => {
                const win = manager.windowForWorkspace(ws.id);
                if (win) win.close();
              },
            },
            {
              label: 'Delete Workspace…',
              click: async () => {
                const parent = BrowserWindow.getFocusedWindow();
                const result = await dialog.showMessageBox(parent, {
                  type: 'warning',
                  buttons: ['Delete', 'Cancel'],
                  defaultId: 1,
                  cancelId: 1,
                  message: `Delete workspace "${ws.name || ws.id}"?`,
                  detail: sessionCount > 0
                    ? `This will kill ${sessionCount} running session${sessionCount === 1 ? '' : 's'} and remove the workspace. Conversation transcripts on disk are preserved and can be resumed in a new workspace.`
                    : 'This removes the empty workspace record. No sessions will be affected.',
                });
                if (result.response !== 0) return;
                for (const s of manager.listForWorkspace(ws.id)) manager.kill(s.name);
                workspaces.remove(ws.id);
                const win = manager.windowForWorkspace(ws.id);
                if (win) win.close();
                refreshAppMenu();
                refreshTrayMenu();
              },
            },
          ],
        });
      }
    }

    // Peers section: configured peers with an online/offline indicator, each
    // expanding to its live sessions (click = attach in the focused window,
    // matching how peer tabs live today). No control verbs — sessions + manage
    // only, to keep the menu light. "Manage Peered Clodexes…" owns the add/
    // edit/remove UI that used to sit in Preferences.
    const peerList = peerManager ? peerManager.statuses() : [];
    wsMenu.submenu.push({ type: 'separator' }, { label: 'Peers', enabled: false });
    if (peerList.length === 0) {
      wsMenu.submenu.push({ label: '(no peers configured)', enabled: false });
    } else {
      for (const st of peerList) {
        const indicator = st.online ? '●' : '○';
        const label = st.label || st.host || st.id;
        let sub;
        if (!st.online) {
          sub = [{ label: 'offline', enabled: false }];
        } else if (!st.sessions || st.sessions.length === 0) {
          sub = [{ label: '(no sessions)', enabled: false }];
        } else {
          sub = st.sessions.map((s) => ({
            label: s.name,
            click: () => sendToFocused('request-open-peer-session', st.id, s.name),
          }));
        }
        wsMenu.submenu.push({ label: `${indicator}  ${label}`, submenu: sub });
      }
    }
    wsMenu.submenu.push({
      label: 'Manage Peered Clodexes…',
      click: () => sendToFocused('request-open-peers-dialog'),
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function refreshAppMenu() {
  buildAppMenu();
}

// Route a menu action to the window the user is looking at (falling back to any
// open window), matching how Preferences and workspace actions already resolve.
function sendToFocused(channel, ...args) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send(channel, ...args);
}

// Peer online/offline (and add/remove) flips the Window > Peers indicators and
// session lists. peer-state can fire in bursts (hello wake + session refresh),
// so debounce like the tray — one rebuild per burst. (macOS snapshots an
// already-open menu, so a rebuild never yanks it out from under the user.)
let appMenuRefreshTimer = null;
function scheduleAppMenuRefresh() {
  if (appMenuRefreshTimer) return;
  appMenuRefreshTimer = setTimeout(() => {
    appMenuRefreshTimer = null;
    refreshAppMenu();
  }, 500);
}

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
    cleanupSkillPlugin,
    codexStatusLineArg,
    collectSystemDiagnostics,
    composeDigest,
    ctxReminderFor,
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
    scheduleTrayRefresh,
    shadowIntentKey,
    shouldHoldDm,
    spillToFile,
    stripLevelOf,
    vetFileIntent,
    whichBin,
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

function syncRemoteServer() {
  const s = uiSettings.get();
  if (!s.remoteEnabled) {
    if (remoteServer) { remoteServer.stop(); remoteServer = null; }
    remoteError = null;
    return;
  }
  if (remoteServer && remoteServer.port !== s.remotePort) {
    remoteServer.stop();
    remoteServer = null;
  }
  if (!remoteServer) {
    const { RemoteServer } = require('./remote');
    remoteServer = new RemoteServer({
      port: s.remotePort,
      pagePath: path.join(__dirname, 'renderer', 'remote.html'),
      getSessions: () =>
        // Agents AND bash: bash sessions are IPC-private (no registry/socket/who)
        // but ARE exposed on the peer surface for visibility/attach/control. The
        // wire payload carries sess.type so the viewer buckets bash like a local
        // bash row (no ctx badge/telemetry — the stats below come back null for
        // an unrouted bash session, which the viewer already tolerates).
        Array.from(manager.sessions.values())
          .filter(sess => !sess._dead)
          .map(sess => {
            // Same sources as the GUI status bar: proxy telemetry snapshot
            // (model/cost/requests/live tokens) + the statusline ctx
            // side-channel (window size; token fallback for unrouted sessions).
            // snapshot() returns the shaped payload itself (renderer's
            // {at, payload} wrapper is renderer-side only)
            const p = proxyPoller.snapshot(sess.name);
            let ctx = null;
            try {
              ctx = parseCtxFile(fs.readFileSync(path.join(REGISTRY_DIR, `${sess.name}-ctx`), 'utf-8'));
            } catch {}
            const wireTok = p && p.context && typeof p.context.inputTokens === 'number'
              ? p.context.inputTokens : null;
            return {
              name: sess.name,
              type: sess.type,
              cwd: sess.cwd,
              workspace: (workspaces.get(sess.workspaceId) || {}).name || '',
              stats: {
                model: (p && p.model) || null,
                cost: p && p.cost && p.cost.usd != null ? p.cost.usd : null,
                requests: p && p.cost && p.cost.requests != null ? p.cost.requests : null,
                ctxTok: wireTok != null ? wireTok : (ctx && ctx.tok) || null,
                ctxSize: (ctx && ctx.size) || null,
                ctxPct: (ctx && ctx.pct != null) ? ctx.pct : null,
              },
            };
          }),
      getTranscript: (name, limit) => {
        const sess = manager.sessions.get(name);
        if (!sess || !sess.agentType) return { ok: false, error: 'Session not found' };
        const linkPath = path.join(REGISTRY_DIR, `${name}.jsonl`);
        let jsonlPath;
        try { jsonlPath = fs.realpathSync(linkPath); }
        catch { return { ok: true, messages: [] }; } // no transcript yet
        try { return { ok: true, messages: jsonlToMessages(jsonlPath, limit) }; }
        catch (e) { return { ok: false, error: e.message }; }
      },
      send: (name, text) => {
        const sess = manager.sessions.get(name);
        if (!sess || !sess.agentType || sess._dead) return { ok: false, error: 'Session not found' };
        // Same path as the app's own panel: agents see "[agent:from user]",
        // oversized bodies ride the spill channel.
        manager._deliverMessage(name, 'user', text, 'dm');
        return { ok: true };
      },
      // Remote-triggered full relaunch: the normal quit path (before-quit →
      // killAll) then a fresh instance — sessions --resume, the managed
      // wirescope survives (detached) and the new launch's version check
      // picks up any pending vendor bump. Delay lets the HTTP response and
      // the ingress hop flush before the server dies under them.
      restartApp: () => { log.info('app', 'restart requested remotely'); restartClodex(); },
      // Remote session create — routes to the LIVE create() path (auto-persists,
      // exactly like [agent:spawn]), so a peer becomes a cockpit for the headless
      // box: no ssh + seed-script + restart. Trust is the tunnel (settled); no
      // token. The viewer can't see this box's dialogs, so the ack IS the whole
      // story — every failure mode returns a DISTINGUISHABLE error string.
      // Defaults mirror the spawn intent: workspace 'default' (no requesting
      // session here to inherit from), cwd created if absent (ensureDir).
      createSession: async ({ name, type, cwd } = {}) => {
        name = String(name || '').trim();
        const t = (type === 'codex') ? 'codex' : (type === 'claude') ? 'claude' : (type === 'bash') ? 'bash' : null;
        const rawCwd = String(cwd || '').trim();
        if (!AGENT_NAME_RE.test(name)) {
          return { ok: false, error: `invalid name "${name}" — allowed [a-zA-Z0-9._-], 1-64 chars` };
        }
        // bash rides the peer surface for visibility/attach/control, but stays
        // IPC-private (no registry/socket/who) exactly like a local bash session.
        if (!t) return { ok: false, error: `invalid type "${type}" — must be claude, codex, or bash` };
        if (manager.sessions.has(name) || persistence.get(name)) {
          return { ok: false, error: `name taken "${name}"` };
        }
        if (!rawCwd) return { ok: false, error: 'cwd required' };
        const dir = path.resolve(rawCwd.replace(/^~(?=$|\/)/, os.homedir()));
        try {
          ensureDir(dir); // create the cwd if absent — mirrors [agent:spawn]
        } catch (e) {
          return { ok: false, error: `cannot create cwd "${dir}": ${e.message}` };
        }
        try {
          const out = await manager.create(
            name, t, dir, [], null, DEFAULT_WORKSPACE_ID,
            null, false, null, [], [], [], [], [], null, [],
          );
          if (remoteServer) { try { remoteServer.notifySessions(); } catch {} }
          log.info('session', `create ${name} (${t}) via peer @ ${dir} pid=${out.pid}`);
          return { ok: true, name: out.name, type: out.type, pid: out.pid };
        } catch (e) {
          log.error('session', `create ${name} via peer failed: ${e.message}`);
          return { ok: false, error: `spawn failed: ${e.message}` };
        }
      },
      // Remote session kill — user-initiated semantics (removes from persistence,
      // no resume), same as the UI's kill. Ack distinguishes not-found from done.
      killSession: async (name) => {
        name = String(name || '').trim();
        const sess = manager.sessions.get(name);
        // Bash included (peer-visible) — gate on existence only, not agentType.
        if (!sess) return { ok: false, error: `no such session "${name}"` };
        await manager.kill(name);
        if (remoteServer) { try { remoteServer.notifySessions(); } catch {} }
        log.info('session', `kill ${name} via peer`);
        return { ok: true, name };
      },
      // Remote session restart — routes to the SHARED restartSession() so the
      // strip-level re-assert + failed-respawn safety net match the local path
      // exactly. Respawn lands in the entry's own workspace (no requesting
      // window here to inherit from). {fresh} picks the two affordances the
      // viewer offers: plain restart (--resume, keeps history) vs fresh reload
      // (new conversation, re-reads skills/agents). Ack is distinguishable
      // (not-found vs respawn-failure-with-"session kept"), same as create/kill.
      restartSession: async (name, opts = {}) => {
        name = String(name || '').trim();
        const entry = persistence.get(name);
        const wsId = (entry && entry.workspaceId) || DEFAULT_WORKSPACE_ID;
        const out = await restartSession(name, { fresh: !!(opts && opts.fresh) }, wsId);
        if (out && out.ok && remoteServer) { try { remoteServer.notifySessions(); } catch {} }
        log.info('session', `restart ${name} via peer (${opts && opts.fresh ? 'fresh' : 'resume'})${out && out.ok ? '' : ` failed: ${out && out.error}`}`);
        return out;
      },
      // ---- DM federation (Clodex-to-Clodex agent messaging) ----
      // Inbound dm from a consumer: remember the origin (so this box can route
      // replies back to its outbox), run the SAME cost-gate/park path a local dm
      // takes via _gatedDeliver, and map the verdict onto the HTTP-shaped
      // response the sender reads. senderTag = from@origin so the recipient's
      // reply trailer teaches an address that routes back.
      deliverDm: ({ to, from, origin, body, urgent }) => {
        manager._knownDmOrigins.add(origin);
        const senderTag = `${from}@${origin}`;
        const r = manager._gatedDeliver(to, senderTag, body, urgent === true);
        manager._broadcast('ipc-message', { type: 'dm', from: senderTag, to, body: `WIRE←${origin}: ${body}` });
        if (r.delivered) return { ok: true, delivered: true };
        if (r.parked) return { ok: true, parked: r.parked };
        // held (Codex/dead target) or error (not a local agent) → bounce; the
        // reason rides the response so the remote sender sees why.
        const why = r.held || r.error || 'not delivered';
        log.info('peer', `dm from ${senderTag} to ${to} not delivered: ${why}`);
        return { ok: false, error: why };
      },
      // Outbox claim: hand the consumer every reply queued under its label.
      claimDms: (origin) => {
        const messages = claimOutbox(OUTBOX_DIR, origin);
        if (messages.length) log.info('peer', `outbox claim by ${origin}: ${messages.length} message(s)`);
        return messages;
      },
      // Advertise which origins have mail waiting, so a consumer only claims when
      // there's something to fetch.
      listDmOrigins: () => listOutboxOrigins(OUTBOX_DIR),
      // ---- peer-attach surface (Clodex-to-Clodex) ----
      hostLabel: SELF_LABEL,
      version: app.getVersion(),
      // Self-report our install dir (home-relative) so a consumer's Update pulls
      // THIS checkout, not a guessed default. Packaged builds report null — an
      // .app bundle isn't a git-pullable source and the ssh update path doesn't
      // apply. main.js sits at the repo root, so __dirname IS the checkout.
      srcDir: app.isPackaged ? null : homeRelativize(__dirname, os.homedir()),
      getAttachInfo: (name) => {
        const sess = manager.sessions.get(name);
        // Bash included: attach mirrors the raw PTY (scrollback + geometry),
        // which every session type maintains. The telemetry seed below is
        // agent-shaped but degrades to nulls for bash (no proxy/ctx), harmless.
        if (!sess || sess._dead) return { ok: false };
        return {
          ok: true,
          scrollback: Buffer.from(sess.scrollback || '', 'utf8'),
          cols: sess.pty.cols, rows: sess.pty.rows,
          // Status-bar seed so the viewer's bar fills with the replay
          // instead of waiting out the first poll tick. The files count seeds
          // the 📄N badge baseline (the viewer treats a seed as baseline, not a
          // change, so it doesn't light the unseen highlight on attach).
          telemetry: {
            proxy: peerProxyView(proxyPoller.snapshot(name)),
            ctx: sess.ctxInfo || null,
            files: { count: (sess.fileTouches || []).length },
          },
        };
      },
      sendInput: (name, data) => {
        const sess = manager.sessions.get(name);
        if (!sess || sess._dead) return { ok: false, error: 'Session not found' };
        manager.write(name, data);
        return { ok: true };
      },
      resizePty: (name, cols, rows) => {
        const sess = manager.sessions.get(name);
        if (!sess || sess._dead) return { ok: false, error: 'Session not found' };
        // Tag the requester: this callback is only ever reached by a token-gated
        // control-holder, so a resize logged as 'peer-control' is the by-design
        // authority path — the arbiter for owner-side perturbation reports.
        manager.resize(name, cols, rows, 'peer-control');
        return { ok: true };
      },
      // Popover data pull (viewer's ctx/cost/bust/files/file-peek popups).
      // Fixed kind whitelist; agent sessions only (bash stays private, same
      // as the session list). For ctx the owner decides the utilization
      // opt-in from its own capabilities — the viewer doesn't hold them.
      query: (name, kind, args) => {
        const sess = manager.sessions.get(name);
        if (!sess || !sess.agentType || sess._dead) return { ok: false, error: 'no such session' };
        const a = args || {};
        switch (kind) {
          case 'ctx': {
            const snap = proxyPoller.snapshot(name);
            const caps = (snap && snap.capabilities) || {};
            return fetchProxyContext(name, { utilization: !!(caps.context_utilization || caps.context_skills) });
          }
          case 'report': return fetchProxyReport(name, { detail: !!a.detail });
          case 'bust': return fetchProxyBust(name);
          case 'files': return fetchSessionFiles(name);
          case 'filePeek': return fetchFilePeek(String(a.path || ''));
          case 'fileDiff': return fetchFileDiff(name, String(a.path || ''));
          default: return { ok: false, error: `unknown query kind: ${kind}` };
        }
      },
      // Owner-side visibility: chip on the session tab + a line in the IPC
      // log, so a controlled session is never silently driven.
      onControlChange: (name, holder) => {
        manager._sendToSession(name, 'session-peer-control', name, holder);
        manager._broadcast('ipc-message', {
          ts: Date.now(), from: holder || 'peer', to: name,
          kind: holder ? 'peer-control' : 'peer-release',
          body: holder ? `${holder} took control of ${name}` : `remote control of ${name} released`,
        });
        log.info('peer', holder ? `${holder} took control of ${name}` : `control of ${name} released`);
      },
    });
  }
  remoteError = null;
  remoteServer.start().catch((e) => {
    remoteError = e.message;
    remoteServer = null;
  });
}

// ---------------------------------------------------------------------------
// Peer manager (peer-client.js) — outbound connections to other Clodexes.
// Module-level like remoteServer; reconciled from settings.
// ---------------------------------------------------------------------------

let peerManager = null;
let tunnelManager = null;
// Last-logged online state per peer id — the ops log records online/offline
// TRANSITIONS, not every (bursty) peer-state event.
const peerOnlineLog = new Map();

// Drop a persisted peer-tab attachment (explicit detach, or a name the peer
// no longer has). No-op if it wasn't persisted, so callers can fire freely.
function forgetPeerAttached(id, name) {
  const map = { ...(uiSettings.get().peerAttached || {}) };
  if (!Array.isArray(map[id]) || !map[id].includes(name)) return;
  const list = map[id].filter((n) => n !== name);
  if (list.length) map[id] = list; else delete map[id];
  uiSettings.set({ peerAttached: map });
}

// Same for a persisted control claim. Fired on explicit release, on detach/hide
// (controlled implies attached, so a gone tab drops both), and on a stale-claim
// drop when a restore re-acquire finds someone else holds it.
function forgetPeerControlled(id, name) {
  const map = { ...(uiSettings.get().peerControlled || {}) };
  if (!Array.isArray(map[id]) || !map[id].includes(name)) return;
  const list = map[id].filter((n) => n !== name);
  if (list.length) map[id] = list; else delete map[id];
  uiSettings.set({ peerControlled: map });
}

// Add a persisted control claim (idempotent). Fired on a successful take —
// explicit or type-to-take.
function rememberPeerControlled(id, name) {
  const map = { ...(uiSettings.get().peerControlled || {}) };
  const list = Array.isArray(map[id]) ? map[id] : [];
  if (list.includes(name)) return;
  map[id] = [...list, name];
  uiSettings.set({ peerControlled: map });
}

function syncPeerManager() {
  const s = uiSettings.get();
  if (!peerManager) {
    const { PeerManager } = require('./peer-client');
    peerManager = new PeerManager({
      selfLabel: SELF_LABEL,
      emit: (channel, ...args) => {
        // DM federation: claimed box→consumer messages are internal, not a
        // renderer event — deliver them locally and stop (keep bodies off the
        // generic ipc fan-out; deliverClaimedDms does its own ipc-log line).
        if (channel === 'peer-dms') {
          try { manager._deliverClaimedDms(args[0], args[1]); } catch (e) { log.error('peer', `claimed dm delivery failed: ${e.message}`); }
          return;
        }
        try { manager._broadcast(channel, ...args); } catch {}
        // Keep the Window > Peers menu's indicators + session lists fresh.
        if (channel === 'peer-state' || channel === 'peer-removed') scheduleAppMenuRefresh();
        // Ops log: peer online/offline TRANSITIONS only (peer-state fires in
        // bursts — hello wake + session refresh — so log on change, not per
        // event), plus removals. Control changes on OUR sessions log at their
        // own site (session-peer-control below).
        try {
          if (channel === 'peer-state') {
            const [id, status] = args;
            const online = !!(status && status.online);
            if (peerOnlineLog.get(id) !== online) {
              peerOnlineLog.set(id, online);
              log.info('peer', `${(status && status.label) || id} ${online ? 'online' : 'offline'}`);
            }
          } else if (channel === 'peer-removed') {
            const [id] = args;
            peerOnlineLog.delete(id);
            log.info('peer', `removed ${id}`);
          }
        } catch { /* logging never breaks the emit fan-out */ }
      },
    });
  }
  if (!tunnelManager) {
    const { TunnelManager } = require('./peer-tunnel');
    tunnelManager = new TunnelManager({
      // Tunnel came up (fresh local port) or died: repoint/park the peer
      // connection, and let the renderer show tunnel state next to the peer.
      onState: (id, status) => {
        resolvePeerUrls();
        try { manager._broadcast('peer-tunnel', id, status); } catch {}
      },
    });
  }
  tunnelManager.sync(s.peers || []);
  resolvePeerUrls();
  // Prune persisted attachments + visibility selections for peers that no
  // longer exist in settings.
  const ids = new Set((s.peers || []).map((p) => p.id));
  const patch = {};
  for (const field of ['peerAttached', 'peerVisible', 'peerControlled']) {
    const cur = s[field] || {};
    const next = {};
    let changed = false;
    for (const [id, names] of Object.entries(cur)) {
      if (ids.has(id)) next[id] = names; else changed = true;
    }
    if (changed) patch[field] = next;
  }
  if (Object.keys(patch).length) uiSettings.set(patch);
  // Reflect add/edit/remove in the Window > Peers menu right away: a newly-added
  // OFFLINE peer never emits peer-state (its initial state is already offline),
  // so the emit-driven refresh wouldn't pick it up on its own.
  if (typeof scheduleAppMenuRefresh === 'function') scheduleAppMenuRefresh();
}

// Managed-tunnel peers ride their tunnel's current local port; while the
// tunnel is down they keep a dead placeholder URL so the connection object
// (and its sidebar presence) stays alive, just offline — calm, like a
// sleeping laptop.
function resolvePeerUrls() {
  if (!peerManager) return;
  const s = uiSettings.get();
  const resolved = [];
  for (const p of s.peers || []) {
    if (p.sshHost) {
      const url = tunnelManager ? tunnelManager.urlFor(p.id) : null;
      resolved.push({ id: p.id, label: p.label, url: url || 'http://127.0.0.1:1' });
    } else {
      resolved.push({ id: p.id, label: p.label, url: p.url });
    }
  }
  peerManager.sync(resolved);
}

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

  // Track recency for "open most recent on startup" behavior
  workspaces.touch(workspaceId);
  win.on('focus', () => workspaces.touch(workspaceId));

  win.on('closed', () => {
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
    agentDefaults, agentLibrary, skillLibrary, uiSettings } =
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

  // Check for updates on startup and every 6 hours
  checkForUpdate(true);
  setInterval(() => checkForUpdate(true), UPDATE_CHECK_INTERVAL);

  initTray();

  ipcMain.handle('session:create', async (e, name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles) => {
    try {
      const workspaceId = workspaceOfSender(e);
      // Seed tool denies from the global "*" default when the caller passed none.
      // The new-session dialog always pre-populates its checklist from the default
      // and sends an explicit array (incl. [] for "deny nothing"), so this only
      // fires for non-dialog callers — keeping new sessions on the shared, lean
      // tools segment. An explicit array always wins (undefined === "untouched").
      const seedTools = (disabledTools === undefined) ? agentDefaults.getDefaultDeny() : disabledTools;
      const session = await manager.create(name, type, cwd, extraArgs, resumeId || null, workspaceId, systemPromptBody || null, !!fork, proxy ?? null, agents || [], denyBuiltins || [], seedTools || [], disabledSkills || [], injectSkills || [], systemPromptFile || null, appendPromptFiles || []);
      // Strip level isn't a spawn arg (it's a proxy-side override the poller
      // asserts once the session links), so persist it onto the entry after
      // create() rather than threading it through the 15-param spawn path.
      // Set at creation = the cold-cache path: the first re-write is tiny.
      // An explicit dialog choice wins; otherwise seed from this agent name's
      // standing default (set previously from the bottom-bar menu, kill-proof).
      const seedStrip = (stripLevel === 1 || stripLevel === 2) ? stripLevel : agentDefaults.getStrip(name);
      if (seedStrip === 1 || seedStrip === 2) persistence.setStripLevel(name, seedStrip);
      return { ok: true, session };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session:list', (e) => manager.listForWorkspace(workspaceOfSender(e)));
  ipcMain.handle('session:listAll', () => manager.list());
  ipcMain.handle('session:kill', (_e, name) => manager.kill(name));
  ipcMain.handle('session:resize', (_e, name, cols, rows) => manager.resize(name, cols, rows));
  ipcMain.handle('session:setLabel', (_e, name, label) => persistence.setLabel(name, label));
  ipcMain.handle('session:setAutoCompact', (_e, name, on) => persistence.setAutoCompact(name, on !== false));

  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('update:check', () => checkForUpdate(false));
  ipcMain.handle('update:info', () => updateInfo);
  // Cached release list for the peer-identity popover's age/behind line. Returns
  // [] until the first fetch lands / when offline — the renderer never blocks on
  // it (it renders from whatever is cached at open time).
  ipcMain.handle('update:releases', () => releasesCache);
  ipcMain.handle('update:open', () => {
    if (updateInfo) shell.openExternal(updateInfo.url);
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // Spawn-health diagnostics for the renderer banner — recomputed live so a
  // post-launch `electron-rebuild` clears the warning on the next poll.
  ipcMain.handle('diagnostics:get', () => {
    const d = collectSystemDiagnostics();
    return { ...d, warning: diagWarning(d), summary: diagSummary(d) };
  });

  ipcMain.handle('templates:list', () => templates.list());
  ipcMain.handle('templates:save', (_e, template) => { templates.save(template); return templates.list(); });
  ipcMain.handle('templates:remove', (_e, id) => { templates.remove(id); return templates.list(); });

  // Prompts library (~/.clodex/library/prompts/{system,append}/*.md). Both
  // Claude and Codex; referenced by session (system replaces, append composes).
  ipcMain.handle('prompts:list', (_e, kind) => promptLibrary.list(kind));
  ipcMain.handle('prompts:save', (_e, kind, name, body) => {
    try { return { ok: true, prompts: promptLibrary.save(kind, name, body) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('prompts:remove', (_e, kind, name) => {
    return { ok: true, prompts: promptLibrary.remove(kind, name) };
  });

  // Custom subagent library (~/.clodex/agents/*.md). Claude-only.
  ipcMain.handle('agents:list', () => agentLibrary.list());
  ipcMain.handle('agents:get', (_e, name) => agentLibrary.raw(name));
  ipcMain.handle('agents:save', (_e, name, content) => {
    try {
      const agents = agentLibrary.save(name, content);
      refreshAppMenu(); // Agents menu lists the library — keep it current.
      return { ok: true, agents };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('agents:remove', (_e, name) => {
    const agents = agentLibrary.remove(name);
    refreshAppMenu();
    return { ok: true, agents };
  });

  // Skill-injection library (~/.clodex/skills/*.md). Claude-only. Mirrors the
  // agents handlers; the Skills app menu lists this library, so save/remove
  // refresh the menu.
  ipcMain.handle('skilllib:list', () => skillLibrary.list());
  ipcMain.handle('skilllib:get', (_e, name) => skillLibrary.raw(name));
  ipcMain.handle('skilllib:save', (_e, name, content) => {
    try {
      const skills = skillLibrary.save(name, content);
      refreshAppMenu();
      return { ok: true, skills };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('skilllib:remove', (_e, name) => {
    const skills = skillLibrary.remove(name);
    refreshAppMenu();
    return { ok: true, skills };
  });
  ipcMain.handle('prompts:inject', (_e, name, body) => {
    const s = manager.sessions.get(name);
    if (!s) return { ok: false, error: 'Session not found' };
    manager._injectText(s, body);
    return { ok: true };
  });

  // Last-known proxy telemetry for a session — lets the renderer fill the
  // status bar immediately on attach/switch instead of waiting for the next poll.
  ipcMain.handle('proxy:snapshot', (_e, name) => proxyPoller.snapshot(name));

  // Fetch the per-line tool roster + context composition for a session
  // (wirescope /_context). Read-only; gated by the caller on the
  // context_view/context_composition capability. Uses the live record's
  // session_id (from the snapshot), never a possibly-stale persisted one.
  ipcMain.handle('proxy:context', (_e, name, opts) => fetchProxyContext(name, opts));

  // Fetch the on-demand per-session cost/efficiency report (wirescope /_report,
  // report_version 1). Disk-based on the proxy side, but we still resolve the
  // session_id from the live record and gate the caller on the
  // capabilities.context_report flag. detail=1 reserves the (v1.1) per-turn
  // series; harmless to pass against a v1 proxy that ignores it.
  ipcMain.handle('proxy:report', (_e, name, opts) => fetchProxyReport(name, opts));

  // On-demand cache-bust forensics for one session (the bust-inspector
  // popover). Resolves the live session_id from the poller snapshot (never a
  // stale persisted one), then fetches /_bust — the per-transition divergence
  // series. Heavy disk read, called only when the popover opens (same profile
  // as proxy:report), never in the 5s poll.
  ipcMain.handle('proxy:bust', (_e, name) => fetchProxyBust(name));

  // On-demand live-activity detail for one subagent row (the child popover).
  // Resolves the live session_id from the poller snapshot (never a stale
  // persisted one), then fetches /_subagents for the given child key. Called on
  // a 1-2s loop only while the popover is open — never in the 5s poll. A `found:
  // false` body is a normal outcome (child expired / session cold), surfaced as
  // ok:true with the proxy's reason so the popover can close gracefully.
  ipcMain.handle('proxy:subagentDetail', async (_e, name, child, maxlen) => {
    const s = manager.sessions.get(name);
    if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
    const snap = proxyPoller.snapshot(name);
    if (!snap || !snap.linked || !snap.sessionId) {
      return { ok: false, error: 'No live proxy session (unlinked)' };
    }
    if (typeof child !== 'string' || !child) return { ok: false, error: 'Missing child key' };
    try {
      const r = await ProxyClient.subagentDetail(s.proxyBase, snap.sessionId, child, maxlen);
      if (r.status !== 200 || !r.json) return { ok: false, error: `proxy returned ${r.status}` };
      return { ok: true, data: r.json };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Open an external URL in the default browser (e.g. the proxy session page).
  // http(s) only — never hand arbitrary schemes to the OS opener.
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // Open a wirescope page in an in-app, clodex-chromed window instead of the
  // system browser. backgroundColor is the caller's active theme `--bg` so the
  // frame matches; the page content stays wirescope's own.
  ipcMain.handle('app:openWirescope', (_e, url, backgroundColor) => {
    openWirescopeWindow(url, backgroundColor);
  });

  // Arm/disarm a cache hold for a session. Writes are gated: the session must
  // be routed AND exactly linked to a live proxy record (we use that record's
  // own session_id, never a possibly-stale persisted one), and the proxy must
  // advertise the hold capability. hours=0 disarms.
  ipcMain.handle('proxy:hold', async (_e, name, hours, force) => {
    const s = manager.sessions.get(name);
    if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
    const snap = proxyPoller.snapshot(name);
    if (!snap || !snap.linked || !snap.sessionId) {
      return { ok: false, error: 'No live proxy session to hold (unlinked)' };
    }
    if (snap.capabilities && snap.capabilities.hold === false) {
      return { ok: false, error: 'This proxy does not support holds' };
    }
    try {
      const r = await ProxyClient.hold(s.proxyBase, snap.sessionId, hours, !!force);
      const j = r.json || {};
      // Distinguish armed from declined (skipped) — a 200 can mean "I chose
      // not to act". Surface the reason so the UI never reads a no-op as success.
      return { ok: true, status: r.status, armed: !!j.armed, skipped: j.skipped || null, body: j };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // In-process twin of proxy:hold — arm/disarm the wire HoldKeeper (wire/hold.js)
  // for the session's wire-observed session_id. Same return contract as
  // proxy:hold so the renderer's doWarmHold works unchanged; which channel the
  // fire button uses is decided by the payload's holdSource (set by
  // WireTelemetry.overlay under CLODEX_WIRE_TELEMETRY). hours<=0 disarms;
  // arming is warm-gated like the proxy's (force is the only override).
  ipcMain.handle('wire:hold', (_e, name, hours, force) => {
    if (!manager._holdKeeper || !manager._wireTelemetry) {
      return { ok: false, error: 'In-process wire keep-warm is not running' };
    }
    const w = manager._wireTelemetry.payload(name);
    if (!w || !w.sessionId) {
      return { ok: false, error: 'The wire has not seen a turn for this session yet' };
    }
    try {
      const j = (hours > 0)
        ? manager._holdKeeper.arm(w.sessionId, hours, { force: !!force })
        : manager._holdKeeper.disarm(w.sessionId);
      return { ok: true, status: 200, armed: !!j.armed, skipped: j.skipped || null, body: j };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Set the per-session strip LEVEL (0 off / 1 thinking / 2 thinking + tool
  // results). Cumulative ladder. Persists our authoritative level (the proxy
  // overrides are in-memory) and pushes the level's wire state now. Level 2's
  // tool-result strip is gated on a separate capability and rejected until the
  // proxy advertises it (the menu disables it too).
  ipcMain.handle('proxy:setStripLevel', async (_e, name, level) => {
    const s = manager.sessions.get(name);
    if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
    const snap = proxyPoller.snapshot(name);
    if (!snap || !snap.linked || !snap.sessionId) {
      return { ok: false, error: 'No live proxy session (unlinked)' };
    }
    const caps = snap.capabilities || {};
    const cap = caps.strip_thinking;
    if (!cap || !cap.available) {
      return { ok: false, error: 'This proxy does not support strip-thinking' };
    }
    let lvl = (level === 1 || level === 2) ? level : 0;
    // L2 (edit-acks + failed-call stubs) folds into strip_thinking as a level —
    // there is no separate capability. Gate on the advertised max_level.
    if (lvl === 2 && !(cap.max_level >= 2)) {
      return { ok: false, error: 'This proxy does not support level 2 stripping yet' };
    }
    persistence.setStripLevel(name, lvl);
    // A bottom-bar choice is also this agent name's standing default, so every
    // future session of that name (even after a kill that drops the sessions.json
    // entry) is seeded with it. Kill-proof; consulted only at session birth.
    agentDefaults.setStrip(name, lvl);
    proxyPoller.noteStripAsserted(name, snap.sessionId, lvl);
    try {
      // One /_strip mechanism, three levels: 0 clears, 1 strips thinking, 2 adds
      // edit-acks + failed-call stubs on top. At level 0, hold OFF with an explicit
      // 0-override when the proxy's global default is ON (else a clear reverts to it).
      const gd = (snap.strip && snap.strip.globalDefaultLevel) || 0;
      const r = await ProxyClient.stripThinking(s.proxyBase, snap.sessionId, lvl, lvl === 0 && gd >= 1);
      const j = r.json || {};
      return { ok: true, status: r.status, level: lvl, effective: !!j.effective, body: j };
    } catch (e) {
      // The push failed but our level is persisted; the poller will retry on the
      // next tick. Surface the error so the UI can flag it.
      proxyPoller.stripAsserted.delete(name);
      return { ok: false, error: e.message, level: lvl };
    }
  });

  ipcMain.handle('session:getArgs', (_e, name) => {
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
      stripLevel: stripLevelOf(entry),
    } : { ok: false };
  });

  // Past conversations for the session picker. Two tiers:
  //  - tracked: ids clodex observed live (persisted sessionIds ∪ current active
  //    id) — authoritative, correctly attributed even when agents share a cwd.
  //  - inferred: other recent transcripts sitting in the same project dir that
  //    clodex never observed (pre-feature history, or started outside clodex).
  //    Best-effort and flagged: a cwd shared by >1 agent can't be split, so
  //    these may belong to a sibling agent. The renderer renders them dimmed.
  ipcMain.handle('session:history', (_e, name) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found' };
    if (entry.type !== 'claude' && entry.type !== 'codex') return { ok: true, sessions: [], activeId: null };
    // Prefer the live symlink's real directory; fall back to the cwd→slug path.
    let slugDir = null;
    try { slugDir = path.dirname(fs.realpathSync(path.join(REGISTRY_DIR, `${name}.jsonl`))); } catch {}
    if (!slugDir) slugDir = claudeProjectDir(entry.cwd);
    const activeId = entry.sessionId || null;
    const tracked = new Set([...(Array.isArray(entry.sessionIds) ? entry.sessionIds : []), ...(activeId ? [activeId] : [])]);
    const out = [];
    const seen = new Set();
    const add = (sid, inferred) => {
      if (!sid || seen.has(sid)) return;
      seen.add(sid);
      const meta = slugDir ? readSessionMeta(path.join(slugDir, `${sid}.jsonl`)) : null;
      if (!meta) {
        if (!inferred) out.push({ sessionId: sid, title: null, lastActive: null, active: sid === activeId, inferred: false, missing: true });
        return;
      }
      out.push({ sessionId: sid, title: meta.title, firstActive: meta.first, lastActive: meta.last, turns: meta.turns, active: sid === activeId, inferred });
    };
    for (const sid of tracked) add(sid, false);
    // Bootstrap: recent sibling transcripts we didn't observe (last 7 days).
    try {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const fn of fs.readdirSync(slugDir)) {
        if (!fn.endsWith('.jsonl')) continue;
        const sid = fn.slice(0, -6);
        if (tracked.has(sid)) continue;
        let st; try { st = fs.statSync(path.join(slugDir, fn)); } catch { continue; }
        if (st.mtimeMs >= cutoff) add(sid, true);
      }
    } catch {}
    out.sort((a, b) => (Date.parse(b.lastActive || 0) || 0) - (Date.parse(a.lastActive || 0) || 0));
    return { ok: true, sessions: out, activeId };
  });
  // --- Touched-files feed + peek/diff -----------------------------------
  // The feed is the session's in-memory ring (facts: tool + path + when, from
  // the wire receipts or the legacy jsonl tap). Peek/diff are read-only looks
  // at the CURRENT disk/git state — created-vs-modified truth comes from git
  // here, never from the feed.
  ipcMain.handle('session:files', (_e, name) => fetchSessionFiles(name));
  ipcMain.handle('file:peek', (_e, filePath) => fetchFilePeek(filePath));
  ipcMain.handle('file:diff', (_e, name, filePath) => fetchFileDiff(name, filePath));
  ipcMain.handle('file:open', (_e, filePath) => shell.openPath(filePath));

  // Focused per-session tool gating: persist disabledTools only (leaves
  // extraArgs/proxy/posture/agents untouched). Takes effect on next spawn;
  // the renderer calls session:restart afterward if the user wants it now.
  ipcMain.handle('session:setTools', (_e, name, disabledTools) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
    persistence.setDisabledTools(name, Array.isArray(disabledTools) ? disabledTools : []);
    return { ok: true };
  });
  // Focused per-session skill gating (mirror of setTools): persist disabledSkills
  // only. Takes effect on next spawn via skillOverrides in the generated settings.
  ipcMain.handle('session:setSkills', (_e, name, disabledSkills, injectSkills) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
    persistence.setDisabledSkills(name, Array.isArray(disabledSkills) ? disabledSkills : []);
    // injectSkills is optional — only the popover's library section sends it.
    if (injectSkills !== undefined) persistence.setInjectSkills(name, Array.isArray(injectSkills) ? injectSkills : []);
    return { ok: true };
  });
  // Focused per-session agent composition (mirror of setSkills/setTools):
  // persist the enabled custom-subagent list + denyBuiltins only, leaving
  // extraArgs/proxy/posture/tools/skills untouched. Takes effect on the next
  // FRESH start — the agent roster, like skills, is frozen at conversation
  // creation, so --resume replays the old one (the popover does the fresh
  // restart when the user asks for it now).
  ipcMain.handle('session:setAgents', (_e, name, agents, denyBuiltins) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
    persistence.setAgents(name,
      Array.isArray(agents) ? agents : [],
      Array.isArray(denyBuiltins) ? denyBuiltins : []);
    return { ok: true };
  });
  // Agent catalog for the Agents popover. Unlike skills there's no transcript
  // roster or lower-layer/policy state to merge — built-ins are irreducible and
  // have no trim lever — so the catalog is simply the custom-subagent library
  // plus this session's persisted enabled set + denyBuiltins flag.
  ipcMain.handle('session:agentCatalog', (_e, name) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found in persistence' };
    return {
      ok: true,
      agents: agentLibrary.list(),
      enabled: Array.isArray(entry.agents) ? entry.agents : [],
      denyBuiltins: Array.isArray(entry.denyBuiltins) ? entry.denyBuiltins : [],
    };
  });
  // Skill catalog for the Skills popover. Three sources unioned: the static
  // CLAUDE_SKILLS seed (known built-ins — visible even when disabled in another
  // settings source so they never hit the roster), the live roster parsed from
  // the transcript (skill_listing attachments — catches plugin/cortex skills
  // not in the seed), and the persisted disabled set (so an off skill stays
  // re-enable-able even after it drops off the wire). Never empty for Claude.
  ipcMain.handle('session:skillCatalog', (_e, name) => {
    const entry = persistence.get(name);
    const disabled = entry && Array.isArray(entry.disabledSkills) ? entry.disabledSkills : [];
    const eff = readEffectiveSkillState(entry ? entry.cwd : null);
    // Catalog unions the static seed, the live roster, clodex's own off list, and
    // any name a lower layer mentions — so a skill that's off below (and thus
    // absent from the roster) is still listed, just rendered disabled+labeled.
    const names = [...new Set([
      ...CLAUDE_SKILLS,
      ...parseSkillRoster(name),
      ...disabled,
      ...Object.keys(eff.overrides),
    ])].sort();
    return {
      ok: true,
      names,
      disabledSkills: disabled,        // clodex's own layer-4 off list
      effective: eff.overrides,        // lower-layer state, per skill (value+source)
      skillsLocked: eff.skillsLocked,  // managed-policy lock on the skills surface
      canReenable: SKILL_REENABLE_CONFIRMED,
      skillLib: skillLibrary.list(),   // library skills available to inject
      injectSkills: entry && Array.isArray(entry.injectSkills) ? entry.injectSkills : [],
    };
  });
  // Skill catalog for the NEW-SESSION dialog (no session/transcript yet, just a
  // chosen cwd). Static seed + whatever a lower settings layer for that cwd
  // already disables, with the same effective-state + provenance so a globally-
  // off skill renders disabled+labeled here too. This is the CLEAN trim path:
  // the skill roster is evaluated at conversation creation, so a fresh session
  // applies skillOverrides immediately — no restart/clear dance.
  ipcMain.handle('settings:skillCatalogFor', (_e, cwd) => {
    const eff = readEffectiveSkillState(cwd || null);
    const names = [...new Set([...CLAUDE_SKILLS, ...Object.keys(eff.overrides)])].sort();
    return { ok: true, names, effective: eff.overrides, skillsLocked: eff.skillsLocked, canReenable: SKILL_REENABLE_CONFIRMED };
  });
  // Tool provenance for the NEW-SESSION dialog (mirror of skillCatalogFor): the
  // tool list itself is the static CLAUDE_TOOLS seed (sent via getSettings), so
  // here we only need the per-cwd lower-layer deny state to render externally-
  // off tools as read-only + labeled before the session exists.
  ipcMain.handle('settings:toolCatalogFor', (_e, cwd) => {
    return { ok: true, effective: readEffectiveToolState(cwd || null).overrides };
  });

  ipcMain.handle('session:setArgs', async (e, name, extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles) => {
    const beforeKill = persistence.get(name);
    const nextAgents = agents !== undefined ? (agents || []) : (beforeKill?.agents || []);
    const nextDeny = denyBuiltins !== undefined ? (denyBuiltins || []) : (beforeKill?.denyBuiltins || []);
    const nextTools = disabledTools !== undefined ? (disabledTools || []) : (beforeKill?.disabledTools || []);
    const nextSkills = disabledSkills !== undefined ? (disabledSkills || []) : (beforeKill?.disabledSkills || []);
    const nextInject = injectSkills !== undefined ? (injectSkills || []) : (beforeKill?.injectSkills || []);
    // undefined = "untouched": keep the persisted value. The edit dialog no
    // longer surfaces the legacy inline body, so it passes systemPrompt
    // undefined and a legacy inline prompt survives editing other settings.
    const nextInline = systemPrompt !== undefined ? (systemPrompt || null) : (beforeKill?.systemPrompt || null);
    const nextSysFile = systemPromptFile !== undefined ? (systemPromptFile || null) : (beforeKill?.systemPromptFile || null);
    const nextAppend = appendPromptFiles !== undefined ? (appendPromptFiles || []) : (beforeKill?.appendPromptFiles || []);
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
    const wsId = workspaceOfSender(e);
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
  });

  // Restart in place: kill the PTY and respawn with the persisted settings,
  // resuming the same conversation. Useful after a CLI upgrade, a global
  // preference change, or a wedged TUI. The core lives in restartSession()
  // (module scope) so the peer restart-session endpoint shares the exact
  // strip-level re-assert + failed-respawn safety net rather than duplicating
  // (and drifting from) it. The IPC handler only supplies the sender's
  // workspace as the respawn target.
  ipcMain.handle('session:restart', async (e, name, opts = {}) =>
    restartSession(name, opts, workspaceOfSender(e)));

  ipcMain.handle('settings:get', () => {
    const s = uiSettings.get();
    return {
      statusline: s.statusline,
      claudeComponents: CLAUDE_SL_COMPONENTS,
      codexComponents: CODEX_SL_COMPONENTS,
      claudeTools: CLAUDE_TOOLS,
      defaultToolDeny: agentDefaults.getDefaultDeny(),
      proxyEnabled: s.proxyEnabled,
      proxyUrl: s.proxyUrl,
      wirescopeDir: s.wirescopeDir,
      wirescopePort: s.wirescopePort,
      disableClaudeDesignMcp: s.disableClaudeDesignMcp,
      compactOnResume: s.compactOnResume,
      theme: s.theme,
      remoteEnabled: s.remoteEnabled,
      remotePort: s.remotePort,
      peers: s.peers,
    };
  });
  ipcMain.handle('settings:set', (_e, partial) => {
    const next = uiSettings.set(partial);
    rebuildAllStatusScripts(manager);
    // The Traffic optimization toggle is the proxy's single control: on brings
    // the managed wirescope up, off tears it down. stop() only ever kills OUR
    // child — an adopted external instance is never touched either way.
    if (wirescope.autoStartWanted()) wirescope.start().catch(() => {});
    else wirescope.stop();
    syncRemoteServer();
    syncPeerManager();
    return next;
  });

  // Remote access status for the prefs dialog: running/port/error. The URL
  // shown is the localhost one — off-machine reach is the user's tailnet.
  ipcMain.handle('remote:status', () => ({
    running: !!(remoteServer && remoteServer.running),
    port: uiSettings.get().remotePort,
    error: remoteError,
  }));

  // ---- Peer deploy wizard: probe a box, then install/update Clodex on it.
  // Tunnel-free — both ssh in and curl hello ON the box (see peer-deploy.js /
  // ssh-run.js). Classification + the deploy script live off-electron so they're
  // unit-tested; these handlers are the thin electron adapter.
  ipcMain.handle('peer:probe', async (_e, sshHost, port) => {
    if (!sshHost || typeof sshHost !== 'string') return { kind: 'ssh-fail', stderr: 'no ssh host given' };
    try {
      return await probePeer(sshHost, port || uiSettings.get().remotePort || 7900);
    } catch (e) {
      return { kind: 'ssh-fail', stderr: e && e.message ? e.message : 'probe failed' };
    }
  });

  // Run the idempotent deploy script on the box, streaming each stdout line to
  // the caller window as a `peer-deploy-line` event (the wizard parses ::markers
  // via peer-deploy.parseDeployLine). Resolves with { code, timedOut, stderr }:
  // code 0 = success, 42 = needs sudo (script emitted the exact commands as
  // ::need-sudo/::sudo-cmd lines), anything else = failure.
  ipcMain.handle('peer:deploy', async (e, sshHost, opts = {}) => {
    if (!sshHost || typeof sshHost !== 'string') return { ok: false, error: 'no ssh host given' };
    let script;
    try {
      script = fs.readFileSync(path.join(__dirname, 'peering', 'clodex-deploy.sh'), 'utf8');
    } catch (err) {
      return { ok: false, error: `deploy script unreadable: ${err.message}` };
    }
    // Params ride the environment the remote bash inherits — prepend exports so
    // the script's ${VAR:-default} reads them without changing its shebang line.
    const port = Number.isInteger(opts.port) ? opts.port : (uiSettings.get().remotePort || 7900);
    const repoUrl = typeof opts.repoUrl === 'string' && opts.repoUrl ? opts.repoUrl : `https://github.com/${UPDATE_REPO}`;
    const branch = typeof opts.branch === 'string' && opts.branch ? opts.branch : 'master';
    // Optional deploy-folder override → a CLODEX_SRC export appended to the
    // preamble. classifyDeployFolder renders the tilde/absolute forms safely; a
    // blank folder yields '' (script default stands). A malformed folder is a
    // hard stop BEFORE we ssh — the wizard validates too, but never trust the
    // renderer for a value that becomes a remote shell word.
    const srcClass = classifyDeployFolder(opts.folder);
    if (!srcClass.ok) return { ok: false, error: srcClass.error };
    const shellEsc = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const srcExport = srcClass.srcExport ? ` ${srcClass.srcExport}` : '';
    const preamble =
      `export PORT=${shellEsc(port)} REPO_URL=${shellEsc(repoUrl)} BRANCH=${shellEsc(branch)}${srcExport}\n`;
    const wc = e.sender;
    try {
      const res = await sshRun(sshHost, preamble + script, {
        timeoutMs: 15 * 60 * 1000,       // a cold clone+install+rebuild can be minutes
        onLine: (line) => { try { if (!wc.isDestroyed()) wc.send('peer-deploy-line', sshHost, line); } catch {} },
      });
      return {
        ok: res.code === 0,
        code: res.timedOut ? null : res.code,
        timedOut: !!res.timedOut,
        needSudo: res.code === 42,
        stderr: (res.stderr || '').trim().split('\n').slice(-20).join('\n'),
      };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'ssh failed to start' };
    }
  });

  // Agent fallback for a failed deploy: spin up a local ad-hoc Claude session
  // (cwd = homedir, focused window's workspace) and hand it the deploy log +
  // playbook pointers so it can untangle the box. The briefing rides the spill
  // channel via _deliverMessage (>500B → file + @-attach). Injection is deferred
  // a beat so the fresh CLI has reached its input prompt before we type.
  ipcMain.handle('peer:deployFix', async (e, sshHost, port, label, logText) => {
    const host = typeof sshHost === 'string' ? sshHost : '';
    const p = Number.isInteger(port) ? port : (uiSettings.get().remotePort || 7900);
    const name = fixSessionName(label || host || 'peer', new Set(manager.sessions.keys()));
    const wsId = workspaceOfSender(e);
    const dir = os.homedir();
    try {
      const out = await manager.create(
        name, 'claude', dir, [], null, wsId,
        null, false, null, [], [], [], [], [], null, [],
      );
      const briefing = buildDeployFixBriefing({
        sshHost: host, port: p, label, logText,
        docsDir: path.join(__dirname, 'peering'),
      });
      setTimeout(() => {
        try { manager._deliverMessage(name, 'user', briefing, 'dm'); } catch {}
      }, DEPLOY_FIX_INJECT_DELAY_MS);
      log.info('session', `deploy-fix session ${name} for ${host}`);
      return { ok: true, name: out.name };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'could not create fix session' };
    }
  });

  // ---- Peered Clodexes: renderer-facing thin adapter. All protocol,
  // reconnect and buffering logic lives in peer-client.js; events reach the
  // renderer as peer-state / peer-activity / peer-replay / peer-data /
  // peer-control / peer-exit broadcasts.
  ipcMain.handle('peer:list', () => {
    const out = peerManager ? peerManager.statuses() : [];
    const tunnels = new Map((tunnelManager ? tunnelManager.statuses() : []).map((t) => [t.id, t]));
    for (const st of out) st.tunnel = tunnels.get(st.id) || null;
    return out;
  });
  ipcMain.handle('peer:attach', (_e, id, name) => {
    const conn = peerManager && peerManager.get(id);
    if (!conn) return { ok: false, error: 'no such peer' };
    const res = conn.attach(name);
    // Persist the attachment so the tab auto-restores on the next app launch.
    if (res && res.ok) {
      const map = { ...(uiSettings.get().peerAttached || {}) };
      const list = Array.isArray(map[id]) ? map[id] : [];
      if (!list.includes(name)) { map[id] = [...list, name]; uiSettings.set({ peerAttached: map }); }
    }
    return res;
  });
  ipcMain.handle('peer:detach', (_e, id, name) => {
    const conn = peerManager && peerManager.get(id);
    if (!conn) return { ok: false, error: 'no such peer' };
    const res = conn.detach(name);
    // Explicit detach = user closed the tab: stop persisting it. Control implies
    // attachment, so a gone tab drops its control claim too.
    forgetPeerAttached(id, name);
    forgetPeerControlled(id, name);
    return res;
  });
  // Renderer reads this once at startup to seed its one-shot restore map.
  ipcMain.handle('peer:attachedNames', () => uiSettings.get().peerAttached || {});
  // Renderer prunes a persisted name that no longer exists on the live peer,
  // without a live connection to detach from.
  ipcMain.handle('peer:forgetAttached', (_e, id, name) => {
    forgetPeerAttached(id, name);
    return { ok: true };
  });
  // Per-peer visibility selection. Renderer reads the whole map at startup and
  // keeps a local copy fresh from setVisible responses.
  ipcMain.handle('peer:visible', () => uiSettings.get().peerVisible || {});
  // names = array ⇒ restrict this peer to those names (empty = show none);
  // names = null ⇒ delete the key (back to show-all). Sanitized through the
  // same name regex the persistence layer enforces.
  ipcMain.handle('peer:setVisible', (_e, id, names) => {
    const map = { ...(uiSettings.get().peerVisible || {}) };
    if (names === null || names === undefined) {
      delete map[id];
    } else if (Array.isArray(names)) {
      map[id] = names.filter((n) => typeof n === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(n));
    } else {
      return { ok: false, error: 'names must be an array or null' };
    }
    uiSettings.set({ peerVisible: map });
    return { ok: true, peerVisible: map };
  });
  ipcMain.handle('peer:control', (_e, id, name, on) => new Promise((resolve) => {
    const conn = peerManager && peerManager.get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.control(name, !!on, (res) => {
      // Persist the control claim on a successful take, drop it on a successful
      // release — so it auto-re-takes across a restart of this app OR the box.
      // (Mirrors peer:attach's inline persist.) A failed take never persists.
      if (res && res.ok) {
        if (on) rememberPeerControlled(id, name); else forgetPeerControlled(id, name);
      }
      resolve(res);
    });
  }));
  // Renderer reads this once at startup to seed its control-restore mirror.
  ipcMain.handle('peer:controlledNames', () => uiSettings.get().peerControlled || {});
  // Explicit drop of a persisted control claim — used when a restore re-acquire
  // finds the session is held by someone else (stale claim, don't retry-loop).
  ipcMain.handle('peer:forgetControlled', (_e, id, name) => {
    forgetPeerControlled(id, name);
    return { ok: true };
  });
  ipcMain.handle('peer:resize', (_e, id, name, cols, rows) => new Promise((resolve) => {
    const conn = peerManager && peerManager.get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.resize(name, cols, rows, resolve);
  }));
  // Host-level remote restart of a peer's Clodex (restart-only, no self-update:
  // the operator git-pulls on the peer host, then triggers this to pick up the
  // new code). Authority is the tunnel, same as every other peer RPC; the
  // viewer fronts a confirm dialog for intentionality. The peer acks, then
  // quits + relaunches; its offline/online blip rides the existing reconnect.
  ipcMain.handle('peer:restart', (_e, id) => new Promise((resolve) => {
    const conn = peerManager && peerManager.get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.restart(resolve);
  }));
  // Remote session create/kill on a peer — makes the Mac the cockpit for a
  // headless box. Trust is the tunnel (settled); the viewer fronts a dialog
  // (create) / confirm (kill) for intentionality. The ack carries the outcome.
  ipcMain.handle('peer:createSession', (_e, id, spec) => new Promise((resolve) => {
    const conn = peerManager && peerManager.get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.createSession(spec || {}, resolve);
  }));
  ipcMain.handle('peer:killSession', (_e, id, name) => new Promise((resolve) => {
    const conn = peerManager && peerManager.get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.killSession(String(name || ''), resolve);
  }));
  // Remote session restart on a peer — plain restart (keeps history) or a
  // fresh reload (new conversation, re-reads skills). The viewer fronts a
  // confirm only for the fresh variant, mirroring the local hard-restart.
  ipcMain.handle('peer:restartSession', (_e, id, name, opts) => new Promise((resolve) => {
    const conn = peerManager && peerManager.get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.restartSession(String(name || ''), opts || {}, resolve);
  }));
  // Popover data for a peer session — one kind-dispatched pull, answered by
  // the owner from the same sources its own popups use.
  ipcMain.handle('peer:query', (_e, id, name, kind, args) => new Promise((resolve) => {
    const conn = peerManager && peerManager.get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.query(name, String(kind || ''), args, resolve);
  }));
  // Keystrokes: fire-and-forget like local pty-input; a failed send surfaces
  // as the terminal simply not echoing.
  ipcMain.on('peer:input', (_e, id, name, data) => {
    const conn = peerManager && peerManager.get(id);
    if (conn) conn.input(name, String(data ?? ''), () => {});
  });

  // Global default tool-deny set new sessions inherit (the "*" agent-default).
  // An explicit [] is honored (deny nothing); separate store from uiSettings, so
  // it gets its own setter. Returns the persisted set for the renderer to render.
  ipcMain.handle('defaults:setToolDeny', (_e, list) => {
    agentDefaults.setDefaultDeny(Array.isArray(list) ? list : []);
    return agentDefaults.getDefaultDeny();
  });

  // Theme set from a renderer's Preferences picker. The sender already applied
  // it locally, so skip echoing back to it; sync the other windows + menu.
  ipcMain.handle('theme:set', (e, name) => { setUiTheme(name, e.sender); });

  ipcMain.handle('wirescope:status', () => wirescope.status());
  ipcMain.handle('wirescope:start', () => wirescope.start());
  ipcMain.handle('wirescope:stop', () => wirescope.stop());
  ipcMain.handle('wirescope:restart', () => wirescope.restart());
  // Capture-log size/reclaimable readout. A non-200 / missing-endpoint result
  // (older proxy without /_prune) comes back ok:false → the renderer hides the
  // whole capture-logs affordance (presence IS the capability).
  ipcMain.handle('wirescope:pruneInfo', async () => {
    try {
      const r = await ProxyClient.pruneInfo(wirescope.baseUrl());
      if (r.status !== 200 || !r.json || r.json.ok === false) {
        return { ok: false, error: (r.json && r.json.error) || `proxy returned ${r.status}` };
      }
      return { ok: true, data: r.json };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  // Execute (or dry-run) a prune. opts: { olderThan, tier, scope, dryRun }.
  // wirescope enforces the safety guards (skips active/warm/recent); clodex just
  // relays and surfaces the result body.
  ipcMain.handle('wirescope:prune', async (_e, opts) => {
    const o = opts || {};
    if (!o.olderThan) return { ok: false, error: 'older_than required' };
    try {
      const r = await ProxyClient.prune(wirescope.baseUrl(), o);
      if (r.status !== 200 || !r.json) {
        return { ok: false, error: (r.json && r.json.error) || `proxy returned ${r.status}` };
      }
      return { ok: true, data: r.json };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('session:exportMarkdown', async (_e, name) => {
    const s = manager.sessions.get(name);
    if (!s) return { ok: false, error: 'Session not found' };
    if (!s.agentType) return { ok: false, error: 'Export only works for agent sessions' };

    // Resolve the JSONL file via the symlink
    const linkPath = path.join(REGISTRY_DIR, `${name}.jsonl`);
    let jsonlPath;
    try {
      jsonlPath = fs.realpathSync(linkPath);
    } catch {
      return { ok: false, error: 'No transcript found yet — wait until the agent has responded at least once.' };
    }

    // Ask user where to save
    const defaultPath = path.join(
      app.getPath('desktop'),
      `${name}-${new Date().toISOString().slice(0, 10)}.md`,
    );
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
      defaultPath,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };

    try {
      const md = jsonlToMarkdown(jsonlPath, s.agentType, name);
      fs.writeFileSync(result.filePath, md);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('session:context-menu', (e, { name, cwd }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    // Quick prompt picker — set the session's system/append prompt refs without
    // opening the Edit Session dialog. Persists immediately + applies on next
    // (re)start; the renderer is told so it can offer to restart now.
    const entry = persistence.get(name) || {};
    const isAgent = entry.type === 'claude' || entry.type === 'codex';
    const sysPrompts = promptLibrary.list('system');
    const appendPrompts = promptLibrary.list('append');
    const curSys = entry.systemPromptFile || null;
    const curAppend = entry.appendPromptFiles || [];
    const notifyPromptsChanged = () =>
      e.sender.send('session:context-action', { action: 'promptsChanged', name });
    const promptsSubmenu = [
      { label: 'System prompt', enabled: false },
      {
        label: '(CLI default)', type: 'radio', checked: !curSys,
        click: () => { persistence.setPromptRefs(name, null, curAppend); notifyPromptsChanged(); },
      },
      ...sysPrompts.map(p => ({
        label: p.name, type: 'radio', checked: curSys === p.name,
        click: () => { persistence.setPromptRefs(name, p.name, curAppend); notifyPromptsChanged(); },
      })),
      { type: 'separator' },
      { label: 'Append prompts', enabled: false },
      ...(appendPrompts.length ? appendPrompts.map(p => ({
        label: p.name, type: 'checkbox', checked: curAppend.includes(p.name),
        click: () => {
          const next = curAppend.includes(p.name)
            ? curAppend.filter(x => x !== p.name) : [...curAppend, p.name];
          persistence.setPromptRefs(name, curSys, next);
          notifyPromptsChanged();
        },
      })) : [{ label: '(no append prompts in library)', enabled: false }]),
    ];
    const menu = Menu.buildFromTemplate([
      {
        label: 'Rename…',
        click: () => e.sender.send('session:context-action', { action: 'rename', name }),
      },
      {
        label: 'Edit Session…',
        click: () => e.sender.send('session:context-action', { action: 'editArgs', name }),
      },
      ...(isAgent ? [{ label: 'Prompts', submenu: promptsSubmenu }] : []),
      {
        label: 'Restart Session',
        click: () => e.sender.send('session:context-action', { action: 'restart', name }),
      },
      { type: 'separator' },
      {
        label: 'Reveal Working Directory in Finder',
        enabled: !!cwd,
        click: () => { if (cwd) shell.showItemInFolder(cwd); },
      },
      {
        label: 'Open in Terminal',
        enabled: !!cwd,
        click: () => {
          if (!cwd) return;
          // Open Terminal.app at the cwd
          const { exec } = require('child_process');
          exec(`open -a Terminal "${cwd.replace(/"/g, '\\"')}"`);
        },
      },
      { type: 'separator' },
      {
        label: 'Export Conversation as Markdown…',
        click: () => e.sender.send('session:context-action', { action: 'export', name }),
      },
      { type: 'separator' },
      {
        label: 'Kill Session',
        click: () => e.sender.send('session:context-action', { action: 'kill', name }),
      },
    ]);
    menu.popup({ window: win });
  });

  // Peer session rows get their own menu — the verbs (attach/control/detach/
  // hide) differ entirely from a local session's, so it's a separate template
  // rather than an overload. State is supplied by the renderer (the source of
  // truth for attach/control lives there, not in persistence); we only render.
  ipcMain.on('peer:context-menu', (e, st) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { id, name, online, attached, controlled, holder, canCreate, hostLabel, type } = st || {};
    const act = (action) => () => e.sender.send('peer:context-action', { action, id, name });
    const template = [];
    // Who holds it, when it's not us — informational, like the peer bar. Take
    // control stays enabled (acquire is last-wins), matching the bar.
    if (holder && !controlled) {
      template.push({ label: `Controlled by ${holder}`, enabled: false });
      template.push({ type: 'separator' });
    }
    if (!attached) {
      template.push({ label: 'Attach', click: act('attach') });
      template.push({ label: 'Take control', enabled: !!online, click: act('takeControl') });
    } else if (controlled) {
      template.push({ label: 'Release control', click: act('releaseControl') });
      template.push({ label: 'Detach (keep listed)', click: act('detach') });
    } else {
      template.push({ label: 'Take control', enabled: !!online, click: act('takeControl') });
      template.push({ label: 'Detach (keep listed)', click: act('detach') });
    }
    template.push({ type: 'separator' });
    template.push({ label: 'Hide from list', click: act('hide') });
    // Host-level lifecycle on the peer — restart/reload/kill. All gated on the
    // create capability (they ship together) + peer online. Restart mirrors the
    // local pair: a plain restart (--resume, keeps history, no confirm) and a
    // fresh reload (new conversation, re-reads skills, confirmed in the renderer
    // like doHardRestart). Kill is the destructive removal (no resume).
    if (canCreate) {
      template.push({ type: 'separator' });
      template.push({
        label: `Restart "${name}" on ${hostLabel || 'peer'}`,
        enabled: !!online,
        click: act('restartRemote'),
      });
      // Fresh reload = new conversation + skill re-read: meaningless for bash
      // (no conversation/roster), so it's offered for agents only.
      if (type !== 'bash') {
        template.push({
          label: `Reload "${name}" on ${hostLabel || 'peer'} (fresh)…`,
          enabled: !!online,
          click: act('reloadRemote'),
        });
      }
      template.push({ type: 'separator' });
      template.push({
        label: `Kill "${name}" on ${hostLabel || 'peer'}`,
        enabled: !!online,
        click: act('killRemote'),
      });
    }
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Peer HEADER right-click: host-level actions (remote restart today). Distinct
  // from the per-session menu above — restart is host-scoped. The label rides
  // through as `name` so the renderer's confirm/toast can address the peer; the
  // action reuses the same peer:context-action channel. Restart needs the peer
  // online (a down peer has nothing to restart — the process-gone case is out
  // of scope).
  // Deploy target for a peer id — the SINGLE resolver both the popover's Update
  // button (peer:deployConfig) and the header-menu "Update Clodex…" item read,
  // so the folder-precedence rule lives in exactly one place. { sshHost, port,
  // folder } for an ssh-reachable peer, or null (url-only / unknown id) so the
  // caller hides Update. folder follows resolveDeployFolder: the box's live
  // self-reported srcDir wins over the persisted deployFolder guess (a stale
  // guess must not shadow live truth), which wins over '' (script default).
  function deployTargetFor(id) {
    const cfg = (uiSettings.get().peers || []).find((p) => p && p.id === id);
    if (!cfg || !cfg.sshHost) return null;
    const st = peerManager ? peerManager.statuses().find((s) => s.id === id) : null;
    const reported = st && st.online ? st.srcDir : null;
    return {
      sshHost: cfg.sshHost,
      port: Number.isInteger(cfg.remotePort) ? cfg.remotePort : 7900,
      folder: resolveDeployFolder(reported, cfg.deployFolder),
    };
  }
  ipcMain.handle('peer:deployConfig', (_e, id) => deployTargetFor(id));

  ipcMain.on('peer:header-menu', (e, st) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { id, label, online, canCreate, sev } = st || {};
    const template = [];
    // Create is gated on the peer advertising the 'create' capability (older
    // peers 501 the endpoint); the renderer passes canCreate from st.caps.
    if (canCreate) {
      template.push({
        label: `New Session on ${label || 'peer'}…`,
        enabled: !!online,
        click: () => e.sender.send('peer:context-action', { action: 'newSession', id, name: label }),
      });
      template.push({ type: 'separator' });
    }
    template.push({
      label: `Restart Clodex on ${label || 'peer'}`,
      enabled: !!online,
      click: () => e.sender.send('peer:context-action', { action: 'restart', id, name: label }),
    });
    // "Update Clodex on <box>…" re-runs the idempotent deploy script over ssh.
    // Only offered for peers reached via an ssh host (a url-only peer has no ssh
    // route) and only when online (nothing to update on an unreachable box).
    // Same deployTargetFor resolver as the popover — reported srcDir wins. Also
    // gated on severity (updateApplies): hidden for a same-version or ahead box,
    // the renderer passes sev from the header row it already computed.
    const target = (online && updateApplies(sev)) ? deployTargetFor(id) : null;
    if (target) {
      template.push({ type: 'separator' });
      template.push({
        label: `Update Clodex on ${label || 'peer'}…`,
        click: () => e.sender.send('peer:context-action', {
          action: 'update', id, name: label,
          sshHost: target.sshHost,
          port: target.port,
          folder: target.folder,
        }),
      });
    }
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Native confirm for remote restart — mirrors dialog:confirmKill. The peer's
  // sessions resume via the normal quit/restore lifecycle, so the copy says so.
  ipcMain.handle('dialog:confirmPeerRestart', async (_e, label) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'question',
      buttons: ['Restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Restart Clodex on ${label || 'this peer'}?`,
      detail: 'The remote app will quit and reopen. Its sessions will resume after the restart.',
    });
    return result.response === 0;
  });

  // Native confirm for the in-place update (re-run the deploy script over ssh).
  // Cancel default; the box's app restarts on success, so the copy says so.
  ipcMain.handle('dialog:confirmPeerUpdate', async (_e, label) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'question',
      buttons: ['Update', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Update Clodex on ${label || 'this peer'}?`,
      detail: 'Re-runs the deploy script over ssh (git pull → build → restart). Safe and idempotent; it can take a few minutes. The box restarts on success and its sessions resume.',
    });
    return result.response === 0;
  });

  // Native confirm for the agent fallback after a failed deploy — opens a local
  // ad-hoc Claude session to untangle the box. Cancel default.
  ipcMain.handle('dialog:confirmDeployFix', async (_e, sshHost) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'question',
      buttons: ['Open agent session', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Open an agent session to fix this?',
      detail: `Creates a local Claude session briefed with the deploy log and the playbook for ${sshHost || 'the box'}, so it can ssh in and finish the install.`,
    });
    return result.response === 0;
  });

  // Native confirm for killing a session ON a peer — destructive (removes it on
  // the remote box, no resume), distinct from local Detach/Hide. Mirrors
  // confirmKill's copy but names the host so it's unmistakably the remote one.
  ipcMain.handle('dialog:confirmPeerKill', async (_e, name, label) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'warning',
      buttons: ['Kill', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Kill session "${name}" on ${label || 'the peer'}?`,
      detail: 'This ends the agent process on the remote box and removes it — it will not resume.',
    });
    return result.response === 0;
  });

  // Native confirm for a fresh peer reload — mirrors doHardRestart's copy
  // (new conversation, CLI re-reads skills/tools/settings; old convo stays in
  // 🕘 history). Plain peer restart has NO confirm, parity with the local plain
  // restart; only the fresh variant (which drops the live conversation) asks.
  ipcMain.handle('dialog:confirmPeerReload', async (_e, name, label) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'question',
      buttons: ['Reload', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Reload "${name}" on ${label || 'the peer'} with a fresh conversation?`,
      detail: 'Starts a new conversation so the CLI reloads tools, skills, and settings from disk '
        + '(a plain restart keeps the old roster). The current conversation isn\'t lost — it stays '
        + 'available under 🕘 history on the remote box.',
    });
    return result.response === 0;
  });

  ipcMain.handle('dialog:confirmKill', async (_e, name) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'warning',
      buttons: ['Kill', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Kill session "${name}"?`,
      detail: 'This ends the agent process. The conversation history is preserved and can be resumed later.',
    });
    return result.response === 0;
  });

  ipcMain.on('pty-input', (_e, name, data) => {
    manager.write(name, data);
  });

  // Renderer tells us it's ready — restore sessions for its workspace.
  // Sessions already running (this can happen for the default workspace on
  // second window creation via tray) are returned as-is so the renderer can
  // render them without double-spawning.
  const readCtxFor = (name) => {
    try {
      const c = parseCtxFile(fs.readFileSync(path.join(REGISTRY_DIR, `${name}-ctx`), 'utf-8'));
      return { ctx: c.pct, ctxTok: c.tok, ctxSize: c.size };
    } catch { return { ctx: null, ctxTok: null, ctxSize: null }; }
  };

  ipcMain.handle('app:restore-sessions', async (e) => {
    const workspaceId = workspaceOfSender(e);
    const saved = persistence.listForWorkspace(workspaceId);
    const restored = [];
    for (const entry of saved) {
      if (manager.sessions.has(entry.name)) {
        // Already running — report it and flush any buffered output so the
        // new terminal shows everything that happened while detached
        const session = manager.sessions.get(entry.name);
        const replay = session.pendingOutput || null;
        session.pendingOutput = '';
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
          replay,
          // Seed the sidebar dot with the CURRENT state — activity events
          // while detached were dropped, so without this a busy or blocked
          // session reattaches showing idle grey until its next transition.
          activity: session.activityState || 'idle',
          attention: session.needsAttention || null,
          ...readCtxFor(entry.name),
          proxy: proxyPoller.snapshot(entry.name),
        });
        continue;
      }
      try {
        // Resume-time bake (opt-in, fail-safe): slim the transcript before
        // --resume so the replayed prefix is small + permanently slimmer. Safe
        // regardless of cache warmth — the bake is byte-identical to the live
        // wire (bake ⊆ live-strip), so it can't bust a warm prefix. No-op unless
        // the compactOnResume setting + a live wirescope are both present.
        await maybeCompactBeforeResume(entry);
        await manager.create(
          entry.name,
          entry.type,
          entry.cwd,
          entry.extraArgs || [],
          entry.sessionId,
          workspaceId,
          entry.systemPrompt || null,
          false,
          entry.proxy ?? null,
          entry.agents || [],
          entry.denyBuiltins || [],
          entry.disabledTools || [],
          entry.disabledSkills || [],
          entry.injectSkills || [],
          entry.systemPromptFile || null,
          entry.appendPromptFiles || [],
        );
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
          ...readCtxFor(entry.name),
          proxy: proxyPoller.snapshot(entry.name),
        });
      } catch (err) {
        // DO NOT remove from persistence — surface the failure to the UI
        // so the user can retry or delete. Silently wiping was the cause
        // of the "agents vanish after upgrade" bug.
        console.error(`Failed to restore session ${entry.name}:`, err.message);
        log.error('session', `restore failed ${entry.name}: ${err.message}`);
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
          failed: true,
          error: err.message,
        });
      }
    }
    return restored;
  });

  // Retry spawning a session that failed during restore
  ipcMain.handle('session:retrySpawn', async (e, name) => {
    const workspaceId = workspaceOfSender(e);
    const entry = persistence.list().find(s => s.name === name);
    if (!entry) return { ok: false, error: 'No saved entry found' };
    try {
      await manager.create(
        entry.name,
        entry.type,
        entry.cwd,
        entry.extraArgs || [],
        entry.sessionId,
        workspaceId,
        entry.systemPrompt || null,
        false,
        entry.proxy ?? null,
        entry.agents || [],
        entry.denyBuiltins || [],
        entry.disabledTools || [],
        entry.disabledSkills || [],
        entry.injectSkills || [],
        entry.systemPromptFile || null,
        entry.appendPromptFiles || [],
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // "Forget" a session — remove from persistence without killing (it's not running)
  ipcMain.handle('session:forget', (_e, name) => {
    persistence.remove(name);
    return true;
  });

  // Workspace management
  ipcMain.handle('workspace:list', () => workspaces.list());
  ipcMain.handle('workspace:current', (e) => workspaceOfSender(e));
  ipcMain.handle('workspace:setName', (e, name) => {
    workspaces.setName(workspaceOfSender(e), name || 'Workspace');
    refreshTrayMenu();
    refreshAppMenu();
    return true;
  });
  ipcMain.handle('workspace:new', () => {
    const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createWindow(id);
    refreshAppMenu();
    refreshTrayMenu();
  });

  buildAppMenu();

  // IDE-style startup: open only the most recently used workspace.
  // Others are accessible via the File / Window / tray menus.
  const sortedWorkspaces = workspaces.sortedByRecent();
  if (sortedWorkspaces.length === 0) {
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
