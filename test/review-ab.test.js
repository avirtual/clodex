'use strict';
// Run: node --test test/review-ab.test.js
//
// scripts/review-ab.js — the A/B readout over REVIEW-COST.jsonl rows.
//
// Every expected number below is a LITERAL, computed by hand from the fixture
// rows and never by re-applying the script's own percentile rule: an expectation
// derived the way the code derives it asserts only that the code agrees with
// itself, and would have been green against a median that returned the mean.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ab = require('../scripts/review-ab.js');
const { mkTmpRoot } = require('./lib/tmp-roots');

const MIN = 60 * 1000;

function row(extra) {
  return JSON.stringify({
    version: 1, ticket: 't1', team: 'crew', round: 1, seat: 's', wireLabel: null,
    verdict: 'ACCEPT', mustFix: 0, template: null, wallMs: null, closedAt: 0,
    sessions: { ids: [], known: 0, total: 0, tokensKnown: 0, resolved: true },
    tokens: {}, usd: null, requests: null, turns: null, refusals: null,
    ...extra,
  });
}

// Two files under two different projects, so the walk itself is exercised: a
// reader that globbed only one project would still produce a plausible table.
function fixtureRoot() {
  const root = mkTmpRoot('review-ab-');
  const a = path.join(root, 'proj-a', 'tasks', 'ticket-one');
  const b = path.join(root, 'proj-b', 'tasks', 'ticket-two');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });

  // DEFAULT group: three rows, wall 4/10/22 min. Median is the middle one, 10.
  fs.writeFileSync(path.join(a, 'REVIEW-COST.jsonl'), [
    // A null template is the default reviewer — the rows that predate the field.
    row({ template: null, wallMs: 4 * MIN, requests: 20, usd: 1, verdict: 'ACCEPT', mustFix: 0 }),
    row({ template: null, wallMs: 10 * MIN, requests: 40, usd: 3, verdict: 'REWORK', mustFix: 4 }),
    row({ template: 'clodex-team-reviewer', wallMs: 22 * MIN, requests: 60, usd: 5, verdict: 'REWORK', mustFix: 2 }),
  ].join('\n') + '\n');

  // SHELL group: two rows, wall 5/7 min.
  fs.writeFileSync(path.join(b, 'REVIEW-COST.jsonl'), [
    row({ template: 'clodex-team-reviewer-shell', wallMs: 5 * MIN, requests: 12, usd: 0.5, verdict: 'ACCEPT', mustFix: 1 }),
    row({ template: 'clodex-team-reviewer-shell', wallMs: 7 * MIN, requests: 16, usd: 1.5, verdict: 'ACCEPT', mustFix: 3 }),
  ].join('\n') + '\n');
  return root;
}

test('review-ab: groups by template, folding a null template into the default', () => {
  const root = fixtureRoot();
  const files = ab.findCostFiles(root);
  assert.strictEqual(files.length, 2, 'ENTER: BOTH project dirs were walked — a one-file read still prints a table');
  const rows = ab.readRows(files);
  assert.strictEqual(rows.length, 5, 'ENTER: every row parsed; a dropped row silently shrinks a group');

  const summary = ab.summarize(rows);
  assert.deepStrictEqual(summary.map((s) => s.template),
    ['clodex-team-reviewer', 'clodex-team-reviewer-shell'],
    'the null-template rows join the named default rather than forming a third group');

  const [def, shell] = summary;
  // n=3: two null rows plus the one that names the default explicitly.
  assert.strictEqual(def.n, 3);
  assert.strictEqual(def.medianWallMin, 10, 'the middle of 4/10/22');
  assert.strictEqual(def.p90WallMin, 22, 'p90 of three values is the top one');
  assert.strictEqual(def.medianRequests, 40, 'the middle of 20/40/60');
  assert.strictEqual(def.medianUsd, 3, 'the middle of 1/3/5');
  assert.deepStrictEqual(def.verdicts, { ACCEPT: 1, REWORK: 2 });
  assert.strictEqual(def.meanMustFix, 2, '(0+4+2)/3');

  assert.strictEqual(shell.n, 2);
  assert.strictEqual(shell.medianWallMin, 7, 'the upper of the two, by this percentile rule');
  assert.strictEqual(shell.medianRequests, 16);
  assert.strictEqual(shell.medianUsd, 1.5);
  assert.deepStrictEqual(shell.verdicts, { ACCEPT: 2 });
  assert.strictEqual(shell.meanMustFix, 2, '(1+3)/2');
});

test('review-ab: a null wallMs is skipped, not counted as zero', () => {
  // The whole point of the null discipline in reviewCostRecord. A zero here
  // would report the slower template as the faster one.
  const rows = [
    { template: 'x', wallMs: null, requests: 10, usd: 1, verdict: 'ACCEPT', mustFix: 0 },
    { template: 'x', wallMs: 20 * MIN, requests: 10, usd: 1, verdict: 'ACCEPT', mustFix: 0 },
  ];
  const [only] = ab.summarize(rows);
  assert.strictEqual(only.n, 2, 'the row still counts toward n — it happened');
  assert.strictEqual(only.medianWallMin, 20, 'but contributes no duration');
});

test('review-ab: a group with no measurable rows reports null, and renders as "-"', () => {
  const [g] = ab.summarize([{ template: 'x', wallMs: null, requests: null, usd: null, verdict: null, mustFix: null }]);
  assert.strictEqual(g.medianWallMin, null);
  assert.strictEqual(g.medianUsd, null);
  assert.strictEqual(g.meanMustFix, null, 'a mean over nothing is not 0');
  const line = ab.render([g])[0];
  assert.match(line, /wall\(med\/p90\)=-\/-/);
  assert.match(line, /verdicts\[unknown:1\]/, 'a verdict-less row is counted as unknown, not dropped');
});

test('review-ab: a torn final line costs that row, never the file', () => {
  // JSONL is APPENDED to by a best-effort writer, so a crash mid-append leaves a
  // partial last line. Losing the whole file to it would silently halve a group.
  const root = mkTmpRoot('review-ab-torn-');
  const dir = path.join(root, 'p', 'tasks', 't');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'REVIEW-COST.jsonl'),
    row({ template: 'x', wallMs: MIN }) + '\n{"template":"x","wallM');
  const rows = ab.readRows(ab.findCostFiles(root));
  assert.strictEqual(rows.length, 1, 'the intact row survives its torn neighbour');
});

test('review-ab: a root with no cost files yields no groups', () => {
  assert.deepStrictEqual(ab.summarize(ab.readRows(ab.findCostFiles(mkTmpRoot('review-ab-empty-')))), []);
});
