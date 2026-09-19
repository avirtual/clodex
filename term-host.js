'use strict';

const SHELL_NAMES = ['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish'];

const MOSH_EXCLUDED_REASON = 'mosh cannot carry terminal marks; use ssh for agent-driven commands';

const COMPOUND_RE = /[;|&<>`]|\$\(/;

const SSH_ARG_OPTS = 'bcDEeFIiJLlmOoPpQRSWw';
const SSH_FLAG_OPTS = '1246AaCfgGkKMNnqsTtVvXxYy';

const SSH_NO_SHELL_OPTS = 'NWTnf';

function basename(word) {
  const s = String(word || '');
  const cut = s.lastIndexOf('/');
  return cut === -1 ? s : s.slice(cut + 1);
}

function isShellName(word) {
  return SHELL_NAMES.includes(basename(word));
}

function tokenize(line) {
  const s = String(line == null ? '' : line);
  const words = [];
  let cur = '';
  let started = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') {
      if (started) { words.push(cur); cur = ''; started = false; }
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') return null;
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += s.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let inner = '';
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\' && j + 1 < s.length) { inner += s[j + 1]; j += 2; continue; }
        if (s[j] === '"') { closed = true; j += 1; break; }
        if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) return null;
        inner += s[j];
        j += 1;
      }
      if (!closed) return null;
      cur += inner;
      started = true;
      i = j;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= s.length) return null;
      cur += s[i + 1];
      started = true;
      i += 2;
      continue;
    }
    if (COMPOUND_RE.test(ch === '$' ? s.slice(i, i + 2) : ch)) return null;
    cur += ch;
    started = true;
    i += 1;
  }
  if (started) words.push(cur);
  return words;
}

const PREFIX_WORDS = ['env', 'nohup', 'exec', 'command'];

function stripPrefixes(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    if (PREFIX_WORDS.includes(basename(w))) { i += 1; continue; }
    break;
  }
  return words.slice(i);
}

function sshHost(argv) {
  let host = '';
  let i = 1;
  while (i < argv.length) {
    const w = argv[i];
    if (w === '--') { i += 1; break; }
    if (w.length > 1 && w[0] === '-') {
      let j = 1;
      let consumed = false;
      while (j < w.length) {
        const c = w[j];
        if (SSH_NO_SHELL_OPTS.includes(c)) return null;
        if (SSH_ARG_OPTS.includes(c)) {
          if (j + 1 === w.length) consumed = true;
          j = w.length;
          break;
        }
        if (!SSH_FLAG_OPTS.includes(c)) return null;
        j += 1;
      }
      if (consumed) i += 1;
      i += 1;
      continue;
    }
    host = w;
    i += 1;
    break;
  }
  if (!host) {
    if (i >= argv.length) return null;
    host = argv[i];
    i += 1;
  }
  const rest = argv.slice(i);
  if (rest.length === 0) return host;
  if (isShellName(rest[0]) && bareShell(rest) !== null) return host;
  return null;
}

function suRecognised(argv) {
  const positionals = [];
  for (let i = 1; i < argv.length; i += 1) {
    const w = argv[i];
    if (w === '-c' || w === '--command' || w.startsWith('--command=')) return null;
    if (w === '-' || w === '-l' || w === '--login') continue;
    if (w.startsWith('-')) return null;
    positionals.push(w);
  }
  if (positionals.length > 1) return null;
  return positionals[0] || 'root';
}

function sudoRecognised(argv) {
  let loginFlag = false;
  for (let i = 1; i < argv.length; i += 1) {
    const w = argv[i];
    if (w === '-i' || w === '--login' || w === '-s' || w === '--shell') { loginFlag = true; continue; }
    if (w.startsWith('-')) continue;
    const rest = argv.slice(i);
    if (isShellName(w)) return bareShell(rest) === null ? null : 'root';
    if (basename(w) === 'su') return suRecognised(rest) === null ? null : 'root';
    return null;
  }
  return loginFlag ? 'root' : null;
}

function containerShell(argv, { sub, wantTty }) {
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) i += 1;
  if (i >= argv.length || !sub.includes(argv[i])) return null;
  i += 1;
  let interactive = false;
  let tty = false;
  const positionals = [];
  for (; i < argv.length; i += 1) {
    const w = argv[i];
    if (w === '--interactive') { interactive = true; continue; }
    if (w === '--tty') { tty = true; continue; }
    if (w.length > 1 && w[0] === '-' && w[1] !== '-') {
      if (w.includes('i')) interactive = true;
      if (w.includes('t')) tty = true;
      continue;
    }
    if (w.startsWith('--')) continue;
    positionals.push(w);
  }
  if (wantTty && !(interactive && tty)) return null;
  if (positionals.length !== 2) return null;
  if (!isShellName(positionals[1])) return null;
  return positionals[0];
}

const KUBECTL_ARG_OPTS = ['-n', '-c', '--namespace', '--container', '--context', '--cluster', '--user', '--kubeconfig'];

function kubectlShell(argv) {
  const dash = argv.indexOf('--');
  if (dash === -1) return null;
  const head = argv.slice(0, dash);
  const tail = argv.slice(dash + 1);
  if (tail.length !== 1 || !isShellName(tail[0])) return null;
  let i = 1;
  while (i < head.length && head[i].startsWith('-')) i += 1;
  if (head[i] !== 'exec') return null;
  let interactive = false;
  let tty = false;
  const positionals = [];
  for (let j = i + 1; j < head.length; j += 1) {
    const w = head[j];
    if (w === '--stdin') { interactive = true; continue; }
    if (w === '--tty') { tty = true; continue; }
    if (KUBECTL_ARG_OPTS.includes(w)) { j += 1; continue; }
    if (w.length > 1 && w[0] === '-' && w[1] !== '-') {
      if (w.includes('i')) interactive = true;
      if (w.includes('t')) tty = true;
      continue;
    }
    if (w.startsWith('--')) continue;
    positionals.push(w);
  }
  if (!(interactive && tty)) return null;
  if (positionals.length !== 1) return null;
  return positionals[0];
}

function lxcShell(argv) {
  const dash = argv.indexOf('--');
  if (dash === -1) return null;
  const tail = argv.slice(dash + 1);
  if (tail.length !== 1 || !isShellName(tail[0])) return null;
  const head = argv.slice(0, dash);
  let i = 1;
  while (i < head.length && head[i].startsWith('-')) i += 1;
  if (head[i] !== 'exec') return null;
  const positionals = head.slice(i + 1).filter((w) => !w.startsWith('-'));
  if (positionals.length !== 1) return null;
  return positionals[0];
}

function chrootShell(argv) {
  const positionals = argv.slice(1).filter((w) => !w.startsWith('-'));
  if (positionals.length !== 2) return null;
  if (!isShellName(positionals[1])) return null;
  return positionals[0];
}

const NSENTER_ARG_OPTS = ['-t', '--target', '-S', '--setuid', '-G', '--setgid', '-w', '--wd'];

function nsenterShell(argv) {
  let target = '';
  const positionals = [];
  for (let i = 1; i < argv.length; i += 1) {
    const w = argv[i];
    if (NSENTER_ARG_OPTS.includes(w)) {
      if (w === '-t' || w === '--target') target = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (w.startsWith('--target=')) { target = w.slice('--target='.length); continue; }
    if (w.startsWith('-')) continue;
    positionals.push(w);
  }
  if (positionals.length !== 1 || !isShellName(positionals[0])) return null;
  return target || positionals[0];
}

function bareShell(argv) {
  for (let i = 1; i < argv.length; i += 1) {
    const w = argv[i];
    if (w === '-c') return null;
    if (w.startsWith('-')) continue;
    return null;
  }
  return '';
}

const HOST_TABLE = [
  {
    program: 'ssh',
    match: (argv) => {
      const host = sshHost(argv);
      return host === null ? null : `ssh ${host}`;
    },
  },
  {
    program: 'su',
    match: (argv) => {
      const user = suRecognised(argv);
      return user === null ? null : `su ${user}`;
    },
  },
  {
    program: 'sudo',
    match: (argv) => (sudoRecognised(argv) === null ? null : 'sudo'),
  },
  {
    program: 'doas',
    match: (argv) => (sudoRecognised(argv) === null ? null : 'doas'),
  },
  {
    program: 'docker',
    match: (argv) => {
      const c = containerShell(argv, { sub: ['exec', 'run'], wantTty: true });
      return c === null ? null : `docker ${c}`;
    },
  },
  {
    program: 'podman',
    match: (argv) => {
      const c = containerShell(argv, { sub: ['exec', 'run'], wantTty: true });
      return c === null ? null : `podman ${c}`;
    },
  },
  {
    program: 'nerdctl',
    match: (argv) => {
      const c = containerShell(argv, { sub: ['exec', 'run'], wantTty: true });
      return c === null ? null : `nerdctl ${c}`;
    },
  },
  {
    program: 'kubectl',
    match: (argv) => {
      const pod = kubectlShell(argv);
      return pod === null ? null : `kubectl ${pod}`;
    },
  },
  {
    program: 'oc',
    match: (argv) => {
      const pod = kubectlShell(argv);
      return pod === null ? null : `oc ${pod}`;
    },
  },
  {
    program: 'lxc',
    match: (argv) => {
      const c = lxcShell(argv);
      return c === null ? null : `lxc ${c}`;
    },
  },
  {
    program: 'incus',
    match: (argv) => {
      const c = lxcShell(argv);
      return c === null ? null : `incus ${c}`;
    },
  },
  {
    program: 'chroot',
    match: (argv) => {
      const root = chrootShell(argv);
      return root === null ? null : `chroot ${root}`;
    },
  },
  {
    program: 'nsenter',
    match: (argv) => {
      const target = nsenterShell(argv);
      return target === null ? null : `nsenter ${target}`;
    },
  },
  { program: 'sh', match: (argv) => (bareShell(argv) === null ? null : 'sh') },
  { program: 'bash', match: (argv) => (bareShell(argv) === null ? null : 'bash') },
  { program: 'zsh', match: (argv) => (bareShell(argv) === null ? null : 'zsh') },
  { program: 'dash', match: (argv) => (bareShell(argv) === null ? null : 'dash') },
  { program: 'ash', match: (argv) => (bareShell(argv) === null ? null : 'ash') },
  { program: 'ksh', match: (argv) => (bareShell(argv) === null ? null : 'ksh') },
  { program: 'fish', match: (argv) => (bareShell(argv) === null ? null : 'fish') },
];

function programOf(commandText) {
  const words = tokenize(commandText);
  if (!words || words.length === 0) return null;
  const argv = stripPrefixes(words);
  if (argv.length === 0) return null;
  return basename(argv[0]);
}

function shellHostOf(commandText) {
  const words = tokenize(commandText);
  if (!words || words.length === 0) return null;
  const argv = stripPrefixes(words);
  if (argv.length === 0) return null;
  const program = basename(argv[0]);
  const row = HOST_TABLE.find((r) => r.program === program);
  if (!row) return null;
  const host = row.match(argv);
  if (host === null) return null;
  return { host, shell: 'posix' };
}

module.exports = {
  shellHostOf,
  programOf,
  tokenize,
  isShellName,
  HOST_TABLE,
  SHELL_NAMES,
  MOSH_EXCLUDED_REASON,
};
