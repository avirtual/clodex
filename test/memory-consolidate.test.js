// archive.js is the only thing that MOVES a memory unit, so these cases guard
// the store against model output. The property the whole design rests on —
// that `<agent>/superseded/` is invisible to every consumer with no filter code
// anywhere — is asserted here against the real consumers, not assumed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMemoryStore, parseMemoryUnit, composeDigest } = require('../memory-store');
const {
  run, restore, drift, parseVerdict, partialRate, consolidate, moreConservative,
  ARCHIVE_DIR, PARTIAL_ALARM, ARCHIVE_CAP, CONSERVATISM,
} = require('../scripts/memory-tag/archive');
const { buckets, render } = require('../scripts/memory-tag/build-buckets');

const AGENT = 'alpha';

function fixture(specs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-arch-'));
  const store = createMemoryStore(root);
  const ids = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    // A body may need an id minted earlier in the same fixture — the refutation
    // guard resolves by cited id, so the citing body cannot be a literal.
    const body = typeof s.text === 'function' ? s.text(ids) : s.text;
    const u = store.remember(AGENT, { text: body, pinned: !!s.pinned });
    const f = path.join(root, AGENT, `${u.id}.md`);
    const extra = [s.tags ? `tags: ${s.tags}` : '', s.extra || ''].filter(Boolean).join('\n');
    let text = fs.readFileSync(f, 'utf-8');
    if (extra) text = text.replace(`source: ${AGENT}`, `source: ${AGENT}\n${extra}`);
    // learned_at is restamped, one day apart, ascending with creation order.
    // remember() takes it from Date.now(), so units built in the same
    // millisecond TIE — and a tie makes any ordering assertion pass or fail on
    // sort stability rather than on the code under test.
    text = text.replace(/^learned_at: .*$/m, `learned_at: ${new Date(Date.UTC(2026, 0, i + 1)).toISOString()}`);
    fs.writeFileSync(f, text);
    ids.push(u.id);
  }
  return {
    root, ids, store,
    activePath: id => path.join(root, AGENT, `${id}.md`),
    archivePath: id => path.join(root, AGENT, ARCHIVE_DIR, `${id}.md`),
  };
}

function verdicts(root, text) {
  const f = path.join(root, 'verdicts.txt');
  fs.writeFileSync(f, text);
  return run(f, { root, agent: AGENT });
}

// The batch path: N buckets judged independently, applied as ONE decision.
// `force` by default because these fixtures are small enough that any archive
// at all is over the store-share cap; the cap has its own case below.
function batch(root, files, opts = {}) {
  const written = files.map((f, i) => {
    const tag = f.tag || `t${i + 1}`;
    const p = path.join(root, `verdicts.${tag}.txt`);
    fs.writeFileSync(p, f.text);
    let bucket = null;
    if (f.bucket) {
      bucket = path.join(root, `bucket.${tag}.md`);
      fs.writeFileSync(bucket, f.bucket.map(id => `### ${id}\nsaved: x\npinned: no\n\nbody\n`).join('\n'));
    }
    return { path: p, tag, bucket };
  });
  return consolidate(written, { root, agent: AGENT, force: true, ...opts });
}

const verdictOf = (r, id) => (r.decided.get(id) || {}).verdict;
const why = r => r.reported.map(x => `${x.id}: ${x.why}`).join('\n');

