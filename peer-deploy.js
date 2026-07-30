
'use strict';

const { sshRun, SSH_EXIT } = require('./ssh-run');

const PROBE_NOLISTEN = 'CLODEX_PROBE_NOLISTEN';
const PROBE_BODY = 'CLODEX_PROBE_BODY ';
const PROBE_CODE = 'CLODEX_PROBE_CODE ';

// curl deliberately omits -f: with -f a 401 from a token-protected Clodex
// exits non-zero and looks identical to connect-refused, so NOLISTEN would
// lie. Without it, non-zero means only a real connect failure / timeout.
// The token must never reach curl's argv (ps-visible on the box): printf is a
// shell builtin, so it writes the Bearer header to a umask-077 temp file that
// curl reads via -H @file.
function buildProbeScript(port, token) {
  const p = String(parseInt(port, 10) || 7900);
  const url = `http://127.0.0.1:${p}/api/peer/hello`;
  const w = `-w '\\n${PROBE_CODE}%{http_code}'`;
  const lines = [];
  let curl;
  if (token) {
    lines.push('umask 077');
    lines.push('__ch=$(mktemp 2>/dev/null || echo "$HOME/.clodex-probe.$$")');
    lines.push(`printf 'Authorization: Bearer %s\\n' ${shSingleQuote(token)} > "$__ch"`);
    curl = `curl -sS -m 5 ${w} -H @"$__ch" "${url}" 2>/dev/null`;
  } else {
    curl = `curl -sS -m 5 ${w} "${url}" 2>/dev/null`;
  }
  lines.push(`__resp=$(${curl})`);
  lines.push('__rc=$?');
  if (token) lines.push('rm -f "$__ch"');
  lines.push(`if [ $__rc -ne 0 ]; then echo "${PROBE_NOLISTEN}"; else echo "${PROBE_BODY}$__resp"; fi`);
  lines.push('');
  return lines.join('\n');
}

async function probePeer(sshHost, port, { sshRun: run = sshRun, timeoutMs = 15000, token = null } = {}) {
  const tokenSent = !!token;
  let res;
  try {
    res = await run(sshHost, buildProbeScript(port, token), { timeoutMs });
  } catch (e) {
    return { kind: 'ssh-fail', stderr: e && e.message ? e.message : 'ssh could not start' };
  }
  if (res.timedOut) return { kind: 'ssh-fail', stderr: 'ssh timed out' };
  // ssh's own failure (unreachable host, rejected key, unknown host) exits 255;
  // the remote probe script always exits 0, so a 255 is unambiguously ssh, not
  // the box's curl.
  if (res.code === SSH_EXIT) {
    return { kind: 'ssh-fail', stderr: lastLine(res.stderr) || 'ssh connection failed' };
  }
  const lines = (res.stdout || '').split('\n').map((l) => l.trim());
  if (lines.some((l) => l === PROBE_NOLISTEN)) return { kind: 'no-listener' };
  const bodyLine = lines.find((l) => l.startsWith(PROBE_BODY.trim()));
  if (bodyLine === undefined) {
    return { kind: 'ssh-fail', stderr: lastLine(res.stderr) || `unexpected probe output: ${(res.stdout || '').trim().slice(0, 200)}` };
  }
  const codeLine = lines.find((l) => l.startsWith(PROBE_CODE.trim()));
  const status = codeLine ? parseInt(codeLine.slice(PROBE_CODE.trim().length).trim(), 10) : NaN;
  if (status === 401 || status === 403) {
    return { kind: 'auth-required', tokenSent, status };
  }
  const body = bodyLine.slice(PROBE_BODY.trim().length).replace(/^\s+/, '');
  let obj;
  try { obj = JSON.parse(body); } catch { return { kind: 'not-clodex' }; }
  if (obj && obj.app === 'clodex') {
    return {
      kind: 'hello-ok',
      version: obj.version || null,
      caps: Array.isArray(obj.caps) ? obj.caps : [],
      host: obj.host || null,
      platform: obj.platform || null,
    };
  }
  return { kind: 'not-clodex' };
}

function lastLine(s) {
  return String(s || '').trim().split('\n').filter(Boolean).pop() || '';
}

