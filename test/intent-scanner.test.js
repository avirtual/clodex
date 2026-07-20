// Run: node --test
// Covers the intent scanner: ANSI/decorator stripping, the full `[agent:…]`
// grammar (dm + urgent, resend, who/name, context/memory/spawn/file), the
// `\[agent:` escape, and shadowIntentKey stability across the wire/jsonl paths.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  cleanLine, parseIntent, fencedLines, looksLikeIntent, shadowIntentKey, ANSI_RE, PREFIX_CHARS,
} = require('../intent-scanner');

test('cleanLine: strips ANSI escapes', () => {
  assert.strictEqual(cleanLine('\x1b[36m[agent:who]\x1b[0m'), '[agent:who]');
  // OSC sequence form
  assert.strictEqual(cleanLine('\x1b]0;title\x07hello'), 'hello');
});

test('cleanLine: strips leading decorator glyphs and whitespace', () => {
  assert.strictEqual(cleanLine('• [agent:who]'), '[agent:who]');
  assert.strictEqual(cleanLine('  \t⬤ [agent:name]'), '[agent:name]');
  // interior decorators are left alone
  assert.strictEqual(cleanLine('[agent:dm bob] • hi'), '[agent:dm bob] • hi');
});

test('PREFIX_CHARS / ANSI_RE are exported and usable', () => {
  assert.ok(PREFIX_CHARS.has(' '));
  assert.ok(PREFIX_CHARS.has('•'));
  assert.ok(ANSI_RE instanceof RegExp);
});

test('parseIntent: dm without and with urgent', () => {
  assert.deepStrictEqual(parseIntent('[agent:dm bob] hello there'),
    { type: 'dm', target: 'bob', urgent: false, body: 'hello there' });
  assert.deepStrictEqual(parseIntent('[agent:dm bob urgent] wake up'),
    { type: 'dm', target: 'bob', urgent: true, body: 'wake up' });
});

test('parseIntent: dm body spans multiple lines (s flag)', () => {
  const r = parseIntent('[agent:dm bob] line one\nline two');
  assert.strictEqual(r.type, 'dm');
  assert.strictEqual(r.body, 'line one\nline two');
});

test('parseIntent: dm to a name@peer target', () => {
  const r = parseIntent('[agent:dm alice@box2] ping');
  assert.strictEqual(r.target, 'alice@box2');
});

test('parseIntent: escaped intent is reported, not dispatched', () => {
  assert.deepStrictEqual(parseIntent('\\[agent:who]'),
    { type: 'escape', text: '[agent:who]' });
  // an indented/quoted intent is NOT parsed as a real one, but cleanLine strips
  // the indentation — column-1 enforcement is the caller's job, not ours
});

test('parseIntent: resend handle is lowercased', () => {
  assert.deepStrictEqual(parseIntent('[agent:resend AB12]'),
    { type: 'resend', id: 'ab12' });
  // resend requires nothing after the bracket
  assert.strictEqual(parseIntent('[agent:resend ab12] extra'), null);
});

test('parseIntent: who / name are bare-only', () => {
  assert.deepStrictEqual(parseIntent('[agent:who]'), { type: 'who' });
  assert.deepStrictEqual(parseIntent('[agent:name]'), { type: 'name' });
  assert.strictEqual(parseIntent('[agent:who] and more'), null);
});

test('parseIntent: end is bare-only (a body terminator, trailing text would be ambiguous)', () => {
  assert.deepStrictEqual(parseIntent('[agent:end]'), { type: 'end' });
  assert.deepStrictEqual(parseIntent('  [agent:end]  '), { type: 'end' });
  assert.strictEqual(parseIntent('[agent:end] trailing prose'), null);
});

test('parseIntent: context sub-command + optional body', () => {
  assert.deepStrictEqual(parseIntent('[agent:context clear]'),
    { type: 'context', sub: 'clear', body: '' });
  const r = parseIntent('[agent:context compact] keep going on task X');
  assert.deepStrictEqual(r, { type: 'context', sub: 'compact', body: 'keep going on task X' });
});