test('archive: superseded moves the file and writes superseded_by + reason', () => {
  const f = fixture([{ text: 'the contrarian agent is retired' }, { text: 'the contrarian agent exists again' }]);
  const [old_, newer] = f.ids;

  const { archived, rejected } = verdicts(f.root, `${old_}: superseded ${newer} # reversed by the newer note\n`);
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(archived.length, 1);

  assert.strictEqual(fs.existsSync(f.activePath(old_)), false, 'the unit did not leave the active dir');
  assert.strictEqual(fs.existsSync(f.archivePath(old_)), true, 'the unit is not in the archive');
  const meta = parseMemoryUnit(fs.readFileSync(f.archivePath(old_), 'utf-8')).meta;
  assert.strictEqual(meta.superseded_by, newer);
  assert.strictEqual(meta.archive_reason, 'reversed by the newer note');
  assert.match(meta.archived_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(meta.expired, undefined, 'superseded must not also be marked expired');
});

test('archive: expired moves the file and writes expired + reason', () => {
  const f = fixture([{ text: 'ticket t99 is in review, waiting on the lead' }]);
  const { archived, rejected } = verdicts(f.root, `${f.ids[0]}: expired # ticket-state, the moment passed\n`);
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(archived.length, 1);

  const meta = parseMemoryUnit(fs.readFileSync(f.archivePath(f.ids[0]), 'utf-8')).meta;
  assert.strictEqual(meta.expired, 'true');
  assert.strictEqual(meta.archive_reason, 'ticket-state, the moment passed');
  assert.strictEqual(meta.superseded_by, undefined, 'expired must not name a superseder');
});

test('archive: the body and all other frontmatter survive the move', () => {
  const f = fixture([
    { text: 'a claim\nwith a second line', pinned: true, tags: 'wirescope,testing', extra: 'custom_key: kept' },
    { text: 'the replacement' },
  ]);
  const before = parseMemoryUnit(fs.readFileSync(f.activePath(f.ids[0]), 'utf-8'));

  verdicts(f.root, `${f.ids[0]}: superseded ${f.ids[1]} # replaced\n`);
  const after = parseMemoryUnit(fs.readFileSync(f.archivePath(f.ids[0]), 'utf-8'));

  assert.strictEqual(after.body, before.body, 'the move altered the body');
  assert.strictEqual(after.meta.custom_key, 'kept', 'the move dropped an unknown frontmatter key');
  assert.strictEqual(after.meta.tags, 'wirescope,testing', 'the move dropped tags');
  assert.strictEqual(after.meta.pinned, 'true', 'the move dropped pinned');
  for (const k of ['id', 'scope', 'learned_at', 'source']) {
    assert.strictEqual(after.meta[k], before.meta[k], `the move altered ${k}`);
  }
});

test('archive: a superseder that is not an active unit rejects and moves nothing', () => {
  const f = fixture([{ text: 'a unit' }]);
  const cases = [
    [`${f.ids[0]}: superseded mem-9999999999-ghost # gone`, /superseder mem-9999999999-ghost is not an active unit/],
    [`${f.ids[0]}: superseded ${f.ids[0]} # itself`, /cannot supersede itself/],
    [`${f.ids[0]}: superseded`, /superseded needs the id/],
  ];
  for (const [line, why] of cases) {
    const { archived, rejected } = verdicts(f.root, `${line}\n`);
    assert.strictEqual(archived.length, 0, `"${line}" should not archive`);
    assert.strictEqual(rejected.length, 1);
    assert.match(rejected[0].why, why);
    assert.strictEqual(fs.existsSync(f.activePath(f.ids[0])), true, `"${line}" moved the unit anyway`);
  }
});

test('archive: an unknown verdict or unknown id rejects and moves nothing', () => {
  const f = fixture([{ text: 'a unit' }]);
  for (const [line, why] of [
    [`${f.ids[0]}: delete # not a verdict`, /unknown verdict "delete"/],
    [`${f.ids[0]}: # only a reason`, /unknown verdict/],
    ['mem-9999999999-nosuch: expired', /no active unit/],
    ['this is not a verdict line at all', /not `<id>: <verdict>`|unknown verdict/],
  ]) {
    const { archived, rejected } = verdicts(f.root, `${line}\n`);
    assert.strictEqual(archived.length, 0, `"${line}" should not archive`);
    assert.strictEqual(rejected.length, 1, `"${line}" should reject once`);
    assert.match(rejected[0].why, why);
  }
  assert.strictEqual(fs.existsSync(f.activePath(f.ids[0])), true);
});

test('archive: keep is a no-op that leaves the file byte-identical', () => {
  const f = fixture([{ text: 'a rule the agent keeps re-earning' }]);
  const before = fs.readFileSync(f.activePath(f.ids[0]), 'utf-8');
  const { archived, kept, rejected } = verdicts(f.root, `${f.ids[0]}: keep # still current\n`);
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(archived.length, 0);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(fs.readFileSync(f.activePath(f.ids[0]), 'utf-8'), before);
  assert.strictEqual(fs.existsSync(path.join(f.root, AGENT, ARCHIVE_DIR)), false,
    'keep must not even create the archive directory');
});

test('archive: an archived unit vanishes from list, recall, the digest and the buckets', () => {
  // THE structural property. Asserted against the real consumers rather than
  // against a filter, because the design's whole claim is that no consumer
  // needs one.
  const f = fixture([
    { text: 'ARCHIVEME an obsolete claim', pinned: true, tags: 'wirescope' },
    { text: 'KEEPME the replacement claim', pinned: true, tags: 'wirescope' },
  ]);
  const [dead, live] = f.ids;
  assert.strictEqual(f.store.list(AGENT).length, 2);

  verdicts(f.root, `${dead}: superseded ${live} # replaced\n`);

  const after = f.store.list(AGENT);
  assert.strictEqual(after.length, 1, 'list() still sees the archived unit');
  assert.strictEqual(after.filter(u => u.pinned).length, 1, 'the pin count still counts the archived unit');
  assert.strictEqual(after[0].id, live);
  assert.strictEqual(f.store.recall(AGENT, 'ARCHIVEME'), null, 'recall by body still finds it');
  assert.strictEqual(f.store.recall(AGENT, dead), null, 'recall by id still finds it (accepted consequence)');
  assert.ok(f.store.recall(AGENT, 'KEEPME'), 'recall stopped finding the live unit');

  const digest = composeDigest(after);
  assert.doesNotMatch(digest, new RegExp(dead), 'the digest still carries the archived unit');
  assert.match(digest, /\(1 unit\(s\)/, 'the digest count still includes the archived unit');

  // and the bucket builder, which reads through the same list()
  const b = buckets(f.root, AGENT);
  assert.deepStrictEqual(b.get('wirescope').map(u => u.id), [live]);
});

test('archive: --restore moves a unit back and strips every archive key', () => {
  const f = fixture([{ text: 'wrongly archived', pinned: true, extra: 'custom_key: kept' }, { text: 'the other' }]);
  const [dead, live] = f.ids;
  verdicts(f.root, `${dead}: superseded ${live} # mistake\n`);
  assert.strictEqual(f.store.list(AGENT).length, 1);

  const r = restore(f.root, AGENT, dead);
  assert.ok(r.ok, r.error);
  assert.strictEqual(fs.existsSync(f.archivePath(dead)), false, 'the unit is still in the archive');

  const meta = parseMemoryUnit(fs.readFileSync(f.activePath(dead), 'utf-8')).meta;
  for (const k of ['archived_at', 'superseded_by', 'expired', 'archive_reason']) {
    assert.strictEqual(meta[k], undefined, `restore left ${k} behind`);
  }
  assert.strictEqual(meta.pinned, 'true', 'restore dropped pinned');
  assert.strictEqual(meta.custom_key, 'kept', 'restore dropped an unknown key');
  assert.strictEqual(f.store.list(AGENT).length, 2, 'the restored unit is not back in list()');
  assert.ok(f.store.recall(AGENT, 'wrongly archived'), 'the restored unit is not recallable');
});

test('archive: --restore refuses a ghost and refuses to clobber an active unit', () => {
  const f = fixture([{ text: 'still active' }]);
  assert.match(restore(f.root, AGENT, 'mem-9999999999-ghost').error, /no archived unit/);
  assert.match(restore(f.root, AGENT, f.ids[0]).error, /no archived unit/);
});

test('archive: --dry-run reports the move and writes nothing', () => {
  const f = fixture([{ text: 'a unit' }, { text: 'its replacement' }]);
  const before = fs.readFileSync(f.activePath(f.ids[0]), 'utf-8');
  const vf = path.join(f.root, 'v.txt');
  fs.writeFileSync(vf, `${f.ids[0]}: superseded ${f.ids[1]} # replaced\n`);

  const { archived, rejected } = run(vf, { root: f.root, agent: AGENT, dryRun: true });
  assert.strictEqual(archived.length, 1);
  assert.deepStrictEqual(rejected, []);
  // Existence first: reading a moved file throws ENOENT, which is a crash
  // rather than a failure that says what broke.
  assert.ok(fs.existsSync(f.activePath(f.ids[0])), 'dry-run moved the unit out of the active dir');
  assert.strictEqual(fs.readFileSync(f.activePath(f.ids[0]), 'utf-8'), before, 'dry-run rewrote the unit');
  assert.strictEqual(fs.existsSync(path.join(f.root, AGENT, ARCHIVE_DIR)), false, 'dry-run created the archive dir');
});

test('archive: one bad line does not stop the good ones', () => {
  const f = fixture([{ text: 'first' }, { text: 'second' }, { text: 'third' }]);
  const [a, b, c] = f.ids;
  const { archived, rejected } = verdicts(f.root,
    `${a}: expired # done\n${c}: superseded mem-9999999999-ghost\n${b}: keep\n`);
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].n, 2, 'the report must name the line number in the file');
  assert.strictEqual(fs.existsSync(f.archivePath(a)), true);
  assert.strictEqual(fs.existsSync(f.activePath(c)), true, 'the rejected unit moved anyway');
});

