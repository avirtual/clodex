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
const fs = require('node:fs');
const path = require('node:path');

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
      // A non-EMPTY assignment is modelled, crudely, as what a browser would do
      // with it: markup becomes elements. Without that, an innerHTML
      // implementation would be indistinguishable from a textContent one here
      // and the "never became an element" assertion would have nothing to fail
      // against. Empty clears the text too — a pane the renderer wiped must not
      // keep reporting content through textOf.
      //
      // _text keeps the RAW string, tags and all, deliberately: the
      // doesNotMatch assertions below (t-stale, `0 open`, "Could not read")
      // stay sensitive precisely because nothing here strips markup out of it.
      // Stripping for browser parity would blunt three live assertions to
      // sharpen none.
      set innerHTML(v) {
        this.children.length = 0;
        const s = v == null ? '' : String(v);
        this._text = s;
        if (!s) return;
        for (const m of s.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)) this.children.push(make(m[1].toLowerCase()));
      },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) {
        const i = this.children.indexOf(c);
        // Throws like the real DOM: a renderer removing a node it does not own
        // is a bug, and a silent no-op here would hide it.
        if (i < 0) throw new Error('removeChild: node is not a child of this node');
        this.children.splice(i, 1);
        c.parentNode = null;
        return c;
      },
      // The editor panel is PREPENDED, so the harness has to model insertion
      // position — appending it instead would still satisfy every text
      // assertion while putting the panel below the fold on a long board.
      insertBefore(c, ref) {
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        c.parentNode = this;
        return c;
      },
      get firstChild() { return this.children[0] || null; },
      // Form-control state the CRUD surface reads back. `value` is a plain
      // field: the renderer writes it (seeding the editor with an existing
      // spec) and reads it (on submit), and a test drives an edit by setting it.
      value: '',
      placeholder: '',
      parentNode: null,
      focus() {},
      addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
      setAttribute() {},
      classList: { toggle: () => {}, add: () => {}, remove: () => {} },
      querySelectorAll: () => [],
      // Bare tag selectors only — the one question asked of it is whether a tag
      // in agent-authored text ever became a node.
      querySelector(sel) {
        for (const c of this.children) {
          if (c.tag === sel) return c;
          const hit = c.querySelector(sel);
          if (hit) return hit;
        }
        return null;
      },
      click() { for (const fn of this.listeners.click || []) fn(); },
      // A <select> fires `change`, not `click`. Modelled as its own dispatch so
      // a test drives the assign control the way the operator does — pick a
      // value, then fire — rather than by reaching for the handler directly.
      change(v) {
        if (v !== undefined) this.value = v;
        for (const fn of this.listeners.change || []) fn();
      },
    };
    return node;
  };
  const prevDoc = global.document;
  global.document = { createElement: make };
  return { root: make('div'), restore: () => { global.document = prevDoc; } };
}

// Every node in the tree whose className contains `cls`.
function allByClass(root, cls, out = []) {
  if (String(root.className).split(/\s+/).includes(cls)) out.push(root);
  for (const c of root.children) allByClass(c, cls, out);
  return out;
}

// The first button whose visible label is exactly `label`. Buttons are found by
// what the operator reads, not by class, so a relabelled control fails loudly
// here instead of silently going untested.
function buttonLabelled(root, label) {
  const hit = [];
  (function walk(n) {
    if (n.tag === 'button' && n.textContent === label) hit.push(n);
    n.children.forEach(walk);
  })(root);
  return hit[0] || null;
}

// window.confirm, stubbed. Returns `answer` and records what it was asked, so a
// destructive action can be tested BOTH ways — confirmed and declined — and the
// decline case can assert nothing was invoked.
function withConfirm(answer, fn) {
  const prev = global.confirm;
  const asked = [];
  global.confirm = (msg) => { asked.push(String(msg)); return answer; };
  return Promise.resolve()
    .then(() => fn(asked))
    .finally(() => { if (prev === undefined) delete global.confirm; else global.confirm = prev; });
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
  const base = {
    id, title: `title ${id}`, spec: `spec of ${id}`, state: 'open', assignee: 'hand', taskDir: '',
    role: '',
    opener: 'lead', closedBy: '', openedAt: 1, closedAt: null, lastActivityAt: 1,
    ageMs: HOUR, quietMs: HOUR, nudged: false, stalled: false, backlog: false,
    // Empty strings, matching what the engine emits for a ticket carrying
    // neither stamp — so the merge cases below are the only rows that differ
    // from an ordinary one, and an accidental mark elsewhere fails there.
    mergeWaiting: '', mergeError: '', ...over,
  };
  // Derived AFTER the overrides, mirroring the engine (`role || assignee`), so a
  // case that overrides `assignee` alone — the unassigned row, every pre-t295
  // fixture — does not silently keep a stale display name from the default.
  return { shownFor: base.role || base.assignee, ...base };
}

