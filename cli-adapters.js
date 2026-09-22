'use strict';

const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,63}(?:\[[a-z0-9]{1,8}\])?$/;

const CAP_KEYS = ['injectSkills', 'skillRoster', 'plugins', 'agents', 'tools', 'strip', 'autoCompact', 'noWire', 'accounts'];

const ADAPTERS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    cmd: 'claude',
    model: {
      flags: ['--model'],
      aliases: {
        opus: 'claude-opus-5-5[1m]',
        sonnet: 'claude-sonnet-5[1m]',
        haiku: 'claude-haiku-4-5-20251001',
        fable: 'claude-fable-5-1[1m]',
      },
      idRe: MODEL_ID_RE,
    },
    posture: { bypassArgs: ['--dangerously-skip-permissions'] },
    account: { envKey: 'CLAUDE_CONFIG_DIR', bootstrap: null },
    cwdDir: null,
    readOnlyCap: { enforce: 'tool-denylist' },
    instructions: 'append-system-prompt-file',
    transcript: { reader: 'claude', link: 'hook' },
    caps: { park: true, transcript: true, warmth: true },
    ui: {
      injectSkills: true,
      skillRoster: true,
      plugins: true,
      agents: true,
      tools: true,
      strip: true,
      autoCompact: true,
      noWire: true,
      accounts: true,
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    model: { flags: ['--model', '-m'], aliases: {}, idRe: MODEL_ID_RE },
    posture: { bypassArgs: ['--dangerously-bypass-approvals-and-sandbox'] },
    account: { envKey: 'CODEX_HOME', bootstrap: 'codex-home' },
    cwdDir: '.codex',
    readOnlyCap: { enforce: 'argv', args: ['--sandbox', 'read-only', '--ask-for-approval', 'never'] },
    instructions: 'model-instructions-file',
    transcript: { reader: 'codex', link: 'hook' },
    caps: { park: false, transcript: true, warmth: false },
    ui: {
      injectSkills: true,
      skillRoster: false,
      plugins: true,
      agents: false,
      tools: false,
      strip: false,
      autoCompact: false,
      noWire: false,
      accounts: false,
    },
  },
  muse: {
    id: 'muse',
    label: 'Muse Code',
    cmd: 'muse',
    model: { flags: ['--model'], aliases: {}, idRe: MODEL_ID_RE },
    posture: { bypassArgs: ['--approval-mode', 'never', '--disable-sandbox'] },
    account: { envKey: 'XDG_CONFIG_HOME', bootstrap: 'xdg-overlay' },
    cwdDir: null,
    readOnlyCap: {
      enforce: 'settings-profile',
      args: ['--permission-profile', 'reviewer'],
      settings: {
        permissions: {
          schema_version: 1,
          profiles: { reviewer: { extends: ':read-only', approval: 'allow_all', reviewer: 'none', network: { mode: 'enabled' } } },
        },
      },
    },
    instructions: 'user-agents-md',
    transcript: { reader: 'muse', link: 'clodex' },
    caps: { park: false, transcript: true, warmth: false },
    ui: {
      injectSkills: true,
      skillRoster: false,
      plugins: true,
      agents: false,
      tools: false,
      strip: false,
      autoCompact: false,
      noWire: false,
      accounts: false,
    },
  },
};

const PLATFORMS = Object.keys(ADAPTERS);
const DEFAULT_TYPE = 'claude';

const NO_CAPS = Object.freeze(Object.fromEntries(CAP_KEYS.map((k) => [k, false])));

function adapterFor(type) {
  if (typeof type !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(ADAPTERS, type) ? ADAPTERS[type] : null;
}

function isAgentType(type) {
  return adapterFor(type) !== null;
}

function hasBypass(adapter, argv) {
  if (!adapter || !Array.isArray(argv)) return false;
  const want = adapter.posture.bypassArgs;
  if (!want.length || argv.length < want.length) return false;
  for (let i = 0; i + want.length <= argv.length; i += 1) {
    if (want.every((tok, j) => argv[i + j] === tok)) return true;
  }
  return false;
}

function capsFor(type) {
  const a = adapterFor(type);
  return a ? a.ui : NO_CAPS;
}

function seatType(tpl, opener) {
  const t = tpl ? (tpl.type || DEFAULT_TYPE) : ((opener && opener.type) || DEFAULT_TYPE);
  if (!adapterFor(t)) throw new Error(`unknown seat type "${String(t)}" (known: ${PLATFORMS.join(', ')})`);
  return t;
}

function resolveModelId(type, v) {
  const a = adapterFor(type);
  if (!a) return null;
  if (typeof v !== 'string' || !v) return null;
  if (Object.prototype.hasOwnProperty.call(a.model.aliases, v)) return a.model.aliases[v];
  return a.model.idRe.test(v) ? v : null;
}

function stripModelArgs(type, extraArgs) {
  const a = adapterFor(type);
  const flags = a ? a.model.flags : [];
  const rest = [];
  const src = Array.isArray(extraArgs) ? extraArgs : [];
  for (let i = 0; i < src.length; i += 1) {
    const tok = src[i];
    if (flags.includes(tok)) { i += 1; continue; }
    if (typeof tok === 'string' && flags.some((f) => f.startsWith('--') && tok.startsWith(f + '='))) continue;
    rest.push(tok);
  }
  return rest;
}

module.exports = {
  ADAPTERS, PLATFORMS, DEFAULT_TYPE, CAP_KEYS,
  adapterFor, isAgentType, capsFor, seatType, resolveModelId, stripModelArgs, hasBypass,
};
