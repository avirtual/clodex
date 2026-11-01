'use strict';

const HOOKS_OFF = 'core.hooksPath=/dev/null';
const SAFE_SETTINGS = ['core.fsmonitor=', HOOKS_OFF, 'diff.external=', 'core.sshCommand=ssh', 'core.pager=cat'];
const DIFF_SUBCOMMANDS = new Set(['diff', 'show', 'log']);
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function safeGitArgs(args, { keepHooks = false } = {}) {
  const list = Array.isArray(args) ? args : [];
  const config = SAFE_SETTINGS.filter((s) => !(keepHooks && s === HOOKS_OFF)).flatMap((s) => ['-c', s]);
  let i = 0;
  while (i < list.length && String(list[i]).startsWith('-')) i += VALUE_OPTIONS.has(list[i]) ? 2 : 1;
  if (i >= list.length || !DIFF_SUBCOMMANDS.has(list[i])) return [...config, ...list];
  return [...config, ...list.slice(0, i + 1), '--no-ext-diff', '--no-textconv', ...list.slice(i + 1)];
}

module.exports = { safeGitArgs };