test('parseIntent: memory sub-command carries body', () => {
  assert.deepStrictEqual(parseIntent('[agent:memory list]'),
    { type: 'memory', sub: 'list', body: '' });
  assert.deepStrictEqual(parseIntent('[agent:memory remember] a durable fact'),
    { type: 'memory', sub: 'remember', body: 'a durable fact' });
});

test('parseIntent: spawn parses name + cwd in any order', () => {
  assert.deepStrictEqual(parseIntent('[agent:spawn name:worker cwd:/tmp/x]'),
    { type: 'spawn', name: 'worker', cwd: '/tmp/x', template: null });
  assert.deepStrictEqual(parseIntent('[agent:spawn cwd:/tmp/x name:worker]'),
    { type: 'spawn', name: 'worker', cwd: '/tmp/x', template: null });
  assert.deepStrictEqual(parseIntent('[agent:spawn name:solo]'),
    { type: 'spawn', name: 'solo', cwd: null, template: null });
});

test('parseIntent: spawn parses optional template: ref, with or without cwd', () => {
  // template + cwd (cwd overrides the template's).
  assert.deepStrictEqual(parseIntent('[agent:spawn name:t2 cwd:/tmp/y template:trader-seat]'),
    { type: 'spawn', name: 't2', cwd: '/tmp/y', template: 'trader-seat' });
  // template alone (cwd comes from the template at apply time).
  assert.deepStrictEqual(parseIntent('[agent:spawn name:t2 template:trader-seat]'),
    { type: 'spawn', name: 't2', cwd: null, template: 'trader-seat' });
  // order-independent.
  assert.deepStrictEqual(parseIntent('[agent:spawn template:seat name:t2]'),
    { type: 'spawn', name: 't2', cwd: null, template: 'seat' });
});

test('parseIntent: file view/open with spaces in path', () => {
  assert.deepStrictEqual(parseIntent('[agent:file view src/a b.txt]'),
    { type: 'file', sub: 'view', path: 'src/a b.txt' });
  assert.deepStrictEqual(parseIntent('[agent:file open report.pdf]'),
    { type: 'file', sub: 'open', path: 'report.pdf' });
});

test('parseIntent: exec parses cmd + JSON body (single + multi-line)', () => {
  assert.deepStrictEqual(parseIntent('[agent:exec bridge-reply] {"id":"r1.json"}'),
    { type: 'exec', cmd: 'bridge-reply', body: '{"id":"r1.json"}' });
  // Multi-line JSON body survives (s flag) — _extractIntents also captures to the
  // next col-1 intent; the scanner itself keeps everything after the bracket.
  const r = parseIntent('[agent:exec bridge-reply] {\n  "id": "r1.json"\n}');
  assert.strictEqual(r.type, 'exec');
  assert.strictEqual(r.cmd, 'bridge-reply');
  assert.strictEqual(r.body, '{\n  "id": "r1.json"\n}');
});

test('shadowIntentKey: exec keys on cmd + body', () => {
  const a = parseIntent('[agent:exec bridge-reply] {"id":"r1.json"}');
  assert.strictEqual(shadowIntentKey('t2', a), 't2|exec|bridge-reply|{"id":"r1.json"}');
  // Different payloads → different keys; identical → identical (differ stability).
  const b = parseIntent('[agent:exec bridge-reply] {"id":"r2.json"}');
  assert.notStrictEqual(shadowIntentKey('t2', a), shadowIntentKey('t2', b));
  const a2 = parseIntent('[agent:exec bridge-reply] {"id":"r1.json"}');
  assert.strictEqual(shadowIntentKey('t2', a), shadowIntentKey('t2', a2));
});

