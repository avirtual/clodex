// The bootstrap body sits at file-level indentation inside createEngine and must
// NOT be re-indented: it contains byte-sensitive template literals (generated
// hook scripts) that a reflow would rewrite.
'use strict';

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
const { confine } = require('./path-confine');
const { runLegacySweep, findOrphans } = require('./legacy-sweep');
const { materializePotCli, materializeExecScripts } = require('./pot-bin');
// Module-level, unlike the rest of pending-store's surface (required inside
// createEngine): sweepSpilledMessages below is module-level so its exemption is
// testable without building an engine, and a closure require would not be in
// scope there.
const { allParkedTexts } = require('./pending-store');

function diagWarning(d = {}) {
  // process.arch uses 'x64'; Mach-O reports 'x86_64'. Normalize to compare.
  const expectedArch = process.arch === 'x64' ? 'x86_64' : process.arch;
  // Fatal node-pty spawn-helper problems FIRST (darwin) — the helper is what
  // posix_spawn actually launches, so any problem with it sinks EVERY session
  // regardless of which CLIs are installed; these take priority.
  if (d.platform === 'darwin') {
    if (!d.helperExists) {
      return 'node-pty spawn-helper is missing — sessions can\'t start. Fix: npx electron-rebuild';
    }
    if (!d.helperExecutable) {
      return `node-pty spawn-helper is not executable — sessions can't start. Fix: chmod +x "${d.helperPath}"`;
    }
    if (!['universal', '32-bit'].includes(d.helperArch) && d.helperArch !== expectedArch) {
      return `spawn-helper arch (${d.helperArch}) != app arch (${expectedArch}) — `
        + 'every session fails with "posix_spawnp failed." Fix: npx electron-rebuild';
    }
    if (d.rosetta) {
      return 'Running under Rosetta — rebuild native modules for the running arch: npx electron-rebuild';
    }
  }
  if (d.pathMergeFailed) {
    return 'PATH merge from your login shell failed — CLIs installed there (claude/codex) '
      + 'may be invisible to Clodex. Relaunch Clodex, or start it from a terminal.';
  }
  // Neither agent CLI on PATH → no agent session can start at all. A SINGLE missing
  // CLI is handled precisely by the New Session dialog gate (and the enriched exit
  // toast), so it's deliberately NOT raised as a global banner — nagging a user who
  // uses only one CLI would be noise.
  if (!d.claude && !d.codex) {
    return 'Neither the claude nor codex CLI was found on PATH — no agent sessions can start. '
      + 'Install one, e.g. curl -fsSL https://claude.ai/install.sh | bash';
  }
  return null;
}

// Spill filenames minted by spillToFile (inside createEngine): the pointer
// grammar the reference scan below recognizes. The two must move together — a
// change to one shape without the other silently reopens the GC hole.
const SPILL_NAME_RE = /msg-\d+-\d+\.txt/g;

// Parking has no expiry; spill files do — and the spill file is the only copy of
// an over-threshold dm body, so an unexempted sweep loses it silently.
// Match on the FILENAME grammar, not the pointer prose: there are already two
// pointer wordings (claude `@<path>`, codex `saved to <path>`). Over-matching
// only keeps a file one extra sweep.
function referencedSpillNames(pendingDir) {
  const refs = new Set();
  for (const text of allParkedTexts(pendingDir)) {
    for (const m of text.match(SPILL_NAME_RE) || []) refs.add(m);
  }
  return refs;
}

// Exempting parked pointers means a seat that never returns grows disk forever.
// Deliberate: the alternative caps disk by destroying undelivered dms. If it
// ever bites, add a `pending/` expiry — ONE policy for both lifetimes — rather
// than a second policy here that disagrees with parking.
function sweepSpilledMessages(msgDir, pendingDir, maxAgeSec, now = Date.now()) {
  if (!fs.existsSync(msgDir)) return;
  const referenced = referencedSpillNames(pendingDir);
  // Spilled messages live one level deep, in a per-recipient subfolder.
  // Walk both the subfolders and (for back-compat) any stray files at the root.
  for (const entry of fs.readdirSync(msgDir, { withFileTypes: true })) {
    try {
      const epath = path.join(msgDir, entry.name);
      if (entry.isDirectory()) {
        for (const fname of fs.readdirSync(epath)) {
          try {
            if (referenced.has(fname)) continue;
            const fpath = path.join(epath, fname);
            if ((now - fs.statSync(fpath).mtimeMs) / 1000 > maxAgeSec) fs.unlinkSync(fpath);
          } catch {}
        }
      } else if (!referenced.has(entry.name)
          && (now - fs.statSync(epath).mtimeMs) / 1000 > maxAgeSec) {
        fs.unlinkSync(epath);
      }
    } catch {}
  }
}

function createEngine({ userDataPath, seams = {}, log }) {
  // Individual consts (not a destructure-with-defaults) so each seam name is
  // visible to the leak-scanner's ownDefinitions; the `|| default` keeps every
  // seam optional so a host (headless) can omit the ones it lacks.
  const openPath = seams.openPath || (() => {});
  const openExternalSeam = seams.openExternal || ((url) => { log.info('seam', `openExternal (no host browser): ${url}`); });
  const notifyOS = seams.notifyOS || (() => {});
  const setAppQuitting = seams.setAppQuitting || (() => {});
  const appVersion = seams.appVersion || require('./package.json').version;
  const isPackaged = seams.isPackaged || (() => false);
  const refreshAppMenu = seams.refreshAppMenu || (() => {});
  const scheduleAppMenuRefresh = seams.scheduleAppMenuRefresh || (() => {});
  const refreshTrayMenu = seams.refreshTrayMenu || (() => {});
  const scheduleTrayRefresh = seams.scheduleTrayRefresh || (() => {});
  const restartHost = seams.restartHost || (() => {});
  const pathMergeFailed = !!seams.pathMergeFailed;
  const enableSandbox = seams.enableSandbox !== false;

  // The browser frontend's host, for peers that want to REACH it (t30). A
  // GETTER, not a value: web-host.js is started by headless-main.js AFTER
  // createEngine returns, so there is nothing to pass at construction time.
  // Electron omits the seam entirely and reports null — the desktop app has no
  // web host, and a consumer must learn that rather than guess wire-port+1.
  const getWebInfo = seams.webInfo || (() => null);

  const REGISTRY_DIR = path.join(os.homedir(), '.clodex');



// node-pty's "posix_spawnp failed." is the spawn of its prebuilt spawn-helper,
// not of claude/codex — so `which claude` succeeding proves nothing. The usual
// cause is a spawn-helper arch mismatch (posix_spawn rejects with EBADARCH).

function whichBin(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/')) { try { fs.accessSync(cmd, fs.constants.X_OK); return cmd; } catch { return null; } }
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

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

// Must check node-pty's OWN candidate set in its order (build/Release,
// build/Debug, prebuilds/<platform>-<arch>, each asar.unpacked-rewritten): with
// no electron-rebuild it loads the prebuild, so a narrower check names the wrong helper.
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
    pathMergeFailed,
    helperPath: helper, helperExists: fs.existsSync(helper),
    helperExecutable, helperArch: machoArch(helper),
  };
}

