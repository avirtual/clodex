#!/usr/bin/env node
// Build one consolidation corpus per tag. Each bucket is read in ONE model
// call, so a bucket is the unit of judgement: contradiction is only visible
// between units seen together.
//
// Bodies are NOT capped (unlike build-corpus.js, which caps at 1200 for a
// whole-store classification pass). A bucket is <=24 units, and deciding
// whether a newer unit replaces an older one means reading both claims whole —
// a truncated claim is exactly the thing that looks like agreement.
//
// Usage: node build-buckets.js [--tag=NAME] [--agent=NAME] [--root=DIR] [--out=DIR]
//        with no --out, prints one bucket to stdout (requires --tag).

const fs = require('fs');
const path = require('path');
const { createMemoryStore } = require(path.join(__dirname, '..', '..', 'memory-store'));
const { resolveRoot, agentFrom } = require(path.join(__dirname, 'unit-file'));

// Below this a bucket cannot hold a contradiction worth a model call; those
// tags surface through archive.js --drift instead.
const MIN_BUCKET = 4;

function tagsOf(u) {
  return String(u.tags || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Archived units are already gone: list() only sees `*.md` in the agent dir and
// the archive is a subdirectory. Nothing here filters them out because nothing
// here can see them.
function buckets(root, agent) {
  const units = createMemoryStore(root).list(agent);
  const byTag = new Map();
  for (const u of units) {
    for (const t of tagsOf(u)) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(u);
    }
  }
  // Oldest first: supersession runs forward in time, so a reader deciding
  // "does a later unit replace this one" needs the earlier claim first.
  for (const list of byTag.values()) {
    list.sort((a, b) => String(a.learned_at).localeCompare(String(b.learned_at)));
  }
  return byTag;
}

function render(tag, units) {
  const out = [`# bucket: ${tag} (${units.length} units, oldest first)`, ''];
  for (const u of units) {
    out.push(`### ${u.id}`);
    out.push(`saved: ${u.learned_at}`);
    out.push(`pinned: ${u.pinned ? 'yes' : 'no'}`);
    out.push('');
    // Body lines that look like a unit header are neutralised. A body starting
    // a line with `### mem-…` would otherwise forge a unit — inventing an id
    // the model then writes a verdict about, and breaking the `grep -c '^### '`
    // count consolidate.sh uses to report bucket size.
    out.push(String(u.body).replace(/^(#{1,6} )/gm, ' $1'));
    out.push('');
  }
  return out.join('\n');
}

function main(argv) {
  const root = resolveRoot(argv);
  const agent = agentFrom(argv);
  const only = (argv.find(a => a.startsWith('--tag=')) || '').slice(6);
  const outDir = (argv.find(a => a.startsWith('--out=')) || '').slice(6);

  const byTag = buckets(root, agent);
  const eligible = [...byTag.entries()]
    .filter(([tag, list]) => list.length >= MIN_BUCKET && (!only || tag === only))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  if (!eligible.length) {
    process.stderr.write(only
      ? `tag ${only} has fewer than ${MIN_BUCKET} active units\n`
      : `no tag has ${MIN_BUCKET} or more active units\n`);
    process.exit(1);
  }

  if (!outDir) {
    if (eligible.length > 1) {
      process.stderr.write('more than one bucket: pass --tag=NAME or --out=DIR\n');
      process.exit(1);
    }
    process.stdout.write(render(eligible[0][0], eligible[0][1]));
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const [tag, list] of eligible) {
    fs.writeFileSync(path.join(outDir, `bucket.${tag}.md`), render(tag, list));
    process.stderr.write(`bucket ${tag}: ${list.length} units\n`);
  }
  // stdout is the tag list so the shell loop can read it without parsing logs.
  process.stdout.write(`${eligible.map(([tag]) => tag).join('\n')}\n`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { buckets, render, MIN_BUCKET };
