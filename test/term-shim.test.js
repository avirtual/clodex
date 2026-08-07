'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const {
  buildZshShim, buildBashShim, buildTermShim, bashSupport, unsupportedShellReason,
  isZsh, isBash, BASH_MIN, FORWARDED,
} = require('../term-shim');

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
  // The WHOLE object: `args` is the half a bash-shaped refactor is most likely
  // to drop, and a shim that forgets to say `-l` silently downgrades every zsh
  // terminal to a non-login shell.
  assert.deepStrictEqual(r, {
    env: { ZDOTDIR: '/run/seat/zsh', __CLODEX_REAL_ZDOTDIR: '' },
    args: ['-l'],
  });
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
  assert.strictEqual(r.env.__CLODEX_REAL_ZDOTDIR, '/home/me/zsh');
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

// --- bash ----------------------------------------------------------------
//
// Everything below asserts GENERATED BYTES, which is all a fake fs can see. The
// question a fake cannot answer — does a real bash do what these bytes intend —
// is answered in test/term-marks-bash.test.js against a real shell. Both are
// needed: this file catches a wrong string cheaply, that one catches a string
// that is right about bash we imagined.

// bash 5.3, i.e. supported. Injected so no test here needs a real bash on the
// machine; the version GATE is the thing being pinned, and probing for real
// would make these tests pass or fail on what happens to be installed.
const v53 = () => [5, 3];
const bash = (over = {}) => {
  const fs = over.fs || fakeFs();
  const r = buildBashShim({ dir: '/s', shell: '/bin/bash', fs, probeVersion: over.probeVersion || v53 });
  return { fs, r, body: (fs.files.get('/s/bashrc') || {}).body || '' };
};

test('a bash shell gets an rc FILE and a non-login argv', () => {
  const { r } = bash();
  assert.deepStrictEqual(r, { env: {}, args: ['--rcfile', '/s/bashrc', '-i'] });
});

// The two mechanisms are mutually exclusive: with -l, bash reads
// ~/.bash_profile and never opens the file we just generated. Asserted as its
// own absence because the deepStrictEqual above would still pass if someone
// "helpfully" restored -l alongside --rcfile in a later refactor of the shape.
test('the bash argv must NOT contain -l — a login bash ignores --rcfile', () => {
  const { r } = bash();
  assert.ok(r.args.includes('--rcfile'), 'ENTER: this really is the --rcfile mechanism');
  assert.ok(!r.args.includes('-l'), 'a login bash would never read the generated file');
  assert.ok(!r.args.includes('--login'), 'the long spelling is the same mistake');
});

test('isBash matches only a bash binary', () => {
  assert.ok(isBash('/bin/bash'));
  assert.ok(isBash('/opt/homebrew/bin/bash'));
  assert.ok(!isBash('/bin/zsh'));
  assert.ok(!isBash('/usr/local/bin/bashfoo'));
  assert.ok(!isBash(''));
});

test('the dispatcher routes by shell and refuses what it cannot shim', () => {
  const fs = fakeFs();
  const z = buildTermShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  assert.ok(z && z.env.ZDOTDIR === '/s', 'zsh took the ZDOTDIR path');
  const b = buildTermShim({ dir: '/s', shell: '/bin/bash', fs, probeVersion: v53 });
  assert.deepStrictEqual(b.args, ['--rcfile', '/s/bashrc', '-i'], 'bash took the rcfile path');
  assert.strictEqual(buildTermShim({ dir: '/s', shell: '/usr/bin/fish', fs }), null,
    'an unsupported shell degrades to an ordinary terminal');
  assert.strictEqual(buildTermShim({ dir: '/s', shell: '', fs }), null);
});

// PS0 arrived in bash 4.4 and there is no preexec without it. An older bash
// would emit D marks with no C before them, so term-marks never starts
// capturing and an agent's exec waits for an ending that cannot come — silence
// is the one outcome worse than refusing. macOS ships 3.2 as /bin/bash, so this
// is the common case here, not a defensive corner.
test('a bash older than PS0 gets no shim at all', () => {
  const { r, fs } = bash({ probeVersion: () => [3, 2] });
  assert.strictEqual(r, null);
  assert.strictEqual(fs.files.size, 0, 'nothing was written for a shell that cannot use it');
});

