'use strict';

const https = require('https');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { execSync, spawn, execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const pty = require('node-pty');
const { ensureDir, atomicWriteFileSync, readJsonSafe } = require('./fs-util');
const { pathFor, runDirFor, defaultClodexHome, seatPathFor, claudeProjectSlug } = require('./clodex-paths');
const { SEAT_IMAGE_FILE_PATTERN } = require('./seat-images');
const { confine } = require('./path-confine');
const { createSkillDelivery } = require('./skill-delivery');
const { createSkillLister, skillAliases } = require('./muse-skills');
const { adapterFor: adapterRowFor, streamFor } = require('./cli-adapters');
const { KINDS: PROMPT_KINDS, badStem, teamPromptFile, teamJsonFile, readTeamJson } = require('./team-prompt-dir');
const { planGather, applyGather } = require('./team-gather');
const { vetFileWrite, PEEK_MAX_BYTES } = require('./file-edit');
const { peekFile } = require('./file-peek');
const { resolveDisplayedPath, durableMessageCopyOf } = require('./file-resolve');
const { runLegacySweep, findOrphans } = require('./legacy-sweep');
const { migrateSeatLayout } = require('./seat-layout');
const { readVoiceTrigger } = require('./voice-settings');
const { readVoiceCapabilityCached } = require('./voice-capability');
const { createSpeaker, createVoiceCatalog } = require('./speaker');
const { runTicketsMigration } = require('./tickets-migrate');
const { validOrigin } = require('./peer-outbox');
const { materializeExecScripts } = require('./bin-materialize');
const { loadHelpCorpus } = require('./help-corpus');
// Module-level, not inside createEngine: sweepSpilledMessages is module-level and a
// closure require would not be in scope there.
const { allParkedTexts } = require('./pending-store');

function diagWarning(d = {}) {
  const expectedArch = process.arch === 'x64' ? 'x86_64' : process.arch;
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
  if (!d.claude && !d.codex && !d.muse) {
    return 'No agent CLI (claude, codex or muse) was found on PATH — no agent sessions can start. '
      + 'Install one, e.g. curl -fsSL https://claude.ai/install.sh | bash';
  }
  return null;
}

function diagLines(d = {}) {
  const lines = [
    '── Clodex startup diagnostics ──',
    `process:      ${d.platform}/${d.procArch}${d.rosetta ? '  ⚠ Rosetta-translated' : ''}   electron ${d.electron}  node ${d.node}`,
  ];
  if (d.platform === 'darwin') {
    lines.push(`spawn-helper: ${d.helperPath}`);
    lines.push(`              exists=${d.helperExists} executable=${d.helperExecutable} arch=${d.helperArch}`);
  }
  lines.push(
    `claude:       ${d.claude || 'NOT FOUND on PATH'}`,
    `codex:        ${d.codex || 'NOT FOUND on PATH'}`,
    `muse:         ${d.muse || 'NOT FOUND on PATH'}`,
  );
  const warning = diagWarning(d);
  if (warning) lines.push(`⚠ ${warning}`);
  return lines;
}

const SPILL_NAME_RE = new RegExp(`msg-\\d+-\\d+\\.txt|${SEAT_IMAGE_FILE_PATTERN}`, 'g');
const SEAT_IMAGE_FILE_RE = new RegExp(`^${SEAT_IMAGE_FILE_PATTERN}$`);
const IMG_MAX_AGE = 24 * 3600;
const MSG_MAX_AGE = 1800;

function referencedSpillNames(pendingDir) {
  const refs = new Set();
  for (const text of allParkedTexts(pendingDir)) {
    for (const m of text.match(SPILL_NAME_RE) || []) refs.add(m);
  }
  return refs;
}

function linksToSeatDir(linkPath, seatPath) {
  try {
    const real = fs.realpathSync(linkPath);
    return fs.statSync(real).isDirectory() && real === fs.realpathSync(seatPath);
  } catch { return false; }
}

function sweepSpilledMessages(msgDir, pendingDir, maxAgeSec, now = Date.now(), imgMaxAgeSec = maxAgeSec) {
  if (!fs.existsSync(msgDir)) return;
  const referenced = referencedSpillNames(pendingDir);
  for (const entry of fs.readdirSync(msgDir, { withFileTypes: true })) {
    try {
      const epath = path.join(msgDir, entry.name);
      const linkToSeat = entry.isSymbolicLink()
        && linksToSeatDir(epath, seatPathFor(path.dirname(msgDir), entry.name, 'messages'));
      if (entry.isDirectory() || linkToSeat) {
        for (const fname of fs.readdirSync(epath)) {
          try {
            if (referenced.has(fname)) continue;
            const fpath = path.join(epath, fname);
            const limit = SEAT_IMAGE_FILE_RE.test(fname) ? imgMaxAgeSec : maxAgeSec;
            if ((now - fs.statSync(fpath).mtimeMs) / 1000 > limit) fs.unlinkSync(fpath);
          } catch {}
        }
      } else if (!referenced.has(entry.name)
          && (now - fs.statSync(epath).mtimeMs) / 1000 > maxAgeSec) {
        fs.unlinkSync(epath);
      }
    } catch {}
  }
}

function sweepSeatMessages(msgDir, pendingDir, now = Date.now()) {
  sweepSpilledMessages(msgDir, pendingDir, MSG_MAX_AGE, now, IMG_MAX_AGE);
}

function resolveRegistryDir(seams) {
  if (seams && seams.registryDir) return seams.registryDir;
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error(
      'createEngine: refusing to resolve the real ~/.clodex under node --test — '
      + 'pass seams.registryDir (see t359)');
  }
  return defaultClodexHome();
}

function resolveSelfLabel(env, hostname, log) {
  const fallback = String(hostname || '').replace(/\.local$/, '');
  const raw = env ? env.CLODEX_LABEL : undefined;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return fallback;
  if (!validOrigin(trimmed)) {
    if (log && typeof log.warn === 'function') {
      log.warn('peer', `CLODEX_LABEL ${JSON.stringify(trimmed)} is not a usable wire label; using ${fallback}`);
    }
    return fallback;
  }
  return trimmed;
}

function createEngine({ userDataPath, seams = {}, log }) {
  const openPath = seams.openPath || (() => {});
  const openExternalSeam = seams.openExternal || ((url) => { log.info('seam', `openExternal (no host browser): ${String(url).split(/[?#]/)[0]}`); });
  const notifyOS = seams.notifyOS || (() => {});
  const setAppQuitting = seams.setAppQuitting || (() => {});
  const appVersion = seams.appVersion || require('./package.json').version;
  const isPackaged = seams.isPackaged || (() => false);
  const refreshAppMenu = seams.refreshAppMenu || (() => {});
  const scheduleAppMenuRefresh = seams.scheduleAppMenuRefresh || (() => {});
  const refreshTrayMenu = seams.refreshTrayMenu || (() => {});
  const scheduleTrayRefresh = seams.scheduleTrayRefresh || (() => {});
  const restartHost = seams.restartHost || (() => {});
  // Separate from restartHost: a human pressing a control restarts immediately, while
  // [agent:reboot] fires mid-turn and waits for the seats to settle.
  const restartHostWhenIdle = seams.restartHostWhenIdle || restartHost;
  const restartUnavailable = seams.restartUnavailable || (() => null);
  const pathMergeFailed = !!seams.pathMergeFailed;
  // Granted on a headless host too: that hands `sandbox:*` (docker and container
  // lifecycle on this box) to a web client.
  const enableSandbox = seams.enableSandbox !== false;
  // Desktop-only, and this flag is the boundary, not the renderer's `available()`:
  // web-host.js dispatches any registered channel by name without consulting api-contract.
  const enableDrawerServices = seams.enableDrawerServices !== false;
  const enableCtl = seams.enableCtl !== false;
  // Split off enableDrawerServices and defaults ON: `wterm:*` spawns `$SHELL` on this box, which
  // the ungated `session:create` (type 'bash') already reaches. Still gates the pty service.
  const enableLocalTerminal = seams.enableLocalTerminal !== false;

  const enableConsole = seams.enableConsole !== false;

  const enableAccounts = seams.enableAccounts !== false;

  // A getter: web-host.js starts after createEngine returns, so nothing exists to pass now.
  // Electron omits the seam and reports null (no web host).
  const getWebInfo = seams.webInfo || (() => null);

  const logFile = seams.logFile || null;

  const noSeed = !!seams.noSeed;
  if (noSeed && !process.env.NODE_TEST_CONTEXT) throw new Error('createEngine: seams.noSeed is a test seam');

  const REGISTRY_DIR = resolveRegistryDir(seams);



// node-pty's "posix_spawnp failed." is its spawn-helper failing (usually an arch mismatch),
// not claude/codex, so a successful `which claude` proves nothing.

function whichBin(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/')) { try { fs.accessSync(cmd, fs.constants.X_OK); return fs.statSync(cmd).isFile() ? cmd : null; } catch { return null; } }
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
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
    if (le === 0xfeedfacf) {
      const cpu = buf.readUInt32LE(4);
      if (cpu === 0x0100000c) return 'arm64';
      if (cpu === 0x01000007) return 'x86_64';
      return `cputype 0x${cpu.toString(16)}`;
    }
    if (le === 0xfeedface) return '32-bit';
    return 'not Mach-O';
  } catch (e) { return `unreadable (${e.code || e.message})`; }
}

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
    claude: whichBin('claude'), codex: whichBin('codex'), muse: whichBin('muse'),
    pathMergeFailed,
    helperPath: helper, helperExists: fs.existsSync(helper),
    helperExecutable, helperArch: machoArch(helper),
  };
}

function diagSummary(d = collectSystemDiagnostics()) {
  return `proc=${d.platform}/${d.procArch}${d.rosetta ? '(rosetta)' : ''} helper=${d.helperArch} `
    + `electron=${d.electron} node=${d.node}`;
}


function logStartupDiagnostics(d = collectSystemDiagnostics()) {
  console.log(diagLines(d).join('\n'));
  return d;
}


