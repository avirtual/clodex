'use strict';
// Run: node --test test/review-verdict-ticket.test.js
//
// t308 §2 — a TICKET's review verdict lands on the ticket record; an ad-hoc
// review's still goes back to whoever asked.
//
// The seam is one field, `reviewTicket`, seeded on the reviewer seat's record by
// the CALLER of [agent:team-review] and read back by [agent:review-done]. Two
// properties carry the whole section, and they pull in opposite directions:
//
//   1. with it, the verdict is written to the ticket (a record survives both the
//      reviewer and the hand dying; a dm survives neither), and
//   2. WITHOUT it nothing changes — `reviewFor` still delivers to the asker.
//
// (2) is the one worth guarding. `reviewFor` was the obvious field to overload,
// and an implementation that repurposed it would satisfy every ticket-shaped
// test in this file while silently swallowing the verdict of every ad-hoc
// review a lead ever asks for. So the no-ticket path is asserted here as its own
// subject, not as a footnote.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { createSessionManager } = require('../session-manager');
const ticketsMod = require('../tickets-store');
const { extractMustFix } = require('../tickets-store');
const { intentEnabled } = require('../intent-catalog');

// The shipped reviewer template — the DATA _handleTeamReview consumes. Copied
// from session-manager.test.js's fixture rather than imported for the same
// reason task-start.test.js rebuilds its own: these assertions are about the
// verdict route, and a shared fixture makes either file's edits break the other.
const SHIPPED_REVIEWER_TEMPLATE = {
  name: 'clodex-team-reviewer',
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
    CLODEX_SPAWNER_HINT: 'off',
  },
};

function mkVerdict(extra = {}) {
  // A real temp clodex HOME, so the board round-trips through the same store the
  // code writes: _landVerdictOnTicket's whole claim is that the verdict is on
  // DISK afterwards, and a Map-backed ticket store would prove only that an
  // object in memory was mutated.
  const home = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-rv-'));
  const tstore = ticketsMod.createTicketsStore({ clodexHome: home });
  const team = {
    name: 'team', root: '/proj', lead: 'lead', watchdogMs: null,
    file: pathReal.join(home, 'teams', 'team', 'team.json'),
    roles: {
      lead: { instantiate: 'session', brief: 'the lead' },
      hand: { instantiate: 'session', brief: 'the hand' },
      reviewer: {
        instantiate: 'subagent', prompt: 'clodex-team-reviewer', brief: 'the reviewer',
        tools: ['Read', 'Grep', 'Glob'], type: null, template: null, standing: null, ephemeral: false,
      },
    },
  };
  const store = [];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    setStripLevel: () => {},
    setAutoCompact: () => {},
  };
  const injected = [];
  const gated = [];
  const broadcasts = [];
  const deps = {
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [SHIPPED_REVIEWER_TEMPLATE] }),
    notifyOS: () => {},
    intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: fsReal,
    path: pathReal,
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: (cwd) => (cwd && cwd.startsWith('/proj') ? team : null),
    findProjectRoot: (cwd) => (cwd && cwd.startsWith('/proj') ? '/proj' : null),
    ...extra,
  };
  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const killed = [];
  const contextActions = [];
  // order proves the verdict is RECORDED before the seat is discarded — a
  // discard-first implementation loses the verdict of any write that then throws.
  const order = [];
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = (channel, msg) => broadcasts.push({ channel, msg });
  m._sendToSession = (name, channel, payload) => { contextActions.push({ name, channel, payload }); order.push('context-action'); };
  m._gatedDeliver = (target, sender, body) => { gated.push({ target, sender, body }); order.push('deliver'); return { queued: true }; };
  m._deliverMessage = () => {};
  m._deliverPassive = () => {};
  m._deliverParkedActive = () => {};
  m.create = async () => {};
  m.kill = async (name) => { killed.push(name); persistence.remove(name); order.push('discard'); };
  const seat = (name, cwd = '/proj') => {
    m.sessions.set(name, { name, type: 'claude', agentType: 'claude', cwd, pty: { pid: 1 }, activityState: 'idle' });
    return m.sessions.get(name);
  };
  return {
    m, team, home, tstore, persistence, injected, gated, broadcasts, killed, contextActions, order, seat,
    one: (id) => tstore.load(team.root).find((t) => t.id === id),
    notes: () => injected.join('\n'),
  };
}

