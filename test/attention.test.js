const test = require('node:test');
const assert = require('node:assert');

const { classifyNotification } = require('../attention');

test('classifyNotification: permission dialogs', () => {
  assert.strictEqual(classifyNotification({ message: 'Claude needs your permission to use Bash' }), 'permission');
  assert.strictEqual(classifyNotification({ message: 'Claude requesting permission for WebFetch' }), 'permission');
  assert.strictEqual(classifyNotification({ message: 'Approval required to run this command' }), 'permission');
  // title carries the signal, message is generic
  assert.strictEqual(classifyNotification({ title: 'Permission to use Edit', message: 'src/main.js' }), 'permission');
});

test('classifyNotification: idle "waiting for input" chatter is ignored class', () => {
  assert.strictEqual(classifyNotification({ message: 'Claude is waiting for your input' }), 'idle');
  assert.strictEqual(classifyNotification({ message: 'Waiting for input' }), 'idle');
});

test('classifyNotification: unknown/malformed classifies as other (badge, no dm gate)', () => {
  assert.strictEqual(classifyNotification({ message: 'Auth token expired, please run /login' }), 'other');
  assert.strictEqual(classifyNotification({}), 'other');
  assert.strictEqual(classifyNotification(null), 'other');
  assert.strictEqual(classifyNotification({ message: 42 }), 'other');
});

const fs = require('node:fs');
const path = require('node:path');
const { classifyBootScreen, bootDialogNote } = require('../attention');

const screen = (rel) => fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf8');

const BOOT_ROWS = [
  ['boot-dialogs/added-folder-trust-2.1.326@120', { kind: 'added-folder-trust', path: '/private/tmp/claude-501/-Users-bogdan-projects-tmux-wb-wrap-ui-t2347-boot-trust/5f328d12-probe/scratchpad/probes/a326-untrusted/messages' }],
  ['split-states/trust@60', { kind: 'folder-trust', path: '/private/tmp/claude-501/-Users-bogdan-projects-tmux-wb-wrap-ui-t1122-spike-composer-anchored-live-strip-over/682adbd3-6bba-4cca-9ad8-d9e8ed7727db/scratchpad/cap/stream-60-5oObVl' }],
  ['split-states/trust@100', { kind: 'folder-trust', path: '/private/tmp/claude-501/-Users-bogdan-projects-tmux-wb-wrap-ui-t1122-spike-composer-anchored-live-strip-over/682adbd3-6bba-4cca-9ad8-d9e8ed7727db/scratchpad/cap/stream-100-GUA391' }],
  ['split-states/trust@200', { kind: 'folder-trust', path: '/private/tmp/claude-501/-Users-bogdan-projects-tmux-wb-wrap-ui-t1122-spike-composer-anchored-live-strip-over/682adbd3-6bba-4cca-9ad8-d9e8ed7727db/scratchpad/cap/stream-200-NBuqMk' }],
  ['split-states/idle@100', null],
  ['split-states/permission@100', null],
];

for (const [rel, expected] of BOOT_ROWS) {
  test(`classifyBootScreen: ${rel} reads as ${expected ? expected.kind : 'no boot dialog'}`, () => {
    assert.deepStrictEqual(classifyBootScreen(screen(`${rel}.screen.txt`)), expected);
  });
}

const INLINE_BOOT_ROWS = [
  ['title scrolled off: the path is read from the line above the body',
    ' /home/bogdan/.clodex/messages\n This session hasn\'t worked here before. Is this a directory you created or one you trust?\n\n ❯ No, exit\n   Yes, add it\n\n Enter to confirm · Esc to cancel\n',
    { kind: 'added-folder-trust', path: '/home/bogdan/.clodex/messages' }],
  ['short window: the path moved to the Adding: footer',
    '────────────────────\n ❯ No, exit\n   Yes, add it\n Enter to confirm · Esc to cancel\n Adding: /home/bogdan/.clodex/sessions/r1/messages\n',
    { kind: 'added-folder-trust', path: '/home/bogdan/.clodex/sessions/r1/messages' }],
  ['a transcript that quotes the dialog words, with the prompt box drawn below it',
    '⏺ The CLI showed "Adding a new directory: /tmp/x" and "This session hasn\'t worked here before" with ❯ No, exit and Yes, add it.\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n  ? for shortcuts\n',
    null],
  ['the dialog answered: the welcome screen and prompt box rendered after it',
    ' Adding a new directory:\n /tmp/x/messages\n This session hasn\'t worked here before.\n ❯ No, exit\n   Yes, add it\n Enter to confirm · Esc to cancel\n▗ ▗   ▖ ▖  Claude Code v2.1.326\n────────────────────────────────────────\n❯ Try "edit <filepath> to..."\n────────────────────────────────────────\n',
    null],
  ['an option label alone, with no dialog body or title',
    '❯ No, exit\n  Yes, add it\n',
    null],
  ['a dialog that scrolled up under later output, with a ready prompt below it',
    ' Adding a new directory:\n /tmp/x/messages\n This session hasn\'t worked here before.\n ❯ No, exit\n   Yes, add it\n Enter to confirm · Esc to cancel\n⏺ Bash(ls)\n  ⎿  README.md\n     package.json\n⏺ Two files.\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n',
    null],
  ['a transcript line quoting the dialog\'s words above a ready prompt',
    '⏺ It asked "Adding a new directory: /tmp/x/messages — This session hasn\'t worked here before" and offered No, exit / Yes, add it.\n────────────────────────────────────────\n❯ \n────────────────────────────────────────\n',
    null],
];

for (const [label, text, expected] of INLINE_BOOT_ROWS) {
  test(`classifyBootScreen: ${label}`, () => {
    assert.deepStrictEqual(classifyBootScreen(text), expected);
  });
}

const ANSWERED = JSON.parse(screen('boot-dialogs/added-folder-trust-2.1.326-answered@120.events.json'));
const TERM_ESCAPE_RE = /\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78MDEc]/g;
const streamUntil = (mark) => {
  const at = ANSWERED.events.findIndex((e) => e.mark === mark);
  assert.ok(at > 0, `ENTER: the capture carries the ${mark} mark`);
  return ANSWERED.events.slice(0, at).filter((e) => e.data).map((e) => e.data).join('').replace(TERM_ESCAPE_RE, '');
};

test('classifyBootScreen on a captured 2.1.326 stream: hits while the dialog is up, misses once "Yes, add it" was chosen', () => {
  assert.deepStrictEqual(classifyBootScreen(streamUntil('enter')), { kind: 'added-folder-trust', path: '/private/tmp/claude-501/probe326/case/messages' });
  const answered = streamUntil('type-x');
  assert.ok(answered.includes('Claude Codev2.1.326'), 'ENTER: the capture reached the REPL after the answer');
  assert.strictEqual(classifyBootScreen(answered), null);
});

test('bootDialogNote names the dialog and quotes its path when it has one', () => {
  assert.strictEqual(bootDialogNote({ kind: 'added-folder-trust', path: '/home/bogdan/.clodex/messages' }),
    'a Claude Code boot dialog is up in its terminal: /home/bogdan/.clodex/messages');
  assert.strictEqual(bootDialogNote({ kind: 'folder-trust', path: null }), 'a Claude Code boot dialog is up in its terminal');
});