const MSG_DIR = path.join(REGISTRY_DIR, 'messages');
const PENDING_DIR = path.join(REGISTRY_DIR, 'pending');
const OUTBOX_DIR = path.join(REGISTRY_DIR, 'peer-outbox');
const SELF_LABEL = resolveSelfLabel(process.env, os.hostname(), log);
const MAX_MSG = 65536;
const MSG_SPILL_THRESHOLD = 500;
const MSG_CLEANUP_INTERVAL = 5 * 60 * 1000;
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
// Short because the quiet gate applies to every inject; MAXWAIT is only the
// walked-away-draft fallback (at 30s it spliced live composition mid-word).
const INJECT_QUIET_MS = 2 * 1000;
const INJECT_QUIET_MAXWAIT = 5 * 60 * 1000;
// First inject into a fresh claude seat waits for the mode-2004 readiness edge plus
// BOOT_DRAIN_SETTLE_MS: text+Enter written before readline is up reads as one paste.
const INJECT_BOOT_MAXWAIT = 20 * 1000;
// A staleness bound on the renderer's 300ms recorder-lit poll: it must clear several missed
// polls and stay well above INJECT_QUIET_MS (a pause between words outlasts one between keys).
const INJECT_SPEAKING_STALE_MS = 3 * 1000;
// Staleness expiry for the dictated-draft sample, above the speaking window because re-reading
// a transcription takes minutes; INJECT_QUIET_MAXWAIT still bounds the park it gates.
const INJECT_VOICE_DRAFT_STALE_MS = 10 * 1000;



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




function pluginBundles() {
  if (!pluginHost || typeof pluginHost.bundles !== 'function') return [];
  try { return pluginHost.bundles() || []; } catch { return []; }
}

function teamOwnBody(team, kind, stem) {
  const own = teamPromptFile({ fs, path }, team, kind, stem);
  if (!own) return null;
  try { return fs.readFileSync(own, 'utf-8'); }
  catch { return null; }
}

function resolveSystemPromptFile(stem, seatPlugins, team) {
  if (!stem) return null;
  const ref = splitPluginPromptRef(stem);
  if (ref) {
    return resolvePluginSystemPromptFile({ fs, path, bundles: pluginBundles() }, ref, seatPlugins);
  }
  const own = teamPromptFile({ fs, path }, team, 'system', stem);
  if (own) return own;
  const p = promptLibrary._file('system', stem);
  try { fs.accessSync(p, fs.constants.R_OK); return p; }
  catch { return null; }
}

function readAppendBodies(stems, seatPlugins, team) {
  const out = [];
  for (const stem of stems || []) {
    const ref = splitPluginPromptRef(stem);
    const body = ref
      ? resolvePluginPromptBody({ bundles: pluginBundles() }, ref, 'append', seatPlugins)
      : (teamOwnBody(team, 'append', stem) ?? promptLibrary.raw('append', stem));
    if (body != null && body.trim()) out.push(body);
  }
  return out;
}

function readSystemPromptBody(stem, seatPlugins, team) {
  if (!stem) return null;
  const ref = splitPluginPromptRef(stem);
  if (ref) return resolvePluginPromptBody({ bundles: pluginBundles() }, ref, 'system', seatPlugins);
  return teamOwnBody(team, 'system', stem) ?? promptLibrary.raw('system', stem);
}

function teamTemplateStems(team) {
  let files;
  try { files = fs.readdirSync(path.join(teamsDir, team, 'templates')); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((stem) => !badStem(stem))
    .sort();
}

function teamTemplateRows() {
  const rows = [];
  const shadows = new Map();
  let names;
  try { names = listTeams(); } catch { return { rows, shadows }; }
  for (const team of names) {
    const dir = path.join(teamsDir, team);
    for (const stem of teamTemplateStems(team)) {
      const id = `team:${team}:${stem}`;
      const body = readTeamJson({ fs, path }, { dir }, 'templates', stem);
      rows.push(body
        ? { ...body, name: stem, id, team, teamName: team }
        : { name: stem, id, team, teamName: team, unreadable: true });
      if (!shadows.has(stem)) shadows.set(stem, []);
      shadows.get(stem).push(team);
    }
  }
  return { rows, shadows };
}

function listAllTemplates() {
  const { rows, shadows } = teamTemplateRows();
  const library = templates.list().map((t) => (
    shadows.has(t.name) ? { ...t, shadowedBy: shadows.get(t.name) } : t
  ));
  return [...library, ...pluginTemplateRows(pluginBundles()), ...rows];
}

function teamPromptStems(team, kind) {
  let files;
  try { files = fs.readdirSync(path.join(teamsDir, team, 'prompts', kind)); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length))
    .filter((stem) => !badStem(stem))
    .sort();
}

function teamPromptRows(kind) {
  const kinds = kind ? (PROMPT_KINDS.includes(kind) ? [kind] : []) : PROMPT_KINDS;
  const rows = [];
  const shadows = new Map();
  let names;
  try { names = listTeams(); } catch { return { rows, shadows }; }
  for (const team of names) {
    for (const k of kinds) {
      for (const stem of teamPromptStems(team, k)) {
        const id = `team:${team}:${k}:${stem}`;
        const file = teamPromptFile({ fs, path }, { dir: path.join(teamsDir, team) }, k, stem);
        let body = null;
        if (file) {
          try { body = fs.readFileSync(file, 'utf-8'); } catch { body = null; }
        }
        rows.push(body == null
          ? { name: stem, kind: k, body: '', id, team, teamName: team, unreadable: true }
          : { name: stem, kind: k, body, file: `${stem}.md`, id, team, teamName: team });
        const key = `${k}:${stem}`;
        if (!shadows.has(key)) shadows.set(key, []);
        shadows.get(key).push(team);
      }
    }
  }
  return { rows, shadows };
}

function listAllPrompts(kind) {
  const { rows, shadows } = teamPromptRows(kind);
  const library = promptLibrary.list(kind).map((p) => {
    const teams = shadows.get(`${p.kind}:${p.name}`);
    return teams ? { ...p, shadowedBy: teams } : p;
  });
  return [...library, ...rows];
}

function gatherSources(team) {
  return {
    libraryPath: (kind, stem) => {
      try {
        if (kind === 'system' || kind === 'append') return promptLibrary._file(kind, stem);
        if (kind === 'templates') return templates._file(stem);
        return execLibrary._file(stem);
      } catch { return null; }
    },
    readLibrary: (kind, stem) => {
      try {
        if (kind === 'system' || kind === 'append') return promptLibrary.raw(kind, stem);
        if (kind === 'templates') return fs.readFileSync(templates._file(stem), 'utf-8');
        return execLibrary.raw(stem);
      } catch { return null; }
    },
    teamHas: (kind, stem) => (
      (kind === 'system' || kind === 'append')
        ? !!teamPromptFile({ fs, path }, team, kind, stem)
        : !!teamJsonFile({ fs, path }, team, kind, stem)
    ),
    readTemplateForWalk: (stem) => readTeamJson({ fs, path }, team, 'templates', stem) ?? templates._read(stem),
  };
}

function gatherTeam(name, { dry = false } = {}) {
  const team = loadManifest(name);
  const plan = planGather(team, gatherSources(team));
  if (dry) return { team: team.name, dry: true, items: plan.items, copied: [], kept: [], skipped: [], missing: [], failed: [] };
  const result = applyGather(plan, {
    write: (to, bytes) => { ensureDir(path.dirname(to)); atomicWriteFileSync(to, bytes); },
  });
  return { team: team.name, dry: false, items: plan.items, ...result };
}


const MEMORY_DIR = path.join(REGISTRY_DIR, 'library', 'memory');
const { createMemoryStore, composeDigest, digestTiers } = require('./memory-store');
const memoryStore = createMemoryStore(MEMORY_DIR);
const { createMemoryLoad } = require('./memory-load');
// Sibling of library/memory, not a child: entries under it enumerate as agents.
const memoryLoad = createMemoryLoad({ logDir: path.join(REGISTRY_DIR, 'library', 'memory-loadlog') });

const { createHintArm } = require('./hint-arm');
const { createVoiceOriginArm } = require('./voice-origin-arm');
const { createSelectionArm } = require('./selection-arm');
const {
  createMemoryRetriever, createCommonRetriever, createCompositeRetriever,
  compose: composeHint, terms: hintTerms, unitsAsRecords, personalAsk,
  selectWithinBudget: selectHintsWithinBudget, withSharedTerm: withSharedHintTerm,
} = require('./hint-retrieve');

const commonMemoryStore = createMemoryStore(path.join(REGISTRY_DIR, 'library', 'common-memory'));

const {
  createEmbedder, createVectorCache, createSemanticRanker, keyOf: embedKeyOf,
} = require('./hint-embed');
// Semantic ranking only reorders what the lexical gate already armed; it must
// not become the gate.
const semanticRanker = createSemanticRanker({
  // Both stores ranked as one list: cosine is per-pair, unlike the lexical
  // retriever whose corpus-relative floor forces separate stores.
  listRecords: (agent) => [
    ...unitsAsRecords(memoryStore.list(agent)),
    ...unitsAsRecords(commonMemoryStore.list('chat-extract'), 'common'),
  ],
  embedder: createEmbedder({ log }),
  cache: createVectorCache({ file: path.join(REGISTRY_DIR, 'library', 'memory-vectors.json') }),
  // One cache file serves every agent, so the GC needs every agent's keys.
  liveKeys: () => {
    const all = [...unitsAsRecords(commonMemoryStore.list('chat-extract'), 'common')];
    for (const a of memoryStore.agents()) all.push(...unitsAsRecords(memoryStore.list(a)));
    return new Set(all.map(embedKeyOf));
  },
  log,
});

const commonMemoryRecall = (arg) => commonMemoryStore.recall('chat-extract', arg);

const hintArm = createHintArm({
  // A getter, not a construction-time value: the Preferences checkbox applies on
  // the next keystroke rather than the next launch.
  enabled: () => !!uiSettings.get().contextHints,
  retriever: createCompositeRetriever([
    createMemoryRetriever({ listUnits: (agent) => memoryStore.list(agent) }),
    createCommonRetriever({ listUnits: (set) => commonMemoryStore.list(set) }),
  ]),
  // Read per call, never captured, same as `enabled`.
  semantic: {
    rank: (draft, opts) => (uiSettings.get().semanticHints
      ? semanticRanker.rank(draft, opts)
      : Promise.resolve(null)),
  },
  compose: composeHint,
  selectWithinBudget: selectHintsWithinBudget,
  terms: hintTerms,
  personalAsk,
  withSharedTerm: withSharedHintTerm,
  loadState: (agent, id) => memoryLoad.stateOf(agent, id),
  armHints: ({ base, route, id, text, ttl_s, turn_start_only, once }) =>
    ProxyClient.armHints(base, route, [{ id, text, ttl_s, turn_start_only, once }]),
  clearHints: ({ base, route, id }) => ProxyClient.clearHints(base, route, id),
  log,
});

