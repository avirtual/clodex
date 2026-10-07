'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { observeRequest } = require('../wire/replay');
const { RoleClassifier } = require('../wire/role');

const SID = '4a59af49-cc52-44b7-8b02-7f4196a4b486';

test('observeRequest passes the request-class header to classify', () => {
  const obj = {
    metadata: { user_id: JSON.stringify({ session_id: SID }) },
    system: [{ type: 'text', text: 'A custom agent prompt.' }],
    tools: [{ name: 'Read' }],
    messages: [{ role: 'user', content: 'go' }],
  };
  const c = new RoleClassifier();
  assert.equal(observeRequest(c, obj, {}).role, 'unknown');
  const r = observeRequest(new RoleClassifier(), obj, { 'x-claude-code-request-class': 'subagent' });
  assert.deepEqual(r, { sessionId: SID, role: 'subagent', sideCall: false });
});

test('observeRequest treats the auxiliary request class as a side-call and notes no main fingerprint', () => {
  const obj = {
    metadata: { user_id: JSON.stringify({ session_id: SID }) },
    system: [{ type: 'text', text: 'A custom agent prompt.' }],
    tools: [{ name: 'Read' }],
    messages: [{ role: 'user', content: 'go' }],
  };
  const c = new RoleClassifier();
  let noted = 0;
  c.noteMainFingerprint = () => { noted++; };
  assert.equal(observeRequest(c, obj, {}).sideCall, false);
  assert.equal(noted, 1, 'ENTER: the same body without the header is noted as main');
  const r = observeRequest(c, obj, { 'x-claude-code-request-class': 'auxiliary' });
  assert.equal(r.sideCall, true);
  assert.equal(noted, 1);
});
