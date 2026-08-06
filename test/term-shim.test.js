'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildZshShim, isZsh, FORWARDED } = require('../term-shim');

function fakeFs() {
  const files = new Map();
  const dirs = [];
  return {
    files,
    dirs,
    mkdirSync: (d, o) => { dirs.push({ d, o }); },
    writeFileSync: (f, body, o) => { files.set(f, { body, o }); },
  };
}

test('a zsh shell gets a shim dir and the ZDOTDIR redirect', () => {
  const fs = fakeFs();
  const r = buildZshShim({ dir: '/run/seat/zsh', shell: '/bin/zsh', env: {}, fs });
  assert.deepStrictEqual(r, { ZDOTDIR: '/run/seat/zsh', __CLODEX_REAL_ZDOTDIR: '' });
});

// A non-zsh shell must degrade to an ORDINARY terminal, not a broken one.
test('a non-zsh shell gets no shim and no env changes', () => {
  const fs = fakeFs();
  assert.strictEqual(buildZshShim({ dir: '/x', shell: '/bin/bash', env: {}, fs }), null);
  assert.strictEqual(fs.files.size, 0, 'nothing was written for a shell we do not shim');
});

test('isZsh matches only a zsh binary', () => {
  assert.ok(isZsh('/bin/zsh'));
  assert.ok(isZsh('/opt/homebrew/bin/zsh'));
  assert.ok(!isZsh('/bin/bash'));
  assert.ok(!isZsh('/usr/local/bin/zshfoo'));
  assert.ok(!isZsh(''));
});

// The startup files zsh reads from ZDOTDIR are not just .zshrc; a shim dir
// holding only .zshrc makes a LOGIN shell skip the operator's .zprofile, which
// silently drops any PATH set there.
test('every zsh startup file is forwarded, not just .zshrc', () => {
  const fs = fakeFs();
  buildZshShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  for (const f of FORWARDED) {
    const rec = fs.files.get(path.join('/s', f));
    assert.ok(rec, `ENTER: ${f} was generated`);
    assert.match(rec.body, new RegExp(`source "\\$HOME/${f.replace('.', '\\.')}"`),
      `${f} sources the operator's own`);
  }
  assert.ok(fs.files.get('/s/.zshrc'), 'ENTER: .zshrc was generated');
});

test("the operator's own rc is sourced BEFORE the hooks are added", () => {
  const fs = fakeFs();
  buildZshShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  const body = fs.files.get('/s/.zshrc').body;
  const src = body.indexOf('source "$HOME/.zshrc"');
  const hook = body.indexOf('__clodex_precmd');
  assert.ok(src > -1 && hook > -1, 'ENTER: both the source and the hooks are present');
  assert.ok(src < hook, 'sourcing first is what lets both their hooks and ours survive');
});

// A plugin manager that re-derives paths from ZDOTDIR would look for the
// operator's plugins inside the generated directory.
test('the real ZDOTDIR is restored before the operator rc is sourced', () => {
  const fs = fakeFs();
  const r = buildZshShim({ dir: '/s', shell: '/bin/zsh', env: { ZDOTDIR: '/home/me/zsh' }, fs });
  assert.strictEqual(r.__CLODEX_REAL_ZDOTDIR, '/home/me/zsh');
  const body = fs.files.get('/s/.zshrc').body;
  const restore = body.indexOf('export ZDOTDIR="$__CLODEX_REAL_ZDOTDIR"');
  const src = body.indexOf('source "/home/me/zsh/.zshrc"');
  assert.ok(restore > -1 && src > -1, 'ENTER: both the restore and the source are present');
  assert.ok(restore < src, 'restored first');
});

test('a custom ZDOTDIR is where the forwarded files point', () => {
  const fs = fakeFs();
  buildZshShim({ dir: '/s', shell: '/bin/zsh', env: { ZDOTDIR: '/custom' }, fs });
  assert.match(fs.files.get('/s/.zprofile').body, /source "\/custom\/\.zprofile"/);
});

// Measured against a real PTY: `${(q)1}` ESCAPES the line, so `echo hello`
// is reported as `echo\ hello` and every command is subtly wrong.
test('the preexec hook does not quote-escape the command line', () => {
  const fs = fakeFs();
  buildZshShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  const body = fs.files.get('/s/.zshrc').body;
  assert.ok(!body.includes('${(q)1}'), 'zsh q-quoting would corrupt every reported command');
  assert.match(body, /printf '%s' "\$1"/, 'the raw line is passed as one argument');
});

// precmd hooks run in array order. A rc that sets its own (OSC 7 cwd reporting
// is near-universal) would otherwise write its bytes INTO the output attributed
// to the command that just finished — measured against a real PTY.
test('the precmd hook is PREPENDED so nothing can write into the capture first', () => {
  const fs = fakeFs();
  buildZshShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  const body = fs.files.get('/s/.zshrc').body;
  assert.match(body, /precmd_functions=\(__clodex_precmd \$precmd_functions\)/,
    'prepended, not appended');
  assert.ok(!/add-zsh-hook precmd/.test(body), 'add-zsh-hook APPENDS and would lose the race');
});

test('re-sourcing the rc does not stack duplicate precmd hooks', () => {
  const fs = fakeFs();
  buildZshShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  assert.match(fs.files.get('/s/.zshrc').body, /precmd_functions\[\(r\)__clodex_precmd\]/,
    'guarded on already being registered');
});

test('the exit status is captured on the first line of precmd', () => {
  const fs = fakeFs();
  buildZshShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  const body = fs.files.get('/s/.zshrc').body;
  const m = body.match(/__clodex_precmd\(\)\s*\{\s*\n\s*([^\n]+)/);
  assert.ok(m, 'ENTER: the precmd body was found');
  assert.match(m[1], /local s=\$\?/, 'anything before this destroys the status being reported');
});

test('the hooks only run in an interactive shell', () => {
  const fs = fakeFs();
  buildZshShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  assert.match(fs.files.get('/s/.zshrc').body, /\[\[ -o interactive \]\]/);
});

// The shim is a convenience; an unwritable dir must cost the operator a
// reporting feature, never their terminal.
test('a write failure degrades to no shim rather than throwing', () => {
  const fs = fakeFs();
  fs.writeFileSync = () => { throw new Error('EACCES'); };
  assert.strictEqual(buildZshShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs }), null);
});

test('the shim dir is created 0700 and its files 0600', () => {
  const fs = fakeFs();
  buildZshShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  assert.strictEqual(fs.dirs[0].o.mode, 0o700, 'the dir is private');
  for (const [, rec] of fs.files) assert.strictEqual(rec.o.mode, 0o600, 'files are private');
});
