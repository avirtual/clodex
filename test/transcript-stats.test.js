'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'transcript-stats.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'transcript-stats');

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, '--dir', FIXTURES, ...args], { encoding: 'utf8' });
}

test('transcript-stats analyzes fixture transcripts', async (t) => {
  const out = JSON.parse(run(['--json']));

  await t.test('inventory: counts live transcripts, excludes .bak, finds subagents', () => {
    assert.strictEqual(out.transcripts, 2);
    assert.strictEqual(out.subagentTranscripts, 1);
    // .bak snapshot must not leak into any stats
    assert.ok(!JSON.stringify(out).includes('should-not-count'));
  });

  await t.test('agent labeling from SessionStart hook', () => {
    assert.deepStrictEqual(Object.keys(out.agents).sort(), ['(unlabeled)', 'fixture-agent']);
  });

  const agent = out.agents['fixture-agent'];

  await t.test('api requests deduped by requestId, usage summed once', () => {
    assert.strictEqual(agent.apiRequests, 4);
    // req_1 appears on two records but counts once: 100+10+1+0 input
    assert.strictEqual(agent.usage.input_tokens, 111);
    assert.strictEqual(agent.usage.output_tokens, 57);
    assert.strictEqual(agent.usage.cache_read_input_tokens, 3300);
    assert.strictEqual(agent.cacheReadPerRequest, 825);
  });

  await t.test('user turns exclude tool_result, meta, command echoes, compact summaries', () => {
    assert.strictEqual(agent.userTurns, 1);
  });

  await t.test('tool counts split main-line vs sidechain', () => {
    assert.deepStrictEqual(agent.tools, { Read: 7, Bash: 2, Edit: 1 });
    assert.deepStrictEqual(agent.sidechainTools, { Grep: 1, Read: 1 });
    assert.strictEqual(agent.sidechainApiRequests, 1);
    assert.strictEqual(agent.sidechainUsage.output_tokens, 9);
  });

  await t.test('re-reads classify by slice and segment on compact boundary', () => {
    // main.js read 3× whole-file: 2nd repeats the exact args (identical-args),
    // 3rd follows the compact_boundary so the segment reset absolves it.
    // big.js: sliced read, a different slice (paginated — new bytes, not
    // waste), a whole-file read after slices (full-after-prior), and the
    // same whole-file read again (identical-args).
    assert.strictEqual(agent.totalReads, 7);
    assert.deepStrictEqual(agent.rereads, {
      paginated: 1, identicalArgs: 2, fullAfterPrior: 1, redundant: 3,
    });
    assert.strictEqual(agent.compacts, 1);
  });

  await t.test('bash heads are subcommand-aware and cd-root is counted', () => {
    assert.deepStrictEqual(agent.bash, { cd: 1, 'git diff': 1 });
    assert.strictEqual(agent.cdIntoRoot, 1); // "cd /proj && npm test" with record cwd /proj
    assert.strictEqual(agent.bashCalls, 2);
  });

  await t.test('first-turn fixed payload: claudeMd + listings', () => {
    assert.strictEqual(agent.firstTurnPayload.claudeMdPersistedSessions, 1);
    assert.strictEqual(
      agent.firstTurnPayload.claudeMdMaxBytes,
      Buffer.byteLength('# fixture claude md body: 0123456789'),
    );
    assert.ok(agent.firstTurnPayload.listingMaxBytes > 0, 'skill_listing after first user record counts');
    assert.ok(agent.firstTurnPayload.hookMaxBytes > 0);
  });

  await t.test('unlabeled session: cd to non-root is not cd-root', () => {
    const unl = out.agents['(unlabeled)'];
    assert.strictEqual(unl.bashCalls, 2);
    assert.strictEqual(unl.cdIntoRoot, 1); // bare "cd /proj" yes, "cd /elsewhere" no
    assert.deepStrictEqual(unl.tools, { Bash: 2, Grep: 1 });
  });

  await t.test('every-session tax and combined view', () => {
    assert.strictEqual(out.combined.sessions, 2);
    const mainJs = out.everySessionTax.find((e) => e.file === '/proj/main.js');
    assert.ok(mainJs, 'main.js appears in every-session tax');
    assert.strictEqual(mainJs.sessions, 1);
    assert.strictEqual(mainJs.reads, 3);
  });

  await t.test('per-session offender lists exist (below MIN_SAMPLE here)', () => {
    assert.ok(Array.isArray(out.worstRereadSessions));
    assert.ok(Array.isArray(out.worstCdRootSessions));
    assert.strictEqual(out.worstRereadSessions.length, 0); // fixtures are under the 10-Read floor
  });
});

test('transcript-stats --agent filters and human output renders', () => {
  const text = run(['--agent', 'fixture-agent', '--top', '3']);
  assert.match(text, /=== fixture-agent: 1 session\(s\)/);
  assert.ok(!text.includes('(unlabeled)'));

  const all = run([]);
  assert.match(all, /every-session tax/);
});
