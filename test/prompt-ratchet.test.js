'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { mkTmpRoot } = require('./lib/tmp-roots');

const REPO = path.join(__dirname, '..');
const NEW_FILE_CAP = 10 * 1024;
const PROMPT_DIRS = ['resources/library/prompts/system', 'resources/library/kits'];
const PROMPT_FILE = /^resources\/library\/(prompts\/system|kits\/[^/]+\/prompts\/system)\/[^/]+\.md$/;
const IPC_ROW = 'ipc-prompt.js:buildIpcPrompt';
const SPILL_ROW = 'ipc-prompt.js:spillGrammarLine';

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function tryGit(args) {
  try {
    return { ok: true, out: git(args) };
  } catch (err) {
    return { ok: false, err };
  }
}

function mergeBase() {
  const hasMaster = tryGit(['rev-parse', '--verify', '--quiet', 'master']);
  if (!hasMaster.ok || !hasMaster.out.trim()) return { base: null, why: 'no master ref in this checkout' };

  const shallow = tryGit(['rev-parse', '--is-shallow-repository']);
  if (shallow.ok && shallow.out.trim() === 'true') return { base: null, why: 'shallow clone' };

  const mb = tryGit(['merge-base', 'master', 'HEAD']);
  if (!mb.ok || !mb.out.trim()) return { base: null, why: 'no merge-base between master and HEAD' };

  return { base: mb.out.trim(), why: null };
}

function parseBumps(log) {
  const bumps = new Map();
  for (const line of String(log).split('\n')) {
    const m = /^Prompt-bytes:\s*(\S+)\s+\+(\d+)\s*$/.exec(line.trim());
    if (m) bumps.set(m[1], (bumps.get(m[1]) || 0) + Number(m[2]));
  }
  return bumps;
}

function judge(rows, bumps, cap) {
  const failures = [];
  const changed = [];
  for (const { name, base, head } of rows) {
    const bump = bumps.get(name) || 0;
    const budget = base === null ? cap : base;
    const delta = head - budget;
    const baseText = base === null ? `absent (new file, cap ${cap} B)` : `${base} B`;
    const deltaText = delta >= 0 ? `+${delta}` : String(delta);
    if (base === null || delta !== 0 || bump) changed.push(`${name}: base ${baseText}, HEAD ${head} B, delta ${deltaText} B`);
    if (delta <= bump) continue;
    failures.push(
      `${name}: base ${baseText}, HEAD ${head} B, delta ${deltaText} B, allowed +${bump} B by Prompt-bytes trailers.`
      + ` Cut it back, or grow it deliberately with the commit-message trailer line`
      + ` "Prompt-bytes: ${name} +${delta - bump}" on this branch, on top of any trailers already counted.`,
    );
  }
  return { failures, changed };
}

function headRows() {
  const rows = [];
  const scan = (dir) => {
    for (const ent of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) scan(rel);
      else if (ent.isFile() && PROMPT_FILE.test(rel)) rows.push({ name: rel, head: fs.statSync(path.join(REPO, rel)).size });
    }
  };
  for (const dir of PROMPT_DIRS) scan(dir);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const ipc = require('../ipc-prompt.js');
  rows.push({ name: IPC_ROW, head: Buffer.byteLength(ipc.buildIpcPrompt(null), 'utf8') });
  rows.push({ name: SPILL_ROW, head: Buffer.byteLength(ipc.spillGrammarLine('/r'), 'utf8') });
  return rows;
}

function baseFileSizes(base) {
  const sizes = new Map();
  const out = git(['ls-tree', '-r', '-l', base, '--', ...PROMPT_DIRS]);
  for (const line of out.split('\n')) {
    const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(line);
    if (m && PROMPT_FILE.test(m[2])) sizes.set(m[2], Number(m[1]));
  }
  return sizes;
}

function baseBlobExists(base, rel) {
  return tryGit(['cat-file', '-e', `${base}:${rel}`]).ok;
}

function baseGeneratedSizes(base) {
  const sizes = new Map();
  if (!baseBlobExists(base, 'ipc-prompt.js')) return sizes;
  const root = mkTmpRoot('t1405-prompt-ratchet-');
  const queue = ['ipc-prompt.js'];
  const seen = new Set();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = git(['show', `${base}:${rel}`]);
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src);
    if (!rel.endsWith('.js')) continue;
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const spec = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      const hit = [spec, `${spec}.js`, `${spec}.json`, `${spec}/index.js`].find((c) => baseBlobExists(base, c));
      if (!hit) throw new Error(`${rel} at ${base} requires ${m[1]}, which is not in that tree`);
      queue.push(hit);
    }
  }
  const ipc = require(path.join(root, 'ipc-prompt.js'));
  if (typeof ipc.buildIpcPrompt === 'function') sizes.set(IPC_ROW, Buffer.byteLength(ipc.buildIpcPrompt(null), 'utf8'));
  if (typeof ipc.spillGrammarLine === 'function') sizes.set(SPILL_ROW, Buffer.byteLength(ipc.spillGrammarLine('/r'), 'utf8'));
  return sizes;
}

