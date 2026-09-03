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

// The CLI's assistant bullet is U+23FA. The set shipped with U+2B24 BLACK LARGE
// CIRCLE instead -- a lookalike, matched by eye and never against real output,
// so every `⏺ [agent:...]` row the CLI rendered was skipped by the highlighter
// while the intent itself fired from the jsonl. Both are held here: the real
// glyph because that is the fix, U+2B24 because narrowing the set would stop an
// intent that fires today.
test('cleanLine strips the CLI assistant bullet U+23FA, not only its lookalike', () => {
  assert.strictEqual(cleanLine('\u23fa [agent:who]'), '[agent:who]');
  assert.strictEqual(cleanLine('\u2b24 [agent:who]'), '[agent:who]');
  assert.deepStrictEqual(parseIntent('\u23fa [agent:task accept t641]'),
    { type: 'task', sub: 'accept', id: 't641', who: null, body: '' });
});

// U+276F leads the Claude CLI's prompt row, and that row is the LIVE COMPOSER:
// renderer/lib/voice-submit.js's COMPOSER_DRAFT reads `U+276F <sep> <text>` as
// an unsent draft, measured off a real seat. PREFIX_CHARS feeds parseIntent, so
// admitting it would make an intent the operator is still TYPING fire the moment
// the CLI painted it. Absence from this set is the fix, not an oversight.
test('cleanLine does NOT strip the composer prompt U+276F, so a typed intent cannot fire', () => {
  assert.ok(!PREFIX_CHARS.has('\u276f'));
  assert.strictEqual(cleanLine('\u276f [agent:dm bob] hello'), '\u276f [agent:dm bob] hello');
  assert.strictEqual(parseIntent('\u276f [agent:dm bob] hello'), null);
  assert.strictEqual(looksLikeIntent('\u276f [agent:dm bob] hello'), null);
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
    { type: 'spawn', name: 'worker', cwd: '/tmp/x', template: null, worktree: null });
  assert.deepStrictEqual(parseIntent('[agent:spawn cwd:/tmp/x name:worker]'),
    { type: 'spawn', name: 'worker', cwd: '/tmp/x', template: null, worktree: null });
  assert.deepStrictEqual(parseIntent('[agent:spawn name:solo]'),
    { type: 'spawn', name: 'solo', cwd: null, template: null, worktree: null });
});

test('parseIntent: spawn parses optional template: ref, with or without cwd', () => {
  // template + cwd (cwd overrides the template's).
  assert.deepStrictEqual(parseIntent('[agent:spawn name:t2 cwd:/tmp/y template:trader-seat]'),
    { type: 'spawn', name: 't2', cwd: '/tmp/y', template: 'trader-seat', worktree: null });
  // template alone (cwd comes from the template at apply time).
  assert.deepStrictEqual(parseIntent('[agent:spawn name:t2 template:trader-seat]'),
    { type: 'spawn', name: 't2', cwd: null, template: 'trader-seat', worktree: null });
  // order-independent.
  assert.deepStrictEqual(parseIntent('[agent:spawn template:seat name:t2]'),
    { type: 'spawn', name: 't2', cwd: null, template: 'seat', worktree: null });
});

test('parseIntent: spawn parses worktree:<branch>, order-independent and branch-shaped', () => {
  assert.deepStrictEqual(parseIntent('[agent:spawn name:h1 cwd:/tmp/x worktree:t272]'),
    { type: 'spawn', name: 'h1', cwd: '/tmp/x', template: null, worktree: 't272' });
  assert.deepStrictEqual(parseIntent('[agent:spawn worktree:feature/a name:h1 cwd:/tmp/x]'),
    { type: 'spawn', name: 'h1', cwd: '/tmp/x', template: null, worktree: 'feature/a' });
  // Combines with template — a role seat gets both its config and its own tree.
  assert.deepStrictEqual(parseIntent('[agent:spawn name:h1 template:hand worktree:t272]'),
    { type: 'spawn', name: 'h1', cwd: null, template: 'hand', worktree: 't272' });
  // A bare `worktree:` yields no branch. It must not read as "no worktree wanted"
  // downstream — the handler rejects it rather than spawning an unisolated seat.
  assert.deepStrictEqual(parseIntent('[agent:spawn name:h1 cwd:/tmp/x worktree:]'),
    { type: 'spawn', name: 'h1', cwd: '/tmp/x', template: null, worktree: null });
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
    { type: 'task', sub: 'add', who: null, id: null, park: false, body: 'build the widget' });
  assert.deepStrictEqual(parseIntent('[agent:task add hand] build the widget'),
    { type: 'task', sub: 'add', who: 'hand', id: null, park: false, body: 'build the widget' });
});