function boardRes(over = {}) {
  return {
    ok: true, project: 'proj-1234abcd', root: '/proj/alpha', team: 'alpha',
    now: Date.now(), stallMs: 30 * 60 * 1000, warning: '',
    open: [], recent: [],
    counts: { open: 0, backlog: 0, done: 0, cancelled: 0, recentOver: 0, recentWindowMs: 24 * HOUR, unknownState: 0, malformed: 0 },
    ...over,
  };
}

// One project row, in the shape `projects` answers with. The left pane lists
// PROJECTS since t304 — the board belongs to the project, and a team is one
// optional name for it.
function projectRow(over = {}) {
  return { key: 'proj-1234abcd', leaf: 'proj', root: '/proj/alpha', team: 'alpha', open: 0, stalled: 0, backlog: 0, parked: 0, warning: '', ...over };
}

function projectsRes(rows) {
  return { ok: true, projects: rows === undefined ? [projectRow()] : rows };
}

// `answers` maps a method to its response, so each case declares exactly what
// the engine said and the assertions are about what the renderer did with it.
// Every invocation is RECORDED: a mutating case asserts what the renderer asked
// the engine to do, which is the only thing this half can be responsible for.
function withDom(answers, fn) {
  const { root, restore } = fakeDom();
  const logged = [];
  const toasts = [];
  const calls = [];
  const rhost = {
    invoke(method, arg) {
      calls.push({ method, arg });
      // Defaults so every case does not have to restate the two reads it does
      // not care about. A case that DOES care overrides them.
      const a = Object.prototype.hasOwnProperty.call(answers, method)
        ? answers[method]
        : ({ projects: projectsRes(), sessions: { ok: true, sessions: [] } })[method];
      return Promise.resolve(typeof a === 'function' ? a(arg) : a);
    },
    log: { info: () => {}, error: (...m) => logged.push(m) },
    ui: {
      surfaces: { overlay: (spec) => { rhost._overlay = spec; return { open: () => {}, close: () => {} }; } },
      sidebar: { footerButton: (spec) => { rhost._button = spec; return () => {}; }, requestRelayout: () => {} },
      showToast: (msg, opts) => toasts.push({ msg: String(msg), kind: opts && opts.kind }),
    },
    _calls: calls,
    _toasts: toasts,
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const run = async () => {
    const teardown = viewer.activate(rhost);
    rhost._overlay.mount(root);
    await rhost._overlay.onOpen();
    // The mount's refresh is fire-and-forget; let its promise chain settle.
    await settle();
    return { rhost, root, teardown, logged, toasts, calls, settle };
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
    projects: projectsRes(),
    board: { ok: false, error: 'tickets.json is not valid JSON' },
  }, ({ root }) => { failed.push(textOf(root).join('\n'), classesOf(root).join(' ')); });

  await withDom({
    projects: projectsRes(),
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

test('an unreadable PROJECTS list does not paint like "no projects yet"', async () => {
  const failed = [];
  await withDom({ projects: { ok: false, error: 'could not read /x/projects (EACCES)' }, board: boardRes() },
    ({ root }) => { failed.push(textOf(root).join('\n'), classesOf(root).join(' ')); });
  assert.match(failed[0], /Could not read the projects directory/);
  assert.match(failed[0], /EACCES/);
  assert.match(failed[1], /tv-error/);

  const none = [];
  await withDom({ projects: { ok: true, projects: [] }, board: boardRes() },
    ({ root }) => { none.push(textOf(root).join('\n'), classesOf(root).join(' ')); });
  assert.match(none[0], /No projects yet/);
  assert.doesNotMatch(none[1], /tv-error/);
  // The empty state must not blame a missing TEAM: a board with no team is the
  // ordinary solo case since t304, and telling the operator to create one would
  // send them after the wrong thing.
  assert.doesNotMatch(none[0], /team/i, 'no team is a normal state, not the reason the list is empty');
});

test('an invoke that throws is a stated failure, never an empty board', async () => {
  // The transport dying is a third way to get nothing back, and it must land in
  // the same place as an {ok:false} rather than falling through to a blank.
  await withDom({
    projects: () => { throw new Error('channel is gone'); },
    board: boardRes(),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    assert.match(text, /Could not read the projects directory/);
    assert.match(classesOf(root).join(' '), /tv-error/);
  });
});

test('a project whose registry is broken shows an error marker, never a count', async () => {
  await withDom({
    projects: projectsRes([projectRow({ key: 'broken-1234abcd', open: undefined, error: 'tickets.json is not valid JSON' })]),
    board: { ok: false, error: 'tickets.json is not valid JSON' },
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    // `0 open` beside a project that could not be read is the false green.
    assert.doesNotMatch(text, /0 open/);
    assert.match(classesOf(root).join(' '), /tv-team-error/);
  });
});

// ── what the board is for ───────────────────────────────────────────────────

// Core re-pins `assignee` to a concrete seat at delivery; both boards render the
// filed ROLE. A viewer rendering the pin raw names a seat for the ticket the
// others call `hand`.
test('a re-pinned row renders the ROLE, so the viewer and the two boards name the same thing', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({
      open: [shaped('t1', { assignee: 'team-hand-9', role: 'hand', shownFor: 'hand' })],
      counts: { ...boardRes().counts, open: 1 },
    }),
  }, ({ root }) => {
    const cells = textOf(root);
    // Exact element text, not a match against the joined tree: `/\bhand\b/` also
    // hits INSIDE `team-hand-9` (a hyphen is a word boundary), so a regex guard
    // here would pass on the very pin the assertion below forbids and the whole
    // property would ride on that `doesNotMatch` alone.
    assert.ok(cells.includes('hand'), 'ENTER: the row rendered its assignee cell as the role');
    assert.doesNotMatch(cells.join('\n'), /team-hand-9/,
      'the seat pin must not surface — the board and the exec leaf both show the role');
  });
});

