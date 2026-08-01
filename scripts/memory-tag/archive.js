#!/usr/bin/env node
// Move superseded and expired units out of the active store. THE SOLE MOVER:
// the model only ever writes the flat verdict file this reads, and never
// touches a memory unit.
//
// Archiving is a MOVE into `<agent>/superseded/`, not a status flag. Every
// enumerator of the store (memory-store's list(), and the memory-viewer
// plugin's own readdir) keeps only `*.md`, so a subdirectory is invisible to
// all of them with no filter code anywhere — and a filter is something each
// future consumer would have to remember, where a subdirectory is something
// none of them can forget. Verified empirically before this was written; do
// not replace it with a status field.
//
// Input: one line per unit, `<id>: <verdict>[ <arg>][ # reason]` where verdict
// is keep | partial "<clause>" | superseded <id> | expired. Malformed lines
// REJECT — never repaired, because a repaired verdict is a judgement nobody
// made.
//
// TWO-PHASE BY CONSTRUCTION: collect (parse everything, mutate nothing) ->
// resolve (one verdict per id, most conservative wins, then fixpoint the batch)
// -> applyDecided (the only stage that touches a file). Take ALL the verdict
// files at once. Applying them one file at a time is what the first live run
// did, and it meant a unit died if any single bucket voted to archive while
// another bucket's `keep` had already been written and discarded.
//
// Usage: node archive.js <verdictfile...> [--agent=NAME] [--root=DIR]
//          [--dry-run] [--force] [--allow-pinned-expiry] [--out=DIR]
//        node archive.js --restore <id> [--agent=NAME] [--root=DIR]
//        node archive.js --drift [--agent=NAME] [--root=DIR]
// Exit: 0 when everything applied; 1 if anything was rejected; 2 if the
//       archive cap aborted the batch.

const fs = require('fs');
const path = require('path');
const { createMemoryStore, parseMemoryUnit, serializeMemoryUnit } = require(path.join(__dirname, '..', '..', 'memory-store'));
const { resolveRoot, agentFrom, census } = require(path.join(__dirname, 'unit-file'));
// The refutation guard reuses the pointer pass's detector rather than growing a
// second, half-correct copy of "does this body declare a supersession".
const {
  matchesIn, contextAt, docFreq, resolve: resolvePointer,
} = require(path.join(__dirname, 'find-pointers'));

const ARCHIVE_DIR = 'superseded';
// Written by an archive, stripped by a restore. Kept together so the two
// operations cannot drift apart.
const ARCHIVE_KEYS = ['archived_at', 'superseded_by', 'expired', 'archive_reason'];

function activeDir(root, agent) { return path.join(root, agent); }
function archiveDir(root, agent) { return path.join(root, agent, ARCHIVE_DIR); }

function readFileMeta(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch { return null; }
  const { meta, body } = parseMemoryUnit(raw);
  if (!meta || !meta.id) return null;
  return { meta, body };
}

