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
};

const SYSTEM_SENDERS = new Set([...Object.keys(SYSTEM_SENDER_GLYPHS), 'clodex', 'user']);

module.exports = { SYSTEM_SENDER_GLYPHS, SYSTEM_SENDERS };
