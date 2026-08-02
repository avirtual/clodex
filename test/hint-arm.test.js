// Run: node --test
// t139 — automatic contextual hint arming: accumulate the user's draft, rank the
// agent's memory against it, and register the winner as a ONE-SHOT tail hint
// before Enter is pressed.
//
// TWO ASYMMETRIES DRIVE EVERY CASE BELOW.
//
// (1) Suppression. A false ABSENT costs a few hundred redundant tail tokens; a
// false FULL silently withholds something the model needed and leaves no trace
// in any log. So TITLE is asserted to NOT suppress (the model knows the unit
// exists and cannot read it — the single best hint case), and a loadState that
// THROWS is asserted to still offer.
//
// (2) The keystroke. A hint is worth nothing next to the user's byte reaching
// the PTY, so the proxy-down case asserts delivery, not just absence of throw.
//
// THE `once` TRAP, which the ticket calls out and which cost the lead hours: the
// server accepts unknown keys, drops them silently and returns 200 — posting
// `pop:true` registers a STANDING hint whose logs read exactly like a pop. A 200
// and a registry echo are NOT evidence. The one-shot case here runs a real HTTP
// server that stores what it was actually sent and reads `once` back off the
// stored record.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  foldDraft, createHintArm, DRAFT_CAP, HINT_ID, TTL_S,
} = require('../hint-arm');
const {
  rank, compose, terms, haystack, selfScore,
  createMemoryRetriever, createCommonRetriever, createCompositeRetriever,
  unitsAsRecords, minScoreFor, confidenceOf, MIN_HITS, MIN_COVERAGE,
} = require('../hint-retrieve');
const { ProxyClient } = require('../wirescope-proxy');
const { createMemoryStore } = require('../memory-store');
const { createMemoryLoad } = require('../memory-load');
const { createSessionManager } = require('../session-manager');
const { pathFor, runDirFor } = require('../clodex-paths');

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// --- draft accumulation ----------------------------------------------------

test('fold: printable bytes accumulate and backspace truncates', () => {
  let d = '';
  for (const c of 'wirescope') d = foldDraft(d, c).draft;
  assert.strictEqual(d, 'wirescope');
  d = foldDraft(d, '\x7f').draft;
  assert.strictEqual(d, 'wirescop', 'DEL truncates by one');
  d = foldDraft(d, '\b\b').draft;
  assert.strictEqual(d, 'wiresc', 'backspace truncates too, once per byte');
  // Backspacing past the start must not produce a negative-length artefact.
  d = foldDraft('ab', '\x7f\x7f\x7f\x7f').draft;
  assert.strictEqual(d, '', 'over-backspacing empties rather than underflowing');
});

test('fold: a bracketed paste accumulates and its interior \\r does NOT close', () => {
  const r = foldDraft('', `${PASTE_START}alpha beta\rgamma delta${PASTE_END}`);
  // The \r is KEPT as a literal pasted byte, not swallowed: dropping it would
  // fuse "beta" and "gamma" into `betagamma`, a token the user never typed and
  // that the ranker would then treat as a rare, highly-weighted term.
  assert.strictEqual(r.draft, 'alpha beta\rgamma delta',
    'every pasted byte accumulates, interior \\r included — treating it as Enter would arm off half '
    + 'a paste and reset the accumulator mid-paste');
  assert.deepStrictEqual(terms(r.draft), ['alpha', 'beta', 'gamma', 'delta'],
    'the tokenizer must see four words, not a fabricated compound');
  assert.strictEqual(r.closes, false,
    'the CLI treats an interior \\r as literal — a paste does not submit, so treating it as Enter '
    + 'would arm off half a draft and reset the accumulator mid-paste');
  assert.strictEqual(r.inPaste, false, 'the region closed');
  // node-pty splits large pastes across reads, so the region must survive a
  // chunk boundary — a paste that "ends" at the boundary would let the next
  // chunk's \r submit.
  const a = foldDraft('', `${PASTE_START}first half\r`);
  assert.strictEqual(a.inPaste, true, 'an unterminated region stays open across chunks');
  assert.strictEqual(a.closes, false);
  const b = foldDraft(a.draft, `second half\r${PASTE_END}`, a.inPaste);
  assert.strictEqual(b.draft, 'first half\rsecond half\r');
  assert.strictEqual(b.closes, false, 'still inside the region on the second chunk');
});

// An append-only accumulator desyncs from the screen on any edit that is not
// the backspace key, and the divergence survives until Enter — which is exactly
// when it gets ranked. Each row is what the TERMINAL shows after those bytes.
test('fold: line edits track what the terminal actually shows', () => {
  const type = (chunks) => {
    let st = '';
    for (const c of chunks) st = foldDraft(st, c);
    return st;
  };
  const cases = [
    ['backspace', ['deploy the helm chart', '\x7f\x7f\x7f\x7f\x7f'], 'deploy the helm '],
    ['Ctrl-W kills the word before the cursor', ['deploy the helm chart', '\x17'], 'deploy the helm '],
    ['Ctrl-A then Ctrl-K clears the line', ['deploy the helm chart', '\x01\x0b'], ''],
    ['left arrows then typing inserts mid-line', ['helm chart', '\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D', 'BIG '], 'helm BIG chart'],
    ['Home then typing prepends', ['chart', '\x1b[H', 'helm '], 'helm chart'],
    ['End returns to the tail', ['chart', '\x1b[H', '\x1b[F', 's'], 'charts'],
    ['Delete removes forward', ['helm chart', '\x1b[H', '\x1b[3~'], 'elm chart'],
    ['Alt-B jumps a word back', ['helm chart', '\x1bb', 'BIG '], 'helm BIG chart'],
    ['Ctrl-D deletes forward', ['helm chart', '\x01\x04'], 'elm chart'],
  ];
  for (const [what, chunks, expected] of cases) {
    const r = type(chunks);
    assert.strictEqual(r.draft, expected,
      `${what}: the ranker would see ${JSON.stringify(r.draft)} while the screen shows `
      + `${JSON.stringify(expected)} — every word in the gap is ranked but no longer on screen`);
    assert.strictEqual(r.desync, false, `${what} is fully modelable and must not set desync`);
  }
});

test('fold: an unmodelable edit sets desync rather than guessing', () => {
  // History recall and tab completion replace the line with text that never
  // passed through foldDraft. There is no recovery, so the flag is sticky and
  // the caller must not arm.
  for (const [what, keys] of [
    ['history up', '\x1b[A'], ['history down', '\x1b[B'],
    ['tab completion', '\t'], ['Ctrl-Y yank', '\x19'], ['Ctrl-T transpose', '\x14'],
  ]) {
    const r = foldDraft(foldDraft('', 'deploy the helm chart'), keys);
    assert.strictEqual(r.desync, true,
      `${what} rewrites the line invisibly — arming on the stale text would rank a question the `
      + 'user never asked, with full confidence');
  }
  // Sticky: a later keystroke must not clear it.
  const stuck = foldDraft(foldDraft(foldDraft('', 'helm'), '\t'), ' chart');
  assert.strictEqual(stuck.desync, true, 'desync survives further typing — there is no way back');
  // Ctrl-U starts over, which IS a way back.
  assert.strictEqual(foldDraft(stuck, '\x15').desync, false, 'clearing the line restores a known state');
});

test('fold: Ctrl-C and Ctrl-U clear the draft and report `cleared`, not `closes`', () => {
  for (const key of ['\x03', '\x15']) {
    const r = foldDraft('half a question', key);
    assert.strictEqual(r.draft, '', `${JSON.stringify(key)} empties the accumulator`);
    assert.strictEqual(r.cleared, true, `${JSON.stringify(key)} must report cleared`);
    assert.strictEqual(r.closes, false,
      'abandon and submit are DIFFERENT outcomes even though draftChunkSignal reports \\x03 as a '
      + 'close: a submit does a final arm pass, an abandon must DELETE the armed hint. Conflating '
      + 'them arms a hint off a draft the user threw away, which then pops on whatever they type next');
  }
  // \x03 inside a paste region is a literal pasted byte, not an abort.
  const p = foldDraft('', `${PASTE_START}a\x03b${PASTE_END}`);
  assert.strictEqual(p.cleared, false, 'a pasted \\x03 must not clear the draft');
  assert.strictEqual(p.draft, 'a\x03b');
});

test('fold: Enter closes and the draft survives the call for a final pass', () => {
  const r = foldDraft('why did the mutant escape', '\r');
  assert.strictEqual(r.closes, true);
  assert.strictEqual(r.cleared, false);
  assert.strictEqual(r.draft, 'why did the mutant escape',
    'the reset is the CALLER\'s job, after the final arm — clearing here would rank an empty draft');
});

