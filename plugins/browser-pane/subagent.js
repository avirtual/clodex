'use strict';

const grammar = require('./grammar');

const SUBS = ['open', 'read', 'click', 'type', 'select', 'key', 'scroll', 'back', 'forward', 'wait', 'download', 'screenshot', 'inspect', 'services', 'note'];
const CONFIRM_SUBS = ['click', 'type', 'select', 'key'];
const NO_RELEASE = "release is for the seat's main agent";
const NO_CONFIRM = 'a subagent cannot confirm a consequential action — ask the main agent';
const NO_FORGET = 'a subagent cannot forget a site note — ask the main agent';

function words(intent) {
  return String((intent && intent.raw) || '').replace(/"/g, '').trim().split(/\s+/).filter(Boolean);
}

function refuse(intent) {
  const w = words(intent);
  if (w[0] === 'release') return NO_RELEASE;
  if (CONFIRM_SUBS.includes(w[0]) && w.some((x) => /^--confirm(=|$)/.test(x))) return NO_CONFIRM;
  if (w[0] === 'note' && w.some((x) => /^--forget(=|$)/.test(x))) return NO_FORGET;
  if (SUBS.includes(w[0])) return null;
  return grammar.SUBCOMMANDS.includes(w[0]) ? `not available to a subagent: browser ${w[0]} (a subagent may ${SUBS.join(', ')})` : '';
}

const brief = "This seat's browser pane is the `browser` MCP tool (verb, service, bracket, body).";

module.exports = { SUBS, CONFIRM_SUBS, NO_RELEASE, NO_CONFIRM, NO_FORGET, refuse, brief };
