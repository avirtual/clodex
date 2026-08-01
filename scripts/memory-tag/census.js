#!/usr/bin/env node
// Print the store's tag census as `tag: count` lines, most-used first.
// A store with no tags prints nothing and exits 0 — the nightly then runs
// censusless, which is the correct first-run behaviour, not an error.
//
// Usage: node census.js [--agent=NAME] [--root=DIR] [--seed=FILE]

const fs = require('fs');
const path = require('path');
const { resolveRoot, agentFrom, census } = require(path.join(__dirname, 'unit-file'));

function main(argv) {
  const root = resolveRoot(argv);
  const agent = agentFrom(argv);
  const out = census(root, agent).map(({ tag, n }) => `${tag}: ${n}`);

  // Seed tags are proposed-but-unapplied, so they carry count 0 and say so:
  // presented as ordinary census entries they would look like tags the store
  // uses, and the model would reuse them believing they were already load-bearing.
  const seedFlag = argv.find(a => a.startsWith('--seed='));
  if (seedFlag) {
    const seen = new Set(census(root, agent).map(c => c.tag));
    let seeds = [];
    try {
      seeds = fs.readFileSync(seedFlag.slice(7), 'utf-8').split('\n')
        .map(s => s.trim()).filter(s => s && !s.startsWith('#') && !seen.has(s));
    } catch (e) {
      process.stderr.write(`census: cannot read seed file: ${e.message}\n`);
      process.exit(1);
    }
    for (const s of seeds) out.push(`${s}: 0 (seed, not yet applied)`);
  }

  if (out.length) process.stdout.write(`${out.join('\n')}\n`);
}

if (require.main === module) main(process.argv.slice(2));