test('the open list renders id, title, assignee, ages and artifact path', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 1 })]),
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
    projects: projectsRes([projectRow({ open: 1 })]),
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
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({ open: [shaped('t1', { assignee: '' })] }),
  }, ({ root }) => {
    assert.match(textOf(root).join('\n'), /unassigned/);
    assert.match(classesOf(root).join(' '), /tv-unassigned/);
  });
});

test('a stalled ticket is MARKED, and an already-nudged one differently', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 2, stalled: 2 })]),
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
    projects: projectsRes([projectRow({ open: 2, stalled: 1, backlog: 1 })]),
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

test('a PARKED ticket is marked parked, never stalled or backlog (t174)', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 2, stalled: 1, parked: 1 })]),
    board: boardRes({
      // Assigned AND parked: the row that would read as ordinary work in flight
      // without the flag, and that the backlog branch cannot claim.
      open: [shaped('t1', { assignee: 'hand', parked: true, quietMs: 40 * HOUR }), shaped('t2', { stalled: true })],
      counts: { ...boardRes().counts, open: 2, parked: 1 },
    }),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    const classes = classesOf(root).join(' ');
    assert.match(text, /parked/, 'the row says it is held back');
    assert.ok(!/backlog/.test(text), 'and does NOT claim nobody has decided — the lead did');
    assert.match(text, /1 quiet longer than 30m/, 'the parked row is not in the stall count');
    assert.match(text, /1 parked/, 'the head counts it separately');
    assert.match(classes, /tv-team-backlog/, 'the sidebar chip renders');
  });
});

// ── the two merge marks (t534) ──────────────────────────────────────────────
//
// The parity `deepStrictEqual` that guards the two TEXT boards does not reach
// this renderer, so these are the only pins on what the GUI draws for either
// field. They assert the mark is VISIBLE and, separately, that the two are
// DISTINGUISHABLE without reading the words — the property t533 shaped the text
// board's ` !! MERGE FAILED: …` around, restated in this board's badge idiom.

test('a ticket whose merge FAILED is marked, and says which step (t534)', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({
      open: [shaped('t1', { mergeError: 'clean-tree' })],
      counts: { ...boardRes().counts, open: 1 },
    }),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    const classes = classesOf(root).join(' ');
    assert.match(text, /merge failed/i, 'the row says the merge did not happen');
    // The stored STEP, verbatim: the board's claim is core's, not one of its
    // own, and the step is what tells the lead where to pick the merge up.
    assert.match(text, /clean-tree/, 'and names the step it gave up at');
    assert.match(classes, /tv-merge-error/);
    // The row-level mark, not just the badge: a failed merge is normally read
    // in the recently-closed block, and one small badge on an otherwise
    // ordinary row is easy to scan past.
    assert.match(classes, /tv-merge-failed/);
  });
});

test('a ticket whose merge is WAITING is marked, and says why (t534)', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({
      open: [shaped('t1', { mergeWaiting: 'suite-in-flight' })],
      counts: { ...boardRes().counts, open: 1 },
    }),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    const classes = classesOf(root).join(' ');
    assert.match(text, /merge waiting/i, 'the row says the merge is still coming');
    assert.match(text, /suite-in-flight/, 'and names the reason core stamped');
    assert.match(classes, /tv-merge-waiting/);
  });
});

