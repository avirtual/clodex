'use strict';
const path = require('path');
const { execFile } = require('child_process');

const SUBCOMMAND_FLAGS = new Map([
  ['diff', ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all']],
  ...['show', 'log'].map((c) => [c, ['--no-ext-diff', '--no-textconv']]),
  ['status', ['--ignore-submodules=all']],
  ...['fetch', 'pull', 'ls-remote'].map((c) => [c, ['--upload-pack=git-upload-pack']]),
  ['push', ['--receive-pack=git-receive-pack']],
]);
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const FILTER_KEY_RE = /^filter\.(.+)\.[^.]+$/;
const MERGE_DRIVER_RE = /^merge\.(.+)\.driver$/;
const OPERATOR_SCOPES = new Set(['system', 'global', 'unknown']);

function safeGitArgs(args, { hooksPath = '/dev/null', sshCommand = 'ssh', askPass = '', credentialHelpers = [] } = {}) {
  const list = Array.isArray(args) ? args : [];
  const config = [
    'core.fsmonitor=', `core.hooksPath=${hooksPath}`, 'diff.external=', `core.sshCommand=${sshCommand}`, 'core.pager=cat',
    'log.showSignature=false', 'commit.gpgSign=false', 'tag.gpgSign=false', 'gpg.program=', 'gpg.ssh.program=',
    'credential.helper=', ...credentialHelpers.map(([key, value]) => `${key}=${value}`), `core.askPass=${askPass}`, 'fetch.all=false',
    'protocol.ext.allow=never', 'protocol.git.allow=never', 'gpg.x509.program=', 'gpg.openpgp.program=', 'merge.verifySignatures=false', 'pull.verifySignatures=false',
    'diff.ignoreSubmodules=all', 'status.submoduleSummary=false', 'submodule.recurse=false', 'fetch.recurseSubmodules=no', 'push.recurseSubmodules=no',
  ].flatMap((s) => ['-c', s]);
  let i = 0;
  while (i < list.length && String(list[i]).startsWith('-')) i += VALUE_OPTIONS.has(list[i]) ? 2 : 1;
  if (i >= list.length || !SUBCOMMAND_FLAGS.has(list[i])) return [...config, ...list];
  return [...config, ...list.slice(0, i + 1), ...SUBCOMMAND_FLAGS.get(list[i]), ...list.slice(i + 1)];
}

function driverOverrides(configNames) {
  const names = [];
  const blanks = [];
  for (const raw of String(configNames || '').split('\0')) {
    const key = raw.trim();
    let m;
    if ((m = FILTER_KEY_RE.exec(key))) blanks.push(`filter.${m[1]}.clean=`, `filter.${m[1]}.smudge=`, `filter.${m[1]}.process=`);
    else if ((m = MERGE_DRIVER_RE.exec(key))) blanks.push(`merge.${m[1]}.driver=`);
    if (m) names.push(m[1]);
  }
  if (names.some((n) => n.includes('='))) throw new Error('git driver name contains "="; refusing to run git here');
  return [...new Set(blanks)].flatMap((s) => ['-c', s]);
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
  const [hooks, sshCommand, askPass] = [await get('core.hooksPath'), await get('core.sshCommand'), await get('core.askPass')];
  let helpers = [];
  try { helpers = await scopedConfig(cwd, ['--get-regexp', '^credential\\..*helper$'], run, 'git credential lookup'); } catch {}
  const credentialHelpers = helpers.filter(([scope, entry]) => OPERATOR_SCOPES.has(scope) && entry.includes('\n'))
    .map(([, entry]) => [entry.slice(0, entry.indexOf('\n')), entry.slice(entry.indexOf('\n') + 1)])
    .filter(([key]) => !key.includes('='));
  return { hooksPath: hooks && path.isAbsolute(hooks) ? hooks : '/dev/null', sshCommand: sshCommand || 'ssh', askPass: askPass || '', credentialHelpers };
}

const operatorConfigs = new Map();
function operatorGitConfigFor(cwd) {
  if (!operatorConfigs.has(cwd)) operatorConfigs.set(cwd, readOperatorGitConfig(cwd));
  return operatorConfigs.get(cwd);
}

async function repoFilterNames(cwd, run = execFile) {
  const pairs = await scopedConfig(cwd, ['--name-only', '--get-regexp', '^(filter|merge)\\.'], run, 'git filter lookup');
  return pairs.filter(([scope]) => !OPERATOR_SCOPES.has(scope)).map(([, name]) => name).join('\0');
}

async function safeGitArgsFor(cwd, args, { run } = {}) {
  const [names, operator] = await Promise.all([repoFilterNames(cwd, run), operatorGitConfigFor(cwd)]);
  return [...driverOverrides(names), ...safeGitArgs(['-C', cwd, ...args], operator)];
}

module.exports = { safeGitArgs, safeGitArgsFor, driverOverrides, filterOverrides: driverOverrides, readOperatorGitConfig, operatorGitConfigFor };