function diagSummary(d = collectSystemDiagnostics()) {
  return `proc=${d.platform}/${d.procArch}${d.rosetta ? '(rosetta)' : ''} helper=${d.helperArch} `
    + `electron=${d.electron} node=${d.node}`;
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


const MSG_DIR = path.join(REGISTRY_DIR, 'messages');
const PENDING_DIR = path.join(REGISTRY_DIR, 'pending');
const OUTBOX_DIR = path.join(REGISTRY_DIR, 'peer-outbox');
const SELF_LABEL = os.hostname().replace(/\.local$/, '');
const MAX_MSG = 65536;
const MSG_SPILL_THRESHOLD = 500;
const MSG_MAX_AGE = 1800;
const MSG_CLEANUP_INTERVAL = 5 * 60 * 1000; // ms
const DEPLOY_FIX_INJECT_DELAY_MS = 4000;


const WIRE_SHADOW = process.env.CLODEX_WIRE_SHADOW !== '0';
const WIRE_TELEMETRY_LIVE = process.env.CLODEX_WIRE_TELEMETRY != null
  ? process.env.CLODEX_WIRE_TELEMETRY === '1'
  : WIRE_SHADOW;
const WIRE_INTENTS_LIVE = process.env.CLODEX_WIRE_INTENTS != null
  ? process.env.CLODEX_WIRE_INTENTS === '1'
  : WIRE_SHADOW;
const LONG_TEXT_THRESHOLD = 200;
const LONG_TEXT_DELAY = 1000;
const SHORT_TEXT_DELAY = 50;
const COMPACT_CONTINUATION_DELAY = 1500;
const RELOAD_CONTINUATION_DELAY = 2500;
const INJECT_HOLD_TIMEOUT = 5 * 60 * 1000;
const COMPACT_INFLIGHT_TIMEOUT = 5 * 60 * 1000;
// The quiet gate defers an inject while a human touched the pane, because the
// leading Ctrl-U eats an un-submitted draft. The window is short because it
// applies to EVERY inject, not just post-hold batch flushes. MAXWAIT is the
// walked-away-draft fallback only: at 30s it spliced live composition mid-word
// (observed twice, operator confirmed actively typing).
const INJECT_QUIET_MS = 2 * 1000;
const INJECT_QUIET_MAXWAIT = 5 * 60 * 1000;
// First inject into a fresh claude seat waits for the mode-2004 readiness edge:
// text+Enter written before the CLI's raw-mode input loop is up arrives as one
// paste-like chunk and the Enter lands as content, so nothing submits.
const INJECT_BOOT_MAXWAIT = 20 * 1000;



let remindScheduler = null;

function stripLevelOf(entry) {
  if (!entry) return 0;
  if (entry.stripLevel === 1 || entry.stripLevel === 2) return entry.stripLevel;
  if (entry.stripThinking === 'on') return 1; // legacy boolean field
  return 0;
}

function autoCompactOf(entry) {
  return !(entry && entry.autoCompact === false);
}

function isDigested(entry, sessionId) {
  return !!(entry && sessionId && Array.isArray(entry.digested) && entry.digested.includes(sessionId));
}




function resolveSystemPromptFile(stem) {
  if (!stem) return null;
  const p = promptLibrary._file('system', stem);
  try { fs.accessSync(p, fs.constants.R_OK); return p; }
  catch { return null; }
}

function readAppendBodies(stems) {
  const out = [];
  for (const stem of stems || []) {
    const body = promptLibrary.raw('append', stem);
    if (body != null && body.trim()) out.push(body);
  }
  return out;
}


const MEMORY_DIR = path.join(REGISTRY_DIR, 'library', 'memory');
const { createMemoryStore, composeDigest, digestTiers } = require('./memory-store');
const memoryStore = createMemoryStore(MEMORY_DIR);
// A SIBLING of library/memory, not a child: that directory's entries are the
// set of agents, so a log dir inside it would enumerate as an agent.
const { createMemoryLoad } = require('./memory-load');
const memoryLoad = createMemoryLoad({ logDir: path.join(REGISTRY_DIR, 'library', 'memory-loadlog') });

// Automatic contextual hint arming — off by default, toggled by the Preferences
// checkbox. `enabled` is a getter rather than a construction-time value so the
// checkbox takes effect on the next keystroke instead of the next launch.
const { createHintArm } = require('./hint-arm');
const {
  createMemoryRetriever, createCommonRetriever, createCompositeRetriever,
  compose: composeHint, terms: hintTerms, unitsAsRecords, personalAsk,
} = require('./hint-retrieve');

// Shared memory every agent can match against — imported sets, not anything an
// agent wrote. A SIBLING of library/memory for the same reason memory-loadlog
// is: entries under that directory enumerate as agents. Its subdirectories are
// SETS (by provenance), so `list(set)` reads one of them.
const commonMemoryStore = createMemoryStore(path.join(REGISTRY_DIR, 'library', 'common-memory'));

// Semantic re-ranking. Its own checkbox because it needs a local Ollama, which
// users do not have — with the daemon absent every path returns "no opinion" and
// arming is exactly the lexical behaviour it was before.
//
// The gate stays lexical. This only reorders what the lexical pass already
// decided was worth arming; see hint-embed.js for the measurement that split
// those two jobs.
const {
  createEmbedder, createVectorCache, createSemanticRanker,
} = require('./hint-embed');
const semanticRanker = createSemanticRanker({
  // Both stores, ranked as ONE list — the opposite of the lexical retriever,
  // which must keep them separate because its floor and coverage are
  // corpus-relative. Cosine is not: a similarity is a property of the pair, so
  // pooling here cannot let one store's size silence the other's hits.
  listRecords: (agent) => [
    ...unitsAsRecords(memoryStore.list(agent)),
    ...unitsAsRecords(commonMemoryStore.list('chat-extract'), 'common'),
  ],
  embedder: createEmbedder({ log }),
  // A SIBLING of library/memory for the same reason memory-loadlog is: entries
  // under that directory enumerate as agents.
  cache: createVectorCache({ file: path.join(REGISTRY_DIR, 'library', 'memory-vectors.json') }),
  log,
});

const hintArm = createHintArm({
  enabled: () => !!uiSettings.get().contextHints,
  retriever: createCompositeRetriever([
    createMemoryRetriever({ listUnits: (agent) => memoryStore.list(agent) }),
    createCommonRetriever({ listUnits: (set) => commonMemoryStore.list(set) }),
  ]),
  // Read per call, never captured: the checkbox must take effect on the next
  // submit rather than the next launch, same as `enabled`.
  semantic: {
    rank: (draft, opts) => (uiSettings.get().semanticHints
      ? semanticRanker.rank(draft, opts)
      : Promise.resolve(null)),
  },
  compose: composeHint,
  terms: hintTerms,
  personalAsk,
  loadState: (agent, id) => memoryLoad.stateOf(agent, id),
  armHints: ({ base, route, id, text, ttl_s, turn_start_only, once }) =>
    ProxyClient.armHints(base, route, [{ id, text, ttl_s, turn_start_only, once }]),
  clearHints: ({ base, route, id }) => ProxyClient.clearHints(base, route, id),
  log,
});



const SKILL_PLUGINS_DIR = path.join(REGISTRY_DIR, 'skill-plugins');
const SKILL_PLUGIN_NAME = 'clodex-skills';



function effectiveInjectedSkills(name, injectSkills) {
  const lib = skillLibrary.list();
  const scoped = lib.map((s) => ({ name: s.name, meta: parseSkillFrontmatter(s.content).meta }));
  const effective = unionEnabled(injectSkills, scoped, name);
  const byName = new Map(lib.map((s) => [s.name, s]));
  return effective.map((n) => byName.get(n)).filter(Boolean);
}

// Scaffold the per-session injection plugin from the enabled skill names and
// return its directory (for --plugin-dir), or null when nothing is injected.
// The dir is rebuilt from scratch each spawn so a removed/edited library skill
// can't linger. Writes only under ~/.clodex — never the repo or ~/.claude.
function writeSkillPlugin(name, injectSkills) {
  const records = effectiveInjectedSkills(name, injectSkills);
  const plugin = buildSkillPlugin(records.map((s) => s.name), records, SKILL_PLUGIN_NAME);
  // The rmSync below is RECURSIVE and fires on every claude spawn, before the
  // no-skills bail — so `dir` is the highest-consequence join in the app, and
  // it must be a confined child of SKILL_PLUGINS_DIR or that delete lands on
  // ~/.clodex (name `..`) or $HOME (name `../..`). The session-name gates
  // upstream are charset filters and never established this.
  const dir = confine(SKILL_PLUGINS_DIR, name);
  if (dir === null) throw new Error(`invalid session name: ${name}`);
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
  // Same recursive delete on the teardown path — confined for the same reason.
  // Silent on a refused name (teardown has no caller to tell), unlike
  // writeSkillPlugin, where a refusal must abort the spawn.
  const dir = confine(SKILL_PLUGINS_DIR, name);
  if (dir === null) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}


const CLAUDE_SL_COMPONENTS = ['model', 'context', 'cost', 'cwd', 'git-branch'];
const CODEX_SL_COMPONENTS = [
  'context-used', 'model-name', 'project-root', 'git-branch',
  'five-hour-limit', 'weekly-limit', 'current-dir', 'context-remaining',
  'model-with-reasoning',
];

const SCROLLBACK_MAX = 256 * 1024;



const { createAgentTransport } = require('./agent-transport');
const { isAlive, registry, Transport } = createAgentTransport({ REGISTRY_DIR, MAX_MSG });


const { buildIpcPrompt, DEFAULT_COMPACT_CONTINUATION } = require('./ipc-prompt');

function rebuildAllStatusScripts(manager) {
  for (const [name, s] of manager.sessions) {
    if (s.agentType !== 'claude') continue;
    const p = pathFor(REGISTRY_DIR, name, 'statusline');
    try { fs.writeFileSync(p, renderClaudeStatusScript(name, !!s.proxyBase, uiSettings, REGISTRY_DIR), { mode: 0o700 }); } catch {}
  }
}


const { PROXY_AGENT_PREFIX, mintProxyAgent, resolveProxyAgentId, pickProxyRecord, shapeProxyRecord, AUTO_COMPACT, shouldAutoCompact, autoCompactDecision, isHumanPtyInput, draftChunkSignal, isDraftOpen, peerStatusLabel, shouldHoldDm, updateApplies, boxWirescopeView } = require('./proxy-util');
const { buildAgentsArg, denyAgentRules, BUILTIN_AGENTS } = require('./agents-util');
const { extractFileTouches, noteFileTouches, vetFileIntent } = require('./file-touch');
const { classifyNotification } = require('./attention');
const { InjectQueue, isInjectInFlight, canFireCompact } = require('./inject-queue');
const { parkDelivery, drainPending, hasPending, hasActivePending, countPending, peekPending, parkIdInUse, claimParkedById } = require('./pending-store');
const { createTeamManifest } = require('./team-manifest');
const {
  findProjectRoot, resolveTeam, createTeam, addRole, listTeams, loadManifest,
  setRole, removeRole, renameRole, setTeamWatchdog,
  // PASSED, not left to defaultClodexHome(): that reads CLODEX_HOME, which
  // would put teams on a different tree than every other subsystem.
} = createTeamManifest({ fs, clodexHome: REGISTRY_DIR });
const { enqueueOutbox, claimOutbox, outboxHasOrigin, listOutboxOrigins } = require('./peer-outbox');
const { parseIntent, fencedLines, looksLikeIntent, shadowIntentKey } = require('./intent-scanner');
const { intentEnabled } = require('./intent-catalog');
const { bodyModeFor, intentEnabledFor, withoutPrivilegedIntentsFor, pluginGrammarLines, pluginRowFor, validIntentNames } = require('./intent-registry');
const { isFilenameToken, parseAndValidate, DEFAULT_MAX_BYTES } = require('./exec-schema');
const { parseRemindSpec } = require('./remind-schedule');
const { createRemindScheduler } = require('./remind-scheduler');
const { mergeClaudeSystemPrompt, mergeCodexInstructions, parseCtxFile } = require('./argv-merge');
const { renderClaudeStatusScript, codexStatusLineArg, normalizeProxyBase, resolveProxyBase } = require('./statusline');
const { jsonlToMarkdown, jsonlToMessages, extractText } = require('./transcript');
const { initStores } = require('./stores');
const { restoreSessionsForWorkspace: restoreSessionsCore } = require('./session-restore');
const { CLAUDE_TOOLS, CLAUDE_SKILLS, SKILL_REENABLE_CONFIRMED, DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, THEME_KEYS } = require('./catalogs');

// Short lowercase base36 token (park/resend handles). Concatenates random
// draws so trailing-zero truncation can't shorten the result below `len`.
function randBase36(len) {
  let s = '';
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}
const { ctxReminderFor } = require('./ctx-reminder');
const { bakePrompt, promptCacheDir } = require('./ipc-prompt-cache');
const { buildSkillPlugin, parseSkillFrontmatter, unresolvedSubagentRefs } = require('./skills-util');
const { unionEnabled } = require('./scope-util');
const { sshRun } = require('./ssh-run');
const { probePeer, fixSessionName, buildDeployFixBriefing, classifyDeployFolder, homeRelativize, resolveDeployFolder } = require('./peer-deploy');
const { resolveSessionArgsPatch } = require('./session-args');
const { ProxyClient, createProxyPoller, PROXY_REPORT_TIMEOUT } = require('./wirescope-proxy');
const ProxyPoller = createProxyPoller({
  log, stripLevelOf, WIRE_TELEMETRY_LIVE,
  autoCompactOf, peerProxyView,
  getPersistence: () => persistence,
  getRemoteServer: () => remoteServer,
  getContextCommands: () => SessionManager.CONTEXT_COMMANDS,
});
const { createWirescopeSupervisor } = require('./wirescope-supervisor');
const { WirescopeSupervisor } = createWirescopeSupervisor({ log, ProxyClient, getUiSettings: () => uiSettings, getUserDataPath: () => userDataPath, isPackaged });
const wirescope = new WirescopeSupervisor();

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

// Only a BARE tool name ("SendMessage") disables the tool; a SCOPED entry
// ("Bash(rm:*)") denies a slice and is ignored here. permissions.deny is a
// UNION with no allow override, so a lower-layer deny is unrevokable from our
// layer-4 settings — hence always read-only.
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

function claudeProjectDir(cwd) {
  if (!cwd) return null;
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}

function lastTranscriptWrite(agentType, cwd, sessionId) {
  if (agentType !== 'claude' || !sessionId) return null;
  const dir = claudeProjectDir(cwd);
  if (!dir) return null;
  try { return fs.statSync(path.join(dir, `${sessionId}.jsonl`)).mtimeMs; } catch { return null; }
}

// Bake the on-disk transcript before --resume. Warmth is irrelevant and needs no
// gate: the prefix cache is keyed on the WIRE bytes, and the bake removes only
// what the live strip already drops (bake ⊆ live-strip), so baked and unbaked
// resumes produce the same wire bytes and the same cache key.
// Fail-safe: opt-in, proxy-gated, and any error / !ok resumes the ORIGINAL file.
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

// nodeInterp is the app's own binary run as Node, baked ABSOLUTE into every
// generated hook so the scripts never depend on an ambient python3 or on PATH
// (packaged .app). Injected here so cli-hooks.js stays free of the `process` global.
const { createCliHooks } = require('./cli-hooks');
const {
  writeClaudeDigestFile, setupClaudeHook, setupCodexHook,
  cleanupClaudeHook, cleanupCodexHook,
// composeRoster reaches the manager lazily and through a try: createCliHooks
// runs long before the SessionManager is constructed, and `manager` is a const
// declared below, so a bare reference during boot is a TDZ throw rather than
// undefined. A pre-manager digest write simply carries no roster.
} = createCliHooks({
  REGISTRY_DIR, memoryStore, getUiSettings: () => uiSettings, nodeInterp: process.execPath,
  composeRoster: (name) => { try { return manager.composeRosterFor(name); } catch { return null; } },
});

const { createJsonlWatcher } = require('./jsonl-watcher');
const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR });

