#!/usr/bin/env node
// pot-cli.js — the boiling pot's read-only command line, for the grok skill
// (boiling-pot-plan.md [internal design doc, not in this repo] treatment 1). A running agent can't reach the
// pot:snapshot IPC (renderer→main only), so it reads the raw per-agent heat
// files instead — but through the SAME aggregator the drawer uses, never an
// ad-hoc re-implementation (that drift is the "skill decays into a stale map"
// failure the plan warns against). Prints the carriage-ranked top-N so the
// skill can point at TODAY's hot files instead of hardcoding names.
//
// MATERIALIZED, not run-in-place: the app copies this + its require closure
// (file-heat.js + fs-util.js) into ~/.clodex/bin/ at launch (pot-bin.js), so it
// runs from a stable path even when the app's own copy is sealed inside
// app.asar. The closure is pinned by test/pot-cli-closure.test.js — a new
// require() in file-heat.js that isn't materialized fails that test, not a user.
//
// TIER 1 ONLY: carriage + segments (what the skill targets). The redundancy
// columns need a live proxy fetch the CLI has no business doing, so they're
// absent here — the drawer owns the tier-2 join.
'use strict';

const fs = require('fs');
const path = require('path');
const { aggregateStates, normalizeState, heatPath } = require('./file-heat');
const { readJsonSafe } = require('./fs-util');

// Root = ~/.clodex. When materialized to ~/.clodex/bin/, the parent dir is the
// root; CLODEX_ROOT overrides (tests, headless, a non-default home).
function resolveRoot() {
  if (process.env.CLODEX_ROOT) return process.env.CLODEX_ROOT;
  return path.resolve(__dirname, '..');
}

// Load every per-agent heat file under heat/<name>/file-heat.json. Through
// file-heat.js's own heatPath, never a hand-joined path: this CLI and the
// drawer's potSnapshot must read the same location, and a second spelling here
// is exactly the drift that would make the two disagree silently.
function loadStates(root) {
  const states = [];
  let names = [];
  try { names = fs.readdirSync(path.join(root, 'heat')); } catch { return states; }
  for (const name of names) {
    const raw = readJsonSafe(heatPath(root, name));
    if (raw) states.push(normalizeState(raw));
  }
  return states;
}

function fmtTokens(n) {
  if (n >= 1e6) { const m = n / 1e6; return (Number.isInteger(m) ? m : m.toFixed(1)) + 'M'; }
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function parseTopN(argv) {
  const i = argv.indexOf('--top');
  if (i >= 0 && Number.isInteger(+argv[i + 1]) && +argv[i + 1] > 0) return +argv[i + 1];
  return 15;
}

function main() {
  const root = resolveRoot();
  const topN = parseTopN(process.argv.slice(2));
  const snap = aggregateStates(loadStates(root), { topN });
  const files = snap.files || [];
  if (!files.length) {
    process.stdout.write('pot is empty — no file-heat recorded yet in this window.\n');
    return;
  }
  // Stable, tab-separated, carriage-ranked. ~tokens is a RANKING approximation
  // (bytes/4, line-slice estimated), never a billing figure — the skill says so.
  process.stdout.write(`# boiling pot — top ${files.length} by carriage (${snap.window.from}..${snap.window.to})\n`);
  process.stdout.write('# ~tokens is an approximation (bytes/4), not billing. segments = distinct read ranges (the walking signal).\n');
  for (const f of files) {
    process.stdout.write(`${fmtTokens(f.approxReadTokens)}\t${f.segments}seg\t${f.reads}r\t${f.edits}e\t${f.file}\n`);
  }
}

if (require.main === module) main();

module.exports = { resolveRoot, loadStates, parseTopN };