// Own id on the shared register: two ids coexist on one route (armHints merges),
// so this cannot clear the contextual hint the operator's typing arms.
const voiceOriginArm = createVoiceOriginArm({
  armHints: ({ base, route, id, text, ttl_s, turn_start_only, once }) =>
    ProxyClient.armHints(base, route, [{ id, text, ttl_s, turn_start_only, once }]),
  clearHints: ({ base, route, id }) => ProxyClient.clearHints(base, route, id),
  log,
});

// A separate pref from contextHints: folding them would let the memory checkbox
// start sending highlighted screen content.
const selectionArm = createSelectionArm({
  enabled: () => !!uiSettings.get().selectionHints,
  // Resolved per call: `ctlService` is declared far below, so it is read through the closure.
  scrubber: () => (ctlService && ctlService.scrubber ? ctlService.scrubber() : null),
  armHints: ({ base, route, hint }) => ProxyClient.armHints(base, route, [hint]),
  clearHints: ({ base, route, id }) => ProxyClient.clearHints(base, route, id),
  // Same endpoint the arm writes to, so the popover cannot show another registry.
  readHints: ({ base, route }) => ProxyClient.readHints(base, route),
  // Append, never write: a second click between submits must not replace the first.
  queue: ({ name, text }) => {
    fs.appendFileSync(pathFor(REGISTRY_DIR, name, 'selection'), `${JSON.stringify({ text })}\n`);
  },
  readQueue: ({ name }) => {
    let raw;
    try { raw = fs.readFileSync(pathFor(REGISTRY_DIR, name, 'selection'), 'utf8'); }
    catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && o.text) out.push(o.text); } catch {}
    }
    return out;
  },
  log,
});



const SKILL_PLUGINS_DIR = path.join(REGISTRY_DIR, 'skill-plugins');
const SKILL_PLUGIN_NAME = 'clodex-skills';
// Sibling of skill-plugins, not a subdir: each root is rm -rf'd per spawn, so
// nesting one under the other deletes its dir.
const AGENT_PLUGINS_DIR = path.join(REGISTRY_DIR, 'agent-plugins');



function effectiveInjectedSkills(name, injectSkills) {
  const lib = skillLibrary.list();
  const scoped = lib.map((s) => ({ name: s.name, meta: parseSkillFrontmatter(s.content).meta }));
  const effective = unionEnabled(injectSkills, scoped, name);
  const byName = new Map(lib.map((s) => [s.name, s]));
  return effective.map((n) => byName.get(n)).filter(Boolean);
}

// Must return the set actually scaffolded, not the set requested: the spawn-time
// reference check reads it.
function effectiveInjectedAgents(name, agents) {
  const lib = agentLibrary.list();
  const effective = unionEnabled(agents, lib, name);
  const byName = new Map(lib.map((a) => [a.name, a]));
  return effective.map((n) => byName.get(n)).filter(Boolean);
}

