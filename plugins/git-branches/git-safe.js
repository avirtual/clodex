'use strict';
const path = require('path');
const { execFile } = require('child_process');

const DIFF_SUBCOMMANDS = new Set(['diff', 'show', 'log']);
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const FILTER_KEY_RE = /^filter\.(.+)\.[^.]+$/;
const OPERATOR_SCOPES = new Set(['system', 'global']);

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
  if (names.some((n) => n.includes('='))) throw new Error('git filter driver name contains "="; refusing to run git here');
  return names.flatMap((n) => ['-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`]);
}

function scopedConfig(cwd, argv, run, what) {
  return new Promise((resolve, reject) => {
    run('git', safeGitArgs(['-C', cwd, 'config', '--null', '--show-scope', ...argv]),
      { timeout: 5000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        const out = String(stdout || '');
        const pairs = [];
        const fields = out.split('\0');
        for (let i = 0; i + 1 < fields.length; i += 2) pairs.push([fields[i], fields[i + 1]]);
        if (!err) return resolve(pairs);
        if (err.code === 1 && !err.killed && !out) return resolve([]);
        reject(new Error(`${what} failed: ${err.message}`));
      });
  });
}

async function readOperatorGitConfig(cwd, run = execFile) {
  const get = async (key) => {
    let pairs;
    try { pairs = await scopedConfig(cwd, ['--type=path', '--get-all', key], run, 'git config lookup'); } catch { return null; }
    const operator = pairs.filter(([scope]) => OPERATOR_SCOPES.has(scope));
    return operator.length ? operator[operator.length - 1][1].trim() || null : null;
  };
  const [hooks, sshCommand] = [await get('core.hooksPath'), await get('core.sshCommand')];
  return { hooksPath: hooks && path.isAbsolute(hooks) ? hooks : '/dev/null', sshCommand: sshCommand || 'ssh' };
}

const operatorConfigs = new Map();
function operatorGitConfigFor(cwd) {
  if (!operatorConfigs.has(cwd)) operatorConfigs.set(cwd, readOperatorGitConfig(cwd));
  return operatorConfigs.get(cwd);
}

async function repoFilterNames(cwd, run = execFile) {
  const pairs = await scopedConfig(cwd, ['--name-only', '--get-regexp', '^filter\\.'], run, 'git filter lookup');
  return pairs.filter(([scope]) => !OPERATOR_SCOPES.has(scope)).map(([, name]) => name).join('\0');
}

async function safeGitArgsFor(cwd, args, { run } = {}) {
  const [names, operator] = await Promise.all([repoFilterNames(cwd, run), operatorGitConfigFor(cwd)]);
  return [...filterOverrides(names), ...safeGitArgs(['-C', cwd, ...args], operator)];
}

module.exports = { safeGitArgs, safeGitArgsFor, filterOverrides, readOperatorGitConfig, operatorGitConfigFor };