test('fold: the 4KB cap stops accumulation and reports overflow', () => {
  const r = foldDraft('', 'x'.repeat(DRAFT_CAP + 500));
  assert.strictEqual(r.draft.length, DRAFT_CAP, 'accumulation stops at the cap');
  assert.strictEqual(r.overflow, true, 'and says so — a pasted wall of text is not a question');
  // Sticky: still overflowed on the next keystroke, so the arm stays off until
  // the draft is reset rather than flapping.
  const next = foldDraft(r.draft, 'y');
  assert.strictEqual(next.overflow, true, 'overflow persists while the draft is still at the cap');
  assert.strictEqual(next.draft.length, DRAFT_CAP, 'and nothing more is appended');
});

test('fold: CSI bytes never land in the draft as content', () => {
  // Arrow keys arrive as ESC [ A. Without a CSI skip the '[' and 'A' land in the
  // draft as text and poison the ranking with letters the user never typed.
  // These sequences MOVE the cursor rather than being discarded (see the
  // line-edit test), so assert on the bytes, not on the text being untouched.
  const r = foldDraft('memory', '\x1b[D\x1b[C\x1b[H\x1b[F');
  assert.strictEqual(r.draft, 'memory', 'pure cursor motion leaves the text alone');
  assert.ok(!/[[\x1b]|3~|OD/.test(r.draft), 'no escape-sequence bytes reached the draft');
  assert.strictEqual(r.closes, false);

  // A sequence split across a node-pty read boundary cannot be completed, and
  // its tail would arrive next chunk as bare content ("D", "3~").
  const split = foldDraft('memory', '\x1b[');
  assert.strictEqual(split.draft, 'memory', 'the partial sequence contributes nothing');
  assert.strictEqual(split.desync, true,
    'an unterminated CSI means the next chunk starts mid-sequence — its tail would be read as text');
});

// --- ranking ---------------------------------------------------------------

function mkStore(units) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-hintarm-'));
  const store = createMemoryStore(path.join(root, 'library', 'memory'));
  const ids = units.map((u) => store.remember('a', { text: u.text, scope: u.scope || '' }).id);
  return { root, store, ids };
}

const CORPUS = [
  { text: 'The wirescope tail hint registry keeps one slot per route and expires it by ttl.' },
  { text: 'Release is one command: scripts/release.sh bumps, builds the dmg and tags.' },
  { text: 'Sessions are keyed by name globally, so two windows cannot share a name.' },
  { text: 'Bash sessions are private: no registry, no socket, invisible to who.' },
  { text: 'Ad-hoc signing must happen in afterPack or node-pty dies on Apple Silicon.' },
  { text: 'The digest budget reserves half its bytes for index lines so pins cannot starve them.' },
];

test('rank: the floor is DERIVED from corpus size, not a constant', () => {
  // hint-probe's MIN_SCORE=2 was tuned at N=4 and does not transfer: at N=179 a
  // single df=1 term is worth log(1+179)=5.19 on its own, so any absolute floor
  // at or below that is cleared by one coincidental rare word.
  assert.ok(minScoreFor(4) < minScoreFor(179),
    'the floor must MOVE with N — a constant is exactly the bug this replaces');
  assert.strictEqual(minScoreFor(179).toFixed(2), '5.19',
    'the floor is the weight of one maximally-rare term: log(1+N)');
  assert.strictEqual(minScoreFor(4).toFixed(2), '1.61');
});

test('rank: one lucky rare term does not arm, several matching terms do', () => {
  const { store, ids } = mkStore(CORPUS);
  const recs = require('../hint-retrieve').unitsAsRecords(store.list('a'));

  // "afterpack" is df=1 here and clears the score floor ALONE. It is the shape
  // of a coincidence — a draft about packing a suitcase should not surface the
  // signing gotcha — and it is why MIN_HITS exists alongside the floor.
  const oneTerm = rank(recs, 'afterpack', { limit: 3 });
  assert.deepStrictEqual(oneTerm, [],
    `a single-term match must not arm even when it clears the score floor (MIN_HITS=${MIN_HITS}); `
    + 'the two populations OVERLAP on score alone — measured against the live store, unrelated '
    + 'drafts topped out at 5.59 and related ones bottomed at 5.19, so a bigger number is not the fix');

  const many = rank(recs, 'how does the wirescope tail hint registry expire a slot', { limit: 3 });
  assert.ok(many.length >= 1, 'a draft sharing several rare terms must arm');
  assert.strictEqual(many[0].id, ids[0], 'and the winner is the unit those terms came from');
  assert.ok(many[0].evidence.hits.length >= MIN_HITS, 'the winner cleared the hit floor');
  assert.ok(many[0].evidence.score >= many[0].evidence.floor, 'and the score floor');
});

// WHY MIN_HITS CANNOT SIMPLY BE LOWERED TO 1, measured 2026-08-03 while trying
// to make short personal questions ("where do i live") arm against the common
// store. `score` sums log(1 + N/df) over MATCHED TERMS ONLY, and every term in
// that sum is a property of the CORPUS, not of the record. So for a one-term
// query every matching record scores IDENTICALLY and the ranker has no
// discriminator left — the winner is decided by the id tiebreak in the sort.
// Against the live 1650-unit store "live" tied 28 records at 4.09 and the
// id-winner was a Terraform note, not anything about where the user lives.
//
// A single-term query also defeats the coverage cut by construction: score ==
// selfScore, so coverage is exactly 1.0 for every candidate. MIN_HITS is the
// only surviving check, which is why relaxing it turns arming into a coin flip
// rather than a retrieval improvement. Fixing short queries needs a per-record
// signal (term frequency, length normalisation, or embeddings), not a lower bar.
test('rank: a one-term query cannot be ranked — every match ties, so MIN_HITS is load-bearing', () => {
  const recs = [
    { id: 'r1', text: 'the cadence of a release train', tags: '', scope: '' },
    { id: 'r2', text: 'cadence cadence cadence cadence — entirely about cadence', tags: '', scope: '' },
    { id: 'r3', text: 'unrelated note that also says cadence once', tags: '', scope: '' },
  ];
  for (let i = 0; i < 60; i += 1) {
    recs.push({ id: `f${i}`, text: `filler ${i} about archives, tabs and worktrees`, tags: '', scope: '' });
  }

  // r2 is overwhelmingly the most ON-TOPIC record for "cadence", but the scorer
  // cannot express that: it counts the term once per record regardless of how
  // often it appears or how long the record is.
  const df = new Map();
  for (const r of recs) for (const t of new Set(terms(haystack(r)))) df.set(t, (df.get(t) || 0) + 1);
  const scoreOf = (r) => (new Set(terms(haystack(r))).has('cadence')
    ? Math.log(1 + recs.length / df.get('cadence')) : 0);
  assert.strictEqual(scoreOf(recs[0]), scoreOf(recs[1]),
    'a record mentioning the term once scores the same as one entirely about it');
  assert.strictEqual(scoreOf(recs[1]), scoreOf(recs[2]),
    'and the same as an unrelated record that happens to contain it — no discriminator exists');

  // Coverage cannot break the tie either: with one query term it is 1.0 for all.
  const self = selfScore(['cadence'], df, recs.length);
  assert.strictEqual(scoreOf(recs[2]) / self, 1,
    'a one-term query makes coverage exactly 1.0, so that cut is inert here');

  // Hence: silent. Arming would mean picking one of three indistinguishable
  // records by id, which is what MIN_HITS prevents.
  assert.deepStrictEqual(rank(recs, 'cadence', { limit: 1 }), [],
    'a one-term query must stay silent rather than arm on an arbitrary tie member');
});

// The floor cannot see query length: a long draft accumulates matched weight for
// free and clears it on volume. Every stray hint observed in production on
// 2026-08-01 was a long message. Coverage is scale-free — the winner's score
// over the most any record COULD have scored on this query.
test('rank: padding a draft with unrelated words must not manufacture a match', () => {
  const { store, ids } = mkStore(CORPUS);
  const recs = require('../hint-retrieve').unitsAsRecords(store.list('a'));

  const real = rank(recs, 'how does the wirescope tail hint registry expire a slot', { limit: 1 });
  assert.strictEqual(real.length, 1, 'the honest draft must still arm');
  assert.strictEqual(real[0].id, ids[0]);
  assert.ok(real[0].evidence.coverage >= MIN_COVERAGE,
    `a draft that is mostly ABOUT the winner must cover it: ${real[0].evidence.coverage}`);

  // The same two matching terms, buried in a message about something else. The
  // absolute score is IDENTICAL — only the denominator moved — so a test that
  // asserted on score alone could not tell these two cases apart.
  const padded = rank(recs, 'i was reading about ad-hoc signing in afterpack while '
    + 'planning dinner reservations downtown for saturday evening with the whole family '
    + 'and wondering whether the restaurant takes bookings by telephone', { limit: 1 });
  assert.deepStrictEqual(padded, [],
    'a couple of matching terms adrift in an unrelated message must not arm — this is the '
    + 'stray-hint shape measured in production, where every false arm came from a long draft');
});

