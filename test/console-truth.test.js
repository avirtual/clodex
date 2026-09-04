'use strict';
// console-truth.test.js — the Console pane must not claim something happened
// that did not. Three symptoms: a repainted record, a repeating gap marker, and
// a backgrounded call drawn as one that printed nothing.
//
// The first two are cross-POLL, so both are structurally invisible to a
// single-poll assertion: what one pull returns is correct in isolation in each
// case, and only the SEQUENCE of what the pane painted is wrong.
// test/bash-console.test.js asserts single pulls and passes over both.
//
// Those two are also invisible under real nanosecond stamps. `date +%s%N` makes every
// record its own timestamp group, the group re-serve never has more than the
// cursor in it, and neither symptom exists. The regime that produces them is a
// `date` without `%N` (macOS 12-14, the README floor), where a whole second's
// records share one stamp — so every fixture here writes one shared stamp on
// purpose. cli-hooks.test.js reaches the same regime from the other end, by
// putting a stubbed `date` on PATH ahead of the generated script.
//
// The tenant is driven through the REAL reader over a REAL spool directory: the
// first defect lives in the seam between them (the reader is stateless, the
// dedupe set is the tenant's), so a fixture that faked either half could not see
// it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readBashConsole, PULL_MAX_RECORDS } = require('../bash-console');
const { pathFor } = require('../clodex-paths');

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

// A real element serializes textContent into innerHTML with & < > escaped, and
// renderer/lib/format.js `esc` round-trips a string through exactly that pair.
// A stub whose textContent does not reach innerHTML makes `esc` return empty,
// which silently empties every assertion below that reads a painted command.
function el(tag = 'div') {
  const e = {
    tagName: tag, children: [], parentNode: null, id: '',
    title: '', type: '', className: '',
    dataset: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, setAttribute() {},
    get textContent() { return e._text || ''; },
    set textContent(v) {
      e._text = String(v == null ? '' : v);
      e._html = e._text.replace(/[&<>]/g, (c) => ENT[c]);
      e.children = [];
    },
    get innerHTML() { return e._html || ''; },
    set innerHTML(v) { e._html = String(v); e._text = ''; e.children = []; },
    get firstElementChild() { return e.children[0] || null; },
    get childElementCount() { return e.children.length; },
    appendChild(c) {
      if (c.parentNode) c.remove();
      c.parentNode = e; e.children.push(c); return c;
    },
    remove() {
      if (!e.parentNode) return;
      const i = e.parentNode.children.indexOf(e);
      if (i >= 0) e.parentNode.children.splice(i, 1);
      e.parentNode = null;
    },
    querySelector(sel) {
      const hit = e.children.find((c) => `#${c.id}` === sel || `.${c.className}` === sel);
      if (hit) return hit;
      const made = el('div');
      made.id = sel.slice(1);
      return e.appendChild(made);
    },
  };
  return e;
}

const OK = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_response: { stdout: 'ok', stderr: '' },
  duration_ms: 1,
};

// What the pane DREW, read back off the node the tenant appended: a block's
// command, or `GAP` for a gap marker. Reading the rendered node rather than the
// records array is the point — the records array is right in both defects.
function drawn(node) {
  if (String(node.className).includes('console-gap')) return 'GAP';
  const m = /console-block-cmd">([^<]*)</.exec(node.innerHTML);
  return m ? m[1] : null;
}

