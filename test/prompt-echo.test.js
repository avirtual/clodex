'use strict';
// The prompt-echo byte rewriter (t641). The CLI paints its submitted-prompt echo
// as truecolor SGR, which xterm renders as INLINE styles that options.theme
// cannot remap — so the slab is recoloured on the wire, before terminal.write.
//
// Every expected value here is a LITERAL. Computing it by re-applying the
// rewriter's own substitution rule would assert only that the code agrees with
// itself, and would make the table structurally unable to express the near-miss
// and gate-clearing rows, which are the whole point of it.

const { test } = require('node:test');
const assert = require('node:assert');

const { rewriteEchoSgr, createEchoRewriter, MATCHED_TRIPLETS } = require('../renderer/lib/prompt-echo.js');
const { THEMES } = require('../renderer/lib/constants.js');

const ESC = '\x1b';
const PAL = { bg: '#0a0b0c', fg: '#111213', prompt: '#141516' };

function run(chunks, palette = PAL) {
  const state = { echo: false, carry: '' };
  return chunks.map((c) => rewriteEchoSgr(c, palette, state).out).join('');
}

// The echo row exactly as captured from a live `claude` PTY (V2/V3): the flat
// truecolor form, the run opened by the 240 bg and closed by SGR 49 — there is
// no SGR 0 anywhere in a real echo.
const REAL_ECHO =
  `${ESC}[48;2;240;240;240m${ESC}[38;2;175;175;175m❯ ${ESC}[38;2;0;0;0mZZ hello${ESC}[39m  \r${ESC}[1B${ESC}[49m${ESC}[K`;

const ROWS = [
  {
    name: 'the real captured echo row: all three triplets substituted',
    input: [REAL_ECHO],
    expect: `${ESC}[48;2;10;11;12m${ESC}[38;2;20;21;22m❯ ${ESC}[38;2;17;18;19mZZ hello${ESC}[39m  \r${ESC}[1B${ESC}[49m${ESC}[K`,
  },
  {
    name: 'colon subparam form, both the bare and the empty-slot spelling',
    input: [`${ESC}[48:2:240:240:240m${ESC}[38:2::0:0:0mx`],
    expect: `${ESC}[48:2:10:11:12m${ESC}[38:2::17:18:19mx`,
  },
  {
    name: 'near-miss 240;240;241 is left alone AND does not open the run',
    input: [`${ESC}[48;2;240;240;241m${ESC}[38;2;0;0;0mx`],
    expect: `${ESC}[48;2;240;240;241m${ESC}[38;2;0;0;0mx`,
  },
  {
    name: 'black fg outside an echo run is left alone',
    input: [`${ESC}[38;2;0;0;0mplain black`],
    expect: `${ESC}[38;2;0;0;0mplain black`,
  },
  {
    name: 'SGR 0 clears the gate',
    input: [`${ESC}[48;2;240;240;240ma${ESC}[0m${ESC}[38;2;0;0;0mb`],
    expect: `${ESC}[48;2;10;11;12ma${ESC}[0m${ESC}[38;2;0;0;0mb`,
  },
  {
    // The real terminator. A gate that cleared only on SGR 0 would latch on
    // forever after the first echo, since a real echo never emits one.
    name: 'SGR 49 clears the gate',
    input: [`${ESC}[48;2;240;240;240ma${ESC}[49m${ESC}[38;2;0;0;0mb`],
    expect: `${ESC}[48;2;10;11;12ma${ESC}[49m${ESC}[38;2;0;0;0mb`,
  },
  {
    // 39 closes the text fg mid-echo; the padding cells still carry the 240 bg,
    // so treating it as a terminator would drop the tail of every echo row.
    name: 'SGR 39 does NOT clear the gate',
    input: [`${ESC}[48;2;240;240;240ma${ESC}[39m${ESC}[38;2;0;0;0mb`],
    expect: `${ESC}[48;2;10;11;12ma${ESC}[39m${ESC}[38;2;17;18;19mb`,
  },
  {
    name: 'another truecolor background clears the gate',
    input: [`${ESC}[48;2;240;240;240ma${ESC}[48;2;215;119;87mb${ESC}[38;2;0;0;0mc`],
    expect: `${ESC}[48;2;10;11;12ma${ESC}[48;2;215;119;87mb${ESC}[38;2;0;0;0mc`,
  },
  {
    name: 'mixed 1;38;2;0;0;0 keeps the leading 1',
    input: [`${ESC}[48;2;240;240;240m${ESC}[1;38;2;0;0;0mx`],
    expect: `${ESC}[48;2;10;11;12m${ESC}[1;38;2;17;18;19mx`,
  },
  {
    name: 'the grey ramp near the echo is untouched — only 175;175;175 matches',
    input: [`${ESC}[48;2;240;240;240m${ESC}[38;2;173;173;173ma${ESC}[38;2;177;177;177mb`],
    expect: `${ESC}[48;2;10;11;12m${ESC}[38;2;173;173;173ma${ESC}[38;2;177;177;177mb`,
  },
  {
    name: 'no palette: the chunk passes through byte-identical',
    palette: null,
    input: [REAL_ECHO],
    expect: REAL_ECHO,
  },
];