test('rank: coverage reaches 1.0 for a draft made only of the winner terms', () => {
  const { store } = mkStore(CORPUS);
  const recs = require('../hint-retrieve').unitsAsRecords(store.list('a'));
  // selfScore and score must apply the SAME discrimination cut. If the
  // denominator counts terms the numerator discards, a perfect match tops out
  // below 1.0 and every threshold derived from coverage silently shifts.
  const r = rank(recs, 'wirescope tail hint registry slot expires ttl', { limit: 1 });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].evidence.coverage.toFixed(2), '1.00',
    'a draft whose every discriminating term is in the winner must cover it fully — a lower '
    + 'number means the two cuts have drifted apart');
});

test('rank: coverage rejects on the ratio, not on the absolute score', () => {
  const { store } = mkStore(CORPUS);
  const recs = require('../hint-retrieve').unitsAsRecords(store.list('a'));
  const core = 'ad-hoc signing afterpack';
  const bare = rank(recs, core, { limit: 1 });
  assert.strictEqual(bare.length, 1, 'the bare terms arm on their own');

  // Pad until it fails, then prove WHY: the winner's raw score never dropped.
  const padded = rank(recs, `${core} dinner reservations downtown saturday evening telephone `
    + 'bicycle brake pads portuguese translation nephew birthday', { limit: 1 });
  assert.deepStrictEqual(padded, [], 'the same terms in a long unrelated draft do not arm');
  assert.ok(bare[0].evidence.score >= bare[0].evidence.floor,
    'and the score that WOULD have armed still clears the old floor — the floor did not reject '
    + 'this, coverage did, which is why both cuts have to exist');
});

test('rank: confidence is a documented 0-1 band, floor maps to 0.5', () => {
  // Scores from different retrievers are not comparable (lexical IDF reaches 12
  // on the real corpus, cosine tops out at 1), so each retriever normalises. IDF
  // is unbounded above, hence a saturation point rather than a max.
  const floor = minScoreFor(100);
  assert.strictEqual(confidenceOf(floor, floor), 0.5, 'the floor is the midpoint of the band');
  assert.strictEqual(confidenceOf(2 * floor, floor), 1, 'twice the floor saturates');
  assert.strictEqual(confidenceOf(50 * floor, floor), 1, 'and never exceeds 1');
  const { store } = mkStore(CORPUS);
  for (const r of rank(require('../hint-retrieve').unitsAsRecords(store.list('a')),
    'the wirescope tail hint registry slot ttl', { limit: 3 })) {
    assert.ok(r.confidence > 0 && r.confidence <= 1, `confidence ${r.confidence} is outside 0-1`);
  }
});

test('compose: a long body is offered by title with a recall pointer, a short one rides whole', () => {
  const short = compose([{ id: 'mem-1-a', text: 'a short claim' }]);
  assert.ok(short.includes('a short claim'), 'a short body rides in full');
  const long = compose([{ id: 'mem-2-b', text: `A title line\n${'x'.repeat(900)}` }]);
  assert.ok(!long.includes('x'.repeat(900)), 'a long body does NOT ride in full');
  assert.ok(long.includes('[agent:memory recall] mem-2-b'),
    'a truncated offer must carry the way to load it, or the model is told a unit exists and given '
    + 'no way to read it');
  assert.strictEqual(compose([]), null, 'nothing to offer composes to null, never an empty hint');
  // A non-empty result whose bodies are all blank is a DIFFERENT branch from
  // the empty-list guard above, and it is the one that matters: composing here
  // would register a hint that is nothing but the preamble — tail budget spent
  // telling the model "this may relate to what you are asking" about nothing.
  assert.strictEqual(compose([{ id: 'mem-3-c', text: '   ' }]), null,
    'a result set whose bodies are all blank must compose to null, not to a bare preamble');
  assert.strictEqual(compose([{ id: 'mem-4-d', text: '' }, { id: 'mem-5-e', text: null }]), null,
    'and that holds for several blank records, not just one');
});

// --- the arm: debounce, suppression, cooldown ------------------------------

function mkArm({ loadState = () => 'absent', armStatus = 200, armThrows = false, enabled = null } = {}) {
  const { store } = mkStore(CORPUS);
  const posts = [];
  const clears = [];
  const logged = [];
  let clock = 1_000_000;
  const a = createHintArm({
    log: { debug: (tag, msg) => logged.push(`${tag} ${msg}`) },
    retriever: createMemoryRetriever({ listUnits: (agent) => store.list(agent) }),
    compose,
    terms,
    loadState,
    armHints: (p) => {
      if (armThrows) throw new Error('proxy is down');
      posts.push(p);
      return Promise.resolve({ status: armStatus, json: { ok: armStatus < 400 } });
    },
    clearHints: (p) => { clears.push(p); return Promise.resolve({ status: 200 }); },
    now: () => clock,
    debounceMs: 5,
    ...(enabled ? { enabled } : {}),
  });
  return { arm: a, posts, clears, store, logged, tick: (ms) => { clock += ms; } };
}

const DRAFT = 'how does the wirescope tail hint registry expire a slot';
const CTX = { agent: 'a', base: 'http://127.0.0.1:1', route: 'clodex-a-deadbeef' };
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('arm: typing arms nothing — only Enter does', async () => {
  const h = mkArm();
  // Every prefix of the same draft, as the user would actually type it.
  for (let i = 1; i <= DRAFT.length; i++) h.arm.onDraft('s', DRAFT.slice(0, i), CTX);
  await settle();
  assert.strictEqual(h.posts.length, 0,
    `${DRAFT.length} keystrokes produced ${h.posts.length} POSTs — mid-draft arming overwrites a `
    + 'fixed hint id repeatedly, and one-shot semantics let an early worse match pop before the '
    + 'final better one replaces it');
  // The submitted draft is the only thing ranked, and it arms exactly once.
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1, 'Enter arms the draft the user actually submitted');
});

// Precision is the open question for this feature, and it cannot be answered
// from a log that records only WHICH unit won. Two arms observed in production
// on 2026-08-01 both looked wrong and neither could be diagnosed, because the
// matched terms were computed and discarded.
test('arm: the debug line carries the matched terms and score, never the draft', async () => {
  const h = mkArm();
  const secret = 'hunter2';
  h.arm.onDraft('s', `${DRAFT} ${secret}`, CTX, { final: true });
  await settle();
  const armed = h.logged.filter((l) => l.startsWith('hint armed'));
  assert.strictEqual(armed.length, 1, 'the successful arm must log exactly one audit line');
  assert.match(armed[0], /on=[a-z0-9,]+ score=\d+\.\d\d/,
    `an audit line without the matched terms cannot distinguish a good hint from a lucky one: ${armed[0]}`);
  for (const t of ['wirescope', 'registry']) {
    assert.ok(armed[0].includes(t), `the term "${t}" won the match and must appear as evidence`);
  }
  // A draft is raw operator text. The ranker's filtered tokens are safe to
  // write; the draft itself may carry a secret and must never reach the log.
  assert.ok(!armed[0].includes(secret),
    `the draft leaked into the log: ${armed[0]} — evidence must be the ranker's tokens, not the input`);
  assert.ok(!armed[0].includes('how does'), 'stop words from the draft imply the draft itself was logged');
});

test('arm: a desynced draft must not arm', async () => {
  const h = mkArm();
  // Same submitted draft, twice, differing only in whether the accumulator is
  // known to match the screen. The text is a perfect match either way, so only
  // the flag can be responsible for the difference.
  h.arm.onDraft('s', DRAFT, CTX, { final: true, desync: true });
  await settle();
  assert.strictEqual(h.posts.length, 0,
    'the accumulator no longer matches the screen, so this text is not what the user asked — '
    + 'ranking it would answer a different question with full confidence');

  h.arm.onDraft('s2', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1, 'and the identical draft DOES arm once it is trustworthy');
});

test('arm: a draft that grows without changing the winner does not re-POST', async () => {
  const h = mkArm();
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1, 'ENTER: the first draft must actually arm');
  // More words, same winner. The registered text is a function of the RESULT
  // SET, so nothing changed and nothing should be sent.
  h.arm.onDraft('s', `${DRAFT} please tell me`, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1, 'the winner did not change, so no second POST');

  // THE ABOVE IS SATISFIED BY THE COOLDOWN ALONE — verified by mutant: deleting
  // the winner memo entirely leaves it green, because a unit whose winner has
  // not changed is by then already in the offer ledger. The memo's real job is
  // the window BEFORE the POST resolves, where the ledger does not yet know
  // about it: a debounced fire and the Enter pass landing back to back would
  // otherwise both rank the same unit and both POST it.
  const slow = mkArm();
  let release;
  const gate = new Promise((r) => { release = r; });
  const posts = [];
  const inflight = createHintArm({
    retriever: createMemoryRetriever({ listUnits: (agent) => slow.store.list(agent) }),
    compose,
    terms,
    loadState: () => 'absent',
    armHints: (p) => { posts.push(p); return gate.then(() => ({ status: 200 })); },
    clearHints: () => Promise.resolve({ status: 200 }),
    debounceMs: 5,
  });
  inflight.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(posts.length, 1, 'ENTER: the debounced pass must have fired');
  // Enter, before the first POST has resolved. The cooldown cannot help here.
  inflight.onDraft('s', DRAFT, CTX, { final: true });
  assert.strictEqual(posts.length, 1,
    'a second pass while the first POST is still in flight must not re-POST the same winner — the '
    + 'offer ledger is written in the .then(), so at this instant it is empty and the memo is the '
    + 'only thing standing between one hint and two');
  release();
  await settle();
});

