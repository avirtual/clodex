'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseAgentPath, inferProvider } = require('../wire/route');

test('agent path is mandatory', () => {
  assert.equal(parseAgentPath('/v1/messages'), null);
  assert.equal(parseAgentPath('/agent//v1/messages'), null);
  // Out-of-charset and dot-only segments stay unroutable. `-bad` used to be
  // here too, on the router's imported "first char must be alphanumeric" rule;
  // it is a creatable clodex session name, so refusing to route it was F004 —
  // see the header of wire/route.js and test/agent-name-seam.test.js.
  assert.equal(parseAgentPath('/agent/bad name/v1/messages'), null);
  assert.equal(parseAgentPath('/agent/../v1/messages'), null);
  assert.equal(parseAgentPath('/agent/..'), null);
});

test('agent name extraction', () => {
  assert.deepEqual(parseAgentPath('/agent/clodex/v1/messages'),
    { agent: 'clodex', rest: '/v1/messages' });
  assert.deepEqual(parseAgentPath('/agent/a.b-c_d'),
    { agent: 'a.b-c_d', rest: '/' });
  // Leading `.`/`_`/`-` are legal clodex session names and must route.
  assert.deepEqual(parseAgentPath('/agent/_scratch/v1/messages'),
    { agent: '_scratch', rest: '/v1/messages' });
  assert.deepEqual(parseAgentPath('/agent/.hidden'), { agent: '.hidden', rest: '/' });
  assert.deepEqual(parseAgentPath('/agent/..a'), { agent: '..a', rest: '/' });
});

test('provider: anthropic default', () => {
  assert.deepEqual(inferProvider('/v1/messages'),
    { provider: 'anthropic', upstreamPath: '/v1/messages' });
  assert.deepEqual(inferProvider('/v1/messages/count_tokens'),
    { provider: 'anthropic', upstreamPath: '/v1/messages/count_tokens' });
});

test('provider: openai by suffix', () => {
  assert.deepEqual(inferProvider('/v1/chat/completions'),
    { provider: 'openai', upstreamPath: '/v1/chat/completions' });
  assert.deepEqual(inferProvider('/v1/responses'),
    { provider: 'openai', upstreamPath: '/v1/responses' });
});

test('provider: explicit segment wins', () => {
  assert.deepEqual(inferProvider('/openai/v1/models'),
    { provider: 'openai', upstreamPath: '/v1/models' });
  assert.deepEqual(inferProvider('/anthropic/v1/messages'),
    { provider: 'anthropic', upstreamPath: '/v1/messages' });
  assert.deepEqual(inferProvider('/anthropic'),
    { provider: 'anthropic', upstreamPath: '/' });
});
