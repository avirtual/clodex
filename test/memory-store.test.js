const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');

const { createMemoryStore, composeDigest, parseMemoryUnit, DIGEST_BUDGET,
  OPERATOR_PIN_CAP, RECENT_BODY_CAP } = require('../memory-store');

function tmpStore() {
  const dir = mkTmpRoot('clodex-mem-');
  return { store: createMemoryStore(dir), dir };
}

test('memoryStore: remember/list/recall roundtrip with pinned default false', () => {
  const { store } = tmpStore();
  const u = store.remember('alpha', { scope: 'proj', text: 'The build needs electron-rebuild.' });
  assert.match(u.id, /^mem-\d+-[a-z0-9]+$/);
  const units = store.list('alpha');
  assert.strictEqual(units.length, 1);
  assert.strictEqual(units[0].pinned, false);
  assert.strictEqual(units[0].scope, 'proj');
  assert.strictEqual(store.recall('alpha', 'electron-rebuild').id, u.id);
});

test('memoryStore: remember with pinned=true saves pinned in one write', () => {
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { scope: 'ops', text: 'Boot rules ride pinned.', pinned: true });
  assert.strictEqual(u.pinned, true);
  const [unit] = store.list('alpha');
  assert.strictEqual(unit.pinned, true);
  const raw = fs.readFileSync(path.join(dir, 'alpha', `${u.id}.md`), 'utf-8');
  assert.strictEqual(parseMemoryUnit(raw).meta.pinned, 'true');
});

test('memoryStore: remember persists tags, and omits the key entirely when empty', () => {
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { scope: 'ops', tags: 'hints,security', text: 'tagged fact' });
  assert.strictEqual(store.list('alpha')[0].tags, 'hints,security');
  // Untagged units keep the pre-tags byte shape, the same contract `pinned` has.
  const bare = store.remember('beta', { text: 'untagged fact' });
  const raw = fs.readFileSync(path.join(dir, 'beta', `${bare.id}.md`), 'utf-8');
  assert.strictEqual(parseMemoryUnit(raw).meta.tags, undefined);
  assert.ok(!raw.includes('tags:'), 'no empty tags key on an untagged unit');
  assert.strictEqual(u.id.startsWith('mem-'), true);
});

test('memoryStore: pin survives the file roundtrip and preserves meta', () => {
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { scope: 'ops', text: 'Never flap wire-strip on a warm cache.' });
  store.setPinned('alpha', u.id, true);
  const [unit] = store.list('alpha');
  assert.strictEqual(unit.pinned, true);
  assert.strictEqual(unit.scope, 'ops');
  assert.strictEqual(unit.learned_at, u.learned_at);
  // unpin removes the key from the file entirely (pre-pin byte shape)
  store.setPinned('alpha', u.id, false);
  const raw = fs.readFileSync(path.join(dir, 'alpha', `${u.id}.md`), 'utf-8');
  assert.strictEqual(parseMemoryUnit(raw).meta.pinned, undefined);
});