test('judge: literal fixture rows for grown, shrunk, new, bumped and bump-too-small', () => {
  const rows = [
    { name: 'p/grown.md', base: 1000, head: 1010 },
    { name: 'p/shrunk.md', base: 1000, head: 900 },
    { name: 'p/same.md', base: 500, head: 500 },
    { name: 'p/new-small.md', base: null, head: 9000 },
    { name: 'p/new-big.md', base: null, head: 10300 },
    { name: 'p/bumped.md', base: 2000, head: 2150 },
    { name: 'p/bump-small.md', base: 2000, head: 2150 },
    { name: 'p/new-bumped.md', base: null, head: 10300 },
    { name: 'p/bump-half.md', base: 2000, head: 2150 },
  ];
  const bumps = parseBumps([
    'feat: grow two prompts',
    '',
    'Prompt-bytes: p/bumped.md +100',
    'Prompt-bytes: p/bump-small.md +149',
    'Prompt-bytes: p/bump-half.md +100',
    'fix: second commit',
    '',
    '  Prompt-bytes: p/bumped.md +50  ',
    'Prompt-bytes: p/new-bumped.md +60',
    'Prompt-bytes: p/shrunk.md 40',
    'Prompt-bytes p/grown.md +20',
  ].join('\n'));

  assert.deepStrictEqual([...bumps], [
    ['p/bumped.md', 150],
    ['p/bump-small.md', 149],
    ['p/bump-half.md', 100],
    ['p/new-bumped.md', 60],
  ], 'trailers for one file sum across commits; a line without the colon or the plus sign is not a trailer');

  const { failures, changed } = judge(rows, bumps, 10240);

  assert.deepStrictEqual(failures, [
    'p/grown.md: base 1000 B, HEAD 1010 B, delta +10 B, allowed +0 B by Prompt-bytes trailers.'
      + ' Cut it back, or grow it deliberately with the commit-message trailer line'
      + ' "Prompt-bytes: p/grown.md +10" on this branch, on top of any trailers already counted.',
    'p/new-big.md: base absent (new file, cap 10240 B), HEAD 10300 B, delta +60 B, allowed +0 B by Prompt-bytes trailers.'
      + ' Cut it back, or grow it deliberately with the commit-message trailer line'
      + ' "Prompt-bytes: p/new-big.md +60" on this branch, on top of any trailers already counted.',
    'p/bump-small.md: base 2000 B, HEAD 2150 B, delta +150 B, allowed +149 B by Prompt-bytes trailers.'
      + ' Cut it back, or grow it deliberately with the commit-message trailer line'
      + ' "Prompt-bytes: p/bump-small.md +1" on this branch, on top of any trailers already counted.',
    'p/bump-half.md: base 2000 B, HEAD 2150 B, delta +150 B, allowed +100 B by Prompt-bytes trailers.'
      + ' Cut it back, or grow it deliberately with the commit-message trailer line'
      + ' "Prompt-bytes: p/bump-half.md +50" on this branch, on top of any trailers already counted.',
  ]);

  assert.deepStrictEqual(changed, [
    'p/grown.md: base 1000 B, HEAD 1010 B, delta +10 B',
    'p/shrunk.md: base 1000 B, HEAD 900 B, delta -100 B',
    'p/new-small.md: base absent (new file, cap 10240 B), HEAD 9000 B, delta -1240 B',
    'p/new-big.md: base absent (new file, cap 10240 B), HEAD 10300 B, delta +60 B',
    'p/bumped.md: base 2000 B, HEAD 2150 B, delta +150 B',
    'p/bump-small.md: base 2000 B, HEAD 2150 B, delta +150 B',
    'p/new-bumped.md: base absent (new file, cap 10240 B), HEAD 10300 B, delta +60 B',
    'p/bump-half.md: base 2000 B, HEAD 2150 B, delta +150 B',
  ]);
});

test('judge: a trailer naming a file that did not grow changes nothing, and HEAD at the budget passes', () => {
  const { failures } = judge(
    [{ name: 'a.md', base: 10, head: 10 }, { name: 'b.md', base: null, head: 10240 }],
    parseBumps('Prompt-bytes: a.md +5'),
    10240,
  );
  assert.deepStrictEqual(failures, []);
});

test('no shipped role prompt or generated intents block grows against the merge-base with master', (t) => {
  const rows = headRows();
  const names = rows.map((r) => r.name);

  for (const must of [
    'resources/library/prompts/system/clodex-team-lead.md',
    'resources/library/prompts/system/clodex-team-hand.md',
    'resources/library/kits/clodex/prompts/system/clodex-team-lead.md',
    'resources/library/kits/default/prompts/system/lead.md',
    IPC_ROW,
    SPILL_ROW,
  ]) {
    assert.ok(names.includes(must), `${must} should be measured by the prompt ratchet`);
  }
  assert.ok(rows.every((r) => r.head > 0), 'every measured prompt has bytes on HEAD');

  const { base, why } = mergeBase();
  if (base === null) {
    t.skip(`prompt ratchet cannot run: ${why}. Fetch master (unshallow if needed) and re-run.`);
    return;
  }

  const fileSizes = baseFileSizes(base);
  const genSizes = baseGeneratedSizes(base);
  const withBase = rows.map((r) => ({
    ...r,
    base: fileSizes.get(r.name) ?? genSizes.get(r.name) ?? null,
  }));
  const bumps = parseBumps(git(['log', '--format=%B', `${base}..HEAD`]));
  const { failures, changed } = judge(withBase, bumps, NEW_FILE_CAP);

  t.diagnostic(`prompt ratchet against ${base.slice(0, 12)}: ${changed.length ? changed.join('; ') : 'no prompt changed size'}`);

  assert.deepStrictEqual(
    failures,
    [],
    `shipped prompts grew against the merge-base ${base}:\n  ${failures.join('\n  ')}`,
  );
});