// `<id>: <verdict>[ <arg>][ # reason]`. Returns { id, verdict, arg, reason } or
// { error }.
function parseVerdict(line) {
  const m = line.match(/^\s*([^:\s]+)\s*:\s*(.*)$/);
  if (!m) return { error: 'not `<id>: <verdict>`' };
  const id = m[1];
  let rest = m[2].trim();

  // The reason splits at the first hash OUTSIDE a quoted clause: `partial`'s
  // clause is quoted verbatim from a unit body, and a body sentence containing
  // a hash would otherwise have the deliverable truncated at it.
  //
  // The clause span is taken GREEDILY to the LAST matching quote, not the
  // first. A clause quoting a unit that itself quotes something ends at the
  // inner quote under a lazy match, and the truncated remainder then reads as
  // prose — the clause IS the deliverable, so a silent truncation is the whole
  // verdict lost. Measured on the first live run: two clauses damaged this way.
  let reason = '';
  const quoted = rest.match(/^(\S+\s+)(["'])(.*)\2/);
  const from = quoted ? quoted[0].length : 0;
  const hash = rest.indexOf('#', from);
  if (hash >= 0) { reason = rest.slice(hash + 1).trim(); rest = rest.slice(0, hash).trim(); }

  const parts = rest.split(/\s+/).filter(Boolean);
  const verdict = (parts[0] || '').toLowerCase();
  if (verdict === 'keep') return { id, verdict, reason };
  if (verdict === 'expired') return { id, verdict, reason };
  // `partial "<clause>"` — one rotten clause in a unit that is otherwise live.
  // The clause is the entire deliverable: without it a human is told only that
  // something in a 400-word pin is stale and has to re-find it, which is the
  // work the model just did.
  if (verdict === 'partial') {
    // Greedy to the last matching quote, same reason as the reason-split above:
    // clauses are quoted verbatim from bodies and bodies quote things.
    const q = rest.match(/(["'])(.*)\1/);
    const clause = q ? q[2] : '';
    if (!clause.trim()) return { error: 'partial needs the rotten clause in quotes' };
    return { id, verdict, arg: clause, reason };
  }
  if (verdict === 'superseded') {
    if (!parts[1]) return { error: 'superseded needs the id of the unit that replaces it' };
    return { id, verdict, arg: parts[1], reason };
  }
  return { error: `unknown verdict "${parts[0] || ''}"` };
}

function archiveOne(root, agent, v, { dryRun = false, now = new Date() } = {}) {
  const src = path.join(activeDir(root, agent), `${v.id}.md`);
  const cur = readFileMeta(src);
  if (!cur) return `unit ${v.id} is not readable`;

  const meta = { ...cur.meta, archived_at: now.toISOString() };
  if (v.verdict === 'superseded') meta.superseded_by = v.arg; else meta.expired = 'true';
  // The reason travels WITH the artifact: this folder is meant to be read later
  // to see how beliefs changed, and a file found there has to explain itself
  // without the report that produced it.
  meta.archive_reason = v.reason || (v.verdict === 'superseded' ? `superseded by ${v.arg}` : 'expired');

  if (dryRun) return null;
  const dstDir = archiveDir(root, agent);
  fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dstDir, `${v.id}.md`), serializeMemoryUnit(meta, cur.body), { mode: 0o600 });
  // Write-then-unlink, not rename-then-edit: a crash between the two leaves the
  // unit in BOTH places, which a human can see and resolve. The reverse order
  // can leave it in neither.
  fs.unlinkSync(src);
  return null;
}

// Most conservative first. A unit lives if ANY bucket says so.
//
// The rule this replaces was not a rule at all, it was apply order: buckets ran
// size-descending and the last verdict to touch an id won, so a unit died if
// ANY ONE of its k buckets voted to archive — k independent rolls, P =
// 1-(1-p)^k. That inverts the intent exactly, because the units in the most
// buckets are the best-tagged and most cross-cutting ones. Measured on the
// first live run: 13 of 46 archives had a keep or partial in another bucket.
const CONSERVATISM = ['keep', 'partial', 'superseded', 'expired'];

function moreConservative(a, b) {
  return CONSERVATISM.indexOf(a) <= CONSERVATISM.indexOf(b) ? a : b;
}

// Ids named by the bucket file, so a verdict about a unit the model never read
// can be rejected. A hallucinated id that happens to match an active unit
// elsewhere in the store would otherwise be archived on a judgement made about
// something else entirely.
function bucketMembers(bucketfile) {
  if (!bucketfile) return null;
  let raw;
  try { raw = fs.readFileSync(bucketfile, 'utf-8'); }
  catch { return null; }
  return new Set([...raw.matchAll(/^### (mem-\d+-[a-z0-9]+)\s*$/gim)].map(m => m[1]));
}

// STAGE 1. Parse every verdict file. MUTATES NOTHING — that is the point of the
// split: the applier cannot act on bucket 1 before bucket 22 has been read, so
// no ordering can decide which judgement takes effect.
function collect(files, { root, agent, allowPinnedExpiry = false } = {}) {
  const units = createMemoryStore(root).list(agent);
  const active = new Set(units.map(u => u.id));
  const pinned = new Set(units.filter(u => u.pinned).map(u => u.id));
  const byId = new Map();
  const rejected = [];

  for (const f of files) {
    const tag = f.tag || path.basename(f.path || f);
    const members = bucketMembers(f.bucket);
    const lines = fs.readFileSync(f.path || f, 'utf-8').split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const reject = why => rejected.push({ tag, n: i + 1, line: line.trim(), why });

      const v = parseVerdict(line);
      if (v.error) { reject(v.error); continue; }
      if (!active.has(v.id)) { reject(`no active unit ${v.id}`); continue; }
      if (members && !members.has(v.id)) { reject(`${v.id} is not in bucket ${tag}`); continue; }
      if (v.verdict === 'superseded' && v.arg === v.id) { reject('a unit cannot supersede itself'); continue; }
      // A pin is a unit some session decided every future session must know.
      // Expiring one on a bucket's say-so, with no replacement named, is the
      // single most destructive thing this pipeline can do.
      if (v.verdict === 'expired' && pinned.has(v.id) && !allowPinnedExpiry) {
        reject(`${v.id} is pinned: expiry needs a superseder, or --allow-pinned-expiry`);
        continue;
      }
      if (!byId.has(v.id)) byId.set(v.id, []);
      byId.get(v.id).push({ ...v, tag, n: i + 1 });
    }
  }
  return { byId, active, pinned, rejected };
}

// STAGE 2. One verdict per id, then make the batch self-consistent.
function resolve(byId, { root, agent, active } = {}) {
  const decided = new Map();
  const reported = [];
  const note = (id, why, votes) => reported.push({ id, why, votes });

  for (const [id, votes] of byId) {
    const verdicts = votes.map(v => v.verdict);
    let winner = verdicts.reduce(moreConservative);

    // Two buckets naming DIFFERENT superseders is not a tie to break — it means
    // two readings of what replaced this unit, and picking either asserts a
    // lineage nobody agreed on.
    const supersederIds = new Set(votes.filter(v => v.verdict === 'superseded').map(v => v.arg));
    if (winner === 'superseded' && supersederIds.size > 1) {
      note(id, `buckets disagree on the superseder (${[...supersederIds].join(', ')})`, votes);
      winner = 'keep';
    }
    const chosen = votes.find(v => v.verdict === winner) || votes[0];
    decided.set(id, { ...chosen, verdict: winner, votes });

    if (winner !== verdicts[0] || new Set(verdicts).size > 1) {
      note(id, `verdicts differed across buckets (${votes.map(v => `${v.tag}:${v.verdict}`).join(', ')}); kept the most conservative: ${winner}`, votes);
    }
  }

  // A cycle means two units each claim the other replaced them. Nothing about
  // that is safe to apply in either direction.
  for (const id of [...decided.keys()]) {
    const seen = new Set();
    let cur = id;
    while (cur && decided.has(cur) && decided.get(cur).verdict === 'superseded') {
      if (seen.has(cur)) {
        for (const member of seen) {
          if (decided.get(member) && decided.get(member).verdict === 'superseded') {
            decided.set(member, { ...decided.get(member), verdict: 'keep' });
            note(member, 'supersession cycle; nothing in the cycle is archived', []);
          }
        }
        break;
      }
      seen.add(cur);
      cur = decided.get(cur).arg;
    }
  }

  // FIXPOINT. The old rule snapshotted `active` once and never updated it, so a
  // `superseded` whose target died later in the same batch passed the guard the
  // comment claimed it caught — leaving archived units whose superseded_by
  // points INTO the archive, which is what breaks reversibility-by-reading.
  //
  // Resolved from the END of each chain backwards, NOT by sweeping the map until
  // it stops changing. A sweep decides the head of a chain before it knows
  // whether the tail survives, and a demotion to keep is never undone, so the
  // same batch read in a different file order archived a different set: a→b→c→d
  // with d expired collapses to four keeps in map order and to "c kept, a and b
  // re-pointed at c" in reverse. The recursion below asks only what survives
  // further down this chain, which no ordering can change.
  const headMemo = new Map();
  const inFlight = new Set();
  const survives = id => {
    if (!decided.has(id)) return active.has(id);
    const d = decided.get(id);
    if (d.verdict !== 'superseded') return d.verdict === 'keep' || d.verdict === 'partial';
    return headFor(id) === null;
  };
  const headFor = id => {
    if (headMemo.has(id)) return headMemo.get(id);
    // A cycle that reached here despite the demotion above must not recurse
    // forever; treating it as "nothing survives down this way" keeps its units.
    if (inFlight.has(id)) return null;
    inFlight.add(id);
    const t = decided.get(id).arg;
    let head;
    if (!decided.has(t)) head = active.has(t) ? t : null;
    else if (decided.get(t).verdict === 'superseded') head = survives(t) ? t : headFor(t);
    else head = survives(t) ? t : null;
    inFlight.delete(id);
    headMemo.set(id, head);
    return head;
  };

  // Every head computed against the ORIGINAL verdicts, then applied: rewriting
  // `decided` mid-walk would feed the recursion its own partial answers.
  const heads = new Map();
  for (const [id, d] of decided) if (d.verdict === 'superseded') heads.set(id, headFor(id));
  for (const [id, head] of heads) {
    const d = decided.get(id);
    if (head === d.arg) continue;
    if (head) {
      decided.set(id, { ...d, arg: head, reason: `${d.reason || ''}${d.reason ? '; ' : ''}re-pointed past units archived in the same batch` });
      note(id, `superseder ${d.arg} dies in this batch; re-pointed to the surviving head ${head}`, []);
    } else if (!active.has(d.arg) && !decided.has(d.arg)) {
      decided.set(id, { ...d, verdict: 'keep' });
      note(id, `superseder ${d.arg} is not an active unit; kept`, []);
    } else {
      decided.set(id, { ...d, verdict: 'keep' });
      note(id, `superseder ${d.arg} dies in this batch and no surviving replacement remains; kept`, []);
    }
  }

  const refusals = protectRefutations(decided, { root, agent, active });
  for (const r of refusals) note(r.id, r.why, []);

  return { decided, reported };
}

// A unit that overturns another belief is load-bearing for exactly as long as
// that belief is in the store. Archiving the refutation while its target stays
// active leaves the store asserting the thing that was refuted — which is how
// this store nearly ended up still claiming the contrarian agent is retired.
//
// Mechanical, not prompt-hope: the same detector the pointer pass uses.
function protectRefutations(decided, { root, agent, active }) {
  const units = createMemoryStore(root).list(agent);
  const byUnitId = new Map(units.map(u => [u.id, u]));
  const freq = docFreq(units);
  const out = [];

  for (const [id, d] of decided) {
    if (d.verdict !== 'expired' && d.verdict !== 'superseded') continue;
    const unit = byUnitId.get(id);
    if (!unit) continue;

    for (const hit of matchesIn(String(unit.body))) {
      const context = contextAt(unit.body, hit.index);
      const r = resolvePointer(unit, context, units, freq);
      const targets = [...(r.target ? [r.target] : []), ...(r.shortlist || [])];
      const survivor = targets.find(t => {
        const td = decided.get(t);
        return active.has(t) && (!td || td.verdict === 'keep' || td.verdict === 'partial');
      });
      if (survivor) {
        decided.set(id, { ...d, verdict: 'keep' });
        out.push({ id, why: `refutes ${survivor}, which stays active; a refutation is load-bearing while its target is in the store` });
        break;
      }
    }
  }
  return out;
}

// STAGE 3. The only stage that touches a file.
function applyDecided(decided, { root, agent, dryRun = false, now = new Date() } = {}) {
  const archived = [];
  const kept = [];
  const partial = [];
  const rejected = [];

  for (const [, d] of decided) {
    if (d.verdict === 'keep') { kept.push(d); continue; }
    if (d.verdict === 'partial') { partial.push(d); continue; }
    const err = archiveOne(root, agent, d, { dryRun, now });
    if (err) { rejected.push({ tag: d.tag, n: d.n, line: `${d.id}: ${d.verdict}`, why: err }); continue; }
    archived.push(d);
  }
  return { archived, kept, partial, rejected };
}

// A copy of the agent dir before the first mutation. The run report says what
// SHOULD have happened; this is what the store actually looked like, and it is
// the only thing that makes a bad batch reversible without re-deriving it.
function snapshot(root, agent, outDir) {
  const src = activeDir(root, agent);
  const dst = path.join(outDir, `snapshot.${agent}`);
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.md')) continue;
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  return dst;
}

// The whole pass in the order that makes it safe: read everything, decide
// everything, then move. No bucket can act before the last one has been read.
function consolidate(files, opts = {}) {
  const { byId, active, pinned, rejected } = collect(files, opts);
  const { decided, reported } = resolve(byId, { ...opts, active });

  const blocked = overCap(decided, active.size, opts);
  if (blocked) {
    return {
      archived: [], kept: [], partial: [], rejected, reported, decided,
      pinned, storeSize: active.size, blocked,
    };
  }

  if (opts.outDir && !opts.dryRun) snapshot(opts.root, opts.agent, opts.outDir);
  const applied = applyDecided(decided, opts);
  return {
    ...applied,
    rejected: [...rejected, ...applied.rejected],
    reported, decided, pinned,
    storeSize: active.size,
  };
}

function run(verdictfile, { root, agent, dryRun = false, now = new Date() } = {}) {
  const active = new Set(createMemoryStore(root).list(agent).map(u => u.id));
  const archived = [];
  const kept = [];
  const partial = [];
  const rejected = [];

  const lines = fs.readFileSync(verdictfile, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const reject = why => rejected.push({ n: i + 1, line: line.trim(), why });

    const v = parseVerdict(line);
    if (v.error) { reject(v.error); continue; }
    if (!active.has(v.id)) { reject(`no active unit ${v.id}`); continue; }
    if (v.verdict === 'keep') { kept.push(v); continue; }
    // A REPORT LINE, NOT A MUTATION. Nothing is moved and nothing is written to
    // the unit — the whole point is a verdict that is honest about not fitting,
    // and a `partial` that touched the file would be the forced verdict wearing
    // a different name.
    if (v.verdict === 'partial') { partial.push(v); continue; }
    // A unit superseded by a ghost stays put. This also catches a superseder
    // that was itself archived or forgotten later — the replacement has to be
    // somewhere a reader can actually follow the pointer to.
    if (v.verdict === 'superseded' && !active.has(v.arg)) {
      reject(`superseder ${v.arg} is not an active unit`);
      continue;
    }
    if (v.verdict === 'superseded' && v.arg === v.id) { reject('a unit cannot supersede itself'); continue; }

    const err = archiveOne(root, agent, v, { dryRun, now });
    if (err) { reject(err); continue; }
    archived.push(v);
  }
  return { archived, kept, partial, rejected };
}

// `partial` is the easiest verdict to over-use: it is the honest escape hatch,
// and a model under uncertainty reaches for it the way it reaches for `keep`.
// Past this share of a bucket's verdicts the prompt's cap has failed and the
// pass has produced a to-do list rather than a curated store — which has to be
// visible in the run report, not discovered on a later read.
const PARTIAL_ALARM = 0.25;

function partialRate({ archived, kept, partial }) {
  const total = archived.length + kept.length + partial.length;
  return { total, n: partial.length, rate: total ? partial.length / total : 0 };
}

// The alarms were on the HARMLESS verdict and absent from the destructive one:
// the first live run archived ~30% of the store and printed nothing. `partial`
// over-use costs a human some reading; archiving over-use costs the knowledge.
const ARCHIVE_ALARM = 0.25;
// Past this share of the whole store the batch STOPS. A cap that only warns is
// a cap that gets read after the units are gone.
const ARCHIVE_CAP = 0.15;

function archiveRate({ archived, kept, partial }, storeSize) {
  const total = archived.length + kept.length + partial.length;
  return {
    total,
    n: archived.length,
    rate: total ? archived.length / total : 0,
    ofStore: storeSize ? archived.length / storeSize : 0,
  };
}

// Checked on the DECIDED batch, before stage 3 runs, so the cap can refuse the
// whole thing rather than report it after the moves.
function overCap(decided, storeSize, { force = false, cap = ARCHIVE_CAP } = {}) {
  if (force || !storeSize) return null;
  const n = [...decided.values()].filter(d => d.verdict === 'superseded' || d.verdict === 'expired').length;
  const share = n / storeSize;
  if (share <= cap) return null;
  return `${n} of ${storeSize} active units (${Math.round(share * 100)}%) would be archived, `
    + `over the ${Math.round(cap * 100)}% cap — rerun with --force if this is deliberate`;
}

function restore(root, agent, id, { dryRun = false } = {}) {
  const src = path.join(archiveDir(root, agent), `${id}.md`);
  const cur = readFileMeta(src);
  if (!cur) return { error: `no archived unit ${id}` };
  const dst = path.join(activeDir(root, agent), `${id}.md`);
  if (fs.existsSync(dst)) return { error: `${id} is already active` };

  const meta = { ...cur.meta };
  for (const k of ARCHIVE_KEYS) delete meta[k];
  if (dryRun) return { ok: true };
  fs.writeFileSync(dst, serializeMemoryUnit(meta, cur.body), { mode: 0o600 });
  fs.unlinkSync(src);
  return { ok: true };
}

// Tags left with 1-2 ACTIVE units. A tag that thins out this far is either a
// bucket the vocabulary never really needed or one archiving just emptied —
// either way it is the signal that the vocabulary has drifted from the store.
function drift(root, agent) {
  return census(root, agent).filter(c => c.n <= 2);
}

function main(argv) {
  const root = resolveRoot(argv);
  const agent = agentFrom(argv);
  const dryRun = argv.includes('--dry-run');

  if (argv.includes('--drift')) {
    const d = drift(root, agent);
    process.stdout.write(d.length
      ? `drift candidates (tags with <=2 active units):\n${d.map(c => `  ${c.tag}: ${c.n}`).join('\n')}\n`
      : 'no drift candidates\n');
    return;
  }

  const ri = argv.indexOf('--restore');
  if (ri >= 0) {
    const id = argv[ri + 1];
    if (!id || id.startsWith('--')) { process.stderr.write('usage: archive.js --restore <id>\n'); process.exit(2); }
    const r = restore(root, agent, id, { dryRun });
    if (r.error) { process.stdout.write(`RESTORE FAILED: ${r.error}\n`); process.exit(1); }
    process.stdout.write(`${dryRun ? '[dry-run] ' : ''}restored ${id} to active\n`);
    return;
  }

  // Every non-flag argument is a verdict file: the whole batch is read before
  // anything moves, so no bucket's judgement can be overridden by a later one.
  const files = argv.filter(a => !a.startsWith('--')).map(p => ({
    path: p,
    tag: path.basename(p).replace(/^verdicts\./, '').replace(/\.txt$/, ''),
    // Same stem in the same directory, so a run dir needs no extra wiring for
    // the membership check to apply.
    bucket: fs.existsSync(p.replace(/verdicts\.(.*)\.txt$/, 'bucket.$1.md'))
      ? p.replace(/verdicts\.(.*)\.txt$/, 'bucket.$1.md') : null,
  }));
  if (!files.length) {
    process.stderr.write('usage: archive.js <verdictfile...> [--agent=NAME] [--root=DIR] '
      + '[--dry-run] [--force] [--allow-pinned-expiry] [--out=DIR]\n');
    process.exit(2);
  }

  const outDir = (argv.find(a => a.startsWith('--out=')) || '').slice(6) || null;
  const result = consolidate(files, {
    root, agent, dryRun, outDir,
    force: argv.includes('--force'),
    allowPinnedExpiry: argv.includes('--allow-pinned-expiry'),
  });
  const { archived, kept, partial, rejected, reported, blocked, storeSize } = result;

  const out = [];
  const say = s => { out.push(s); process.stdout.write(s); };

  if (blocked) {
    say(`ABORTED: ${blocked}\n`);
    if (outDir) fs.writeFileSync(path.join(outDir, 'archive.log'), out.join(''));
    process.exit(2);
  }

  const sup = archived.filter(v => v.verdict === 'superseded').length;
  const exp = archived.filter(v => v.verdict === 'expired').length;
  say(`${dryRun ? '[dry-run] ' : ''}${archived.length} archived `
    + `(${sup} superseded, ${exp} expired), ${kept.length} kept, `
    + `${partial.length} partial, ${rejected.length} rejected\n`);
  for (const r of rejected) say(`  REJECT ${r.tag || ''} line ${r.n}: ${r.why}\n    ${r.line}\n`);

  // The resolution log is the part that has no other home: the verdict files
  // record what each bucket said, and only this records which judgement won and
  // why, which is exactly what was unrecoverable after the first live run.
  if (reported && reported.length) {
    say(`resolution (most conservative wins across buckets):\n`);
    for (const r of reported) say(`  ${r.id}: ${r.why}\n`);
  }

  if (partial.length) {
    const { n, total, rate } = partialRate(result);
    say(`partial (rotted clause, nothing moved — for human review):\n`);
    for (const p of partial) {
      say(`  ${p.id}: "${p.arg}"${p.reason ? ` — ${p.reason}` : ''}\n`);
    }
    say(`  rate: ${n}/${total} (${Math.round(rate * 100)}%)`
      + `${rate > PARTIAL_ALARM ? ` — OVER ${Math.round(PARTIAL_ALARM * 100)}%, the prompt's cap is not holding` : ''}\n`);
  }

  const ar = archiveRate(result, storeSize);
  if (archived.length) {
    say(`archived: ${ar.n}/${ar.total} verdicts (${Math.round(ar.rate * 100)}%), `
      + `${Math.round(ar.ofStore * 100)}% of the ${storeSize}-unit store`
      + `${ar.rate > ARCHIVE_ALARM ? ` — OVER ${Math.round(ARCHIVE_ALARM * 100)}%, look before trusting this` : ''}\n`);
  }

  const d = drift(root, agent);
  if (d.length) {
    say(`drift candidates (tags with <=2 active units):\n${d.map(c => `  ${c.tag}: ${c.n}`).join('\n')}\n`);
  }

  if (outDir) {
    fs.writeFileSync(path.join(outDir, 'archive.log'), out.join(''));
    fs.writeFileSync(path.join(outDir, 'partials.txt'),
      partial.map(p => `${p.id}: "${p.arg}"${p.reason ? ` # ${p.reason}` : ''}`).join('\n') + '\n');
  }
  process.exit(rejected.length ? 1 : 0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = {
  run, restore, drift, parseVerdict, partialRate,
  collect, resolve, applyDecided, consolidate, snapshot,
  archiveRate, overCap, moreConservative, bucketMembers,
  ARCHIVE_DIR, ARCHIVE_KEYS, PARTIAL_ALARM, ARCHIVE_ALARM, ARCHIVE_CAP, CONSERVATISM,
};
