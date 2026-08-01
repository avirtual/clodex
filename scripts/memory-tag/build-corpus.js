#!/usr/bin/env node
// Build the tagging corpus from a live memory store.
//
// Rebuilt every run, never hand-copied: a defect in the output must be
// traceable to the store as it is now, not to a snapshot that went stale.
//
// Modes:
//   --all           every unit (vocabulary proposal — needs the whole shape)
//   --unprocessed   units with no `tags:`, or a stale `tags_v` (nightly)
//
// Bodies are capped per unit so one long memory can't dominate the corpus;
// the cap is generous enough that the claim line and its reasoning survive,
// which is all a classifier needs.

const path = require('path');
const { createMemoryStore } = require(path.join(__dirname, '..', '..', 'memory-store'));
const { VOCAB_VERSION, resolveRoot, agentFrom, isUnprocessed } = require(path.join(__dirname, 'unit-file'));

const BODY_CAP = 1200;

function main(argv) {
  const agent = agentFrom(argv);
  const all = argv.includes('--all');
  const root = resolveRoot(argv);

  const units = createMemoryStore(root).list(agent);
  if (!units.length) {
    process.stderr.write(`no units for agent ${agent} under ${root}\n`);
    process.exit(1);
  }

  // "Unprocessed" is missing tags OR an older vocabulary version. Folding the
  // version in here is what lets a vocabulary revision re-queue the corpus by
  // bumping one constant, instead of needing a one-off backfill script.
  //
  // The version test reads the FILE (isUnprocessed), not the projected unit:
  // list() surfaces a fixed field set that excludes tags_v, so filtering on
  // `u.tags_v` made every tagged unit read as unprocessed and selected the
  // whole store every run.
  const selected = all ? units : units.filter(u => isUnprocessed(root, agent, u));

  const out = [];
  for (const u of selected) {
    const body = u.body.length > BODY_CAP ? `${u.body.slice(0, BODY_CAP)}…[truncated]` : u.body;
    out.push(`### ${u.id}`);
    // scope is provenance, not a tag: it is single-valued, was set at write
    // time and never revised, and on this store 51% of it is either empty or
    // the agent's own name. Passed through as a weak hint, labelled as such.
    out.push(`scope(legacy, unreliable): ${u.scope || '(none)'}`);
    out.push(`saved: ${u.learned_at}`);
    out.push('');
    out.push(body);
    out.push('');
  }

  process.stdout.write(out.join('\n'));
  process.stderr.write(
    `corpus: ${selected.length} of ${units.length} units, `
    + `${out.join('\n').length} bytes (~${Math.round(out.join('\n').length / 3800)}k tokens)\n`
  );
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { BODY_CAP, VOCAB_VERSION };
