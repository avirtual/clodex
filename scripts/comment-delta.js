'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { countCommentLines } = require('../comment-census.js');

const EXCLUDED_ANYWHERE = /(^|\/)(node_modules|vendor)\//;
const EXCLUDED_ROOT = /^(web-dist|dist)\//;

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tryGit(repo, args) {
  try {
    return { ok: true, out: git(repo, args) };
  } catch (err) {
    return { ok: false, err };
  }
}

function inScope(p) {
  return p.endsWith('.js') && !EXCLUDED_ROOT.test(p) && !EXCLUDED_ANYWHERE.test(p);
}

function changedFiles(repo, base) {
  const tracked = git(repo, ['diff', '--name-only', base]).split('\n');
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...tracked, ...untracked])]
    .map((p) => p.trim())
    .filter(Boolean)
    .filter(inScope)
    .sort();
}

function baseCount(repo, base, file) {
  const r = tryGit(repo, ['show', `${base}:${file}`]);
  if (!r.ok) return 0;
  if (r.out.includes('\0')) return 0;
  return countCommentLines(r.out);
}

function commentDelta({ repo, base } = {}) {
  const root = git(repo || process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  let resolved = base;
  if (!resolved) {
    const mb = tryGit(root, ['merge-base', 'master', 'HEAD']);
    if (!mb.ok || !mb.out.trim()) {
      throw new Error('comment-delta: no merge-base between master and HEAD; pass an explicit base');
    }
    resolved = mb.out.trim();
  }
  resolved = git(root, ['rev-parse', resolved]).trim();

  const files = [];
  let added = 0;
  for (const file of changedFiles(root, resolved)) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    const before = baseCount(root, resolved, file);
    const after = countCommentLines(fs.readFileSync(abs, 'utf8'));
    files.push({ file, before, after });
    if (after > before) added += after - before;
  }

  return { base: resolved, files, added };
}

function main(argv) {
  const { base, files, added } = commentDelta({ repo: process.cwd(), base: argv[0] });
  const short = base.slice(0, 7);
  if (added === 0) {
    process.stdout.write(`comment-delta: 0 added across ${files.length} changed .js files (base ${short})\n`);
    return 0;
  }
  for (const row of files) {
    if (row.after > row.before) {
      process.stdout.write(`${row.file}: ${row.before} -> ${row.after} (+${row.after - row.before})\n`);
    }
  }
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    process.exitCode = 2;
  }
}

module.exports = { commentDelta };