// `partial` exists to be honest about not fitting, so the ONE thing it must
// never do is mutate. A partial that touched the file would be the forced
// verdict wearing a different name.
test('archive: partial reports the clause and leaves the unit byte-identical', () => {
  const f = fixture([{ text: 'a dozen standing rules, one of which has gone false' }]);
  const [id] = f.ids;
  const before = fs.readFileSync(f.activePath(id), 'utf-8');

  const { archived, kept, partial, rejected } = verdicts(f.root,
    `${id}: partial "the contrarian is RETIRED" # reversed later\n`);

  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(archived.length, 0, 'partial archived something');
  assert.strictEqual(kept.length, 0, 'partial was counted as a keep, hiding it from the report');
  assert.strictEqual(partial.length, 1, 'partial was not collected');
  assert.strictEqual(partial[0].arg, 'the contrarian is RETIRED',
    `the quoted clause is the deliverable; got "${partial[0].arg}"`);
  assert.strictEqual(partial[0].reason, 'reversed later');

  // Existence first, with a message: a mutant that MOVES the unit deletes the
  // subject of the byte compare, and readFileSync would die on ENOENT instead
  // of naming what broke.
  assert.ok(fs.existsSync(f.activePath(id)), 'partial moved the unit out of the active dir');
  assert.strictEqual(fs.readFileSync(f.activePath(id), 'utf-8'), before,
    'partial wrote to the unit file');
  assert.strictEqual(fs.existsSync(path.join(f.root, AGENT, ARCHIVE_DIR)), false,
    'partial must not even create the archive directory');
});

// Without the clause a human is told only that something in a 400-word pin is
// stale, and has to redo the work the model just did.
test('archive: partial without a quoted clause rejects rather than reporting a vague one', () => {
  const f = fixture([{ text: 'a dozen standing rules, one of which has gone false' }]);
  const [id] = f.ids;

  const { partial, rejected } = verdicts(f.root, `${id}: partial # something in here is stale\n`);
  assert.strictEqual(partial.length, 0, 'a clauseless partial was accepted');
  assert.strictEqual(rejected.length, 1, 'a clauseless partial was not rejected');
  assert.match(rejected[0].why, /clause/, `the rejection must say what is missing; got "${rejected[0].why}"`);
});

test('archive: partial accepts single quotes and keeps a clause containing a hash', () => {
  const line = parseVerdict(`mem-1-a: partial 'the #4 rule about retries' # stale`);
  assert.ok(!line.error, `unexpected rejection: ${line.error}`);
  assert.strictEqual(line.verdict, 'partial');
  // The reason splits on the FIRST hash, so a hash inside the quoted clause is
  // the case that would silently truncate the deliverable.
  assert.strictEqual(line.arg, 'the #4 rule about retries',
    `the clause lost text at a hash: "${line.arg}"`);
});