test('memoryStore: an unknown frontmatter key survives the setPinned ROUND TRIP', () => {
  // Round trip is the whole test. parse was never the broken half — it read
  // every key already — so a test that writes tags and reads them back through
  // parseMemoryUnit alone PASSES against the allowlist serializer that drops
  // them. Only serialize(parse(x)), which is what setPinned does, can fail.
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { text: 'unit with curation metadata' });
  const file = path.join(dir, 'alpha', `${u.id}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(
    `source: alpha`, `source: alpha\ntags: plugins,ipc\nsuperseded_by: mem-9-zzz`));

  store.setPinned('alpha', u.id, true);

  const after = parseMemoryUnit(fs.readFileSync(file, 'utf-8')).meta;
  assert.strictEqual(after.tags, 'plugins,ipc', 'pin deleted the tags key');
  assert.strictEqual(after.superseded_by, 'mem-9-zzz', 'pin deleted an unknown key');
  assert.strictEqual(after.pinned, 'true');
  // pinned stays LAST: unpin removes that line, and any key emitted after it
  // would leave the pre-pin byte shape unrecoverable.
  const keys = fs.readFileSync(file, 'utf-8').split('\n---')[0].split('\n')
    .map(l => (l.match(/^(\w+):/) || [])[1]).filter(Boolean);
  assert.deepStrictEqual(keys, ['id', 'scope', 'learned_at', 'source', 'tags', 'superseded_by', 'pinned']);
});

test('memoryStore: a unit with no unknown keys is byte-identical after pin+unpin', () => {
  // The property the passthrough must not cost: a pre-tag file on disk today
  // must not be rewritten into a new shape by this change.
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { scope: 'ops', text: 'plain pre-tag unit' });
  const file = path.join(dir, 'alpha', `${u.id}.md`);
  const before = fs.readFileSync(file, 'utf-8');
  store.setPinned('alpha', u.id, true);
  store.setPinned('alpha', u.id, false);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before);
});

test('memoryStore: recall matches a tag, and not an id or timestamp', () => {
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { text: 'a unit whose body never says the word' });
  const file = path.join(dir, 'alpha', `${u.id}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(
    'source: alpha', 'source: alpha\ntags: plugins,ipc'));

  // Read the unit out BEFORE dereferencing it: a miss returns null, so
  // `.id` inline would fail by TypeError instead of by message.
  const byTag = store.recall('alpha', 'plugins');
  assert.ok(byTag, 'a tag in the frontmatter was not searchable');
  assert.strictEqual(byTag.id, u.id);
  const byUpper = store.recall('alpha', 'IPC');
  assert.ok(byUpper, 'tag match is not case-insensitive like the body match');
  assert.strictEqual(byUpper.id, u.id);
  // The rest of the frontmatter stays OUT of the haystack: `learned_at` is an
  // ISO timestamp and the id is digits, so admitting them would make short
  // numeric queries match everything. Both substrings below are really present
  // in the file and must still miss.
  assert.strictEqual(store.recall('alpha', u.learned_at.slice(0, 4)), null, 'a year matched — frontmatter leaked into the haystack');
  assert.strictEqual(store.recall('alpha', 'mem-'), null, 'an id prefix matched — frontmatter leaked into the haystack');
});

test('memoryStore: forget deletes, and pin/forget reject non-id shapes (traversal guard)', () => {
  const { store } = tmpStore();
  const u = store.remember('alpha', { text: 'ephemeral' });
  store.forget('alpha', u.id);
  assert.strictEqual(store.list('alpha').length, 0);
  assert.throws(() => store.forget('alpha', '../alpha/x'), /invalid unit id/);
  assert.throws(() => store.setPinned('alpha', 'mem-1-UPPER', true), /invalid unit id/);
  assert.throws(() => store.forget('alpha', u.id), /no unit/); // already gone
});

test('memoryStore: the operator pin is capped, and REFUSES rather than evicting', () => {
  const { store } = tmpStore();
  const ids = [];
  for (let i = 0; i < OPERATOR_PIN_CAP + 1; i++) {
    ids.push(store.remember('alpha', { text: `unit ${i}` }).id);
  }
  for (let i = 0; i < OPERATOR_PIN_CAP; i++) store.setOperatorPinned('alpha', ids[i], true);
  // Silently evicting the oldest would look like the pin simply not working;
  // the operator set both deliberately, so the choice is theirs.
  assert.throws(() => store.setOperatorPinned('alpha', ids[OPERATOR_PIN_CAP], true),
    /operator pin limit reached/);
  assert.strictEqual(store.list('alpha').filter(u => u.operatorPinned).length, OPERATOR_PIN_CAP);
  // Re-pinning an ALREADY pinned unit is a no-op, not a cap violation — the
  // count excludes the unit under edit, or a UI that re-asserts state breaks.
  assert.doesNotThrow(() => store.setOperatorPinned('alpha', ids[0], true));
  // Unpin frees a slot.
  store.setOperatorPinned('alpha', ids[0], false);
  assert.doesNotThrow(() => store.setOperatorPinned('alpha', ids[OPERATOR_PIN_CAP], true));
});

