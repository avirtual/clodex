#!/usr/bin/env node
// Does the generated plugin actually RUN?
//
// A file that parses is not a plugin that works: an earlier trial exited rc=0
// having written an engine.js with a raw control character in a regex class.
// `node --check` is therefore the floor here, not the test. This drives the
// plugin through the REAL loader and the REAL engine — the same two factories
// the app uses — so a pass means activate() ran against the true host surface.
//
// Both factories are plain-deps (no electron, no window), which is what makes
// this possible outside the GUI; the stub shapes below are lifted from
// test/plugin-loader.test.js and test/plugin-host-engine.test.js so the fake
// manager cannot drift into being kinder than the real one.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Derived, never a literal: this tool ships inside plugins/, so a hardcoded
// repo path makes it work only on the machine it was written on.
const REPO = path.resolve(__dirname, '..', '..');
const { createPluginLoader } = require(path.join(REPO, 'plugin-loader.js'));
const { createPluginHostEngine } = require(path.join(REPO, 'plugin-host-engine.js'));
const intentRegistry = require(path.join(REPO, 'intent-registry.js'));

const dir = process.argv[2];
if (!dir) { console.error('usage: verify.js <plugin-dir>'); process.exit(2); }

const checks = [];
const notes = [];
const record = (name, ok, detail) => { checks.push({ name, ok, detail: detail || '' }); };
// Observations the contract does not require. Kept OUT of `checks` so they can
// never fail a conforming plugin, and printed anyway so an author sees what the
// host actually saw.
const note = (name, detail) => { notes.push({ name, detail: detail || '' }); };
const fatal = (name, detail) => { record(name, false, detail); report(); process.exit(1); };

// ---------------------------------------------------------------- structure
if (!fs.existsSync(dir)) fatal('plugin dir exists', `${dir} not found`);
const manifestPath = path.join(dir, 'manifest.json');
if (!fs.existsSync(manifestPath)) fatal('manifest.json present', 'missing');

let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
catch (e) { fatal('manifest.json parses', e.message); }
record('manifest.json parses', true);

// Syntax floor. Checked in a child process because a raw control byte can make
// require() fail in ways that are harder to attribute than --check's message.
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'pipe' });
    record(`parses: ${f}`, true);
  } catch (e) {
    record(`parses: ${f}`, false, String(e.stderr || e.message).split('\n')[0]);
  }
}

// Staged under a scratch root so the loader sees exactly one plugin, but the
// DIRECTORY NAME IS PRESERVED. Renaming it to manifest.id here would manufacture
// the very match the loader checks for, and this verifier would then be
// structurally incapable of catching an id/dirname mismatch — a defect that
// makes the plugin undiscoverable in the real app.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-verify-'));
const staged = path.join(stage, path.basename(path.resolve(dir)));
fs.mkdirSync(staged, { recursive: true });
for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(staged, f));

// ------------------------------------------------------------------- stubs
const sent = [];
const injected = [];
const sessions = new Map([
  ['seat-a', { name: 'seat-a', type: 'claude', cwd: REPO, workspaceId: 'ws-open' }],
  ['seat-remote', { name: 'seat-remote', type: 'claude', cwd: '/x', workspaceId: 'ws-open', peer: 'box' }],
]);
const manager = {
  sessions,
  list: () => [...sessions.values()].map((s) => ({ name: s.name, type: s.type, cwd: s.cwd, workspaceId: s.workspaceId })),
  listForWorkspace(wsId) { return this.list().filter((s) => s.workspaceId === wsId); },
  _sendToSession: (name, channel, ...args) => sent.push({ to: { session: name }, channel, args }),
  _broadcast: (channel, ...args) => sent.push({ to: 'all', channel, args }),
  windowForWorkspace: (wsId) => (wsId === 'ws-open'
    ? { webContents: { send: (channel, ...args) => sent.push({ to: { workspace: wsId }, channel, args }) } }
    : null),
  _injectText: (session, text, opts) => injected.push({ name: session.name, text, opts }),
};

