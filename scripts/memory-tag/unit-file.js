// Shared leaf for the tagging pipeline: where the store is, how to read a unit
// file's RAW frontmatter, and the tag census.
//
// `memory-store`'s list() projects a fixed set of fields and does not surface
// `tags_v`, so anything that needs it has to go to the file. Reading the raw
// meta here, once, is what keeps build-corpus and apply from each growing their
// own half-correct version of that.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMemoryStore, parseMemoryUnit, serializeMemoryUnit } = require(path.join(__dirname, '..', '..', 'memory-store'));

// The vocabulary generation. Bumping it re-queues every unit through
// --unprocessed, which is the whole point of storing tags_v alongside tags.
const VOCAB_VERSION = 1;

// `--root=` wins over the env var so a test or a dry run can point at a fixture
// without exporting anything; both exist because build-corpus shipped with the
// env var and callers may already use it.
function resolveRoot(argv = []) {
  const flag = argv.find(a => a.startsWith('--root='));
  if (flag) return flag.slice(7);
  return process.env.CLODEX_MEMORY_ROOT
    || path.join(os.homedir(), '.clodex', 'library', 'memory');
}

function agentFrom(argv = [], fallback = 'clodex') {
  const flag = argv.find(a => a.startsWith('--agent='));
  return flag ? flag.slice(8) : fallback;
}

function unitPath(root, agent, id) { return path.join(root, agent, `${id}.md`); }

// Raw meta straight off disk, including keys list() drops. Returns null for a
// file that is absent or has no frontmatter, so callers can reject rather than
// write into something they failed to understand.
function readUnitFile(root, agent, id) {
  let raw;
  try { raw = fs.readFileSync(unitPath(root, agent, id), 'utf-8'); }
  catch { return null; }
  const { meta, body } = parseMemoryUnit(raw);
  if (!meta || !meta.id) return null;
  return { meta, body, raw };
}

// Sets tags/tags_v and NOTHING else. The spread preserves every other
// frontmatter key, and serializeMemoryUnit (since 7498631) passes unknown keys
// through — order is core keys, then unknowns in insertion order, then pinned
// last. Assigning over an existing tags key keeps its original position rather
// than moving it to the end.
function writeTags(root, agent, id, tags) {
  const cur = readUnitFile(root, agent, id);
  if (!cur) return false;
  const meta = { ...cur.meta, tags: tags.join(','), tags_v: String(VOCAB_VERSION) };
  fs.writeFileSync(unitPath(root, agent, id), serializeMemoryUnit(meta, cur.body), { mode: 0o600 });
  return true;
}

// Units whose tags are missing or written under an older vocabulary. Reads
// tags_v from the FILE: list() does not surface it, so filtering on the
// projected unit silently selects everything.
function isUnprocessed(root, agent, unit) {
  if (!unit.tags || !String(unit.tags).trim()) return true;
  const file = readUnitFile(root, agent, unit.id);
  return Number((file && file.meta.tags_v) || 0) < VOCAB_VERSION;
}

// `tag: count` over the store, most-used first. The nightly prompt carries this
// so the model reuses what is already there instead of coining a synonym; ties
// break alphabetically so two runs on an unchanged store agree.
function census(root, agent) {
  const counts = new Map();
  for (const u of createMemoryStore(root).list(agent)) {
    for (const t of String(u.tags || '').split(',').map(s => s.trim()).filter(Boolean)) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, n]) => ({ tag, n }));
}

module.exports = {
  VOCAB_VERSION, resolveRoot, agentFrom, unitPath,
  readUnitFile, writeTags, isUnprocessed, census,
};