test('parseIntent: remind captures a spaced spec + body', () => {
  // The spec spans a space (unlike every other intent) — captured whole up to
  // the closing bracket, trimmed; the reminder text is the body.
  assert.deepStrictEqual(parseIntent('[agent:remind every 30m] check the build'),
    { type: 'remind', spec: 'every 30m', body: 'check the build' });
  assert.deepStrictEqual(parseIntent('[agent:remind on compact] reassess the plan'),
    { type: 'remind', spec: 'on compact', body: 'reassess the plan' });
  assert.deepStrictEqual(parseIntent('[agent:remind at 09:00] standup'),
    { type: 'remind', spec: 'at 09:00', body: 'standup' });
});

test('parseIntent: remind management forms (list / cancel) parse with empty body', () => {
  assert.deepStrictEqual(parseIntent('[agent:remind list]'),
    { type: 'remind', spec: 'list', body: '' });
  assert.deepStrictEqual(parseIntent('[agent:remind cancel ab12]'),
    { type: 'remind', spec: 'cancel ab12', body: '' });
});

test('parseIntent: remind body spans multiple lines and keeps ] after the spec bracket', () => {
  // [^\]]+ stops the spec at the FIRST ], so a ] in the reminder text stays in
  // the body; the s flag keeps multi-line text (the manager also captures to the
  // next col-1 intent).
  const r = parseIntent('[agent:remind in 1h] ship it [done]\nand tell the team');
  assert.strictEqual(r.type, 'remind');
  assert.strictEqual(r.spec, 'in 1h');
  assert.strictEqual(r.body, 'ship it [done]\nand tell the team');
});

test('shadowIntentKey: remind keys on spec + body', () => {
  const a = parseIntent('[agent:remind every 30m] check the build');
  assert.strictEqual(shadowIntentKey('t2', a), 't2|remind|every 30m|check the build');
  // Different spec or body → different key; identical → identical (differ stability).
  const b = parseIntent('[agent:remind every 2h] check the build');
  assert.notStrictEqual(shadowIntentKey('t2', a), shadowIntentKey('t2', b));
  const a2 = parseIntent('[agent:remind every 30m] check the build');
  assert.strictEqual(shadowIntentKey('t2', a), shadowIntentKey('t2', a2));
});

test('parseIntent: notify-user captures a free-text body (no sub/target)', () => {
  assert.deepStrictEqual(parseIntent('[agent:notify-user] blocked on which API to use'),
    { type: 'notify-user', body: 'blocked on which API to use' });
  // Empty body is legal at the scanner (the handler bounces it, not here).
  assert.deepStrictEqual(parseIntent('[agent:notify-user]'),
    { type: 'notify-user', body: '' });
  assert.deepStrictEqual(parseIntent('[agent:notify-user] '),
    { type: 'notify-user', body: '' });
});

test('parseIntent: notify-user body spans multiple lines and keeps brackets', () => {
  // The s flag keeps multi-line text; a ] in the body stays put (no spec to
  // terminate). The manager also captures to the next col-1 intent.
  const r = parseIntent('[agent:notify-user] need a call on [option A]\nvs option B');
  assert.strictEqual(r.type, 'notify-user');
  assert.strictEqual(r.body, 'need a call on [option A]\nvs option B');
});

test('shadowIntentKey: notify-user keys on body (no head discriminator)', () => {
  const a = parseIntent('[agent:notify-user] decide on the schema');
  assert.strictEqual(shadowIntentKey('t3', a), 't3|notify-user||decide on the schema');
  const b = parseIntent('[agent:notify-user] decide on the schema');
  assert.strictEqual(shadowIntentKey('t3', a), shadowIntentKey('t3', b));
  const c = parseIntent('[agent:notify-user] something else');
  assert.notStrictEqual(shadowIntentKey('t3', a), shadowIntentKey('t3', c));
});