// The cap is guarded by measurement, not just prompt language: an over-use has
// to be visible in the run report rather than discovered on a later read.
test('archive: the partial rate is reported and trips its alarm past the threshold', () => {
  const f = fixture([{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }]);
  const [a, b, c, d] = f.ids;

  const under = verdicts(f.root, `${a}: partial "x" \n${b}: keep\n${c}: keep\n${d}: keep\n`);
  const lo = partialRate(under);
  assert.strictEqual(lo.total, 4, 'the rate must be over every verdict, not just the partials');
  assert.ok(lo.rate <= PARTIAL_ALARM, `1 of 4 tripped the alarm at rate ${lo.rate}`);

  const f2 = fixture([{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }]);
  const [e, g, h, i] = f2.ids;
  const over = verdicts(f2.root, `${e}: partial "x" \n${g}: partial "y" \n${h}: keep\n${i}: keep\n`);
  const hi = partialRate(over);
  assert.ok(hi.rate > PARTIAL_ALARM,
    `2 of 4 must trip the alarm; rate ${hi.rate} against threshold ${PARTIAL_ALARM}`);
});

// Chunking deliberately lets a unit appear in two buckets, which means two
// verdicts for one id. This case previously asserted FIRST-ARCHIVER-WINS across
// two separate runs — which was the defect, not the rule: applying one bucket
// at a time made a unit die if ANY bucket voted to archive, k independent rolls
// against the conservative AND the prompt promises. Measured on the first live
// run: 13 of 46 archives had a keep or partial in another bucket. The batch now
// resolves before anything moves, so the second verdict is a VOTE, not a
// too-late rejection.
test('archive: two buckets disagreeing on one id resolve to the most conservative', () => {
  const f = fixture([{ text: 'the older claim' }, { text: 'the newer claim' }]);
  const [old_, newer] = f.ids;
  const before = fs.readFileSync(f.activePath(old_), 'utf-8');

  const r = batch(f.root, [
    { tag: 'one', text: `${old_}: superseded ${newer} # bucket one says replaced\n` },
    { tag: 'two', text: `${old_}: keep # bucket two still needs it\n` },
  ]);

  assert.strictEqual(verdictOf(r, old_), 'keep',
    `a keep in any bucket must win; got ${verdictOf(r, old_)}`);
  assert.strictEqual(r.archived.length, 0, 'the unit was archived despite a keep in another bucket');
  assert.ok(fs.existsSync(f.activePath(old_)), 'the unit left the active dir');
  assert.strictEqual(fs.readFileSync(f.activePath(old_), 'utf-8'), before, 'the unit was rewritten');
  assert.strictEqual(fs.existsSync(path.join(f.root, AGENT, ARCHIVE_DIR)), false,
    'a keep-wins batch must not even create the archive directory');
  assert.match(why(r), new RegExp(`${old_}: verdicts differed`),
    `the resolution must be reported, not silent; got:\n${why(r)}`);
});

// The order the two buckets are read in must not decide it. The defect was
// exactly an ordering (size-descending, last writer won), so a fixture that
// only ever presents one order cannot tell the fix from the defect.
test('archive: conservative-wins does not depend on which bucket is read first', () => {
  for (const flip of [false, true]) {
    const f = fixture([{ text: 'the older claim' }, { text: 'the newer claim' }]);
    const [old_, newer] = f.ids;
    const files = [
      { tag: 'archiver', text: `${old_}: expired # bucket one\n` },
      { tag: 'keeper', text: `${old_}: partial "one stale clause" # bucket two\n` },
    ];
    const r = batch(f.root, flip ? files.reverse() : files);
    assert.strictEqual(verdictOf(r, old_), 'partial',
      `order ${flip ? 'reversed' : 'forward'} changed the verdict to ${verdictOf(r, old_)}`);
    assert.strictEqual(r.partial.length, 1, 'the surviving verdict was not reported as a partial');
    assert.ok(fs.existsSync(f.activePath(old_)), `order ${flip ? 'reversed' : 'forward'} archived the unit`);
    assert.ok(newer);
  }
});

test('archive: the conservatism order is keep > partial > superseded > expired', () => {
  assert.deepStrictEqual(CONSERVATISM, ['keep', 'partial', 'superseded', 'expired']);
  // Both argument orders: a comparator that just returned `a` would pass half.
  for (const [a, b, want] of [
    ['keep', 'expired', 'keep'], ['expired', 'keep', 'keep'],
    ['partial', 'superseded', 'partial'], ['superseded', 'partial', 'partial'],
    ['keep', 'partial', 'keep'], ['partial', 'keep', 'keep'],
    ['superseded', 'expired', 'superseded'], ['expired', 'superseded', 'superseded'],
    ['keep', 'keep', 'keep'], ['expired', 'expired', 'expired'],
  ]) {
    assert.strictEqual(moreConservative(a, b), want, `moreConservative(${a}, ${b})`);
  }
});