// A ticket on the board, written through the real verbs so the record carries
// the shape the loop actually produces (assignee, role, state) rather than a
// hand-built object that may drift from it.
function openTicket(f, body = 'the spec') {
  f.seat('lead'); f.seat('team-hand');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'add', who: 'hand', id: null, body });
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'start', id: 't1', who: null, body: '' });
  const t = f.one('t1');
  assert.ok(t, 'ENTER: the ticket exists on the board');
  // `start` delivers the spec through the same _gatedDeliver every verdict-route
  // assertion below counts. Asserted, then cleared: the downstream subject is
  // whether the VERDICT reached the lead, and a setup delivery left in the array
  // makes `gated.length === 1` true for the wrong reason on the ticket path and
  // off-by-one on the fall-through path.
  assert.deepStrictEqual(f.gated, [{ target: 'team-hand', sender: 'lead', body: `[ticket t1] ${body}` }],
    'ENTER: start dispatched the spec exactly once');
  f.gated.length = 0;
  f.order.length = 0;
  return t;
}

// Spawn a reviewer the way a caller does, and hand back the seat it reserved.
// The name is READ from the record rather than assumed: the mint loop bumps on
// collision, and a hardcoded `team-reviewer-1` would make round 2's assertions
// silently address round 1's seat.
function spawnReviewer(f, scope, opts) {
  const before = new Set(f.persistence.list().map((e) => e.name));
  f.m._handleTeamReview(f.seat('lead'), scope, opts);
  const rec = f.persistence.list().find((e) => !before.has(e.name));
  assert.ok(rec, 'ENTER: the reviewer seat was reserved — otherwise there is no record to route by');
  f.seat(rec.name);
  return rec;
}

// ── the seed ───────────────────────────────────────────────────────────────

test('team-review with a ticketId seeds reviewTicket ALONGSIDE reviewFor, not instead of it', () => {
  const f = mkVerdict();
  openTicket(f);
  const rec = spawnReviewer(f, 'review the diff', { ticketId: 't1' });

  // Whole-object, per CLAUDE.md: a field-by-field match reads around a seed that
  // dropped `reviewFor`, and losing reviewFor is exactly the regression §2's
  // constraint forbids — review-done's own guard would then reject the seat.
  assert.deepStrictEqual(rec, {
    name: rec.name, ephemeral: true, reviewFor: 'lead', reviewTicket: 't1',
    wireLabel: rec.wireLabel,
  });
  assert.strictEqual(rec.reviewFor, 'lead', 'reviewFor is the seat identity and the fallback route — it must survive');
});

test('team-review WITHOUT a ticketId writes no reviewTicket key at all', () => {
  const f = mkVerdict();
  const rec = spawnReviewer(f, 'review the boot-race fix');

  assert.ok(!('reviewTicket' in rec),
    'an ad-hoc review must not carry the key — an absent key is what makes review-done take the lead path');
  assert.strictEqual(rec.reviewFor, 'lead');
});

test('reviewTicket is NEVER derived from the scope text', () => {
  const f = mkVerdict();
  openTicket(f);
  // A lead asking, in prose, about a ticket. If the id were sniffed out of the
  // scope, this review's verdict would divert to t1 and the lead — who asked a
  // question, not opened a review round — would be told nothing at all.
  const rec = spawnReviewer(f, 'is the approach in t1 sound? do not touch the ticket');

  assert.ok(!('reviewTicket' in rec),
    'the route is the caller\'s explicit claim; a scope that merely NAMES a ticket is not one');
});