const { createSessionMeta } = require('./session-meta');
const sessionMeta = createSessionMeta({ REGISTRY_DIR });


let msgCounter = 0;

function cleanupOldMessages() {
  sweepSpilledMessages(MSG_DIR, PENDING_DIR, MSG_MAX_AGE);
}

function spillToFile(sender, body, recipient) {
  // Each recipient gets its own subfolder so two agents never appear to share
  // an inbox. Names are constrained to [a-zA-Z0-9._-] upstream — which is TRUE
  // but does not make them safe as a path: `.` and `..` are spelled in that
  // charset, so the charset alone never established containment here. What
  // does: t115 made dot-only names unrepresentable at every gate, so no name
  // reaching this join can traverse. If that guard is ever relaxed, this join
  // needs confine() from path-confine.js — it writes, so the cost of being
  // wrong is a stray file, not a delete.
  const dir = path.join(MSG_DIR, recipient);
  ensureDir(dir);
  msgCounter++;
  const fname = `msg-${process.pid}-${msgCounter}.txt`;
  const fpath = path.join(dir, fname);
  const header = `From: ${sender}\nTime: ${new Date().toTimeString().slice(0, 8)}\nSize: ${body.length} bytes\n\n`;
  fs.writeFileSync(fpath, header + body);
  return fpath;
}