// The wirescope:5-6 shape from the live run: 1wl5rh superseded by 3mt55w, and
// 3mt55w expired in the same batch. Applied naively this archives a unit whose
// superseded_by points INTO the archive — the pointer a future reader follows
// to find the replacement lands on a file no enumerator can see.
test('archive: a superseder that dies in the same batch is not left as a dangling pointer', () => {
  const f = fixture([{ text: 'the original rule' }, { text: 'the rule that replaced it' }]);
  const [old_, newer] = f.ids;

  const r = batch(f.root, [
    { tag: 'wirescope', text: `${old_}: superseded ${newer} # replaced\n${newer}: expired # the moment passed\n` },
  ]);

  assert.strictEqual(verdictOf(r, old_), 'keep',
    `nothing survives to be the replacement, so the older unit must be kept; got ${verdictOf(r, old_)}`);
  assert.ok(fs.existsSync(f.activePath(old_)), 'the older unit was archived pointing at an archived unit');
  assert.strictEqual(fs.existsSync(f.archivePath(newer)), true, 'the expired superseder was not archived');
  assert.match(why(r), /dies in this batch/, `the demotion must be reported; got:\n${why(r)}`);
});

// task-tracking:1-4 from the live run: mrg172 -> jihgdf -> dzvf78 -> 90ml4f,
// with 90ml4f expired. Four links, every superseder itself archived. A
// single-step check passes each link in isolation and still archives the lot,
// leaving three units whose superseded_by points into the archive.
//
// The chain collapses to its LAST SURVIVOR, not to blanket keeps: c is kept
// because the unit that replaced it died, and a and b are then archived against
// c, which is a pointer a reader can still follow.
test('archive: a four-link chain whose head dies collapses onto the last surviving link', () => {
  const f = fixture([{ text: 'link one' }, { text: 'link two' }, { text: 'link three' }, { text: 'link four' }]);
  const [a, b, c, d] = f.ids;

  const r = batch(f.root, [{
    tag: 'task-tracking',
    text: `${a}: superseded ${b} # v2\n${b}: superseded ${c} # v3\n`
        + `${c}: superseded ${d} # v4\n${d}: expired # the whole line of work shipped\n`,
  }]);

  assert.strictEqual(verdictOf(r, c), 'keep',
    `c's superseder died, so c must survive; got ${verdictOf(r, c)}`);
  assert.ok(fs.existsSync(f.activePath(c)), 'c left the active dir with nothing replacing it');
  assert.strictEqual(fs.existsSync(f.archivePath(d)), true, 'the expired head was not archived');

  // EVERY archived unit must point at something a reader can still reach —
  // asserted over the batch rather than on one link, because a per-link check
  // is exactly what passed while the chain rotted.
  assert.strictEqual(r.archived.length, 3, `expected a, b and d to move; got ${r.archived.length}`);
  for (const v of r.archived.filter(x => x.verdict === 'superseded')) {
    const meta = parseMemoryUnit(fs.readFileSync(f.archivePath(v.id), 'utf-8')).meta;
    assert.strictEqual(meta.superseded_by, c,
      `${v.id} points at ${meta.superseded_by}, which is not the surviving head`);
    assert.ok(fs.existsSync(f.activePath(meta.superseded_by)),
      `${v.id}.superseded_by points into the archive`);
  }
});

// The same chain with a SURVIVOR at the end: the middle links still die, but
// their pointers must be re-aimed at the unit that is actually still there.
// Without this the batch is safe only by refusing to archive anything.
test('archive: a chain re-points past units archived in the same batch', () => {
  const f = fixture([{ text: 'link one' }, { text: 'link two' }, { text: 'the surviving head' }]);
  const [a, b, head] = f.ids;

  const r = batch(f.root, [{
    tag: 'task-tracking',
    text: `${a}: superseded ${b} # v2\n${b}: superseded ${head} # v3\n${head}: keep # current\n`,
  }]);

  assert.strictEqual(r.archived.length, 2, `a and b should both archive; got ${r.archived.length}`);
  assert.ok(fs.existsSync(f.archivePath(a)), 'a was not archived');
  const meta = parseMemoryUnit(fs.readFileSync(f.archivePath(a), 'utf-8')).meta;
  assert.strictEqual(meta.superseded_by, head,
    `a must point past the archived b to the surviving head; got ${meta.superseded_by}`);
  assert.ok(fs.existsSync(f.activePath(head)), 'the head was archived');
  assert.match(why(r), /re-pointed to the surviving head/, `the re-point must be reported; got:\n${why(r)}`);
});

// A superseder that was never an active unit at all — a hallucinated or
// already-archived id. The batch path has to catch this too: `active` is
// consulted for the VICTIM at collect time, and a ghost TARGET slips through
// into a superseded_by nobody can follow.
test('archive: a superseder that is not an active unit at all keeps the victim', () => {
  const f = fixture([{ text: 'the victim' }, { text: 'a bystander' }]);
  const [victim, bystander] = f.ids;

  const r = batch(f.root, [{ tag: 'x', text: `${victim}: superseded mem-9999999999-ghost # replaced\n` }]);
  assert.strictEqual(verdictOf(r, victim), 'keep',
    `a ghost superseder must not archive the victim; got ${verdictOf(r, victim)}`);
  assert.strictEqual(r.archived.length, 0, 'the victim was archived against a ghost');
  assert.ok(fs.existsSync(f.activePath(victim)), 'the victim left the active dir');
  assert.match(why(r), /is not an active unit/,
    `the demotion must name the reason, not report a batch death; got:\n${why(r)}`);
  assert.ok(bystander);
});