test('reviewTicket survives an in-place restart (engine preserveFields)', () => {
  // A source pin, like team-cost-wiring's wireLabel check: the field is seeded
  // once at the mint with nothing to regrow it, so a restart that drops it sends
  // the verdict to the lead while the ticket waits forever for a verdict that
  // already happened. There is no runnable seam here without spawning a PTY.
  const src = fsReal.readFileSync(pathReal.join(__dirname, '..', 'engine.js'), 'utf8');
  // Anchored on `reviewFor` rather than on a variable name: one site builds a
  // named `preserveFields` const and the other passes the array inline, so the
  // shared thing is the list CONTENTS. Anchoring on the sibling field also means
  // a third preserve site added later fails this count rather than sliding past.
  const lists = src.match(/\[[^\]]*'reviewFor'[^\]]*\]/g) || [];
  // ENTER: both call sites were found. A zero-length match would make the loop
  // below vacuously true — the exact shape CLAUDE.md warns about.
  //
  // TWO is engine.js-only BY CONSTRUCTION, not a claim about the codebase: this
  // reads one file, so a preserve site added in another module is outside what
  // the count can see. A third _preserveAcrossRestart call already exists
  // elsewhere and is deliberately not covered here (it does not carry reviewFor,
  // so it is not on this seam). Widening the scan to the whole tree is the
  // change to make if that stops being true — not bumping this number.
  assert.strictEqual(lists.length, 2, `expected 2 preserve lists, found ${lists.length}`);
  for (const l of lists) {
    assert.match(l, /'reviewTicket'/,
      'every preserveFields list must carry reviewTicket, or a restarted reviewer reverts to the lead route');
  }
});

// ── the verdict lands on the ticket ────────────────────────────────────────

test('review-done on a ticket review writes the verdict to the RECORD and tells the lead nothing', async () => {
  const f = mkVerdict();
  openTicket(f);
  const rec = spawnReviewer(f, 'review the diff', { ticketId: 't1' });

  await f.m._handleReviewDone(f.m.sessions.get(rec.name),
    'VERDICT: REWORK\n\nMUST-FIX\n- the guard is inverted\n- the sweep drops the row\n\nNITS\n- naming');

  const t = f.one('t1');
  assert.strictEqual(t.verdict, 'REWORK');
  assert.strictEqual(t.mustFix, '- the guard is inverted\n- the sweep drops the row');
  assert.strictEqual(t.reviewRound, 1);
  assert.ok(typeof t.reviewedAt === 'number' && t.reviewedAt > 0, 'reviewedAt is stamped');

  // The point of the field, stated as an absence: the lead is NOT the route.
  assert.deepStrictEqual(f.gated, [],
    'a ticket verdict must not also be dm-ed to the lead — two copies of a verdict is two things to reconcile');
});

test('the verdict is written BEFORE the seat is discarded', async () => {
  const f = mkVerdict();
  openTicket(f);
  const rec = spawnReviewer(f, 'scope', { ticketId: 't1' });

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT');

  assert.deepStrictEqual(f.killed, [rec.name], 'the reviewer still retires on the ticket path');
  assert.deepStrictEqual(f.contextActions.map((c) => c.payload.disposition), ['discard'],
    'and still discards rather than archiving');
  assert.strictEqual(f.one('t1').verdict, 'ACCEPT',
    'the record holds the verdict after the seat is gone — that is the whole reason it goes to the record');
});

test('reviewRound counts on the TICKET, so it survives the reviewer seat dying', async () => {
  const f = mkVerdict();
  openTicket(f);

  const r1 = spawnReviewer(f, 'round one', { ticketId: 't1' });
  await f.m._handleReviewDone(f.m.sessions.get(r1.name), 'VERDICT: REWORK\nMUST-FIX: fix the guard');
  assert.strictEqual(f.one('t1').reviewRound, 1);

  // The seat is gone (kill removed its record). A round counted off the seat's
  // name index would restart at 1 here, and §5's auto-reject/escalate split —
  // r1 rejects, r2 escalates — would never reach round 2.
  const r2 = spawnReviewer(f, 'round two', { ticketId: 't1' });
  assert.notStrictEqual(r2.name, r1.name, 'ENTER: a genuinely new seat, not the recycled record');
  await f.m._handleReviewDone(f.m.sessions.get(r2.name), 'VERDICT: REWORK\nMUST-FIX: still inverted');

  const t = f.one('t1');
  assert.strictEqual(t.reviewRound, 2);
  assert.strictEqual(t.mustFix, 'still inverted', 'the newest round\'s must-fix replaces the previous one');
});