// The DISTINCTION, which is the reason core keeps two fields rather than one.
// Both directions, because each half fails a different way: a waiting row
// painted as a failure sends the lead to a merge that needs nothing, and a
// failed row painted quietly leaves the one state requiring intervention
// looking like the one requiring none.
test('waiting and failed are told apart by their MARKS, not only their words (t534)', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 2 })]),
    board: boardRes({
      open: [shaped('t1', { mergeWaiting: 'suite-in-flight' }), shaped('t2', { mergeError: 'clean-tree' })],
      counts: { ...boardRes().counts, open: 2 },
    }),
  }, ({ root }) => {
    const rows = allByClass(root, 'tv-ticket');
    // ENTER: both rows rendered. Every assertion below is about a difference
    // BETWEEN them, and all of those hold vacuously over a board with one row.
    assert.equal(rows.length, 2, 'both rows reached the board');
    const waitingRow = rows.find((r) => textOf(r).join('\n').includes('t1'));
    const failedRow = rows.find((r) => textOf(r).join('\n').includes('t2'));
    assert.ok(waitingRow && failedRow, 'ENTER: each row is identifiable by its id');

    // The waiting row gets NO row-level mark: it resolves by itself, and a
    // painted row would recreate here the "looks like it needs a human"
    // confusion that made core split the fields in the first place.
    assert.doesNotMatch(classesOf(waitingRow).join(' '), /tv-merge-failed/,
      'a deferred merge must not paint the row like a failed one');
    assert.match(classesOf(failedRow).join(' '), /tv-merge-failed/);
    // And the badges are different classes, so the styling that separates them
    // at a glance has something to key on.
    assert.match(classesOf(waitingRow).join(' '), /tv-merge-waiting/);
    assert.doesNotMatch(classesOf(waitingRow).join(' '), /tv-merge-error/);
    assert.match(classesOf(failedRow).join(' '), /tv-merge-error/);
    assert.doesNotMatch(classesOf(failedRow).join(' '), /tv-merge-waiting/);
  });
});

// The precedence, which the row-class expression makes load-bearing. `stalled`
// is NOT gated on the row being open, so a merge that failed and then sat past
// the threshold satisfies both conditions at once, and only one row class can
// win. If the stall took it, the amber edge would cover the red one on exactly
// the rows most needing the lead — and chasing the seat does not clear a merge
// the loop gave up on.
test('a failed merge takes the row edge from a stall it coincides with (t534)', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 1, stalled: 1 })]),
    board: boardRes({
      open: [shaped('t1', { stalled: true, mergeError: 'clean-tree' })],
      counts: { ...boardRes().counts, open: 1 },
    }),
  }, ({ root }) => {
    const rows = allByClass(root, 'tv-ticket');
    // ENTER: the row rendered AND really carries both states, so the class
    // assertions below are about a conflict rather than about a fixture that
    // only ever had one of them.
    assert.equal(rows.length, 1, 'the row reached the board');
    const text = textOf(rows[0]).join('\n');
    assert.match(text, /stalled/, 'ENTER: the stall is genuinely present');
    assert.match(text, /clean-tree/, 'ENTER: and so is the merge failure');
    const classes = classesOf(rows[0]).join(' ');
    assert.match(classes, /tv-merge-failed/, 'the failure wins the row edge');
    assert.doesNotMatch(classes, /tv-stalled/, 'and the stall does not also paint it');
  });
});

// The stylesheet is what makes the previous test's class distinction VISIBLE,
// and a class nothing styles is a mark the lead cannot see. Read as source
// because no fixture here computes styles.
test('both merge classes are styled, and not styled alike (t534)', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'plugins', 'tickets-viewer', 'style.css'), 'utf8');
  for (const cls of ['.tv-merge-error', '.tv-merge-waiting', '.tv-ticket.tv-merge-failed']) {
    assert.ok(css.includes(cls), `${cls} must be styled, or the mark is invisible`);
  }
  // The DECLARATIONS of a rule, found by the rule itself rather than by
  // slicing between two indexOf hits: the comments here name neighbouring
  // selectors (that is what makes them useful), so a bare indexOf can land in
  // prose ABOUT a class instead of on the class, and slice a block that is
  // empty or belongs to something else. That is not hypothetical — the first
  // version of this test did exactly that and reported an empty block.
  const blockOf = (sel) => {
    const m = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, `no rule found for ${sel}`);
    return m[1];
  };
  // The failure takes the error red the board already uses for .tv-error; the
  // deferral must NOT, or the two badges are one mark wearing two names.
  assert.match(blockOf('.tv-merge-error'), /rgb\(230, 110, 110\)/,
    'the failure badge is the error red');
  assert.doesNotMatch(blockOf('.tv-merge-waiting'), /rgb\(230, 110, 110\)/,
    'the waiting badge must not wear the failure colour');
  // The row edge is the same red as the badge — one state, one colour.
  assert.match(blockOf('.tv-ticket.tv-merge-failed'), /rgb\(230, 110, 110\)|rgba\(230, 110, 110/,
    'the row edge matches the badge it belongs to');
});

