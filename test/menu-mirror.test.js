'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { BACKSPACE, isMirrorDraft, createMenuMirror } = require('../renderer/lib/menu-mirror');

const MENU = { anchor: 6, rows: [{ name: '/compact', description: 'x', selected: false, matchSpans: [] }, { name: '/copy', description: 'y', selected: true, matchSpans: [] }] };
const UNSELECTED = { anchor: 6, rows: [{ name: '/usage (cost)', description: 'x', selected: false, matchSpans: [] }, { name: '/copy', description: 'y', selected: false, matchSpans: [] }] };

function run(steps) {
  const m = createMenuMirror();
  return steps.map(([kind, arg, read]) => {
    if (read !== undefined) m.setRead(read);
    if (kind === 'draft') return [m.draft(arg), m.on()];
    const hit = m.key({ key: arg });
    return [hit, m.on()];
  });
}

test('the backspace byte is the one capture-menu.js sends in its backspace step', () => {
  assert.strictEqual(BACKSPACE, '\x7f');
});

test('mirror mode matches a bare one-line slash command and nothing else', () => {
  assert.deepStrictEqual(['/', '/co', '/built-in-browser', '/co ', ' /co', '/co\n', 'co', '', '//x', null].map(isMirrorDraft),
    [true, true, true, false, false, false, false, false, true, false]);
});

const DRAFT_TABLE = [
  ['OFF→ON pastes the whole draft', [['draft', '/']], [[['\x1b[200~/\x1b[201~'], true]]],
  ['OFF→ON on a pasted draft pastes all of it', [['draft', '/clo']], [[['\x1b[200~/clo\x1b[201~'], true]]],
  ['a draft that is not a slash command stays OFF and writes nothing', [['draft', 'hello'], ['draft', '/co x']], [[[], false], [[], false]]],
  ['ON: one appended char is that char', [['draft', '/'], ['draft', '/c'], ['draft', '/co']], [[['\x1b[200~/\x1b[201~'], true], [['c'], true], [['o'], true]]],
  ['ON: one char deleted at the end is one backspace', [['draft', '/co'], ['draft', '/c']], [[['\x1b[200~/co\x1b[201~'], true], [['\x7f'], true]]],
  ['ON: an unchanged draft writes nothing', [['draft', '/co'], ['draft', '/co']], [[['\x1b[200~/co\x1b[201~'], true], [[], true]]],
  ['ON: a paste resyncs with backspace × previous length then the new draft', [['draft', '/c'], ['draft', '/clear']], [[['\x1b[200~/c\x1b[201~'], true], [['\x7f\x7f', '\x1b[200~/clear\x1b[201~'], true]]],
  ['ON: a cut of two chars resyncs', [['draft', '/clear'], ['draft', '/cle']], [[['\x1b[200~/clear\x1b[201~'], true], [['\x7f\x7f\x7f\x7f\x7f\x7f', '\x1b[200~/cle\x1b[201~'], true]]],
  ['ON: a mid-draft edit resyncs', [['draft', '/cop'], ['draft', '/cxp']], [[['\x1b[200~/cop\x1b[201~'], true], [['\x7f\x7f\x7f\x7f', '\x1b[200~/cxp\x1b[201~'], true]]],
  ['ON→OFF on a typed space erases the mirrored length', [['draft', '/model'], ['draft', '/model ']], [[['\x1b[200~/model\x1b[201~'], true], [['\x7f\x7f\x7f\x7f\x7f\x7f'], false]]],
  ['ON→OFF on a newline erases the mirrored length', [['draft', '/co'], ['draft', '/co\n']], [[['\x1b[200~/co\x1b[201~'], true], [['\x7f\x7f\x7f'], false]]],
  ['ON→OFF on an emptied draft erases the mirrored length', [['draft', '/'], ['draft', '']], [[['\x1b[200~/\x1b[201~'], true], [['\x7f'], false]]],
  ['OFF again then a new slash pastes afresh', [['draft', '/a'], ['draft', ''], ['draft', '/b']], [[['\x1b[200~/a\x1b[201~'], true], [['\x7f\x7f'], false], [['\x1b[200~/b\x1b[201~'], true]]],
];

for (const [name, steps, expected] of DRAFT_TABLE) {
  test(`draft: ${name}`, () => {
    assert.deepStrictEqual(run(steps), expected);
  });
}