test('an ACCEPT whose MUST-FIX section is a placeholder carries no rework body', async () => {
  const f = mkVerdict();
  openTicket(f);
  const rec = spawnReviewer(f, 'scope', { ticketId: 't1' });

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT\n\nMUST-FIX: none\n\nNITS\n- a name');

  const t = f.one('t1');
  assert.strictEqual(t.verdict, 'ACCEPT');
  assert.strictEqual(t.mustFix, null,
    'an empty rework body handed to the loop would dispatch a rework round with nothing in it');
});

// ── the constraint: the ad-hoc path is unchanged ───────────────────────────

test('an ad-hoc review still delivers its verdict to the lead who asked', async () => {
  const f = mkVerdict();
  const rec = spawnReviewer(f, 'review the boot-race fix');

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT\nlooks right');

  assert.strictEqual(f.gated.length, 1, 'the lead is told');
  assert.strictEqual(f.gated[0].target, 'lead');
  assert.match(f.gated[0].body, /VERDICT: ACCEPT/);
  assert.deepStrictEqual(f.killed, [rec.name], 'and the seat retires exactly as before');
});

test('an ad-hoc verdict is not written to any ticket, even when its text names one', async () => {
  const f = mkVerdict();
  const before = openTicket(f);
  const rec = spawnReviewer(f, 'is the t1 approach sound?');

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: REWORK\nMUST-FIX: t1 needs a rethink');

  const t = f.one('t1');
  assert.ok(!('verdict' in t), 'no verdict key was written to the ticket');
  assert.ok(!('reviewRound' in t), 'and no round was burned on it');
  assert.strictEqual(t.lastActivityAt, before.lastActivityAt,
    'the ticket was not touched at all — its stall clock is unmoved');
  assert.strictEqual(f.gated.length, 1, 'the asker got the verdict instead');
});

// ── fall-through: a verdict is never lost ──────────────────────────────────

test('a ticket that cannot be resolved falls through to the lead', async () => {
  const f = mkVerdict();
  openTicket(f);
  const rec = spawnReviewer(f, 'scope', { ticketId: 't999' });
  // ENTER: the seat really is on the TICKET route. Without this the test passes
  // against a tree where reviewTicket does not exist at all — the reviewer would
  // reach the lead because there is no other path, not because it fell back.
  assert.strictEqual(rec.reviewTicket, 't999');

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT\nall good');

  assert.strictEqual(f.gated.length, 1,
    'a verdict is a cold review\'s entire output — a misrouted one costs less than a lost one');
  assert.strictEqual(f.gated[0].target, 'lead');
  assert.match(f.gated[0].body, /VERDICT: ACCEPT/);
  assert.deepStrictEqual(f.killed, [rec.name]);
});

test('a verdict that does not parse falls through to the lead, and stamps nothing', async () => {
  const f = mkVerdict();
  const before = openTicket(f);
  const rec = spawnReviewer(f, 'scope', { ticketId: 't1' });
  // ENTER: on the ticket route, and the ticket RESOLVES — so the only thing left
  // to send this verdict to the lead is the parse failing. Without it the test
  // passes on a tree that has no ticket route to fall back from.
  assert.strictEqual(rec.reviewTicket, 't1');
  assert.ok(f.one('t1'), 'and the ticket it names is on the board');

  // A reviewer answering off-grammar. Guessing a verdict here would stamp the
  // ticket with a decision nobody made; the recoverable branch is a human.
  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'I think it is mostly fine but the naming is odd');

  const t = f.one('t1');
  assert.ok(!('verdict' in t), 'no verdict was invented');
  assert.strictEqual(t.reviewRound, undefined, 'and no round was burned');
  assert.strictEqual(t.lastActivityAt, before.lastActivityAt);
  assert.strictEqual(f.gated.length, 1, 'the lead reads it instead');
  assert.match(f.gated[0].body, /mostly fine/);
});