for (const row of ROWS) {
  test(`rewriteEchoSgr — ${row.name}`, () => {
    assert.strictEqual(run(row.input, 'palette' in row ? row.palette : PAL), row.expect);
  });
}

// A PTY chunk can split an escape sequence at ANY offset. Splitting the real row
// at every offset and asserting the concatenation equals the whole-row result is
// the only shape that covers the boundary cases (between ESC and '[', mid-triplet,
// mid-final-'m') without enumerating them by hand and missing one.
test('chunk boundary: every split offset of the real echo row yields the same bytes', () => {
  const whole = run([REAL_ECHO]);
  const offsets = [];
  for (let i = 1; i < REAL_ECHO.length; i += 1) {
    const got = run([REAL_ECHO.slice(0, i), REAL_ECHO.slice(i)]);
    if (got !== whole) offsets.push(i);
  }
  assert.deepStrictEqual(offsets, [], `split offsets that changed the output: ${offsets.join(',')}`);
});

test('chunk boundary: ESC alone, then the rest of the sequence', () => {
  assert.strictEqual(run([ESC, `[48;2;240;240;240mx`]), `${ESC}[48;2;10;11;12mx`);
});

test('chunk boundary: three-way split mid-triplet', () => {
  assert.strictEqual(run([`${ESC}[48;2;24`, `0;240;2`, `40mx`]), `${ESC}[48;2;10;11;12mx`);
});

// ENTER: a split that leaves a partial sequence unterminated must not emit the
// partial bytes early — if it did, this would be the whole prefix, not ''.
test('an unterminated trailing sequence is carried, not emitted', () => {
  const state = { echo: false, carry: '' };
  const first = rewriteEchoSgr(`abc${ESC}[48;2;240`, PAL, state);
  assert.strictEqual(first.out, 'abc');
  assert.strictEqual(state.carry, `${ESC}[48;2;240`);
  assert.strictEqual(rewriteEchoSgr(`;240;240mx`, PAL, state).out, `${ESC}[48;2;10;11;12mx`);
});

// A carry is bounded so a stream of ESC bytes that never completes a sequence
// cannot grow it without limit.
test('a partial longer than the carry bound is passed through, not buffered', () => {
  const state = { echo: false, carry: '' };
  const long = `${ESC}[${'1'.repeat(200)}`;
  const res = rewriteEchoSgr(long, PAL, state);
  assert.strictEqual(state.carry, '');
  assert.strictEqual(res.out, long);
});

// The rewriter's output is fed to no further pass, but a theme value equal to a
// matched triplet would still make one echo's output look like the next echo's
// input to a reader — and would make the substitution non-idempotent under any
// future re-entry. Cheap to pin, and it constrains the palettes.
test('no theme echo value equals a triplet the rewriter matches', () => {
  const hex = (h) => {
    let s = h.replace('#', '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  };
  const collisions = [];
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const slot of ['bg', 'fg', 'prompt']) {
      const rgb = hex(theme.echo[slot]);
      if (MATCHED_TRIPLETS.some((m) => m.every((v, i) => v === rgb[i]))) collisions.push(`${name}.${slot}`);
    }
  }
  assert.deepStrictEqual(collisions, []);
});

test('every theme carries a complete echo palette', () => {
  const shape = {};
  for (const [name, theme] of Object.entries(THEMES)) {
    shape[name] = theme.echo && ['bg', 'fg', 'prompt'].every((k) => /^#[0-9a-f]{6}$/i.test(theme.echo[k] || ''));
  }
  assert.deepStrictEqual(shape, { midnight: true, claude: true, paper: true, light: true });
});

// The rewriter reads the palette through a getter on every chunk, so a theme
// switch reaches the NEXT write without re-registering anything.
test('createEchoRewriter reads the palette per chunk, not at construction', () => {
  let pal = { bg: '#010203', fg: '#040506', prompt: '#070809' };
  const rw = createEchoRewriter(() => pal);
  assert.strictEqual(rw(`${ESC}[48;2;240;240;240mx`), `${ESC}[48;2;1;2;3mx`);
  pal = { bg: '#0a0b0c', fg: '#111213', prompt: '#141516' };
  assert.strictEqual(rw(`${ESC}[48;2;240;240;240my`), `${ESC}[48;2;10;11;12my`);
});

// Two sessions must not share the echo-run flag: one session's open run would
// otherwise recolour another's black text.
test('each rewriter keeps its own echo-run state', () => {
  const a = createEchoRewriter(() => PAL);
  const b = createEchoRewriter(() => PAL);
  a(`${ESC}[48;2;240;240;240m`);
  assert.strictEqual(b(`${ESC}[38;2;0;0;0mx`), `${ESC}[38;2;0;0;0mx`);
});