// connection-unification:16 + task-tracking:8 from the live run: one bucket
// supersedes neqwg1 by 2ndk3j, a DIFFERENT bucket expires 2ndk3j. Neither
// bucket can see the other, which is why this cannot be a prompt-level rule.
test('archive: a chain broken ACROSS two buckets is resolved before anything moves', () => {
  const f = fixture([{ text: 'the superseded unit' }, { text: 'its replacement' }]);
  const [victim, replacement] = f.ids;

  const r = batch(f.root, [
    { tag: 'connection-unification', text: `${victim}: superseded ${replacement} # unified\n` },
    { tag: 'task-tracking', text: `${replacement}: expired # that work shipped\n` },
  ]);

  assert.strictEqual(verdictOf(r, victim), 'keep',
    `the victim's replacement dies in another bucket; got ${verdictOf(r, victim)}`);
  assert.ok(fs.existsSync(f.activePath(victim)), 'the victim was archived pointing into the archive');
  assert.strictEqual(fs.existsSync(f.archivePath(replacement)), true,
    'the replacement was not archived on its own bucket verdict');
});

// A chain's fate is decided by what survives at its END, so reading the same
// batch in a different file order must not change a single verdict. The sweep
// this replaced collapsed a→b→c→d to four keeps in one order and archived two
// units in the other.
test('archive: chain resolution is independent of verdict-file order', () => {
  const shape = ids => {
    const [a, b, c, d] = ids;
    return [
      { tag: 'one', text: `${a}: superseded ${b} # v2\n` },
      { tag: 'two', text: `${b}: superseded ${c} # v3\n` },
      { tag: 'three', text: `${c}: superseded ${d} # v4\n` },
      { tag: 'four', text: `${d}: expired # shipped\n` },
    ];
  };
  const specs = [{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }];

  const fwd = fixture(specs);
  const forward = batch(fwd.root, shape(fwd.ids));
  const rev = fixture(specs);
  const reversed = batch(rev.root, shape(rev.ids).reverse());

  const shapeOf = (r, ids) => ids.map(id => `${verdictOf(r, id)}${(r.decided.get(id) || {}).arg ? `->${ids.indexOf(r.decided.get(id).arg)}` : ''}`).join(',');
  assert.strictEqual(shapeOf(reversed, rev.ids), shapeOf(forward, fwd.ids),
    'the same batch in a different file order produced different verdicts');
  // Pinned, not just compared: two orders agreeing on the WRONG answer would
  // pass the equality above. The sweep this replaced gave keep,keep,keep,expired
  // forward and archived two units reversed.
  assert.strictEqual(shapeOf(forward, fwd.ids), 'superseded->2,superseded->2,keep->3,expired',
    `expected the chain collapsed onto its last survivor; got ${shapeOf(forward, fwd.ids)}`);
});

// Two buckets naming DIFFERENT superseders is not a tie to break: it is two
// readings of what replaced this unit, and picking either asserts a lineage
// nobody agreed on.
test('archive: buckets naming different superseders keep the unit and report it', () => {
  const f = fixture([{ text: 'the contested unit' }, { text: 'candidate one' }, { text: 'candidate two' }]);
  const [victim, one, two] = f.ids;

  const r = batch(f.root, [
    { tag: 'alpha', text: `${victim}: superseded ${one} # this one\n` },
    { tag: 'beta', text: `${victim}: superseded ${two} # no, this one\n` },
  ]);

  assert.strictEqual(verdictOf(r, victim), 'keep',
    `a contested lineage must not be applied; got ${verdictOf(r, victim)}`);
  assert.ok(fs.existsSync(f.activePath(victim)), 'the unit was archived under a contested lineage');
  assert.match(why(r), /disagree on the superseder/, `the conflict must be reported; got:\n${why(r)}`);
  // Both candidate ids named, so a report that mentions only the winner of an
  // arbitrary pick still fails.
  assert.match(why(r), new RegExp(one), 'the report must name both candidates');
  assert.match(why(r), new RegExp(two), 'the report must name both candidates');
});

test('archive: a supersession cycle archives nothing in the cycle', () => {
  const f = fixture([{ text: 'unit a' }, { text: 'unit b' }]);
  const [a, b] = f.ids;

  const r = batch(f.root, [
    { tag: 'alpha', text: `${a}: superseded ${b} # b replaced it\n` },
    { tag: 'beta', text: `${b}: superseded ${a} # no, a replaced it\n` },
  ]);

  assert.strictEqual(r.archived.length, 0, 'a cycle archived something');
  assert.ok(fs.existsSync(f.activePath(a)), 'a moved');
  assert.ok(fs.existsSync(f.activePath(b)), 'b moved');
  assert.match(why(r), /cycle/, `the cycle must be reported; got:\n${why(r)}`);
});