test('parseIntent: team-review / review-done capture a free-text body (dm-shaped)', () => {
  assert.deepStrictEqual(parseIntent('[agent:team-review] check the boot-race fix'),
    { type: 'team-review', body: 'check the boot-race fix' });
  assert.deepStrictEqual(parseIntent('[agent:team-review]'),
    { type: 'team-review', body: '' });
  assert.deepStrictEqual(parseIntent('[agent:review-done] VERDICT: ACCEPT'),
    { type: 'review-done', body: 'VERDICT: ACCEPT' });
  assert.deepStrictEqual(parseIntent('[agent:review-done] '),
    { type: 'review-done', body: '' });
});

test('parseIntent: team-review / review-done bodies span multiple lines (s flag)', () => {
  const r = parseIntent('[agent:review-done] VERDICT: REWORK\nMUST-FIX: foo.js:12');
  assert.strictEqual(r.type, 'review-done');
  assert.strictEqual(r.body, 'VERDICT: REWORK\nMUST-FIX: foo.js:12');
});

test('parseIntent: an escaped team-review is reported, not dispatched', () => {
  assert.deepStrictEqual(parseIntent('\\[agent:team-review] scope'),
    { type: 'escape', text: '[agent:team-review] scope' });
});

test('parseIntent: reboot — bodyless or optional free-text reason', () => {
  assert.deepStrictEqual(parseIntent('[agent:reboot]'),
    { type: 'reboot', body: '' });
  assert.deepStrictEqual(parseIntent('[agent:reboot] '),
    { type: 'reboot', body: '' });
  assert.deepStrictEqual(parseIntent('[agent:reboot] testing overnight restart'),
    { type: 'reboot', body: 'testing overnight restart' });
});

test('parseIntent: an escaped reboot is reported, not dispatched', () => {
  assert.deepStrictEqual(parseIntent('\\[agent:reboot] why'),
    { type: 'escape', text: '[agent:reboot] why' });
});

test('parseIntent: task add — bracket-arg optional (backlog vs mint+assign)', () => {
  assert.deepStrictEqual(parseIntent('[agent:task add] build the widget'),
    { type: 'task', sub: 'add', who: null, id: null, body: 'build the widget' });
  assert.deepStrictEqual(parseIntent('[agent:task add hand] build the widget'),
    { type: 'task', sub: 'add', who: 'hand', id: null, body: 'build the widget' });
});

test('parseIntent: task assign / done / reject / cancel / list', () => {
  assert.deepStrictEqual(parseIntent('[agent:task assign t7 hand]'),
    { type: 'task', sub: 'assign', id: 't7', who: 'hand', body: '' });
  // A missing token surfaces as null — the handler bounces with a precise message.
  assert.deepStrictEqual(parseIntent('[agent:task assign t7]'),
    { type: 'task', sub: 'assign', id: 't7', who: null, body: '' });
  assert.deepStrictEqual(parseIntent('[agent:task done t7] shipped it'),
    { type: 'task', sub: 'done', id: 't7', who: null, body: 'shipped it' });
  assert.deepStrictEqual(parseIntent('[agent:task reject t7] needs rework'),
    { type: 'task', sub: 'reject', id: 't7', who: null, body: 'needs rework' });
  assert.deepStrictEqual(parseIntent('[agent:task cancel t7] nvm'),
    { type: 'task', sub: 'cancel', id: 't7', who: null, body: 'nvm' });
  assert.deepStrictEqual(parseIntent('[agent:task cancel t7]'),
    { type: 'task', sub: 'cancel', id: 't7', who: null, body: '' });
  assert.deepStrictEqual(parseIntent('[agent:task list]'),
    { type: 'task', sub: 'list', id: null, who: null, body: '' });
});

test('parseIntent: task bodies span multiple lines (s flag)', () => {
  const r = parseIntent('[agent:task add hand] line one\nline two');
  assert.strictEqual(r.sub, 'add');
  assert.strictEqual(r.body, 'line one\nline two');
});