test('arm: a draft below the term floor never arms', async () => {
  // "wirescope registry" is TWO content terms and DOES rank — verified below —
  // so the ranker's own MIN_HITS cannot be what stops it. That matters: with a
  // one-term draft this case passed even with the term floor deleted, because
  // MIN_HITS was quietly doing the work and the assertion proved nothing.
  const probe = mkArm();
  assert.strictEqual(terms('wirescope registry').length, 2, 'ENTER: two content terms');
  assert.strictEqual(
    rank(require('../hint-retrieve').unitsAsRecords(probe.store.list('a')), 'wirescope registry', { limit: 1 }).length,
    1, 'ENTER: this draft DOES rank, so only the term floor can be what withholds it');

  const h = mkArm();
  h.arm.onDraft('s', 'wirescope registry', CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 0,
    'below the minimum term count a draft is not yet a question — two words rank against something, '
    + 'but a hint costs tail budget on a request the user is already paying for');
});

test('arm: an overflowed draft never arms', async () => {
  const h = mkArm();
  h.arm.onDraft('s', `${DRAFT} ${'x'.repeat(DRAFT_CAP)}`, CTX, { overflow: true });
  await settle();
  assert.strictEqual(h.posts.length, 0, 'a pasted wall of text is not a question');
});

test('arm: the suppression matrix — FULL suppresses, TITLE and ABSENT do not, a throw does not', async () => {
  const winner = (h) => rank(require('../hint-retrieve').unitsAsRecords(h.store.list('a')),
    DRAFT, { limit: 1 })[0].id;

  // ABSENT — the ordinary case.
  let h = mkArm({ loadState: () => 'absent' });
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1, 'ABSENT must offer');

  // TITLE — an index line rode, so the model knows the unit exists and cannot
  // read it. This is the single best hint case, not a suppression case.
  h = mkArm({ loadState: () => 'title' });
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1,
    'TITLE must NOT suppress: the model knows the unit exists and cannot read it, so suppressing '
    + 'here withholds exactly the unit most worth sending. A boolean "is it known" collapses this '
    + 'into the wrong answer');

  // FULL — the body is already in context; the hint would be a duplicate.
  h = mkArm({ loadState: () => 'full' });
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 0, 'FULL suppresses — the body is already there');

  // A lookup that THROWS resolves to ABSENT. The asymmetry is the whole design:
  // resolving an error toward FULL would silently withhold with no trace.
  h = mkArm({ loadState: () => { throw new Error('tracker exploded'); } });
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1,
    'a loadState that THROWS must resolve to ABSENT and still offer — a false ABSENT costs a few '
    + 'hundred tail tokens, a false FULL withholds silently and leaves nothing in any log');

  // A suppressed winner must not eat the slot a live runner-up could fill.
  h = mkArm({ loadState: (agent, id) => (id === winner(h) ? 'full' : 'absent') });
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  if (h.posts.length) {
    assert.ok(!h.posts[0].text.includes(winner(h)),
      'the suppressed winner must not appear in the hint text');
  }
});

test('arm: the same unit is not re-offered inside the cooldown, and a compact ends it early', async () => {
  const h = mkArm();
  h.arm.onDraft('s1', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1, 'ENTER: the first offer must land');

  // A different session key, so the per-session "winner unchanged" memo cannot
  // be what suppresses this — the cooldown ledger has to be doing the work.
  h.tick(60_000);
  h.arm.onDraft('s2', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1, 'a second offer of the same unit inside 10min is suppressed');

  // Cleared/compacted context: whatever was offered is no longer in front of the
  // model, so the cooldown ends early — the "whichever comes first" half.
  h.arm.onContextReset('a');
  h.arm.onDraft('s3', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 2,
    'after a context reset the unit must be offerable again — the offer it was suppressed against '
    + 'is no longer in front of the model');

  // And the window does expire on its own.
  const h2 = mkArm();
  h2.arm.onDraft('s1', DRAFT, CTX, { final: true });
  await settle();
  h2.tick(11 * 60 * 1000);
  h2.arm.onDraft('s2', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h2.posts.length, 2, 'past 10 minutes the same unit may be offered again');
});

test('arm: a failed POST does not burn the cooldown', async () => {
  const h = mkArm({ armStatus: 503 });
  h.arm.onDraft('s1', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1, 'ENTER: the POST must have been attempted');
  assert.strictEqual(h.arm._offered('a').size, 0,
    'the cooldown is recorded on a SUCCESSFUL post, not on the rank — a unit the proxy never '
    + 'accepted has not been offered, and burning its cooldown suppresses the retry');
  h.arm.onDraft('s2', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 2, 'so the next draft retries it');
});

test('arm: an abandoned draft DELETES the registered hint', async () => {
  const h = mkArm();
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1, 'ENTER: something must be armed before disarm means anything');
  h.arm.disarm('s', CTX);
  assert.strictEqual(h.clears.length, 1,
    'an armed hint from a discarded draft would ride its TTL and pop on whatever the user types next');
  assert.strictEqual(h.clears[0].id, HINT_ID, 'and it clears the hint it armed, by id');

  // Nothing armed -> nothing to delete. Not a correctness issue (the proxy is
  // idempotent) but a POST per Ctrl-C on an empty prompt is pure noise.
  const h2 = mkArm();
  h2.arm.disarm('s', CTX);
  assert.strictEqual(h2.clears.length, 0, 'disarming when nothing was armed sends nothing');
});

test('arm: a proxy that throws synchronously is swallowed and does not poison the next attempt', async () => {
  const h = mkArm({ armThrows: true });
  await assert.doesNotReject(async () => {
    h.arm.onDraft('s', DRAFT, CTX, { final: true });
    await settle();
  }, 'an arm failure must never surface — the keystroke path is what matters');
  // The memo must not latch on a throw, or a transient proxy failure disables
  // arming for the rest of the draft.
  assert.strictEqual(h.arm._armedIds('s'), null, 'a throw clears the winner memo so the next pass retries');
});

test('arm: with no proxy base nothing is attempted', async () => {
  const h = mkArm();
  h.arm.onDraft('s', DRAFT, { agent: 'a', base: null, route: 'clodex-a-x' }, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 0, 'no base, no POST');
});

// --- the one-shot field, against a server that stores what it was sent -----