function writeAgentPlugin(name, agents) {
  const records = effectiveInjectedAgents(name, agents);
  const plugin = buildAgentPlugin(records.map((a) => a.name), records, AGENT_PLUGIN_NAME);
  // The recursive rmSync below runs before the no-agents bail, so `dir` must be a
  // confined child: a name of `..` or `../..` would delete ~/.clodex or $HOME.
  const dir = confine(AGENT_PLUGINS_DIR, name);
  if (dir === null) throw new Error(`invalid session name: ${name}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!plugin) return null;
  const manifestDir = path.join(dir, '.claude-plugin');
  ensureDir(manifestDir);
  fs.writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify(plugin.manifest, null, 2), { mode: 0o600 });
  const agentsDir = path.join(dir, 'agents');
  ensureDir(agentsDir);
  for (const a of plugin.agents) {
    fs.writeFileSync(path.join(agentsDir, `${a.name}.md`), a.md, { mode: 0o600 });
  }
  return dir;
}

function cleanupAgentPlugin(name) {
  // Same recursive delete as writeAgentPlugin, so the same confine; a refused
  // name returns silently.
  const dir = confine(AGENT_PLUGINS_DIR, name);
  if (dir === null) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

const BUNDLES_SUBDIR = 'bundles';

function writeBundlePlugins(name, bundles) {
  const seatDir = confine(SKILL_PLUGINS_DIR, name);
  if (seatDir === null) throw new Error(`invalid session name: ${name}`);
  const out = [];
  for (const b of bundles || []) {
    const skillRecords = (b.skills || []).map((s) => ({
      name: s.name, content: s.content, files: (s.files && typeof s.files === 'object') ? s.files : {},
    }));
    const agentRecords = (b.agents || []).map((a) => {
      const { meta, body } = parseAgentFrontmatter(a.content);
      return { name: a.name, meta, body };
    });
    const manifestOpts = {
      version: b.version || '0.0.0',
      description: b.announce || `Clodex plugin ${b.name || b.id}`,
    };
    const skillPlugin = buildSkillPlugin(skillRecords.map((s) => s.name), skillRecords, b.id, manifestOpts);
    const agentPlugin = buildAgentPlugin(agentRecords.map((a) => a.name), agentRecords, b.id, manifestOpts);
    if (!skillPlugin && !agentPlugin) continue;
    const dir = confine(path.join(seatDir, BUNDLES_SUBDIR), b.id);
    if (dir === null) throw new Error(`invalid plugin id: ${b.id}`);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    const manifestDir = path.join(dir, '.claude-plugin');
    ensureDir(manifestDir);
    const manifest = (skillPlugin || agentPlugin).manifest;
    fs.writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const filesOf = new Map(skillRecords.map((s) => [s.name, s.files]));
    for (const s of (skillPlugin ? skillPlugin.skills : [])) {
      const sdir = path.join(dir, 'skills', s.name);
      ensureDir(sdir);
      fs.writeFileSync(path.join(sdir, 'SKILL.md'), s.skillMd, { mode: 0o600 });
      for (const [rel, bytes] of Object.entries(filesOf.get(s.name) || {})) {
        const parts = String(rel).split('/');
        if (!parts.length || !parts.every((p) => AGENT_NAME_RE.test(p))) continue;
        const file = path.join(sdir, ...parts);
        ensureDir(path.dirname(file));
        fs.writeFileSync(file, bytes, { mode: parts[0] === 'scripts' ? 0o700 : 0o600 });
      }
    }
    if (agentPlugin) {
      const agentsDir = path.join(dir, 'agents');
      ensureDir(agentsDir);
      for (const a of agentPlugin.agents) {
        fs.writeFileSync(path.join(agentsDir, `${a.name}.md`), a.md, { mode: 0o600 });
      }
    }
    out.push({
      id: b.id,
      dir,
      skills: skillPlugin ? skillRecords : [],
      agents: agentPlugin ? agentRecords : [],
    });
  }
  return out;
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
const { buildAgentPlugin, parseAgentFrontmatter, qualifiedAgentName, denyAgentRules, BUILTIN_AGENTS, AGENT_PLUGIN_NAME, DROPPED_AGENT_FIELDS } = require('./agents-util');
const { extractFileTouches, noteFileTouches, vetFileIntent } = require('./file-touch');
const { createSubagentStore, noteSubagentTurn, feedSince } = require('./subagent-ring');
const { classifyNotification } = require('./attention');
const { InjectQueue, isInjectInFlight, canFireCompact } = require('./inject-queue');
const { parkDelivery, drainPending, hasPending, hasActivePending, countPending, peekPending, oldestActiveParkTs, parkedTexts, parkIdInUse, claimParkedById, claimParkedByKey } = require('./pending-store');
const { createTeamDelete } = require('./team-delete');
const { createTeamManifest } = require('./team-manifest');
const {
  findProjectRoot, resolveTeam, createTeam, addRole, listTeams, loadManifest,
  setRole, removeRole, renameRole, setTeamWatchdog, setLead, setTeamTrunk, teamsDir, deleteTeam,
  kitCatalog, resolveKit,
  // clodexHome is passed, not defaulted: defaultClodexHome reads CLODEX_HOME and
  // would put teams on a different tree than every other subsystem.
} = createTeamManifest({ fs, clodexHome: REGISTRY_DIR });
const { enqueueOutbox, claimOutbox, outboxKnowsOrigin, markOutboxOrigin, listOutboxOrigins } = require('./peer-outbox');
const { parseIntent, fencedLines, looksLikeIntent, shadowIntentKey } = require('./intent-scanner');
const { intentEnabled } = require('./intent-catalog');
const { bodyModeFor, intentEnabledFor, intentEnabledForSeat, withoutPrivilegedIntentsFor, pluginGrammarLines, pluginRowFor, pruneForPlugins, validIntentNames } = require('./intent-registry');
const { isFilenameToken, parseAndValidate, clampReplyBody, DEFAULT_MAX_BYTES } = require('./exec-schema');
const { parseRemindSpec } = require('./remind-schedule');
const { createRemindScheduler } = require('./remind-scheduler');
const { mergeClaudeSystemPrompt, mergeCodexInstructions, mergeInstructionBodies, parseCtxFile } = require('./argv-merge');
const { renderClaudeStatusScript, codexStatusLineArg, normalizeProxyBase, resolveProxyBase } = require('./statusline');
const { jsonlToMarkdown, cachedMessages, sliceSince, extractText } = require('./transcript');
const { initStores } = require('./stores');
const { createAccounts, sweepAccountMove } = require('./accounts');
const { restoreSessionsForWorkspace: restoreSessionsCore } = require('./session-restore');
const { CLAUDE_TOOLS, CLAUDE_SKILLS, SKILL_REENABLE_CONFIRMED, DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, THEME_KEYS } = require('./catalogs');
const { isSkillDenyDirective } = require('./skills-off');

function randBase36(len) {
  let s = '';
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}
const { ctxReminderFor, ctxThresholdsFor, CTX_THRESHOLD_MIN } = require('./ctx-reminder');
const { bakePrompt, promptCacheDir, readCache, ipcDelta } = require('./ipc-prompt-cache');
const { enqueueNotice, versionNoticeFor, clearNotices } = require('./notice-queue');
const { buildSkillPlugin, skillMd, parseSkillFrontmatter, unresolvedSubagentRefs } = require('./skills-util');
const { classifySkillRoster, emptyRoster, listedRosterNames } = require('./skill-roster');
// Must stay below the skills-util require: the deps read buildSkillPlugin and
// skillMd at construction, and the const destructure is in its TDZ until then.
const skillDelivery = createSkillDelivery({
  fs, path, confine, ensureDir, SKILL_PLUGINS_DIR, SKILL_PLUGIN_NAME, buildSkillPlugin, skillMd, parseSkillFrontmatter,
});
const deliverSkills = (provider, name, records) => skillDelivery.deliver(provider, name, records);
const cleanupSkills = (provider, name) => skillDelivery.cleanup(provider, name);
const skillDeliveryProviders = () => skillDelivery.providers();
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
    // The seed goes in as alwaysInScope so a scoped directory reusing a built-in's
    // name cannot mark the built-in out-of-scope.
    return classifySkillRoster(lines, { alwaysInScope: CLAUDE_SKILLS });
  } catch { return emptyRoster(); }
}

const MANAGED_SETTINGS = {
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
}[process.platform];

function readEffectiveSkillState(cwd) {
  const layers = [
    { src: 'global', file: path.join(os.homedir(), '.claude', 'settings.json') },
    { src: 'project', file: cwd ? path.join(cwd, '.claude', 'settings.json') : null },
    { src: 'local', file: cwd ? path.join(cwd, '.claude', 'settings.local.json') : null },
  ];
  const overrides = {};
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
  if (MANAGED_SETTINGS) {
    const managed = readJsonSafe(MANAGED_SETTINGS);
    const lock = managed && managed.strictPluginOnlyCustomization;
    if (lock === true) skillsLocked = true;
    else if (Array.isArray(lock) && lock.includes('skills')) skillsLocked = true;
  }
  return { overrides, skillsLocked };
}

// Bare tool names only: a scoped entry such as "Bash(rm:*)" denies a slice and
// does not disable the tool.
function readEffectiveToolState(cwd) {
  const layers = [
    { src: 'global', file: path.join(os.homedir(), '.claude', 'settings.json') },
    { src: 'project', file: cwd ? path.join(cwd, '.claude', 'settings.json') : null },
    { src: 'local', file: cwd ? path.join(cwd, '.claude', 'settings.local.json') : null },
  ];
  if (MANAGED_SETTINGS) layers.push({ src: 'policy', file: MANAGED_SETTINGS });
  const overrides = {};
  for (const { src, file } of layers) {
    if (!file) continue;
    const data = readJsonSafe(file);
    const deny = data && data.permissions && data.permissions.deny;
    if (!Array.isArray(deny)) continue;
    for (const entry of deny) {
      if (typeof entry !== 'string' || entry.includes('(')) continue;
      overrides[entry] = { value: 'off', source: src, locked: src === 'policy' };
    }
  }
  return { overrides };
}

function claudeProjectDir(cwd) {
  if (!cwd) return null;
  return path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd));
}

function lastTranscriptWrite(agentType, cwd, sessionId) {
  if (agentType !== 'claude' || !sessionId) return null;
  const dir = claudeProjectDir(cwd);
  if (!dir) return null;
  try { return fs.statSync(path.join(dir, `${sessionId}.jsonl`)).mtimeMs; } catch { return null; }
}

// Not warmth-neutral: a pure-thinking turn survives live-strip but the bake deletes
// it, and the proxy reports warmth only after rewriting, so a gate on it is too late.
async function maybeCompactBeforeResume(entry) {
  try {
    if (!uiSettings.get().compactOnResume) return;
    if (!entry || entry.type !== 'claude' || !entry.sessionId) return;
    const base = resolveProxyBase(entry.proxy, uiSettings);
    if (!base) return;
    // Fire only once the proxy answers /_identity as wirescope: /_compact is
    // wirescope-only and the proxy may not be up yet at restore.
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
  for (const ln of lines) {
    if (!ln.includes('"type":"user"')) continue;
    if (!ln.includes('"tool_result"')) { turns++; continue; }
    let content;
    try { content = JSON.parse(ln).message?.content; } catch { continue; }
    if (Array.isArray(content) && content.length && content.every((b) => b && b.type === 'tool_result')) continue;
    turns++;
  }
  if (!first && !last && !title) return null;
  return { title, first, last, turns };
}

// nodeInterp is the app binary run as Node, baked absolute into every hook so the
// scripts never depend on PATH or an ambient python3 (packaged .app).
const { createCliHooks } = require('./cli-hooks');
const {
  writeClaudeDigestFile, setupClaudeHook, setupCodexHook,
  cleanupClaudeHook, cleanupCodexHook, cleanupMuseSeat,
// composeRoster reaches `manager` lazily and inside a try: this runs before the
// const is declared, so a bare reference at boot is a TDZ throw.
} = createCliHooks({
  REGISTRY_DIR, memoryStore, getUiSettings: () => uiSettings, nodeInterp: process.execPath,
  composeRoster: (name) => { try { return manager.composeRosterFor(name); } catch { return null; } },
});

const { createJsonlWatcher } = require('./jsonl-watcher');
const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR });

const { createBashLive } = require('./bash-live');
const bashLive = createBashLive({ REGISTRY_DIR });

const { createSessionMeta } = require('./session-meta');
const sessionMeta = createSessionMeta({ REGISTRY_DIR });

const { createSessionInfo } = require('./session-info');
const sessionInfo = createSessionInfo({
  fs, readline: require('readline'), homedir: () => os.homedir(),
  pathFor, registryDir: REGISTRY_DIR, userDataPath,
});


let msgCounter = 0;

function cleanupOldMessages() {
  sweepSeatMessages(MSG_DIR, PENDING_DIR);
}

function spillToFile(sender, body, recipient) {
  // Unconfined join, safe only because every name gate rejects dot-only names
  // (the charset alone admits `..`); if that relaxes, this needs confine().
  const dir = path.join(MSG_DIR, recipient);
  ensureDir(dir);
  msgCounter++;
  const fname = `msg-${process.pid}-${msgCounter}.txt`;
  const fpath = path.join(dir, fname);
  const header = `From: ${sender}\nTime: ${new Date().toTimeString().slice(0, 8)}\nSize: ${Buffer.byteLength(body)} bytes\n\n`;
  fs.writeFileSync(fpath, header + body);
  const durable = confine(path.join(REGISTRY_DIR, 'spill'), recipient) && durableMessageCopyOf(fpath, path);
  if (durable) {
    try {
      ensureDir(path.dirname(durable));
      fs.writeFileSync(durable, header + body);
    } catch (e) {
      log.warn('messages', `durable copy of ${fname} for ${recipient} failed: ${e.message}`);
    }
  }
  return fpath;
}


// Required here, not beside createDrawerPtys: the deps object below reads
// `termAvailableFor` eagerly, and a later const destructure is still in its TDZ.
const { termAvailableFor, vetTermCommand, sanitizeName } = require('./drawer-avail');

const { createSessionManager } = require('./session-manager');

const { createPluginHostEngine } = require('./plugin-host-engine');
const { pluginsEnabled } = require('./plugin-api');
const {
  splitPluginPromptRef, resolvePluginSystemPromptFile, resolvePluginPromptBody, pluginTemplateRows,
} = require('./plugin-prompt-refs');
const gitWorktree = require('./git-worktree');
// setEnabled reaches the loader through a getter: it is constructed after the
// host, so a captured value would stay null for the app's life.
const { createPluginLoader } = require('./plugin-loader');
const { createPluginUpdateWatch } = require('./plugin-update-watch');
let pluginHost = null;
let pluginLoader = null;
let pluginUpdateWatch = null;

let helpCorpus = null;
function getHelpCorpus() {
  if (!helpCorpus) helpCorpus = loadHelpCorpus(__dirname);
  return helpCorpus;
}



// One speaker for the whole app: a per-session speaker would let two seats
// finishing together talk over each other.
const speaker = createSpeaker();
// Not warmed here: building the engine must spawn nothing, or every test that
// constructs it forks a real `say -v '?'` that can outlive the test process.
const voiceCatalog = createVoiceCatalog();

const knownSkillNames = () => [...new Set([
  ...CLAUDE_SKILLS,
  ...skillsSeen.list(),
  ...Object.keys(readEffectiveSkillState(null).overrides),
])];

const skillLister = seams.skillLister || createSkillLister({
  execFileSync,
  scratchDir: path.join(os.tmpdir(), 'clodex-skills-list'),
  env: process.env,
  log,
});
const platformSkills = (adapter, opts) => {
  if (!seams.skillLister) { try { ensureDir(path.join(os.tmpdir(), 'clodex-skills-list')); } catch {} }
  return skillLister.list(adapter, opts);
};

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
    INJECT_SPEAKING_STALE_MS,
    speaker,
    INJECT_VOICE_DRAFT_STALE_MS,
    InjectQueue,
    JsonlWatcher,
    LONG_TEXT_DELAY,
    LONG_TEXT_THRESHOLD,
    MSG_DIR,
    MSG_SPILL_THRESHOLD,
    MSG_MAX_AGE,
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
    DROPPED_AGENT_FIELDS,
    qualifiedAgentName,
    buildIpcPrompt,
    childProcess: require('child_process'),
    claimParkedById,
    claimParkedByKey,
    classifyNotification,
    cleanupClaudeHook,
    cleanupCodexHook,
    cleanupMuseSeat,
    crypto,
    cleanupSkills,
    cleanupAgentPlugin,
    effectiveInjectedSkills,
    effectiveInjectedAgents,
    unresolvedSubagentRefs,
    codexStatusLineArg,
    collectSystemDiagnostics,
    composeDigest,
    digestTiers,
    ctxReminderFor,
    ctxThresholdsFor,
    CTX_THRESHOLD_MIN,
    bakePrompt,
    promptCacheDir,
    readCache,
    ipcDelta,
    enqueueNotice,
    versionNoticeFor,
    clearNotices,
    appVersion,
    diagSummary,
    diagWarning,
    draftChunkSignal,
    drainPending,
    countPending,
    oldestActiveParkTs,
    peekPending,
    parkedTexts,
    enqueueOutbox,
    ensureDir,
    execBodyCap: DEFAULT_MAX_BYTES,
    findProjectRoot,
    gitWorktree,
    resolveTeam,
    createTeam,
    kitCatalog,
    resolveKit,
    addRole,
    listTeams,
    loadManifest,
    setRole,
    removeRole,
    renameRole,
    setTeamWatchdog,
    setTeamTrunk,
    setLead,
    teamsDir,
    gatherTeam,
    fs,
    hasActivePending,
    bodyModeFor,
    intentEnabledFor,
    intentEnabledForSeat,
    knownSkillNames,
    platformSkills,
    pluginGrammarLines,
    pluginRowFor,
    validIntentNames,
    intentEnabled,
    withoutPrivilegedIntentsFor,
    isAlive,
    isDigested,
    isDraftOpen,
    isFilenameToken,
    clampReplyBody,
    isHumanPtyInput,
    isInjectInFlight,
    canFireCompact,
    lastTranscriptWrite,
    log,
    memoryStore,
    commonMemoryRecall,
    memoryLoad,
    hintArm,
    selectionArm,
    voiceOriginArm,
    mergeClaudeSystemPrompt,
    mergeCodexInstructions,
    mergeInstructionBodies,
    normalizeProxyBase,
    noteFileTouches,
    createSubagentStore,
    noteSubagentTurn,
    os,
    outboxKnowsOrigin,
    markOutboxOrigin,
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
    termAvailableFor,
    termExec,
    whichBin,
    writeClaudeDigestFile,
    readVoiceCapability: readVoiceCapabilityCached,
    deliverSkills,
    skillDeliveryProviders,
    writeAgentPlugin,
    writeBundlePlugins,
    readSystemPromptBody,
    listAllTemplates,
    listAllPrompts,
    getPluginBundles: () => (pluginHost ? pluginHost.bundles() : []),
  getPersistence: () => persistence,
  getTemplates: () => templates,
  getUiSettings: () => uiSettings,
  getWorkspaces: () => workspaces,
  readCtxFor: (n) => readCtxFor(n),
  getEnvScopes: () => envScopes,
  getAccounts: () => accounts,
  getPromptLibrary: () => promptLibrary,
  getAgentLibrary: () => agentLibrary,
  getRemoteServer: () => remoteServer,
  getPeerManager: () => peerManager,
  getRemindScheduler: () => remindScheduler,
  getReminders: () => reminders,
  getNotifications: () => notifications,
  getSandboxManager: () => sandboxManager,
  getUserDataPath: () => userDataPath,
  openPath,
  notifyOS,
  setAppQuitting,
  relaunchApp: restartHostWhenIdle,
  relaunchUnavailable: restartUnavailable,
  getPluginHooks: () => (pluginHost ? pluginHost.hooks : null),
});
const manager = new SessionManager();
const { deleteCheck: teamDeleteCheck, deleteGated: teamDeleteGated } = createTeamDelete({
  loadManifest, deleteTeam, getManager: () => manager, getSandboxManager: () => sandboxManager, teamsDir,
});
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

const reportCache = new Map();
manager._reportCache = reportCache;

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
  const wantDetail = !!(opts && opts.detail);
  const fallback = (error) => {
    const c = wantDetail ? null : reportCache.get(name);
    return (c && c.sid === snap.sessionId)
      ? { ok: true, data: c.data, at: c.at, stale: true, error }
      : { ok: false, error };
  };
  try {
    let q = `/_report?session=${encodeURIComponent(snap.sessionId)}`;
    if (wantDetail) q += '&detail=1';
    const r = await ProxyClient._getJson(s.proxyBase, q, PROXY_REPORT_TIMEOUT);
    if (r.status !== 200 || !r.json) return fallback(`proxy returned ${r.status}`);
    if (!wantDetail) reportCache.set(name, { data: r.json, at: Date.now(), sid: snap.sessionId });
    return { ok: true, data: r.json };
  } catch (e) {
    return fallback(String((e && e.message) || e));
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
  return { ok: true, cwd: s.cwd || null, files: s.fileTouches || [], filed: s.filedRing ? s.filedRing.list() : [] };
}

function fetchFilePeek(filePath, opts = {}) {
  return peekFile(filePath, opts);
}

function resolveFilePath(name, raw, baseDir) {
  const s = manager.sessions.get(name);
  if (!s) return { ok: false, error: 'Session not running' };
  if (s.peer) return { ok: false, error: 'remote' };
  return resolveDisplayedPath({
    raw, cwd: s.cwd, baseDir: baseDir || null,
    touched: (s.fileTouches || []).map((t) => t && t.path).filter(Boolean),
    home: os.homedir(), path,
    statFile: (p) => fs.statSync(p).isFile(),
  });
}

// Takes a session name because the cwd is the containment boundary; a write with
// no session to confine it is refused, not resolved against the process cwd.
function writeFilePeek(name, filePath, content, expectMtime) {
  const s = manager.sessions.get(name);
  if (!s) return { ok: false, error: 'Session not running' };
  if (s.peer) return { ok: false, error: 'remote' };
  const v = vetFileWrite({
    filePath, cwd: s.cwd, content, expectMtime,
    resolve: path.resolve, realpath: fs.realpathSync, stat: fs.statSync,
    readHead: (p) => {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, 8192, 0);
        return buf.subarray(0, n);
      } finally { fs.closeSync(fd); }
    },
  });
  if (!v.ok) return v;
  try {
    fs.writeFileSync(v.path, content);
    return { ok: true, mtime: Math.trunc(fs.statSync(v.path).mtimeMs), size: Buffer.byteLength(content) };
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
  let diff = await git(['diff', 'HEAD', '--no-color', '--', filePath]);
  if (diff == null) diff = await git(['diff', '--no-color', '--', filePath]);
  if (diff == null) return { ok: false, error: 'git diff failed' };
  return { ok: true, untracked: false, clean: !status.trim(), diff };
}

let remoteServer = null;
let remoteError = null;

// Capabilities and the owner's loopback base/sessionId are dropped so a viewer's
// owner-local controls degrade to plain text instead of hitting owner-only endpoints.
function peerProxyView(p) {
  if (!p) return null;
  const caps = p.capabilities || {};
  const queries = [];
  if (caps.context_composition || caps.context_view || caps.context_utilization) queries.push('ctx');
  if (caps.context_utilization || caps.context_skills) queries.push('ctxScan');
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

// The slot frees in the PTY's onExit (kill's SIGKILL fallback fires at 5s), so
// the default timeout stays above it; a fixed sleep raced "session already exists".
async function waitForSessionExit(name, timeoutMs = 8000) {
  const start = Date.now();
  while (manager.sessions.has(name) && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  return !manager.sessions.has(name);
}


async function restartSession(name, opts = {}, wsId = DEFAULT_WORKSPACE_ID) {
  let entry = persistence.get(name);
  if (!entry) return { ok: false, error: 'Session not found in persistence' };
  if (opts && opts.resumeId && opts.resumeId !== entry.sessionId) {
    persistence.setSessionId(name, opts.resumeId);
    entry = persistence.get(name);
  }
  const resumeId = opts && opts.fresh ? null : ((opts && opts.resumeId) || entry.sessionId || null);
  try {
    if (manager.sessions.has(name)) {
      await manager.kill(name);
      if (!await waitForSessionExit(name)) throw new Error('old process did not exit in time');
    }
    // Re-seed before create() reads existingEntry (kill() dropped the record); a fresh
    // restart must not carry rosterSentAt, and every restart must carry createdAt.
    const preserveFields = ['ephemeral', 'reviewFor', 'reviewTicket', 'createdAt'];
    if (!(opts && opts.fresh)) preserveFields.push('rosterSentAt');
    manager._preserveAcrossRestart(name, entry, preserveFields);
    const created = await manager.create(name, entry.type, manager.resumeCwdOf(entry), entry.extraArgs || [], resumeId, wsId, entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [], entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [], entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [], Array.isArray(entry.execCommands) ? entry.execCommands : [], Array.isArray(entry.intents) ? entry.intents : null, (entry.env && typeof entry.env === 'object') ? entry.env : null, false, entry.noWire === true, Array.isArray(entry.plugins) ? entry.plugins : null, Array.isArray(entry.shellDeny) ? entry.shellDeny : null, typeof entry.fixFor === 'string' ? entry.fixFor : null, entry.io || 'pty', typeof entry.effort === 'string' ? entry.effort : null);
    // create() re-writes the entry from spawn args only, so re-assert the seat's own
    // strip level or a restart silently turns stripping off.
    const restartLvl = stripLevelOf(entry);
    if (restartLvl >= 1) persistence.setStripLevel(name, restartLvl);
    if (entry.label) persistence.setLabel(name, entry.label);
    return { ok: true, restarted: true, backend: created.backend || null, io: created.io || 'pty' };
  } catch (err) {
    // Strip a checkout another seat took mid-restart through the manager; a second
    // tree-occupancy reader here would be a second source of truth.
    persistence.upsert(manager._stripClaimedTree(entry));
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
  try { manager.deliverLostExecRuns(); } catch (e) { log.error('intent', `lost exec run delivery failed: ${e.message}`); }
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
    effectiveTools: readEffectiveToolState(entry.cwd).overrides,
    disabledSkills: entry.disabledSkills || [],
    injectSkills: entry.injectSkills || [],
    intents: Array.isArray(entry.intents) ? entry.intents : null, // gate allowlist (null = all-enabled)
    plugins: Array.isArray(entry.plugins) ? entry.plugins : null,
    execCommands: Array.isArray(entry.execCommands) ? entry.execCommands : [],
    env: (entry.env && typeof entry.env === 'object') ? entry.env : {},
    agentCatalog: agentLibrary.listFor(sessionScopeCtx(name)),
    team: (() => { try { const t = resolveTeam(entry.cwd); return t ? t.name : null; } catch { return null; } })(),
    stripLevel: stripLevelOf(entry),
    io: entry.io === 'stream' ? 'stream' : 'pty',
    effort: (typeof entry.effort === 'string' && entry.effort) ? entry.effort : null,
  } : { ok: false };
}

async function applySessionArgs(name, patch = {}, wsId = DEFAULT_WORKSPACE_ID) {
  const { extraArgs, restart, proxy } = patch;
  const beforeKill = persistence.get(name);
  const {
    agents: nextAgents, denyBuiltins: nextDeny, disabledTools: nextTools,
    disabledSkills: nextSkills, injectSkills: nextInject,
    systemPrompt: nextInline, systemPromptFile: nextSysFile, appendPromptFiles: nextAppend,
    intents: nextIntents, execCommands: nextExec, env: nextEnv, plugins: nextPlugins,
  } = resolveSessionArgsPatch(patch, beforeKill);
  if (!beforeKill) return { ok: false, error: 'Session not found in persistence' };
  persistence.setExtraArgs(name, extraArgs);
  persistence.setProxy(name, proxy ?? null);
  persistence.setSystemPrompt(name, nextInline);
  persistence.setPromptRefs(name, nextSysFile, nextAppend);
  persistence.setAgents(name, nextAgents, nextDeny);
  persistence.setDisabledTools(name, nextTools);
  persistence.setDisabledSkills(name, nextSkills);
  persistence.setInjectSkills(name, nextInject);
  persistence.setPlugins(name, nextPlugins);
  const prunedArgs = pruneForPlugins({ intents: nextIntents, pluginGrants: beforeKill && beforeKill.pluginGrants }, nextPlugins);
  persistence.setIntents(name, Array.isArray(nextIntents) ? prunedArgs.intents : nextIntents);
  if (Array.isArray(beforeKill && beforeKill.pluginGrants)
      && prunedArgs.pluginGrants.length !== beforeKill.pluginGrants.length) {
    persistence.setPluginGrants(name, prunedArgs.pluginGrants);
  }
  persistence.setExecCommands(name, nextExec);
  persistence.setEnv(name, nextEnv);
  const priorIo = (beforeKill && beforeKill.io) || 'pty';
  const nextIo = (patch.io === 'stream' || patch.io === 'pty') && beforeKill && !!streamFor(beforeKill.type)
    ? patch.io : priorIo;
  if (nextIo !== priorIo) persistence.setIo(name, nextIo);
  const priorEffort = (beforeKill && typeof beforeKill.effort === 'string' && beforeKill.effort) ? beforeKill.effort : null;
  const nextEffort = patch.effort === undefined ? priorEffort
    : ((typeof patch.effort === 'string' && patch.effort.trim()) ? patch.effort.trim() : null);
  if (nextEffort !== priorEffort) persistence.setEffort(name, nextEffort);
  if (!restart) return { ok: true, restarted: false };
  const restartIntents = Array.isArray(nextIntents) ? prunedArgs.intents : nextIntents;
  const prunedGrants = (prunedArgs.pluginGrants && prunedArgs.pluginGrants.length)
    ? prunedArgs.pluginGrants : undefined;
  const preservable = Array.isArray(beforeKill.pluginGrants)
    ? { ...beforeKill, pluginGrants: prunedGrants }
    : beforeKill;
  try {
    if (manager.sessions.has(name)) {
      await manager.kill(name);
      if (!await waitForSessionExit(name)) throw new Error('old process did not exit in time');
    }
    manager._preserveAcrossRestart(name, preservable, ['rosterSentAt', 'ephemeral', 'reviewFor', 'reviewTicket', 'createdAt']);
    const created = await manager.create(name, beforeKill.type, manager.resumeCwdOf(beforeKill), extraArgs, beforeKill.sessionId || null, wsId, nextInline, false, proxy ?? null, nextAgents, nextDeny, nextTools, nextSkills, nextInject, nextSysFile, nextAppend, nextExec, restartIntents, (nextEnv && Object.keys(nextEnv).length) ? nextEnv : null, false, beforeKill.noWire === true, nextPlugins, Array.isArray(beforeKill.shellDeny) ? beforeKill.shellDeny : null, typeof beforeKill.fixFor === 'string' ? beforeKill.fixFor : null, nextIo, nextEffort);
    const argsLvl = stripLevelOf(beforeKill);
    if (argsLvl >= 1) persistence.setStripLevel(name, argsLvl);
    if (beforeKill.label) persistence.setLabel(name, beforeKill.label);
    return { ok: true, restarted: true, backend: created.backend || null, io: created.io || 'pty' };
  } catch (err) {
    // Strip the assembled object, not `beforeKill`: the spread is what reaches the
    // store, so stripping the source would be undone by it.
    persistence.upsert(manager._stripClaimedTree({ ...beforeKill, extraArgs, proxy: proxy ?? null, systemPrompt: nextInline, systemPromptFile: nextSysFile, appendPromptFiles: nextAppend, agents: nextAgents, denyBuiltins: nextDeny, disabledTools: nextTools, disabledSkills: nextSkills, injectSkills: nextInject, intents: Array.isArray(nextIntents) ? prunedArgs.intents : undefined, pluginGrants: prunedGrants, plugins: nextPlugins, execCommands: nextExec.length ? nextExec : undefined, env: (nextEnv && Object.keys(nextEnv).length) ? nextEnv : undefined, io: nextIo, effort: nextEffort }));
    return { ok: false, error: `${err.message} — session kept; it will respawn on next workspace open.` };
  }
}

function moveAccountByModel(model, label, wsId = DEFAULT_WORKSPACE_ID) {
  return sweepAccountMove({
    model,
    label,
    liveSessions: manager.sessions.values(),
    getEntry: (name) => persistence.get(name),
    configDirFor: (l) => accounts.configDirFor(l),
    settingsModelFor: accounts.settingsModelResolver(),
    mergeTrust: (l) => accounts.mergeTrust(l),
    applyArgs: async (name, patch, entryWs) => {
      const res = await applySessionArgs(name, patch, entryWs || wsId);
      if (res && res.ok && res.restarted) {
        const entry = persistence.get(name) || {};
        const live = manager.sessions.get(name) || {};
        manager._sendToSession(name, 'session:context-action', {
          action: 'reattach',
          name,
          type: entry.type,
          cwd: manager.resumeCwdOf(entry),
          backend: live.backend || null,
          noWire: !!live.noWire,
          io: live.io || 'pty',
          background: true,
        });
      }
      return res;
    },
  });
}

const SKILL_SWEEP_HEAD = 256 * 1024;

function sweepDiscoveredSkills() {
  let dirs;
  try { dirs = fs.readdirSync(path.join(REGISTRY_DIR, 'run')); } catch { return []; }
  const out = new Set();
  const buf = Buffer.alloc(SKILL_SWEEP_HEAD);
  for (const seat of dirs) {
    try {
      const fd = fs.openSync(pathFor(REGISTRY_DIR, seat, 'transcript'), 'r');
      let read;
      try { read = fs.readSync(fd, buf, 0, SKILL_SWEEP_HEAD, 0); }
      finally { fs.closeSync(fd); }
      let text = buf.toString('utf8', 0, read);
      if (read === SKILL_SWEEP_HEAD) text = text.slice(0, text.lastIndexOf('\n') + 1);
      for (const n of listedRosterNames(text.split('\n'))) out.add(n);
    } catch {}
  }
  return [...out];
}

function readSkillCatalog({ name = null, cwd = null, type = null } = {}) {
  const entry = name ? persistence.get(name) : null;
  const disabled = entry && Array.isArray(entry.disabledSkills) ? entry.disabledSkills : [];
  const adapter = adapterRowFor(name ? (entry ? entry.type : null) : type);
  if (adapter && adapter.skills && adapter.skills.list) {
    const envKey = adapter.account.envKey;
    const configDir = (entry && entry.env && typeof entry.env[envKey] === 'string' && entry.env[envKey])
      || path.join(os.homedir(), '.config');
    const roster = platformSkills(adapter, { configDir });
    const listed = roster.map((s) => s.id);
    const aliases = skillAliases(roster);
    const off = disabled.map((n) => (Object.hasOwn(aliases, n) ? aliases[n] : n));
    const names = [...new Set([...listed, ...off])].filter((n) => !isSkillDenyDirective(n)).sort();
    const base = { ok: true, names, aliases, effective: {}, skillsLocked: false, canReenable: SKILL_REENABLE_CONFIRMED };
    if (!name) return base;
    return {
      ...base,
      outOfScope: [],
      disabledSkills: disabled,
      allOff: disabled.includes('*'),
      skillLib: skillLibrary.listFor(sessionScopeCtx(name)),
      injectSkills: entry && Array.isArray(entry.injectSkills) ? entry.injectSkills : [],
    };
  }
  const eff = readEffectiveSkillState(name ? (entry ? entry.cwd : null) : cwd);
  const scan = name ? parseSkillRoster(name) : emptyRoster();
  let discovered;
  if (name) {
    try { skillsSeen.record(scan.roster); } catch (e) { log.warn('skills', `skills-seen not recorded: ${e.message}`); }
    discovered = scan.roster;
  } else {
    const swept = sweepDiscoveredSkills();
    try { discovered = skillsSeen.record(swept); } catch (e) {
      log.warn('skills', `skills-seen not recorded: ${e.message}`);
      discovered = swept;
    }
  }
  const names = [...new Set([
    ...CLAUDE_SKILLS,
    ...discovered,
    ...scan.outOfScope.map((s) => s.name),
    ...disabled,
    ...Object.keys(eff.overrides),
  ])].filter((n) => !isSkillDenyDirective(n)).sort();
  const base = {
    ok: true,
    names,
    effective: eff.overrides,
    skillsLocked: eff.skillsLocked,
    canReenable: SKILL_REENABLE_CONFIRMED,
  };
  if (!name) return base;
  return {
    ...base,
    outOfScope: scan.outOfScope,
    disabledSkills: disabled,
    allOff: disabled.includes('*'),
    skillLib: skillLibrary.listFor(sessionScopeCtx(name)),
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
const { syncRemoteServer, refreshRemoteToken, shutdownRemoteServer } = createRemoteWiring({
  path, fs, os, log,
  DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, REGISTRY_DIR, MSG_DIR, OUTBOX_DIR, SELF_LABEL,
  parseCtxFile, cachedMessages, sliceSince, ensureDir, homeRelativize,
  claimOutbox, listOutboxOrigins,
  manager, proxyPoller, loadManifest, listTeams, gitWorktree,
  getPeerManager: () => peerManager,
  getTunnelManager: () => tunnelManager,
  getWebTunnelManager: () => webTunnelManager,
  getSandboxManager: () => sandboxManager,
  restartClodex: restartHost, restartUnavailable, restartSession, peerProxyView,
  fetchProxyContext, fetchProxyReport, fetchProxyBust,
  fetchSessionFiles, fetchFilePeek, fetchFileDiff,
  readSessionArgs, applySessionArgs, CLAUDE_TOOLS,
  readSkillCatalog, applySessionSkills,
  getPromptLibrary: () => promptLibrary,
  getAgentLibrary: () => agentLibrary,
  getHelpCorpus,
  getSkillLibrary: () => skillLibrary,
  getPersistence: () => persistence,
  getUiSettings: () => uiSettings,
  getWorkspaces: () => workspaces,
  getNotifications: () => notifications,
  getReminders: () => reminders,
  getAccounts: () => accounts,
  getRemoteServer: () => remoteServer,
  // A getter because drawerPtys is built below this call and is null on a host with
  // drawer services off; the peer terminal must inherit that refusal.
  getDrawerPtys: () => drawerPtys,
  setRemoteServer: (v) => { remoteServer = v; },
  setRemoteError: (v) => { remoteError = v; },
  readRemoteEnvToken: () => readRemoteEnvToken(userDataPath),
  resolveRemoteToken,
  appVersion,
  isPackaged,
  getWebInfo,
  // Read per hello, so a peer sees the gate change (proxy disabled, port moved,
  // CLODEX_WIRESCOPE=off) without the box restarting.
  getWirescopeInfo: () => wirescope.localReach(),
  getNodeLogFile: logFile ? () => logFile : undefined,
  getUserDataPath: () => userDataPath,
});



let peerManager = null;
let tunnelManager = null;
let webTunnelManager = null;
const { createPeerWiring } = require('./peer-wiring');
const {
  forgetPeerAttached, forgetPeerControlled, rememberPeerControlled,
  syncPeerManager, resolvePeerUrls, openPeerWeb, closePeerWeb,
  stopPeerWirescopeTunnels,
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

// Built only when the host granted the capability, so a null service means no
// handler is registered rather than one that decides at call time.
const { createCtlService } = require('./ctl-service');
const ctlService = enableCtl ? createCtlService({}) : null;

const PASSIVE_TERM_KIND = 'terminal-passive';
const { createDrawerPtys } = require('./drawer-pty');
const { withUtf8Charset } = require('./env-scopes');
const { buildTermShim, unsupportedShellReason, REMOTE_INSTALL_LINE, remoteUnsupportedReason } = require('./term-shim');
const { shellHostOf, programOf } = require('./term-host');
const { formatCommand, createMarkParser } = require('./term-marks');
const { stripAnsi } = require('./cli/src/output');
const drawerPtys = enableLocalTerminal ? createDrawerPtys({
  spawn: pty.spawn.bind(pty),
  send: (workspaceId, channel, ...args) => {
    const win = manager.windowForWorkspace(workspaceId);
    // No pendingOutput spill as sessions get: a detached workbench terminal is
    // being killed, not buffered.
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  },
  cwdFor: (workspaceId, seat) => drawerPtyCwd(workspaceId, seat),
  scrollbackMax: SCROLLBACK_MAX,
  withUtf8Charset,
  // Injected, not required inside drawer-pty, whose test pins that it requires nothing.
  makeMarkParser: createMarkParser,
  // Spawn-time capability gate: it must stay distinct from onCommand's disclosure
  // gate, since marks make a command knowable without disclosing it.
  shimEnv: (seat) => {
    if (!seat || uiSettings.get().terminalReports === 'off') return null;
    return buildTermShim({
      dir: pathFor(REGISTRY_DIR, seat, 'termShim'),
      shell: process.env.SHELL,
      env: process.env,
    });
  },
  // Disclosure gate, read per command so switching the firehose off bites a live
  // shell; rows go onto the existing selection queue, not a channel of their own.
  onCommand: (seat, rec) => {
    if (uiSettings.get().terminalReports !== 'all') return;
    const text = formatCommand(rec, { stripAnsi });
    if (!text) return;
    queueForSeat(seat, text, PASSIVE_TERM_KIND);
  },
  vetCommand: vetTermCommand,
  onOutput: (seat, data) => { if (remoteServer) remoteServer.pushWtermOutput(seat, data); },
  onShellEnd: (seat, exitCode) => { if (remoteServer) remoteServer.pushWtermExit(seat, exitCode); },
  // Not gated on the reporting pref (it governs the unasked firehose, not an answer
  // to the agent) and always:true so output rides even on a clean exit.
  onExecResult: (seat, res) => {
    // Worded to fit every branch: after a timeout then a window close, "it has now
    // finished" would be false.
    const late = res.late ? '\n(this supersedes the still-running notice above)' : '';
    const inside = sanitizeName(res.inside);
    const insideLine = inside ? `\nran inside \`${inside}\`` : '';
    const meantLine = inside ? `\nit was meant for \`${inside}\`` : '';
    let text;
    if (res.mismatch) {
      // The other command's output is not rendered: it is the operator's own work
      // and the firehose is what they rejected.
      const ran = (res.record && res.record.command) || 'something else';
      text = `[terminal] ${res.command}${insideLine}\nthe terminal reported \`${ran}\` finishing instead — that was already running when your command arrived. Yours may never have run, or may still be queued behind it. Look at the terminal before sending it again.`;
    } else if (res.status === 'ok') {
      // `assumed` keeps this branch total: vetTermCommand guarantees a non-empty
      // `res.command`, so formatCommand always has a name and cannot answer null.
      text = formatCommand(res.record, { stripAnsi, always: true, assumed: res.command, inside });
    } else if (res.status === 'abandoned') {
      text = `[terminal] ${res.command}${insideLine}\nabandoned — a new prompt appeared before it finished, so it was interrupted (Ctrl-C) or the shell reset. There is no exit code. Its output was not captured; look at the terminal, or ask your operator.`;
    } else if (res.status === 'timeout') {
      text = `[terminal] ${res.command}${insideLine}\nstill running after ${Math.round(res.afterMs / 1000)}s. NOT cancelled — it is still going, and you will get its output when it finishes. Do not run it again.`;
    } else if (res.status === 'lost') {
      text = `[terminal] ${res.command}${insideLine}\nno ending was ever reported for it, and the terminal is idle again — whether it ran is unknown. The terminal is free for another command.`;
    } else if (res.status === 'shell-exit') {
      text = `[terminal] ${res.command}${insideLine}\nthe terminal's shell exited (${res.exitCode}) before the command reported back. Whether it ran is unknown.`;
    } else if (res.status === 'write-failed') {
      // Not the catch-all's "before the command reported back": it was never typed,
      // so nothing ran and a retry is safe.
      text = `[terminal] ${res.command}${meantLine}\nthe terminal did not accept it (${res.reason}). It was never typed, so nothing ran — you can send it again.`;
    } else if (res.status === 'session-ended') {
      const outer = sanitizeName(programOf(res.inside)) || 'the session';
      const how = res.outerExit == null ? `${outer} exited, status unknown` : `${outer} exited ${res.outerExit}`;
      text = `[terminal] ${res.command}\nran inside \`${inside}\` — the session ended (${how}) before the command reported a status of its own, so there is no exit code for it. Your terminal is back at its local shell.`;
    } else if (res.status === 'remote-unsupported') {
      text = `[terminal] ${res.command}${meantLine}\n${res.reason}`;
    } else if (res.status === 'shell-gone') {
      text = `[terminal] ${res.command}${insideLine}\n${res.reason} before the command reported back. Whether it ran is unknown.`;
    } else {
      const why = res.reason || (res.status ? `the terminal reported \`${res.status}\`` : 'the terminal went away');
      text = `[terminal] ${res.command}${insideLine}\n${why} before the command reported back. Whether it ran is unknown.`;
    }
    deliverExecResult(seat, `${text}${late}`);
  },
  remoteAllowed: () => uiSettings.get().terminalRemote === 'on' && uiSettings.get().terminalReports !== 'off',
  shellHost: shellHostOf,
  remoteInstallLine: REMOTE_INSTALL_LINE,
  remoteUnsupportedReason,
  log,
}) : null;

