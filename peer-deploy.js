// Peer-deploy helpers: the pure classification + parsing layer the deploy
// wizard drives. Two jobs, both testable without a live ssh:
//   probePeer   — is there a Clodex on this box, and what version/caps?
//   parseDeployLine — turn one line of clodex-deploy.sh's ::marker stream into
//                     a structured event the wizard renders as a step list.
//
// The probe deliberately needs NO tunnel: it ssh's in and curls hello ON the
// box (127.0.0.1:<port>), so it cleanly separates "ssh broken" from "ssh fine
// but no Clodex" from "Clodex vX with these caps" — and the curl doubles as the
// deploy's own preflight. See ssh-run.js for the transport.

'use strict';

const { sshRun, SSH_EXIT } = require('./ssh-run');

// Sentinels the on-box probe script echoes so the classifier never has to guess
// from curl's own noisy output. NOLISTEN = curl couldn't connect (no server);
// BODY = curl got a response, whose text follows for JSON classification;
// CODE = the HTTP status curl saw (via -w), so a 401/403 auth gate is told apart
// from a genuine "nothing there".
const PROBE_NOLISTEN = 'CLODEX_PROBE_NOLISTEN';
const PROBE_BODY = 'CLODEX_PROBE_BODY ';
const PROBE_CODE = 'CLODEX_PROBE_CODE ';

// The tiny script run on the box. Deliberately DROPS curl's -f: with -f, ANY
// HTTP error (a 401 from a token-protected Clodex included) makes curl exit
// non-zero and look identical to connect-refused. Without -f, curl exits
// non-zero ONLY on a real connect failure / timeout — so NOLISTEN stays
// truthful — while an HTTP response (200 hello OR a 401/403 auth gate) comes
// back exit 0 with the status recovered via -w. -sS silences progress but keeps
// errors; -m bounds it.
//
// When a token is supplied it's sent as `Authorization: Bearer` — but the token
// bytes must NEVER reach curl's argv (ps-visible on the box). printf is a bash
// builtin (no argv), so it writes the header to a umask-077 temp file that curl
// reads with `-H @file` and we rm immediately. The token is single-quote-escaped
// so a quote in it can't break out of the printf argument.
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

// Classify a peer box. Returns one of:
//   { kind: 'ssh-fail', stderr }              ssh couldn't connect/auth/timed out
//   { kind: 'no-listener' }                    ssh ok, nothing answering on <port>
//   { kind: 'auth-required', tokenSent, status } something answered but the wire
//                                              is token-gated (HTTP 401/403);
//                                              tokenSent = we sent a token and it
//                                              was rejected (else none was tried)
//   { kind: 'not-clodex' }                     something answered, but not a Clodex hello
//   { kind: 'hello-ok', version, caps, host, platform }
// sshRun is injectable for tests; token (optional) is sent as Bearer auth.
async function probePeer(sshHost, port, { sshRun: run = sshRun, timeoutMs = 15000, token = null } = {}) {
  const tokenSent = !!token;
  let res;
  try {
    res = await run(sshHost, buildProbeScript(port, token), { timeoutMs });
  } catch (e) {
    // Spawn failure (no ssh binary) — surface as an ssh failure the wizard shows.
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
    // ssh ran but produced neither sentinel — treat as an ssh-layer problem
    // (wrong shell, script didn't execute) rather than silently claim no Clodex.
    return { kind: 'ssh-fail', stderr: lastLine(res.stderr) || `unexpected probe output: ${(res.stdout || '').trim().slice(0, 200)}` };
  }
  // An auth gate (401/403) answered before routing — a live, token-protected
  // Clodex, NOT an empty box. Report it so the wizard points at the token field
  // instead of offering a fresh install over a running peer.
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

// Parse one line of the deploy script's stdout into a structured event. The
// grammar (see clodex-deploy.sh):
//   ::step <name>            a step is starting
//   ::ok <name>              a step succeeded (or was already satisfied)
//   ::fail <name> <reason>   a step failed (script then exits non-zero)
//   ::need-sudo <what>       a sudo step can't run non-interactively
//   ::sudo-cmd <command>     one exact command the user must run (follows need-sudo)
//   ::done                   the whole deploy finished
// Anything else is a { type:'log' } line (surfaced as the stderr/detail tail).
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

// ---------------------------------------------------------------------------
// Agent-fallback helpers: when a deploy ends in a real failure the wizard can
// spin up an ad-hoc Claude session to untangle it. Both are pure so they unit-
// test without Electron; main.js owns the manager.create + spill injection.
// ---------------------------------------------------------------------------

const FIX_NAME_MAX = 64; // mirrors the session-name regex ceiling [a-zA-Z0-9._-]{1,64}

// Name the ad-hoc fix session: sanitize the peer label to a NAME_RE-safe stem,
// prefix `fix-`, and suffix `-2`, `-3`… on collision with an existing session.
// `taken` is a Set (or array) of names already in use.
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

// Build the briefing the fix session reads (delivered via the spill channel, so
// its size is fine — it @-attaches). Names the box, the exact success check, the
// captured deploy log, and points at the playbook + idempotent installer.
//
// The fix session's cwd is the operator's HOMEDIR, not the repo, so relative
// `peering/…` pointers would be dead. When `docsDir` is given (main passes the
// on-disk peering/ dir) we render absolute paths; we ALWAYS also name the GitHub
// repo as the honest backstop — in a packaged app those files live inside
// app.asar, which an external claude CLI can't read.
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
    `HOW TO FIX: read ${readme} (the full manual playbook) and ${script} (the idempotent installer — env params REPO_URL, BRANCH, PORT, CLODEX_SRC). If those paths aren't readable, both live in the peering/ folder of ${repo}. Re-running the script is SAFE and idempotent (re-run = update); it emits ::step/::ok/::fail markers, and when it needs root it can't get, it prints the exact sudo commands and stops. You can ssh ${host} directly to inspect and run steps by hand. Common snags: apt packages needing sudo, Node < 20, the Chromium chrome-sandbox SUID bits, or XDG_RUNTIME_DIR missing for systemctl --user.`,
    ``,
    `When the hello curl returns "app":"clodex", you're done — report back.`,
  ].join('\n');
}