test('once: the stored record reads back once === true', async () => {
  // A 200 and a registry echo are NOT evidence: the server accepts unknown keys,
  // drops them silently and returns 200, so posting `pop:true` registers a
  // STANDING hint whose logs are indistinguishable from a pop. This server keeps
  // ONLY the keys the real one validates, so a wrong field name cannot survive
  // the round trip.
  const KNOWN = ['id', 'text', 'ttl_s', 'turn_start_only', 'once'];
  const stored = new Map();
  let rejected = null;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const route = u.searchParams.get('agent');
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: route, agent_hints: [...(stored.get(route) || new Map()).values()] }));
      return;
    }
    if (req.method === 'DELETE') {
      const id = u.searchParams.get('id');
      const m = stored.get(route);
      const removed = m && id ? (m.delete(id) ? 1 : 0) : (stored.delete(route) ? 1 : 0);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, removed }));
      return;
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let p = null;
      try { p = JSON.parse(body); } catch {}
      const hints = (p && p.hints) || [];
      // The real server 400s a once:true with no ttl_s (proxylab/hints.py) —
      // the coupling is not optional, so a post that omits it must fail here too
      // rather than quietly registering a standing hint.
      for (const hint of hints) {
        if (hint.once && (typeof hint.ttl_s !== 'number' || !(hint.ttl_s > 0))) {
          rejected = 'once:true requires ttl_s';
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: rejected }));
          return;
        }
      }
      if (!stored.has(route)) stored.set(route, new Map());
      for (const hint of hints) {
        // Unknown keys are DROPPED, exactly as the real server drops them.
        const kept = {};
        for (const k of KNOWN) if (hint[k] !== undefined) kept[k] = hint[k];
        stored.get(route).set(kept.id, kept);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    // The REAL ProxyClient, wired exactly as engine.js wires it. A stubbed
    // sender here would prove only that this file can build a payload — the
    // claim under test is what survives the wire and lands in the registry.
    const { store } = mkStore(CORPUS);
    const arm = createHintArm({
      retriever: createMemoryRetriever({ listUnits: (agent) => store.list(agent) }),
      compose,
      terms,
      loadState: () => 'absent',
      armHints: (p) => ProxyClient.armHints(p.base, p.route,
        [{ id: p.id, text: p.text, ttl_s: p.ttl_s, turn_start_only: p.turn_start_only, once: p.once }]),
      clearHints: (p) => ProxyClient.clearHints(p.base, p.route, p.id),
      debounceMs: 5,
    });
    const ctx = { agent: 'a', base, route: 'clodex-a-deadbeef' };
    arm.onDraft('s', DRAFT, ctx, { final: true });
    // The arm is fire-and-forget; wait for the POST to have actually landed
    // rather than asserting on a race.
    for (let i = 0; i < 100 && !stored.size; i++) await settle(10);
    assert.strictEqual(rejected, null, `the server rejected the post: ${rejected}`);

    const read = await ProxyClient.readHints(base, 'clodex-a-deadbeef');
    assert.strictEqual(read.status, 200, 'ENTER: the registry must be readable');
    const rec = (read.json.agent_hints || []).find((x) => x.id === HINT_ID);
    assert.ok(rec, `no record stored under id ${HINT_ID} — nothing was armed`);
    assert.strictEqual(rec.once, true,
      'the STORED record must carry once === true. A 200 plus a registry echo is not evidence: the '
      + 'server drops unknown keys silently, so posting `pop: true` returns 200, echoes back, and '
      + 'registers a STANDING hint whose logs are indistinguishable from a pop');
    assert.strictEqual(rec.ttl_s, TTL_S, 'and a ttl, which once:true REQUIRES');
    assert.strictEqual(rec.turn_start_only, true, 'and turn_start_only, so it lands at a turn boundary');
    assert.ok(rec.text && rec.text.length, 'with text');

    // A re-arm OVERWRITES rather than accreting: the fixed id is the mechanism.
    arm.onContextReset('a');
    arm.onDraft('s2', `${DRAFT} and how does the digest budget reserve index lines`, ctx);
    for (let i = 0; i < 100 && stored.get('clodex-a-deadbeef').size < 1; i++) await settle(10);
    assert.strictEqual(stored.get('clodex-a-deadbeef').size, 1,
      'a re-arm must overwrite — a per-draft id would accrete entries until the scope cap declines them');

    // And the delete really removes it.
    await ProxyClient.clearHints(base, 'clodex-a-deadbeef', HINT_ID);
    const after = await ProxyClient.readHints(base, 'clodex-a-deadbeef');
    assert.deepStrictEqual((after.json.agent_hints || []).filter((x) => x.id === HINT_ID), [],
      'clearHints must actually remove the record');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// --- the real write() seam -------------------------------------------------

// A real create() with the claude arm's seams stubbed, matching
// test/memory-load.test.js — the draft fold and the arm calls are the product's
// own code; the stubs stand only between create()'s entry and the session map.
function mkManager({ hintArm = null, extraDeps = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-hintwire-'));
  const store = createMemoryStore(path.join(root, 'library', 'memory'));
  const persisted = new Map();
  const watchers = [];
  const written = [];

  const SessionManager = createSessionManager({
    REGISTRY_DIR: root,
    fs, path, pathFor, runDirFor,
    PENDING_DIR: path.join(root, 'pending'),
    MSG_DIR: path.join(root, 'messages'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => ({
      list: () => [...persisted.values()],
      get: (n) => persisted.get(n) || null,
      upsert: (e) => persisted.set(e.name, { ...(persisted.get(e.name) || {}), ...e }),
      remove: (n) => persisted.delete(n),
      setSessionId: () => {},
      markDigested: () => {},
    }),
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getEnvScopes: () => ({ all: () => ({ global: {}, workspaces: {} }) }),
    getAgentLibrary: () => ({ list: () => [], get: () => null }),
    getPromptLibrary: () => ({ list: () => [], get: () => null }),
    getPluginHooks: () => null,
    getPeerManager: () => null,
    getRemindScheduler: () => null,
    getNotifications: () => null,
    getTemplates: () => ({ list: () => [] }),
    getUserDataPath: () => os.tmpdir(),
    resolveProxyBase: () => 'http://127.0.0.1:1',
    resolveProxyAgentId: ({ name }) => `clodex-${name}-deadbeef`,
    normalizeProxyBase: (v) => v,
    lastTranscriptWrite: () => null,
    memoryStore: store,
    memoryLoad: createMemoryLoad({}),
    composeDigest: require('../memory-store').composeDigest,
    digestTiers: require('../memory-store').digestTiers,
    hintArm,
    isDigested: () => true,   // no digest delivery — this file is about the draft seam
    registry: { register: () => {}, unregister: () => {} },
    Transport: class { static async isSocketLive() { return false; } start() {} stop() {} },
    JsonlWatcher: class {
      constructor(name, onText, onSessionId, onActivity, onCompactSummary) {
        watchers.push({ name, onSessionId, onCompactSummary });
      }
      start() {} stop() {}
    },
    pty: { spawn: () => ({ onData() {}, onExit() {}, pid: 999, write: (b) => written.push(b) }) },
    os,
    notifyOS: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    setupClaudeHook: () => path.join(root, 'settings.json'),
    setupCodexHook: () => {},
    cleanupClaudeHook: () => {}, cleanupCodexHook: () => {}, cleanupSkillPlugin: () => {},
    writeClaudeDigestFile: () => true,
    buildIpcPrompt: () => '',
    bakePrompt: () => '',
    teeBlindBackend: () => null,
    readEffectiveClaudeEnv: () => ({}),
    mergeSessionEnv: () => ({ ...process.env }),
    resolveTeam: () => null,
    strictMcpReason: () => null,
    scrubInheritedClaudeMarkers: (e) => e,
    resolveSystemPromptFile: () => null,
    mergeClaudeSystemPrompt: (a) => ({ cleaned: [...a], append: null }),
    readAppendBodies: () => [],
    pluginGrammarLines: () => [],
    buildAgentsArg: () => [],
    effectiveInjectedSkills: () => [],
    unresolvedSubagentRefs: () => [],
    unionEnabled: require('../scope-util').unionEnabled,
    intentEnabled: require('../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fencedLines: require('../intent-scanner').fencedLines,
    // The REAL gate and the REAL paste tracker. isHumanPtyInput is the whole
    // guarantee that injected text never reaches the accumulator — stubbing it
    // would leave the injected-writes case asserting against the stub.
    isHumanPtyInput: require('../proxy-util').isHumanPtyInput,
    draftChunkSignal: require('../proxy-util').draftChunkSignal,
    // Every inject wait driven to 0: the boot-readiness gate polls until a real
    // mode-2004 byte from a real CLI latches `_bootReadySeen`, so with the
    // production caps this file prints green and then HANGS.
    INJECT_BOOT_MAXWAIT: 0,
    INJECT_QUIET_MAXWAIT: 0,
    INJECT_QUIET_MS: 0,
    SHORT_TEXT_DELAY: 0,
    LONG_TEXT_DELAY: 0,
    LONG_TEXT_THRESHOLD: 1e9,
    COMPACT_CONTINUATION_DELAY: 0,
    INJECT_HOLD_TIMEOUT: 0,
    InjectQueue: require('../inject-queue').InjectQueue,
    isInjectInFlight: require('../inject-queue').isInjectInFlight,
    canFireCompact: require('../inject-queue').canFireCompact,
    writeSkillPlugin: () => {},
    whichBin: () => null,
    codexStatusLineArg: () => [],
    mergeCodexInstructions: (a) => ({ cleaned: [...a], append: null }),
    randBase36: () => 'abc123',
    spillToFile: () => null,
    enqueueOutbox: () => {},
    drainPending: () => [],
    countPending: () => 0,
    peekPending: () => [],
    hasActivePending: () => false,
    isAlive: () => false,
    scheduleTrayRefresh: () => {},
    refreshAppMenu: () => {},
    refreshTrayMenu: () => {},
    findProjectRoot: () => null,
    execBodyCap: () => 4096,
    ...extraDeps,
  });
  const m = new SessionManager();
  m._sendToSession = () => {};
  m._broadcast = () => {};
  const stop = (name) => {
    const s = m.sessions.get(name);
    if (!s) return;
    try { if (s.sentinel) s.sentinel.stop(); } catch {}
    try { if (s.watcher) s.watcher.stop(); } catch {}
    try { if (s.ctxWatcher) s.ctxWatcher.close(); } catch {}
    clearTimeout(s._bootDrainTimer);
    clearTimeout(s._injectFlushRetry);
    clearTimeout(s._compactValveTimer);
  };
  return { m, root, store, watchers, written, stop };
}

// A recording arm rather than the real one: this half of the file is about what
// the SEAM feeds the arm, and a real ranker between the two would let a wiring
// bug hide behind an empty result set.
function recorder() {
  const calls = [];
  return {
    calls,
    onDraft: (key, draft, ctx, opts) => calls.push({ fn: 'onDraft', key, draft, ctx, opts }),
    disarm: (key, ctx) => calls.push({ fn: 'disarm', key, ctx }),
    onSubmit: (key) => calls.push({ fn: 'onSubmit', key }),
    onContextReset: (agent) => calls.push({ fn: 'onContextReset', agent }),
    forget: (key) => calls.push({ fn: 'forget', key }),
  };
}

async function spawned(h, name) {
  try {
    await h.m.create(name, 'claude', os.tmpdir(), [], null, 'ws');
  } catch (e) {
    assert.fail(`create() did not reach the session map: ${e && e.message}`);
  }
  assert.ok(h.m.sessions.get(name), 'ENTER: create() must have put a session in the map');
  return h.m.sessions.get(name);
}

test('write: human keystrokes accumulate on the session and reach the arm', async () => {
  const rec = recorder();
  const h = mkManager({ hintArm: rec });
  const s = await spawned(h, 'a');
  try {
    for (const c of 'wirescope hints') h.m.write('a', c);
    assert.strictEqual(s._draft, 'wirescope hints', 'the session carries the accumulated draft');
    const drafts = rec.calls.filter((c) => c.fn === 'onDraft');
    assert.strictEqual(drafts.length, 'wirescope hints'.length, 'every keystroke offers the draft to the arm');
    assert.strictEqual(drafts[drafts.length - 1].draft, 'wirescope hints');
    assert.strictEqual(drafts[0].ctx.agent, 'a');
    // The EXACT route, not a glob. The proxy matches globs with fnmatchcase, so
    // `clodex-a-*` also matches `clodex-a-hand-4f2a` — arming for one agent
    // would arm every agent whose name extends it.
    assert.strictEqual(drafts[0].ctx.route, 'clodex-a-deadbeef',
      'the route must be the minted proxyAgent; a glob would arm every agent whose name extends this one');
    assert.ok(!drafts[0].ctx.route.includes('*'), 'and must not be a glob when the exact id is known');
    // The keystrokes still reached the PTY — the whole point of the fire-and-forget shape.
    assert.strictEqual(h.written.join(''), 'wirescope hints', 'every byte reached the PTY');
  } finally { h.stop('a'); }
});

test('write: line edits across separate keystrokes track the terminal', async () => {
  const rec = recorder();
  const h = mkManager({ hintArm: rec });
  const s = await spawned(h, 'a');
  try {
    // node-pty delivers each keypress as its own write. The cursor and the
    // desync flag therefore have to SURVIVE between calls on the session — if
    // only the text carries forward, the cursor resets to the end every
    // keystroke and mid-line editing silently reverts to append-only.
    for (const c of 'helm chart') h.m.write('a', c);
    for (let i = 0; i < 5; i++) h.m.write('a', '\x1b[D');
    for (const c of 'BIG ') h.m.write('a', c);
    assert.strictEqual(s._draft, 'helm BIG chart',
      'the terminal shows "helm BIG chart"; anything else is text the ranker sees but the user cannot');

    h.m.write('a', '\x17');
    assert.strictEqual(s._draft, 'helm chart',
      'Ctrl-W killed "BIG " at the cursor, not the trailing word');

    // And the desync flag survives the same way.
    h.m.write('a', '\t');
    h.m.write('a', '\r');
    const final = rec.calls.filter((c) => c.fn === 'onDraft' && c.opts && c.opts.final).pop();
    assert.ok(final, 'Enter must still reach the arm');
    assert.strictEqual(final.opts.desync, true,
      'tab completion rewrote the line invisibly and the arm must be told, not handed stale text');
  } finally { h.stop('a'); }
});

test('write: injected (non-human) writes never reach the accumulator', async () => {
  const rec = recorder();
  const h = mkManager({ hintArm: rec });
  const s = await spawned(h, 'a');
  try {
    for (const c of 'real typing') h.m.write('a', c);
    const before = s._draft;
    const drafts = () => rec.calls.filter((c) => c.fn === 'onDraft').length;
    const armCallsBefore = drafts();
    // A focus report and a mouse report: these arrive down the SAME onData path
    // as keystrokes, and isHumanPtyInput is what tells them apart. Reusing that
    // gate is the guarantee — a second predicate here could drift from it.
    h.m.write('a', '\x1b[I');
    h.m.write('a', '\x1b[<0;10;20M');
    assert.strictEqual(s._draft, before,
      'terminal auto-replies must not reach the accumulator — they arrive on the same path as '
      + 'keystrokes and would poison the ranking with bytes the user never typed');
    assert.strictEqual(drafts(), armCallsBefore, 'and must not trigger an arm pass');

    // A real injection writes straight to the pty, bypassing write() entirely.
    s.pty.write('an injected dm body\r');
    assert.strictEqual(s._draft, before,
      'injected text (dm delivery, nudges, ticket bodies) must never be folded into the draft');
  } finally { h.stop('a'); }
});

test('write: Enter does a final pass, then resets the draft', async () => {
  const rec = recorder();
  const h = mkManager({ hintArm: rec });
  const s = await spawned(h, 'a');
  try {
    for (const c of 'why did the mutant escape') h.m.write('a', c);
    rec.calls.length = 0;
    h.m.write('a', '\r');
    const final = rec.calls.find((c) => c.fn === 'onDraft');
    assert.ok(final, 'Enter must do one last arm pass');
    assert.strictEqual(final.opts.final, true, 'and it must skip the debounce — the draft will not grow again');
    assert.strictEqual(final.draft, 'why did the mutant escape',
      'the final pass ranks the draft the user SUBMITTED; ranking after the reset ranks an empty string');
    assert.ok(rec.calls.some((c) => c.fn === 'onSubmit'), 'and the per-session memo resets');
    assert.strictEqual(s._draft, '', 'the accumulator resets after the final pass');
  } finally { h.stop('a'); }
});

test('write: Ctrl-C disarms rather than arming', async () => {
  const rec = recorder();
  const h = mkManager({ hintArm: rec });
  const s = await spawned(h, 'a');
  try {
    for (const c of 'abandoned question here') h.m.write('a', c);
    rec.calls.length = 0;
    h.m.write('a', '\x03');
    assert.ok(rec.calls.some((c) => c.fn === 'disarm'),
      'an abandoned draft must DELETE the registered hint — left to ride its TTL it pops on '
      + 'whatever the user types next');
    assert.ok(!rec.calls.some((c) => c.fn === 'onDraft'), 'and must not arm off the draft being thrown away');
    assert.strictEqual(s._draft, '', 'the accumulator is empty');
  } finally { h.stop('a'); }
});

test('write: a clear (new sessionId) and a compact both end the offer cooldown', async () => {
  const rec = recorder();
  const h = mkManager({ hintArm: rec });
  await spawned(h, 'a');
  try {
    const w = h.watchers.find((x) => x.name === 'a');
    assert.ok(w, 'ENTER: the watcher callbacks must have been captured');
    // First id is an attach, NOT a clear — resetting here would drop a cooldown
    // recorded microseconds earlier by the very session it belongs to.
    w.onSessionId('sid-1');
    assert.strictEqual(rec.calls.filter((c) => c.fn === 'onContextReset').length, 0,
      'the FIRST session id is an attach or resume, not a clear');
    // A CHANGED id is /clear.
    w.onSessionId('sid-2');
    assert.strictEqual(rec.calls.filter((c) => c.fn === 'onContextReset').length, 1,
      'a changed session id is /clear — whatever was offered is no longer in front of the model');
    assert.strictEqual(rec.calls.filter((c) => c.fn === 'onContextReset').pop().agent, 'a');
    // The same id again is not a transition.
    w.onSessionId('sid-2');
    assert.strictEqual(rec.calls.filter((c) => c.fn === 'onContextReset').length, 1,
      'the same id repeated is not a transition');

    h.m._fireCompactContinuation(h.m.sessions.get('a'));
    assert.strictEqual(rec.calls.filter((c) => c.fn === 'onContextReset').length, 2,
      'compaction ends the cooldown too — this fires for the CLI\'s own auto-compact, because the '
      + 'watcher reads the transcript rather than only knowing about compactions Clodex triggered');
  } finally { h.stop('a'); }
});

test('write: with no arm injected the seam still tracks and never throws', async () => {
  // The feature is OFF by default (CLODEX_HINT_ARM), so this is the shipped
  // configuration — it must be the one that cannot break a keystroke.
  const h = mkManager({ hintArm: null });
  const s = await spawned(h, 'a');
  try {
    for (const c of 'typing with the feature off\r') h.m.write('a', c);
    assert.strictEqual(s._draft, '', 'Enter still reset the accumulator');
    assert.strictEqual(h.written.join(''), 'typing with the feature off\r',
      'and every byte still reached the PTY');
  } finally { h.stop('a'); }
});

test('write: an arm that throws does not stop the keystroke', async () => {
  const boom = {
    onDraft() { throw new Error('arm exploded'); },
    disarm() { throw new Error('arm exploded'); },
    onSubmit() { throw new Error('arm exploded'); },
    onContextReset() {}, forget() {},
  };
  const h = mkManager({ hintArm: boom });
  await spawned(h, 'a');
  try {
    // Wrapped, so the red NAMES the invariant. Left bare, an arm exception
    // propagates out of write() and the case dies on a raw "arm exploded" stack
    // before reaching any assertion — a red that does not say what broke.
    assert.doesNotThrow(() => {
      for (const c of 'still typing\r') h.m.write('a', c);
    }, 'an arm exception must never escape write() — it would take the keystroke with it');
    assert.strictEqual(h.written.join(''), 'still typing\r',
      'a hint is worth nothing next to the user\'s byte reaching the PTY — every arm call site is '
      + 'inside a catch for exactly this');
  } finally { h.stop('a'); }
});

// The setting is a Preferences checkbox, not an env var read at construction:
// these pin that the gate is consulted per call, so toggling it takes effect on
// the next keystroke rather than the next launch.
test('arm: the enabled gate suppresses the POST while off', async () => {
  let on = false;
  const h = mkArm({ enabled: () => on });
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 0, 'the checkbox was off and a hint was armed anyway');
});

test('arm: turning the gate on takes effect without reconstructing the arm', async () => {
  let on = false;
  const h = mkArm({ enabled: () => on });
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 0);
  on = true;
  h.arm.onDraft('s', `${DRAFT} today`, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1,
    'the gate was sampled at construction — a live checkbox would need an app restart to take effect');
});

test('arm: unchecking the box between typing and Enter suppresses that submit', async () => {
  let on = true;
  const h = mkArm({ enabled: () => on });
  h.arm.onDraft('s', DRAFT, CTX);           // typing — arms nothing either way
  on = false;                                // box unticked before submitting
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 0,
    'the gate is read at Enter, so a box unticked mid-draft must suppress that submit rather than '
    + 'arm from a decision the user already reversed');
});

test('arm: an absent gate leaves the arm enabled', async () => {
  const h = mkArm();  // no `enabled` dep at all
  h.arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(h.posts.length, 1,
    'omitting the gate must not silently disable arming — the null object is the off switch');
});

// The pitch has to be judgeable on its own. A 180-char cut read as a stub and
// argued against spending the recall it was asking for.
test('compose: a truncated unit is pitched with its labels and a substantial preview', () => {
  const long = `${'x'.repeat(40)} SUBJECT LINE THAT MATTERS\n${'body '.repeat(600)}`;
  const text = compose([{ id: 'mem-1-a', text: long, tags: 'security,hints', scope: 'clodex' }]);
  assert.ok(text.includes('scope=clodex'), 'scope is a curated topic label and belongs in the pitch');
  assert.ok(text.includes('tags=security,hints'),
    'the tag can read as relevant even when the excerpt does not — it is the cheapest signal there is');
  assert.ok(text.includes('SUBJECT LINE THAT MATTERS'), 'the preview must carry real prose');
  // The preview spans lines, so measure the block between the label and the
  // truncation notice rather than a single line.
  const preview = text.split('...\n(truncated')[0].split(']\n')[1] || '';
  assert.ok(preview.length > 500,
    `preview was ${preview.length} chars — too short to judge relevance from, which is what made the `
    + 'model ignore its own recall offer');
  assert.ok(text.length <= 2500, 'the proxy caps a single hint at 2500 chars');
  assert.ok(/truncated at \d+ of \d+ chars/.test(text),
    'naming both sizes tells the model how much it is NOT seeing, which is the recall decision');
});

test('compose: a short unit rides in full and still carries its labels', () => {
  const text = compose([{ id: 'mem-2-b', text: 'a short durable fact', tags: 'method', scope: '' }]);
  assert.ok(text.includes('tags=method'));
  assert.ok(text.includes('a short durable fact'));
  assert.ok(!text.includes('truncated'), 'a short body is not truncated');
});

test('compose: a body that fits the preview is not advertised as truncated', () => {
  // Between FULL_BODY_CAP (700) and PREVIEW_CAP (900): takes the preview branch
  // but nothing is actually cut.
  const body = `SUBJECT\n${'w '.repeat(400)}`.slice(0, 850);
  const text = compose([{ id: 'mem-3-c', text: body, tags: 'method', scope: '' }]);
  assert.ok(!text.includes('truncated'),
    'nothing was cut, so a recall offer here buys the model nothing it does not already have');
  assert.ok(!/emit \[agent:memory recall\]/.test(text), 'and no recall is offered');
});

test('compose: the preamble tells the model the delivery is one-shot', () => {
  // Pinned because the sentence reads like padding and is the first thing a
  // later edit would trim. hint-arm arms with `turn_start_only: true` and the
  // proxy pops the entry after one delivery, so a model that defers acting on
  // a useful hint until after a tool call loses it outright. Both halves of the
  // instruction earn their place: `act on it` is free when the model answers
  // directly, `restate` costs output tokens but is the only thing that carries
  // the fact into a tool loop.
  const text = compose([{ id: 'mem-1-a', text: 'a short durable fact', tags: 'method', scope: '' }]);
  assert.ok(/will not be repeated/.test(text), 'the hint must say it is not coming back');
  assert.ok(/act on it or restate/.test(text), 'and name both ways to preserve it');
  assert.ok(/do not defer it to a later step/.test(text),
    'deferring past a tool call is the exact failure this sentence prevents');
  assert.ok(!/cache|token|cost|billing/i.test(text),
    'the billing reason for one-shot delivery is not the model\'s to reason about');
});

// --- the semantic tier: gate stays lexical, order becomes semantic ----------

// A stand-in ranker. Returning a FIXED winner regardless of the draft is the
// point: it makes "did the semantic order actually replace the lexical one"
// observable, which a realistic ranker agreeing with lexical would hide.
function fakeSemantic({ winner = null, returns = undefined, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async rank(draft, opts) {
      calls.push({ draft, opts });
      if (throws) throw new Error('daemon exploded');
      if (returns !== undefined) return returns;
      return [{ id: winner, text: 'the semantically chosen unit body', tags: '', scope: '',
        source: 'memory', confidence: 0.7, evidence: { sim: 0.7, ranker: 'semantic' } }];
    },
  };
}

function mkArmWith(semantic, { loadState = () => 'absent' } = {}) {
  const { store, ids } = mkStore(CORPUS);
  const posts = [];
  const logged = [];
  const a = createHintArm({
    log: { debug: (tag, msg) => logged.push(`${tag} ${msg}`) },
    retriever: createMemoryRetriever({ listUnits: (agent) => store.list(agent) }),
    semantic,
    compose,
    terms,
    loadState,
    armHints: (p) => { posts.push(p); return Promise.resolve({ status: 200 }); },
    clearHints: () => Promise.resolve({ status: 200 }),
  });
  return { arm: a, posts, logged, ids, store };
}

test('semantic: a draft the lexical gate rejects never reaches the ranker', async () => {
  // THE GATE IS LEXICAL AND THE RANKER CANNOT OVERRIDE IT. Measured on the real
  // store, top cosine for junk drafts (0.490-0.600) overlaps real ones
  // (0.536-0.708), so a semantic tier that got to vote on WHETHER to arm would
  // arm on "the cat knocked the plant over". Consulting it only after the gate
  // has fired is what makes that impossible rather than unlikely.
  const sem = fakeSemantic({ winner: 'mem-x' });
  const { arm, posts } = mkArmWith(sem);
  arm.onDraft('s', 'what should i have for dinner tonight please', CTX, { final: true });
  await settle();
  assert.strictEqual(posts.length, 0, 'an unrelated draft must not arm');
  assert.strictEqual(sem.calls.length, 0,
    'and the semantic ranker must not even be consulted — it cannot abstain, so asking it is the bug');
});

test('semantic: when the gate fires, the semantic order replaces the lexical one', async () => {
  const { store, ids } = mkStore(CORPUS);
  const posts = [];
  const logged = [];
  // The unit lexical would NOT pick for this draft.
  const other = ids[5];
  const arm = createHintArm({
    log: { debug: (tag, msg) => logged.push(`${tag} ${msg}`) },
    retriever: createMemoryRetriever({ listUnits: (a) => store.list(a) }),
    semantic: {
      async rank() {
        return [{ id: other, text: 'the digest budget reserves half its bytes for index lines',
          tags: '', scope: '', source: 'memory', confidence: 0.71,
          evidence: { sim: 0.712, ranker: 'semantic' } }];
      },
    },
    compose,
    terms,
    loadState: () => 'absent',
    armHints: (p) => { posts.push(p); return Promise.resolve({ status: 200 }); },
    clearHints: () => Promise.resolve({ status: 200 }),
  });
  arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(posts.length, 1, 'the gate fired, so something must be armed');
  assert.ok(posts[0].text.includes(other),
    'the armed unit must be the semantically chosen one, not the lexical winner');

  const line = logged.find((l) => l.includes('armed'));
  assert.ok(/by=semantic sim=0\.71/.test(line),
    `the audit line must attribute the choice to the ranker that made it: ${line}`);
});

test('semantic: no opinion falls back to the lexical winner', async () => {
  // null is "the daemon is down / the corpus is not embedded yet" and MUST NOT
  // suppress the hint — Ollama is not installed on users' machines and this
  // feature has to work without it.
  for (const [label, sem] of [
    ['null', fakeSemantic({ returns: null })],
    ['empty', fakeSemantic({ returns: [] })],
    ['throws', fakeSemantic({ throws: true })],
  ]) {
    const { arm, posts } = mkArmWith(sem);
    arm.onDraft('s', DRAFT, CTX, { final: true });
    await settle();
    assert.strictEqual(posts.length, 1, `${label}: the lexical hint must still arm`);
    assert.ok(posts[0].text.includes('wirescope'),
      `${label}: and it must be the lexical winner, unchanged`);
  }
});

test('semantic: absent entirely, arming is exactly what it was', async () => {
  const { arm, posts } = mkArmWith(undefined);
  arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(posts.length, 1, 'no semantic dep at all must not change behaviour');
  assert.ok(posts[0].text.includes('wirescope'));
});

test('semantic: the cooldown and in-context ledgers still apply to its winner', async () => {
  // The suppression matrix is a property of the RECORD, not of the ranking that
  // produced it. A semantic winner that is already in context would otherwise
  // be re-offered forever, since the ledgers were only ever applied to the
  // lexical pool.
  const { store, ids } = mkStore(CORPUS);
  const inContext = ids[5];
  const posts = [];
  const arm = createHintArm({
    retriever: createMemoryRetriever({ listUnits: (a) => store.list(a) }),
    semantic: {
      async rank() {
        return [{ id: inContext, text: 'already in the model context', tags: '', scope: '',
          source: 'memory', confidence: 0.9, evidence: { sim: 0.9, ranker: 'semantic' } }];
      },
    },
    compose,
    terms,
    loadState: (agent, id) => (id === inContext ? 'full' : 'absent'),
    armHints: (p) => { posts.push(p); return Promise.resolve({ status: 200 }); },
    clearHints: () => Promise.resolve({ status: 200 }),
  });
  arm.onDraft('s', DRAFT, CTX, { final: true });
  await settle();
  assert.strictEqual(posts.length, 1, 'the pass still arms');
  assert.ok(!posts[0].text.includes(inContext),
    'a semantically chosen unit whose body is already in context must be filtered like any other');
  assert.ok(posts[0].text.includes('wirescope'),
    'and with nothing admissible left, the lexical winner takes the slot');
});

test('semantic: a slow ranker never blocks the keystroke path', async () => {
  // Arming is fire-and-forget by contract. onDraft became a caller of an async
  // ranker, so this asserts the contract survived that change.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { store } = mkStore(CORPUS);
  const posts = [];
  const arm = createHintArm({
    retriever: createMemoryRetriever({ listUnits: (a) => store.list(a) }),
    semantic: { async rank() { await gate; return null; } },
    compose,
    terms,
    loadState: () => 'absent',
    armHints: (p) => { posts.push(p); return Promise.resolve({ status: 200 }); },
    clearHints: () => Promise.resolve({ status: 200 }),
  });
  const t0 = Date.now();
  arm.onDraft('s', DRAFT, CTX, { final: true });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `onDraft returned in ${elapsed}ms — it must not await the ranker`);
  assert.strictEqual(posts.length, 0, 'and nothing has been armed yet');
  release();
  await settle();
  assert.strictEqual(posts.length, 1, 'once the ranker settles the lexical fallback arms');
});