const KEY_TABLE = [
  ['ArrowDown with rows forwards CSI B', [['draft', '/co'], ['key', 'ArrowDown', MENU]], { writes: ['\x1b[B'] }, true],
  ['ArrowUp with rows forwards CSI A', [['draft', '/co'], ['key', 'ArrowUp', MENU]], { writes: ['\x1b[A'] }, true],
  ['ArrowDown with no rows is left to the textarea', [['draft', '/co'], ['key', 'ArrowDown', null]], null, true],
  ['ArrowUp with an empty read is left to the textarea', [['draft', '/co'], ['key', 'ArrowUp', { anchor: 1, rows: [] }]], null, true],
  ['Tab with rows forwards a tab and takes the selected entry as the draft', [['draft', '/co'], ['key', 'Tab', MENU]], { writes: ['\t'], draft: '/copy' }, true],
  ['Tab with no row selected takes the first entry, alias dropped', [['draft', '/u'], ['key', 'Tab', UNSELECTED]], { writes: ['\t'], draft: '/usage' }, true],
  ['Tab with no rows (Codex sends the draft on it) is swallowed', [['draft', '/co'], ['key', 'Tab', null]], { writes: [] }, true],
  ['Escape forwards ESC and mode stays ON', [['draft', '/co'], ['key', 'Escape', MENU]], { writes: ['\x1b'] }, true],
  ['Enter forwards CR, clears the draft and turns OFF', [['draft', '/co'], ['key', 'Enter', MENU]], { writes: ['\r'], draft: '' }, false],
  ['Enter with no rows still forwards CR and turns OFF', [['draft', '/nope'], ['key', 'Enter', null]], { writes: ['\r'], draft: '' }, false],
  ['a plain letter key is left to the input path', [['draft', '/co'], ['key', 'a', MENU]], null, true],
  ['keys while OFF are never handled', [['draft', 'hello'], ['key', 'Enter', MENU]], null, false],
];

for (const [name, steps, hit, on] of KEY_TABLE) {
  test(`key: ${name}`, () => {
    assert.deepStrictEqual(run(steps).at(-1), [hit, on]);
  });
}

test('a modified key while ON is never handled', () => {
  const m = createMenuMirror();
  m.draft('/co');
  m.setRead(MENU);
  for (const mod of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey', 'isComposing']) {
    assert.strictEqual(m.key({ key: 'Enter', [mod]: true }), null, mod);
  }
});

test('Enter sets the mirrored length to 0: the next slash pastes with no backspace', () => {
  assert.deepStrictEqual(run([['draft', '/co'], ['key', 'Enter', MENU], ['draft', ''], ['draft', '/']]).slice(2), [[[], false], [['\x1b[200~/\x1b[201~'], true]]);
});

test('after Tab the draft equals the completion and the next change erases one extra char for a completion space', () => {
  const m = createMenuMirror();
  m.draft('/co');
  m.setRead(MENU);
  m.key({ key: 'Tab' });
  assert.strictEqual(m.sent(), '/copy');
  assert.deepStrictEqual(m.draft('/copy'), []);
  assert.deepStrictEqual(m.draft('/copyx'), ['\x7f\x7f\x7f\x7f\x7f\x7f', '\x1b[200~/copyx\x1b[201~']);
  assert.deepStrictEqual(m.draft('/copyxy'), ['y']);
});

test('after Tab turning OFF erases the completion plus one', () => {
  const m = createMenuMirror();
  m.draft('/co');
  m.setRead(MENU);
  m.key({ key: 'Tab' });
  assert.deepStrictEqual([m.draft('/copy '), m.on()], [['\x7f\x7f\x7f\x7f\x7f\x7f'], false]);
});

test('resync counts characters, not UTF-16 units', () => {
  const m = createMenuMirror();
  m.draft('/😀');
  assert.deepStrictEqual(m.draft('/😀a'), ['a']);
  assert.deepStrictEqual(m.draft('/x'), ['\x7f\x7f\x7f', '\x1b[200~/x\x1b[201~']);
});

test('submit forwards CR and turns OFF; a read is dropped while OFF', () => {
  const m = createMenuMirror();
  m.draft('/co');
  m.setRead(MENU);
  assert.strictEqual(m.hasRows(), true);
  assert.deepStrictEqual(m.submit(), ['\r']);
  assert.deepStrictEqual([m.on(), m.sent(), m.read(), m.hasRows()], [false, '', null, false]);
  m.setRead(MENU);
  assert.strictEqual(m.read(), null);
});

test('dispose resets to OFF', () => {
  const m = createMenuMirror();
  m.draft('/co');
  m.dispose();
  assert.deepStrictEqual([m.on(), m.sent()], [false, '']);
});
