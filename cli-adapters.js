'use strict';

const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,63}(?:\[[a-z0-9]{1,8}\])?$/;

const META_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const CAP_KEYS = ['injectSkills', 'skillRoster', 'plugins', 'agents', 'tools', 'strip', 'autoCompact', 'noWire', 'accounts', 'streamIo'];

const CLAUDE_MODEL_ALIASES = Object.freeze({
  opus: 'claude-opus-5-5[1m]',
  sonnet: 'claude-sonnet-5-5[1m]',
  haiku: 'claude-haiku-5-5[1m]',
  fable: 'claude-fable-5-1[1m]',
});

const ADAPTERS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    cmd: 'claude',
    model: { flags: ['--model'], aliases: CLAUDE_MODEL_ALIASES, idRe: MODEL_ID_RE },
    effort: { values: ['low', 'medium', 'high', 'xhigh', 'max'], apply: 'settings' },
    posture: { bypassArgs: ['--dangerously-skip-permissions'], bypass: [['--dangerously-skip-permissions']] },
    account: { envKey: 'CLAUDE_CONFIG_DIR', bootstrap: null, defaultDir: null },
    cwdDir: null,
    readOnlyCap: { enforce: 'tool-denylist' },
    seatSettings: null,
    skills: null,
    instructions: 'append-system-prompt-file',
    transcript: { reader: 'claude', link: 'hook' },
    caps: { park: true, transcript: true, warmth: true, claudeHooks: true },
    stream: {
      codec: 'stream-codec-claude',
      argv: ({ resumeId, sessionId, fork }) => [
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        ...(resumeId ? ['--resume', resumeId, ...(fork ? ['--fork-session'] : [])] : ['--session-id', sessionId]),
        '--permission-prompt-tool', 'stdio',
      ],
      toolBoundary: 'hook',
      transcriptRepoint: 'claude',
    },
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
      streamIo: true,
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    model: { flags: ['--model', '-m'], aliases: {}, idRe: MODEL_ID_RE },
    effort: { values: [...META_EFFORTS], apply: 'config' },
    posture: { bypassArgs: ['--dangerously-bypass-approvals-and-sandbox'], bypass: [['--dangerously-bypass-approvals-and-sandbox']] },
    account: { envKey: 'CODEX_HOME', bootstrap: 'codex-home', defaultDir: null },
    cwdDir: '.codex',
    readOnlyCap: { enforce: 'argv', args: ['--sandbox', 'read-only', '--ask-for-approval', 'never'], shortFlags: { '-s': '--sandbox', '-a': '--ask-for-approval' } },
    seatSettings: null,
    skills: null,
    instructions: 'model-instructions-file',
    transcript: { reader: 'codex', link: 'clodex' },
    caps: { park: false, transcript: true, warmth: false, claudeHooks: false },
    stream: {
      codec: 'stream-codec-codex',
      argv: () => ['app-server'],
      toolBoundary: 'hook',
      transcriptRepoint: 'record',
    },
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
      streamIo: true,
    },
  },
  muse: {
    id: 'muse',
    label: 'Muse Code',
    cmd: 'muse',
    model: { flags: ['--model'], aliases: {}, idRe: MODEL_ID_RE },
    effort: { values: [...META_EFFORTS], apply: 'flag' },
    posture: { bypassArgs: ['--approval-mode', 'never', '--disable-sandbox'], bypass: [['--approval-mode', 'never'], ['--disable-sandbox']] },
    account: { envKey: 'XDG_CONFIG_HOME', bootstrap: 'xdg-overlay', defaultDir: null },
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
    seatSettings: {
      run: {
        workflow_trigger_mode: 'off',
        reminder_roster: { agents: [] },
        context_slimming: { excluded_tool_names: ['workflow', 'request_user_input'] },
      },
    },
    skills: {
      list: {
        args: ['skills', 'list', '--json'],
        env: 'XDG_CONFIG_HOME',
        scratchEnv: 'XDG_DATA_HOME',
        extraEnv: { MUSE_NO_AUTO_UPDATE: '1' },
      },
      activation: { key: 'skills.activation', off: 'off' },
    },
    instructions: 'user-agents-md',
    transcript: { reader: 'muse', link: 'clodex' },
    caps: { park: false, transcript: true, warmth: false, claudeHooks: false },
    stream: {
      codec: 'stream-codec-muse',
      argv: ({ bypass = false, readOnly = false } = {}) => [
        'serve', '--trust-workspace',
        ...(bypass ? ['--disable-sandbox'] : (readOnly ? ['--disable-write', '--disable-shell'] : [])),
      ],
      toolBoundary: 'hook',
      transcriptRepoint: 'record',
    },
    ui: {
      injectSkills: true,
      skillRoster: true,
      plugins: true,
      agents: false,
      tools: false,
      strip: false,
      autoCompact: false,
      noWire: false,
      accounts: false,
      streamIo: true,
    },
  },
  clodent: {
    id: 'clodent',
    label: 'clodent',
    cmd: 'clodent',
    model: { flags: ['--model'], aliases: CLAUDE_MODEL_ALIASES, idRe: MODEL_ID_RE },
    effort: { values: ['low', 'medium', 'high', 'xhigh', 'max'], apply: 'flag' },
    posture: { bypassArgs: ['--dangerously-skip-permissions'], bypass: [['--dangerously-skip-permissions']], aliases: ['--yolo'] },
    account: { envKey: 'CLODENT_HOME', bootstrap: null, defaultDir: '.clodent' },
    cwdDir: null,
    readOnlyCap: { enforce: 'argv', args: ['--permission-mode', 'plan'], aliases: ['--read-only'], note: 'read-only (clodent plan mode: permission rules and a Bash path guard, not an OS sandbox)' },
    seatSettings: null,
    skills: null,
    instructions: 'append-system-prompt-file',
    transcript: { reader: 'claude', link: 'hook' },
    caps: { park: false, transcript: true, warmth: false, claudeHooks: true },
    stream: null,
    ui: {
      injectSkills: false,
      skillRoster: false,
      plugins: false,
      agents: false,
      tools: false,
      strip: false,
      autoCompact: false,
      noWire: false,
      accounts: false,
      streamIo: false,
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

function normalizeArgv(argv, short) {
  const norm = [];
  for (const tok of argv) {
    if (typeof tok !== 'string') { norm.push(tok); continue; }
    const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
    if (eq > 2) norm.push(tok.slice(0, eq), tok.slice(eq + 1));
    else if (tok.length > 2 && tok[0] === '-' && tok[1] !== '-' && Object.prototype.hasOwnProperty.call(short, tok.slice(0, 2))) norm.push(short[tok.slice(0, 2)], tok[2] === '=' ? tok.slice(3) : tok.slice(2));
    else norm.push(Object.prototype.hasOwnProperty.call(short, tok) ? short[tok] : tok);
  }
  return norm;
}

function lastValueOf(norm, flag) {
  let value;
  for (let i = 0; i + 1 < norm.length; i += 1) {
    if (norm[i] === flag) { value = norm[i + 1]; i += 1; }
  }
  return value;
}

function hasBypass(adapter, argv) {
  const want = adapter && adapter.posture && adapter.posture.bypass;
  if (!Array.isArray(want) || want.length === 0 || !Array.isArray(argv)) return false;
  if (Array.isArray(adapter.posture.aliases) && adapter.posture.aliases.some((a) => argv.includes(a))) return true;
  const norm = normalizeArgv(argv, {});
  return want.every((opt) => (opt.length === 1 ? argv.includes(opt[0]) : lastValueOf(norm, opt[0]) === opt[1]));
}

function hasReadOnlyCap(adapter, argv) {
  const cap = adapter && adapter.readOnlyCap && adapter.readOnlyCap.args;
  const aliases = adapter && adapter.readOnlyCap && adapter.readOnlyCap.aliases;
  if (Array.isArray(aliases) && Array.isArray(argv) && aliases.some((a) => argv.includes(a))) return true;
  if (!Array.isArray(cap) || cap.length === 0 || cap.length % 2 !== 0 || !Array.isArray(argv)) return false;
  const norm = normalizeArgv(argv, adapter.readOnlyCap.shortFlags || {});
  for (let c = 0; c < cap.length; c += 2) {
    if (lastValueOf(norm, cap[c]) !== cap[c + 1]) return false;
  }
  return true;
}

function postureOf(adapter, argv) {
  if (!adapter || !Array.isArray(argv)) return 'default';
  if (hasBypass(adapter, argv)) return 'bypass';
  if (hasReadOnlyCap(adapter, argv)) return 'read-only';
  return 'default';
}

function runsClaudeHooks(type) {
  const a = adapterFor(type);
  return !!(a && a.caps.claudeHooks);
}

function capsFor(type) {
  const a = adapterFor(type);
  return a ? a.ui : NO_CAPS;
}

function streamFor(type) {
  const a = adapterFor(type);
  return a && a.stream ? a.stream : null;
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

function resolveEffort(type, v) {
  if (v == null || v === '' || v === 'default') return null;
  const a = adapterFor(type);
  if (!a || !a.effort) return { error: `seat type "${String(type)}" takes no effort level` };
  if (typeof v === 'string' && a.effort.values.includes(v)) return v;
  return { error: `effort "${String(v)}" is not one of ${a.effort.values.join(', ')} (${a.label}), or default` };
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
    if (typeof tok === 'string' && flags.some((f) => /^-[^-]$/.test(f) && tok.startsWith(f) && tok.length > f.length)) continue;
    rest.push(tok);
  }
  return rest;
}

const PRIVILEGED_FLAG_ARITY = {
  '--settings': 1, '--permission-mode': 1, '--mcp-config': Infinity, '--add-dir': Infinity,
  '--sandbox': 1, '-s': 1, '--ask-for-approval': 1, '-a': 1, '--config': 1, '-c': 1, '--full-auto': 0, '--yolo': 0,
  '--profile': 1, '-p': 1, '--sandbox-network': 1, '--permission-profile': 1,
  '--agents': 1, '--plugin-dir': 1, '--enable': 1, '--dangerously-bypass-hook-trust': 0,
  '--disable-approval': 0, '--trust-workspace': 0, '--approval-judge': 1,
  '--allowedTools': Infinity, '--allowed-tools': Infinity, '--disallowedTools': Infinity, '--disallowed-tools': Infinity,
  ...Object.fromEntries(Object.values(ADAPTERS).flatMap((a) => a.posture.bypass.map((opt) => [opt[0], opt.length - 1]))),
};

const PRIVILEGED_FLAG_ALIAS = {
  ...ADAPTERS.codex.readOnlyCap.shortFlags,
  '-c': '--config', '-p': '--profile', '--allowed-tools': '--allowedTools', '--disallowed-tools': '--disallowedTools',
};

function privilegedFlagOf(tok) {
  if (typeof tok !== 'string') return null;
  if (tok.startsWith('--')) {
    const eq = tok.indexOf('=');
    return { name: eq < 0 ? tok : tok.slice(0, eq), inline: eq < 0 ? null : tok.slice(eq + 1) };
  }
  const short = tok.slice(0, 2);
  if (!/^-[^-]$/.test(short) || !Object.prototype.hasOwnProperty.call(PRIVILEGED_FLAG_ALIAS, short)) return null;
  return { name: short, inline: tok.length > 2 ? tok.slice(2).replace(/^=/, '') : null };
}

function splitPrivilegedArgs(argv) {
  const kept = [];
  const privileged = [];
  const flags = [];
  const pairs = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const tok = list[i];
    const parsed = privilegedFlagOf(tok);
    if (!parsed || !Object.prototype.hasOwnProperty.call(PRIVILEGED_FLAG_ARITY, parsed.name)) { kept.push(tok); continue; }
    const name = PRIVILEGED_FLAG_ALIAS[parsed.name] || parsed.name;
    if (!flags.includes(name)) flags.push(name);
    privileged.push(tok);
    if (parsed.inline !== null) { pairs.push([name, parsed.inline]); continue; }
    let left = PRIVILEGED_FLAG_ARITY[parsed.name];
    let took = 0;
    while (left > 0 && i + 1 < list.length && !(typeof list[i + 1] === 'string' && list[i + 1].startsWith('-'))) {
      privileged.push(list[i + 1]);
      pairs.push([name, list[i + 1]]);
      i += 1;
      left -= 1;
      took += 1;
    }
    if (!took) pairs.push([name, null]);
  }
  return { kept, privileged, flags, pairs };
}

module.exports = {
  ADAPTERS, PLATFORMS, DEFAULT_TYPE, CAP_KEYS,
  adapterFor, isAgentType, capsFor, runsClaudeHooks, streamFor, seatType, resolveModelId, resolveEffort, stripModelArgs, hasBypass, hasReadOnlyCap, postureOf,
  PRIVILEGED_FLAG_ARITY, splitPrivilegedArgs,
};
