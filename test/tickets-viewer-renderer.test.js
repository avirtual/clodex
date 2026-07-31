'use strict';
// tickets-viewer-renderer.test.js — the board's RENDERING decisions.
//
// The one this file exists for: a board that failed to load and a board with
// nothing on it must not paint the same. That is asserted behaviourally, by
// mounting the overlay against a fake rhost that answers `{ok:false}` and
// checking the DOM says so — a test that only checked the engine's return value
// would pass for a renderer that quietly showed "No open tickets." either way.
//
// jsdom is not a dependency, so the DOM here is the minimum this renderer
// touches, the same shape memory-viewer-renderer.test.js uses.

const test = require('node:test');
const assert = require('node:assert');

const viewer = require('../plugins/tickets-viewer/renderer');
const { humanizeAge, ageLine, summaryText } = viewer;

const HOUR = 60 * 60 * 1000;

// ── the pure pieces ─────────────────────────────────────────────────────────

test('humanizeAge matches core\'s, so the board and [agent:task list] agree', () => {
  // These are core's own roundings (session-manager's humanizeAge). Two
  // different roundings of one age read as two different ages.
  assert.equal(humanizeAge(0), '0s');
  assert.equal(humanizeAge(45 * 1000), '45s');
  assert.equal(humanizeAge(90 * 1000), '2m');
  assert.equal(humanizeAge(45 * 60 * 1000), '45m');
  assert.equal(humanizeAge(5 * HOUR), '5h');
  assert.equal(humanizeAge(50 * HOUR), '2d');
  assert.equal(humanizeAge(-5), '0s', 'a clock that went backwards is not a negative age');
});

test('ageLine shows how long it has been OPEN and how long it has been QUIET', () => {
  // One number cannot distinguish a long job from an abandoned one, which is
  // the whole reason this board sorts the way it does.
  const line = ageLine({ ageMs: 5 * HOUR, quietMs: 30 * 60 * 1000 });
  assert.match(line, /open 5h/);
  assert.match(line, /quiet 30m/);
});

test('ageLine states an unknown age instead of rendering a blank', () => {
  const line = ageLine({ ageMs: null, quietMs: null });
  assert.match(line, /unknown/);
  assert.doesNotMatch(line, /NaN|undefined|null/);
});

test('summaryText omits a zero rather than printing it', () => {
  // A trailer of zeroes trains the eye to skip the line where the non-zero ones
  // appear.
  assert.equal(summaryText({ done: 0, cancelled: 0, unknownState: 0, malformed: 0 }), '');
  assert.equal(summaryText({ done: 3, cancelled: 0, unknownState: 0, malformed: 0 }), '3 done');
  const full = summaryText({ done: 3, cancelled: 2, unknownState: 1, malformed: 4 });
  assert.match(full, /3 done/);
  assert.match(full, /2 cancelled/);
  assert.match(full, /1 in an unrecognised state/);
  assert.match(full, /4 unreadable record/);
});

// ── the DOM harness ─────────────────────────────────────────────────────────