// --- common memory + composite ranking -------------------------------------

function mkCommonStore(units, set = 'chat-extract') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-common-'));
  const store = createMemoryStore(path.join(root, 'library', 'common-memory'));
  units.forEach((u) => store.remember(set, { text: u.text, scope: u.scope || '', tags: u.tags || '' }));
  return store;
}

test('common: the retriever reads a SET, not an agent', () => {
  const store = mkCommonStore([{ text: 'Bogdan prefers arm64-only releases since v0.14, intel builds from source.' }]);
  const r = createCommonRetriever({ listUnits: (set) => store.list(set), set: 'chat-extract' });
  // No agent is passed at all — these units belong to no one.
  const hit = r.retrieve('what is the policy on intel builds and arm64 releases', { limit: 1 })[0];
  assert.ok(hit, 'a set-scoped store must be matchable without an agent');
  assert.strictEqual(hit.source, 'common', 'the source label distinguishes it from the agent store');
});

test('composite: pooling lets a big corpus SILENCE a small one, merging does not', () => {
  // The measured regression this retriever exists to prevent: concatenating a
  // 1650-unit store into a 570-unit one raised the floor log(1+N) 6.35 -> 7.71
  // and dropped a live memory hit that scored 6.88. Both of rank's cuts are
  // corpus-relative, so SIZE alone moves them.
  // The squeeze is arithmetic: score sums log(1 + N/df) while the floor is
  // log(1+N), so a term whose df grows in step with N holds its score while the
  // bar rises past it. Sized to that — 2 terms at df=1 in memory (score 7.48,
  // floor 3.74) which reach df=41 once common is pooled (score 6.14, floor
  // 6.74). A fixture that merely adds records does NOT reproduce it.
  const memStore = mkStore([{ text: 'cadence screenplay' }]).store;
  for (let i = 0; i < 40; i += 1) {
    memStore.remember('a', { text: `Memory filler ${i} about archive rotation, tab dimming and worktree removal.` });
  }
  const filler = [];
  for (let i = 0; i < 760; i += 1) filler.push({ text: `Shared ${i}: deployment topology, cluster sizing, billing envelope.` });
  for (let i = 0; i < 40; i += 1) filler.push({ text: `Common ${i} cadence screenplay noted.` });
  const commonStore = mkCommonStore(filler);

  const draft = 'cadence screenplay';
  const memR = createMemoryRetriever({ listUnits: (a) => memStore.list(a) });
  const comR = createCommonRetriever({ listUnits: (s) => commonStore.list(s) });

  const alone = memR.retrieve(draft, { agent: 'a', limit: 1 });
  assert.strictEqual(alone.length, 1, 'the memory hit arms against its own store');

  const pooled = rank(
    unitsAsRecords(memStore.list('a')).concat(unitsAsRecords(commonStore.list('chat-extract'), 'common')),
    draft, { limit: 1 },
  );
  assert.strictEqual(pooled.length, 0, 'pooled, the bigger corpus raises the floor past that hit');

  const composite = createCompositeRetriever([memR, comR]).retrieve(draft, { agent: 'a', limit: 1 });
  assert.strictEqual(composite.length, 1, 'ranked separately, the hit survives');
  assert.strictEqual(composite[0].source, 'memory');
});

