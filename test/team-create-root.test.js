// Run: node --test
// t780: [agent:team create] classifies its root before it writes anything —
// NEW (created + git init'd + one empty commit), TAKEOVER (a repo with commits,
// nothing under it touched), or REFUSED (files without a repo, a commitless
// repo, a file, a missing parent).
//
// REAL trees under mkTmpRoot and REAL git throughout, driven through
// _handleIntent so the dispatcher's await is exercised too. The point of a real
// tree here is that the NEW rows end on `createWorktree(root, 'b1')` SUCCEEDING:
// a worktree hand's first ticket is what the empty commit exists for, and a
// stubbed git could not see it fail.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const wt = require('../git-worktree');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { mkTeamCreate } = require('./lib/session-fixtures');

function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const create = (f, root, body = '') =>
  f.m._handleIntent('a', { type: 'team-create', name: 'shop', root, lead: null, body });

// Sorted and RECURSIVE, and it deliberately includes `.git`: the takeover claim
// is that create writes nothing under the root, and a listing that skipped the
// repo internals could not see an added commit or a rewritten ref.
function fileList(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const here = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) { out.push(`${here}/`); walk(full, here); } else out.push(here);
    }
  };
  walk(root, '');
  return out.sort();
}

function makeRepo(prefix) {
  const dir = mkTmpRoot(prefix);
  const run = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return dir;
}

// The NEW rows both end here. `createWorktree(root, 'b1')` is THE pin, not the
// init: `git worktree add -b b1 <p> HEAD` fails `fatal: invalid reference: HEAD`
// on a commitless repo, which is exactly how a per-ticket hand's first ticket
// dies on a root that was only `git init`'d.
async function assertUsableAsTeamRoot(root) {
  assert.strictEqual(fs.statSync(root).isDirectory(), true, 'the root is a directory');
  assert.strictEqual(await wt.hasCommit(root), true, 'it carries a commit');
  assert.strictEqual(fs.realpathSync(await wt.repoToplevel(root)), fs.realpathSync(root),
    'ENTER: the root is its OWN repo toplevel, not a subdirectory of some enclosing one');
  const w = await wt.createWorktree(root, 'b1');
  assert.strictEqual(w.ok, true, `a hand's first worktree lands: ${w.error || ''}`);
  await wt.removeWorktree(w.path);
}

test('t780 create: an ABSENT leaf under an existing parent is made, init\'d, and takes a worktree',
  { skip: !gitAvailable() }, async () => {
    const f = mkTeamCreate();
    const root = path.join(f.projectRoot, 'shop');
    assert.strictEqual(fs.existsSync(root), false, 'ENTER: nothing is there yet');

    await create(f, root);

    assert.ok(f.teamExists('shop'), f.injected.join(' | '));
    await assertUsableAsTeamRoot(root);
  });

test('t780 create: an EMPTY existing directory is init\'d in place and takes a worktree',
  { skip: !gitAvailable() }, async () => {
    const f = mkTeamCreate();

    await create(f, f.projectRoot);

    assert.ok(f.teamExists('shop'), f.injected.join(' | '));
    await assertUsableAsTeamRoot(f.projectRoot);
  });

test('t780 create: a repo WITH commits is taken over — not one byte under it changes',
  { skip: !gitAvailable() }, async () => {
    const f = mkTeamCreate();
    const root = makeRepo('clodex-t780-take-');
    const filesBefore = fileList(root);
    const headBefore = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    await create(f, root);

    assert.ok(f.teamExists('shop'), f.injected.join(' | '));
    assert.deepStrictEqual(fileList(root), filesBefore, 'the recursive file list is identical');
    assert.strictEqual(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      headBefore, 'and HEAD did not move — no empty commit was laid on the operator\'s history');
  });