function fakeDom() {
  const make = (tag) => {
    const node = {
      tag, className: '', children: [], listeners: {}, dataset: {},
      isConnected: true, title: '', _text: '',
      set textContent(v) { this._text = String(v); this.children.length = 0; },
      get textContent() { return this._text; },
      set innerHTML(_v) { this.children.length = 0; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
      setAttribute() {},
      classList: { toggle: () => {}, add: () => {}, remove: () => {} },
      querySelectorAll: () => [],
      click() { for (const fn of this.listeners.click || []) fn(); },
    };
    return node;
  };
  const prevDoc = global.document;
  global.document = { createElement: make };
  return { root: make('div'), restore: () => { global.document = prevDoc; } };
}

// All text in the tree, and every class present. The assertions below are about
// what the user can SEE and how it is marked, not about tree shape.
function textOf(node, out = []) {
  if (node._text) out.push(node._text);
  for (const c of node.children) textOf(c, out);
  return out;
}

function classesOf(node, out = []) {
  if (node.className) out.push(...String(node.className).split(/\s+/));
  for (const c of node.children) classesOf(c, out);
  return out;
}

function shaped(id, over = {}) {
  return {
    id, title: `title ${id}`, state: 'open', assignee: 'hand', taskDir: '',
    opener: 'lead', closedBy: '', openedAt: 1, closedAt: null, lastActivityAt: 1,
    ageMs: HOUR, quietMs: HOUR, nudged: false, stalled: false, backlog: false, ...over,
  };
}

function boardRes(over = {}) {
  return {
    ok: true, team: 'alpha', now: Date.now(), stallMs: 30 * 60 * 1000, warning: '',
    open: [], recent: [],
    counts: { open: 0, backlog: 0, done: 0, cancelled: 0, recentOver: 0, recentWindowMs: 24 * HOUR, unknownState: 0, malformed: 0 },
    ...over,
  };
}

// `answers` maps a method to its response, so each case declares exactly what
// the engine said and the assertions are about what the renderer did with it.
function withDom(answers, fn) {
  const { root, restore } = fakeDom();
  const logged = [];
  const rhost = {
    invoke(method, arg) {
      const a = answers[method];
      return Promise.resolve(typeof a === 'function' ? a(arg) : a);
    },
    log: { info: () => {}, error: (...m) => logged.push(m) },
    ui: {
      surfaces: { overlay: (spec) => { rhost._overlay = spec; return { open: () => {}, close: () => {} }; } },
      sidebar: { footerButton: (spec) => { rhost._button = spec; return () => {}; }, requestRelayout: () => {} },
      showToast: () => {},
    },
  };
  const run = async () => {
    const teardown = viewer.activate(rhost);
    rhost._overlay.mount(root);
    await rhost._overlay.onOpen();
    // The mount's refresh is fire-and-forget; let its promise chain settle.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    return { rhost, root, teardown, logged };
  };
  return run().then(async (ctx) => {
    try { await fn(ctx); } finally { ctx.teardown(); restore(); }
  });
}

// ── empty is not broken, on screen ──────────────────────────────────────────

test('a board that FAILED to load does not paint like an empty one', async () => {
  const failed = [];
  const empty = [];
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 0, stalled: 0 }] },
    board: { ok: false, error: 'tickets.json is not valid JSON' },
  }, ({ root }) => { failed.push(textOf(root).join('\n'), classesOf(root).join(' ')); });

  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 0, stalled: 0 }] },
    board: boardRes(),
  }, ({ root }) => { empty.push(textOf(root).join('\n'), classesOf(root).join(' ')); });

  // The failure names itself, in words a user can act on.
  assert.match(failed[0], /Could not read/);
  assert.match(failed[0], /not valid JSON/, 'the engine\'s reason reaches the screen');
  // And is marked as an error, not as emptiness — .tv-error is styled in red,
  // .tv-empty is dimmed grey.
  assert.match(failed[1], /tv-error/);

  // The empty board says nothing is open and is NOT marked as an error.
  assert.match(empty[0], /No open tickets/);
  assert.doesNotMatch(empty[1], /tv-error/);
  assert.doesNotMatch(empty[0], /Could not read/);
});

test('an unreadable TEAMS list does not paint like "no teams yet"', async () => {
  const failed = [];
  await withDom({ teams: { ok: false, error: 'could not read /x/teams (EACCES)' }, board: boardRes() },
    ({ root }) => { failed.push(textOf(root).join('\n'), classesOf(root).join(' ')); });
  assert.match(failed[0], /Could not read the teams directory/);
  assert.match(failed[0], /EACCES/);
  assert.match(failed[1], /tv-error/);

  const none = [];
  await withDom({ teams: { ok: true, teams: [] }, board: boardRes() },
    ({ root }) => { none.push(textOf(root).join('\n'), classesOf(root).join(' ')); });
  assert.match(none[0], /No teams yet/);
  assert.doesNotMatch(none[1], /tv-error/);
});

test('an invoke that throws is a stated failure, never an empty board', async () => {
  // The transport dying is a third way to get nothing back, and it must land in
  // the same place as an {ok:false} rather than falling through to a blank.
  await withDom({
    teams: () => { throw new Error('channel is gone'); },
    board: boardRes(),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    assert.match(text, /Could not read the teams directory/);
    assert.match(classesOf(root).join(' '), /tv-error/);
  });
});