test('composite: one source throwing does not silence the others', () => {
  const memStore = mkStore([{ text: 'Ad-hoc signing must happen in afterPack or node-pty dies on Apple Silicon.' }]).store;
  const boom = { source: 'common', retrieve() { throw new Error('store unreadable'); } };
  const r = createCompositeRetriever([
    createMemoryRetriever({ listUnits: (a) => memStore.list(a) }),
    boom,
  ]);
  const hit = r.retrieve('why does node-pty die on apple silicon without ad-hoc signing', { agent: 'a', limit: 1 });
  assert.strictEqual(hit.length, 1, 'a broken source must not take the working one down with it');
});

test('composite: merges by confidence, which is corpus-normalised on both sides', () => {
  const memStore = mkStore([{ text: 'Sessions are keyed by name globally, so two windows cannot share a name.' }]).store;
  const commonStore = mkCommonStore([{ text: 'Bogdan ruled that sessions keyed by name globally is deliberate, not a bug.' }]);
  const r = createCompositeRetriever([
    createMemoryRetriever({ listUnits: (a) => memStore.list(a) }),
    createCommonRetriever({ listUnits: (s) => commonStore.list(s) }),
  ]);
  const out = r.retrieve('are sessions keyed by name globally across windows', { agent: 'a', limit: 2 });
  assert.strictEqual(out.length, 2, 'both sources contribute');
  assert.ok(out[0].confidence >= out[1].confidence, 'sorted by confidence across sources');
});

