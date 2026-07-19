'use strict';
// tool-doctor.test.js — the external-tool presence leaf (Task 12). Pure probe +
// notice fns with an injected whichBin, and the TTL cache wrapper (shared
// detect-cache). No PATH, no spawn — whichBin is a fake map.

const test = require('node:test');
const assert = require('node:assert');
const {
  TOOL_SPECS, FUTURE_TOOLS, probeTool, probeTools, specFor, toolNotice, createToolCache,
} = require('../tool-doctor');

// A fake whichBin over a present-set: returns a plausible path for a present bin.
const whichFrom = (present) => (bin) => (present.has(bin) ? `/usr/local/bin/${bin}` : null);

test('probeTool: first bin on PATH wins → present + path', () => {
  const r = probeTool({ name: 'claude', bins: ['claude'] }, whichFrom(new Set(['claude'])));
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.tool, 'claude');
  assert.strictEqual(r.path, '/usr/local/bin/claude');
});

test('probeTool: none of the bins found → absent, path null, bin = first candidate', () => {
  const r = probeTool({ name: 'gh', bins: ['gh', 'hub'] }, whichFrom(new Set()));
  assert.strictEqual(r.present, false);
  assert.strictEqual(r.path, null);
  assert.strictEqual(r.bin, 'gh');
});

test('probeTool: falls through to a later bin when the first is missing', () => {
  const r = probeTool({ name: 'x', bins: ['nope', 'yes'] }, whichFrom(new Set(['yes'])));
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.bin, 'yes');
});

test('probeTools: reports every default spec, in spec order', () => {
  const list = probeTools(whichFrom(new Set(['git', 'ssh'])));
  assert.deepStrictEqual(list.map((r) => r.tool), TOOL_SPECS.map((s) => s.name));
  const byName = Object.fromEntries(list.map((r) => [r.tool, r.present]));
  assert.strictEqual(byName.git, true);
  assert.strictEqual(byName.ssh, true);
  assert.strictEqual(byName.claude, false);
});

test('specs: claude/codex carry an install remedy; python3 is future, NOT probed', () => {
  assert.match(specFor('claude').install, /claude-code/);
  assert.ok(specFor('codex').install, 'codex has an install line');
  assert.strictEqual(specFor('python3'), null, 'python3 is not a probed spec');
  assert.ok(FUTURE_TOOLS.includes('python3'), 'python3 is listed as future');
});

test('toolNotice: present → ok; missing with install → error + remedy; missing without → bare', () => {
  assert.strictEqual(toolNotice({ tool: 'claude', present: true }, specFor('claude')).kind, 'ok');
  const miss = toolNotice({ tool: 'claude', present: false }, specFor('claude'));
  assert.strictEqual(miss.kind, 'error');
  assert.match(miss.text, /not found on PATH/);
  assert.match(miss.text, /install: npm i -g @anthropic-ai\/claude-code/);
  const bare = toolNotice({ tool: 'git', present: false }, specFor('git'));
  assert.strictEqual(bare.kind, 'error');
  assert.doesNotMatch(bare.text, /install:/, 'no remedy when the spec carries none');
});

test('createToolCache: byTool carries each report + its precomputed notice', async () => {
  const cache = createToolCache({ whichBin: whichFrom(new Set(['codex'])), now: () => 0 });
  const res = await cache.get();
  assert.strictEqual(res.byTool.codex.present, true);
  assert.strictEqual(res.byTool.codex.notice.kind, 'ok');
  assert.strictEqual(res.byTool.claude.present, false);
  assert.match(res.byTool.claude.notice.text, /not found on PATH/);
  assert.ok(Array.isArray(res.list), 'the flat list is also present');
});

test('createToolCache: caches within the TTL, re-probes past it (shared detect-cache)', async () => {
  let probes = 0;
  const whichBin = (bin) => { probes++; return bin === 'git' ? '/usr/bin/git' : null; };
  let clock = 0;
  const cache = createToolCache({ whichBin, now: () => clock, ttlMs: 1000 });
  await cache.get();
  const afterFirst = probes;
  await cache.get();                 // within TTL → no new probe
  assert.strictEqual(probes, afterFirst, 'second get within TTL is served from cache');
  clock = 2000;                      // past TTL
  await cache.get();
  assert.ok(probes > afterFirst, 're-probes once the TTL elapses');
});

test('createToolCache: invalidate() forces the next get() to re-probe', async () => {
  let probes = 0;
  const whichBin = () => { probes++; return null; };
  const cache = createToolCache({ whichBin, now: () => 0 });
  await cache.get();
  const afterFirst = probes;
  cache.invalidate();
  await cache.get();
  assert.ok(probes > afterFirst, 'invalidate drops the cache');
});