test('a team whose registry is broken shows an error marker, never a count', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'broken', error: 'tickets.json is not valid JSON' }] },
    board: { ok: false, error: 'tickets.json is not valid JSON' },
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    // `0 open` beside a team that could not be read is the false green.
    assert.doesNotMatch(text, /0 open/);
    assert.match(classesOf(root).join(' '), /tv-team-error/);
  });
});

// ── what the board is for ───────────────────────────────────────────────────

test('the open list renders id, title, assignee, ages and artifact path', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 1, stalled: 0 }] },
    board: boardRes({
      open: [shaped('t7', { title: 'do the thing', assignee: 'hand', taskDir: 'tasks/do-the-thing', ageMs: 5 * HOUR, quietMs: 20 * 60 * 1000 })],
      counts: { ...boardRes().counts, open: 1 },
    }),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    for (const must of ['t7', 'do the thing', 'hand', 'open 5h', 'quiet 20m', 'tasks/do-the-thing']) {
      assert.ok(text.includes(must), `the board must show ${JSON.stringify(must)}\n--- got ---\n${text}`);
    }
  });
});

test('a MISSING artifact path is stated, not left blank', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 1, stalled: 0 }] },
    board: boardRes({ open: [shaped('t1', { taskDir: '' })] }),
  }, ({ root }) => {
    // "there is nothing on disk to pick up" is the actionable half of the
    // answer; a blank cell reads as a rendering gap.
    assert.match(textOf(root).join('\n'), /no task directory in the spec/);
    assert.match(classesOf(root).join(' '), /tv-no-artifact/);
  });
});

test('an unassigned ticket says so rather than showing an empty slot', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 1, stalled: 0 }] },
    board: boardRes({ open: [shaped('t1', { assignee: '' })] }),
  }, ({ root }) => {
    assert.match(textOf(root).join('\n'), /unassigned/);
    assert.match(classesOf(root).join(' '), /tv-unassigned/);
  });
});

test('a stalled ticket is MARKED, and an already-nudged one differently', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 2, stalled: 2 }] },
    board: boardRes({
      open: [shaped('t1', { stalled: true, nudged: true }), shaped('t2', { stalled: true })],
    }),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    assert.match(text, /stalled · nudged/, 'chased and still quiet');
    assert.match(text, /(^|\n)stalled($|\n)/, 'quiet and not yet chased');
    assert.match(classesOf(root).join(' '), /tv-stalled/);
    // The count in the section head names the threshold, so "stalled" is never
    // an unexplained label.
    assert.match(text, /quiet longer than 30m/);
  });
});

test('a BACKLOG ticket is marked as backlog, never as stalled', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 2, stalled: 1, backlog: 1 }] },
    board: boardRes({
      open: [shaped('t1', { assignee: '', backlog: true, quietMs: 40 * HOUR }), shaped('t2', { stalled: true })],
      counts: { ...boardRes().counts, open: 2, backlog: 1 },
    }),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    const classes = classesOf(root).join(' ');
    assert.match(text, /backlog/, 'unassigned work is labelled for what it is');
    assert.match(classes, /tv-backlog-flag/);
    // The two need opposite actions — assign it versus chase whoever holds it —
    // so the counts stay separate and the stall head counts only the stall.
    assert.match(text, /1 quiet longer than 30m/, 'the backlog row is not in the stall count');
    assert.match(text, /1 unassigned/);
    assert.match(classes, /tv-team-backlog/, 'the sidebar chip is its own, not the stall chip');
  });
});

test('a manifest core would reject is WARNED about while the tickets still render', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 1, stalled: 0, backlog: 0, warning: 'team.json "root" is not an absolute path — core would refuse this team' }] },
    board: boardRes({ open: [shaped('t1')], warning: 'team.json "root" is not an absolute path — core would refuse this team', counts: { ...boardRes().counts, open: 1 } }),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    const classes = classesOf(root).join(' ');
    assert.match(text, /manifest is unusable/);
    assert.match(text, /absolute path/, 'the engine\'s reason reaches the screen');
    // The rows are real, so this is a warning beside them, not an error instead
    // of them — and the sidebar keeps its count for the same reason.
    assert.match(text, /t1/);
    assert.match(text, /1 open/);
    assert.match(classes, /tv-warning/);
    assert.match(classes, /tv-team-warning/);
    assert.doesNotMatch(classes, /tv-team-error/, 'a bad manifest is not an unreadable registry');
  });
});