test('parseIntent: an unknown task sub-verb is NOT an intent (falls to near-miss bounce)', () => {
  assert.strictEqual(parseIntent('[agent:task foo] x'), null);
  assert.strictEqual(parseIntent('[agent:task addx] typo'), null, 'closed alternation — addx is not add');
  assert.strictEqual(parseIntent('[agent:task]'), null);
});

test('parseIntent: an escaped task is reported, not dispatched', () => {
  assert.deepStrictEqual(parseIntent('\\[agent:task add] spec'),
    { type: 'escape', text: '[agent:task add] spec' });
});

// --- [agent:team <verb>] — T29 team metadata mutation ----------------------
test('parseIntent: team role-add — brief BODY + optional prompt/template key:val tokens', () => {
  assert.deepStrictEqual(parseIntent('[agent:team role-add worker] does the widgets'),
    { type: 'team', sub: 'role-add', name: 'worker', prompt: null, template: null, body: 'does the widgets' });
  assert.deepStrictEqual(parseIntent('[agent:team role-add worker prompt:my-p template:tpl] the brief'),
    { type: 'team', sub: 'role-add', name: 'worker', prompt: 'my-p', template: 'tpl', body: 'the brief' });
});

test('parseIntent: team role-set — same shape as role-add', () => {
  assert.deepStrictEqual(parseIntent('[agent:team role-set worker prompt:new-p] new brief'),
    { type: 'team', sub: 'role-set', name: 'worker', prompt: 'new-p', template: null, body: 'new brief' });
});

test('parseIntent: team role-rm / role-rename / watchdog carry no body', () => {
  assert.deepStrictEqual(parseIntent('[agent:team role-rm worker]'),
    { type: 'team', sub: 'role-rm', name: 'worker', body: '' });
  assert.deepStrictEqual(parseIntent('[agent:team role-rename worker builder]'),
    { type: 'team', sub: 'role-rename', name: 'worker', to: 'builder', body: '' });
  assert.deepStrictEqual(parseIntent('[agent:team watchdog 600000]'),
    { type: 'team', sub: 'watchdog', ms: 600000, body: '' });
  // A non-numeric watchdog arg → ms null (the handler bounces).
  assert.deepStrictEqual(parseIntent('[agent:team watchdog soon]'),
    { type: 'team', sub: 'watchdog', ms: null, body: '' });
});

test('parseIntent: team role-add brief spans multiple lines (s flag)', () => {
  const r = parseIntent('[agent:team role-add worker] line one\nline two');
  assert.strictEqual(r.sub, 'role-add');
  assert.strictEqual(r.body, 'line one\nline two');
});

test('parseIntent: an unknown team verb is NOT an intent (near-miss bounce)', () => {
  assert.strictEqual(parseIntent('[agent:team foo] x'), null);
  assert.strictEqual(parseIntent('[agent:team role-addx] typo'), null, 'closed alternation — role-addx is not role-add');
  assert.strictEqual(parseIntent('[agent:team]'), null);
});

test('parseIntent: an escaped team is reported, not dispatched', () => {
  assert.deepStrictEqual(parseIntent('\\[agent:team role-rm worker]'),
    { type: 'escape', text: '[agent:team role-rm worker]' });
});

test('parseIntent: non-intent / blank lines return null', () => {
  assert.strictEqual(parseIntent(''), null);
  assert.strictEqual(parseIntent('just some prose'), null);
  assert.strictEqual(parseIntent('`[agent:who]` mentioned inline'), null);
});

test('shadowIntentKey: stable + urgent is part of identity', () => {
  const plain = parseIntent('[agent:dm bob] hi');
  const urgent = parseIntent('[agent:dm bob urgent] hi');
  assert.strictEqual(shadowIntentKey('alice', plain), 'alice|dm|bob|hi');
  assert.strictEqual(shadowIntentKey('alice', urgent), 'alice|dm|bob+urgent|hi');
  assert.notStrictEqual(shadowIntentKey('alice', plain), shadowIntentKey('alice', urgent));
});