// Both marks survive into the RECENTLY-CLOSED block. This is the case the
// open-only `stalled`/`parked`/`backlog` chain does not cover and the one the
// text boards call the normal reading: the loop merges after `task done`, so a
// merge that failed or deferred is usually read on a row that is already done.
//
// Both fixtures are STALLED, which is the ordinary shape here rather than an
// exotic one: the recent window is 24h and the stall threshold 30m, so a row in
// this block has almost always been quiet long past it. A `stalled: false`
// fixture would test the closed block in the one condition it is rarely in, and
// would leave the precedence below asserted only on an OPEN row — where losing
// it costs nothing, since the amber and the red say the same thing there.
test('both merge marks render on a recently-CLOSED row too, stalled as they normally are (t534)', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 0 })]),
    board: boardRes({
      recent: [
        shaped('t1', { state: 'done', closedAt: 1, closedBy: 'hand', stalled: true, mergeError: 'clean-tree' }),
        shaped('t2', { state: 'done', closedAt: 1, closedBy: 'hand', stalled: true, mergeWaiting: 'suite-in-flight' }),
      ],
      counts: { ...boardRes().counts, done: 2 },
    }),
  }, ({ root }) => {
    const text = textOf(root).join('\n');
    // ENTER: the closed block rendered at all. Without this the two matches
    // below could be satisfied by a board that painted nothing.
    assert.match(text, /Recently closed/, 'the closed section is on screen');
    assert.match(text, /clean-tree/, 'the failure reaches a closed row');
    assert.match(text, /suite-in-flight/, 'and so does the deferral');

    const rows = allByClass(root, 'tv-ticket');
    assert.equal(rows.length, 2, 'ENTER: both closed rows rendered');
    const failedRow = rows.find((r) => textOf(r).join('\n').includes('clean-tree'));
    assert.ok(failedRow, 'ENTER: the failed row is identifiable by its step');
    // The precedence WHERE IT BITES. This row is stalled and failed at once, so
    // the amber would take the edge on source order and hide the red — on a
    // closed row, which is where a failed merge is normally read.
    assert.match(classesOf(failedRow).join(' '), /tv-merge-failed/,
      'the row-level mark is not gated on the row being open');
    assert.doesNotMatch(classesOf(failedRow).join(' '), /tv-stalled/,
      'and the stall does not take the edge from it here either');
  });
});

test('an ordinary row carries NEITHER merge mark (t534)', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({
      open: [shaped('t1')],
      counts: { ...boardRes().counts, open: 1 },
    }),
  }, ({ root }) => {
    // ENTER: the row is there. `doesNotMatch` over an empty board is true of
    // everything, which is exactly the shape CLAUDE.md warns about.
    assert.match(textOf(root).join('\n'), /t1/, 'the ordinary row rendered');
    const classes = classesOf(root).join(' ');
    assert.doesNotMatch(classes, /tv-merge-error|tv-merge-waiting|tv-merge-failed/,
      'a ticket with no merge stamp must not claim one');
    assert.doesNotMatch(textOf(root).join('\n'), /merge/i);
  });
});

test('a manifest core would reject is WARNED about while the tickets still render', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 1, warning: 'team.json "root" is not an absolute path — core would refuse this team' })]),
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

// ── the spec body ───────────────────────────────────────────────────────────

// The row whose head carries `id`. Every expand assertion goes through the head
// the user would actually click, not through a hand-picked node.
function headOf(root, id) {
  let found = null;
  (function walk(n) {
    if (String(n.className).includes('tv-ticket-head') && textOf(n).includes(id)) found = n;
    n.children.forEach(walk);
  })(root);
  return found;
}

test('a ticket\'s spec is COLLAPSED by default and expands on click', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({
      open: [shaped('t1', { spec: 'line one\n\n- a bullet\n- another' })],
      counts: { ...boardRes().counts, open: 1 },
    }),
  }, ({ root }) => {
    // Scan-density is the board's strength: twenty-one rows each opening with a
    // couple of KB of spec is a different, worse surface.
    assert.doesNotMatch(textOf(root).join('\n'), /a bullet/, 'collapsed by default');

    headOf(root, 't1').click();

    const text = textOf(root).join('\n');
    assert.match(text, /line one/);
    assert.match(text, /a bullet/, 'the whole body, not a first line');
    // classesOf SPLITS className into tokens, so the no-spec branch contributes
    // both `tv-spec` and `tv-no-spec` and an anchored /tv-spec/ still matches
    // it. The absence is what tells the two branches apart.
    const specClasses = classesOf(root).join(' ');
    assert.match(specClasses, /(^|\s)tv-spec(\s|$)/);
    assert.doesNotMatch(specClasses, /tv-no-spec/, 'the body branch, not the placeholder one');

    // And back: a toggle that only opens turns the board into the wall of text
    // the collapse exists to prevent.
    headOf(root, 't1').click();
    assert.doesNotMatch(textOf(root).join('\n'), /a bullet/, 'clicking again collapses it');
  });
});