test('the version floor is exactly 4.4, checked on both sides', () => {
  assert.deepStrictEqual(BASH_MIN, [4, 4], 'ENTER: the floor under test');
  assert.strictEqual(bashSupport({ shell: '/bin/bash', probeVersion: () => [4, 3] }).ok, false);
  // The positive control. Without it every assertion above is true of a build
  // that refuses every bash there is.
  assert.strictEqual(bashSupport({ shell: '/bin/bash', probeVersion: () => [4, 4] }).ok, true);
  assert.strictEqual(bashSupport({ shell: '/bin/bash', probeVersion: () => [5, 3] }).ok, true);
  assert.strictEqual(bashSupport({ shell: '/bin/bash', probeVersion: () => [3, 2] }).ok, false);
  // A major bump must not read as older than a 4.x minor.
  assert.strictEqual(bashSupport({ shell: '/bin/bash', probeVersion: () => [5, 0] }).ok, true);
});

// A probe that cannot answer is not evidence of support. It reports the version
// as null so the diagnosis can say so, rather than guessing either way.
test('an unreadable bash version degrades to no shim', () => {
  assert.deepStrictEqual(bashSupport({ shell: '/bin/bash', probeVersion: () => null }),
    { ok: false, version: null });
  assert.strictEqual(bash({ probeVersion: () => null }).r, null);
});

// Dropping -l took the login startup away; the generated rc puts it back. Order
// matters: a real login bash reads /etc/profile before anything in $HOME, and
// on Linux that is where the distro PATH comes from.
test('the rc reconstructs login startup, /etc/profile FIRST', () => {
  const { body } = bash();
  const etc = body.indexOf('/etc/profile');
  const home = body.indexOf('$HOME/.bash_profile');
  assert.ok(etc > -1 && home > -1, 'ENTER: both halves of the reconstruction are present');
  assert.ok(etc < home, 'the system profile is read before the user one, as a login shell does');
  // The GUARD, not just the mention. An ordering assertion reads the same
  // whether the source runs or sits behind a condition that never fires, and
  // the string stays put either way — mutation-checked.
  assert.match(body, /if \[\[ -r \/etc\/profile \]\]; then\n\s*source \/etc\/profile\n/,
    'sourced when readable, rather than merely named');
});

// bash stops at the FIRST of these that exists. Sourcing all three would run
// startup the operator's own login shell never runs.
test('the profile loop takes the first that exists and stops', () => {
  const { body } = bash();
  const loop = body.match(/for __clodex_profile in ([^\n]*)/);
  assert.ok(loop, 'ENTER: the profile loop was found');
  assert.match(loop[1], /\.bash_profile.*\.bash_login.*\.profile/, 'in bash\'s documented order');
  assert.match(body, /\n\s*break\n/, 'first-one-that-exists only');
});

// --rcfile REPLACES ~/.bashrc, and a login bash would not have read it either.
// The tab spawned -l before this feature, so profile-only IS the behaviour
// being matched; adding .bashrc would be a behaviour change dressed as a
// convenience. It arrives transitively when their profile sources it.
test('the rc never sources ~/.bashrc directly', () => {
  const { body } = bash();
  assert.ok(!/\$HOME\/\.bashrc/.test(body), 'sourcing it would change what the tab does today');
});

// The whole reason bash looked unshimmable. PS0 is a real preexec — expanded
// once per accepted line — so no trap is needed, and the operator's own DEBUG
// trap survives because we never touch it.
test('no DEBUG trap is installed anywhere in the generated rc', () => {
  const { body } = bash();
  assert.ok(/PS0=/.test(body), 'ENTER: the PS0 preexec is what replaced it');
  assert.ok(!/\bDEBUG\b/.test(body), 'the DEBUG trap fires per simple command and is not used');
  assert.ok(!/\btrap\b/.test(body), 'no trap of any kind — an operator trap must survive untouched');
});

// Measured against a real PTY: `\[ \]` is a READLINE hint, stripped only from
// PS1 because readline has to measure that prompt. bash expands it in PS0 and
// prints literal SOH/STX, which landed at the head of every captured command's
// output. A fake fs cannot see that, so the bytes are pinned here.
test('neither PS0 branch wraps its escape in \\[ \\]', () => {
  const { body } = bash();
  const ps0 = body.split('\n').filter((l) => /^\s*PS0=/.test(l));
  assert.strictEqual(ps0.length, 2, 'ENTER: both the dynamic and static PS0 branches are present');
  for (const line of ps0) {
    assert.ok(!line.includes('\\['), `PS0 must not carry a readline hint: ${line.trim()}`);
  }
});

test('the PS0 branch falls back to a static mark when promptvars is off', () => {
  const { body } = bash();
  // With promptvars off bash does not expand a prompt at all, so a PS0 holding
  // a command substitution is PRINTED — the mangled prompt this feature must
  // never cause. The static form needs no expansion and still frames the
  // command; it just cannot say what the command was.
  assert.match(body, /if shopt -q promptvars; then/, 'ENTER: the branch exists');
  assert.match(body, /PS0='\$\(__clodex_preexec\)'/, 'dynamic form when prompts expand');
  assert.match(body, /PS0='\\e\]133;C;\\a'/, 'static form when they do not');
});

