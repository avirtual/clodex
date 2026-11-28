'use strict';

const crypto = require('crypto');

const BOX_ARGS_MAX = 32;
const BOX_ARG_MAX = 512;
const BOX_ARGS_LABEL_RE = /^[A-Za-z0-9._-]{1,32}$/;
const FINGERPRINT_RE = /^[0-9a-f]{12}$/;
const BOX_ARGS_FAILED = 'the runner owner\'s box options failed to start the box';
const RESERVED_LONG = [
  '--name', '--rm', '--detach', '--entrypoint', '--cidfile', '--interactive', '--tty', '--restart',
  '--workdir', '--platform', '--pull', '--init', '--log-driver', '--log-opt', '--label', '--label-file',
];
const RESERVED_SHORT = { d: '--detach', i: '--interactive', t: '--tty', w: '--workdir', l: '--label' };
const BARE_LONG = [
  '--privileged', '--read-only', '--oom-kill-disable', '--no-healthcheck', '--publish-all',
  '--sig-proxy', '--disable-content-trust', '--quiet',
];
const BARE_SHORT = ['P', 'q'];
const ATTACH = 'needs its value attached with = (for example --device=/dev/dri)';

function shortRefusal(body) {
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (RESERVED_SHORT[c]) return `-${c} (${RESERVED_SHORT[c]}) is reserved by Clodex`;
    if (BARE_SHORT.includes(c) && body[i + 1] !== '=') continue;
    if (BARE_SHORT.includes(c)) return null;
    return body.slice(i + 1).replace(/^=/, '') ? null : `-${c} ${ATTACH}`;
  }
  return null;
}

function boxArgRefusal(arg) {
  if (typeof arg !== 'string' || !arg.length || arg.length > BOX_ARG_MAX) return `must be text of 1 to ${BOX_ARG_MAX} characters`;
  if (/[\0\r\n]/.test(arg)) return 'must not contain a NUL or a line break';
  if (!arg.startsWith('-') || arg === '-') return 'must be an option starting with - (a bare word would end Docker\'s options and replace the image)';
  if (arg === '--') return '-- would end Docker\'s options';
  if (!arg.startsWith('--')) return shortRefusal(arg.slice(1));
  const eq = arg.indexOf('=');
  const name = eq < 0 ? arg : arg.slice(0, eq);
  if (RESERVED_LONG.includes(name)) return `${name} is reserved by Clodex`;
  if (eq < 0 && !BARE_LONG.includes(name)) return `${name} ${ATTACH}`;
  return null;
}

function boxArgsRefusal(list) {
  if (!Array.isArray(list)) return 'box options must be a list';
  if (list.length > BOX_ARGS_MAX) return `at most ${BOX_ARGS_MAX} box options, not ${list.length}`;
  for (let i = 0; i < list.length; i += 1) {
    const why = boxArgRefusal(list[i]);
    if (why) return `box option ${i + 1} ${why}`;
  }
  return null;
}

function boxArgsLabelRefusal(label) {
  if (label == null || label === '') return null;
  if (typeof label !== 'string' || !BOX_ARGS_LABEL_RE.test(label)) return 'the box options label must be at most 32 letters, digits, dot, dash or underscore';
  return null;
}

function boxArgsFingerprint(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 12);
}

function boxCustom(list, label = null) {
  const fingerprint = boxArgsFingerprint(list);
  if (!fingerprint) return null;
  return { fingerprint, label: typeof label === 'string' && BOX_ARGS_LABEL_RE.test(label) ? label : null };
}

function cleanCustom(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !FINGERPRINT_RE.test(String(raw.fingerprint))) return null;
  return { fingerprint: raw.fingerprint, label: typeof raw.label === 'string' && BOX_ARGS_LABEL_RE.test(raw.label) ? raw.label : null };
}

const customField = (raw) => {
  const custom = cleanCustom(raw);
  return custom ? { custom } : {};
};

const customName = (custom) => (custom ? custom.label || custom.fingerprint : null);

module.exports = {
  BOX_ARGS_MAX, BOX_ARG_MAX, BOX_ARGS_FAILED, boxArgRefusal, boxArgsRefusal, boxArgsLabelRefusal, boxArgsFingerprint, boxCustom, cleanCustom, customField, customName,
};
