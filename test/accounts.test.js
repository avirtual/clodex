'use strict';
// accounts.test.js — t811. The registered-subscription registry
// (`~/.clodex/accounts.json`) and the mint recipe for the isolated
// CLAUDE_CONFIG_DIR each registered account spawns with.
//
// TWO PROPERTIES CARRY THE FEATURE and both are absences, so each is pinned
// against the shape that would silently break it:
//
//  1. The `default` account is IMPLICIT — never written to the file, always
//     first in list(). A default row that reached the file would be a second
//     source of truth for "where does an unconfigured seat's config live", and
//     it would go stale the moment the operator's home moved.
//  2. MINT IS IDEMPOTENT. add() calls it, the Preferences pane will call it
//     again, and a second mint that rewrote `.claude.json` would blow away the
//     onboarding marker and the credentials beside it. "Unchanged" is asserted
//     on inode+mtime, not on content: a rewrite with identical bytes is still a
//     rewrite and still races a running CLI.
//
// Everything runs against a tmp clodexHome AND a tmp claudeHome, injected —
// the module's deps are parameters precisely so a test never touches the
// operator's real ~/.claude.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createAccounts, modelOfArgs, modelSelects } = require('../accounts');
const { mkTmpRoot } = require('./lib/tmp-roots');

// A fake home with the shape the mint recipe reads: ~/.claude/{projects,
// skills,agents,commands}/ + settings.json, and the sibling ~/.claude.json the
// theme is lifted from. `plugins` is DELIBERATELY absent — the dangling-link
// case has its own test and needs a claudeHome that is missing one.
function fixture({ withPlugins = false } = {}) {
  const root = mkTmpRoot('clx-accounts-');
  const clodexHome = path.join(root, 'clodex');
  const home = path.join(root, 'home');
  const claudeHome = path.join(home, '.claude');
  fs.mkdirSync(clodexHome, { recursive: true });
  for (const d of ['projects', 'skills', 'agents', 'commands', ...(withPlugins ? ['plugins'] : [])]) {
    fs.mkdirSync(path.join(claudeHome, d), { recursive: true });
  }
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{"defaultMode":"acceptEdits"}\n');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ theme: 'light', projects: { a: 1 } }));
  const accounts = createAccounts({ fs, path, os: require('node:os'), clodexHome, claudeHome });
  return { root, clodexHome, claudeHome, accounts };
}

test('add/list/remove round trip, and the registry file is 0600', () => {
  const { accounts, clodexHome } = fixture();
  const row = accounts.add({ label: 'sub-2', email: 'b@example.com', plan: 'max', configDir: '/tmp/sub-2-dir' });
  assert.strictEqual(row.label, 'sub-2');
  assert.strictEqual(row.plan, 'max');
  assert.strictEqual(row.configDir, '/tmp/sub-2-dir');
  assert.ok(Number.isFinite(row.addedAt), 'addedAt is stamped');

  const listed = accounts.list();
  assert.deepStrictEqual(listed.map((a) => a.label), ['default', 'sub-2']);

  const file = path.join(clodexHome, 'accounts.json');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'the registry names config dirs — not world-readable');

  assert.strictEqual(accounts.remove('sub-2'), true);
  assert.deepStrictEqual(accounts.list().map((a) => a.label), ['default']);
  // Removing a label that is not there reports so rather than silently
  // succeeding — the IPC layer turns this false into an error string.
  assert.strictEqual(accounts.remove('sub-2'), false);
});

test('remove() drops the registry row and NEVER the minted dir', () => {
  const { accounts, clodexHome } = fixture();
  accounts.add({ label: 'sub-2', plan: 'max' });
  const dir = path.join(clodexHome, 'accounts', 'sub-2');
  assert.ok(fs.existsSync(dir), 'ENTER: the mint happened — otherwise the survival below proves nothing');
  accounts.remove('sub-2');
  assert.ok(fs.existsSync(dir), 'the dir holds credentials the operator did not ask to destroy');
  assert.ok(fs.existsSync(path.join(dir, '.claude.json')), 'and its contents are untouched');
});

