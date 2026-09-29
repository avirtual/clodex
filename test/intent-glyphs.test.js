'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseIntent } = require('../intent-scanner');
const registry = require('../intent-registry');
const { glyphFor, headOf, REPLY_GLYPHS, CORE_GLYPHS, INERT, PLUGIN_GLYPH, replyGlyphFor } = require('../intent-glyphs');

const CARD_ROWS = [
  ['[agent:dm bob] hi', '→', 'message', 'bob', []],
  ['[agent:dm bob urgent] hi', '→', 'message', 'bob', ['urgent']],
  ['[agent:dm alice@box] hi', '→', 'message', 'alice@box', []],
  ['[agent:resend ab12]', '⇉', 'resend', 'ab12', []],
  ['[agent:who]', '◎', 'who', null, []],
  ['[agent:name]', '@', 'name', null, []],
  ['[agent:context compact] keep', '⊟', 'compact', null, []],
  ['[agent:context clear]', '⌫', 'clear', null, []],
  ['[agent:context reload] brief', '↺', 'reload', null, []],
  ['[agent:scratch begin]', '⟦', 'scratch', null, []],
  ['[agent:scratch end] summary', '⟧', 'result', null, []],
  ['[agent:scratch rewind] why', '⇤', 'rewind', null, []],
  ['[agent:scratch mark here]', '✱', 'mark', 'here', []],
  ['[agent:scratch cancel]', '⊗', 'cancel', null, []],
  ['[agent:memory remember] x', '◈', 'remember', null, []],
  ['[agent:memory recall] x', '◈', 'recall', null, []],
  ['[agent:memory list]', '◈', 'list', null, []],
  ['[agent:file view docs/a.md]', '▢', 'show', 'docs/a.md', []],
  ['[agent:file open x.pdf]', '▢', 'show', 'x.pdf', ['open']],
  ['[agent:term ls]', '▤', 'terminal', null, []],
  ['[agent:exec clodex-team] {}', '▸', 'run', 'clodex-team', []],
  ['[agent:remind in 10m] check', '◷', 'remind', 'in 10m', []],
  ['[agent:remind every 30m] check', '◷', 'remind', 'every 30m', []],
  ['[agent:remind list]', '◷', 'list reminders', null, []],
  ['[agent:remind cancel 3]', '◷', 'unremind', '3', []],
  ['[agent:shout] merge blocked', '⚑', 'shout', 'you', []],
  ['[agent:team-review] look', '◐', 'review', null, []],
  ['[agent:review-done] t4 accept', '⊨', 'verdict', null, []],
  ['[agent:reboot]', '↻', 'reboot', null, []],
  ['[agent:task add hand] spec', '⊕', 'file', 'hand', []],
  ['[agent:task add dup park] spec', '⊕', 'file', null, ['park', 'dup']],
  ['[agent:task add hand start] spec', '⊕', 'dispatch', 'hand', ['start']],
  ['[agent:task add reviewer:bob] spec', '⊕', 'file', null, ['reviewer:bob']],
  ['[agent:task assign t4 bob]', '⇥', 'assign', 't4', []],
  ['[agent:task start t4]', '⇄', 'start', 't4', []],
  ['[agent:task park t4]', '‖', 'park', 't4', []],
  ['[agent:task respec t4] x', '✎', 'respec', 't4', []],
  ['[agent:task reject t4] x', '↶', 'reject', 't4', []],
  ['[agent:task cancel t4] x', '⊗', 'cancel', 't4', []],
  ['[agent:task accept t4] x', '⤓', 'accept', 't4', []],
  ['[agent:task done t4] x', '✓', 'done', 't4', []],
  ['[agent:task list open]', '≡', 'tickets', null, []],
  ['[agent:team role-add hand model:opus] brief', '⊞', 'role-add', 'hand', ['model:opus']],
  ['[agent:team sandbox up]', '⊞', 'sandbox', null, ['action:up']],
  ['[agent:team trunk main]', '⊞', 'trunk', 'main', []],
  ['[agent:team set-lead bob]', '⊞', 'set-lead', 'bob', []],
  ['[agent:spawn name:bob cwd:/x]', '✦', 'spawn', 'bob', []],
];

for (const [line, glyph, label, target, chips] of CARD_ROWS) {
  test(`headOf(${line})`, () => {
    const intent = parseIntent(line);
    assert.ok(intent, `${line} parses`);
    assert.deepStrictEqual(headOf(intent), { glyph, label, target, chips });
  });
}