test('memoryStore: agent pin and operator pin are INDEPENDENT flags', () => {
  // Collapsing them would erase which one a store's history came from the
  // moment either is written, and the digest treats them as different claims.
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { text: 'both flags', pinned: true });
  store.setOperatorPinned('alpha', u.id, true);
  let unit = store.list('alpha')[0];
  assert.strictEqual(unit.pinned, true);
  assert.strictEqual(unit.operatorPinned, true);
  const raw = fs.readFileSync(path.join(dir, 'alpha', `${u.id}.md`), 'utf-8');
  assert.match(raw, /^pinned: true$/m);
  assert.match(raw, /^operator_pinned: true$/m);
  // Clearing one leaves the other standing.
  store.setOperatorPinned('alpha', u.id, false);
  unit = store.list('alpha')[0];
  assert.strictEqual(unit.pinned, true, 'unpinning the operator flag must not clear the agent flag');
  assert.strictEqual(unit.operatorPinned, false);
  store.setPinned('alpha', u.id, false);
  assert.strictEqual(store.list('alpha')[0].pinned, false);
});

// --- the unit open ---------------------------------------------------------
// An agent writes its own memory folder, and list()/_setFlag run in the MAIN
// process (the boot digest, liveKeys, the hint retriever). A file there can be
// a pipe or a hardlink to something outside the store, so the open is judged
// through the fd rather than by path.

const MEMORY_STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'memory-store.js'), 'utf-8');

// BOTH tokens, because either one alone still hangs. O_NONBLOCK is what lets
// the OPEN return on a writerless pipe; isFile() is what stops the READ that
// follows, which blocks on the same pipe even through a non-blocking fd
// (measured: dropping only isFile() hung this file with no output).
const OPEN_SHAPE = [/O_NONBLOCK/, /isFile\(\)/];

// Declared BEFORE the FIFO subjects because it is what keeps their failure
// readable: a blocking read never returns, so it stops the event loop the test
// timeout itself lives on and the runner hangs with zero output instead of
// reddening. This subject turns that regression into one red line, and the
// subjects below skip when it fails so the run still finishes.
test('memoryStore: the unit open stays non-blocking — without it a planted FIFO hangs the suite', () => {
  for (const re of OPEN_SHAPE) {
    assert.match(MEMORY_STORE_SRC, re,
      `${re} is gone: a planted FIFO then hangs the main process at agent boot, and hangs this suite with no output`);
  }
});

const fifoSkip = process.platform === 'win32'
  ? 'mkfifo and O_NOFOLLOW are POSIX-only'
  : (OPEN_SHAPE.every((re) => re.test(MEMORY_STORE_SRC))
    ? false
    : 'the non-blocking open shape is gone from memory-store.js — see the source-shape pin above');

test('memoryStore: a FIFO planted beside a real unit is skipped and list() RETURNS', { skip: fifoSkip }, () => {
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { text: 'the control body' });
  execFileSync('mkfifo', [path.join(dir, 'alpha', 'planted.md')]);

  // The assertion that matters is that this line is ever reached: a blocking
  // read of a writerless FIFO never returns, and list() runs at agent boot.
  const units = store.list('alpha');

  // ENTER: the control unit survives, so the absence below is the pipe being
  // refused and not the whole folder going dark.
  assert.deepStrictEqual(units.map(x => x.id), [u.id],
    'the pipe is absent and the real unit beside it survives');
  assert.strictEqual(units[0].body, 'the control body');
  assert.ok(fs.existsSync(path.join(dir, 'alpha', 'planted.md')),
    'the refusal is a read refusal — it deletes nothing');
});