const { createSessionManager } = require('./session-manager');

const { createPluginHostEngine } = require('./plugin-host-engine');
const { pluginsEnabled } = require('./plugin-api');
const gitWorktree = require('./git-worktree');
// Phase 2: discovery + the enabled set. Declared beside the host because
// setEnabled reaches it through a getter — the loader is constructed AFTER the
// host (it takes no host argument; loadAll receives one), so a captured value
// would be null for the app's whole life. Same getter discipline as every other
// bootstrap-assigned seam.
const { createPluginLoader } = require('./plugin-loader');
let pluginHost = null;
let pluginLoader = null;



const SessionManager = createSessionManager({
    AGENT_NAME_RE,
    COMPACT_CONTINUATION_DELAY,
    COMPACT_INFLIGHT_TIMEOUT,
    DEFAULT_COMPACT_CONTINUATION,
    DEFAULT_WORKSPACE_ID,
    INJECT_BOOT_MAXWAIT,
    INJECT_HOLD_TIMEOUT,
    INJECT_QUIET_MAXWAIT,
    INJECT_QUIET_MS,
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
    SELF_LABEL,
    SHORT_TEXT_DELAY,
    Transport,
    WIRE_INTENTS_LIVE,
    WIRE_SHADOW,
    BUILTIN_AGENTS,
    buildAgentsArg,
    buildIpcPrompt,
    childProcess: require('child_process'),
    claimParkedById,
    classifyNotification,
    cleanupClaudeHook,
    cleanupCodexHook,
    cleanupSkillPlugin,
    effectiveInjectedSkills,
    unresolvedSubagentRefs,
    codexStatusLineArg,
    collectSystemDiagnostics,
    composeDigest,
    digestTiers,
    ctxReminderFor,
    bakePrompt,
    promptCacheDir,
    diagSummary,
    diagWarning,
    draftChunkSignal,
    drainPending,
    countPending,
    peekPending,
    enqueueOutbox,
    ensureDir,
    execBodyCap: DEFAULT_MAX_BYTES, // exec JSON-terminator capture cap (session-manager)
    findProjectRoot,
    resolveTeam,
    createTeam,
    addRole,
    listTeams,
    setRole,
    removeRole,
    renameRole,
    setTeamWatchdog,
    fs,
    hasActivePending,
    bodyModeFor,
    intentEnabledFor,
    pluginGrammarLines,
    pluginRowFor,
    validIntentNames,
    intentEnabled,
    withoutPrivilegedIntentsFor,
    isAlive,
    isDigested,
    isDraftOpen,
    isFilenameToken,
    isHumanPtyInput,
    isInjectInFlight,
    canFireCompact,
    lastTranscriptWrite,
    log,
    memoryStore,
    memoryLoad,
    hintArm,
    mergeClaudeSystemPrompt,
    mergeCodexInstructions,
    normalizeProxyBase,
    noteFileTouches,
    os,
    outboxHasOrigin,
    parkDelivery,
    parkIdInUse,
    fencedLines,
    looksLikeIntent,
    parseAndValidate,
    parseCtxFile,
    parseIntent,
    parseRemindSpec,
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
  getPersistence: () => persistence,
  getTemplates: () => templates,
  getUiSettings: () => uiSettings,
  getEnvScopes: () => envScopes,
  getPromptLibrary: () => promptLibrary,
  getAgentLibrary: () => agentLibrary,
  getRemoteServer: () => remoteServer,
  getPeerManager: () => peerManager,
  getRemindScheduler: () => remindScheduler,
  getNotifications: () => notifications,
  getUserDataPath: () => userDataPath,
  openPath,
  notifyOS,
  setAppQuitting,
  relaunchApp: restartHost,
  getPluginHooks: () => (pluginHost ? pluginHost.hooks : null),
});
const manager = new SessionManager();
const proxyPoller = new ProxyPoller(manager);
manager._proxyPoller = proxyPoller;