let ui = {};
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-verify-data-'));
const logged = [];

const loader = createPluginLoader({
  fs, path,
  pluginsDir: stage,
  getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
  log: { info: (scope, msg) => logged.push(`${scope}: ${msg}`) },
  requireModule: (p) => require(p),
});

const engine = createPluginHostEngine({
  manager,
  getUiSettings: () => ({ get: () => ui, set: (patch) => { ui = { ...ui, ...patch }; } }),
  log: { info: (s, m) => logged.push(`${s} ${m}`), error: (s, m) => logged.push(`ERROR ${s} ${m}`) },
  userDataPath: dataDir,
  fs, path,
  // Stub SHAPE from the real leaf, values never: host.lib.gitWorktree lends
  // through exactly the function keys found here, so a hand-written key list
  // makes real methods read as `is not a function` and fails a conforming
  // plugin for a defect that is ours. Bodies stay inert — the real
  // createWorktree/removeWorktree touch the user's actual repo — but they must
  // still answer in the leaf's own shape: it is `async` and refuses bad input
  // with `{ ok: false, error }`, so returning a bare `undefined` makes a plugin
  // that correctly reads `.error` throw, and the crash regex then blames the
  // plugin for the stub's infidelity.
  gitWorktree: Object.fromEntries(Object.keys(require(path.join(REPO, 'git-worktree.js')))
    .map((k) => [k, async () => ({ ok: false, error: 'verify.js: inert gitWorktree stub' })])),
  telemetrySnapshot: () => null,
  getLoader: () => loader,
});

// -------------------------------------------------------------- discovery
let rec;
try {
  rec = loader.discover().find((r) => r.id === manifest.id);
} catch (e) { fatal('loader.discover() runs', e.message); }
if (!rec) fatal('plugin is discoverable', `manifest validation refused id "${manifest.id}" — ${logged.join(' | ') || 'no reason logged'}`);
record('plugin is discoverable', true);
record('hostApi accepted', rec.manifest.hostApi === '1', `manifest.hostApi = ${JSON.stringify(rec.manifest.hostApi)}`);

const declaredEngine = rec.manifest.entry && rec.manifest.entry.engine;
if (declaredEngine) {
  record('declared engine file exists', fs.existsSync(path.join(staged, declaredEngine)), declaredEngine);
}
const declaredRenderer = rec.manifest.entry && rec.manifest.entry.renderer;
if (declaredRenderer) {
  record('declared renderer file exists', fs.existsSync(path.join(staged, declaredRenderer)), declaredRenderer);
}
if (rec.manifest.style) {
  record('declared style file exists', fs.existsSync(path.join(staged, rec.manifest.style)), rec.manifest.style);
}

// -------------------------------------------------------------- activation
// Snapshot the registry's plugin rows so the verb check OBSERVES what got
// registered instead of probing a guessed list of names. A hardcoded guess list
// reports "no verb" for any plugin that picked a name we did not think of,
// which is a false failure in the instrument rather than a defect in the plugin.
// rows() is CORE_ROWS followed by the live plugin rows, so subtracting the core
// set enumerates exactly the plugin-contributed verbs.
const pluginVerbs = () => {
  const core = new Set(intentRegistry.CORE_ROWS.map((r) => r.type));
  return intentRegistry.rows().map((r) => r.type).filter((t) => !core.has(t));
};
const verbsBefore = new Set(pluginVerbs());

let activated = false;
try {
  const r = loader.activateById(manifest.id, engine);
  activated = !!(r && r.ok);
  record('activate() succeeds', activated, activated ? '' : JSON.stringify(r));
} catch (e) {
  record('activate() succeeds', false, e.message);
}

if (!activated) { report(); process.exit(1); }