// The store nearly ended up still asserting that the contrarian agent was
// retired: the unit whose whole job was to say otherwise was the one archived.
// A refutation is load-bearing for exactly as long as its target is active.
test('archive: a unit refuting a still-active unit is kept, not archived', () => {
  const f = fixture([
    { text: 'The contrarian agent is RETIRED and no longer part of the roster.' },
    { text: ids => `CONTRARIAN EXISTS AGAIN — this supersedes ${ids[0]}, which said it was retired.` },
  ]);
  const [belief, refutation] = f.ids;

  const r = batch(f.root, [
    { tag: 'team-delegation', text: `${refutation}: expired # reads like a moment-in-time note\n${belief}: keep # still referenced\n` },
  ]);

  assert.strictEqual(verdictOf(r, refutation), 'keep',
    `the refutation must outlive the belief it corrects; got ${verdictOf(r, refutation)}`);
  assert.ok(fs.existsSync(f.activePath(refutation)),
    'archiving the refutation leaves the store asserting the thing that was overturned');
  assert.match(why(r), /refutes/, `the guard must say why it fired; got:\n${why(r)}`);

  // And the guard is not a blanket "never archive an expired unit": the SAME
  // verdict applies when the refuted belief is gone too.
  const f2 = fixture([
    { text: 'The contrarian agent is RETIRED and no longer part of the roster.' },
    { text: ids => `CONTRARIAN EXISTS AGAIN — this supersedes ${ids[0]}, which said it was retired.` },
  ]);
  const r2 = batch(f2.root, [
    { tag: 'team-delegation', text: `${f2.ids[1]}: expired # the pair has stopped mattering\n${f2.ids[0]}: expired # ditto\n` },
  ]);
  assert.strictEqual(r2.archived.length, 2,
    `with its target archived too, the refutation may go; archived ${r2.archived.length}`);
});

// A pin is a unit some session decided every future session must know. Expiring
// one on a single bucket's say-so, with no replacement named, is the most
// destructive thing this pipeline can do.
test('archive: a pinned unit cannot be bare-expired without the explicit flag', () => {
  const f = fixture([{ text: 'a standing rule', pinned: true }, { text: 'a replacement' }]);
  const [pin, other] = f.ids;

  const r = batch(f.root, [{ tag: 'rules', text: `${pin}: expired # looks like ticket state\n` }]);
  assert.strictEqual(r.archived.length, 0, 'a pinned unit was expired');
  assert.strictEqual(r.rejected.length, 1, 'the pinned expiry was not rejected');
  assert.match(r.rejected[0].why, /pinned/, `the rejection must say why; got "${r.rejected[0].why}"`);
  assert.ok(fs.existsSync(f.activePath(pin)), 'the pinned unit moved');

  // The flag is the only way through, and supersession — which NAMES the
  // replacement — is not gated at all.
  const r2 = batch(f.root, [{ tag: 'rules', text: `${pin}: expired # deliberate\n` }], { allowPinnedExpiry: true });
  assert.strictEqual(r2.archived.length, 1, '--allow-pinned-expiry did not let the expiry through');

  const f2 = fixture([{ text: 'a standing rule', pinned: true }, { text: 'a replacement' }]);
  const r3 = batch(f2.root, [{ tag: 'rules', text: `${f2.ids[0]}: superseded ${f2.ids[1]} # named replacement\n` }]);
  assert.strictEqual(r3.archived.length, 1, 'supersession of a pin must not be gated: it names a replacement');
  assert.ok(other);
});

// A hallucinated id that happens to match an active unit elsewhere in the store
// would otherwise be archived on a judgement made about something else.
test('archive: a verdict about an id not in the bucket is rejected', () => {
  const f = fixture([{ text: 'in the bucket' }, { text: 'never shown to this bucket' }]);
  const [inb, outb] = f.ids;

  const r = batch(f.root, [{
    tag: 'wirescope',
    text: `${inb}: expired # judged\n${outb}: expired # never read by this bucket\n`,
    bucket: [inb],
  }]);

  assert.strictEqual(r.archived.length, 1, 'the out-of-bucket verdict was applied');
  assert.strictEqual(r.archived[0].id, inb);
  assert.strictEqual(r.rejected.length, 1, 'the out-of-bucket verdict was not rejected');
  assert.match(r.rejected[0].why, new RegExp(`${outb} is not in bucket wirescope`),
    `the rejection must name the id and bucket; got "${r.rejected[0].why}"`);
  assert.ok(fs.existsSync(f.activePath(outb)), 'the out-of-bucket unit moved anyway');
});

// The first live run archived ~30% of the store and printed nothing. A cap that
// only warns is a cap read after the units are gone, so this aborts the batch
// BEFORE stage 3 — nothing moves at all, not even the units under the cap.
test('archive: a batch over the archive cap aborts before anything moves', () => {
  const f = fixture(Array.from({ length: 10 }, (_, i) => ({ text: `unit ${i}` })));
  const lines = f.ids.slice(0, 3).map(id => `${id}: expired # shipped\n`).join('');

  const r = batch(f.root, [{ tag: 'big', text: lines }], { force: false });
  assert.ok(r.blocked, `3 of 10 is over the ${ARCHIVE_CAP} cap and must block`);
  assert.match(r.blocked, /cap/, `the abort must explain itself; got "${r.blocked}"`);
  assert.strictEqual(r.archived.length, 0, 'the cap reported but still moved files');
  for (const id of f.ids.slice(0, 3)) {
    assert.ok(fs.existsSync(f.activePath(id)), `${id} moved despite the abort`);
  }
  assert.strictEqual(fs.existsSync(path.join(f.root, AGENT, ARCHIVE_DIR)), false,
    'an aborted batch must not even create the archive directory');

  // Under the cap the same shape goes through, so the guard is not just "always
  // block".
  const f2 = fixture(Array.from({ length: 10 }, (_, i) => ({ text: `unit ${i}` })));
  const under = batch(f2.root, [{ tag: 'big', text: `${f2.ids[0]}: expired # shipped\n` }], { force: false });
  assert.ok(!under.blocked, `1 of 10 is under the cap; got "${under.blocked}"`);
  assert.strictEqual(under.archived.length, 1);

  // and --force is the deliberate override
  const f3 = fixture(Array.from({ length: 10 }, (_, i) => ({ text: `unit ${i}` })));
  const forced = batch(f3.root, [{ tag: 'big', text: f3.ids.slice(0, 3).map(id => `${id}: expired # x\n`).join('') }]);
  assert.strictEqual(forced.archived.length, 3, '--force did not override the cap');
});