// Urgent dm so an agent blocked on its own command is woken; the queue write stays
// as fallback for held, dead or throwing deliveries, since dropping it loses the result.
function deliverExecResult(seat, text) {
  try {
    const r = manager._gatedDeliver(seat, 'terminal', text, true);
    if (r && (r.queued || r.parked)) return;
  } catch (e) {
    log.warn('term', `exec result dm failed for ${seat}: ${(e && e.message) || e}`);
  }
  queueForSeat(seat, text);
}

// The one append path for both terminal deliveries; only the passive firehose passes
// `kind`, so dropPassiveTermReports never touches a row the operator or agent asked for.
function queueForSeat(seat, text, kind) {
  try {
    const row = kind ? { text, kind } : { text };
    fs.appendFileSync(pathFor(REGISTRY_DIR, seat, 'selection'), `${JSON.stringify(row)}\n`);
  } catch {}
}

// Rewrites in place, not rename-and-replace: the CLI's drain hook claims this file by
// rename, so a mid-write claim reads at worst the pre-drop bytes.
function dropPassiveTermReports(seats) {
  for (const seat of seats) {
    const file = pathFor(REGISTRY_DIR, seat, 'selection');
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const kept = [];
      let dropped = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        // An unparseable row is kept; dropping what cannot be read would amplify corruption.
        let o = null;
        try { o = JSON.parse(line); } catch { kept.push(line); continue; }
        if (o && o.kind === PASSIVE_TERM_KIND) { dropped += 1; continue; }
        kept.push(line);
      }
      if (!dropped) continue;
      if (kept.length) fs.writeFileSync(file, `${kept.join('\n')}\n`);
      else fs.rmSync(file, { force: true });
      log.info('term', `dropped ${dropped} undrained terminal report(s) for ${seat}`);
    } catch {}
  }
}