async function fetchProxyContext(name, opts) {
  const s = manager.sessions.get(name);
  if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
  const snap = proxyPoller.snapshot(name);
  if (!snap || !snap.linked || !snap.sessionId) {
    return { ok: false, error: 'No live proxy session (unlinked)' };
  }
  const wantUtil = !!(opts && opts.utilization);
  try {
    let q = `/_context?session=${encodeURIComponent(snap.sessionId)}`;
    if (wantUtil) q += '&utilization=1';
    const r = await ProxyClient._getJson(s.proxyBase, q, wantUtil ? PROXY_REPORT_TIMEOUT : undefined);
    if (r.status !== 200 || !r.json) return { ok: false, error: `proxy returned ${r.status}` };
    return { ok: true, data: r.json };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg === 'timeout') {
      return { ok: false, error: wantUtil
        ? `proxy /_context utilization scan timed out after ${PROXY_REPORT_TIMEOUT}ms`
        : 'proxy /_context timed out' };
    }
    return { ok: false, error: msg };
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

// Dropping base/sessionId/capabilities is load-bearing: it is what makes the
// viewer's owner-local controls degrade to plain text instead of firing requests
// at endpoints that exist only on the owner's machine.
function peerProxyView(p) {
  if (!p) return null;
  const caps = p.capabilities || {};
  const queries = [];
  if (caps.context_composition || caps.context_view || caps.context_utilization) queries.push('ctx');
  if (caps.context_timeline && p.base && p.sessionId) queries.push('cost');
  if (p.base && p.sessionId) queries.push('bust');
  if (caps.context_report && p.base && p.sessionId) queries.push('report');
  const view = {
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
    stripLevel: typeof p.stripLevel === 'number' ? p.stripLevel : 0,
    queries,
  };
  const box = boxWirescopeView(p, process.env.CLODEX_WIRESCOPE_PUBLIC_URL);
  if (box) { view.base = box.base; view.sessionId = box.sessionId; }
  return view;
}

// kill() only signals; the slot frees in the PTY's onExit (SIGKILL fallback at
// 5s). A fixed sleep here raced it into "session already exists" on respawn.
async function waitForSessionExit(name, timeoutMs = 8000) {
  const start = Date.now();
  while (manager.sessions.has(name) && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  return !manager.sessions.has(name);
}


async function restartSession(name, opts = {}, wsId = DEFAULT_WORKSPACE_ID) {
  const entry = persistence.get(name);
  if (!entry) return { ok: false, error: 'Session not found in persistence' };
// A skill change needs `fresh`: the roster is evaluated when a CONVERSATION is
// created, so --resume replays the roster frozen before the change.
// opts.resumeId switches to a past conversation and becomes the active id.
  if (opts && opts.resumeId && opts.resumeId !== entry.sessionId) {
    persistence.setSessionId(name, opts.resumeId);
  }
  const resumeId = opts && opts.fresh ? null : ((opts && opts.resumeId) || entry.sessionId || null);
  try {
    if (manager.sessions.has(name)) {
      await manager.kill(name);
      if (!await waitForSessionExit(name)) throw new Error('old process did not exit in time');
    }
// Re-seed post-create fields BEFORE create() reads existingEntry (kill() dropped
// the record). rosterSentAt is conversation-scoped, so a FRESH restart must NOT
// carry it. createdAt is birth time and must carry across every restart —
// create() falls back to Date.now(), re-minting it and reordering "created" sort.
    const preserveFields = ['ephemeral', 'reviewFor', 'createdAt'];
    if (!(opts && opts.fresh)) preserveFields.push('rosterSentAt');
    manager._preserveAcrossRestart(name, entry, preserveFields);
    const created = await manager.create(name, entry.type, entry.cwd, entry.extraArgs || [], resumeId, wsId, entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [], entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [], entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [], Array.isArray(entry.execCommands) ? entry.execCommands : [], Array.isArray(entry.intents) ? entry.intents : null, (entry.env && typeof entry.env === 'object') ? entry.env : null);
    // kill() removed the persistence entry (incl. stripLevel) and create()
    // re-wrote it from spawn args only — re-assert the session's OWN level so
    // a restart doesn't silently turn stripping off. (Birth-time agentDefaults
    // seeding lives in session:create; this preserves the actual level.)
    const restartLvl = stripLevelOf(entry);
    if (restartLvl >= 1) persistence.setStripLevel(name, restartLvl);
    if (entry.label) persistence.setLabel(name, entry.label);
    return { ok: true, restarted: true, backend: created.backend || null };
  } catch (err) {
    persistence.upsert(entry);
    return { ok: false, error: `${err.message} — session kept; it will respawn on next workspace open.` };
  }
}

const readCtxFor = (name) => {
  try {
    const c = parseCtxFile(fs.readFileSync(pathFor(REGISTRY_DIR, name, 'ctx'), 'utf-8'));
    return { ctx: c.pct, ctxTok: c.tok, ctxSize: c.size, ctxCost: c.cost, ctxModel: c.modelName };
  } catch { return { ctx: null, ctxTok: null, ctxSize: null, ctxCost: null, ctxModel: null }; }
};

async function restoreSessionsForWorkspace(workspaceId) {
  const restored = await restoreSessionsCore({
    workspaceId, persistence, manager, proxyPoller,
    maybeCompactBeforeResume, readCtxFor, log,
  });
  try { manager.maybeDeliverRebootNotice(); } catch (e) { log.error('intent', `reboot notice delivery failed: ${e.message}`); }
  return restored;
}

function sessionScopeCtx(name) {
  const entry = persistence.get(name);
  const wsId = (entry && entry.workspaceId) || DEFAULT_WORKSPACE_ID;
  const ws = workspaces.get(wsId);
  return { session: name, workspace: (ws && ws.name) || null };
}

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
    intents: Array.isArray(entry.intents) ? entry.intents : null, // gate allowlist (null = all-enabled)
    execCommands: Array.isArray(entry.execCommands) ? entry.execCommands : [], // exec GRANT allowlist (local-only; stripped at the peer wire)
    env: (entry.env && typeof entry.env === 'object') ? entry.env : {}, // per-session env (T46b; local-only, stripped at the peer wire)
    agentCatalog: agentLibrary.listFor(sessionScopeCtx(name)), // scope-filtered offer list
    stripLevel: stripLevelOf(entry),
  } : { ok: false };
}