// The run report says what SHOULD have happened; the snapshot is what the store
// actually looked like, and it is the only thing that makes a bad batch
// reversible without re-deriving it.
test('archive: --out snapshots the active store before the first move', () => {
  const f = fixture([{ text: 'about to be archived' }, { text: 'the replacement' }]);
  const [dead, live] = f.ids;
  const before = fs.readFileSync(f.activePath(dead), 'utf-8');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-out-'));

  const r = batch(f.root, [{ tag: 'x', text: `${dead}: superseded ${live} # replaced\n` }], { outDir });
  assert.strictEqual(r.archived.length, 1);

  const snap = path.join(outDir, `snapshot.${AGENT}`, `${dead}.md`);
  assert.ok(fs.existsSync(snap), 'the archived unit is missing from the snapshot');
  assert.strictEqual(fs.readFileSync(snap, 'utf-8'), before,
    'the snapshot was taken after the mutation, so it does not reconstruct the store');
  assert.ok(fs.existsSync(path.join(outDir, `snapshot.${AGENT}`, `${live}.md`)),
    'the snapshot must copy the whole store, not just the victims');
});

// The clause is the entire deliverable, and clauses are quoted verbatim from
// bodies that themselves quote things. A lazy match ends the clause at the
// inner quote and the remainder reads as prose — a silent truncation of the
// whole verdict. Measured on the first live run: two clauses damaged this way.
test('archive: a clause containing quotes survives whole', () => {
  for (const [line, want] of [
    [`mem-1-a: partial "the rule says "always fence" here" # stale`, 'the rule says "always fence" here'],
    [`mem-1-a: partial "he said 'no longer' about it" # stale`, `he said 'no longer' about it`],
    [`mem-1-a: partial "a clause with a # hash and a "quote"" # reversed`, 'a clause with a # hash and a "quote"'],
    // The hash AFTER an inner quote is the case the reason-split itself must be
    // greedy for: a lazy span ends at the inner quote, the hash search then
    // starts inside the clause and splits the verdict at a hash that is part of
    // the deliverable. The two cases above put the hash BEFORE the inner quote,
    // where a lazy split happens to land correctly and proves nothing.
    [`mem-1-a: partial "the "always fence" rule # 4 applies" # stale`, 'the "always fence" rule # 4 applies'],
    [`mem-1-a: partial "plain clause"`, 'plain clause'],
  ]) {
    const v = parseVerdict(line);
    assert.ok(!v.error, `unexpected rejection of ${line}: ${v.error}`);
    assert.strictEqual(v.arg, want, `clause truncated: got "${v.arg}"`);
  }
  // and the reason still survives the greedy clause, including past an inner
  // quote — a truncated clause with an intact reason would pass a clause-only
  // check while the verdict itself was cut in half.
  for (const [line, want] of [
    [`mem-1-a: partial "a "nested" clause" # the reason`, 'the reason'],
    [`mem-1-a: partial "the "always fence" rule # 4 applies" # stale`, 'stale'],
  ]) {
    assert.strictEqual(parseVerdict(line).reason, want,
      `the reason was eaten by the clause; got "${parseVerdict(line).reason}"`);
  }
});

test('drift: tags with 1-2 active units are reported, and archiving can create one', () => {
  const f = fixture([
    { text: 'one', tags: 'big-tag' }, { text: 'two', tags: 'big-tag' },
    { text: 'three', tags: 'big-tag' }, { text: 'lonely', tags: 'singleton-tag' },
  ]);
  assert.deepStrictEqual(drift(f.root, AGENT), [{ tag: 'singleton-tag', n: 1 }]);

  // Archiving down to 2 makes big-tag a candidate too: the detector has to see
  // the store AFTER the move, not the store the verdicts were written against.
  verdicts(f.root, `${f.ids[0]}: superseded ${f.ids[1]} # replaced\n`);
  assert.deepStrictEqual(drift(f.root, AGENT).map(c => c.tag).sort(), ['big-tag', 'singleton-tag']);
});

test('buckets: units are oldest first with full bodies and pinned state', () => {
  const long = 'x'.repeat(2000);
  const f = fixture([
    { text: `oldest claim ${long}`, tags: 'wirescope', pinned: true },
    { text: 'newest claim', tags: 'wirescope' },
  ]);
  const list = buckets(f.root, AGENT).get('wirescope');
  assert.deepStrictEqual(list.map(u => u.id), f.ids, 'buckets must be oldest first');

  const text = render('wirescope', list);
  assert.ok(text.includes(long), 'the body was capped — a truncated claim reads as agreement');
  assert.match(text, /### .*\nsaved: .*\npinned: yes/);
  assert.ok(text.indexOf(f.ids[0]) < text.indexOf(f.ids[1]));
});
