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
// BODY = curl got a response, whose text follows for JSON classification.
const PROBE_NOLISTEN = 'CLODEX_PROBE_NOLISTEN';
const PROBE_BODY = 'CLODEX_PROBE_BODY ';

// The tiny script run on the box. curl -fsS: fail (non-zero) on HTTP errors,
// silent progress, but show errors; -m bounds it. On connect failure we emit
// the NOLISTEN sentinel (curl exit is the classifier's job on THIS side is
// avoided — the sentinel is unambiguous). On success we emit BODY + the raw
// response for JSON parsing off-box.
function buildProbeScript(port) {
  const p = String(parseInt(port, 10) || 7900);
  return [
    `body=$(curl -fsS -m 5 "http://127.0.0.1:${p}/api/peer/hello" 2>/dev/null)`,
    `if [ $? -ne 0 ]; then echo "${PROBE_NOLISTEN}"; else echo "${PROBE_BODY}$body"; fi`,
    '',
  ].join('\n');
}

// Classify a peer box. Returns one of:
//   { kind: 'ssh-fail', stderr }              ssh couldn't connect/auth/timed out
//   { kind: 'no-listener' }                    ssh ok, nothing answering on <port>
//   { kind: 'not-clodex' }                     something answered, but not a Clodex hello
//   { kind: 'hello-ok', version, caps, host, platform }
// sshRun is injectable for tests.
async function probePeer(sshHost, port, { sshRun: run = sshRun, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await run(sshHost, buildProbeScript(port), { timeoutMs });
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

module.exports = {
  probePeer, buildProbeScript, parseDeployLine,
  fixSessionName, buildDeployFixBriefing,
  PROBE_NOLISTEN, PROBE_BODY,
};
