'use strict';
const { execFile, execFileSync } = require('child_process');

const DIFF_SUBCOMMANDS = new Set(['diff', 'show', 'log']);
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const FILTER_KEY_RE = /^filter\.(.+)\.[^.]+$/;

function safeGitArgs(args, { hooksPath = '/dev/null', sshCommand = 'ssh' } = {}) {
  const list = Array.isArray(args) ? args : [];
  const config = [
    'core.fsmonitor=', `core.hooksPath=${hooksPath}`, 'diff.external=', `core.sshCommand=${sshCommand}`, 'core.pager=cat',
  ].flatMap((s) => ['-c', s]);
  let i = 0;
  while (i < list.length && String(list[i]).startsWith('-')) i += VALUE_OPTIONS.has(list[i]) ? 2 : 1;
  if (i >= list.length || !DIFF_SUBCOMMANDS.has(list[i])) return [...config, ...list];
  return [...config, ...list.slice(0, i + 1), '--no-ext-diff', '--no-textconv', ...list.slice(i + 1)];
}

function filterOverrides(configNames) {
  const names = [];
  for (const key of String(configNames || '').split('\0')) {
    const m = FILTER_KEY_RE.exec(key.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names.flatMap((n) => ['-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`]);
}

function readOperatorGitConfig(run) {
  const get = (key) => {
    try { return String(run(['config', '--global', '--type=path', '--get', key]) || '').trim() || null; } catch { return null; }
  };
  return { hooksPath: get('core.hooksPath') || '/dev/null', sshCommand: get('core.sshCommand') || 'ssh' };
}

let operatorConfig = null;
function operatorGitConfig() {
  if (!operatorConfig) {
    operatorConfig = readOperatorGitConfig((a) => execFileSync('git', a, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }));
  }
  return operatorConfig;
}

function repoFilterNames(cwd) {
  return new Promise((resolve) => {
    execFile('git', safeGitArgs(['-C', cwd, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.']),
      { timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

async function safeGitArgsFor(cwd, args) {
  return [...filterOverrides(await repoFilterNames(cwd)), ...safeGitArgs(['-C', cwd, ...args], operatorGitConfig())];
}

module.exports = { safeGitArgs, safeGitArgsFor, filterOverrides, readOperatorGitConfig, operatorGitConfig };