test('the label regex rejects a space, an uppercase letter and a leading hyphen', () => {
  const { accounts } = fixture();
  for (const bad of ['Sub 2', 'Sub-2', '-sub', 'sub_2', '']) {
    assert.throws(
      () => accounts.add({ label: bad, plan: 'max', configDir: '/tmp/x' }),
      /invalid account label/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
  // ENTER: a legal label goes through, so the throws above are the regex
  // biting and not add() being broken for every input.
  assert.ok(accounts.add({ label: 'sub-2', plan: 'max', configDir: '/tmp/x' }));
});

test('a duplicate label is rejected, and `default` cannot be added at all', () => {
  const { accounts } = fixture();
  accounts.add({ label: 'sub-2', plan: 'max', configDir: '/tmp/x' });
  assert.throws(() => accounts.add({ label: 'sub-2', plan: 'pro', configDir: '/tmp/y' }), /already exists/);
  assert.throws(() => accounts.add({ label: 'default', plan: 'max', configDir: '/tmp/z' }), /implicit account/);
  assert.deepStrictEqual(accounts.list().map((a) => a.label), ['default', 'sub-2']);
});

test('`default` is always first in list() and is NEVER written to the file', () => {
  const { accounts, clodexHome, claudeHome } = fixture();
  accounts.add({ label: 'aaa-first-alphabetically', plan: 'max', configDir: '/tmp/x' });

  const listed = accounts.list();
  assert.strictEqual(listed[0].label, 'default', 'default leads even a label that sorts before it');
  assert.strictEqual(listed[0].configDir, claudeHome, 'and it points at claudeHome');

  // The FILE, not the list: this is the claim that default is implicit.
  const raw = JSON.parse(fs.readFileSync(path.join(clodexHome, 'accounts.json'), 'utf8'));
  assert.deepStrictEqual(raw.accounts.map((a) => a.label), ['aaa-first-alphabetically']);
  assert.ok(!JSON.stringify(raw).includes('"default"'), 'no default row reached the file');
});

test('a hand-written default row in the file is dropped on read, not honoured', () => {
  // The file is operator-editable, so "never written" is only half the rule —
  // a row that gets in some other way must not become a second default.
  const { accounts, clodexHome, claudeHome } = fixture();
  fs.mkdirSync(clodexHome, { recursive: true });
  fs.writeFileSync(path.join(clodexHome, 'accounts.json'), JSON.stringify({
    accounts: [{ label: 'default', configDir: '/somewhere/else', plan: 'max' }],
  }));
  const listed = accounts.list();
  assert.deepStrictEqual(listed.map((a) => a.label), ['default']);
  assert.strictEqual(listed[0].configDir, claudeHome, 'the implicit row wins; the forged one is gone');
});

test('mint: dir is 0700, .claude.json is the literal recipe, settings.json is byte-equal', () => {
  const { accounts, clodexHome, claudeHome } = fixture();
  const dir = accounts.mint('sub-2');
  assert.strictEqual(dir, path.join(clodexHome, 'accounts', 'sub-2'));
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, 'the dir holds credentials');

  // The literal, asserted whole: `projects: {}` rather than a copy is the whole
  // point of the recipe (the real ~/.claude.json is ~700KB of project state),
  // and `theme` is lifted from the operator's own file.
  const body = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(body, { hasCompletedOnboarding: true, theme: 'light', projects: {} });

  assert.deepStrictEqual(
    fs.readFileSync(path.join(dir, 'settings.json')),
    fs.readFileSync(path.join(claudeHome, 'settings.json')),
    'settings.json is copied byte for byte',
  );
});

test('mint: theme falls back to dark when ~/.claude.json is unreadable', () => {
  const { accounts, claudeHome } = fixture();
  fs.writeFileSync(path.join(path.dirname(claudeHome), '.claude.json'), 'not json at all');
  const body = JSON.parse(fs.readFileSync(path.join(accounts.mint('sub-2'), '.claude.json'), 'utf8'));
  assert.strictEqual(body.theme, 'dark');
});

test('mint: the shared symlinks point at claudeHome — asserted on the readlink LITERALS', () => {
  const { accounts, claudeHome } = fixture({ withPlugins: true });
  const dir = accounts.mint('sub-2');
  // The literal target, not a resolved realpath: a link written relative, or to
  // the account dir's own copy, would still resolve to a real directory and
  // pass a mere existsSync.
  for (const name of ['projects', 'plugins', 'skills', 'agents', 'commands']) {
    const link = path.join(dir, name);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${name} is a symlink, not a copied dir`);
    assert.strictEqual(fs.readlinkSync(link), path.join(claudeHome, name), `${name} points into claudeHome`);
  }
});

test('mint: a name missing from claudeHome is SKIPPED, leaving no dangling link', () => {
  // withPlugins:false — the CLI reads a dangling symlink as a present-but-broken
  // directory, which is worse than an absent one.
  const { accounts } = fixture({ withPlugins: false });
  const dir = accounts.mint('sub-2');
  const link = path.join(dir, 'plugins');
  assert.strictEqual(fs.existsSync(link), false, 'no plugins entry at all');
  assert.throws(() => fs.lstatSync(link), /ENOENT/, 'not even a broken one');
  // ENTER: the other four DID get linked, so the absence above is the skip and
  // not a mint that linked nothing.
  assert.ok(fs.lstatSync(path.join(dir, 'projects')).isSymbolicLink());
});

test('mint is idempotent: a second mint changes no inode and no mtime', async () => {
  const { accounts } = fixture({ withPlugins: true });
  const dir = accounts.mint('sub-2');
  const files = ['.claude.json', 'settings.json', 'projects', 'plugins'];
  const before = files.map((f) => {
    const st = fs.lstatSync(path.join(dir, f));
    return { f, ino: st.ino, mtime: st.mtimeMs };
  });
  // A rewrite inside the same millisecond would show an unchanged mtime, so the
  // clock has to move before the second mint for that half to mean anything.
  await new Promise((r) => setTimeout(r, 12));

  const again = accounts.mint('sub-2');
  assert.strictEqual(again, dir, 'the existing dir is reused, not re-derived');
  const after = files.map((f) => {
    const st = fs.lstatSync(path.join(dir, f));
    return { f, ino: st.ino, mtime: st.mtimeMs };
  });
  assert.deepStrictEqual(after, before, 'a second mint rewrote nothing — .claude.json holds the onboarding marker');
});

test('mint leaves an EDITED .claude.json alone (the login it carries survives)', () => {
  const { accounts } = fixture();
  const dir = accounts.mint('sub-2');
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', oauthAccount: 'live' }));
  accounts.mint('sub-2');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount, 'live');
});

test('resync re-copies settings.json over an edited one; mint alone does not', () => {
  const { accounts, claudeHome } = fixture();
  accounts.add({ label: 'sub-2', plan: 'max' });
  const dest = path.join(accounts.configDirFor('sub-2'), 'settings.json');
  fs.writeFileSync(dest, '{"defaultMode":"plan"}\n');

  accounts.mint('sub-2');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), '{"defaultMode":"plan"}\n', 'mint does not clobber');

  assert.deepStrictEqual(accounts.resync('sub-2'), { ok: true, copied: true });
  assert.deepStrictEqual(fs.readFileSync(dest), fs.readFileSync(path.join(claudeHome, 'settings.json')));
});

test('resync refuses an unknown label and the default account', () => {
  const { accounts } = fixture();
  assert.deepStrictEqual(accounts.resync('nope'), { ok: false, error: 'unknown account "nope"' });
  assert.strictEqual(accounts.resync('default').ok, false, 'default IS the source it would copy from');
});

test('add() with no configDir mints one; with a configDir it mints nothing', () => {
  const { accounts, clodexHome } = fixture();
  const minted = accounts.add({ label: 'sub-2', plan: 'max' });
  assert.strictEqual(minted.configDir, path.join(clodexHome, 'accounts', 'sub-2'));
  assert.ok(fs.existsSync(path.join(minted.configDir, '.claude.json')));

  const byo = accounts.add({ label: 'sub-3', plan: 'max', configDir: '/tmp/byo-dir' });
  assert.strictEqual(byo.configDir, '/tmp/byo-dir');
  assert.strictEqual(fs.existsSync(path.join(clodexHome, 'accounts', 'sub-3')), false, 'a supplied dir is adopted, not minted over');
});

test('add() refuses a relative configDir and an unknown plan', () => {
  const { accounts } = fixture();
  assert.throws(() => accounts.add({ label: 'sub-2', plan: 'max', configDir: 'relative/dir' }), /must be absolute/);
  assert.throws(() => accounts.add({ label: 'sub-2', plan: 'enterprise', configDir: '/tmp/x' }), /invalid plan/);
});

test('labelFor: claudeHome → default, a registered dir → its label, a foreign dir → its basename', () => {
  const { accounts, claudeHome } = fixture();
  accounts.add({ label: 'sub-2', plan: 'max', configDir: '/tmp/registered-2' });

  assert.strictEqual(accounts.labelFor(claudeHome), 'default');
  assert.strictEqual(accounts.labelFor(`${claudeHome}/`), 'default', 'a trailing slash is the same dir');
  assert.strictEqual(accounts.labelFor('/tmp/registered-2'), 'sub-2');
  // The fallback is what keeps an operator who typed CLAUDE_CONFIG_DIR by hand
  // legible on the sidebar instead of mislabelled `default`.
  assert.strictEqual(accounts.labelFor('/Users/someone/sub-9'), 'sub-9');
  assert.strictEqual(accounts.labelFor(''), null);
  assert.strictEqual(accounts.labelFor(null), null);
});

test('configDirFor: default → claudeHome, registered → its dir, unknown → null', () => {
  const { accounts, claudeHome } = fixture();
  accounts.add({ label: 'sub-2', plan: 'max', configDir: '/tmp/registered-2' });
  assert.strictEqual(accounts.configDirFor('default'), claudeHome);
  assert.strictEqual(accounts.configDirFor('sub-2'), '/tmp/registered-2');
  assert.strictEqual(accounts.configDirFor('nope'), null);
});

test('modelOfArgs reads all three spellings and ignores a --model after the first', () => {
  assert.strictEqual(modelOfArgs(['--model', 'claude-fable-5-1']), 'claude-fable-5-1');
  assert.strictEqual(modelOfArgs(['--model=claude-opus-5']), 'claude-opus-5');
  assert.strictEqual(modelOfArgs(['-m', 'fable']), 'fable');
  assert.strictEqual(modelOfArgs(['--dangerously-skip-permissions']), '');
  assert.strictEqual(modelOfArgs([]), '');
  assert.strictEqual(modelOfArgs(null), '');
  // A trailing --model with no value is not a model.
  assert.strictEqual(modelOfArgs(['--model']), '');
});

test('modelSelects: `fable` matches a dated claude-fable-* id in BOTH directions', () => {
  assert.strictEqual(modelSelects('claude-fable-5-1', 'fable'), true);
  assert.strictEqual(modelSelects('fable', 'claude-fable-5-1'), true);
  assert.strictEqual(modelSelects('claude-fable-5-1', 'claude-fable-5-1'), true);
  // The alias must not spill onto the models that stay on the old account —
  // that spill would move every seat, which is the failure the whole ticket
  // exists to avoid.
  assert.strictEqual(modelSelects('claude-opus-5', 'fable'), false);
  assert.strictEqual(modelSelects('fable', 'claude-opus-5'), false);
  assert.strictEqual(modelSelects('', 'fable'), false);
  assert.strictEqual(modelSelects('fable', ''), false);
  // A prefix that merely starts the same is a different model, not a fable.
  assert.strictEqual(modelSelects('claude-fabulous-1', 'fable'), false);
});

// --- t812 riders -------------------------------------------------------------

test('save() is ATOMIC: the registry goes through a .tmp that does not survive', () => {
  const { accounts, clodexHome } = fixture();
  accounts.add({ label: 'sub-2', plan: 'max', configDir: '/tmp/registered-2' });
  const file = path.join(clodexHome, 'accounts.json');
  assert.strictEqual(fs.existsSync(`${file}.tmp`), false, 'the scratch file is renamed away, not left behind');
  // The rename must carry the real content, not an empty or partial file: a
  // truncated registry parses as no accounts at all, which is how every
  // registered subscription would vanish with nothing logged.
  const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepStrictEqual(obj.accounts.map((a) => a.label), ['sub-2']);
  assert.strictEqual(obj.accounts[0].configDir, '/tmp/registered-2');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'the mode survives the rename');
  // And a SECOND write over the existing file still lands atomically.
  accounts.add({ label: 'sub-3', plan: 'pro', configDir: '/tmp/registered-3' });
  assert.strictEqual(fs.existsSync(`${file}.tmp`), false);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(file, 'utf-8')).accounts.map((a) => a.label),
    ['sub-2', 'sub-3'],
  );
});

test('labelResolver(): one registry read answers many dirs, with labelFor\'s answers', () => {
  const { accounts, claudeHome } = fixture();
  accounts.add({ label: 'sub-2', plan: 'max', configDir: '/tmp/registered-2' });
  const resolve = accounts.labelResolver();
  assert.strictEqual(resolve(claudeHome), 'default');
  assert.strictEqual(resolve('/tmp/registered-2'), 'sub-2');
  assert.strictEqual(resolve('/Users/someone/sub-9'), 'sub-9');
  assert.strictEqual(resolve(''), null);

  // The point of the resolver is that the file is read ONCE. Deleting the
  // registry after it is built must not change its answers — a per-call
  // labelFor would start saying `registered-2` (the basename fallback) here.
  fs.rmSync(path.join(accounts.registryFile));
  assert.strictEqual(resolve('/tmp/registered-2'), 'sub-2', 'the map was built up front');
  assert.strictEqual(accounts.labelFor('/tmp/registered-2'), 'registered-2', 'ENTER: labelFor really does re-read');
});
