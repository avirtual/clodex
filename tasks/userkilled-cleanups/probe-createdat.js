// PROBE: does persistence `createdAt` actually survive a kill()+create() restart?
// The journal (mine) and clodex's ruling both assume it does. The comment at
// session-manager.js:1458 asserts it does. But createdAt is NOT in either
// _preserveAcrossRestart field list, and kill() removes the record BEFORE
// create() reads existingEntry. Measure, don't read.
//
// Simulates exactly the engine.restartSession sequence against the REAL
// persistence store semantics: get → remove → (preserve stub) → upsert.

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'createdat-probe-'));
const file = path.join(root, 'sessions.json');

// Minimal stand-in for the persistence store's actual behaviour: upsert
// spread-merges over any existing record, remove drops it entirely.
function load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function save(o) { fs.writeFileSync(file, JSON.stringify(o)); }
const persistence = {
  get: (n) => load()[n] || null,
  upsert: (rec) => { const o = load(); o[rec.name] = { ...(o[rec.name] || {}), ...rec }; save(o); },
  remove: (n) => { const o = load(); delete o[n]; save(o); },
};

// create()'s own createdAt line, verbatim from session-manager.js:1462-1463.
function createStampsCreatedAt(name) {
  const existingEntry = persistence.get(name);
  const createdAt = (existingEntry && existingEntry.createdAt) || Date.now();
  persistence.upsert({ name, createdAt });
  return createdAt;
}

// _preserveAcrossRestart, verbatim shape from session-manager.js:2013.
function preserveAcrossRestart(name, priorEntry, fields) {
  if (!priorEntry || !Array.isArray(fields) || !fields.length) return;
  const seed = { name };
  let any = false;
  for (const f of fields) if (priorEntry[f] !== undefined) { seed[f] = priorEntry[f]; any = true; }
  if (!any) return;
  persistence.upsert(seed);
}

console.log('--- CASE 1: first create');
const born = createStampsCreatedAt('agent-7');
console.log('createdAt at birth:', born);

// Busy-wait so a fresh Date.now() is visibly different.
const t0 = Date.now(); while (Date.now() === t0) { /* spin */ }

console.log('\n--- CASE 2: engine.restartSession (kill removes the record)');
const entry = persistence.get('agent-7');           // pre-kill snapshot
persistence.remove('agent-7');                      // <- kill() does this
preserveAcrossRestart('agent-7', entry, ['ephemeral', 'reviewFor', 'rosterSentAt']);
const afterRestart = createStampsCreatedAt('agent-7');
console.log('createdAt after restart:', afterRestart);
console.log('PRESERVED?', afterRestart === born ? 'YES' : '*** NO — CHANGED ***');

console.log('\n--- CASE 3: restore-on-launch (record KEPT, no kill)');
const beforeRestore = persistence.get('agent-7').createdAt;
const afterRestore = createStampsCreatedAt('agent-7');
console.log('createdAt after restore:', afterRestore);
console.log('PRESERVED?', afterRestore === beforeRestore ? 'YES' : '*** NO — CHANGED ***');

fs.rmSync(root, { recursive: true, force: true });