test('memoryStore: _setFlag on a planted FIFO throws no unit', { skip: fifoSkip }, () => {
  const { store, dir } = tmpStore();
  const control = store.remember('alpha', { text: 'pin me' });
  const id = 'mem-9-fifo';
  execFileSync('mkfifo', [path.join(dir, 'alpha', `${id}.md`)]);

  assert.throws(() => store.setPinned('alpha', id, true), /no unit mem-9-fifo/,
    'a refused open is the same miss as an absent file, and it must not block first');
  // CONTROL: the refusal is about THIS file, not about pinning being broken.
  store.setPinned('alpha', control.id, true);
  assert.strictEqual(store.list('alpha').find(x => x.id === control.id).pinned, true);
});

test('memoryStore: a hardlinked unit is not listed, so recall and the viewer agree', () => {
  // The viewer already refuses these; core listing them would serve a unit in
  // recall that the overlay hides. A hardlink's realpath is in-dir, so only the
  // fd's nlink can see it.
  const { store, dir } = tmpStore();
  const u = store.remember('alpha', { text: 'the control body' });
  const outside = mkTmpRoot('clodex-mem-outside-');
  const secret = path.join(outside, 'secret.md');
  fs.writeFileSync(secret, '---\nid: mem-1-secret\nlearned_at: 2026-07-30T10:00:00.000Z\n---\n\nHARDLINKED BODY\n');
  fs.linkSync(secret, path.join(dir, 'alpha', 'planted.md'));

  const units = store.list('alpha');

  // ENTER: the control unit survives, so the absence below is the hardlink
  // being refused and not the whole folder going dark.
  assert.deepStrictEqual(units.map(x => x.id), [u.id],
    'the hardlink is absent and the real unit beside it survives');
  assert.strictEqual(JSON.stringify(units).includes('HARDLINKED BODY'), false,
    'the outside file\'s text never reaches a caller, under any key');
  assert.ok(fs.existsSync(secret), 'the refusal is a read refusal — it deletes nothing');
});

// --- digest ---------------------------------------------------------------

const NOW = Date.parse('2026-07-08T12:00:00Z');
function unit(id, { pinned = false, operatorPinned = false, scope = '', body = 'body of ' + id, daysAgo = 1 } = {}) {
  return {
    id, scope, pinned, operatorPinned, body,
    learned_at: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    source: 'test',
  };
}

test('composeDigest: empty store is null (no digest, conversation stays unmarked)', () => {
  assert.strictEqual(composeDigest([]), null);
  assert.strictEqual(composeDigest(null), null);
});