test('recently-closed renders below the open list and is capped-marked', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 1, stalled: 0 }] },
    board: boardRes({
      open: [shaped('t1')],
      recent: [shaped('t9', { state: 'done', closedAt: Date.now() - HOUR, closedBy: 'hand' })],
      counts: { ...boardRes().counts, done: 12, cancelled: 2, recentOver: 2 },
    }),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    assert.match(text, /Recently closed/);
    assert.match(text, /closed 1h ago/);
    assert.match(text, /by hand/);
    assert.match(text, /\+2 more/);
    // Counted in the trailer, not shown as rows.
    assert.match(text, /12 done/);
    assert.match(text, /2 cancelled/);
    // And it is placed AFTER the open section: order is the whole point of
    // "available but not competing for space".
    assert.ok(text.indexOf('Open (1)') < text.indexOf('Recently closed'),
      'open work leads the board');
  });
});

test('no recently-closed section at all when there is none', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 1, stalled: 0 }] },
    board: boardRes({ open: [shaped('t1')] }),
  }, ({ root }) => {
    assert.doesNotMatch(textOf(root).join('\n'), /Recently closed/);
  });
});

test('a board fetch that lands after a RELOAD does not paint over it', async () => {
  // The monotonic-token bug class we fixed in memory-viewer. selectSeq alone is
  // not enough: renderTeams returns EARLY when the teams list fails, so it never
  // starts a new select and never bumps selectSeq — an in-flight board result
  // then paints tickets over the error the user is looking at.
  let resolveBoard;
  const pending = new Promise((r) => { resolveBoard = r; });
  let teamsCalls = 0;
  const { root, restore } = fakeDom();
  const rhost = {
    invoke(method) {
      if (method === 'teams') {
        teamsCalls += 1;
        return Promise.resolve(teamsCalls === 1
          ? { ok: true, teams: [{ team: 'alpha', open: 1, stalled: 0, backlog: 0 }] }
          : { ok: false, error: 'could not read /x/teams (EACCES)' });
      }
      return pending;
    },
    log: { info: () => {}, error: () => {} },
    ui: {
      surfaces: { overlay: (spec) => { rhost._overlay = spec; return { open: () => {}, close: () => {} }; } },
      sidebar: { footerButton: () => () => {}, requestRelayout: () => {} },
      showToast: () => {},
    },
  };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const teardown = viewer.activate(rhost);
  try {
    rhost._overlay.mount(root);
    await rhost._overlay.onOpen();   // teams ok → selects alpha → board hangs
    await settle();
    await rhost._overlay.onOpen();   // reload: teams now fails, no new select
    await settle();
    resolveBoard(boardRes({ open: [shaped('t-stale')], counts: { ...boardRes().counts, open: 1 } }));
    await settle();

    const text = textOf(root).join('\n');
    assert.match(text, /Could not read the teams directory/, 'the reload\'s error survives');
    assert.doesNotMatch(text, /t-stale/, 'a board from before the reload must not paint');
  } finally { teardown(); restore(); }
});

// ── read-only, on screen ────────────────────────────────────────────────────

test('the board offers NO mutation control', async () => {
  await withDom({
    teams: { ok: true, teams: [{ team: 'alpha', open: 1, stalled: 0 }] },
    board: boardRes({ open: [shaped('t1')], recent: [shaped('t9', { closedAt: Date.now() })] }),
  }, ({ root, rhost }) => {
    // v1 is read-only by decision, not by omission. The only button in the tree
    // is the overlay's own close control; a close/assign/cancel button
    // appearing here is a scope change for the lead to approve.
    const buttons = [];
    (function walk(n) { if (n.tag === 'button') buttons.push(n); n.children.forEach(walk); })(root);
    assert.deepEqual(buttons.map((b) => b.className), ['tv-close']);
    // And the surface it contributes is one footer button, nothing more.
    assert.equal(rhost._button.label, 'Tickets');
  });
});