test('t780 create: a NON-EMPTY NON-REPO directory is refused with nothing created',
  { skip: !gitAvailable() }, async () => {
    const f = mkTeamCreate();
    const root = mkTmpRoot('clodex-t780-files-');
    fs.writeFileSync(path.join(root, 'secret.env'), 'TOKEN=1\n');
    const filesBefore = fileList(root);

    await create(f, root);

    assert.strictEqual(f.teamExists('shop'), false);
    assert.ok(f.injected.some((t) => t.includes(
      `error: root ${root} has files but no git repo — run git init there yourself `
      + '(Clodex will not make a first commit of files it did not create) and re-fire — no team was created')),
    f.injected.join(' | '));
    assert.deepStrictEqual(fileList(root), filesBefore, 'the operator\'s files are untouched');
    assert.strictEqual(fs.existsSync(path.join(root, '.git')), false,
      'and no repo was made — a first commit here would have captured secret.env');
  });

test('t780 create: a repo with NO commits is refused, and stays commitless',
  { skip: !gitAvailable() }, async () => {
    const f = mkTeamCreate();
    const root = mkTmpRoot('clodex-t780-nocommit-');
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
    assert.strictEqual(await wt.hasCommit(root), false, 'ENTER: the state under test');

    await create(f, root);

    assert.strictEqual(f.teamExists('shop'), false);
    assert.ok(f.injected.some((t) => t.includes(
      `error: root ${root} is a git repo with no commits — `
      + 'make one (git commit --allow-empty -m init) and re-fire — no team was created')),
    f.injected.join(' | '));
    assert.strictEqual(await wt.hasCommit(root), false, 'create made no commit of its own here');
  });

test('t780 create: a MISSING PARENT is refused, and the path is not minted',
  { skip: !gitAvailable() }, async () => {
    const f = mkTeamCreate();
    const parent = path.join(f.projectRoot, 'nope');
    const root = path.join(parent, 'deeper');

    await create(f, root);

    assert.strictEqual(f.teamExists('shop'), false);
    assert.ok(f.injected.some((t) => t.includes(
      `error: root ${root} — its parent ${parent} does not exist; `
      + 'Clodex creates the leaf, never the path — no team was created')), f.injected.join(' | '));
    assert.strictEqual(fs.existsSync(parent), false, 'a mkdir -p would have minted this');
  });

test('t780 create: a FILE is refused, and its bytes are unchanged',
  { skip: !gitAvailable() }, async () => {
    const f = mkTeamCreate();
    const root = path.join(f.projectRoot, 'notes.txt');
    fs.writeFileSync(root, 'operator content\n');

    await create(f, root);

    assert.strictEqual(f.teamExists('shop'), false);
    assert.ok(f.injected.some((t) => t.includes(
      `error: root ${root} is a file, not a directory — no team was created`)), f.injected.join(' | '));
    assert.strictEqual(fs.readFileSync(root, 'utf-8'), 'operator content\n');
  });

test('t780 create: WITH A BRIEF the reply names the case; bodiless carries neither clause',
  { skip: !gitAvailable() }, async () => {
    const fresh = mkTeamCreate();
    const newRoot = path.join(fresh.projectRoot, 'shop');
    await create(fresh, newRoot, 'Ship the thing.\n');
    assert.ok(fresh.injected.some((t) => t.includes(`root ${newRoot} (new, git init'd), lead shop-lead`)),
      fresh.injected.join(' | '));

    const taken = mkTeamCreate();
    const repo = makeRepo('clodex-t780-clause-');
    await create(taken, repo, 'Ship the thing.\n');
    assert.ok(taken.injected.some((t) => t.includes(`root ${repo} (existing repo, untouched), lead shop-lead`)),
      taken.injected.join(' | '));

    // The bodiless reply is byte-frozen by the t773 pin, so the clause must not
    // reach it at all — not even the correct one.
    const bare = mkTeamCreate();
    const repo2 = makeRepo('clodex-t780-bare-');
    await create(bare, repo2);
    assert.ok(bare.teamExists('shop'), 'ENTER: this create succeeded — the reply below is the success line');
    assert.deepStrictEqual(bare.injected.filter((t) => /\((new|existing)/.test(t)), []);
  });