function syncTerminalReports(prev) {
  if (prev !== 'all') return;
  if (uiSettings.get().terminalReports === 'all') return;
  let seats = [];
  try { seats = [...manager.sessions.keys()]; } catch { return; }
  dropPassiveTermReports(seats);
}

// Shell support and the bash floor stay in unsupportedShellReason; a copy here would drift.
// A shell older than the pref emits nothing however the checkbox reads, since the shim is applied at spawn.
function termShimDiagnosis() {
  const shellReason = unsupportedShellReason({ shell: process.env.SHELL });
  if (shellReason) return shellReason;
  const reports = uiSettings.get().terminalReports;
  if (reports === 'off') {
    return 'terminal reporting is switched off in Settings, so the shell emits no completion marks';
  }
  // Reached only by a shell born under 'off' after the operator switched to 'asked'; the
  // last message would name the checkbox they just ticked.
  if (reports === 'asked') {
    return 'this shell was opened while terminal reporting was off — close the terminal tab and reopen it';
  }
  return 'this shell was opened before terminal reporting was switched on — close the terminal tab and reopen it';
}

function termRefusalName(running) {
  const s = String(running || '');
  if (!s) return '';
  if (uiSettings.get().terminalReports === 'all') return sanitizeName(s);
  return sanitizeName(programOf(s) || '');
}