// Single-quote a value for POSIX sh: wrap in '…', and end/escape/reopen any
// embedded quote. Renders any string as one safe literal word.
function shSingleQuote(v) {
  return `'${String(v == null ? '' : v).replace(/'/g, `'\\''`)}'`;
}

// Classify an operator-entered deploy folder and render its CLODEX_SRC export
// token for the deploy preamble. The clone/checkout dir on the box; the deploy
// script defaults CLODEX_SRC to $HOME/wb-wrap-ui, so a blank field ⇒ NO export
// (the script's own default stands — one source of truth). Two accepted forms:
//   `~/sub/dir` → REMOTE-home-relative. We render CLODEX_SRC="$HOME/"'sub/dir':
//     $HOME stays UNQUOTED so the remote shell expands it, the remainder is a
//     single-quoted literal. (A quoted "~" would be a literal tilde dir — the
//     classic footgun this avoids.)
//   `/abs/path` → absolute, single-quoted whole.
// Anything else (a relative path without ~/, or a bare ~) is rejected with an
// inline error — the wizard surfaces it and never deploys. Pure + testable.
// Returns { ok:true, srcExport } (srcExport '' means no override) or
// { ok:false, error }.
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

// Classify one operator-entered peer DESTINATION into ssh vs URL — the wizard
// collapses the old two fields into a single smart input, and a scheme prefix
// makes the two unambiguous (a dropdown would tax the common ssh path). Returns
// one of:
//   { kind: 'ssh',   sshHost }  — user@host / bare host / IP / ssh-config alias
//   { kind: 'url',   url }      — a validated http(s):// direct endpoint
//   { kind: 'empty' }           — blank (skip the row)
//   { kind: 'error', error }    — a targeted message for the common mistakes
// Pure + testable; the settings schema is unchanged (ssh → peer.sshHost, url →
// peer.url), so this only reshapes the input surface, no migration.
function classifyPeerDest(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!s) return { kind: 'empty' };
  // An http(s):// prefix is an explicit "direct URL" — validate the shape.
  if (/^https?:\/\//i.test(s)) {
    try { new URL(s); return { kind: 'url', url: s }; }
    catch { return { kind: 'error', error: "That doesn't look like a valid URL. Example: http://host:7900" }; }
  }
  // Any other scheme (ftp://, ws://, …) is a real mistake — reject it clearly
  // rather than letting it masquerade as an ssh host.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    return { kind: 'error', error: 'Only http:// and https:// URLs are supported for a direct peer.' };
  }
  // ssh destination charset: user@host, bare host, IPv4, or an ~/.ssh/config
  // alias. No colon (a host:port belongs in ssh config), no spaces.
  if (/^[a-zA-Z0-9._@-]{1,128}$/.test(s)) return { kind: 'ssh', sshHost: s };
  // Targeted errors for the misfires the single field invites.
  if (/\s/.test(s) || /^ssh\s/i.test(s)) {
    return { kind: 'error', error: 'Enter just the destination, e.g. user@host — not an ssh command.' };
  }
  if (s.includes(':')) {
    return { kind: 'error', error: 'For a direct URL include http://. For ssh, set the port in ~/.ssh/config, not host:port.' };
  }
  return { kind: 'error', error: "That doesn't look like an ssh host or a URL. Example: user@laptop2" };
}

// Render an absolute path as home-relative for display / self-report: inside
// `home` → `~/rest`, exactly `home` → `~`, outside → unchanged. Trailing
// separators on either side are tolerated (a home of `/Users/x/` still matches
// `/Users/x/proj`). Pure; the owner side calls it on __dirname so a peer reports
// its install dir the way the wizard's folder field expects (~/…).
function homeRelativize(p, home) {
  const path_ = String(p == null ? '' : p).replace(/\/+$/, '');
  const h = String(home == null ? '' : home).replace(/\/+$/, '');
  if (!path_) return path_;
  if (!h) return path_;
  if (path_ === h) return '~';
  if (path_.startsWith(h + '/')) return '~/' + path_.slice(h.length + 1);
  return path_;
}

// The ONE deploy-folder precedence rule, shared by every consumer: a live
// self-reported install dir wins over a persisted deployFolder guess, which wins
// over '' (the caller's default pre-fill). A stale persisted value must never
// shadow live truth — that's the wrong-guess bug this closes. Pure.
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