// bash 5.1+ allows an ARRAY here. Assigning a STRING onto an existing array
// replaces element 0 and leaves the rest, so the string form composes with
// both — while the array form silently drops the operator's command on 4.4–5.0,
// where PROMPT_COMMAND is scalar and only [0] is honoured.
test('PROMPT_COMMAND is installed in the STRING form, prepended', () => {
  const { body } = bash();
  assert.match(body, /PROMPT_COMMAND="__clodex_precmd\$\{PROMPT_COMMAND:\+; \$PROMPT_COMMAND\}"/,
    'prepended, and composing with whatever they already had');
  assert.ok(!/PROMPT_COMMAND=\(/.test(body), 'the array form loses their command on bash 4.4-5.0');
});

// Same property the zsh precmd test pins, same reason: anything running before
// this line destroys the status being reported.
test('the bash exit status is captured on the first line of precmd', () => {
  const { body } = bash();
  const m = body.match(/__clodex_precmd\(\)\s*\{\s*\n\s*([^\n]+)/);
  assert.ok(m, 'ENTER: the precmd body was found');
  assert.match(m[1], /local s=\$\?/, 'anything before this destroys the status being reported');
});

// There is no $BASH_COMMAND at PS0 time, so the line comes from `history`, and a
// line that was never added makes a naive read report the PREVIOUS one —
// measured, `echo first` was reported twice.
test('the reported command is guarded on the history number changing', () => {
  const { body } = bash();
  assert.match(body, /__clodex_hist=\$\{h%%\[\[:space:\]\]\*\}/, 'precmd remembers the number');
  assert.match(body, /\$n != "\$__clodex_hist"/,
    'preexec reports the text when the entry is genuinely new');
});

// The number alone is NOT the rule, and treating it as one is what shipped in
// v5.1.x: ubuntu's stock ~/.bashrc sets HISTCONTROL=ignoreboth, so every REPEATED
// command arrived unnamed. Measured in ghcr.io/avirtual/clodex:5.1.1 — a second
// `pwd` reported an empty payload, and clearing HISTCONTROL in that same shell
// reported it correctly.
//
// Under ignoredups/erasedups the entry was suppressed BECAUSE it equals the last
// one, so the last one IS the command and naming it is right. Under ignorespace
// the last entry is some earlier, unrelated command. The two are
// indistinguishable here, so the combined `ignoreboth` must stay silent.
test('an unchanged history number still names the command, except where the last entry may not be it', () => {
  const { body } = bash();
  const m = body.match(/^\s*if \[\[ -n \$n[^\n]*$/m);
  assert.ok(m, 'ENTER: the preexec guard line was found');
  const guard = m[0];
  assert.match(guard, /\$hc != \*:ignorespace:\*/,
    'a space-hidden command must not borrow the previous entry as its name');
  assert.match(guard, /\$hc != \*:ignoreboth:\*/,
    'ignoreboth is ignorespace too, so it cannot be told from a dup');
  assert.ok(!/\$hc != \*:ignoredups:\*/.test(guard),
    'ignoredups is the case this fix EXISTS to name — excluding it would restore the defect');
});

// Not conservatism: ignorespace and `set +o history` are how an operator hides a
// command carrying a secret, so a stale label on THAT output is the one wrong
// answer worth paying an unnamed command to avoid. Measured against a real bash
// in the 5.1.1 image: with this clause deleted, an unrelated `date` sitting in
// ~/.bash_history was reported as the command for two different `echo`s.
test('a shell with history switched off names nothing at all', () => {
  const { body } = bash();
  assert.match(body, /\[\[ -n \$n && -o history \]\]/,
    'without this the last entry in the history FILE is reported as every command');
});

// The token match is anchored on both sides. HISTCONTROL is colon-separated and
// a bare substring test would read `ignoredups` as containing... nothing, but
// would read a hypothetical `noignorespace` as ignorespace and go silent on a
// shell that had no such setting.
test('the HISTCONTROL tokens are matched colon-delimited, not as substrings', () => {
  const { body } = bash();
  assert.match(body, /hc=":\$\{HISTCONTROL\}:"/,
    'the wrapping colons are what make the first and last tokens matchable');
});

test('the bash hooks only run in an interactive shell, and only once', () => {
  const { body } = bash();
  assert.match(body, /\$- == \*i\*/, 'non-interactive bash gets nothing');
  assert.match(body, /-z \$\{__clodex_installed:-\}/,
    're-sourcing the rc must not stack duplicate marks per prompt');
});

// The command rides base64 so its contents cannot end the mark's own framing,
// and it is passed as ONE quoted argument so nothing splits or globs it.
test('the command line is base64d and never re-expanded', () => {
  const { body } = bash();
  assert.match(body, /builtin printf '%s' "\$line" \| base64/, 'one quoted argument, then base64');
  assert.match(body, /tr -d '\\n'/, 'a wrapped base64 would break the mark');
});

test('a bash write failure degrades to no shim rather than throwing', () => {
  const fs = fakeFs();
  fs.writeFileSync = () => { throw new Error('EACCES'); };
  assert.strictEqual(buildBashShim({ dir: '/s', shell: '/bin/bash', fs, probeVersion: v53 }), null);
});

test('the bash rc is written 0600 into a 0700 dir', () => {
  const { fs } = bash();
  assert.strictEqual(fs.dirs[0].o.mode, 0o700, 'the dir is private');
  assert.strictEqual(fs.files.get('/s/bashrc').o.mode, 0o600, 'the rc is private');
});

// --- the operator-facing diagnosis ---------------------------------------
//
// This is what an agent's refusal message quotes when a command cannot be
// reported on, and it is one of the few places the product speaks to the
// operator about their own machine. It lives beside the builder because the
// supported set and the version floor are the SAME facts the builder enforces:
// a second copy is how a shell we do support starts being told it does not.

test('a supported shell has no complaint to make', () => {
  assert.strictEqual(unsupportedShellReason({ shell: '/bin/zsh' }), null);
  assert.strictEqual(
    unsupportedShellReason({ shell: '/bin/bash', probeVersion: v53 }), null,
    'a new enough bash is supported, so the refusal must look elsewhere for a cause',
  );
});

// The message an operator on stock macOS gets. It must name a version and a
// fix, because "unsupported shell" would send them to install zsh when a newer
// bash — possibly already installed — is what they need.
test('a too-old bash is told its version and the floor', () => {
  const msg = unsupportedShellReason({ shell: '/bin/bash', probeVersion: () => [3, 2] });
  assert.ok(msg, 'ENTER: an old bash really is refused');
  assert.match(msg, /bash 3\.2/, 'the version they HAVE');
  assert.match(msg, /4\.4/, 'the version they need');
  assert.ok(!/only zsh/.test(msg), 'bash is supported now — this message must not say otherwise');
});

test('a bash whose version cannot be read says so rather than guessing', () => {
  const msg = unsupportedShellReason({ shell: '/bin/bash', probeVersion: () => null });
  assert.match(msg, /could not be read/);
});

test('an unshimmable shell is named, and told which shells do work', () => {
  const msg = unsupportedShellReason({ shell: '/usr/bin/fish' });
  assert.match(msg, /fish/, 'the shell they are actually running');
  assert.match(msg, /zsh and bash/, 'both supported shells, not just zsh');
});

// The reason above only reaches an operator if engine.js asks for it, and that
// call site is not reachable from a test: engine requires node-pty directly
// rather than through a seam, so there is no way to stand up a shell whose
// refusal would quote the message. Pinned at the SOURCE instead — a weaker
// statement than a behavioural test, and here because the alternative measured
// nothing at all (a mutant that made engine stop consulting it survived a green
// suite).
test('engine asks term-shim for the shell reason rather than deciding itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  assert.match(src, /function termShimDiagnosis\(\)/, 'ENTER: the diagnosis still lives in engine');
  assert.match(src, /unsupportedShellReason\(\{ shell: process\.env\.SHELL \}\)/,
    'the supported set and the bash floor are term-shim\'s facts, not a second copy');
  // The positive control for the pin: the facts must NOT have been copied back.
  assert.ok(!/only zsh/.test(src), 'a stale claim about zsh would mean the copy came back');
});

// The standing rule this whole file is shaped by. A generated file lives under
// Clodex's own dir; nothing under the operator's home is ever written.
test('nothing outside the shim dir is written, for either shell', () => {
  const fs = fakeFs();
  buildTermShim({ dir: '/s', shell: '/bin/zsh', env: {}, fs });
  buildTermShim({ dir: '/s', shell: '/bin/bash', fs, probeVersion: v53 });
  assert.ok(fs.files.size > 0, 'ENTER: files really were generated');
  for (const [p] of fs.files) {
    assert.ok(p.startsWith('/s/'), `wrote outside the shim dir: ${p}`);
  }
});