function termExec(workspaceId, seat, command) {
  if (!drawerPtys) return { ok: false, error: 'terminal tabs are not available on this host' };
  const r = drawerPtys.exec(workspaceId, seat, command);
  if (r.ok) return r.inside ? { ...r, inside: sanitizeName(r.inside) } : r;
  switch (r.code) {
    case 'bad-command': return { ok: false, error: r.error };
    case 'no-shell': return { ok: false, error: 'no terminal is open for your seat — ask your operator to open the terminal tab in the drawer. Nothing was queued.' };
    case 'no-marks': return { ok: false, error: `your terminal cannot report a command's result, so running one blind would leave you waiting forever: ${termShimDiagnosis()}` };
    case 'busy': {
      const shown = termRefusalName(r.running);
      const offer = r.remoteOffer
        ? ' — running commands inside it is possible if your operator switches on remote terminal commands in Settings ▸ Terminal'
        : '';
      if (!shown) return { ok: false, error: `your terminal is busy — a command is running, or a full-screen program (an editor, a pager, a REPL) has it. Typing now would go into that program, not the shell.${offer}` };
      const inside = sanitizeName(r.inside);
      const where = inside ? ` inside \`${inside}\`` : ' in it';
      return { ok: false, error: `your terminal is busy — \`${shown}\` is still running${where} (a command, or a full-screen program such as an ssh session, an editor, a pager or a REPL). Typing now would go into that program, not the shell. Nothing was queued${offer}.` };
    }
    case 'full-screen': {
      const shown = termRefusalName(r.running);
      const held = shown ? ` \`${shown}\` holds your terminal, and something` : ' something';
      return { ok: false, error: `a full-screen program has the remote session; nothing was typed —${held} on the far side (an editor, a pager, top) is on the alternate screen. Wait until it exits, then send the command again.` };
    }
    case 'remote-unsupported': return { ok: false, error: String(r.reason || 'the remote session cannot report results back') };
    case 'pending': return { ok: false, error: `you already have \`${sanitizeName(r.running)}\` running in your terminal — wait for its result before sending another.` };
    case 'write-failed': return { ok: false, error: `the terminal did not accept the command (${r.error}). Nothing ran.` };
    case 'no-seat': return { ok: false, error: 'your session has no terminal of its own' };
    default: return { ok: false, error: `terminal refused the command (${r.code})` };
  }
}