// ------------------------------------------------- did it actually DO anything
const keys = engine._dispatchKeys().filter((k) => k.startsWith(`${manifest.id}:`));
const hookCounts = engine._hookCounts();
record('registered at least one surface', keys.length > 0 || hookCounts.create > 0 || hookCounts.exit > 0,
  `ipc methods: ${keys.length ? keys.join(', ') : 'none'} | onCreate: ${hookCounts.create} | onExit: ${hookCounts.exit}`);

// Every declared ipc method must answer without CRASHING. It is called with no
// arguments, so a handler that replies "a session name is required" has passed:
// rejecting a bad call is correct behaviour, and grading it as a failure would
// make this verifier punish the well-written plugins. Only a crash-shaped error
// — the runtime complaining about the handler's own code rather than about its
// input — is a real defect. Judged by message shape because the host flattens
// every throw into the same envelope.
const CRASH = /is not a function|is not defined|Cannot read propert|Cannot access|undefined is not|null is not|Assignment to constant/i;
(async () => {
  for (const key of keys) {
    const method = key.slice(manifest.id.length + 1);
    try {
      // 'desktop' explicitly: dispatch refuses anything that is not that exact
      // token, and the refusal it returns is not crash-shaped — so an omitted
      // surface would grade every unannotated method "rejected cleanly" without
      // ever entering the handler, and this whole loop would pass vacuously.
      const res = await engine.dispatch(manifest.id, method, [], 'desktop');
      const msg = res && typeof res === 'object' && res.ok === false ? String(res.error) : '';
      const crashed = msg && CRASH.test(msg);
      record(`ipc ${method}() answers`, !crashed,
        msg ? `rejected cleanly: ${msg.slice(0, 120)}` : `-> ${JSON.stringify(res).slice(0, 120)}`);
    } catch (e) {
      record(`ipc ${method}() answers`, false, `threw out of dispatch: ${e.message}`);
    }
  }

  // Hooks are sync and positioned; a throwing hook is caught by the host, so we
  // assert via the log rather than by catching here.
  const errsBefore = logged.filter((l) => l.startsWith('ERROR')).length;
  try { engine.hooks.fireCreate('seat-a'); engine.hooks.fireExit('seat-a'); record('session hooks survive firing', true); }
  catch (e) { record('session hooks survive firing', false, e.message); }
  const errsAfter = logged.filter((l) => l.startsWith('ERROR')).length;
  record('hooks logged no error', errsAfter === errsBefore,
    errsAfter > errsBefore ? logged.filter((l) => l.startsWith('ERROR')).slice(-2).join(' | ') : '');

  // Reported, not asserted: a verb is optional in the contract — the manifest
  // requires only hostApi + entry and has no verb field to gate on — so a
  // UI-only plugin is conforming. Asserting presence rejected `workbench` and
  // would teach authors to register a verb they do not want.
  const newVerbs = pluginVerbs().filter((t) => !verbsBefore.has(t));
  note('intent verbs', newVerbs.join(', ') || 'none (optional)');

  // Deactivation must release everything: a verb that outlives its plugin keeps
  // parsing into a dead handler.
  try {
    engine.deactivate(manifest.id);
    const leftover = engine._dispatchKeys().filter((k) => k.startsWith(`${manifest.id}:`));
    const leftVerbs = newVerbs.filter((t) => intentRegistry.pluginRowFor(t));
    record('deactivate() releases surfaces', leftover.length === 0 && leftVerbs.length === 0,
      [...leftover, ...leftVerbs].join(', '));
  } catch (e) {
    record('deactivate() releases surfaces', false, e.message);
  }

  report();
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
})();

function report() {
  const pass = checks.filter((c) => c.ok).length;
  console.log(`\n=== verify: ${path.basename(dir)} ===`);
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  for (const n of notes) console.log(`  note  ${n.name}${n.detail ? `  — ${n.detail}` : ''}`);
  console.log(`  ${pass}/${checks.length} checks passed`);
}
