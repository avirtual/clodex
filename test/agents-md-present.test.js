'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GUARDED = 'If `.claude/memory.md` exists (local, untracked), read it first: it is the live thread.';

test('AGENTS.md exists at the repo root and is non-empty', () => {
  const src = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(src.trim().length > 0);
});

test('no root CLAUDE.md, so Claude falls back to AGENTS.md', () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'CLAUDE.md')), false);
});

test('AGENTS.md names no .claude/ path except the guarded memory.md line', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8').split('\n');
  const hits = lines.filter((l) => l.includes('.claude/'));
  assert.deepStrictEqual(hits.map((l) => l.replace(/^>\s*/, '')), [GUARDED]);
});