async function applySessionArgs(name, patch = {}, wsId = DEFAULT_WORKSPACE_ID) {
  const { extraArgs, restart, proxy } = patch;
  const beforeKill = persistence.get(name);
  const {
    agents: nextAgents, denyBuiltins: nextDeny, disabledTools: nextTools,
    disabledSkills: nextSkills, injectSkills: nextInject,
    systemPrompt: nextInline, systemPromptFile: nextSysFile, appendPromptFiles: nextAppend,
    intents: nextIntents, execCommands: nextExec, env: nextEnv,
  } = resolveSessionArgsPatch(patch, beforeKill);
  persistence.setExtraArgs(name, extraArgs);
  persistence.setProxy(name, proxy ?? null);
  persistence.setSystemPrompt(name, nextInline);
  persistence.setPromptRefs(name, nextSysFile, nextAppend);
  persistence.setAgents(name, nextAgents, nextDeny);
  persistence.setDisabledTools(name, nextTools);
  persistence.setDisabledSkills(name, nextSkills);
  persistence.setInjectSkills(name, nextInject);
  persistence.setIntents(name, nextIntents);
  persistence.setExecCommands(name, nextExec);
  persistence.setEnv(name, nextEnv);
  if (!restart) return { ok: true, restarted: false };
  if (!beforeKill) return { ok: false, error: 'Session not found in persistence' };
  try {
    if (manager.sessions.has(name)) {
      await manager.kill(name);
      if (!await waitForSessionExit(name)) throw new Error('old process did not exit in time');
    }
    manager._preserveAcrossRestart(name, beforeKill, ['rosterSentAt', 'ephemeral', 'reviewFor', 'createdAt']);
    const created = await manager.create(name, beforeKill.type, beforeKill.cwd, extraArgs, beforeKill.sessionId || null, wsId, nextInline, false, proxy ?? null, nextAgents, nextDeny, nextTools, nextSkills, nextInject, nextSysFile, nextAppend, Array.isArray(beforeKill.execCommands) ? beforeKill.execCommands : [], nextIntents, (nextEnv && Object.keys(nextEnv).length) ? nextEnv : null);
    const argsLvl = stripLevelOf(beforeKill);
    if (argsLvl >= 1) persistence.setStripLevel(name, argsLvl);
    if (beforeKill.label) persistence.setLabel(name, beforeKill.label);
    return { ok: true, restarted: true, backend: created.backend || null };
  } catch (err) {
    persistence.upsert({ ...beforeKill, extraArgs, proxy: proxy ?? null, systemPrompt: nextInline, systemPromptFile: nextSysFile, appendPromptFiles: nextAppend, agents: nextAgents, denyBuiltins: nextDeny, disabledTools: nextTools, disabledSkills: nextSkills, injectSkills: nextInject, intents: Array.isArray(nextIntents) ? nextIntents : undefined, env: (nextEnv && Object.keys(nextEnv).length) ? nextEnv : undefined });
    return { ok: false, error: `${err.message} — session kept; it will respawn on next workspace open.` };
  }
}

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