// Mounts the real tenant over a real spool dir and returns a driver whose
// `poll()` is the tenant's OWN interval callback, so the sequence is the one the
// pane really paints rather than a re-implementation of it.
//
// Async because `onShow` fires an immediate pull of its own: while that one is
// in flight the tenant's `pulling` guard makes the next poll a no-op, so a
// caller that started writing records straight away would lose its first tick
// and every ENTER check below it.
async function mountPane(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-repaint-'));
  const dir = pathFor(root, 'agent1', 'bashConsole');
  fs.mkdirSync(dir, { recursive: true });

  const had = { d: global.document, w: global.window };
  global.document = { createElement: el, addEventListener() {} };
  global.window = {
    __CLODEX_WEB__: false,
    api: { consoleRead: async (name, cursor) => readBashConsole(root, name, cursor) },
  };
  const hadClear = global.clearInterval;
  t.after(() => {
    global.document = had.d;
    global.window = had.w;
    global.clearInterval = hadClear;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { createConsoleTab } = require('../renderer/console-tab');
  let tenant = null;
  const host = {
    register: (spec) => { tenant = spec; return Object.assign(() => {}, { selectionChanged: () => {} }); },
    domSelection: () => '',
    open() {},
  };
  createConsoleTab({ host, getActiveSession: () => 'agent1', getSeatType: () => 'claude' });

  const pane = el('div');
  tenant.mount(pane, el('div'));
  const body = pane.querySelector('#console-body');
  const painted = [];
  const append = body.appendChild;
  body.appendChild = (c) => {
    const d = drawn(c);
    if (d) painted.push(d);
    return append(c);
  };

  // Capture the tenant's interval callback so polls are DRIVEN, not timed: a
  // test that slept POLL_MS per poll would take seconds and still race.
  let poll = null;
  const realInterval = global.setInterval;
  global.setInterval = (fn) => { poll = fn; return 1; };
  global.clearInterval = () => {};
  tenant.onShow();
  global.setInterval = realInterval;

  const settle = () => new Promise((r) => setTimeout(r, 0));
  await settle();
  await settle();
  assert.deepStrictEqual(painted, [], 'ENTER: the pane starts empty, with onShow\'s own pull drained');

  return {
    dir,
    body,
    painted,
    write(cmd, pid, stamp) {
      fs.writeFileSync(path.join(dir, `${stamp}-${pid}.json`),
        JSON.stringify({ ...OK, tool_input: { command: cmd }, tool_use_id: `t-${cmd}` }));
    },
    async tick() { await poll(); await settle(); await settle(); },
  };
}

// One shared whole-second stamp, zero-padded to the 19-wide shape the hook's
// `%N`-less fallback produces.
const STAMP = '0000000001788481092';

// The cursor names ONE file in its timestamp group. Excluding that file from the
// re-serve means it is absent from the raw batch, and the tenant REPLACES
// `lastKeys` from each raw batch rather than accumulating — so the excluded file
// falls out of the dedupe set and is repainted by the next poll that re-serves
// its group. Serving the whole group instead keeps every drawn key in the set,
// which is what the module's own note already describes.
test('a record already drawn is not painted a second time when its group is re-served', async (t) => {
  const p = await mountPane(t);

  p.write('A', 8, STAMP);
  await p.tick();
  assert.deepStrictEqual(p.painted, ['A'], 'ENTER: the first call really was painted');

  await p.tick();

  // Same second, higher pid: B joins A's timestamp group rather than opening a
  // new one, which is the whole regime under test.
  p.write('B', 9, STAMP);
  await p.tick();
  assert.deepStrictEqual(p.painted, ['A', 'B'], 'ENTER: the second call really was painted too');

  // The idle poll that re-serves the group. Nothing new has been written, so
  // nothing may be painted.
  await p.tick();

  assert.deepStrictEqual(p.painted, ['A', 'B'],
    `an idle poll repainted a call the pane already showed: ${p.painted.join(' ')}`);
  assert.strictEqual(new Set(p.painted).size, p.painted.length,
    'no command appears twice in the painted sequence');
});

// The same defect at the scale it was measured: a whole second of records, all
// one group, drained over many polls. A repeat here is a command the operator
// sees twice and cannot tell from a command that really ran twice.
test('a whole second of records drains across polls with nothing painted twice', async (t) => {
  const p = await mountPane(t);
  const N = 12;

  for (let i = 0; i < N; i++) {
    p.write(`cmd-${i}`, 100 + i, STAMP);
    await p.tick();
  }
  await p.tick();
  await p.tick();

  assert.strictEqual(p.painted.length, N,
    `every record painted exactly once: expected ${N}, got ${p.painted.length} (${p.painted.join(' ')})`);
  assert.deepStrictEqual([...p.painted].sort(), Array.from({ length: N }, (_, i) => `cmd-${i}`).sort(),
    'and the set painted is exactly the set written — none lost, none invented');
});

// A lower-pid arrival lands BELOW the cursor inside the shared group, so a
// strict `f > cursor` scan drops it forever. That tolerance is why the group is
// re-served at all, and it must not cost a repeat.
test('a late lower-pid record in the cursor group is painted, and painted once', async (t) => {
  const p = await mountPane(t);

  p.write('high', 9, STAMP);
  await p.tick();
  assert.deepStrictEqual(p.painted, ['high'], 'ENTER: the cursor record was painted');

  p.write('low', 8, STAMP);
  await p.tick();
  await p.tick();

  assert.deepStrictEqual(p.painted, ['high', 'low'],
    'the record sorting below the cursor reaches the pane exactly once');
});

// If more than PULL_MAX_RECORDS records share the top timestamp group and the
// seat goes quiet, the cursor cannot advance past the group, so `skipped` stays
// above zero on every poll. Appending a gap node each time fills MAX_BLOCKS and
// scrolls the real blocks out — the pane reporting a fresh loss every 1.2s when
// nothing has been lost since the first one.
test('a stalled backlog reports its gap once, not once per poll', async (t) => {
  const p = await mountPane(t);
  const total = PULL_MAX_RECORDS + 5;

  for (let i = 0; i < total; i++) p.write(`c${i}`, 200 + i, STAMP);

  await p.tick();
  const gapsAfterFirst = p.painted.filter((x) => x === 'GAP').length;
  assert.strictEqual(gapsAfterFirst, 1, 'ENTER: the backlog really did report a gap');
  assert.ok(p.painted.length > 1, 'ENTER: and it carried records alongside the gap');

  await p.tick();
  await p.tick();
  await p.tick();

  assert.strictEqual(p.painted.filter((x) => x === 'GAP').length, 1,
    `the gap marker repeated on idle polls: ${p.painted.filter((x) => x === 'GAP').length} markers`);
});

// The suppression is on an UNCHANGED count, not on the marker having been shown.
// A backlog that grows is a new loss and must say so, or the pane goes quiet
// exactly when it is falling further behind.
test('a gap that GROWS is reported again', async (t) => {
  const p = await mountPane(t);
  for (let i = 0; i < PULL_MAX_RECORDS + 5; i++) p.write(`c${i}`, 200 + i, STAMP);

  await p.tick();
  assert.strictEqual(p.painted.filter((x) => x === 'GAP').length, 1, 'ENTER: the first gap was reported');

  // More records into the same stalled group, at pids that sort BELOW the served
  // window: the second poll returns nothing the pane has not already drawn, so
  // the append can only come from the COUNT rising. Growth pids INSIDE the
  // window make this pass against a naive `gapShown` boolean.
  for (let i = 0; i < 10; i++) p.write(`e${i}`, 100 + i, STAMP);
  await p.tick();

  assert.strictEqual(p.painted.filter((x) => x === 'GAP').length, 2,
    'a larger backlog is a new loss and is reported');
});

// The mirror of the growth case, and the reason the guard is `<=` rather than
// `===`. The CLI-side prune reaps the OLDEST records while the cursor survives,
// so a stalled group can shrink: `skipped` drops 10 -> 2 and an equality guard
// reads that as a new loss, announcing 2 for a backlog it already reported as
// 10. The smaller number was already covered by the larger one.
test('a gap that SHRINKS is not reported again', async (t) => {
  const p = await mountPane(t);
  const total = PULL_MAX_RECORDS + 5;
  for (let i = 0; i < total; i++) p.write(`c${i}`, 200 + i, STAMP);

  await p.tick();
  assert.strictEqual(p.painted.filter((x) => x === 'GAP').length, 1,
    'ENTER: the full backlog really did report its gap');

  // The prune reaps the three oldest, which are below the served window, so the
  // next poll returns the same 50 records and a SMALLER skipped count.
  for (let i = 0; i < 3; i++) fs.rmSync(path.join(p.dir, `${STAMP}-${200 + i}.json`));
  await p.tick();

  assert.strictEqual(p.painted.filter((x) => x === 'GAP').length, 1,
    'a backlog that shrank re-announced a loss already reported as a larger one');
});

// A payload carrying BOTH flags must not be told the output never arrived while
// 30000 chars of it are on screen above the note. The backgrounded branch is
// guarded on there being no output for exactly this reason: measured payloads
// are all empty, but the note is a claim about the screen, not about the flag.
test('a backgrounded call that DID carry output gets the truncation note', async (t) => {
  const p = await mountPane(t);

  fs.writeFileSync(path.join(p.dir, `${STAMP}-8.json`), JSON.stringify({
    ...OK,
    tool_input: { command: 'seq 1 20000' },
    tool_use_id: 't-bg-out',
    tool_response: {
      stdout: 'x'.repeat(120), stderr: '', interrupted: false,
      backgroundTaskId: 'b0zgstcy6',
      persistedOutputPath: '/tmp/out.txt', persistedOutputSize: 108894,
    },
  }));
  await p.tick();
  assert.deepStrictEqual(p.painted, ['seq 1 20000'], 'ENTER: the call really was painted');

  const block = p.body.children[p.body.children.length - 1];
  assert.doesNotMatch(block.innerHTML, /never sent here/,
    'output is on screen, so the pane must not claim it never arrived');
  assert.match(block.innerHTML, /output truncated by the CLI/,
    'the note that describes what IS on screen is the truncation one');
});

// The CLI auto-backgrounds Bash calls under parallel load. Those PostToolUse
// payloads carry `backgroundTaskId` on `tool_response` with stdout and stderr
// both EMPTY — measured across every transcript on the author's box, 23 such
// responses, 23 of them empty, none carrying a byte of output. The bytes never
// reach the hook, so nothing at the capture layer can recover them; the only
// defect in reach is the pane drawing a block that reads as "this printed
// nothing" for a command that printed plenty.
test('a backgrounded call says its output was never sent, not that there was none', async (t) => {
  const p = await mountPane(t);

  fs.writeFileSync(path.join(p.dir, `${STAMP}-7.json`), JSON.stringify({
    ...OK,
    tool_input: { command: 'npm run build' },
    tool_use_id: 't-bg',
    tool_response: {
      stdout: '', stderr: '', interrupted: false, isImage: false,
      noOutputExpected: false, backgroundTaskId: 'b0zgstcy6',
    },
  }));
  await p.tick();
  assert.deepStrictEqual(p.painted, ['npm run build'], 'ENTER: the call really was painted');

  const block = p.body.children[p.body.children.length - 1];
  assert.match(block.innerHTML, /console-block-note/,
    'a backgrounded call must carry a note rather than a bare empty block');
  assert.match(block.innerHTML, /never sent here/,
    'and the note must say the output never arrived, not that the command was quiet');
});

// The note is specific to the backgrounded case: an ordinary call that genuinely
// printed nothing must NOT be labelled, or the pane starts excusing silence it
// has no reason to excuse.
test('an ordinary call with no output carries no such note', async (t) => {
  const p = await mountPane(t);

  fs.writeFileSync(path.join(p.dir, `${STAMP}-7.json`), JSON.stringify({
    ...OK,
    tool_input: { command: 'true' },
    tool_use_id: 't-quiet',
    tool_response: { stdout: '', stderr: '', interrupted: false },
  }));
  await p.tick();
  assert.deepStrictEqual(p.painted, ['true'], 'ENTER: the quiet call really was painted');

  const block = p.body.children[p.body.children.length - 1];
  assert.doesNotMatch(block.innerHTML, /console-block-note/,
    'a genuinely silent command is drawn as silent, with nothing claimed about why');
});