test('review-done still refuses a seat that is not an ephemeral reviewer', async () => {
  const f = mkVerdict();
  openTicket(f);
  // The reviewFor gate is UNCHANGED by t308 — it is the seat-identity check, and
  // a reviewTicket-only record must not become a second way past it.
  f.persistence.upsert({ name: 'impostor', ephemeral: true, reviewTicket: 't1' });
  f.seat('impostor');

  await f.m._handleReviewDone(f.m.sessions.get('impostor'), 'VERDICT: ACCEPT');

  assert.match(f.notes(), /only for an ephemeral reviewer seat/);
  assert.ok(!('verdict' in f.one('t1')), 'and it wrote nothing to the ticket it named');
});

// ── extractMustFix ─────────────────────────────────────────────────────────
// The rework body is the half a rework round is built from, so a parse that
// truncates it dispatches a round missing its blocking items.

test('extractMustFix: a section runs to the next HEADER, not to the next mention', () => {
  // "NITS" appears INSIDE a must-fix item. A substring scan for the word cuts
  // here and drops the second item — the failure this parse exists to avoid.
  assert.strictEqual(
    extractMustFix('VERDICT: REWORK\n\nMUST-FIX\n- this NITS-looking one is blocking\n- and this one\n\nNITS\n- naming'),
    '- this NITS-looking one is blocking\n- and this one');
});

test('extractMustFix: the header line carries the first item when written inline', () => {
  assert.strictEqual(extractMustFix('VERDICT: REWORK\nMUST-FIX: the guard is inverted'),
    'the guard is inverted');
  // ...and an inline item does not suppress the lines under it.
  assert.strictEqual(extractMustFix('MUST-FIX: the guard is inverted\n- and the sweep drops the row'),
    'the guard is inverted\n- and the sweep drops the row');
});

test('extractMustFix: header spellings and decoration a reviewer actually writes', () => {
  for (const h of ['MUST-FIX', 'MUST FIX', 'MUSTFIX', 'must-fix', '**MUST-FIX**', '- MUST-FIX', '> MUST-FIX']) {
    assert.strictEqual(extractMustFix(`${h}\n- the item\n\nCHECKED\n- a thing`), '- the item',
      `header spelling "${h}" must be recognized`);
  }
});

test('extractMustFix: a placeholder body is null, not an empty rework', () => {
  for (const body of ['none', 'None.', 'n/a', 'N/A', '-', '—']) {
    assert.strictEqual(extractMustFix(`VERDICT: ACCEPT\nMUST-FIX: ${body}`), null,
      `"${body}" is a reviewer saying there is nothing, not an item`);
  }
  assert.strictEqual(extractMustFix('VERDICT: ACCEPT\nNITS\n- naming'), null, 'no section at all is null');
  assert.strictEqual(extractMustFix(''), null);
  assert.strictEqual(extractMustFix(null), null);
});

test('extractMustFix: CHECKED and VERDICT both close the section', () => {
  assert.strictEqual(extractMustFix('MUST-FIX\n- the item\nCHECKED\n- not an item'), '- the item');
  assert.strictEqual(extractMustFix('MUST-FIX\n- the item\nVERDICT: REWORK'), '- the item');
});

// The header test above covers the section word MID-LINE ("this NITS-looking one
// is blocking"), which the substring scan it replaced already handled. The case
// that actually breaks is the word as the item's FIRST TOKEN: bullet decoration
// is identical on a header and an item, so `- NITS are blocking` read as a
// header. When such an item came first the whole extraction returned null, and a
// null must-fix dispatches a rework round that tells the hand nothing.
test('extractMustFix: an item whose FIRST TOKEN is a section word does not close the section', () => {
  assert.strictEqual(
    extractMustFix('VERDICT: REWORK\n\nMUST-FIX\n- NITS are being treated as blocking here\n- and the guard is inverted\n\nNITS\n- naming'),
    '- NITS are being treated as blocking here\n- and the guard is inverted',
    'a bulleted item starting with NITS is an ITEM — the header form is `NITS` alone or `NITS:`');

  // The sharpest shape: that item is the ONLY one. Under the first-token bug the
  // section closed before collecting anything and the result was null, so the
  // rework round carried no body at all.
  assert.strictEqual(
    extractMustFix('VERDICT: REWORK\n\nMUST-FIX\n- CHECKED the sweep, it drops the row'),
    '- CHECKED the sweep, it drops the row',
    'a single item starting with a section word must not extract to null');

  // Unbulleted, and with the section-word items at both ends.
  assert.strictEqual(
    extractMustFix('MUST-FIX\nVERDICT parsing accepts a quoted line\nthe guard is inverted\nNITS mentioned as blocking\n\nCHECKED\n- a thing'),
    'VERDICT parsing accepts a quoted line\nthe guard is inverted\nNITS mentioned as blocking');
});