function applySessionSkills(name, disabledSkills, injectSkills) {
  if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
  persistence.setDisabledSkills(name, Array.isArray(disabledSkills) ? disabledSkills : []);
  if (injectSkills !== undefined) persistence.setInjectSkills(name, Array.isArray(injectSkills) ? injectSkills : []);
  return { ok: true };
}


const { createRemoteWiring } = require('./remote-wiring');
const { readRemoteEnvToken, writeRemoteEnvToken, hasRemoteEnvToken, resolveRemoteToken } = require('./remote-token');
const { syncRemoteServer, refreshRemoteToken } = createRemoteWiring({
  path, fs, os, log,
  DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, REGISTRY_DIR, OUTBOX_DIR, SELF_LABEL,
  parseCtxFile, jsonlToMessages, ensureDir, homeRelativize,
  claimOutbox, listOutboxOrigins,
  manager, proxyPoller,
  restartClodex: restartHost, restartSession, peerProxyView,
  fetchProxyContext, fetchProxyReport, fetchProxyBust,
  fetchSessionFiles, fetchFilePeek, fetchFileDiff,
  readSessionArgs, applySessionArgs, CLAUDE_TOOLS,
  readSkillCatalog, applySessionSkills,
  getPromptLibrary: () => promptLibrary,
  getAgentLibrary: () => agentLibrary,
  getSkillLibrary: () => skillLibrary,
  getPersistence: () => persistence,
  getUiSettings: () => uiSettings,
  getWorkspaces: () => workspaces,
  getRemoteServer: () => remoteServer,
  setRemoteServer: (v) => { remoteServer = v; },
  setRemoteError: (v) => { remoteError = v; },
  readRemoteEnvToken: () => readRemoteEnvToken(userDataPath),
  resolveRemoteToken,
  appVersion,
  isPackaged,
  getWebInfo,
});



let peerManager = null;
let tunnelManager = null;
let webTunnelManager = null;
const { createPeerWiring } = require('./peer-wiring');
const {
  forgetPeerAttached, forgetPeerControlled, rememberPeerControlled,
  syncPeerManager, resolvePeerUrls, openPeerWeb, closePeerWeb,
} = createPeerWiring({
  manager, log, SELF_LABEL, scheduleAppMenuRefresh,
  getUiSettings: () => uiSettings,
  getPeerManager: () => peerManager,
  setPeerManager: (v) => { peerManager = v; },
  getTunnelManager: () => tunnelManager,
  setTunnelManager: (v) => { tunnelManager = v; },
  getWebTunnelManager: () => webTunnelManager,
  setWebTunnelManager: (v) => { webTunnelManager = v; },
  openExternal: (url) => openExternalSeam(url),
});

const { createSandboxManager } = require('./sandbox');
const sandboxManager = enableSandbox ? createSandboxManager({
  getUserDataPath: () => userDataPath,
  getUiSettings: () => uiSettings,
  syncPeerManager,
  appVersion,
  isPackaged,
  registryDir: REGISTRY_DIR,
  log,
}) : null;

const { createToolCache } = require('./tool-doctor');
const toolCache = createToolCache({ whichBin });

  const stores = initStores(userDataPath, { log, registryDir: REGISTRY_DIR });
  const { persistence, templates, workspaces, promptLibrary,
    agentDefaults, agentLibrary, skillLibrary, execLibrary, reminders, notifications, uiSettings, envScopes, renameWorkspaceScope } = stores;

  try { materializePotCli({ root: REGISTRY_DIR, srcDir: __dirname, log }); } catch {}
  try { materializeExecScripts({ root: REGISTRY_DIR, srcDir: __dirname, log }); } catch {}

  proxyPoller.start();
  manager.startPendingPoll();
  manager.startTicketWatchdog();


  remindScheduler = createRemindScheduler({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    store: reminders,
    deliver: (agent, id, spec, body) => {
      const prefix = `[${id} ${spec}]`;
      const status = manager._deliverReminder(agent, body ? `${prefix} ${body}` : prefix);
      if (status === 'gone') reminders.remove(id);
    },
  });
  remindScheduler.start();

  log.info('app', `startup — Clodex ${appVersion} engine up (pid ${process.pid})`);



  logStartupDiagnostics();

  if (wirescope.autoStartWanted()) wirescope.start().catch(() => {});

  syncRemoteServer();

  syncPeerManager();

  try {
    for (const box of (sandboxManager ? sandboxManager.list() : [])) {
      const inst = sandboxManager.get(box.id);
      try { if (inst && inst.getConfig().autoStart) inst.up().catch(() => {}); } catch { /* skip this box */ }
    }
  } catch { /* registry read failed — skip autostart */ }

  let wsFails = 0;          // consecutive respawn attempts since last healthy
  let wsNextAttempt = 0;    // epoch ms gate for the next attempt
  const WS_WATCHDOG_INTERVAL = 10000;   // ms between health checks
  const WS_WATCHDOG_BASE = 15000;       // ms first backoff step
  const WS_WATCHDOG_MAX = 300000;       // ms backoff cap
  const wsWatchdogTimer = setInterval(async () => {
    if (!wirescope.autoStartWanted()) { wsFails = 0; wsNextAttempt = 0; return; }
    let st;
    try { st = await wirescope.status(); } catch { return; }
    if (st.state === 'managed' || st.state === 'external') {
      wsFails = 0; wsNextAttempt = 0; return;   // healthy — nothing to do
    }
    if (st.state === 'installing' || st.state === 'starting') return; // mid-launch
    const now = Date.now();
    if (now < wsNextAttempt) return;
    wsFails++;
    wsNextAttempt = now + Math.min(WS_WATCHDOG_BASE * 2 ** (wsFails - 1), WS_WATCHDOG_MAX);
    wirescope.start().catch(() => {});
  }, WS_WATCHDOG_INTERVAL);

  cleanupOldMessages();
  const msgCleanupTimer = setInterval(cleanupOldMessages, MSG_CLEANUP_INTERVAL);
  registry.cleanup();


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

  try { manager.sweepReviewerGraveyard(); } catch (e) { log.info('migrate', `reviewer-graveyard sweep skipped (${e && e.message})`); }

