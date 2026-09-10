'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  RoleClassifier, isSubagentRole, billingIsSubagent, billingFingerprint,
  isTitleCall, isProbeCall, isClassifierCall,
} = require('../wire/role');

const SID = '4a59af49-cc52-44b7-8b02-7f4196a4b486';

// Billing header shapes as seen on the wire (block 0 of system[]).
function billing(fp, sub) {
  return `x-anthropic-billing-header: cc_surface=cli cc_is_subagent=${sub} cc_version=${fp}`;
}

function parentTurn(fp = 'a1b2c3.1.0.53') {
  return {
    system: [
      { type: 'text', text: billing(fp, 'false') },
      { type: 'text', text: 'You are Claude Code, an agentic coding tool.' },
    ],
    tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: 'hi' }],
  };
}

function subagentTurn(fp = 'ffff99.1.0.53') {
  return {
    system: [
      { type: 'text', text: billing(fp, 'true') },
      { type: 'text', text: 'You are an agent for Claude Code.' },
    ],
    tools: [{ name: 'Read' }],
    messages: [{ role: 'user', content: 'search for X' }],
  };
}

test('billing header parsing', () => {
  assert.equal(billingIsSubagent(parentTurn()), false);
  assert.equal(billingIsSubagent(subagentTurn()), true);
  assert.equal(billingFingerprint(parentTurn('deadbeef.2')), 'deadbeef.2');
  assert.equal(billingFingerprint({ system: 'no header here' }), null);
});

test('signature roles win over the generic bucket', () => {
  const c = new RoleClassifier();
  assert.equal(c.classify({ system: [{ type: 'text', text: 'You are a software architect and planning specialist.' }] }, SID, null), 'Plan');
  assert.equal(c.classify({ system: 'You are a verification specialist.' }, SID, null), 'verification');
  assert.equal(c.classify(subagentTurn(), SID, null), 'general-purpose');
});

test('parent and unknown are the main line', () => {
  const c = new RoleClassifier();
  assert.equal(c.classify(parentTurn(), SID, null), 'parent');
  assert.equal(c.classify({ system: 'something else entirely' }, SID, null), 'unknown');
  assert.equal(isSubagentRole('parent'), false);
  assert.equal(isSubagentRole('unknown'), false);
  assert.equal(isSubagentRole('subagent'), true);
  assert.equal(isSubagentRole('Plan'), true);
});

test('custom subagent (no known signature) files as generic subagent', () => {
  const c = new RoleClassifier();
  const custom = {
    system: [
      { type: 'text', text: billing('bbbb00.1', 'true') },
      { type: 'text', text: 'You are a bespoke reviewer agent.' },
    ],
  };
  assert.equal(c.classify(custom, SID, null), 'subagent');
});

test('teammate-spawned agent: agent-id only, never sets cc_is_subagent', () => {
  const c = new RoleClassifier();
  c.noteMainFingerprint(SID, parentTurn('aaaa11.1'));
  const spawned = {
    system: [
      { type: 'text', text: billing('cccc22.1', 'false') },
      { type: 'text', text: 'You are Claude Code, an agentic coding tool.' },
    ],
  };
  // Own fingerprint + a present x-claude-code-agent-id → genuine subagent.
  assert.equal(c.classify(spawned, SID, 'opsguru2@session-1'), 'subagent');
});

test('stale-agent-id leak: leaked parent turn stays on the main line', () => {
  // The landmine regression (wire-confirmed 2026-06-14): a PARENT turn
  // arrives flagged cc_is_subagent=true with a recycled agent-id. Its body
  // is the parent conversation, so it carries the MAIN fingerprint — the
  // stateful backstop must classify it parent, not subagent.
  const c = new RoleClassifier();
  const fp = 'a1b2c3.1.0.53';
  c.noteMainFingerprint(SID, parentTurn(fp));

  const leaked = {
    system: [
      { type: 'text', text: billing(fp, 'true') }, // leaked flag, SAME fingerprint
      { type: 'text', text: 'You are Claude Code, an agentic coding tool.' },
    ],
  };
  assert.equal(c.classify(leaked, SID, 'recycled-agent-id'), 'parent');

  // WITHOUT the stored fingerprint state the same turn misfiles as
  // subagent — proving the state, not the flag, is what carries this.
  const stateless = new RoleClassifier();
  assert.equal(stateless.classify(leaked, SID, 'recycled-agent-id'), 'subagent');
});

test('fingerprint state is per-session and forgettable', () => {
  const c = new RoleClassifier();
  const fp = 'eeee33.1';
  c.noteMainFingerprint(SID, parentTurn(fp));
  const leaked = {
    system: [
      { type: 'text', text: billing(fp, 'true') },
      { type: 'text', text: 'You are Claude Code.' },
    ],
  };
  assert.equal(c.classify(leaked, 'other-session', null), 'subagent'); // no state for that sid
  c.forgetSession(SID);
  assert.equal(c.classify(leaked, SID, null), 'subagent'); // state dropped with the session
});

test('title side-call detection', () => {
  assert.equal(isTitleCall({
    system: 'Generate a concise, sentence-case title for this conversation.',
    messages: [{ role: 'user', content: 'hi' }],
  }), true);
  assert.equal(isTitleCall(parentTurn()), false); // has tools
  assert.equal(isTitleCall({ system: 'You are Claude Code.' }), false);
});

const CLASSIFIER_SYS = 'You are a security monitor for autonomous AI coding agents. Your job is to '
  + 'classify whether a proposed tool call is safe to run without asking the operator. '
  + '[…127 KB of policy…]';

function classifierCall(extra = {}) {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 64,
    system: [
      { type: 'text', text: billing('a1b2c3.1.0.53', 'false') },
      { type: 'text', text: CLASSIFIER_SYS },
      { type: 'text', text: 'Respond with allow or ask.' },
    ],
    messages: [{ role: 'user', content: 'Bash(rm -rf build)' }],
    ...extra,
  };
}

test('auto-mode permission classifier detection', () => {
  assert.equal(isClassifierCall(classifierCall()), true);
  // The prefix alone decides, but only for a toolless call: a real agent turn
  // that quoted the same prompt back carries tools and is the agent's own request.
  assert.equal(isClassifierCall(classifierCall({ tools: [{ name: 'Bash' }] })), false);
  assert.equal(isClassifierCall(parentTurn()), false);
  assert.equal(isClassifierCall({ system: `${CLASSIFIER_SYS}`, max_tokens: 64 }), true);
  assert.equal(isClassifierCall({ system: 'You are Claude Code.' }), false);
});

test('health-probe detection', () => {
  assert.equal(isProbeCall({ max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] }), true);
  assert.equal(isProbeCall({ max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] }), false);
  assert.equal(isProbeCall(parentTurn()), false);
});
