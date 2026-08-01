// find-pointers.js reads bodies and writes nothing, so what these cases guard
// is JUDGEMENT: that a declaration nobody can resolve comes out unresolved
// rather than paired with the nearest lookalike. A wrong pair here reaches
// archive.js with a model verdict on top of it; an unresolved one costs a human
// a glance.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMemoryStore } = require('../memory-store');
const {
  findPointers, renderCandidates, matchesIn, chunkBucket, CHUNK_DECLARERS,
} = require('../scripts/memory-tag/find-pointers');

const AGENT = 'alpha';

// Distinctive-term scoring is relative to the corpus: a term in more than
// COMMON_DF of units is not distinctive. A handful of units would make every
// shared term "common" by construction and every resolution fail for a reason
// that has nothing to do with the code, so fixtures carry filler.
const FILLER = 14;

function fixture(specs, { filler = FILLER } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-ptr-'));
  const store = createMemoryStore(root);
  const ids = [];
  const all = [...specs];
  for (let i = 0; i < filler; i++) {
    all.push({ text: `unrelated note number ${i} about zzq${i} widget calibration and nothing else` });
  }
  for (let i = 0; i < all.length; i++) {
    const u = store.remember(AGENT, { text: all[i].text, pinned: !!all[i].pinned });
    const f = path.join(root, AGENT, `${u.id}.md`);
    let text = fs.readFileSync(f, 'utf-8');
    if (all[i].tags) text = text.replace(`source: ${AGENT}`, `source: ${AGENT}\ntags: ${all[i].tags}`);
    // Same reason as the consolidate fixture: remember() stamps learned_at from
    // Date.now(), so units built in one millisecond tie and any ordering
    // assertion resolves on sort stability instead of on the code.
    text = text.replace(/^learned_at: .*$/m, `learned_at: ${new Date(Date.UTC(2026, 0, i + 1)).toISOString()}`);
    fs.writeFileSync(f, text);
    if (i < specs.length) ids.push(u.id);
  }
  return { root, ids };
}

function candidatesFor(root, id) {
  return findPointers(root, AGENT).candidates.filter(c => c.id === id);
}

// The live case this pass exists for: the declaring unit names no id, cites a
// date that is NOT the target's learned_at (it is a date written inside the
// target's own body), and PARAPHRASES rather than quotes. Tags are disjoint on
// purpose — that is precisely why the tag pass cannot see this pair.
test('pointers: a prose declaration reaches its target with no id, no matching date, and a paraphrase', () => {
  const f = fixture([
    {
      text: 'Boot protocol (rev 2026-07-10): read the live thread file first. '
        + 'The reviewer/contrarian agent is RETIRED as of 2026-07-10 — it no longer '
        + 'exists; do NOT propose consulting it. Releases are decided by hand.',
      tags: 'memory-and-docs,product-philosophy',
      pinned: true,
    },
    {
      text: 'CONTRARIAN EXISTS AGAIN (spawned 07-20, supersedes the 07-10 '
        + '"contrarian retired, never consult" rule in the boot pin): peer agent '
        + 'contrarian, posture = question decisions.',
      tags: 'team-delegation,cold-review',
    },
  ]);
  const [target, decl] = f.ids;

  const { candidates, bucket } = findPointers(f.root, AGENT);
  const mine = candidates.filter(c => c.id === decl);
  assert.ok(mine.length, 'the declaration was not detected at all');

  // Resolved outright or shortlisted — either is honest. What is NOT acceptable
  // is the target being absent from the bucket, because then the model never
  // reads the two side by side and the pass has done nothing.
  const reached = mine.some(c => c.target === target || c.shortlist.includes(target));
  assert.ok(reached, `declaration ${decl} did not reach ${target}: ${JSON.stringify(mine.map(c => [c.target, c.shortlist, c.why]))}`);

  const inBucket = bucket.map(u => u.id);
  assert.ok(inBucket.includes(decl), 'the declaring unit is missing from the bucket');
  assert.ok(inBucket.includes(target), 'the target is missing from the bucket, so nothing reads them together');
});