// Constructed at the bootstrap TAIL: stores/manager/wiring exist, no window does,
// and the handle has not returned — so a plugin's activate() runs strictly before
// the renderer-driven restore can create any session.
// CLODEX_PLUGINS=0 skips construction; every hook call site is `?`-guarded.
  if (pluginsEnabled(process.env)) {
    try {
      pluginHost = createPluginHostEngine({
        manager,
        getUiSettings: () => uiSettings,
        log,
        userDataPath,
        fs, path,
        gitWorktree,
        libraryKinds: { memory: (ref) => manager.removeMemoryUnit(ref.agent, ref.id) },
        libraryPinKinds: { memory: (ref, on) => manager.setOperatorPin(ref.agent, ref.id, on) },
        telemetrySnapshot: (name) => proxyPoller.snapshot(name),
        getLoader: () => pluginLoader,
        onPluginStateChanged: () => scheduleAppMenuRefresh(),
      });
      pluginLoader = createPluginLoader({
        fs, path,
        roots: [
          { id: 'core', dir: path.join(__dirname, 'plugins'), label: 'Built in' },
          { id: 'user', dir: path.join(REGISTRY_DIR, 'plugins'), label: 'User' },
        ],
        getUiSettings: () => uiSettings,
        log,
        requireModule: (p) => require(p),
      });
      pluginLoader.loadAll(pluginHost);
    } catch (e) {
      pluginHost = null;
      pluginLoader = null;
      log.info('plugin', `host construction failed, continuing without plugins: ${e && e.message}`);
    }
  } else {
    log.info('plugin', 'CLODEX_PLUGINS=0 — plugin host not constructed');
  }

  let didShutdown = false;
  function shutdown() {
    if (didShutdown) return;
    didShutdown = true;
    setAppQuitting(true);
    try { log.info('app', 'shutdown — engine.shutdown(), killing all sessions'); } catch {}
    try { clearInterval(wsWatchdogTimer); } catch {}
    try { clearInterval(msgCleanupTimer); } catch {}
    try { proxyPoller.stop(); } catch {}
    try { if (remindScheduler) remindScheduler.stop(); } catch {}
    if (remoteServer) { try { remoteServer.stop(); } catch {} remoteServer = null; }
    if (peerManager) { try { peerManager.stopAll(); } catch {} peerManager = null; }
    if (tunnelManager) { try { tunnelManager.stopAll(); } catch {} tunnelManager = null; }
    if (webTunnelManager) { try { webTunnelManager.stopAll(); } catch {} webTunnelManager = null; }
    manager.killAll();
  }

  return {
    manager, stores, syncRemoteServer, syncPeerManager, restoreSessionsForWorkspace, shutdown,
    refreshRemoteToken,
    setRemoteToken: (token) => writeRemoteEnvToken(userDataPath, token),
    hasRemoteToken: () => hasRemoteEnvToken(userDataPath),
    REGISTRY_DIR, proxyPoller, wirescope, ProxyClient, pty,
    getRemoteServer: () => remoteServer,
    getRemoteError: () => remoteError,
    getPeerManager: () => peerManager,
    getTunnelManager: () => tunnelManager,
    getWebTunnelManager: () => webTunnelManager,
    openPeerWeb, closePeerWeb,
    getSandbox: (boxId) => (sandboxManager ? sandboxManager.get(boxId) : null),
    getSandboxManager: () => sandboxManager,
    getPluginHost: () => pluginHost,
    createTeam, addRole, resolveTeam, listTeams, loadManifest,
    setRole, removeRole, renameRole, setTeamWatchdog,
    CLAUDE_SKILLS, CLAUDE_SL_COMPONENTS, CLAUDE_TOOLS, CODEX_SL_COMPONENTS,
    DEPLOY_FIX_INJECT_DELAY_MS, SKILL_REENABLE_CONFIRMED,
    collectSystemDiagnostics, diagSummary, diagWarning,
    checkTools: () => toolCache.get(),
    invalidateToolCache: () => toolCache.invalidate(),
    fetchProxyContext, fetchProxyReport, fetchProxyBust,
    fetchSessionFiles, fetchFilePeek, fetchFileDiff,
    restartSession, waitForSessionExit,
    readSessionArgs, applySessionArgs, readSkillCatalog, applySessionSkills,
    sessionScopeCtx, readEffectiveSkillState, readEffectiveToolState,
    readSessionMeta, sessionMeta, claudeProjectDir, rebuildAllStatusScripts,
    stripLevelOf, updateApplies, jsonlToMarkdown, sshRun,
    probePeer, fixSessionName, buildDeployFixBriefing, classifyDeployFolder, resolveDeployFolder,
    forgetPeerAttached, forgetPeerControlled, rememberPeerControlled,
  };
}

module.exports = { createEngine, diagWarning, sweepSpilledMessages };