test('parseIntent: task add park — the modifier never lands in `who` (t174)', () => {
  // The whole point of filtering rather than positional-reading: `add park hand`
  // must file for `hand`, not for a seat named "park" with no assignee recorded.
  assert.deepStrictEqual(parseIntent('[agent:task add park hand] spec'),
    { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'spec' });
  // Either order, because both read naturally and a lead should not have to
  // remember which.
  assert.deepStrictEqual(parseIntent('[agent:task add hand park] spec'),
    { type: 'task', sub: 'add', who: 'hand', id: null, park: true, body: 'spec' });
  // Parked backlog: no assignee at all is still a legal park.
  assert.deepStrictEqual(parseIntent('[agent:task add park] spec'),
    { type: 'task', sub: 'add', who: null, id: null, park: true, body: 'spec' });
  // Only the exact token. `parked` is a plausible typo and must resolve as an
  // assignee (which the handler then rejects) rather than silently parking.
  assert.deepStrictEqual(parseIntent('[agent:task add parked] spec'),
    { type: 'task', sub: 'add', who: 'parked', id: null, park: false, body: 'spec' });
});

test('parseIntent: task park — id only, no body (t174)', () => {
  assert.deepStrictEqual(parseIntent('[agent:task park t7]'),
    { type: 'task', sub: 'park', id: 't7', who: null, body: '' });
  // Body dropped on purpose: park is a toggle, so there is no reason text to
  // deliver and `bodyModeFor` gives it 'none'.
  assert.deepStrictEqual(parseIntent('[agent:task park t7] some reason'),
    { type: 'task', sub: 'park', id: 't7', who: null, body: '' });
  assert.deepStrictEqual(parseIntent('[agent:task park]'),
    { type: 'task', sub: 'park', id: null, who: null, body: '' });
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
  // t339: respec's body is the REPLACEMENT SPEC, so it parses like reject's —
  // greedy and multi-line. A spec is the one body whose silent truncation would
  // be dispatched to a hand as the work itself.
  assert.deepStrictEqual(parseIntent('[agent:task respec t7] the corrected spec'),
    { type: 'task', sub: 'respec', id: 't7', who: null, body: 'the corrected spec' });
  assert.deepStrictEqual(parseIntent('[agent:task respec t7] line one\nline two'),
    { type: 'task', sub: 'respec', id: 't7', who: null, body: 'line one\nline two' });
  assert.deepStrictEqual(parseIntent('[agent:task cancel t7] nvm'),
    { type: 'task', sub: 'cancel', id: 't7', who: null, body: 'nvm' });
  assert.deepStrictEqual(parseIntent('[agent:task cancel t7]'),
    { type: 'task', sub: 'cancel', id: 't7', who: null, body: '' });
  // t305: accept takes an id and an OPTIONAL note, so both shapes must parse —
  // a bare accept is the common one and must not degrade to a null id.
  assert.deepStrictEqual(parseIntent('[agent:task accept t7] merged, thanks'),
    { type: 'task', sub: 'accept', id: 't7', who: null, body: 'merged, thanks' });
  assert.deepStrictEqual(parseIntent('[agent:task accept t7]'),
    { type: 'task', sub: 'accept', id: 't7', who: null, body: '' });
  // t80: bare list carries filter:null (the handler defaults it to open); an
  // explicit bracket arg is carried through for the handler to validate.
  assert.deepStrictEqual(parseIntent('[agent:task list]'),
    { type: 'task', sub: 'list', id: null, who: null, filter: null, body: '' });
  assert.deepStrictEqual(parseIntent('[agent:task list done]'),
    { type: 'task', sub: 'list', id: null, who: null, filter: 'done', body: '' });
  // An unknown filter PARSES — it is the handler that bounces it with the valid
  // set, so the caller learns the vocabulary instead of getting a near-miss.
  assert.deepStrictEqual(parseIntent('[agent:task list bogus]'),
    { type: 'task', sub: 'list', id: null, who: null, filter: 'bogus', body: '' });
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

// ── t313: the head must not short-circuit on `sub` ──────────────────────────
//
// The head was a `||` chain, so for any verb carrying a `sub` every later
// field was unreachable and two BODYLESS siblings of the same sub hashed
// identically: `[agent:task start t210]` and `[agent:task start t309]` both
// became `agent|task|start|`. The intra-turn `fired` Set then swallowed the
// second with a log.warn the emitting seat never sees — measured live on a
// pair of `task accept`s, where one ticket's branch and worktree simply never
// appeared.
//
// Both directions are pinned together on purpose. Splitting siblings apart is
// only half the requirement: the dedupe must still COLLAPSE a genuine
// double-paste, and a key change that made duplicates look distinct would let
// a repeated `task cancel` execute twice — worse than the drop it fixes.
// Every case drives the real parser, so "identical" is decided by the
// mechanism rather than by a hand-built object pair.

test('shadowIntentKey: bodyless siblings with distinct ids do NOT collide', () => {
  const a = parseIntent('[agent:task start t210]');
  const b = parseIntent('[agent:task start t309]');
  assert.strictEqual(a.id, 't210', 'ENTER: the parser really put the id on the intent');
  assert.strictEqual(b.id, 't309', 'ENTER: and on the sibling too — otherwise the keys below differ for no reason');
  assert.notStrictEqual(shadowIntentKey('me', a), shadowIntentKey('me', b));

  const c = parseIntent('[agent:task accept t330]');
  const d = parseIntent('[agent:task accept t331]');
  assert.notStrictEqual(shadowIntentKey('me', c), shadowIntentKey('me', d));
});

test('shadowIntentKey: a genuine duplicate still hashes identically (dedupe stays load-bearing)', () => {
  for (const line of [
    '[agent:task start t210]',
    '[agent:task cancel t7] dropping this',
    '[agent:team role-rm hand]',
    '[agent:dm bob] hi',
    '[agent:spawn name:a cwd:/x]',
  ]) {
    assert.strictEqual(
      shadowIntentKey('me', parseIntent(line)), shadowIntentKey('me', parseIntent(line)),
      `a double-pasted ${line} must collapse — a distinct key here means it executes twice`,
    );
  }
});

test('shadowIntentKey: every discriminator behind `sub` reaches the key', () => {
  const pairs = [
    ['[agent:team role-rm hand]', '[agent:team role-rm designer]'],       // name
    ['[agent:task assign t1 hand]', '[agent:task assign t1 bob]'],        // who
    ['[agent:team role-rename a b]', '[agent:team role-rename a c]'],     // to
    ['[agent:task list open]', '[agent:task list done]'],                 // filter
    ['[agent:spawn name:a cwd:/x]', '[agent:spawn name:a cwd:/y]'],       // cwd
  ];
  for (const [x, y] of pairs) {
    const a = parseIntent(x), b = parseIntent(y);
    assert.ok(a && b, `ENTER: both lines parse (${x} / ${y}) — a null here would compare nothing`);
    assert.notStrictEqual(shadowIntentKey('me', a), shadowIntentKey('me', b), `${x} vs ${y}`);
  }
});

// The key is a pure function of the parse output, so it must never read
// anything a plugin's `parse` invented: an intent carrying a field outside the
// allowlist (a timestamp is the dangerous shape) must key exactly as one
// without it, or two identical emissions stop deduping.
test('shadowIntentKey: fields outside the allowlist do not enter the key', () => {
  const base = { type: 'thing', sub: 'go', id: 'x1', body: 'b' };
  assert.strictEqual(
    shadowIntentKey('me', { ...base, ts: Date.now(), nonce: Math.random() }),
    shadowIntentKey('me', base),
  );
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

// --- markdown emphasis around an intent line (t404) -------------------------
// A reviewer emitted `**[agent:review-done]**`. It did not parse, the seat went
// idle holding a finished verdict, and a watchdog reported it wedged 33 minutes
// later. The verdict BODY parser already tolerated `**VERDICT**`; the line that
// DELIVERS it did not, and that asymmetry is the defect.

test('parseIntent: symmetric emphasis around a whole intent line unwraps', () => {
  assert.deepStrictEqual(parseIntent('**[agent:review-done]**'), { type: 'review-done', body: '' });
  assert.deepStrictEqual(parseIntent('__[agent:review-done]__'), { type: 'review-done', body: '' });
  assert.deepStrictEqual(parseIntent('*[agent:review-done]*'), { type: 'review-done', body: '' });
  assert.deepStrictEqual(parseIntent('_[agent:review-done]_'), { type: 'review-done', body: '' });
});

test('parseIntent: emphasis applies to the WHOLE grammar, not just review-done', () => {
  // The incident happened to be a verdict; the same wrapper could equally have
  // eaten a close or a dm, and a fix scoped to one verb would leave those lost.
  assert.deepStrictEqual(parseIntent('**[agent:who]**'), { type: 'who' });
  assert.deepStrictEqual(parseIntent('**[agent:task done t42]**'),
    parseIntent('[agent:task done t42]'));
  assert.deepStrictEqual(parseIntent('**[agent:dm bob] hello**'),
    { type: 'dm', target: 'bob', urgent: false, body: 'hello' });
});

test('parseIntent: nested and mixed emphasis unwrap layer by layer', () => {
  assert.deepStrictEqual(parseIntent('***[agent:who]***'), { type: 'who' });
  assert.deepStrictEqual(parseIntent('**_[agent:who]_**'), { type: 'who' });
});

test('parseIntent: emphasis does not defeat the escape — the quote still wins', () => {
  // cleanLine unwraps BEFORE parseIntent's escape branch, which sits ahead of
  // the registry. Reverse that order and a bolded example fires for real.
  assert.deepStrictEqual(parseIntent('**\\[agent:who]**'), { type: 'escape', text: '[agent:who]' });
  assert.deepStrictEqual(parseIntent('*\\[agent:dm bob] hi*'),
    { type: 'escape', text: '[agent:dm bob] hi' });
});

test('parseIntent: an UNPAIRED leading marker is a markdown bullet and must not fire', () => {
  // `* [agent:x]` is a list item in prose ABOUT an intent. Stripping `*` as a
  // generic prefix char would make every such line in every doc fire.
  assert.strictEqual(parseIntent('* [agent:who]'), null);
  assert.strictEqual(parseIntent('- [agent:who]'), null);
  assert.strictEqual(parseIntent('**[agent:who]'), null);
  assert.strictEqual(parseIntent('[agent:who]**'), null);
});

test('parseIntent: mismatched marker pairs do not unwrap', () => {
  assert.strictEqual(parseIntent('*[agent:who]_'), null);
  assert.strictEqual(parseIntent('__[agent:who]**'), null);
});

test('parseIntent: bare emphasis markers are not an intent', () => {
  // Guards the length floor: `**` alone must not slice into a negative-index
  // remainder that then matches something.
  assert.strictEqual(parseIntent('**'), null);
  assert.strictEqual(parseIntent('****'), null);
  assert.strictEqual(parseIntent('__'), null);
});

test('cleanLine: emphasis is unwrapped ONLY when it reveals an intent', () => {
  assert.strictEqual(cleanLine('**[agent:who]**'), '[agent:who]');
  // Prose reaches every other caller byte-identical: the near-miss bounce
  // quotes this line, and the terminal mark scan tests it for `[agent:`.
  assert.strictEqual(cleanLine('**bold prose**'), '**bold prose**');
  assert.strictEqual(cleanLine('*emphasis*'), '*emphasis*');
});

test('cleanLine: decorators and emphasis compose in either arrangement', () => {
  assert.strictEqual(cleanLine('• **[agent:who]**'), '[agent:who]');
  assert.strictEqual(cleanLine('\x1b[1m**[agent:name]**\x1b[0m'), '[agent:name]');
});

test('looksLikeIntent: a bolded near-miss bounces, quoting the unwrapped line', () => {
  // Without this the wrapper would ALSO hide the typo, so an agent whose verb
  // was wrong AND bolded gets no bounce and no dispatch — silence twice over.
  assert.strictEqual(looksLikeIntent('**[agent:frobnicate now]**'), '[agent:frobnicate now]');
  assert.strictEqual(looksLikeIntent('**bold prose**'), null);
});

test('fencedLines + emphasis: a bolded intent inside a fence stays inert', () => {
  // fencedLines reads raw lines; the caller skips fenced ones before parsing.
  // Asserted together because the fence is the documented way to QUOTE an
  // intent, and an unwrap that ran first would break that promise.
  const lines = ['```', '**[agent:review-done]**', '```'];
  assert.deepStrictEqual(fencedLines(lines), [true, true, true]);
});

test('parseIntent: a BACKTICKED intent stays quoted — inline code is not emphasis', () => {
  // The inline counterpart of the fence, and the reason EMPHASIS_MARKS holds no
  // backtick: `[agent:who]` is how every doc and dm in this repo mentions an
  // intent without firing it. Adding ` to the list makes all of them fire.
  assert.strictEqual(parseIntent('`[agent:who]`'), null);
  assert.strictEqual(parseIntent('``[agent:review-done]``'), null);
  assert.strictEqual(cleanLine('`[agent:who]`'), '`[agent:who]`');
});

test('parseIntent: a SPACED interior is a list item, not emphasis', () => {
  // `* [agent:who] *` is a bullet whose line happens to end in a star. Markdown
  // does not read it as emphasis either, and tickets-store's wrapper regex
  // draws the same line for the same reason — a wrapper hugs its content.
  assert.strictEqual(parseIntent('* [agent:who] *'), null);
  assert.strictEqual(parseIntent('_ [agent:who] _'), null);
  // Hugging it is the difference, nothing else about the line changes.
  assert.deepStrictEqual(parseIntent('*[agent:who]*'), { type: 'who' });
});

test('parseIntent: the unwrap must REVEAL an intent at the start, not anywhere', () => {
  // The keep-guard is anchored. A substring test would accept any emphasised
  // prose that merely MENTIONS an intent, rewriting the line the near-miss
  // bounce quotes and the terminal marks its rows from.
  assert.strictEqual(cleanLine('*see the [agent:dm] docs*'), '*see the [agent:dm] docs*');
  assert.strictEqual(parseIntent('*see the [agent:dm] docs*'), null);
  assert.strictEqual(looksLikeIntent('*see the [agent:dm] docs*'), null);
});

test('parseIntent: only markdown emphasis unwraps — other paired glyphs do not', () => {
  // Strikethrough, quotes and brackets are not emphasis; each added mark is a
  // new way for prose to fire, so the list stays closed at `*` and `_`.
  assert.strictEqual(parseIntent('~~[agent:who]~~'), null);
  assert.strictEqual(parseIntent('"[agent:who]"'), null);
  assert.strictEqual(parseIntent('([agent:who])'), null);
});

test('parseIntent: trailing whitespace AFTER the wrapper still fires', () => {
  // A trailing space is invisible in a rendered turn and costs nothing to type,
  // so it must not be the difference between a verdict landing and a seat going
  // idle holding one. The unwrap trims before testing the wrapper for exactly
  // this; without it `**[agent:x]** ` ends in a space, matches no closing run,
  // and silently does not fire.
  assert.deepStrictEqual(parseIntent('**[agent:review-done]** '), { type: 'review-done', body: '' });
  assert.deepStrictEqual(parseIntent('  *[agent:who]*\t'), { type: 'who' });
});

test('parseIntent: whitespace INSIDE the wrapper keeps the line inert', () => {
  // The mirror of the case above, and the reason the interior must hug: a
  // closing marker separated from the content is a line that ENDS in a star,
  // not a wrapper. Emphasis and a stray trailing glyph are different things.
  assert.strictEqual(parseIntent('*[agent:who] *'), null);
  assert.strictEqual(parseIntent('* [agent:who]*'), null);
});

test('parseIntent: an emphasised term body keeps its RAW bytes, so ANSI is refused not rewritten', () => {
  // `term` is the one row whose body is EXECUTED, and the only reader of the
  // raw second argument: the shell's ANSI strip would turn `echo a<ESC>[Kb`
  // into `echo ab` — a command the agent never wrote — and then run it. The
  // raw line must therefore be unwrapped the same way the cleaned one is, or
  // it stops matching the row's regex and the body silently falls back to the
  // stripped text. Asserted as EQUALITY with the bare form: the wrapper must
  // not change which bytes reach vetTermCommand.
  const bold = parseIntent('**[agent:term exec] echo a\x1b[Kb**');
  const bare = parseIntent('[agent:term exec] echo a\x1b[Kb');
  assert.ok(bare.body.includes('\x1b'), 'ENTER: the bare form really does carry the escape through');
  assert.deepStrictEqual(bold, bare, 'emphasis must not strip the escape the vetter has to see');
  assert.ok(bold.body.includes('\x1b'), 'the escape survives — refusal is the vetter\'s job, not a silent rewrite');
});
