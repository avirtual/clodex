'use strict';

const TURN_KINDS = new Set(['prompt', 'inbound', 'reply', 'notification', 'command', 'boundary']);

function isInternalRow(rec) {
  if (!rec) return false;
  switch (rec.kind) {
    case 'inbound': return rec.from !== 'user';
    case 'reply':
    case 'notice':
    case 'notification': return true;
    default: return false;
  }
}

module.exports = { TURN_KINDS, isInternalRow };
