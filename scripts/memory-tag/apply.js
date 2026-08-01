#!/usr/bin/env node
// Apply a model-produced tag file to a memory store. THE SOLE WRITER in this
// pipeline: the model only ever writes the flat scratch file this reads, and
// never touches a unit file.
//
// Input: one line per unit, `<id>: tag1,tag2`. Blank lines and #-comments are
// skipped; anything else that does not parse is REJECTED, never repaired.
// Rejecting is the point — a "fixed up" tag is a tag no human reviewed and no
// model actually chose, and it would be indistinguishable on disk from one that
// was. A rejected line leaves its unit untouched.
//
// Usage: node apply.js <tagfile> [--agent=NAME] [--root=DIR] [--dry-run]
// Exit: 0 only when every line applied; 1 if anything was rejected.

const fs = require('fs');
const path = require('path');
const { createMemoryStore } = require(path.join(__dirname, '..', '..', 'memory-store'));
const { resolveRoot, agentFrom, readUnitFile, writeTags } = require(path.join(__dirname, 'unit-file'));

const TAG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAG_MAX = 24;
const TAGS_MIN = 1;
const TAGS_MAX = 3;

// Returns { id, tags } or { error } — never a partially-valid result. Callers
// apply only what comes back clean.
function parseLine(line, known) {
  const m = line.match(/^\s*([^:\s]+)\s*:\s*(.*)$/);
  if (!m) return { error: 'not `<id>: tag1,tag2`' };
  const id = m[1];
  if (!known.has(id)) return { error: `no unit ${id} in store` };

  const tags = m[2].split(',').map(s => s.trim()).filter(Boolean);
  if (tags.length < TAGS_MIN) return { error: 'no tags' };
  if (tags.length > TAGS_MAX) return { error: `${tags.length} tags, max ${TAGS_MAX}` };
  for (const t of tags) {
    if (t.length > TAG_MAX) return { error: `tag "${t}" is ${t.length} chars, max ${TAG_MAX}` };
    if (!TAG_RE.test(t)) return { error: `tag "${t}" is not lowercase-hyphenated` };
  }
  // A duplicate would inflate that tag's census count and make the store look
  // more organised than it is.
  if (new Set(tags).size !== tags.length) return { error: 'duplicate tag' };
  return { id, tags };
}

function apply(tagfile, { root, agent, dryRun = false } = {}) {
  const known = new Set(createMemoryStore(root).list(agent).map(u => u.id));
  const applied = [];
  const rejected = [];

  const lines = fs.readFileSync(tagfile, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const r = parseLine(line, known);
    if (r.error) { rejected.push({ n: i + 1, line: line.trim(), why: r.error }); continue; }
    // Re-read guard: list() said the id exists, but the file is what gets
    // written. A unit deleted between the two reads must reject, not create a
    // file with no body.
    if (!readUnitFile(root, agent, r.id)) {
      rejected.push({ n: i + 1, line: line.trim(), why: `unit ${r.id} unreadable` });
      continue;
    }
    if (!dryRun) writeTags(root, agent, r.id, r.tags);
    applied.push(r);
  }
  return { applied, rejected };
}

function main(argv) {
  const tagfile = argv.find(a => !a.startsWith('--'));
  if (!tagfile) {
    process.stderr.write('usage: apply.js <tagfile> [--agent=NAME] [--root=DIR] [--dry-run]\n');
    process.exit(2);
  }
  const root = resolveRoot(argv);
  const agent = agentFrom(argv);
  const dryRun = argv.includes('--dry-run');

  const { applied, rejected } = apply(tagfile, { root, agent, dryRun });

  process.stdout.write(`${dryRun ? '[dry-run] ' : ''}${applied.length} applied, ${rejected.length} rejected\n`);
  for (const r of rejected) process.stdout.write(`  REJECT line ${r.n}: ${r.why}\n    ${r.line}\n`);
  // Nonzero on any rejection: the nightly is unattended, and a silent partial
  // apply is how a tagging run half-lands and nobody looks at the log.
  process.exit(rejected.length ? 1 : 0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { apply, parseLine, TAG_RE, TAG_MAX, TAGS_MAX };