test('extractMustFix: the real header forms still close the section', () => {
  // The guard above must not have retired the header match itself. Each of these
  // is a header a reviewer writes, and each must still end the must-fix body.
  for (const h of ['NITS', 'NITS:', '**NITS**', '- NITS', '> NITS', 'NITS —', 'CHECKED', 'CHECKED:', 'VERDICT: ACCEPT']) {
    assert.strictEqual(extractMustFix(`MUST-FIX\n- the item\n${h}\n- not an item`), '- the item',
      `"${h}" is a HEADER and must close the section`);
  }
});

// The first attempt at the test above required a SEPARATOR after the keyword,
// and that rule cannot decide this: `- CHECKED: I could not verify this` (an
// item) and `MUST-FIX: the ordering is wrong` (a header carrying its only item
// inline) are the same shape by it. Every item below extracted to null.
//
// What discriminates comes from the producer — resources/library/prompts/system/
// clodex-team-reviewer.md's "Verdict format" — where headers are bold and items
// are bulleted-and-plain. Each case here is a real item shape whose first token
// is a section word AND which carries the punctuation a separator rule reads as
// a header. The second item is what makes a truncation visible: a rule that
// closes the section at the first line still returns something for the inline
// forms, so asserting only "not null" would pass over the bug.
test('extractMustFix: a bulleted item is an item however it is punctuated', () => {
  const items = [
    '- NITS-level in isolation, but blocking here: the lock',
    '- NITS, but blocking: the lock',
    '- CHECKED: I could not verify this one, so it blocks',
    '- VERDICT-adjacent wording bug',
    '- NITS/CHECKED overlap here',
    '- CHECKED. This path has no coverage',
    '1. NITS: this one is numbered, not bulleted',
    '* CHECKED — an asterisk bullet is a bullet',
  ];
  for (const item of items) {
    assert.strictEqual(
      extractMustFix(`**MUST-FIX**\n${item}\n- second blocking item\n\n**NITS**\n- cosmetic`),
      `${item}\n- second blocking item`,
      `"${item}" is an ITEM — a rework round built from this must carry BOTH items`);
  }
});

// The producer's own format section writes its headers bulleted AND bold
// (`- **MUST-FIX**: ...`), so "bulleted" cannot disqualify a header on its own —
// which is exactly why the rule is bold-first rather than bullet-first.
test('extractMustFix: a bulleted BOLD header is still a header', () => {
  assert.strictEqual(
    extractMustFix('- **MUST-FIX**: the ordering is wrong\n- and the sweep drops the row\n\n- **NITS**: naming'),
    'the ordering is wrong\n- and the sweep drops the row',
    'the producer emits `- **MUST-FIX**: ...`; both halves must parse as one header');

  assert.strictEqual(
    extractMustFix('- **MUST-FIX**\n- the item\n\n- **CHECKED**\n- a thing'),
    '- the item',
    'a bulleted bold header standing alone opens and the next one closes');

  // Bold that never CLOSES is emphasis running into a sentence, not a header —
  // the shape an item takes when a reviewer starts stressing a word and does not
  // stop. Reading it as a header closes the section on a blocking item.
  assert.strictEqual(
    extractMustFix('**MUST-FIX**\n- the item\n- **NITS are being treated as blocking here\n\n**NITS**\n- cosmetic'),
    '- the item\n- **NITS are being treated as blocking here',
    'an unterminated `**` is emphasis; the closed `**NITS**` below it is the header');
});