test('shadowIntentKey: identical intents hash identically (wire == jsonl)', () => {
  const a = parseIntent('[agent:context compact] resume');
  const b = parseIntent('[agent:context compact] resume');
  assert.strictEqual(shadowIntentKey('x', a), shadowIntentKey('x', b));
});

test('shadowIntentKey: body is trimmed and capped at 200 chars', () => {
  const long = parseIntent('[agent:dm bob] ' + 'z'.repeat(500));
  const key = shadowIntentKey('a', long);
  assert.strictEqual(key, 'a|dm|bob|' + 'z'.repeat(200));
});

// --- looksLikeIntent (near-miss detector for the silent-drop bounce) ---------
// Returns the CLEANED line on a match so the bounce can quote it without ANSI
// noise; null otherwise. parseIntent stays null for near-misses by design (it
// is the dm-body boundary), so this is a SEPARATE question asked only at the
// top level of _extractIntents.

test('looksLikeIntent: typo\'d verb matches and returns the cleaned line', () => {
  assert.strictEqual(looksLikeIntent('[agent:frobnicate now]'), '[agent:frobnicate now]');
  assert.strictEqual(looksLikeIntent('\x1b[1m• [agent:dmm bob] hi\x1b[0m'), '[agent:dmm bob] hi');
});

test('looksLikeIntent: escape, prose, and mid-line mentions do not match', () => {
  assert.strictEqual(looksLikeIntent('\\[agent:dm bob] literal'), null);
  assert.strictEqual(looksLikeIntent('see the [agent:dm] docs'), null);
  assert.strictEqual(looksLikeIntent('plain prose'), null);
  assert.strictEqual(looksLikeIntent(''), null);
});

test('looksLikeIntent: matches lines parseIntent ALSO matches (caller filters on null parse first)', () => {
  assert.strictEqual(looksLikeIntent('[agent:who]'), '[agent:who]');
});

test('shadowIntentKey: unknown intents key on their text, so distinct near-misses stay distinct', () => {
  const a = shadowIntentKey('x', { type: 'unknown', text: '[agent:aaa]' });
  const b = shadowIntentKey('x', { type: 'unknown', text: '[agent:bbb]' });
  assert.notStrictEqual(a, b);
});

// --- fencedLines: code fences are quotes ---

test('fencedLines: marks opener, interior, and closer; text outside stays unfenced', () => {
  const f = fencedLines(['prose', '```', '[agent:who]', '```', '[agent:who]']);
  assert.deepStrictEqual(f, [false, true, true, true, false]);
});

test('fencedLines: info string on the opener; indented fences count', () => {
  assert.deepStrictEqual(fencedLines(['```js', 'code', '```']), [true, true, true]);
  assert.deepStrictEqual(fencedLines(['  ```', 'code', '  ```']), [true, true, true]);
});

test('fencedLines: closer must match char and length — mismatches are content', () => {
  // ``` inside a ~~~ block is content, not a closer
  assert.deepStrictEqual(fencedLines(['~~~', '```', 'x', '~~~', 'out']),
    [true, true, true, true, false]);
  // a shorter run does not close a longer opener
  assert.deepStrictEqual(fencedLines(['````', '```', 'x', '````', 'out']),
    [true, true, true, true, false]);
  // a longer run does close
  assert.deepStrictEqual(fencedLines(['```', 'x', '`````']), [true, true, true]);
  // trailing text disqualifies a closer (```js mid-block is content)
  assert.deepStrictEqual(fencedLines(['```', '```js', 'x', '```']), [true, true, true, true]);
});

test('fencedLines: unclosed fence runs to end of turn', () => {
  assert.deepStrictEqual(fencedLines(['```', 'a', 'b']), [true, true, true]);
});

test('fencedLines: inline backticks are not fences', () => {
  assert.deepStrictEqual(fencedLines(['see `[agent:who]` inline', 'a ``` b']), [false, false]);
});