test('pointers: an explicit mem-id in the body wins outright', () => {
  const f = fixture([
    { text: 'the original claim about quorum handling in the dispatch layer' },
    { text: 'PLACEHOLDER' },
  ]);
  const [target] = f.ids;

  // The citing unit has to be written after the target exists to name its id.
  const store = createMemoryStore(f.root);
  const decl = store.remember(AGENT, {
    text: `this retracts ${target} entirely; the quorum claim was wrong`,
  }).id;

  const [c] = candidatesFor(f.root, decl);
  assert.ok(c, 'the retraction was not detected');
  assert.strictEqual(c.target, target, `expected the cited id as target, got ${c.target} (${c.why})`);
  assert.strictEqual(c.how, 'id', `expected resolution by id, got "${c.how}"`);
});

// The rule the ticket is explicit about: an unresolved candidate a human reads
// is fine, a wrong pair that gets archived is not.
test('pointers: a declaration with nothing to point at is unresolved, not paired with the nearest unit', () => {
  const f = fixture([
    { text: 'the earlier approach here is obsolete now that the pipeline changed' },
    // A LOOKALIKE, and the case has no teeth without it: a fixture where nothing
    // shares vocabulary is unresolvable for every threshold, so it cannot tell a
    // careful pass from one that grabs the nearest thing. This unit shares a
    // term or two and must still not be selected.
    { text: 'a note about the pipeline that shares a word and nothing else' },
  ]);
  const [decl] = f.ids;

  const cands = candidatesFor(f.root, decl);
  assert.ok(cands.length, 'the declaration was not detected');
  for (const c of cands) {
    assert.strictEqual(c.target, null, `invented a target ${c.target} for a declaration naming nothing`);
    assert.deepStrictEqual(c.shortlist, [], `shortlisted ${c.shortlist} for a declaration naming nothing`);
    assert.ok(c.why, 'an unresolved candidate must say why, or a human cannot judge it');
  }
});

test('pointers: a cited id that no longer exists is a dead pointer, not a crash and not a substitute', () => {
  const f = fixture([
    { text: 'this supersedes mem-1700000000000-ghost, which said the opposite about retries' },
    { text: 'a note about retries that could pass for the ghost if anything went looking' },
  ]);
  const [decl] = f.ids;

  const [c] = candidatesFor(f.root, decl);
  assert.ok(c, 'the declaration was not detected');
  assert.strictEqual(c.target, null, `resolved a dead pointer to ${c.target}`);
  assert.deepStrictEqual(c.shortlist, [], 'a dead pointer must not fall back to a lookalike');
  assert.match(c.why, /not an active unit/, `expected a dead-pointer reason, got "${c.why}"`);
});

// Two units saying near-identical things is the case where being decisive is
// the bug. Both go in the bucket; neither is named as the target.
test('pointers: a near-tie shortlists both instead of picking one', () => {
  const twin = 'the tessellation quorum threshold for dispatch batching is four';
  const f = fixture([
    { text: `${twin}, measured on the staging rig` },
    { text: `${twin}, confirmed again later on the same rig` },
    { text: 'this reverses the earlier tessellation quorum threshold dispatch batching claim' },
  ]);
  const [a, b, decl] = f.ids;

  const { candidates, bucket } = findPointers(f.root, AGENT);
  const [c] = candidates.filter(x => x.id === decl);
  assert.ok(c, 'the declaration was not detected');
  assert.strictEqual(c.target, null, `named ${c.target} outright when two units are indistinguishable`);
  assert.ok(c.shortlist.includes(a) && c.shortlist.includes(b),
    `expected both twins shortlisted, got ${JSON.stringify(c.shortlist)}`);

  // Shortlisting is only worth anything if it puts the units in the BUCKET —
  // that is the whole mechanism by which an unresolvable pair still gets read
  // side by side. Asserting the shortlist field alone leaves the step that
  // matters untested: a mutant dropping the shortlist from the bucket passed
  // every other case here, because the fixtures that check bucket membership
  // resolve outright and never take this branch.
  const inBucket = bucket.map(u => u.id);
  assert.ok(inBucket.includes(a) && inBucket.includes(b),
    `shortlisted units never reached the bucket: ${JSON.stringify(inBucket)}`);
});

