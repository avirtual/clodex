'use strict';

const { identToken } = require('../../intent-socket');

function wireSeenStamps() {
  const seen = new Set();
  let seq = 0;
  const seenIdent = (crypto, cred, agentId, agentType, sessionId, nonce) => {
    if (agentId) return identToken(crypto, cred, agentId, agentType, sessionId, nonce);
    const id = `toolu_seen${++seq}`;
    seen.add(id);
    return identToken(crypto, cred, null, null, sessionId, nonce, id);
  };
  const consume = (id) => seen.delete(id);
  const wire = { consumeMainToolUse: (name, id) => consume(id) };
  return { seenIdent, consume, wire, seen };
}

module.exports = { wireSeenStamps };