test('composeDigest: operator pins in full, then recent short bodies, rest as index', () => {
  const d = composeDigest([
    unit('mem-1-aaaaaa', { operatorPinned: true, daysAgo: 40, body: 'Settled: no auto-sweep.\nSecond line rides too.' }),
    unit('mem-2-bbbbbb', { daysAgo: 3, scope: 'proj', body: 'Older index item' }),
    unit('mem-3-cccccc', { daysAgo: 1, body: 'Newer index item' }),
  ], { now: NOW });
  // The operator pin rides in full DESPITE being the oldest unit here — that is
  // the whole difference between the two tiers.
  assert.match(d, /## mem-1-aaaaaa\nSettled: no auto-sweep\.\nSecond line rides too\./);
  const newer = d.indexOf('mem-3-cccccc');
  const older = d.indexOf('mem-2-bbbbbb');
  assert.ok(newer !== -1 && older !== -1 && newer < older, 'recent tier is newest-first');
});

test('composeDigest: a long unit is NEVER served in full, however recent', () => {
  // The cap is what converts the budget from 2 bodies into several. A unit over
  // RECENT_BODY_CAP falls to an index line even when it is the newest thing in
  // the store and the budget is untouched.
  const d = composeDigest([
    unit('mem-1-longone', { daysAgo: 0, body: 'L'.repeat(RECENT_BODY_CAP + 1) }),
    unit('mem-2-shorter', { daysAgo: 5, body: 'S'.repeat(100) }),
  ], { now: NOW });
  assert.doesNotMatch(d, /## mem-1-longone/, 'over the cap must not ride in full');
  assert.ok(d.includes('mem-1-longone'), 'but it must still be reachable as a line');
  assert.match(d, /## mem-2-shorter\nS{100}/, 'the older SHORT unit rides instead');
});

test('composeDigest: an operator pin bypasses the per-unit cap', () => {
  // The operator asserted this text is worth its bytes. Silently demoting it
  // would make the one deliberate human signal unreliable.
  const big = 'B'.repeat(RECENT_BODY_CAP * 2);
  const d = composeDigest([
    unit('mem-1-opinned', { operatorPinned: true, body: big }),
  ], { now: NOW });
  assert.match(d, new RegExp(`## mem-1-opinned\\nB{${RECENT_BODY_CAP * 2}}`));
});

test('composeDigest: the operator cap bounds what the digest serves in full', () => {
  // Belt-and-braces against the store's own refusal: even if more than the cap
  // reach the composer (hand-edited files, a store written by an older build),
  // only OPERATOR_PIN_CAP of them ride, newest first.
  const units = [];
  for (let i = 0; i < OPERATOR_PIN_CAP + 3; i++) {
    units.push(unit(`mem-${100 + i}-opinned`, { operatorPinned: true, daysAgo: 50 - i, body: `pin ${i}` }));
  }
  const d = composeDigest(units, { now: NOW });
  // Count the OPERATOR section alone: units past the cap are not privileged, but
  // they are not banished either — they fall back into the recent tier and ride
  // on their own merits, which is why the whole-digest body count is not the
  // measure here.
  const opSection = d.slice(d.indexOf('Pinned by the operator'), d.indexOf('Most recent'));
  const bodies = (opSection.match(/\n## mem-\d+-opinned\n/g) || []).length;
  assert.strictEqual(bodies, OPERATOR_PIN_CAP);
  // Newest wins the scarce slots.
  assert.match(opSection, new RegExp(`## mem-${100 + OPERATOR_PIN_CAP + 2}-opinned`));
});

test('composeDigest: the agent pin ORDERS the recent tier but never gates it', () => {
  // Same timestamp, so only the flag can break the tie — and an unpinned unit
  // must still be served, which is what makes it a boost rather than a gate.
  const d = composeDigest([
    unit('mem-1-plainer', { daysAgo: 2, body: 'p'.repeat(80) }),
    unit('mem-2-boosted', { daysAgo: 2, pinned: true, body: 'b'.repeat(80) }),
  ], { now: NOW });
  assert.ok(d.indexOf('## mem-2-boosted') < d.indexOf('## mem-1-plainer'), 'pinned wins the tie');
  assert.match(d, /## mem-1-plainer/, 'unpinned is still served — the flag is not a gate');
});

test('composeDigest: a NEWER unpinned unit still beats an older agent-pinned one', () => {
  // Recency is the primary key. If the flag could outrank it the tier would
  // drift back into the stale-pin failure this design exists to remove.
  const d = composeDigest([
    unit('mem-1-oldpin', { daysAgo: 30, pinned: true, body: 'o'.repeat(80) }),
    unit('mem-2-newest', { daysAgo: 1, body: 'n'.repeat(80) }),
  ], { now: NOW });
  assert.ok(d.indexOf('## mem-2-newest') < d.indexOf('## mem-1-oldpin'));
});

test('composeDigest: budget drops whole units and counts the overflow', () => {
  const units = [];
  for (let i = 0; i < 6; i++) {
    units.push(unit(`mem-${100 + i}-aaaaaa`, { daysAgo: 10 - i, body: 'x'.repeat(400) }));
  }
  const d = composeDigest(units, { budget: 2000, now: NOW });
  assert.ok(d.length < 2200); // header may nudge past, never a whole extra unit
  assert.match(d, /— \[agent:memory list\]\)/);
  // no unit is truncated mid-body: every included block ends with its full body
  const blocks = d.match(/## mem-\d+-aaaaaa\nx+/g) || [];
  assert.ok(blocks.length > 0);
  for (const b of blocks) assert.strictEqual(b.split('\n')[1].length, 400);
});

test('composeDigest: a unit whose body does not fit is listed, never dropped', () => {
  const d = composeDigest([
    unit('mem-1-oldest', { daysAgo: 9, body: 'x'.repeat(300) }),
    unit('mem-2-middle', { daysAgo: 5, body: 'y'.repeat(300) }),
    unit('mem-3-newest', { daysAgo: 1, body: 'z'.repeat(300) }),
  ], { budget: 1000, now: NOW });
  assert.doesNotMatch(d, /## mem-1-oldest/);
  assert.ok(d.includes('mem-1-oldest')); // the id is still reachable
});

test('composeDigest: a demoted OPERATOR pin is marked, an ordinary index entry is not', () => {
  // Two oversized operator pins against a budget that fits one: the loser keeps
  // its [pinned] marker in the index so the operator can see the pin exists and
  // did not ride, rather than concluding the pin was lost.
  const d = composeDigest([
    unit('mem-1-opinned', { operatorPinned: true, daysAgo: 9, body: 'x'.repeat(600) }),
    unit('mem-2-opinned', { operatorPinned: true, daysAgo: 1, body: 'z'.repeat(600) }),
    // Over the per-unit cap, so it lands in the index rather than riding —
    // which is what puts it beside the demoted pin for the ordering check.
    unit('mem-4-plainer', { daysAgo: 2, body: 'p'.repeat(RECENT_BODY_CAP + 1) }),
  ], { budget: 1500, now: NOW });
  assert.match(d, /\n- \[pinned\] mem-1-opinned /);
  assert.match(d, /\n- mem-4-plainer /);
  assert.ok(d.indexOf('[pinned] mem-1-opinned') < d.indexOf('- mem-4-plainer'),
    'demoted pins lead the index');
});

test('composeDigest: the tail counts the three cases separately, omitting empty clauses', () => {
  // everything fits: no tail at all
  const small = composeDigest([
    unit('mem-1-aaaaaa', { operatorPinned: true, body: 'short pin' }),
    unit('mem-2-bbbbbb', { body: 'short index' }),
  ], { now: NOW });
  assert.doesNotMatch(small, /\[agent:memory list\]/);

  // overflow only: the "+N more" clause, no full/title clauses
  const indexOnly = [];
  for (let i = 0; i < 40; i++) {
    indexOnly.push(unit(`mem-${200 + i}-bbbbbb`, { daysAgo: i + 1, body: `index item ${i}` }));
  }
  const di = composeDigest(indexOnly, { budget: 700, now: NOW });
  assert.match(di, /— \[agent:memory list\]\)$/);
  // Which clause fires depends on where the budget ran out, and that is not the
  // property under test — the tail existing and naming a nonzero withheld count
  // is. Asserting a specific clause here pins an implementation detail of the
  // fill order rather than the guarantee.
  assert.match(di, /(\d+) (?:listed by title only|omitted)|\+\d+ more/);
});

// The store this function actually runs against, not a toy one. Sized from the
// lead's live store measured 2026-08-02: 207 units, ~1175-byte mean body — the
// shape that made the OLD policy serve two bodies out of 130 pins.
function bigStore(n, { bytes = 1200 } = {}) {
  const units = [];
  for (let i = 0; i < n; i++) {
    units.push(unit(`mem-${100 + i}-aaaaaa`, {
      // Agent-pinned, as the live store is: under this policy the flag orders
      // but does not admit, so a store where EVERY unit carries it must behave
      // exactly like a store where none does.
      pinned: true,
      daysAgo: n - i,
      body: `settled position ${i}\n${'x'.repeat(bytes)}`,
    }));
  }
  return units;
}

test('composeDigest: a 110-unit store of LONG bodies serves none of them in full', () => {
  // THE regression this policy exists to fix, stated as the composer sees it.
  // The live store served 2 bodies from 130 pins and reported nothing wrong; a
  // store of over-cap units must now serve ZERO bodies and say so, rather than
  // spending the whole body budget on two arbitrary essays.
  const d = composeDigest(bigStore(110), { budget: DIGEST_BUDGET, now: NOW });
  const bodies = (d.match(/\n## mem-\d+-aaaaaa\n/g) || []).length;
  assert.strictEqual(bodies, 0, 'every body is over RECENT_BODY_CAP, so none rides');
  assert.ok(d.length <= DIGEST_BUDGET, `digest is ${d.length} bytes, over the ${DIGEST_BUDGET} budget`);
  // The bytes go to reachability instead: index lines for as many as fit.
  const lines = (d.match(/\n- mem-\d+-aaaaaa /g) || []).length;
  assert.ok(lines > 40, `expected the budget to buy index lines, got ${lines}`);
});

test('composeDigest: SHORT units at scale get many bodies from the same budget', () => {
  // The other side of the cap, and the reason it is an incentive rather than a
  // bound: the identical budget that served 0 long bodies above serves a dozen
  // short ones. This is what the write-time guidance is asking agents to earn.
  const d = composeDigest(bigStore(110, { bytes: 200 }), { budget: DIGEST_BUDGET, now: NOW });
  const bodies = (d.match(/\n## mem-\d+-aaaaaa\n/g) || []).length;
  assert.ok(bodies >= 10, `expected short units to ride in bulk, got ${bodies}`);
  assert.ok(d.length <= DIGEST_BUDGET, `digest is ${d.length} bytes, over budget`);
  const bodyBytes = (d.match(/\n## mem-\d+-aaaaaa\n[^\n]*\nx+/g) || [])
    .reduce((n, b) => n + b.length, 0);
  assert.ok(bodyBytes <= DIGEST_BUDGET / 2, `bodies took ${bodyBytes}, starving the index`);
});

test('composeDigest: at scale every withheld unit is still counted', () => {
  // The reachability guarantee, unchanged by the rewrite: nothing withheld goes
  // unaccounted. The tail is the only thing a reader of the digest has, so the
  // arithmetic is read back from the tail's own words rather than recomputed.
  const units = bigStore(97, { bytes: 880 });
  const d = composeDigest(units, { budget: DIGEST_BUDGET, now: NOW });
  const shown = (d.match(/\n## mem-\d+-aaaaaa\n/g) || []).length;
  const listed = (d.match(/\n- (?:\[pinned\] )?mem-\d+-aaaaaa /g) || []).length;
  // No tail when nothing was withheld — every unit got at least a line, which is
  // itself the guarantee. Treat the absent tail as zeros rather than requiring
  // one, or the test fails on the BEST outcome.
  const tail = d.match(/\((.+) — \[agent:memory list\]\)$/);
  const say = re => {
    if (!tail) return 0;
    const m = tail[1].match(re);
    return m ? Number(m[1]) : 0;
  };
  assert.strictEqual(shown + listed + say(/\+(\d+) more/) + say(/(\d+) omitted/), 97,
    'every unit is served, listed or counted');
  assert.ok(listed > 0, 'long units must still be reachable by line');
});

test('composeDigest: the digest never exceeds its budget, whatever the mix', () => {
  // One bound that must hold across the tier interactions, since three fills now
  // share the budget and each was individually bounded before the rewrite.
  for (const bytes of [80, 300, 601, 1200, 4000]) {
    for (const n of [1, 5, 60, 200]) {
      const units = bigStore(n, { bytes });
      // Salt in operator pins, which bypass the per-unit cap and so are the most
      // likely thing to push a mixed store over.
      for (let i = 0; i < Math.min(OPERATOR_PIN_CAP, units.length); i++) units[i].operatorPinned = true;
      const d = composeDigest(units, { budget: DIGEST_BUDGET, now: NOW });
      assert.ok(d === null || d.length <= DIGEST_BUDGET,
        `n=${n} bytes=${bytes}: digest is ${d && d.length} bytes, over ${DIGEST_BUDGET}`);
    }
  }
});