test('a long title stays recoverable on hover after the head took a click hint', async () => {
  // .tv-ticket-title ellipsizes, so its own hover is the only way back to the
  // full text. The head now carries the expand hint; if the title span does not
  // carry its own, the nearer-element rule hands the reader the hint instead.
  const long = 'a title far too long for the row to show without ellipsizing it somewhere';
  await withDom({
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({ open: [shaped('t1', { title: long })], counts: { ...boardRes().counts, open: 1 } }),
  }, ({ root }) => {
    let titleNode = null;
    (function walk(n) {
      if (String(n.className).includes('tv-ticket-title')) titleNode = n;
      n.children.forEach(walk);
    })(root);
    assert.equal(titleNode.title, long);
  });
});

test('a spec containing markup renders as TEXT, never as elements', async () => {
  // Spec bodies are agent-authored and are the strongest untrusted-input case on
  // this surface. The text assertion alone is satisfied by an innerHTML
  // implementation too — the querySelector half is the one that can fail.
  await withDom({
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({
      open: [shaped('t1', { spec: 'before <img src=x onerror="boom()"> after' })],
      counts: { ...boardRes().counts, open: 1 },
    }),
  }, ({ root }) => {
    headOf(root, 't1').click();
    assert.match(textOf(root).join('\n'), /<img src=x onerror="boom\(\)">/,
      'the markup is shown to the reader, as the characters it is');
    assert.equal(root.querySelector('img'), null, 'and never became an element');
  });
});

test('a ticket with NO spec says so rather than expanding to a blank', async () => {
  // Whitespace belongs here and not in a case of its own: "\n  \n" is truthy,
  // so a presence test passes it through to an empty <pre> — the same blank box
  // an absent spec would give, which is exactly what this branch exists to
  // prevent.
  for (const spec of ['', '\n  \n']) {
    await withDom({
      projects: projectsRes([projectRow({ open: 1 })]),
      board: boardRes({ open: [shaped('t1', { spec })], counts: { ...boardRes().counts, open: 1 } }),
    }, ({ root }) => {
      headOf(root, 't1').click();
      // Same rule the artifact path follows: an empty body reads as a rendering
      // gap, and "there is nothing recorded" is the actionable half of the answer.
      assert.match(textOf(root).join('\n'), /no spec recorded/, `spec ${JSON.stringify(spec)}`);
      assert.match(classesOf(root).join(' '), /tv-no-spec/, `spec ${JSON.stringify(spec)}`);
    });
  }
});

test('recently-closed renders below the open list and is capped-marked', async () => {
  await withDom({
    projects: projectsRes([projectRow({ open: 1 })]),
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
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({ open: [shaped('t1')] }),
  }, ({ root }) => {
    assert.doesNotMatch(textOf(root).join('\n'), /Recently closed/);
  });
});