test('common: extra frontmatter (kind, volatility, quote-in-body) survives the store', () => {
  // The import writes kind/authority/confidence/volatility/refs as frontmatter
  // the parser preserves, and puts the quote in the BODY — frontmatter is
  // line-based, so a multi-line quote truncates at the first newline.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-commonmeta-'));
  const dir = path.join(root, 'library', 'common-memory', 'chat-extract');
  fs.mkdirSync(dir, { recursive: true });
  const body = 'Bogdan measured 57% of tokens as thinking.\n\n> i analyzed\n> tens of thousands of sessions';
  fs.writeFileSync(path.join(dir, 'mem-1700000000000-c0.md'), [
    '---', 'id: mem-1700000000000-c0', 'scope: memory-system',
    'learned_at: 2026-05-25T12:00:00.000Z', 'source: chat-extract',
    'tags: fact-project,point-in-time,operator-stated', 'kind: fact-project',
    'volatility: point-in-time', 'refs: 37,39', '---', '', body, '',
  ].join('\n'));
  const u = createMemoryStore(path.join(root, 'library', 'common-memory')).list('chat-extract')[0];
  assert.strictEqual(u.tags, 'fact-project,point-in-time,operator-stated');
  assert.ok(u.body.includes('> i analyzed\n> tens of thousands of sessions'),
    'a multi-line quote must survive — in the body, where newlines are free');
});