// Workspace records carry no root field, so the operator's most common session cwd stands in for it.
function drawerPtyCwd(workspaceId, seat) {
  if (seat) {
    try {
      const s = manager.sessions.get(seat);
      if (s && s.cwd && fs.existsSync(s.cwd)) return s.cwd;
    } catch {}
  }
  try {
    const counts = new Map();
    for (const s of manager.listForWorkspace(workspaceId)) {
      if (!s.cwd) continue;
      counts.set(s.cwd, (counts.get(s.cwd) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && fs.existsSync(best[0])) return best[0];
  } catch {}
  return process.env.HOME || os.homedir();
}

const { createToolCache } = require('./tool-doctor');
const toolCache = createToolCache({ whichBin });

  const stores = initStores(userDataPath, { log, registryDir: REGISTRY_DIR, knownSkillNames,
    ...(noSeed ? {
      resourcesDir: path.join(REGISTRY_DIR, '__no_seed__'),
      skillsResourcesDir: path.join(REGISTRY_DIR, '__no_seed_skills__'),
      envDefaultsFile: path.join(REGISTRY_DIR, '__no_env_defaults__.json'),
    } : {}) });
  const { persistence, templates, workspaces, promptLibrary,
    agentDefaults, agentLibrary, skillLibrary, execLibrary, reminders, notifications, uiSettings, envScopes, skillsSeen, renameWorkspaceScope } = stores;

  const accounts = createAccounts({ fs, path, os, clodexHome: REGISTRY_DIR });

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

  let wsFails = 0;
  let wsNextAttempt = 0;
  const WS_WATCHDOG_INTERVAL = 10000;
  const WS_WATCHDOG_BASE = 15000;
  const WS_WATCHDOG_MAX = 300000;
  const wsWatchdogTimer = setInterval(async () => {
    if (!wirescope.autoStartWanted()) { wsFails = 0; wsNextAttempt = 0; return; }
    let st;
    try { st = await wirescope.status(); } catch { return; }
    if (st.state === 'managed' || st.state === 'external') {
      wsFails = 0; wsNextAttempt = 0; return;
    }
    if (st.state === 'installing' || st.state === 'starting') return;
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
    migrateSeatLayout({ root: REGISTRY_DIR, names, fs, log });
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

  // A board that fails to migrate stays readable at its old path; it must not refuse startup.
  try {
    runTicketsMigration({ root: REGISTRY_DIR, fs, log });
  } catch (e) {
    log.info('migrate', `tickets migration skipped (${e && e.message})`);
  }

  try { manager.sweepReviewerGraveyard(); } catch (e) { log.info('migrate', `reviewer-graveyard sweep skipped (${e && e.message})`); }

  // Constructed last, before the handle returns, so a plugin's activate() runs before
  // the renderer-driven restore can create a session.
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
        getPluginUpdates: () => (pluginUpdateWatch ? pluginUpdateWatch.list() : []),
        refreshPluginUpdates: () => (pluginUpdateWatch ? pluginUpdateWatch.run() : Promise.resolve([])),
        onPluginUpdated: (id) => { if (pluginUpdateWatch) pluginUpdateWatch.drop(id); },
        getPersistence: () => persistence,
        onPluginStateChanged: () => scheduleAppMenuRefresh(),
        getNotifications: () => notifications,
        notifyOS,
        broadcast: (ch, p) => manager._broadcast(ch, p),
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
        https, execFile,
      });
      pluginLoader.loadAll(pluginHost);
      pluginUpdateWatch = createPluginUpdateWatch({
        getLoader: () => pluginLoader,
        log,
        onChange: () => scheduleAppMenuRefresh(),
      });
      pluginUpdateWatch.start();
    } catch (e) {
      pluginHost = null;
      pluginLoader = null;
      if (pluginUpdateWatch) { try { pluginUpdateWatch.stop(); } catch {} pluginUpdateWatch = null; }
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
    if (pluginUpdateWatch) { try { pluginUpdateWatch.stop(); } catch {} }
    try { proxyPoller.stop(); } catch {}
    try { if (remindScheduler) remindScheduler.stop(); } catch {}
    try { shutdownRemoteServer(); } catch {}
    if (remoteServer) { try { remoteServer.stop(); } catch {} remoteServer = null; }
    if (peerManager) { try { peerManager.stopAll(); } catch {} peerManager = null; }
    if (tunnelManager) { try { tunnelManager.stopAll(); } catch {} tunnelManager = null; }
    if (webTunnelManager) { try { webTunnelManager.stopAll(); } catch {} webTunnelManager = null; }
    try { stopPeerWirescopeTunnels(); } catch {}
    if (ctlService) { try { ctlService.dispose(); } catch {} }
    if (drawerPtys) { try { drawerPtys.dispose(); } catch {} }
    try { bashLive.stopAll(); } catch {}
    manager.killAll();
    try { speaker.stop(); } catch {}
  }

  return {
    manager, stores, syncRemoteServer, syncPeerManager, restoreSessionsForWorkspace, shutdown,
    knownSkillNames,
    refreshRemoteToken,
    setRemoteToken: (token) => writeRemoteEnvToken(userDataPath, token),
    hasRemoteToken: () => hasRemoteEnvToken(userDataPath),
    listSpeakVoices: () => voiceCatalog.list(),
    REGISTRY_DIR, SELF_LABEL, proxyPoller, wirescope, ProxyClient, pty,
    getRemoteServer: () => remoteServer,
    getRemoteError: () => remoteError,
    getPeerManager: () => peerManager,
    getTunnelManager: () => tunnelManager,
    getWebTunnelManager: () => webTunnelManager,
    openPeerWeb, closePeerWeb,
    getSandbox: (boxId) => (sandboxManager ? sandboxManager.get(boxId) : null),
    getSandboxManager: () => sandboxManager,
    enableDrawerServices,
    enableCtl,
    enableLocalTerminal,
    enableConsole,
    enableAccounts,
    syncTerminalReports,
    getCtlService: () => ctlService,
    getBashLive: () => bashLive,
    getDrawerPtys: () => drawerPtys,
    getPluginHost: () => pluginHost,
    getHelpCorpus,
    getPluginLoader: () => pluginLoader,
    getPluginUpdates: () => (pluginUpdateWatch ? pluginUpdateWatch.list() : []),
    refreshPluginUpdates: () => (pluginUpdateWatch ? pluginUpdateWatch.run() : Promise.resolve([])),
    listAllTemplates,
    listAllPrompts,
    resolveSystemPromptFile, readAppendBodies, readSystemPromptBody,
    createTeam, addRole, resolveTeam, listTeams, loadManifest,
    setRole, removeRole, renameRole, setTeamWatchdog, setLead, setTeamTrunk, gatherTeam, teamsDir,
    teamDeleteCheck, teamDeleteGated,
    CLAUDE_SKILLS, CLAUDE_SL_COMPONENTS, CLAUDE_TOOLS, CODEX_SL_COMPONENTS,
    DEPLOY_FIX_INJECT_DELAY_MS, SKILL_REENABLE_CONFIRMED,
    collectSystemDiagnostics, diagSummary, diagWarning,
    checkTools: () => toolCache.get(),
    invalidateToolCache: () => toolCache.invalidate(),
    fetchProxyContext, fetchProxyReport, fetchProxyBust,
    fetchSessionFiles, fetchFilePeek, fetchFileDiff, writeFilePeek, resolveFilePath,
    restartClodex: restartHost,
    restartUnavailable,
    restartSession, waitForSessionExit,
    readSessionArgs, applySessionArgs, readSkillCatalog, applySessionSkills,
    accounts, moveAccountByModel,
    sessionScopeCtx, readEffectiveSkillState, readEffectiveToolState, readVoiceTrigger,
    readVoiceCapability: readVoiceCapabilityCached,
    readSessionMeta, sessionMeta, sessionInfo, claudeProjectDir, rebuildAllStatusScripts, whichBin,
    stripLevelOf, updateApplies, jsonlToMarkdown, sshRun,
    probePeer, fixSessionName, buildDeployFixBriefing, classifyDeployFolder, resolveDeployFolder,
    forgetPeerAttached, forgetPeerControlled, rememberPeerControlled,
  };
}

module.exports = { createEngine, resolveRegistryDir, resolveSelfLabel, diagWarning, diagLines, sweepSpilledMessages, sweepSeatMessages, IMG_MAX_AGE };
