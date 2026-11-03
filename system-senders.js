'use strict';

const SYSTEM_SENDER_GLYPHS = {
  reminder: '◷',
  reboot: '↻',
  'ticket-loop': '⇄',
  'ticket-watchdog': '◉',
  monitor: '▣',
  memory: '◈',
  exec: '▸',
  terminal: '▤',
  team: '⊞',
  'clodex-team': '⊞',
  wirescope: '∿',
  'deploy-fix': '⚙',
  permission: '⊩',
};

const SYSTEM_SENDERS = new Set([...Object.keys(SYSTEM_SENDER_GLYPHS), 'clodex', 'user']);

const RESERVED_SENDER_NAMES = new Set([...SYSTEM_SENDERS, 'relay', 'ctl-admin', 'peer', 'ext']);
const RESERVED_SENDER_SUFFIX_RE = /-(loop|watchdog)$/;

function isReservedSenderName(name) {
  const n = String(name).toLowerCase();
  return RESERVED_SENDER_NAMES.has(n) || RESERVED_SENDER_SUFFIX_RE.test(n);
}

function reservedSenderError(name) {
  return `"${name}" is reserved for a system sender`;
}

module.exports = { SYSTEM_SENDER_GLYPHS, SYSTEM_SENDERS, RESERVED_SENDER_NAMES, RESERVED_SENDER_SUFFIX_RE, isReservedSenderName, reservedSenderError };