function parseDeployLine(rawLine) {
  const line = String(rawLine == null ? '' : rawLine);
  const m = line.match(/^::(\S+)\s?(.*)$/);
  if (!m) return { type: 'log', text: line };
  const rest = m[2];
  switch (m[1]) {
    case 'step': return { type: 'step', name: rest.trim() };
    case 'ok': return { type: 'ok', name: rest.trim() };
    case 'fail': {
      const sp = rest.indexOf(' ');
      const name = (sp >= 0 ? rest.slice(0, sp) : rest).trim();
      const reason = sp >= 0 ? rest.slice(sp + 1).trim() : '';
      return { type: 'fail', name, reason };
    }
    case 'need-sudo': return { type: 'need-sudo', what: rest.trim() };
    case 'sudo-cmd': return { type: 'sudo-cmd', command: rest.trim() };
    case 'done': return { type: 'done' };
    default: return { type: 'log', text: line };
  }
}


// Mirrors the session-name regex ceiling (?!\.+$)[a-zA-Z0-9._-]{1,64}. The
// dot-only half needs no mirroring here: every name minted below is prefixed
// `fix-`, so none can be dots.
const FIX_NAME_MAX = 64;

function fixSessionName(label, taken = new Set()) {
  const has = (n) => (taken instanceof Set ? taken.has(n) : Array.isArray(taken) && taken.includes(n));
  let stem = String(label || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!stem) stem = 'peer';
  const base = `fix-${stem}`.slice(0, FIX_NAME_MAX);
  if (!has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const cand = `fix-${stem}`.slice(0, FIX_NAME_MAX - suffix.length) + suffix;
    if (!has(cand)) return cand;
  }
  return `fix-${Date.now().toString(36)}`.slice(0, FIX_NAME_MAX);
}

// The fix session's cwd is the operator's HOMEDIR, not the repo, so relative
// `peering/…` pointers would be dead — hence absolute paths when docsDir is
// given. The repo URL is always named too: in a packaged app those files live
// inside app.asar, which an external claude CLI cannot read.
function buildDeployFixBriefing({ sshHost, port, label, logText, docsDir } = {}) {
  const host = String(sshHost || 'the box');
  const p = Number.isInteger(port) ? port : 7900;
  const who = label ? ` (peer "${label}")` : '';
  const join = (f) => (docsDir ? `${String(docsDir).replace(/\/+$/, '')}/${f}` : `peering/${f}`);
  const readme = join('README.md');
  const script = join('clodex-deploy.sh');
  const repo = 'https://github.com/avirtual/clodex';
  return [
    `You're an ad-hoc troubleshooting session. A Clodex headless deploy to ${host}${who} just failed and I need you to get it running.`,
    ``,
    `GOAL: Clodex should answer the peer protocol on http://127.0.0.1:${p}/ of ${host}, running as a systemd --user service. Verify with:`,
    `  ssh ${host} 'curl -fsS http://127.0.0.1:${p}/api/peer/hello'`,
    `Success = JSON containing "app":"clodex".`,
    ``,
    `WHAT HAPPENED: the deploy script (${script}) ran over ssh and did not finish. Its progress + error tail:`,
    ``,
    (logText && String(logText).trim()) || '(no log captured)',
    ``,
    `HOW TO FIX: read ${readme} (the full manual playbook) and ${script} (the idempotent installer — env params REPO_URL, BRANCH, PORT, CLODEX_SRC). If those paths aren't readable, both live in the peering/ folder of ${repo}. Re-running the script is SAFE and idempotent (re-run = update); it emits ::step/::ok/::fail markers, and when it needs root it can't get, it prints the exact sudo commands and stops. You can ssh ${host} directly to inspect and run steps by hand. Common snags: system packages needing sudo, Node < 20, the node-pty native rebuild, or XDG_RUNTIME_DIR missing for systemctl --user.`,
    ``,
    `When the hello curl returns "app":"clodex", you're done — report back.`,
  ].join('\n');
}

