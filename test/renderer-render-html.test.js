// Run: node --test
// Covers renderer/lib/render-html.js `bustRow` — the /_bust panel row.
//
// The module's builders route through format.esc, which HTML-escapes via a
// detached DOM node, so a `document` is required. Rather than jsdom (the R1 rule
// forbids it), this installs the same kind of minimal stub other renderer tests
// already use (api-shim.test.js:41, plugin-host.test.js:133) — with one
// difference that matters here: createElement returns a node whose
// textContent->innerHTML transform actually escapes, because escaping is the
// property half these tests assert. A stub that passed bytes through would make
// the XSS pin vacuous.
const { test } = require('node:test');
const assert = require('node:assert');

function fakeNode() {
  let text = '';
  return {
    set textContent(v) { text = v == null ? String(v) : String(v); },
    get textContent() { return text; },
    // What a real detached div does: & < > become entities, quotes do NOT
    // (format.esc adds those two itself, which is why it does).
    get innerHTML() {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  };
}

const prevDoc = global.document;
global.document = { createElement: () => fakeNode() };
const { bustRow, renderDiffHtml } = require('../renderer/lib/render-html');
process.on('exit', () => {
  if (prevDoc === undefined) delete global.document; else global.document = prevDoc;
});

// A transition in the shape /_bust actually returns, verified against session
// a68b0455 (69 busts). Overridable per test.
function tx(over = {}) {
  const { locus, ...rest } = over;
  return {
    i: 300, ts: '2026-07-22T20:59:42', severity: 'full-rewrite', bust: true,
    class: 'preamble', fault: 'content', restart_between: false,
    fix_hint: 'messages[0] (claudeMd / userEmail / currentDate / scratchpad) changed — peel the volatile line to the tail',
    write_tokens: 25886, write_frac: 0.72,
    prev_messages: 386, cur_messages: 4,
    locus: {
      segment: 'messages', index: 0, role: 'user', block: 2, char_offset: 198,
      label: 'messages[0].user text', appended: false,
      old: 'ry:\n1. Primary Request and Intent:\n   - Session opened with: "your session was r',
      new: 'ry:\n1. Primary Request and Intent:\n   - Continue as team lead (seat "clodex") on',
      ...locus,
    },
    ...rest,
  };
}

const hasDiff = (h) => h.includes('class="bust-diff"');
const hasHint = (h) => h.includes('class="bust-hint"');
const hasCompactBadge = (h) => h.includes('/compact rewrote messages[0]');

// ---------------------------------------------------------------- (a) escaping

test('bustRow: divergence snippets are escaped and cannot break out of the markup', () => {
  // Raw request bytes really do contain markup and backticks — the live
  // claudeMd-bundle locus at turn 1090 carries `build/` and `"build"` verbatim.
  const html = bustRow(tx({
    locus: {
      old: 'a `tick` & <b>bold</b>\nsecond line',
      new: 'a `tick` & <script>alert("x")</script>\nsecond "line"',
    },
  }), null, null);

  // ENTER: this test is worthless if the row has no diff block to escape into.
  assert.ok(hasDiff(html),
    'the row must actually contain a diff block — otherwise this test asserts escaping of markup that was never rendered');

  assert.ok(!html.includes('<script>'),
    'a <script> tag from a captured request body must not reach the markup verbatim — this is raw bytes from the wire rendered into the operator\'s panel');
  assert.ok(!html.includes('<b>bold</b>'),
    'markup in the OLD snippet must be escaped too — both sides come off the wire');
  assert.ok(html.includes('&lt;script&gt;'), 'the tag must appear escaped, not dropped — the operator needs to see what changed');
  assert.ok(html.includes('&amp;'), '& must be escaped, or a following entity name would be swallowed');
  assert.ok(html.includes('&quot;'), 'quotes must be escaped — esc() escapes them so a snippet is safe in an attribute context too');
  assert.ok(html.includes('`tick`'), 'backticks are not markup and must survive readable');

  // Literal newlines are visible rather than layout breaks: the snippet is a
  // 40-char window cut by character offset, so a real break would present one
  // window as two lines of text.
  assert.ok(html.includes('class="bust-nl"'),
    'a literal \\n in a snippet must render as a visible glyph — the window is cut by char offset, not by line, so a layout break misrepresents it');
  const between = html.slice(html.indexOf('class="bust-diff"'));
  assert.ok(!/\n(?!$)/.test(between.replace(/\n$/, '')) || !between.includes('\nsecond'),
    'the raw newline must not survive into the diff block as a break');
});

test('bustRow: char_offset is shown when present and absent when not', () => {
  const withOff = bustRow(tx(), null, null);
  assert.ok(withOff.includes('@ char 198'),
    'char_offset says how deep into the segment the change landed, which is what determines how much has to be re-written');

  const noOff = bustRow(tx({ locus: { char_offset: null } }), null, null);
  assert.ok(hasDiff(noOff),
    'ENTER: the no-offset row must still render its diff block, or this asserts nothing about the offset');
  assert.ok(!noOff.includes('@ char'),
    'a null char_offset must render no offset line rather than "@ char null"');
});

// -------------------------------------------------------- (b) degrade to today

test('bustRow: a locus with nothing to show renders today\'s row and NO empty diff block', () => {
  // Three shapes in the live data, all of which must degrade identically:
  //   tools        — locus has no old/new keys at all (a roster change has no
  //                  text offset, so char_offset is null too)
  //   conversation — the keys are present but both are the empty string
  //   lapse        — there is no locus at all
  // Testing the strings rather than the keys is what covers all three at once.
  const shapes = [
    ['tools', tx({ class: 'tools', locus: { segment: 'tools', index: 0, label: 'tools[] changed (11->10 tools)', appended: false, old: undefined, new: undefined, char_offset: undefined } })],
    ['conversation', tx({ class: 'conversation', locus: { label: 'messages[173].user changed', old: '', new: '', char_offset: 4 } })],
    ['no locus', tx({ locus: undefined })],
  ];
  for (const [name, t] of shapes) {
    if (name === 'no locus') delete t.locus;
    const html = bustRow(t, null, null);
    assert.ok(!hasDiff(html),
      `${name}: a locus carrying no text must render no diff block — an empty -/+ pair claims a divergence was located when none was`);
    assert.ok(!html.includes('@ char'),
      `${name}: and no bare offset line either, with nothing for it to point into`);
    // …but the row itself must still be a complete row.
    assert.ok(html.includes('class="bust-row'), `${name}: the row must still render`);
    assert.ok(html.includes('class="bust-what"'), `${name}: with its label heading intact`);
  }
});

test('bustRow: a one-sided divergence still renders (old present, new empty)', () => {
  // _text_first_diff can hand back an empty window on one side (a truncation).
  // That is genuinely something to show, so the guard must be OR, not AND.
  const html = bustRow(tx({ locus: { old: 'text that went away', new: '' } }), null, null);
  assert.ok(hasDiff(html),
    'one empty side is still a divergence worth rendering — only BOTH empty means the locus located no text');
  assert.ok(html.includes('text that went away'), 'and the side that has content must be shown');
});

// ------------------------------------------------------- (c) inherent compacts

test('bustRow: a /compact-caused preamble bust is badged inherent and loses the generic hint', () => {
  // Two shapes in the live data, 38 of 39 preamble busts between them.
  const cases = [
    // 30 of 39 — the thread collapses to a summary (386 -> 4).
    ['collapse', tx()],
    // 8 of 39 — the /compact local-command markers are APPENDED to messages[0],
    // so the message count goes N -> N+1 and looks like a normal turn. From the
    // payload alone this is a one-character insert that rewrote 63k tokens.
    ['appended markers', tx({
      prev_messages: 78, cur_messages: 79, write_tokens: 63807,
      locus: {
        char_offset: 14621,
        old: 'ast task as if the break never happened.',
        new: 'ast task as if the break never happened.\n',
      },
    })],
  ];
  for (const [name, t] of cases) {
    const html = bustRow(t, null, null);
    assert.ok(hasCompactBadge(html),
      `${name}: a /compact necessarily rewrites messages[0], so the row must name that as inherent rather than present it as a change to fix`);
    assert.ok(!hasHint(html),
      `${name}: and the generic fix_hint must be suppressed — it is a static per-class string, and there is nothing here to fix`);
    assert.ok(html.includes('bust-fault-env'),
      `${name}: styled calm like the deploy tax, not amber like an actionable prefix change`);
    // ENTER: the classification must be reached through the compact path, not
    // fall out of the deploy-tax branch that already existed.
    assert.strictEqual(t.restart_between, false,
      `${name}: this case must NOT straddle a restart, or it would be badged by the pre-existing deployTax branch and prove nothing about compact detection`);
    // And the diff still renders — knowing it was a compact does not mean
    // hiding what moved.
    assert.ok(hasDiff(html), `${name}: the divergence is still shown`);
  }
});

test('bustRow: a compact that also straddles a restart is badged once, as a compact', () => {
  const html = bustRow(tx({ restart_between: true }), null, null);
  assert.ok(hasCompactBadge(html), 'a compact that happens to straddle a restart is still a compact');
  assert.ok(!html.includes('deploy tax'),
    'and only one badge may claim the row — two heal badges would read as two unrelated explanations for one bust');
});

// ---------------------------------------------------- (d) real preamble busts

test('bustRow: a genuine preamble bust keeps its hint and gets NO inherent badge', () => {
  // Turn 1090 of the live session: the one preamble bust of 39 that is real —
  // a CLAUDE.md edit, labelled `claudeMd bundle` rather than `text`, with the
  // message count GROWING (287 -> 290).
  const html = bustRow(tx({
    prev_messages: 287, cur_messages: 290, restart_between: false, write_tokens: 132225,
    locus: {
      char_offset: 1582,
      label: 'messages[0].user claudeMd bundle',
      old: ') · `build/` (icons + `afterPack.js`) ·\nelectron-builder config under `"build"` ',
      new: ') · `build/` (icons + `afterPack.js`) ·\n`cli/deploy/` (the packaged infra catalo',
    },
  }), null, null);

  assert.ok(!hasCompactBadge(html),
    'an edit to the injected static bundle is actionable — badging it inherent tells the operator to ignore the one preamble bust of 39 that is real');
  assert.ok(hasHint(html), 'and its fix_hint must survive');
  assert.ok(html.includes('bust-fault-content'), 'styled amber — this one is worth fixing');
  assert.ok(html.includes('cli/deploy/'),
    'and the diff must show the inserted text, which is the whole point of the row');
});

test('bustRow: the compact signals are each required, not either', () => {
  // The predicate needs BOTH a generic `text` label and a compact-shaped thread
  // move. Each half alone must fall through to the actionable row, because that
  // is the safe direction: a real bust shown as real.
  const labelOnly = bustRow(tx({
    prev_messages: 287, cur_messages: 290,
    locus: { old: 'aaa', new: 'bbb' },       // label stays `… text`, no collapse, no append
  }), null, null);
  assert.ok(!hasCompactBadge(labelOnly),
    'messages[0] text changing WITHOUT the thread contracting or being appended to is not a compact — do not badge it inherent');

  const shapeOnly = bustRow(tx({
    locus: { label: 'messages[0].user claudeMd bundle' },   // collapse holds, label is named
  }), null, null);
  assert.ok(!hasCompactBadge(shapeOnly),
    'a named static-context block changing is an actionable edit even across a contraction — the block label is what says WHAT moved');

  const notPreamble = bustRow(tx({ class: 'conversation' }), null, null);
  assert.ok(!hasCompactBadge(notPreamble),
    'the predicate is scoped to the preamble class — a deep-history rewrite is a different population and wirescope already classes compacts there itself');
});

// --- renderDiffHtml gutter --------------------------------------------------

// Two hunks with a real gap between them, which is the only shape that can
// catch the off-by-the-gap bug: a single counter run over the whole diff gets
// hunk 1 right and every later hunk wrong, so a one-hunk fixture proves nothing.
const TWO_HUNK = [
  'diff --git a/renderer/plugin-host.js b/renderer/plugin-host.js',
  'index 1111111..2222222 100644',
  '--- a/renderer/plugin-host.js',
  '+++ b/renderer/plugin-host.js',
  '@@ -262,6 +292,7 @@ function initPluginHost({',
  '   };',
  ' ',
  '-  function menuEntriesFor(type) {',
  '+  // sessionName is optional',
  '+  function menuEntriesFor(type, sessionName) {',
  '     const out = [];',
  '   }',
  '@@ -400,3 +431,3 @@ function other() {',
  '-  const a = 1;',
  '+  const a = 2;',
  '   return a;',
].join('\n');

// [class, gutterText, lineText] per rendered row. Parsing the markup rather
// than trusting a count is what lets the assertions below name a specific row.
function rows(html) {
  return [...html.matchAll(/<div class="diff-line ([a-z-]+)">(?:<span class="peek-ln">([^<]*)<\/span>)?([\s\S]*?)<\/div>/g)]
    .map(m => [m[1], m[2] === undefined ? null : m[2].trim(), m[3]]);
}

test('renderDiffHtml: the gutter re-seeds at each @@ header', () => {
  const r = rows(renderDiffHtml(TWO_HUNK, { lineNumbers: true }));
  assert.equal(r.length, 16, 'every input line must produce exactly one row');

  // ENTER: the second hunk's rows must actually be in the parse, or every
  // assertion about them below is true of nothing.
  const secondHunk = r.slice(13);
  assert.deepStrictEqual(secondHunk.map(x => x[2]), ['-  const a = 1;', '+  const a = 2;', '   return a;'],
    'the second hunk body must have survived into the parsed rows');

  // Hunk 1 starts at old 262 / new 292. A context line takes the NEW number.
  assert.deepStrictEqual(r.slice(4, 12).map(x => [x[0], x[1]]), [
    ['diff-hunk', ''],        // the @@ header itself occupies no line
    ['diff-ctx', '292'],
    ['diff-ctx', '293'],
    ['diff-del', '264'],      // deletion numbers in the OLD file, which the two context lines above already advanced 262->264
    ['diff-add', '294'],
    ['diff-add', '295'],
    ['diff-ctx', '296'],
    ['diff-ctx', '297'],
  ], 'hunk 1: adds/context count in the new file, deletions in the old');

  assert.deepStrictEqual(secondHunk.map(x => x[1]), ['400', '431', '432'],
    'hunk 2 must restart from ITS header (400/431), not continue hunk 1 — a single running counter lands here at 266/298');
});

test('renderDiffHtml: file headers get no number and the gutter stays fixed-width', () => {
  const r = rows(renderDiffHtml(TWO_HUNK, { lineNumbers: true }));

  const heads = r.slice(0, 4);
  assert.deepStrictEqual(heads.map(x => x[0]), ['diff-file', 'diff-file', 'diff-file', 'diff-file'],
    'ENTER: the four header lines must be classed diff-file before asserting they are unnumbered');
  assert.ok(heads.every(x => x[1] === ''), '--- and +++ are file headers, not del/add lines, and hold no position');

  // The blank gutter must still be emitted at full width, or the code column
  // steps left on every header row.
  const widths = [...renderDiffHtml(TWO_HUNK, { lineNumbers: true })
    .matchAll(/<span class="peek-ln">([^<]*)<\/span>/g)].map(m => m[1].length);
  assert.ok(widths.length === 16, 'every row carries a gutter span, numbered or not');
  assert.deepStrictEqual([...new Set(widths)], [3], 'all gutters are padded to the widest number (3 chars)');
});

test('renderDiffHtml: default output carries no gutter at all', () => {
  // lib.renderDiffHtml is frozen into the plugin surface under hostApi "1".
  // Changing what a no-opts call returns is a change every conforming plugin
  // sees, so the default must stay byte-identical to the pre-gutter output.
  const html = renderDiffHtml(TWO_HUNK);
  const r = rows(html);
  assert.equal(r.length, 16, 'ENTER: all rows parsed, so the absence below is over a populated set');
  assert.deepStrictEqual([...new Set(r.map(x => x[0]))], ['diff-file', 'diff-hunk', 'diff-ctx', 'diff-del', 'diff-add'],
    'ENTER: every diff class is present in the default render');
  assert.ok(!html.includes('peek-ln'), 'no gutter span without an explicit opt-in');
  assert.deepStrictEqual(r.map(x => x[1]), new Array(16).fill(null), 'and no row carries gutter text');
});

test('renderDiffHtml: a diff with no @@ header numbers nothing rather than guessing', () => {
  const html = renderDiffHtml('diff --git a/x b/x\nindex 1..2 100644', { lineNumbers: true });
  const r = rows(html);
  assert.deepStrictEqual(r.map(x => x[0]), ['diff-file', 'diff-file'],
    'ENTER: both header rows reached the assertion');
  assert.ok(r.every(x => x[1] === ''), 'without a hunk header there is no known position — emit blanks, not 1..n');
});