test('pointers: the bucket parses through the reader the consolidate flow already uses', () => {
  const f = fixture([
    { text: 'the original claim about quorum handling in the dispatch layer' },
    { text: 'PLACEHOLDER' },
  ]);
  const target = f.ids[0];
  const store = createMemoryStore(f.root);
  store.remember(AGENT, { text: `this retracts ${target}; the quorum claim was wrong` });

  const { bucket } = findPointers(f.root, AGENT);
  const { render } = require('../scripts/memory-tag/build-buckets');
  const text = render('pointers', bucket);

  // consolidate.sh counts units with `grep -c '^### '` and the prompt tells the
  // model the bucket is oldest first. Both have to hold for the existing flow
  // to consume this bucket unchanged.
  const heads = text.match(/^### mem-[^\n]+$/gm) || [];
  assert.strictEqual(heads.length, bucket.length, 'unit headers do not match the bucket size the shell will count');
  assert.match(text, /^# bucket: pointers \(\d+ units, oldest first\)/, 'bucket header is not the format the flow emits');

  const stamps = (text.match(/^saved: (.+)$/gm) || []).map(s => s.slice(7));
  assert.deepStrictEqual(stamps, [...stamps].sort(), 'pointer bucket must be oldest first like every other bucket');
});

test('pointers: several supersession words in one clause are one candidate, not one per word', () => {
  const hits = matchesIn('this supersedes and retracts the earlier rule, which is obsolete');
  assert.strictEqual(hits.length, 1, `one clause produced ${hits.length} candidates: ${JSON.stringify(hits)}`);
  assert.match(hits[0].text, /supersed/i, 'the merged candidate lost the word that matched first');
});

test('pointers: a body with no supersession language produces no candidates', () => {
  const f = fixture([{ text: 'the dispatch layer batches on a four-unit threshold' }]);
  assert.deepStrictEqual(findPointers(f.root, AGENT).candidates, []);
});

// THE failure mode chunking can have: a declaring unit in one chunk and the
// unit it points at in another means no model call ever sees both, and the pass
// reports success having destroyed exactly what it exists to find.
//
// The fixture has to be able to REACH that: more than CHUNK_DECLARERS
// declarers, and companions far from their declarer in age order — a flat slice
// of an age-sorted unit list splits those, which is the implementation this
// case exists to reject.
test('pointers: a declarer and its companions are never split across chunks', () => {
  const specs = [];
  // Targets first, so they sort OLDEST and their declarers land many positions
  // later. Distinct vocabulary per pair keeps each resolution unambiguous.
  const n = CHUNK_DECLARERS + 5;
  for (let i = 0; i < n; i++) {
    specs.push({ text: `baseline claim number ${i}: the qq${i} threshold for vv${i} and ww${i} in xx${i} handling` });
  }
  for (let i = 0; i < n; i++) {
    specs.push({ text: `this reverses the qq${i} threshold vv${i} ww${i} xx${i} baseline claim` });
  }
  const f = fixture(specs);

  const { candidates, chunks } = findPointers(f.root, AGENT);
  assert.ok(chunks.length > 1, `fixture produced ${chunks.length} chunk(s); it cannot test splitting`);

  const home = new Map();
  chunks.forEach((c, i) => c.units.forEach(u => {
    if (!home.has(u.id)) home.set(u.id, []);
    home.get(u.id).push(i);
  }));

  // Age order is what a flat slice would cut on, so the discriminating fact is
  // that some pair sits FURTHER APART in age order than a chunk is wide. Without
  // such a pair every implementation passes, including the broken one.
  const ages = [...new Set(candidates.flatMap(c => [c.id, c.target, ...c.shortlist]).filter(Boolean))];
  const order = new Map(findPointers(f.root, AGENT).bucket.map((u, i) => [u.id, i]));

  let pairsChecked = 0;
  let farPairs = 0;
  for (const c of candidates) {
    const companions = [...(c.target ? [c.target] : []), ...c.shortlist];
    const declHomes = home.get(c.id) || [];
    for (const comp of companions) {
      pairsChecked++;
      if (Math.abs((order.get(c.id) ?? 0) - (order.get(comp) ?? 0)) > CHUNK_DECLARERS) farPairs++;
      const compHomes = home.get(comp) || [];
      assert.ok(declHomes.some(i => compHomes.includes(i)),
        `${c.id} (chunks ${declHomes}) and its companion ${comp} (chunks ${compHomes}) never share a chunk`);
    }
  }
  // Both guards, because either alone leaves the case able to pass on nothing:
  // no pairs at all, or pairs a flat slice would never have separated.
  assert.ok(pairsChecked > 0 && ages.length > 0, 'no declarer/companion pairs existed at all');
  assert.ok(farPairs > 0,
    `all ${pairsChecked} pairs sat within ${CHUNK_DECLARERS} of each other in age order; `
    + 'a flat slice would pass this fixture');
});

test('pointers: every declaring unit lands in exactly one chunk', () => {
  const specs = [];
  const n = CHUNK_DECLARERS + 5;
  for (let i = 0; i < n; i++) {
    specs.push({ text: `baseline claim number ${i}: the qq${i} threshold for vv${i} and ww${i} in xx${i} handling` });
  }
  for (let i = 0; i < n; i++) {
    specs.push({ text: `this reverses the qq${i} threshold vv${i} ww${i} xx${i} baseline claim` });
  }
  const f = fixture(specs);
  const { candidates, chunks } = findPointers(f.root, AGENT);

  const declarers = new Set(candidates.map(c => c.id));
  for (const d of declarers) {
    const homes = chunks.filter(c => c.declarers.includes(d));
    assert.strictEqual(homes.length, 1, `declarer ${d} appears as a declarer in ${homes.length} chunks`);
  }
  assert.strictEqual(chunks.reduce((s, c) => s + c.declarers.length, 0), declarers.size,
    'the chunks between them do not account for every declaring unit exactly once');
});

// Deliberate, not a defect: deduplicating would drop a unit out of a pair it
// belongs to. archive.js is what makes the duplicate harmless.
test('pointers: a unit two declarers point at may appear in two chunks', () => {
  const f = fixture([{ text: 'the shared tessellation quorum baseline for dispatch batching is four' }]);
  const target = f.ids[0];

  // Cited BY ID, not by term overlap: many declarations saying the same thing
  // make their own shared words common corpus-wide, so term scoring would fail
  // them all and the case would test nothing. The id path is the branch that
  // matters here anyway — what is under test is chunk membership.
  const store = createMemoryStore(f.root);
  for (let i = 0; i < CHUNK_DECLARERS + 2; i++) {
    store.remember(AGENT, { text: `note ${i}: this retracts ${target}, the quorum baseline` });
  }

  const { candidates, chunks } = findPointers(f.root, AGENT);
  assert.ok(candidates.filter(c => c.target === target).length > CHUNK_DECLARERS,
    'not enough declarers resolved to the shared target to span two chunks');
  const homes = chunks.filter(c => c.units.some(u => u.id === target)).length;
  assert.ok(chunks.length > 1, 'fixture did not produce enough chunks to duplicate anything');
  assert.ok(homes > 1, `the shared target appeared in ${homes} chunk(s); duplication never happened`);
});

test('pointers: chunkBucket keeps buckets close to the declarer budget', () => {
  const specs = [];
  const n = CHUNK_DECLARERS * 2 + 3;
  for (let i = 0; i < n; i++) {
    specs.push({ text: `baseline claim number ${i}: the qq${i} threshold for vv${i} and ww${i} in xx${i} handling` });
  }
  for (let i = 0; i < n; i++) {
    specs.push({ text: `this reverses the qq${i} threshold vv${i} ww${i} xx${i} baseline claim` });
  }
  const f = fixture(specs);
  const { chunks } = findPointers(f.root, AGENT);

  for (const c of chunks) {
    assert.ok(c.declarers.length <= CHUNK_DECLARERS,
      `a chunk carries ${c.declarers.length} declarers, over the ${CHUNK_DECLARERS} budget`);
  }
  assert.ok(chunks.length >= 3, `expected the fixture to need 3+ chunks, got ${chunks.length}`);
});

test('pointers: the candidates report names the reason an unresolved candidate failed', () => {
  const f = fixture([
    { text: 'this supersedes mem-1700000000000-ghost, which said the opposite about retries' },
  ]);
  const text = renderCandidates(findPointers(f.root, AGENT).candidates);
  assert.match(text, /UNRESOLVED/, 'the report does not mark the candidate unresolved');
  assert.match(text, /not an active unit/, 'the report does not carry the reason a human needs');
  assert.match(text, /context: .*ghost/, 'the report does not show the matched text');
});