// The accepted cost of "bold wins": a reviewer who bolds a keyword INSIDE an
// item (`- **NITS** are being treated as blocking`) has written the header shape
// and the section closes there. Pinned rather than left unstated — it is the one
// case the rule gets wrong, it is rare (the producer bolds keywords only as
// headers), and the failure is a truncated list, so if it is ever seen in a real
// verdict this is the test to change.
test('extractMustFix: a bolded keyword mid-item closes the section (known cost)', () => {
  assert.strictEqual(
    extractMustFix('**MUST-FIX**\n- the item\n- **NITS** are being treated as blocking here'),
    '- the item',
    'bold wins over bullet, so an emphasized keyword inside an item reads as a header');
});

// ── the verdict match is line-anchored ─────────────────────────────────────

test('a QUOTED previous verdict does not win over the reviewer`s own', async () => {
  const f = mkVerdict();
  openTicket(f);
  const rec = spawnReviewer(f, 'scope', { ticketId: 't1' });

  // §3 feeds round 1's verdict into round 2's scope, so the previous verdict
  // arrives quoted INSIDE the new body. An unanchored match takes the first
  // mention anywhere in the text — which is the old round's, and it would land
  // an ACCEPT on a ticket the reviewer just sent back.
  await f.m._handleReviewDone(f.m.sessions.get(rec.name),
    'Round 1 said:\n> VERDICT: ACCEPT\n> looks right\n\nI disagree.\n\nVERDICT: REWORK\nMUST-FIX: the guard is inverted');

  const t = f.one('t1');
  assert.strictEqual(t.verdict, 'REWORK',
    'the reviewer`s OWN verdict decides — reading the quoted one accepts work that was just rejected');
  assert.strictEqual(t.mustFix, 'the guard is inverted');
});

test('ordinary verdict decoration is still accepted, so the anchor did not narrow the grammar', async () => {
  for (const line of ['VERDICT: ACCEPT', '  VERDICT: ACCEPT', '**VERDICT**: ACCEPT', '- VERDICT: ACCEPT', 'VERDICT — ACCEPT', 'verdict: accept']) {
    const f = mkVerdict();
    openTicket(f);
    const rec = spawnReviewer(f, 'scope', { ticketId: 't1' });
    await f.m._handleReviewDone(f.m.sessions.get(rec.name), `some preamble\n\n${line}\n\nMUST-FIX: none`);
    assert.strictEqual(f.one('t1').verdict, 'ACCEPT', `"${line}" must still parse — a verdict that stops parsing falls through to the lead silently`);
  }
});

// ── a closed ticket takes no verdict ───────────────────────────────────────

test('a verdict for a ticket that is no longer open falls through to the lead', async () => {
  const f = mkVerdict();
  openTicket(f);
  const rec = spawnReviewer(f, 'scope', { ticketId: 't1' });
  // ENTER: the seat is on the TICKET route and the ticket RESOLVES, so the only
  // thing that can send this to the lead is the state check. Without both, this
  // passes on a tree with no ticket route at all.
  assert.strictEqual(rec.reviewTicket, 't1');
  f.m._handleTask(f.seat('lead'), { type: 'task', sub: 'cancel', id: 't1', body: 'never mind' });
  assert.strictEqual(f.one('t1').state, 'cancelled', 'ENTER: the ticket really left the open state');
  const before = f.one('t1');
  f.gated.length = 0;

  await f.m._handleReviewDone(f.m.sessions.get(rec.name), 'VERDICT: ACCEPT\nlooks right');

  const t = f.one('t1');
  assert.ok(!('verdict' in t), 'a closed ticket is not stamped — the loop step is over and nobody would act on it');
  assert.ok(!('reviewRound' in t), 'and no round is burned');
  assert.strictEqual(t.lastActivityAt, before.lastActivityAt, 'its clock is untouched');
  assert.strictEqual(t.closedAt, before.closedAt, 'and it stays closed');
  assert.strictEqual(f.gated.length, 1,
    'the verdict still reaches the lead — the review was real work, and the lead is who can act on a closed ticket');
  assert.strictEqual(f.gated[0].target, 'lead');
  assert.match(f.gated[0].body, /VERDICT: ACCEPT/);
});