test('team-create reads its name and kvs', () => {
  assert.deepStrictEqual(headOf({ type: 'team-create', name: 'foo', root: '/r', lead: null, mode: null, kit: null, body: 'x' }),
    { glyph: '⊞', label: 'create', target: 'foo', chips: ['root:/r'] });
});

const REPLY_ROWS = [
  ['dm', '→', 'message'], ['resend', '⇉', 'resend'], ['who', '◎', 'who'], ['name', '@', 'name'],
  ['context', '⊟', 'context'], ['scratch', '⟦', 'scratch'], ['memory', '◈', 'memory'], ['file', '▢', 'show'],
  ['term', '▤', 'terminal'], ['exec', '▸', 'run'], ['remind', '◷', 'remind'], ['shout', '⚑', 'shout'],
  ['team-review', '◐', 'review'], ['review-done', '⊨', 'verdict'], ['reboot', '↻', 'reboot'], ['task', '⇄', 'task'],
  ['team-create', '⊞', 'team'], ['team', '⊞', 'team'], ['spawn', '✦', 'spawn'], ['intent', '⊘', 'bounced'], ['peers', '⇢', 'peers'],
];

for (const [verb, glyph, label] of REPLY_ROWS) {
  test(`replyGlyphFor(${verb})`, () => {
    assert.deepStrictEqual({ ...replyGlyphFor(verb) }, { glyph, label });
  });
}

test('an unknown reply verb and an undeclared plugin fall back to ◇ with the verb as the label', () => {
  assert.deepStrictEqual({ ...replyGlyphFor('branch') }, { glyph: '◇', label: 'branch' });
  assert.deepStrictEqual({ ...replyGlyphFor('branch', { glyph: '⎇' }) }, { glyph: '⎇', label: 'branch' });
  assert.deepStrictEqual(headOf({ type: 'branch', arg: '' }), { glyph: '◇', label: 'branch', target: null, chips: [] });
  assert.deepStrictEqual(headOf({ type: 'deploy', target: 'prod' }, { glyph: '⎈' }), { glyph: '⎈', label: 'deploy', target: 'prod', chips: [] });
});

test('every glyph fails both emoji properties', () => {
  const all = new Set([
    ...CARD_ROWS.map((r) => r[1]),
    ...REPLY_ROWS.map((r) => r[1]),
    ...CORE_GLYPHS,
    ...Object.values(REPLY_GLYPHS).map((x) => x.glyph),
    INERT.glyph,
    PLUGIN_GLYPH,
    '⎇',
  ]);
  assert.ok(all.size > 30, 'ENTER: the glyph set is non-empty');
  for (const glyph of all) {
    assert.strictEqual(Array.from(glyph).length, 1, glyph);
    assert.ok(!/\p{Emoji}/u.test(glyph), `${glyph} is Emoji`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(glyph), `${glyph} is Extended_Pictographic`);
  }
});

test('glyphFor on a core verb ignores a plugin row', () => {
  assert.deepStrictEqual({ ...glyphFor({ type: 'who' }, { glyph: '⎇' }) }, { glyph: '◎', label: 'who' });
});

function withWarn(fn) {
  const orig = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try { fn(); } finally { console.warn = orig; }
  return warned;
}

test('registerIntent keeps a valid plugin glyph and drops an invalid one to ◇ with a warning', () => {
  registry._resetPluginRows();
  const mk = (verb, glyph) => ({ verb, glyph, parse: () => ({}) });
  const cases = [
    ['gl-ok', '⎇', '⎇', 0],
    ['gl-none', undefined, '◇', 0],
    ['gl-emoji', '✉', '◇', 1],
    ['gl-two', '⎇⎇', '◇', 1],
    ['gl-core', '→', '◇', 1],
    ['gl-num', 7, '◇', 1],
  ];
  try {
    for (const [verb, glyph, want, warns] of cases) {
      const warned = withWarn(() => registry.registerIntent(mk(verb, glyph), 'glyph-test'));
      assert.strictEqual(registry.pluginRowFor(verb).glyph, want, verb);
      assert.strictEqual(warned.length, warns, verb);
    }
  } finally {
    registry._resetPluginRows();
  }
});

test('git-branches declares ⎇ for branch', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugins', 'git-branches', 'engine.js'), 'utf8');
  assert.match(src, /verb: 'branch',[\s\S]{0,400}glyph: '⎇'/);
});