test('a board fetch that lands after a RELOAD does not paint over it', async () => {
  // The monotonic-token bug class we fixed in memory-viewer. selectSeq alone is
  // not enough: renderProjects returns EARLY when the list fails, so it never
  // starts a new select and never bumps selectSeq — an in-flight board result
  // then paints tickets over the error the user is looking at.
  let resolveBoard;
  const pending = new Promise((r) => { resolveBoard = r; });
  let listCalls = 0;
  const { root, restore } = fakeDom();
  const rhost = {
    invoke(method) {
      if (method === 'projects') {
        listCalls += 1;
        return Promise.resolve(listCalls === 1
          ? projectsRes([projectRow({ open: 1 })])
          : { ok: false, error: 'could not read /x/projects (EACCES)' });
      }
      // `sessions` rides with the board fetch, so it must hang too — resolving
      // it while the board hangs would let the select finish half-way.
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
    await rhost._overlay.onOpen();   // list ok → selects the project → board hangs
    await settle();
    await rhost._overlay.onOpen();   // reload: the list now fails, no new select
    await settle();
    resolveBoard(boardRes({ open: [shaped('t-stale')], counts: { ...boardRes().counts, open: 1 } }));
    await settle();

    const text = textOf(root).join('\n');
    assert.match(text, /Could not read the projects directory/, 'the reload\'s error survives');
    assert.doesNotMatch(text, /t-stale/, 'a board from before the reload must not paint');
  } finally { teardown(); restore(); }
});

// ── the CRUD surface (t304) ─────────────────────────────────────────────────

// The board a mutating case starts from: one open ticket, one live seat to
// assign it to.
function crudAnswers(over = {}) {
  return {
    projects: projectsRes([projectRow({ open: 1 })]),
    board: boardRes({ open: [shaped('t1', { title: 'do the thing', spec: 'the original spec' })], counts: { ...boardRes().counts, open: 1 } }),
    sessions: { ok: true, sessions: ['hand-1', 'hand-2'] },
    ...over,
  };
}

test('every CRUD action is reachable with NO team defined', async () => {
  // The ticket's premise: the board is the project's, so a project no team
  // names must still offer the whole surface. A control that only appeared for
  // a team would strand the solo operator the feature is for.
  await withDom(crudAnswers({
    projects: projectsRes([projectRow({ team: '', open: 1 })]),
    board: boardRes({
      team: '', open: [shaped('t1')], counts: { ...boardRes().counts, open: 1 },
    }),
  }), ({ root }) => {
    for (const label of ['+ New ticket', 'Edit spec', 'Close', 'Cancel']) {
      assert.ok(buttonLabelled(root, label), `${label} must be reachable with no team`);
    }
    assert.equal(allByClass(root, 'tv-assign').length, 1, 'and so must the assign control');
  });
});

test('the add form opens a ticket with the spec and assignee the operator chose', async () => {
  await withDom(crudAnswers({ add: { ok: true, id: 't2', delivered: true } }), async ({ root, calls, settle }) => {
    buttonLabelled(root, '+ New ticket').click();

    const area = allByClass(root, 'tv-editor-spec')[0];
    assert.ok(area, 'the editor opened');
    // A textarea, never a prompt(): a spec is multi-line, and prompt collapses
    // it to one line — which would silently rewrite every spec typed into it.
    assert.equal(area.tag, 'textarea');
    area.value = 'tasks/new-thing — a new ticket\n\nwith a second line';

    const picker = allByClass(root, 'tv-editor-assignee')[0];
    assert.ok(picker, 'the add form offers an assignee');
    picker.value = 'hand-2';

    buttonLabelled(root, 'Open ticket').click();
    await settle();

    const add = calls.find((c) => c.method === 'add');
    assert.ok(add, 'the engine was asked to add');
    assert.deepEqual(add.arg, {
      project: 'proj-1234abcd',
      spec: 'tasks/new-thing — a new ticket\n\nwith a second line',
      assignee: 'hand-2',
    }, 'the whole multi-line spec crosses, with the chosen seat');

    // The surface is pull-on-open, so a write that did not re-read would leave
    // the operator looking at a board that no longer matches the disk.
    assert.ok(calls.filter((c) => c.method === 'board').length >= 2,
      'the board is re-read after a successful write');
    assert.equal(allByClass(root, 'tv-editor-spec').length, 0, 'and the editor closed');
  });
});

test('the add form defaults to UNASSIGNED, which is a backlog ticket', async () => {
  await withDom(crudAnswers({ add: { ok: true, id: 't2', delivered: false } }), async ({ root, calls, settle }) => {
    buttonLabelled(root, '+ New ticket').click();
    allByClass(root, 'tv-editor-spec')[0].value = 'no seat for this one';
    buttonLabelled(root, 'Open ticket').click();
    await settle();

    // Opening to the backlog is a first-class outcome, not a degraded one — it
    // is the only outcome available on a box with nothing running.
    assert.equal(calls.find((c) => c.method === 'add').arg.assignee, '');
  });
});

test('an add with an empty spec never reaches the engine', async () => {
  await withDom(crudAnswers(), async ({ root, calls, toasts, settle }) => {
    buttonLabelled(root, '+ New ticket').click();
    allByClass(root, 'tv-editor-spec')[0].value = '   \n\n  ';
    buttonLabelled(root, 'Open ticket').click();
    await settle();

    assert.equal(calls.filter((c) => c.method === 'add').length, 0,
      'the operator is told before a round trip, not after');
    assert.match(toasts.map((t) => t.msg).join('\n'), /needs a spec/);
    assert.ok(allByClass(root, 'tv-editor-spec')[0], 'and the editor stays open with their text');
  });
});

test('the spec editor opens SEEDED with the current spec, and saves the edit', async () => {
  await withDom(crudAnswers({ editSpec: { ok: true } }), async ({ root, calls, settle }) => {
    buttonLabelled(root, 'Edit spec').click();

    const area = allByClass(root, 'tv-editor-spec')[0];
    // Seeded, because an editor that opened blank turns every edit into a
    // rewrite from scratch — and the engine replaces the whole field.
    assert.equal(area.value, 'the original spec', 'the editor starts from what is there');

    area.value = 'the corrected spec';
    buttonLabelled(root, 'Save spec').click();
    await settle();

    assert.deepEqual(calls.find((c) => c.method === 'editSpec').arg,
      { project: 'proj-1234abcd', id: 't1', spec: 'the corrected spec' });
  });
});

test('the assign control offers the live seats and reassigns on pick', async () => {
  await withDom(crudAnswers({ assign: { ok: true, delivered: true } }), async ({ root, calls, settle }) => {
    const picker = allByClass(root, 'tv-assign')[0];
    const options = picker.children.map((o) => o.value);
    // A select over live seats, not a text field: with no team an assignee IS a
    // session name, so the valid answers are known and typing one is a chance
    // to typo a ticket into a seat that does not exist.
    assert.ok(options.includes('hand-2'), 'a live seat is offered');
    assert.ok(options.includes(''), 'and the no-change option leads');

    picker.change('hand-2');
    await settle();

    assert.deepEqual(calls.find((c) => c.method === 'assign').arg,
      { project: 'proj-1234abcd', id: 't1', assignee: 'hand-2' });
  });
});

test('picking the no-change option does NOT reassign', async () => {
  await withDom(crudAnswers({ assign: { ok: true, delivered: true } }), async ({ root, calls, settle }) => {
    allByClass(root, 'tv-assign')[0].change('');
    await settle();
    // The head option exists to display the current holder; firing on it would
    // reassign a ticket to nobody every time the control was touched.
    assert.equal(calls.filter((c) => c.method === 'assign').length, 0);
  });
});

test('an assignment nobody could be told about is REPORTED, not silently ok', async () => {
  await withDom(crudAnswers({ assign: { ok: true, delivered: false } }), async ({ root, toasts, settle }) => {
    allByClass(root, 'tv-assign')[0].change('hand-2');
    await settle();

    // The one outcome an ok/error pair cannot express: the ticket IS assigned,
    // so this is not a failure, but a seat that was never sent the spec will
    // never start — and that looks exactly like a seat working quietly.
    const said = toasts.map((t) => t.msg).join('\n');
    assert.match(said, /hand-2/);
    assert.match(said, /not delivered|not running/i);
  });
});

test('a delivered assignment says nothing at all', async () => {
  await withDom(crudAnswers({ assign: { ok: true, delivered: true } }), async ({ root, toasts, settle }) => {
    allByClass(root, 'tv-assign')[0].change('hand-2');
    await settle();
    // The accept half of the case above: a notice on every success trains the
    // operator to dismiss the one that matters.
    assert.deepEqual(toasts, []);
  });
});

test('close and cancel CONFIRM first, and do nothing when declined', async () => {
  for (const [label, method] of [['Close', 'close'], ['Cancel', 'cancel']]) {
    // Declined.
    await withConfirm(false, (asked) => withDom(crudAnswers({ [method]: { ok: true } }),
      async ({ root, calls, settle }) => {
        buttonLabelled(root, label).click();
        await settle();
        assert.equal(asked.length, 1, `${label} asks first`);
        assert.match(asked[0], /t1/, 'and names the ticket it would act on');
        assert.equal(calls.filter((c) => c.method === method).length, 0,
          `a declined ${label} must not reach the engine`);
      }));

    // Confirmed — the accept half, without which the assertion above passes for
    // a button that does nothing at all.
    await withConfirm(true, () => withDom(crudAnswers({ [method]: { ok: true } }),
      async ({ root, calls, settle }) => {
        buttonLabelled(root, label).click();
        await settle();
        assert.deepEqual(calls.find((c) => c.method === method).arg,
          { project: 'proj-1234abcd', id: 't1' }, `a confirmed ${label} acts`);
      }));
  }
});

test('a failed write is reported and does NOT close the editor', async () => {
  await withDom(crudAnswers({ add: { ok: false, error: 'refusing to write: tickets.json is not valid JSON' } }),
    async ({ root, toasts, settle }) => {
      buttonLabelled(root, '+ New ticket').click();
      allByClass(root, 'tv-editor-spec')[0].value = 'some real work';
      buttonLabelled(root, 'Open ticket').click();
      await settle();

      const said = toasts.map((t) => t.msg).join('\n');
      assert.match(said, /refusing to write/, 'the engine\'s reason reaches the operator');
      assert.equal(toasts[0].kind, 'error');
      // The text must survive: closing the editor on failure discards what the
      // operator typed, and a spec is minutes of writing.
      assert.equal(allByClass(root, 'tv-editor-spec')[0].value, 'some real work',
        'the operator does not lose their spec to a failed write');
    });
});

test('a CLOSED ticket offers no lifecycle action', async () => {
  await withDom(crudAnswers({
    board: boardRes({
      open: [], recent: [shaped('t9', { state: 'done', closedAt: Date.now() - HOUR, closedBy: 'hand' })],
    }),
  }), ({ root }) => {
    // Reopening is `[agent:task reject]`, which carries the notice to the seat
    // that a silent state flip here would not. Offering Close on a closed row
    // would also overwrite closedAt/closedBy with the viewer's.
    assert.equal(buttonLabelled(root, 'Close'), null);
    assert.equal(buttonLabelled(root, 'Cancel'), null);
    assert.equal(allByClass(root, 'tv-assign').length, 0);
    // The row itself is still there — this is about actions, not visibility.
    assert.match(textOf(root).join('\n'), /t9/);
  });
});

test('the surface contributes one footer button and no other entry point', async () => {
  await withDom(crudAnswers(), ({ rhost }) => {
    assert.equal(rhost._button.label, 'Tickets');
  });
});