function shSingleQuote(v) {
  return `'${String(v == null ? '' : v).replace(/'/g, `'\\''`)}'`;
}

// Blank ⇒ NO export, so the deploy script's own default stands (one source of
// truth). For `~/sub`, $HOME is left UNQUOTED so the remote shell expands it
// and only the remainder is single-quoted — a quoted "~" would be a literal
// tilde directory on the box.
function classifyDeployFolder(folder) {
  const f = (folder == null ? '' : String(folder)).trim();
  if (!f) return { ok: true, srcExport: '' };            // blank → script default
  if (f.includes('\0')) return { ok: false, error: 'Folder path contains an invalid character.' };
  if (f === '~' || f === '~/') return { ok: false, error: 'Enter a folder under home, e.g. ~/clodex.' };
  if (f.startsWith('~/')) {
    const rest = f.slice(2).replace(/^\/+/, '');         // strip the ~/ and any extra leading /
    if (!rest) return { ok: false, error: 'Enter a folder under home, e.g. ~/clodex.' };
    return { ok: true, srcExport: `CLODEX_SRC="$HOME/"${shSingleQuote(rest)}` };
  }
  if (f.startsWith('/')) return { ok: true, srcExport: `CLODEX_SRC=${shSingleQuote(f)}` };
  return { ok: false, error: 'Use an absolute path (/…) or a home path (~/…).' };
}

function classifyPeerDest(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!s) return { kind: 'empty' };
  // A bare instance id (`i-0abc…`) is indistinguishable from an ssh alias, so
  // the ssm: prefix is required rather than sniffed.
  if (/^ssm:/i.test(s)) {
    const target = s.slice(4).trim();
    if (!target) return { kind: 'error', error: 'ssm: needs a target — e.g. ssm:i-0abc123def456789 (an instance id or an SSM managed-instance id).' };
    // ECS/Fargate is a CLUSTER/FAMILY spec resolved to a task at CONNECT time
    // (two aws reads). The tunnel supervisor is synchronous today, so say that
    // plainly instead of accepting a destination that would never dial.
    if (target.includes('/')) {
      return { kind: 'error', error: 'ECS/Fargate targets (CLUSTER/FAMILY) are not supported for peers yet — use a plain instance id, or the clodexctl CLI, which resolves ECS at connect time.' };
    }
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(target)) {
      return { kind: 'error', error: "That doesn't look like an SSM target. Example: ssm:i-0abc123def456789" };
    }
    return { kind: 'ssm', ssm: { target } };
  }
  // `k8s:POD_OR_SVC` — kubectl port-forward. The target keeps kubectl's own
  // `svc/name` / `pod/name` spelling verbatim (a slash is EXPECTED here, unlike
  // ssm's), so what the operator types is what kubectl receives. namespace and
  // context have no syntax: they are settings-file-only, like ssm's region.
  if (/^k8s:/i.test(s)) {
    const target = s.slice(4).trim();
    if (!target) return { kind: 'error', error: 'k8s: needs a pod or service — e.g. k8s:svc/clodex or k8s:pod/clodex-0.' };
    if (!/^[a-zA-Z0-9._\/-]{1,253}$/.test(target)) {
      return { kind: 'error', error: "That doesn't look like a kubectl target. Example: k8s:svc/clodex" };
    }
    return { kind: 'kubectl', kubectl: { target } };
  }
  if (/^gcp:/i.test(s)) {
    const instance = s.slice(4).trim();
    if (!instance) return { kind: 'error', error: 'gcp: needs an instance name — e.g. gcp:clodex-box (add zone/project in settings if needed).' };
    if (!/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(instance)) {
      return { kind: 'error', error: "That doesn't look like a Compute instance name (lowercase letters, digits and hyphens). Example: gcp:clodex-box" };
    }
    return { kind: 'gcloud', gcloud: { instance } };
  }
  if (/^https?:\/\//i.test(s)) {
    try { new URL(s); return { kind: 'url', url: s }; }
    catch { return { kind: 'error', error: "That doesn't look like a valid URL. Example: http://host:7900" }; }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    return { kind: 'error', error: 'Only http:// and https:// URLs are supported for a direct peer.' };
  }
  if (/^[a-zA-Z0-9._@-]{1,128}$/.test(s)) return { kind: 'ssh', sshHost: s };
  if (/\s/.test(s) || /^ssh\s/i.test(s)) {
    return { kind: 'error', error: 'Enter just the destination, e.g. user@host — not an ssh command.' };
  }
  if (s.includes(':')) {
    return { kind: 'error', error: 'For a direct URL include http://. For ssh, set the port in ~/.ssh/config, not host:port.' };
  }
  return { kind: 'error', error: "That doesn't look like an ssh host or a URL. Example: user@laptop2" };
}

function homeRelativize(p, home) {
  const path_ = String(p == null ? '' : p).replace(/\/+$/, '');
  const h = String(home == null ? '' : home).replace(/\/+$/, '');
  if (!path_) return path_;
  if (!h) return path_;
  if (path_ === h) return '~';
  if (path_.startsWith(h + '/')) return '~/' + path_.slice(h.length + 1);
  return path_;
}

function resolveDeployFolder(reported, persisted) {
  const r = typeof reported === 'string' ? reported.trim() : '';
  if (r) return r;
  const p = typeof persisted === 'string' ? persisted.trim() : '';
  if (p) return p;
  return '';
}

module.exports = {
  probePeer, buildProbeScript, parseDeployLine,
  fixSessionName, buildDeployFixBriefing,
  classifyDeployFolder, shSingleQuote, classifyPeerDest,
  homeRelativize, resolveDeployFolder,
  PROBE_NOLISTEN, PROBE_BODY, PROBE_CODE,
};
