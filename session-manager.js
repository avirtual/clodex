// ─── WINDOW BRIDGE / opaque-handle contract ─── a handle is touched only via .webContents.send, .isDestroyed(), .isFocused(), .show()/.focus() and === identity;
// web-host handleFor builds plain literals, so widen it in the same change and never require('electron') here.

const SHOUT_MAX_BYTES = 16 * 1024;

const REBOOT_MIN_INTERVAL = 5 * 60 * 1000;

const EXEC_ACK_MIN_TIMEOUT_MS = 60 * 1000;
const EXEC_STATUS_DEFAULT_MS = 3 * 60 * 1000;
const EXEC_STATUS_MIN_MS = 30 * 1000;
const EXEC_RUN_RECORD_CAP = 20;
const EXEC_RUN_LEDGER_FILE = 'exec-runs-inflight.json';
const EXEC_STATUS_QUERY_CMD = 'status';
const EXEC_STATUS_REPLY_MAX = 400;
const EXEC_STATUS_REPLY_RUNS = 3;
const EXEC_STATUS_REPLY_CLOSING = ' Do not poll; a running run reports every few minutes'
  + ' and delivers its result as input.';

function execElapsedLabel(ms) {
  const elapsed = Math.max(0, ms);
  const mins = Math.floor(elapsed / 60000);
  const secs = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
  return `${mins}m ${secs}s`;
}

function execRunStatusReply(execRuns, rawBody, now) {
  const runs = Array.isArray(execRuns) ? execRuns : [];
  let wanted = null;
  try {
    const payload = JSON.parse(String(rawBody == null ? '' : rawBody).trim() || '{}');
    if (payload && typeof payload.seq === 'number') wanted = payload.seq;
  } catch { wanted = null; }

  let shown;
  if (wanted !== null) {
    const one = runs.find((r) => r && r.seq === wanted);
    if (!one) return `status: no run #${wanted} on this seat.`;
    shown = [one];
  } else {
    if (!runs.length) return 'status: no exec runs on this seat yet.';
    shown = runs.slice(-EXEC_STATUS_REPLY_RUNS).reverse();
  }

  const cmds = shown.map((r) => String(r.cmd));
  const clipped = shown.map(() => false);
  const headOf = (r, i) => {
    const head = `run #${r.seq} ${cmds[i]}${clipped[i] ? '…' : ''} ${r.state} `;
    if (r.state === 'running') {
      return `${head}${execElapsedLabel(now - r.startedAt)} so far, ceiling ${r.ceilingMin}m`;
    }
    return `${head}at ${execElapsedLabel((r.endedAt == null ? now : r.endedAt) - r.startedAt)}`;
  };
  const tails = shown.map((r) => (r.state === 'running' ? '' : String(r.tail || '')));
  const render = () => `status: ${shown.map((r, i) => {
    const h = headOf(r, i);
    return tails[i] ? `${h}: ${tails[i]}` : h;
  }).join('; ')}` + EXEC_STATUS_REPLY_CLOSING;
  const endsHigh = (str) => {
    const c = str.charCodeAt(str.length - 1);
    return c >= 0xD800 && c <= 0xDBFF;
  };
  const dropLast = (str, n = 1) => {
    const cut = str.slice(0, -n);
    return endsHigh(cut) ? cut.slice(0, -1) : cut;
  };

  let over = render().length - EXEC_STATUS_REPLY_MAX;
  while (over > 0) {
    let longest = -1;
    for (let i = 0; i < tails.length; i++) {
      if (longest < 0 || tails[i].length > tails[longest].length) longest = i;
    }
    if (longest >= 0 && tails[longest].length) {
      tails[longest] = dropLast(tails[longest], over);
      over = render().length - EXEC_STATUS_REPLY_MAX;
      continue;
    }
    let widest = -1;
    for (let i = 0; i < cmds.length; i++) {
      if (cmds[i].length && (widest < 0 || cmds[i].length > cmds[widest].length)) widest = i;
    }
    if (widest < 0) break;
    cmds[widest] = dropLast(cmds[widest], over + (clipped[widest] ? 0 : 1));
    clipped[widest] = true;
    over = render().length - EXEC_STATUS_REPLY_MAX;
  }
  for (let i = 0; i < tails.length; i++) {
    if (endsHigh(tails[i])) tails[i] = tails[i].slice(0, -1);
  }
  return render();
}

const REBOOT_NOTICE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// Retry with a ceiling, not confirmed delivery: nothing acknowledges an injected message, so the notice is re-offered a bounded number of times.
// Measured delays: a resumed seat was silent for 105s re-rendering a 41MB transcript, so the second retry has to land after that.
const REBOOT_NOTICE_RETRY_DELAYS = [30 * 1000, 120 * 1000];
const REBOOT_NOTICE_MAX_ATTEMPTS = 3;

// Must sit above INJECT_BOOT_MAXWAIT (20s) and below REBOOT_NOTICE_RETRY_DELAYS[0] (30s), or two copies of the notice flush joined into one body.
// It does not replace the retry ladder: a flush at 25s can still be lost into a booting CLI on a slow seat.
const REBOOT_NOTICE_FLUSH_MS = 25 * 1000;

// Longer than INJECT_QUIET_MS (2s) on purpose: it must clear a pause mid-composition, not just mid-word.
const REBOOT_NOTICE_DRAFT_STALE_MS = 10 * 1000;

const { readEffectiveClaudeEnv, teeBlindBackend } = require('./claude-env');
const { readerFor } = require('./transcript-readers');
const { scanIntentLines } = require('./intent-segments');
const { deepMerge, bootstrapSeatConfig, museDataHome, findMuseTranscript, oldestMuseTranscript, findCodexRollout, museRegistryFor, linkTranscript } = require('./seat-config');
const { activationSettings } = require('./muse-skills');
const { seatImageFileName, seatImageHead } = require('./seat-images');
const MUSE_LINK_POLL_MS = 250;
const MUSE_LINK_DEADLINE_MS = 60000;
const CODEX_LINK_POLL_MS = 250;
const CODEX_LINK_DEADLINE_MS = 60000;
const CODEX_LINK_SLOW_POLL_MS = 5000;
const { mergeSessionEnv, sanitizeFlat, withUtf8Charset } = require('./env-scopes');
const voiceEngineSpec = require('./voice-engine');
const { CTRLU_SETTLE_MS } = require('./inject-queue');
const { VOICE_MODES, voiceModeOf } = require('./voice-settings');
const { pasteModeSignal, strictMcpReason, STRICT_MCP_EXPLANATION, PROXY_AGENT_PREFIX, PASTE_START, PASTE_END, stampServedAge } = require('./proxy-util');
const {
  RELAY_ROSTER_TTL_MS, RELAY_MAX_HOPS,
  buildRelayEnvelope, buildTerminalDm, isRelayEnvelope, hopRule, relayVersionOk,
} = require('./relay-protocol');
const { formatTeamBlock, matchSeatRole, formatRoster, formatCompositionDelta } = require('./team-manifest');
const { SYSTEM_SENDERS } = require('./system-senders');

const SCRATCH_TAIL_SCAN = 64 * 1024;
const SCRATCH_MARK_TAIL = 512;
const SCRATCH_CLOSE_TIMEOUT = 120000;
const SCRATCH_BAK_TTL_MS = 7 * 24 * 3600 * 1000;
const isScratchCutText = (text) => typeof text === 'string' && SCRATCH_CUT_TEXT_PREFIXES.some((p) => text.startsWith(p));
const scratchRealArrivals = (list) => (Array.isArray(list) ? list : []).filter((a) => !isScratchCutText(a && a.text));

const SCRATCH_DISPATCH_TYPES = new Set(['task', 'spawn', 'team', 'team-create', 'team-review', 'review-done']);
const openBodyTails = new WeakMap();
const endsContextVerb = (intent) => intent.type === 'review-done'
  || (intent.type === 'scratch' && (intent.sub === 'end' || intent.sub === 'rewind'))
  || (intent.type === 'context' && (intent.sub === 'clear' || intent.sub === 'compact' || intent.sub === 'reload'));

const ECHOED_DUP_TYPES = new Set(['task', 'remind', 'spawn', 'team']);

function dupIdentity(intent) {
  const what = intent.id || intent.target || intent.name || '';
  return what ? `${intent.type} ${what}` : intent.type;
}

const { createTicketsStore, ticketTerminalReason } = require('./tickets-store');
const { findRepoRoot } = require('./project-root');
const { atomicWriteFileSync } = require('./fs-util');
const { isAgentType, adapterFor, streamFor: adapterStreamFor, hasBypass, hasReadOnlyCap, postureOf, resolveModelId, resolveEffort } = require('./cli-adapters');

function streamCodecCtx(type, extraArgs) {
  const a = adapterFor(type);
  const argv = Array.isArray(extraArgs) ? extraArgs : [];
  let model = null;
  const flags = a ? a.model.flags : [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (flags.includes(tok) && i + 1 < argv.length) model = argv[i + 1];
    else if (typeof tok === 'string') {
      const f = flags.find((fl) => fl.startsWith('--') && tok.startsWith(`${fl}=`));
      const g = flags.find((fl) => /^-[^-]$/.test(fl) && tok.startsWith(fl) && tok.length > fl.length);
      if (f) model = tok.slice(f.length + 1);
      else if (g) model = tok.slice(tok[g.length] === '=' ? g.length + 1 : g.length);
    }
  }
  return {
    bypass: hasBypass(a, argv),
    readOnly: hasReadOnlyCap(a, argv),
    model: model ? resolveModelId(type, model) : null,
  };
}

const TERM_ESCAPE_RE = /\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78MDEc]/g;
const BOOT_NUDGE_PROBE_CHARS = 32;
const BOOT_NUDGE_ECHO_CAP = 65536;
const BOOT_NUDGE_PASTE_PLACEHOLDER = '[Pastedtext#';

const TERM_ESCAPE_STICKY_RE = new RegExp(TERM_ESCAPE_RE.source, 'y');
const ESCAPE_RESYNC_WINDOW = 4096;

function escapeSafeTail(buf, max) {
  if (buf.length <= max) return buf;
  let start = buf.length - max;
  const esc = buf.lastIndexOf('\x1b', start - 1);
  if (esc >= 0 && start - esc <= ESCAPE_RESYNC_WINDOW) {
    TERM_ESCAPE_STICKY_RE.lastIndex = esc;
    const hit = TERM_ESCAPE_STICKY_RE.exec(buf);
    if (hit && esc + hit[0].length > start) start = esc + hit[0].length;
  }
  if (/[\uDC00-\uDFFF]/.test(buf[start] || '')) start += 1;
  return buf.slice(start);
}

function inkVisibleText(s) {
  return String(s).replace(TERM_ESCAPE_RE, '').replace(/\s+/g, '');
}

function bootNudgeProbeOf(bytes) {
  if (typeof bytes !== 'string') return '';
  const body = bytes.split(PASTE_START).join('').split(PASTE_END).join('').replace(/\x15/g, '');
  const line = body.split(/[\r\n]/).find((l) => /\S/.test(l)) || '';
  return inkVisibleText(line).slice(0, BOOT_NUDGE_PROBE_CHARS);
}

const CODEX_STREAM_REFUSED = new Map([
  ['--dangerously-bypass-approvals-and-sandbox', 0], ['--no-alt-screen', 0],
  ['--sandbox', 1], ['-s', 1], ['--ask-for-approval', 1], ['-a', 1], ['--model', 1], ['-m', 1], ['--add-dir', 1],
]);

function stripCodexStreamArgs(argv) {
  const out = [];
  const dropped = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (CODEX_STREAM_REFUSED.has(tok)) {
      dropped.push(tok);
      i += CODEX_STREAM_REFUSED.get(tok);
      continue;
    }
    if (typeof tok === 'string' && /^-[^-]./.test(tok) && CODEX_STREAM_REFUSED.has(tok.slice(0, 2))) { dropped.push(tok.slice(0, 2)); continue; }
    const eq = typeof tok === 'string' ? tok.indexOf('=') : -1;
    if (eq > 0 && tok.startsWith('--') && CODEX_STREAM_REFUSED.has(tok.slice(0, eq))) { dropped.push(tok.slice(0, eq)); continue; }
    out.push(tok);
  }
  return { args: out, dropped };
}
const {
  SPILL_VERBS, SPILL_MIN_BYTES, HEAD_RE, isSpillVerb, pointerOf, pointerMatch, trailingPointerOf, spilledBodyOf, resolveSpill, spillDirFor, spillPathFor, verbKeyOf, writeSpill,
  receiptOf, resolveReceipt,
  capResumeSnapshot, spillMimicBounce,
} = require('./intent-spill');
const { createFiledRing, seedFiledRing, filedEntry, spillHead } = require('./filed-ring');
const nodePath = require('path');
const { durableMessageCopyOf, literalMessagePathOf } = require('./file-resolve');
const { spillGrammarLine } = require('./ipc-prompt');
const { readPromptSnapshotMemo, restageAtReset, clearCache } = require('./ipc-prompt-cache');

function spillAckLine(ev, filePath) {
  if (ev.verb !== 'prose') return null;
  return `[clodex] the ${ev.bytes} B of prose you wrote after your last intent were removed from your retained transcript to save context; they reached the operator's log and were filed at ${filePath}.`;
}
const { previewLine } = require('./body-preview');
const { createMemoryLoad } = require('./memory-load');
const { foldDraft, HOLD_MAX_MS: HINT_HOLD_MAX_MS } = require('./hint-arm');
const { didGrow, parsePsRows, descendantPids } = require('./stall-evidence');
const { seatHasPlugin } = require('./plugin-api');
const { readTeamJson } = require('./team-prompt-dir');
const { ensureSeatLink, renameSeat, removeSeat, renameTargets, pathInUse } = require('./seat-layout');
const { SEAT_KINDS, seatPathFor, claudeProjectSlug, scratchDirFor } = require('./clodex-paths');
const {
  ACK_PREFIX: SCRATCH_ACK_PREFIX, boundaryAt: scratchBoundaryAt, beginCutAt: scratchBeginCutAt,
  parseTranscriptTail: scratchParseTail, validateScratchCut, scratchBriefing, scratchReArmLine,
  nonce: scratchNonce, scratchReplayLine, arrivalClock: scratchArrivalClock, SCRATCH_BRIEFING_PREFIXES,
} = require('./scratch-mark');
const SCRATCH_CUT_TEXT_PREFIXES = [...SCRATCH_BRIEFING_PREFIXES, 'Continue from your handoff: @'];
const { SCRATCH_COST_FILE, scratchCostRecord } = require('./team-cost');
const { SCRATCH_LABEL_RE } = require('./intent-catalog');
const { SEGMENT_RE: IMPORT_SEGMENT_RE, SESSION_ID_RE: IMPORT_SESSION_ID_RE } = require('./seat-import');
const { effectiveModel } = require('./accounts');
const { liveSnapshotFor, archivedSnapshotFor, exitedSnapshotFor, stampConfigFlags } = require('./session-restore');
const { COMPACTING_VALVE_MS, COMPACT_NOTICE_CAP, noticeTextFor } = require('./compact-notices');
const STREAM_TOOL_DRAIN_MIN_MS = 2000;
const STREAM_RESULT_HOLD_MS = 400;
const STREAM_ARM_WAIT_MS = 1000;
const SEAT_CONTROL_COMMANDS = Object.freeze([
  { name: '/compact', kind: 'control', description: 'Compact the context' },
  { name: '/clear', kind: 'control', description: 'Start a fresh context' },
  { name: '/stop', kind: 'control', description: 'Interrupt the running turn' },
]);
const CLAUDE_SLASH_DESCRIPTIONS = Object.freeze({
  compact: 'Summarize the conversation to free context',
  clear: 'Start a fresh conversation',
  context: 'Show context window usage',
  model: 'Show or switch the model',
  effort: 'Set the reasoning effort',
  usage: 'Show plan usage limits',
  cost: 'Show the session cost',
  status: 'Show the seat status',
  help: 'List the available commands',
  mcp: 'Show MCP server status',
  skills: 'List the available skills',
  agents: 'List the configured subagents',
  config: 'Show the configuration',
  init: 'Write a CLAUDE.md for this project',
  memory: 'Edit the memory files',
  review: 'Review a pull request',
  rename: 'Rename the conversation',
});
const STREAM_HINT_POLL_MS = 50;
const STREAM_INIT_TIMEOUT_MS = 60 * 1000;
const PENDING_DRAIN_KEY = '\0pending-drain';
// Imported only to re-export: tests import ticketCloseLine and ticketTaskDirLine from this module, so do not drop them as unused.
const { createTicketMethods, ticketCloseLine, ticketTaskDirLine } = require('./team-tickets');

let incarnationSeq = 0;
function nextIncarnation() {
  return `${process.pid}.${Date.now().toString(36)}.${++incarnationSeq}`;
}

function preseedClaudeOnboarding({ fs, path, homeDir, cwd }) {
  try {
    const p = path.join(homeDir, '.claude.json');
    let j = {};
    if (fs.existsSync(p)) {
      j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
    }
    const wantOnboarding = !j.hasCompletedOnboarding;
    const trustKey = typeof cwd === 'string' && cwd ? cwd : null;
    const wantTrust = !!trustKey
      && ((j.projects || {})[trustKey] || {}).hasTrustDialogAccepted !== true;
    if (!wantOnboarding && !wantTrust) return false;
    if (wantOnboarding) {
      j.hasCompletedOnboarding = true;
      if (!j.theme) j.theme = 'dark';
    }
    if (wantTrust) {
      j.projects = j.projects || {};
      j.projects[trustKey] = { ...(j.projects[trustKey] || {}), hasTrustDialogAccepted: true };
    }
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}
function nearMissFormHint(text) {
  if (!/^\[agent:term[\s\]]/.test(String(text || ''))) return '';
  return 'The term intent takes its command AFTER the closing bracket — `[agent:term exec] <command>`, not inside it. ';
}

// Add a field only if no caller can regrow it and none re-asserts it after create(), else two writers own it; keepWarmAlways and holdUntil stay a pair.
// An absent worktree pointer is the dangerous state: destroy() would drop the record and orphan the checkout.
const ALWAYS_PRESERVE = ['sessionIds', 'pluginGrants', 'wireLabel', 'ticketId', 'keepWarmAlways', 'holdUntil', 'worktree', 'autoCompact', 'digested', 'voice', 'reviewerTemplate'];

function sigkillPid(pid, name, log) {
  if (!(pid > 0)) {
    if (log) log.warn('session', `refusing SIGKILL for ${name}: pid is ${pid}, which would broadcast rather than target`);
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

function psSnapshotSync(childProcess) {
  try {
    return parsePsRows(childProcess.execFileSync(
      'ps', ['-axo', 'pid=,ppid=,time='], { timeout: 5000, encoding: 'utf8' },
    ));
  } catch { return null; }
}

function psSnapshot(childProcess) {
  return new Promise((resolve) => {
    try {
      childProcess.execFile('ps', ['-axo', 'pid=,ppid=,time='], { timeout: 5000 }, (err, stdout) => {
        resolve(err ? null : parsePsRows(stdout));
      });
    } catch { resolve(null); }
  });
}

function ptyOwnership(rows, ptyPid, ownerPid) {
  const row = rows.find((r) => r.pid === ptyPid);
  if (!row) return 'gone';
  return row.ppid === ownerPid ? 'ours' : 'foreign';
}

function reapFromSnapshot({ rows, ptyPid, name, log, ownerPid = process.pid }) {
  if (!rows || !(ptyPid > 0)) return 0;
  const owned = ptyOwnership(rows, ptyPid, ownerPid);
  if (owned !== 'ours') {
    if (owned === 'foreign' && log) {
      log.warn('session', `refusing to reap beneath ${name} pid=${ptyPid}: that process is not a child of this one `
        + `(pid ${ownerPid}), so the tree under it belongs to someone else. A pty we spawned is always our direct `
        + `child; anything else is a stale or stubbed pid, and pid 1 reached this way would signal the whole machine`);
    }
    return 0;
  }
  const pids = descendantPids(rows, ptyPid);
  for (const pid of pids) sigkillPid(pid, `${name} descendant`, log);
  if (pids.length && log) log.info('session', `reaped ${pids.length} descendant(s) of ${name} pid=${ptyPid}`);
  return pids.length;
}

async function reapPtyDescendants({ ptyPid, name, log, childProcess }) {
  if (!(ptyPid > 0)) return 0;
  return reapFromSnapshot({ rows: await psSnapshot(childProcess), ptyPid, name, log });
}

// A blocking agent.json naming our own pid is stale (Docker reuses one pid every boot), but only once the caller has ruled out a live session of that name.
function isStaleRegistration(existingPid, ownPid, isAlive) {
  return !isAlive(existingPid) || existingPid === ownPid;
}

function exitDisposition({ agentType, userKilled, shuttingDown, archived, moving }) {
  const expected = !!(userKilled || shuttingDown || archived || moving);
  return { expected, dropRecord: !agentType && !expected, stampExited: !!agentType && !expected };
}

// node-pty's execvp failure is silent: a bare code-1 exit inside the fast-fail window, while a later code-1 is a real crash.
function missingToolOnExit({ expected, exitCode, signal, elapsedMs, cmd, whichBin }) {
  if (expected || exitCode !== 1 || signal) return null;
  if (!(elapsedMs <= 5000)) return null;
  const resolved = whichBin(cmd);
  return resolved ? null : (cmd || null);
}

function nameConflict({ liveHas, persistedHas }) {
  if (liveHas) return 'live';
  if (persistedHas) return 'persisted';
  return null;
}

// Not 1: a turn carrying three denied dms would keep an arbitrary one and destroy the rest.
const DENIED_SPILL_CAP = 3;

function deniedBodyDisposition(intent) {
  if (!intent || !intent.body) return { how: 'none', label: null };
  switch (intent.type) {
    case 'dm': case 'shout': case 'remind':
      return { how: 'spill', label: intent.type };
    case 'memory':
      if (intent.sub === 'remember') return { how: 'spill', label: 'memory remember' };
      return { how: 'note', label: `memory ${intent.sub || ''}`.trim() };
    // Denial makes the body moot rather than lost: the compact/clear/reload did not happen, so a body-not-saved line would be a false alarm.
    case 'context':
      return { how: 'none', label: null };
    // exec's body is derived from the refused command, so it is reported as lost but never spilled to disk.
    default:
      return { how: 'note', label: intent.type };
  }
}

function keepwarmTokens(n) {
  if (n == null) return null;
  if (n === 0) return '0';
  return `${(n / 1000).toFixed(1)}k`;
}

function keepwarmPingBody(pings, r) {
  const head = `keep-warm ping #${pings}`;
  const u = r.usage || {};
  const parts = [r.cache_hit ? 'warm' : 'COLD'];
  const read = keepwarmTokens(u.cache_read_input_tokens);
  const made = keepwarmTokens(u.cache_creation_input_tokens);
  if (read != null) parts.push(`${read} cached`);
  if (made != null) parts.push(`${made} re-cached`);
  if (r.ttl_s != null) parts.push(`cache slid ${Math.round(r.ttl_s / 60)}m`);
  return `${head} — ${parts.join(', ')}`;
}

const { AGENT_NAME_RE: ORIGIN_NAME_RE } = require('./catalogs');

function findPeerByOrigin(peers, origin) {
  if (!origin) return undefined;
  const want = String(origin).toLowerCase();
  const list = Array.isArray(peers) ? peers : [];
  for (const field of ['label', 'id', 'host']) {
    const hit = list.find((p) => p && p[field] && String(p[field]).toLowerCase() === want);
    if (hit) return hit;
  }
  return undefined;
}

function peerOriginSuffix(p, nameRe = ORIGIN_NAME_RE) {
  if (!p) return null;
  for (const v of [p.label, p.host, p.id]) {
    if (v && nameRe.test(String(v))) return String(v);
  }
  return null;
}

const { speakable } = require('./speakable');
const { proseVerdictNeedsNudge, PROSE_VERDICT_NUDGE } = require('./verdict-nudge');
const { expandSkillsOff } = require('./skills-off');
const { randomUUID } = require('crypto');
const streamSeatLib = require('./stream-seat');
const streamReap = require('./stream-reap');

function dmContentKey(senderTag, body) {
  return require('crypto').createHash('sha256')
    .update(`${senderTag}\n${body}`).digest('hex').slice(0, 16);
}

const MOVE_TO_PEER_OMIT = [
  'execCommands', 'worktree', 'archivedAt', 'exitedAt', 'exitCode', 'exitSignal', 'failed', 'movedTo',
  'ephemeral', 'reviewFor', 'reviewTicket', 'reviewerTemplate', 'pluginGrants',
  'wireLabel', 'ticketId', 'rosterSentAt', 'streamPid',
];

function moveFileBytes(fs, f) {
  if (f.bytes) return f.bytes.length;
  try { return fs.statSync(f.path).size; } catch { return 0; }
}

function seatRelFiles(fs, path, dir) {
  const out = [];
  const walk = (cur, prefix) => {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries.slice().sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(cur, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir, '');
  return out;
}

function createSessionManager(deps) {
  const {
    AGENT_NAME_RE,
    COMPACT_CONTINUATION_DELAY,
    COMPACT_INFLIGHT_TIMEOUT,
    DEFAULT_COMPACT_CONTINUATION,
    DEFAULT_WORKSPACE_ID,
    INJECT_BOOT_MAXWAIT,
    INJECT_HOLD_TIMEOUT,
    INJECT_QUIET_MAXWAIT,
    INJECT_QUIET_MS,
    INJECT_SPEAKING_STALE_MS,
    INJECT_VOICE_DRAFT_STALE_MS,
    InjectQueue,
    JsonlWatcher,
    LONG_TEXT_DELAY,
    LONG_TEXT_THRESHOLD,
    MSG_DIR,
    MSG_SPILL_THRESHOLD,
    MSG_MAX_AGE,
    OUTBOX_DIR,
    PENDING_DIR,
    ProxyClient,
    REGISTRY_DIR,
    RELOAD_CONTINUATION_DELAY,
    SCROLLBACK_MAX,
    SELF_LABEL,
    SHORT_TEXT_DELAY,
    Transport,
    WIRE_INTENTS_LIVE,
    WIRE_SHADOW,
    BUILTIN_AGENTS,
    DROPPED_AGENT_FIELDS,
    qualifiedAgentName,
    buildIpcPrompt,
    childProcess,
    claimParkedById,
    claimParkedByKey,
    classifyNotification,
    cleanupClaudeHook,
    cleanupCodexHook,
    cleanupMuseSeat,
    crypto,
    cleanupSkills,
    cleanupAgentPlugin,
    effectiveInjectedSkills,
    effectiveInjectedAgents,
    unresolvedSubagentRefs,
    codexStatusLineArg,
    collectSystemDiagnostics,
    composeDigest,
    digestTiers,
    ctxReminderFor,
    ctxThresholdsFor,
    CTX_THRESHOLD_MIN,
    bakePrompt,
    promptCacheDir,
    readCache,
    ipcDelta,
    enqueueNotice,
    versionNoticeFor,
    clearNotices,
    appVersion,
    diagSummary,
    diagWarning,
    draftChunkSignal,
    drainPending,
    countPending,
    oldestActiveParkTs,
    peekPending,
    enqueueOutbox,
    ensureDir,
    execBodyCap,
    findProjectRoot,
    gitWorktree,
    resolveTeam,
    addRole,
    setRole,
    removeRole,
    renameRole,
    setTeamWatchdog,
    setLead,
    teamsDir,
    fs,
    hasActivePending,
    bodyModeFor,
    intentEnabledFor,
    intentEnabledForSeat,
    knownSkillNames,
    platformSkills,
    pluginGrammarLines,
    pluginRowFor,
    validIntentNames,
    intentEnabled,
    isAlive,
    isDigested,
    isDraftOpen,
    isFilenameToken,
    clampReplyBody,
    isHumanPtyInput,
    withoutPrivilegedIntentsFor,
    isInjectInFlight,
    canFireCompact,
    lastTranscriptWrite,
    log,
    fencedLines,
    looksLikeIntent,
    memoryStore,
    commonMemoryRecall,
    memoryLoad,
    hintArm,
    selectionArm: selectionArmDep,
    voiceOriginArm: voiceOriginArmDep,
    mergeClaudeSystemPrompt,
    mergeCodexInstructions,
    mergeInstructionBodies,
    normalizeProxyBase,
    noteFileTouches,
    createSubagentStore,
    noteSubagentTurn,
    os,
    outboxKnowsOrigin,
    markOutboxOrigin,
    parkDelivery,
    parkIdInUse,
    parseAndValidate,
    parseCtxFile,
    parseIntent,
    parseRemindSpec,
    path,
    pathFor,
    peerStatusLabel,
    pty,
    randBase36,
    readAppendBodies,
    refreshAppMenu,
    refreshTrayMenu,
    registry,
    resolveProxyAgentId,
    resolveProxyBase,
    resolveSystemPromptFile,
    runDirFor,
    scheduleTrayRefresh,
    setupClaudeHook,
    setupCodexHook,
    shadowIntentKey,
    shouldHoldDm,
    spillToFile,
    stripLevelOf,
    unionEnabled,
    vetFileIntent,
    termAvailableFor,
    termExec: termExecDep,
    whichBin,
    writeClaudeDigestFile,
    deliverSkills,
    skillDeliveryProviders,
    writeAgentPlugin,
    writeBundlePlugins,
    getPluginBundles,
    readSystemPromptBody,
    getPersistence, getTemplates, getUiSettings, getEnvScopes, getAccounts, getPromptLibrary, getAgentLibrary, getRemoteServer, getPeerManager, getRemindScheduler, getReminders, getNotifications,
    getWorkspaces, readCtxFor,
    getPluginHooks,
    getUserDataPath, openPath, notifyOS, setAppQuitting, relaunchApp, relaunchUnavailable,
  } = deps;
  const spawnStreamSeat = deps.spawnStreamSeat || streamSeatLib.spawnStreamSeat;
  const reapBeforeResume = deps.reapBeforeResume || streamReap.reapBeforeResume;
  const streamFor = deps.streamFor || adapterStreamFor;
  const loadStreamCodec = deps.loadStreamCodec || ((id) => require(`./${id}`));
  const streamProc = deps.streamProc || {
    kill: streamSeatLib.groupKill,
    isAlive: streamSeatLib.isAlive,
    startTimeOf: streamSeatLib.kernelStartTime,
  };

  const memLoad = memoryLoad || createMemoryLoad();
  const bundlesFor = (writeBundlePlugins && getPluginBundles) ? getPluginBundles : () => [];
  const writeBundles = (writeBundlePlugins && getPluginBundles) ? writeBundlePlugins : () => [];
  const tiersOf = digestTiers || (() => null);

  const NO_ARM = { onDraft() {}, disarm() {}, onSubmit() {}, onContextReset() {}, forget() {}, holding() { return false; } };
  const arm = hintArm || NO_ARM;

  const NO_SELECTION_ARM = {
    arm: () => Promise.resolve({ armed: false, reason: 'selection hints are unavailable on this host' }),
    release: () => Promise.resolve({ armed: false }),
    onSubmit() {},
    forget() {},
  };
  const selectionArm = selectionArmDep || NO_SELECTION_ARM;

  const voiceOriginArm = voiceOriginArmDep || { arm: () => false };

  const termExec = termExecDep
    || (() => ({ ok: false, error: 'terminal tabs are not available on this host' }));

  const speaker = deps.speaker || {
    speak: () => false, stop: () => false, interruptForRecorder: () => false, isSpeaking: () => false,
  };

  const claudeHome = deps.claudeHome || (() => path.join(os.homedir(), '.claude'));

  const ROSTER_SETTLE_MS = deps.rosterSettleMs || 400;
  // The first mode-2004 can precede the readline loop accepting Enter, so a write at the
  // boot-ready edge lands in a composer the boot re-render wipes; ~750ms production settle.
  const BOOT_DRAIN_SETTLE_MS = Number.isFinite(deps.bootDrainSettleMs) ? deps.bootDrainSettleMs : 750;
  const BOOT_NUDGE_MS = Number.isFinite(deps.bootNudgeMs) ? deps.bootNudgeMs : 4000;
  const BOOT_NUDGE_QUIET_MS = Number.isFinite(deps.bootNudgeQuietMs) ? deps.bootNudgeQuietMs : 1000;
  const BOOT_NUDGE_MAXWAIT_MS = Number.isFinite(deps.bootNudgeMaxWaitMs) ? deps.bootNudgeMaxWaitMs : 120000;
  const BOOT_REPLAY_POLL_MS = Number.isFinite(deps.bootReplayPollMs) ? deps.bootReplayPollMs : 250;
  const ROSTER_MAX_WAIT_MS = deps.rosterMaxWaitMs || 10000;
  const STREAM_INIT_MS = Number.isFinite(deps.streamInitTimeoutMs) ? deps.streamInitTimeoutMs : STREAM_INIT_TIMEOUT_MS;

  // Tests drive this long and call the checks directly: at 0 a check races the delivery it judges.
  const SPEC_CONFIRM_MS = Number.isFinite(deps.specConfirmMs) ? deps.specConfirmMs : 90 * 1000;
  const TURN_START_WINDOW_MS = Number.isFinite(deps.turnStartWindowMs) ? deps.turnStartWindowMs : 5000;

  const DM_LATCH_CAP = Number.isFinite(deps.dmLatchCap) ? deps.dmLatchCap : 8;

  // clodexHome is injected, not the store default, so a test repointing REGISTRY_DIR
  // cannot read or write the operator's real ~/.clodex board.
  const ticketsStore = createTicketsStore({ fs, path, clodexHome: REGISTRY_DIR });

  class SessionManager {
    constructor() {
      this.sessions = new Map();
      this._freshBakeOnce = new Set();
      this._creating = new Set();
      this.windows = new Map();
      // Global, not per-window: the external tap picks one seat for the whole box.
      this._focusedSession = null;
      this._micTarget = null;
      this._appFocused = false;
      // Separate from _appFocused, whose false cannot tell backgrounded from no host reporting;
      // the headless host never reports, so it must neither arm the host mic nor raise a window.
      this._appFocusReported = false;
      // Box-wide, separate from the per-seat field of the same name: audio has no seat.
      this._lastVoiceRecordingTs = 0;
      this._knownDmOrigins = new Set();
      this._relayRosters = new Map();
      this._lastPendingCounts = new Map();
      this._ticketWatch = new Map();
      // The probe is async (git); without this two overlapping sweeps both pass the gate and alarm twice.
      this._stallProbing = new Set();
      this._movingNames = new Set();
      this._wire = null;
      this._voiceEngine = null;
      this._voiceEnginePending = null;
      this._voiceOp = Promise.resolve();
      this._shadow = null;
      this._wireTelemetry = null;
      const { IntentDeduper, ActivityTracker } = require('./wire-intents');
      this._intentDeduper = new IntentDeduper();
      this._activity = new ActivityTracker((name, state, { turnEnd }) => {
        this._emitActivity(name, state, state === 'idle' && turnEnd);
      }, {
        onEvent: (name, ts) => {
          const s = this.sessions.get(name);
          if (s) s.activityTs = Math.max(s.activityTs || 0, ts);
        },
      });
    }

    // atomicWriteFileSync, not writeFileSync: this whole-history ledger is rewritten in full and
    // WireTelemetry swallows a read parse error, so a torn write silently drops all of it.
    _wireTotalsPersist(totalsPath) {
      return {
        read: () => JSON.parse(fs.readFileSync(totalsPath, 'utf8')),
        write: (obj) => atomicWriteFileSync(totalsPath, JSON.stringify(obj)),
      };
    }

    _ensureWire() {
      if (this._wire) return Promise.resolve(this._wire);
      if (this._wirePending) return this._wirePending;
      const pending = this._buildWire().finally(() => {
        if (this._wirePending === pending) this._wirePending = null;
      });
      this._wirePending = pending;
      return pending;
    }

    async _buildWire() {
      let warmth = null;
      try {
        const { WarmthStore } = require('./wire/warmth');
        warmth = new WarmthStore({ path: path.join(getUserDataPath(), 'wire-warmth.sqlite') });
      } catch (e) {
        this._shadowLog({ type: 'wire-warmth-unavailable', error: e.message });
      }
      let hold = null;
      if (warmth) {
        try {
          const { HoldKeeper } = require('./wire/hold');
          const { HoldEntryStore } = require('./wire/hold-store');
          // userData, not ~/.clodex/run/<name>/, which is rm -rf'd on every exit path.
          const entryStore = new HoldEntryStore({
            path: path.join(getUserDataPath(), 'wire-hold-entries.json'),
            // Message only: the records carry request bytes and a bearer token,
            // and the shadow log must never gain a line holding either.
            onError: (message) => this._shadowLog({ type: 'wire-hold-store-error', error: message }),
          });
          hold = new HoldKeeper({
            warmth,
            entryStore,
            configDirFor: (sid) => {
              for (const s of this.sessions.values()) {
                if (s.sessionId !== sid) continue;
                const entry = getPersistence().get(s.name);
                const dir = entry && entry.env && entry.env.CLAUDE_CONFIG_DIR;
                return dir || null;
              }
              return null;
            },
          });
          hold.on('hold', (ev) => this._shadowLog({ type: 'wire-hold', ...ev }));
          hold.on('hold', (ev) => this._onHoldLifecycle(ev));
          hold.start();
          this._restorePerpetualHolds(hold);
        } catch (e) {
          this._shadowLog({ type: 'wire-hold-unavailable', error: e.message });
          hold = null;
        }
      }
      this._holdKeeper = hold;
      try {
        return await this._startWire(warmth, hold);
      } catch (e) {
        if (hold) { try { hold.stop(); } catch {} }
        if (this._holdKeeper === hold) this._holdKeeper = null;
        throw e;
      }
    }

    async _startWire(warmth, hold) {
      const { WireProxy } = require('./wire/proxy');
      const { isSubagentRole } = require('./wire/role');
      const { ShadowDiff } = require('./wire/shadow');
      let spillShownStore = null;
      try {
        const { SpillShownStore } = require('./wire/spill-shown-store');
        spillShownStore = new SpillShownStore({
          path: path.join(getUserDataPath(), 'wire-spill-shown.json'),
          onError: (message) => this._shadowLog({ type: 'wire-spill-shown-store-error', error: message }),
        });
      } catch (e) {
        this._shadowLog({ type: 'wire-spill-shown-store-error', error: e.message });
      }
      const wire = new WireProxy({
        requireTokens: true,
        warmth,
        hold,
        spillShownStore,
        onSpillShownError: (message) => this._shadowLog({ type: 'wire-spill-shown-store-error', error: message }),
        spillEnabled: () => getUiSettings().get().intentSpill === 'on',
      });
      // Header presence gates a reading; the provider check gates the 429 path, which carries no
      // ratelimit headers from any provider and would file a codex refusal against the Claude org.
      wire.on('response', (ev) => {
        if (!ev || !ev.headers) return;
        if (ev.provider !== 'anthropic') return;
        const store = this.quotaStore();
        if (!store) return;
        // Deferred: the store's write is a synchronous disk sync and this event fires
        // before the response head goes downstream, so inline it delays time-to-first-token.
        setImmediate(() => {
          try {
            const account = this._accountForWireAgent(ev.agent);
            const snap = store.note(ev.headers, { status: ev.status, account });
            if (snap) this._broadcast('wire-quota', this._quotaPayload(store));
          } catch (e) {
            this._shadowLog({ type: 'wire-quota-error', error: e.message });
          }
        });
      });
      wire.on('spill', (ev) => {
        this._shadowLog({ type: 'wire-spill', ...ev });
        const filePath = spillPathFor(REGISTRY_DIR, ev.agent, ev.id);
        log.info('intent', `spill ${ev.agent} ${ev.verb} ${filePath} (${ev.bytes} B)`);
        this._broadcast('ipc-message', {
          type: 'spill', from: 'clodex', to: ev.agent,
          body: ev.verb === 'prose'
            ? `prose after your last intent (${ev.bytes} B) filed at ${filePath}`
            : `${ev.head} (${ev.bytes} B) filed at ${filePath}`,
          path: filePath,
        });
        const ack = spillAckLine(ev, filePath);
        if (ack) {
          try {
            enqueueNotice(REGISTRY_DIR, ev.agent, ack);
          } catch (e) {
            this._shadowLog({ type: 'wire-spill-ack-error', agent: ev.agent, error: e.message });
          }
        }
        this._noteFiled(ev.agent, filedEntry(filePath, 'intent', spillHead(filePath, ev)));
      });
      wire.on('spill-bail', (ev) => this._shadowLog({ type: 'wire-spill-bail', ...ev }));
      wire.on('spill-mimic', (ev) => {
        this._shadowLog({ type: 'wire-spill-mimic', ...ev });
        log.warn('intent', `${ev.agent} wrote a ${ev.kind} line itself — nothing was sent or filed`);
        const s = this.sessions.get(ev.agent);
        if (s && s.agentType) {
          s.spillMimicReq = ev.reqId;
          const typed = typeof ev.line === 'string' ? ev.line.trim() : '';
          const at = HEAD_RE.test(typed) ? parseIntent(typed) : null;
          const intent = at && typeof at.body === 'string' && at.body.trim() ? at : null;
          this._injectText(s, spillMimicBounce(intent, intent ? intent.body.trim() : typed), { parkable: true });
        }
      });
      wire.on('spill-skip', (ev) => this._shadowLog({ type: 'wire-spill-skip', ...ev }));
      wire.on('spill-cut', (ev) => {
        this._shadowLog({ type: 'wire-spill-cut', ...ev });
        log.info('intent', `spill-cut ${ev.agent} lines=${ev.lines} blocks=${ev.blocks} messages=${ev.messages} skipped=${ev.skipped}`);
      });
      wire.on('spill-cut-skip', (ev) => {
        this._shadowLog({ type: 'wire-spill-cut-skip', ...ev });
        log.info('intent', `spill-cut-skip ${ev.agent} ${ev.reason} skipped=${ev.skipped}`);
      });
      wire.on('spill-cut-error', (ev) => {
        this._shadowLog({ type: 'wire-spill-cut-error', ...ev });
        log.warn('intent', `spill-cut-error ${ev.agent} forwarded uncut: ${ev.error}`);
      });
      await wire.listen();
      this._shadow = new ShadowDiff((rec) => this._shadowLog(rec));
      wire.on('turn.completed', (t) => {
        try {
          {
            const s = this.sessions.get(t.agent);
            if (s && s.intentSource === 'wire') {
              this._activity.turnCompleted(t.agent, { reqId: t.reqId, sideCall: t.sideCall, stop: t.stop });
            }
          }
          if (!t.sideCall) {
            const s = this.sessions.get(t.agent);
            if (s) {
              if (Array.isArray(t.files) && t.files.length) this._noteFileTouches(s, t.files, isSubagentRole(t.role));
              if (isSubagentRole(t.role)) this._noteSubagentTurn(s, t);
            }
          }
          if (t.sideCall || t.compact || isSubagentRole(t.role)) return;
          // Inside the main-line filter and not gated on stop.is_turn: turn.completed fires per
          // request, so gating would drop the text of every tool-loop hop.
          this._publishAgentText({
            session: t.agent, text: t.text, source: 'wire', truncated: t.truncated,
            isTurnEnd: !!(t.stop && t.stop.is_turn), files: t.files, reads: t.reads,
            thinking: t.thinking, thinkingTruncated: t.thinkingTruncated, toolUses: t.toolUses,
          });
          const intents = this._extractIntents(t.text);
          this._shadowLog({
            type: 'wire-turn', agent: t.agent, sessionId: t.sessionId,
            role: t.role, reqId: t.reqId, textLen: t.text.length,
            intents: intents.length,
          });
          const s = this.sessions.get(t.agent);
          if (s) s.lastMainStop = { isTurn: !!(t.stop && t.stop.is_turn), ts: Date.now() };
          if (s) s._flushTurnEnd = !!(t.stop && t.stop.is_turn);
          this._maybeSpeak(t.agent, t.text, !!(t.stop && t.stop.is_turn));
          if (s && t.stop && t.stop.is_turn) this._maybeDeliverDigest(s, t.sessionId || s.sessionId);
          if (s && s.intentSource === 'wire') {
            if (s.sentinel) s.sentinel.noteWireHealthy();
            const fired = new Set();
            for (const intent of intents) {
              const bkey = shadowIntentKey(t.agent, intent);
              if (intent.type !== 'exec' && fired.has(bkey)) {
                log.warn('intent', `intra-turn dup ${intent.type} ${t.agent} — swallowed`);
                if (ECHOED_DUP_TYPES.has(intent.type)) {
                  this._injectText(s, `[agent:${intent.type}] skipped: duplicate of an intent earlier in this same reply `
                    + `(same ${dupIdentity(intent)}) — not re-run; if it was meant as a distinct emission, `
                    + 'change what identifies it', { parkable: true });
                }
                continue;
              }
              const v = this._intentDeduper.claim(t.agent, bkey, 'wire');
              if (!v.ok) {
                log.warn('intent', `drop ${intent.type} ${t.agent}: ${v.reason}`);
                this._shadowLog({ type: 'intent-drop', agent: t.agent, intentType: intent.type, source: 'wire', reason: v.reason });
                continue;
              }
              fired.add(bkey);
              intent.fromWire = true;
              intent.reqId = t.reqId;
              setImmediate(() => this._handleIntent(t.agent, intent));
            }
            if (t.stop && t.stop.is_turn) {
              setImmediate(() => this._maybeFireCompactLatch(s));
              setImmediate(() => this._fireScratchClose(s));
            }
            if (t.sessionId && s.sessionId !== t.sessionId) {
              this._onWireSessionRotated(s, t.agent, t.sessionId);
            }
            this._maybeRearmHold(s, t.agent);
          } else if (s && s.agentType === 'claude') {
            for (const intent of intents) {
              this._shadow.record('wire', shadowIntentKey(t.agent, intent), {
                agent: t.agent, sessionId: t.sessionId, intentType: intent.type,
                reqId: t.reqId,
              });
            }
          }
        } catch (e) {
          this._shadowLog({ type: 'wire-observer-error', error: e.message });
        }
      });
      wire.on('turn.started', (t) => {
        try {
          const s = this.sessions.get(t.agent);
          if (s && s.intentSource === 'wire') {
            this._activity.turnStarted(t.agent, { reqId: t.reqId, sideCall: t.sideCall });
          }
        } catch { /* observer-grade */ }
      });
      try {
        const { WireTelemetry } = require('./wire-telemetry');
        const persistTotals = this._wireTotalsPersist(path.join(getUserDataPath(), 'wire-totals.json'));
        this._wireTelemetry = new WireTelemetry({ warmth, hold, log: (rec) => this._shadowLog(rec), persist: persistTotals });
        wire.on('turn.completed', (t) => this._wireTelemetry.noteTurn(t));
      } catch (e) {
        this._shadowLog({ type: 'wire-telemetry-unavailable', error: e.message });
      }
      wire.on('session', (ev) => this._shadowLog({ type: 'wire-session', ...ev }));
      const onWireFailure = (ev, kind) => {
        this._shadowLog({ type: kind, ...ev });
        try {
          this._activity.requestFailed(ev.agent, ev.reqId);
          const s = this.sessions.get(ev.agent);
          if (s && s.intentSource === 'wire' && s.sentinel && !s.sentinel.recovering) {
            s.sentinel.armRecovery((text, touches) => {
              // Published here too so the feed is at-least-once: the replayed tail can overlap a turn the
              // wire already delivered and raw text has no dedup key; skipping loses text when the wire gave no receipt.
              this._publishAgentText({
                session: ev.agent, text, source: 'jsonl', truncated: false,
                files: Array.isArray(touches) ? touches : [],
              });
              const fired = new Set();
              for (const intent of this._extractIntents(text, { receiptsFor: ev.agent })) {
                const bkey = shadowIntentKey(ev.agent, intent);
                if (fired.has(bkey)) {
                  log.warn('intent', `intra-turn dup ${intent.type} ${ev.agent} — swallowed`);
                  continue;
                }
                const v = this._intentDeduper.claim(ev.agent, bkey, 'recovery');
                if (!v.ok) {
                  log.warn('intent', `drop ${intent.type} ${ev.agent}: ${v.reason}`);
                  this._shadowLog({ type: 'intent-drop', agent: ev.agent, intentType: intent.type, source: 'recovery', reason: v.reason });
                  continue;
                }
                fired.add(bkey);
                setImmediate(() => this._handleIntent(ev.agent, intent));
              }
            });
            this._broadcast('ipc-message', {
              type: 'system', from: ev.agent, to: ev.agent,
              body: `wire ${kind} (${ev.error}) — intent recovery armed on transcript tail`,
            });
          }
        } catch { /* observer-grade */ }
      };
      wire.on('proxy-error', (ev) => onWireFailure(ev, 'wire-error'));
      wire.on('tee-failure', (ev) => onWireFailure(ev, 'wire-tee-failure'));
      this._shadowLog({ type: 'wire-up', port: wire.port });
      this._wire = wire;
      return wire;
    }

    _shadowLog(rec) {
      try {
        if (!this._shadowSink) {
          const { ShadowLog } = require('./wire/shadow-log');
          this._shadowSink = new ShadowLog({ fs, path, dir: REGISTRY_DIR });
        }
        this._shadowSink.append(rec);
      } catch { /* shadow only — never surfaces */ }
    }

    _nameForWireSession(sid) {
      if (!sid) return null;
      for (const [name, s] of this.sessions) {
        if (s.sessionId === sid) return name;
      }
      for (const [name, s] of this.sessions) {
        if (s._leftSessionIds && s._leftSessionIds.includes(sid)) return name;
      }
      return null;
    }

    _noteSessionLeft(s, sid) {
      if (!sid) return;
      const left = s._leftSessionIds || (s._leftSessionIds = []);
      if (left.includes(sid)) return;
      left.push(sid);
      if (left.length > 8) left.shift();
    }

    // Backstop for onSessionId's handover, normally unreachable because the symlink beats the wire;
    // the handover must not live only here.
    _onWireSessionRotated(s, agent, newSessionId) {
      // Refuse rotating backwards onto a conversation this seat left: a late old-id turn would end the fresh
      // hold, and the corroboration below fails open when a clear leaves the symlink transiently unresolvable.
      if (s._leftSessionIds && s._leftSessionIds.includes(newSessionId)) {
        this._shadowLog({ type: 'wire-stale-session', agent, sessionId: newSessionId });
        return;
      }
      if (!this._wireSessionCorroborated(s, newSessionId)) {
        this._shadowLog({ type: 'wire-stray-session', agent, sessionId: newSessionId });
        return;
      }
      const oldSid = s.sessionId;
      this._noteSessionLeft(s, oldSid);
      // Before the reassignment, or the old id's perpetual hold is unreachable and re-hashes forever;
      // endSession's 'session-ended' cause leaves the re-arm gate to the reset below.
      if (this._holdKeeper && oldSid) this._holdKeeper.endSession(oldSid);
      s.sessionId = newSessionId;
      s._holdRearmed = false;
      getPersistence().setSessionId(agent, newSessionId);
      this._noteConversationForDigest(s, newSessionId);
    }

    // Startup re-arm for perpetual holds, which an idle seat never gets from _maybeRearmHold (no turn);
    // persistence only authorises a sessionId, the keeper's stored entries supply the replayable bytes.
    _restorePerpetualHolds(hold) {
      try {
        const perpetual = new Set();
        for (const rec of getPersistence().list()) {
          if (!rec || !rec.keepWarmAlways || rec.archived || rec.archivedAt) continue;
          if (rec.sessionId) perpetual.add(rec.sessionId);
        }
        const r = hold.restorePerpetual({ accept: (sid) => perpetual.has(sid) });
        if (r.restored || r.declined || r.dropped) {
          // Counts only: a name or id here would start logging what was replayed.
          log.info('keepwarm', `restored ${r.restored} perpetual hold(s) at startup ` +
            // 'declined' carries no cause: the count also covers warmth-store errors, which are not a cold prefix.
            `(${r.declined} declined, ${r.dropped} no longer armed)`);
        }
      } catch (e) {
        this._shadowLog({ type: 'wire-hold-restore-error', error: e.message });
      }
    }

    // Retried every main-line turn until an arm lands, not latched once per spawn:
    // arm() is warm-gated, so a first-turn decline would otherwise lose the hold silently.
    _maybeRearmHold(s, agent) {
      if (!this._holdKeeper || s._holdRearmed) return;
      try {
        // Required here, not at module top: wire/* loads lazily so a wire-less host never pulls it in.
        const { rearmPlan } = require('./wire/hold');
        const p = getPersistence();
        const rec = p.list().find((x) => x.name === agent);
        const plan = rearmPlan(rec && rec.holdUntil, Date.now(), !!(rec && rec.keepWarmAlways));
        if (!plan) {
          s._holdRearmed = true;
        } else if (plan.clear) {
          p.setHoldUntil(agent, null);
          s._holdRearmed = true;
          log.info('keepwarm', `disarmed ${agent} (expired before re-arm)`);
        } else if (plan.arm && s.sessionId) {
          const r = plan.always
            ? this._holdKeeper.arm(s.sessionId, 0, { always: true })
            : this._holdKeeper.arm(s.sessionId, plan.hours);
          if (r && r.armed && (r.always || r.until)) {
            s._holdRearmed = true;
            if (r.always) {
              log.info('keepwarm', `re-armed ${agent} perpetually (seat property)`);
            } else {
              p.setHoldUntil(agent, Math.round(r.until * 1000)); // the keeper's clamped deadline, not plan.hours
              log.info('keepwarm', `re-armed ${agent} ${plan.hours.toFixed(2)}h remaining ` +
                `until ${new Date(r.until * 1000).toISOString()}`);
            }
          }
        }
      } catch (e) {
        this._shadowLog({ type: 'wire-hold-rearm-error', agent, error: e.message });
      }
    }

    _onHoldLifecycle(ev) {
      try {
        if (!ev) return;
        if (ev.event === 're-anchored') {
          const name = this._nameForWireSession(ev.session);
          if (name && ev.until > 0) getPersistence().setHoldUntil(name, Math.round(ev.until * 1000));
          return;
        }
        if (ev.event === 'disarmed') {
          if (ev.cause === 'off') return;
          const name = this._nameForWireSession(ev.session);
          // A failure disarm stops the live hold but never erases the persisted intent: the CLI refreshes its
          // OAuth on its next turn, so an overnight 401 is transient (~12 minutes) and a rejected replay proves nothing.
          if (ev.cause === 'failures' && name) {
            const s = this.sessions.get(name);
            if (s) s._holdRearmed = false;
          }
          log.info('keepwarm', `disarmed ${name || ev.session} (${ev.cause || 'unknown'}` +
            `${ev.pings != null ? `, ${ev.pings} pings` : ''}` +
            `${ev.lastResult ? `, last ${ev.lastResult}` : ''})`);
          this._keepwarmRow(name, ev.session,
            `keep-warm stopped (${ev.cause || 'unknown'}` +
            `${ev.pings != null ? `, ${ev.pings} pings` : ''})`);
        } else if (ev.event === 'ping' && ev.result && !ev.result.skipped) {
          const name = this._nameForWireSession(ev.session);
          const r = ev.result;
          if (r.ok === false) {
            const why = r.reason || r.status_code || 'error';
            log.warn('keepwarm', `ping FAILED ${name || ev.session}: ${why}`);
            this._keepwarmRow(name, ev.session, `keep-warm ping FAILED: ${why}`);
          } else if (r.ok === true) {
            this._keepwarmRow(name, ev.session, keepwarmPingBody(ev.pings, r));
          }
        }
      } catch { /* reporting must never break the emitter */ }
    }

    _keepwarmRow(name, session, body) {
      this._broadcast('ipc-message', { type: 'keepwarm', from: name || null, session, body });
    }


    registerWindow(workspaceId, win) {
      this.windows.set(workspaceId, win);
    }

    unregisterWindow(workspaceId) {
      this.windows.delete(workspaceId);
      try { speaker.stop(); } catch {}
    }

    windowForWorkspace(workspaceId) {
      const w = this.windows.get(workspaceId);
      return w && !w.isDestroyed() ? w : null;
    }

    workspaceForWindow(win) {
      for (const [wsId, w] of this.windows) {
        if (w === win) return wsId;
      }
      return null;
    }

    windowForSession(name) {
      const s = this.sessions.get(name);
      if (!s) return null;
      return this.windowForWorkspace(s.workspaceId);
    }

    allLiveWindows() {
      const out = [];
      for (const w of this.windows.values()) {
        if (w && !w.isDestroyed()) out.push(w);
      }
      return out;
    }

    quotaStore() {
      if (this._quotaStore !== undefined) return this._quotaStore;
      try {
        const { QuotaStore } = require('./wire/quota');
        this._quotaStore = new QuotaStore({
          // userData, not run/<name>/, which is removed on every exit path.
          path: path.join(getUserDataPath(), 'wire-quota.sqlite'),
          // Message string only: these headers ride the same response as an authorization header, so never log an object.
          onError: (message) => this._shadowLog({ type: 'wire-quota-store-error', error: message }),
        });
      } catch (e) {
        this._shadowLog({ type: 'wire-quota-unavailable', error: e.message });
        this._quotaStore = null;
      }
      return this._quotaStore;
    }

    _quotaPayload(store) {
      const latest = store.snapshot();
      if (!latest) return null;
      return { accounts: store.snapshotAll(), latest };
    }

    _broadcastQuota() {
      const store = this.quotaStore();
      if (!store) return;
      try {
        const payload = this._quotaPayload(store);
        if (payload) this._broadcast('wire-quota', payload);
      } catch (e) {
        this._shadowLog({ type: 'wire-quota-error', error: e.message });
      }
    }

    _sendToSession(name, channel, ...args) {
      const win = this.windowForSession(name);
      if (win) {
        win.webContents.send(channel, ...args);
        return;
      }
      if (channel === 'pty-data') {
        const session = this.sessions.get(name);
        if (!session) return;
        if (!session.pendingOutput) session.pendingOutput = '';
        session.pendingOutput += args[1];
        const MAX_BUFFER = 2 * 1024 * 1024; // 2M UTF-16 code units per session, not bytes
        if (session.pendingOutput.length > MAX_BUFFER) {
          session.pendingOutput = escapeSafeTail(session.pendingOutput, MAX_BUFFER);
        }
      }
    }

    _broadcast(channel, ...args) {
      for (const w of this.allLiveWindows()) {
        w.webContents.send(channel, ...args);
      }
    }

    async create(name, type, cwd, extraArgs = [], resumeId = null, workspaceId = DEFAULT_WORKSPACE_ID, systemPromptBody = null, fork = false, proxy = null, agents = [], denyBuiltins = [], disabledTools = [], disabledSkills = [], injectSkills = [], systemPromptFile = null, appendPromptFiles = [], execCommands = [], intents = null, sessionEnv = null, mint = false, noWire = false, plugins = null, shellDeny = null, fixFor = null, io = 'pty', effort = null) {
      if (this.sessions.has(name) || this._creating.has(name)) {
        throw new Error(`Session "${name}" already exists`);
      }
      const reserve = adapterFor(type)?.account.bootstrap === 'xdg-overlay';
      if (reserve) this._creating.add(name);
      try {
        return await this._createReserved(...arguments);
      } finally {
        if (reserve) this._creating.delete(name);
      }
    }

    async _createReserved(name, type, cwd, extraArgs = [], resumeId = null, workspaceId = DEFAULT_WORKSPACE_ID, systemPromptBody = null, fork = false, proxy = null, agents = [], denyBuiltins = [], disabledTools = [], disabledSkills = [], injectSkills = [], systemPromptFile = null, appendPromptFiles = [], execCommands = [], intents = null, sessionEnv = null, mint = false, noWire = false, plugins = null, shellDeny = null, fixFor = null, io = 'pty', effort = null) {
      const freshBake = this._freshBakeOnce.delete(name);
      if (cwd) {
        let st = null;
        try { st = fs.statSync(cwd); } catch { /* missing — handled below */ }
        if (!st) throw new Error(`Directory does not exist: ${cwd}`);
        if (!st.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
      }
      const streamIo = io === 'stream';
      const streamSpec = streamIo ? streamFor(type) : null;
      if (streamIo && !streamSpec) throw new Error(`stream transport is not supported for ${type}`);
      const streamCtx = streamIo ? streamCodecCtx(type, extraArgs) : null;
      if (streamIo && resumeId) {
        const prior = getPersistence().get(name);
        const record = prior && prior.streamPid ? prior.streamPid : null;
        let decision = 'dead';
        try {
          decision = await reapBeforeResume({
            record,
            kill: streamProc.kill,
            isAlive: streamProc.isAlive,
            startTimeOf: streamProc.startTimeOf,
          });
        } catch (e) {
          log.warn('session', `stream reap ${name} failed: ${e.message}`);
        }
        log.info('session', `stream reap ${name}: ${decision}${record ? ` pid=${record.pid}` : ' (no record)'}`);
      }
      let mergedEnv;
      const baseEnv = { ...process.env };
      try {
        const store = getEnvScopes && getEnvScopes();
        const all = store ? store.all() : { global: {}, workspaces: {} };
        mergedEnv = mergeSessionEnv({
          base: baseEnv,
          global: all.global,
          workspace: (all.workspaces && all.workspaces[workspaceId]) || null,
          session: (sessionEnv && typeof sessionEnv === 'object') ? sessionEnv : null,
          overrideFile: path.join(getUserDataPath(), 'env-override.env'),
        });
      } catch {
        mergedEnv = { ...baseEnv };
      }

      const accountEnvKey = adapterFor(type)?.account.envKey || null;
      const accountDir = accountEnvKey ? mergedEnv[accountEnvKey] : null;
      if (accountDir) {
        let ok = false;
        try { ok = fs.statSync(accountDir).isDirectory(); } catch { ok = false; }
        if (!ok) throw new Error(`account dir ${accountDir} does not exist`);
      }
      let streamCodec = null;
      if (streamSpec) {
        const mod = loadStreamCodec(streamSpec.codec);
        const makeCodec = mod.create;
        const codecHome = accountDir && accountEnvKey === 'CODEX_HOME' ? { home: path.dirname(accountDir) } : {};
        streamCodec = typeof makeCodec === 'function'
          ? makeCodec({ cwd: cwd || process.env.HOME || os.homedir(), resumeId, fork, ...streamCtx, ...codecHome, log })
          : mod;
      }
      let seatConfigDir = null;
      let museSid = null;
      let museData = null;
      let codexLink = null;
      if (adapterFor(type)?.account.bootstrap === 'xdg-overlay') {
        seatConfigDir = pathFor(REGISTRY_DIR, name, 'seatConfig');
        const sourceConfig = accountDir || path.join(os.homedir(), '.config');
        const adapterSkills = adapterFor(type).skills || null;
        let skillsMerge = null;
        if (adapterSkills && Array.isArray(disabledSkills) && disabledSkills.length) {
          const roster = typeof platformSkills === 'function'
            ? platformSkills(adapterFor(type), { configDir: sourceConfig })
            : [];
          skillsMerge = activationSettings(adapterSkills, roster, disabledSkills, { injectSkills });
        }
        const seatSettings = adapterFor(type).seatSettings || null;
        const profileMerge = adapterFor(type).readOnlyCap?.settings || null;
        bootstrapSeatConfig({ fs, path }, {
          source: sourceConfig,
          seatDir: seatConfigDir,
          settingsMerge: (seatSettings || profileMerge || skillsMerge)
            ? deepMerge(deepMerge(seatSettings || {}, profileMerge || {}), skillsMerge || {})
            : null,
        });
        mergedEnv.XDG_CONFIG_HOME = seatConfigDir;
      }

      let proxyBase = resolveProxyBase(proxy, getUiSettings());
      // Nulling proxyBase is the wire-off switch itself: setupClaudeHook falls back to proxyBase when wireBase is
      // absent, so skipping only the wire registration would still set ANTHROPIC_BASE_URL through the external proxy.
      const wireOff = noWire === true;
      if (wireOff) proxyBase = null;
      const fixHost = (typeof fixFor === 'string' && fixFor) ? fixFor : null;

      if (accountDir && proxyBase && !adapterFor(type).account.bootstrap && accountDir !== claudeHome()) {
        Promise.resolve().then(() => ProxyClient.probe(proxyBase)).then((probe) => {
          if (!probe || !probe.capabilities || !probe.capabilities.accounts) return;
          return ProxyClient.registerAccount(proxyBase, accountDir);
        }).catch((e) => log.warn('session', `account register ${accountDir} skipped: ${e.message}`));
      }

      let cmd, args;
      const shell = process.env.SHELL || '/bin/bash';
      const warnings = [];
      const agentType = isAgentType(type) ? type : null;
      const effortResolved = agentType ? resolveEffort(type, effort) : null;
      if (effortResolved && typeof effortResolved === 'object') warnings.push(`${effortResolved.error}; spawned at the CLI's default effort.`);
      const effortLevel = typeof effortResolved === 'string' ? effortResolved : null;
      let intentSource = 'jsonl';
      let wireRouted = false;
      let spillArmedForRecord = false;
      let promptRecipe = null;
      const backend = agentType === 'claude' ? teeBlindBackend(readEffectiveClaudeEnv(cwd, { baseEnv: mergedEnv })) : null;
      if (backend && proxyBase) {
        this._shadowLog({ type: 'proxy-off-tee-blind', agent: name, backend });
        proxyBase = null;
      }

      let proxyAgent = null;
      if (agentType) {
        const taken = new Set();
        for (const e of getPersistence().list()) if (e.proxyAgent) taken.add(e.proxyAgent);
        for (const s of this.sessions.values()) if (s.proxyAgent) taken.add(s.proxyAgent);
        // The external proxy id is minted from the wire label, not the seat name, which is recycled and renamed.
        // registerAgent keeps the bare name: `t.agent` is a sessions-map key and wire-telemetry prunes against it.
        const existingEntry = getPersistence().get(name);
        const labelFrom = (existingEntry && existingEntry.wireLabel) || name;
        proxyAgent = resolveProxyAgentId({ name: labelFrom, fork, existing: existingEntry, taken });
      }

      // Fired before the PTY spawn: the hint rides the marked system prefix, so a flip after the first turn busts the cache.
      // Strict match on purpose: a lenient parser would hide typos like 'OFF' behind a block that silently reappears.
      const hintWant = mergedEnv.CLODEX_SPAWNER_HINT;
      const hintValid = hintWant === 'off' || hintWant === 'on';
      let spawnerHintSet = false;
      if (hintValid && proxyBase && proxyAgent) {
        spawnerHintSet = true;
        try {
          ProxyClient.spawnerHint(proxyBase, proxyAgent, { on: hintWant === 'on' })
            .catch((e) => log.warn('session', `spawner-hint(${hintWant}) ${proxyAgent} failed: ${e.message}`));
        } catch (e) {
          log.warn('session', `spawner-hint(${hintWant}) skipped: ${e.message}`);
        }
      } else if (hintWant && !hintValid) {
        log.warn('session', `spawner-hint: CLODEX_SPAWNER_HINT=${JSON.stringify(hintWant)} not recognized (expected "off" or "on") — no hint set for ${name}`);
      }

      // The hint POST lands before the session exists, so kill() cannot clear it when create throws before sessions.set;
      // the route would otherwise keep the row forever in a table with no TTL.
      const abandonHint = () => {
        if (!spawnerHintSet) return;
        try {
          ProxyClient.spawnerHint(proxyBase, proxyAgent, { clear: true }).catch(() => {});
        } catch {}
      };

      const existingEntry = getPersistence().get(name);
      const createdAt = (existingEntry && existingEntry.createdAt) || Date.now();

      const { teamBlock, teamName, resolvedTeam, missingPrompt } = this._teamBlockFor(name, cwd, agentType, systemPromptFile);
      if (missingPrompt) warnings.push(missingPrompt);

      const librarySkills = [];
      try {
        if (skillDeliveryProviders().includes(type)) {
          for (const rec of effectiveInjectedSkills(name, injectSkills)) {
            librarySkills.push({ name: rec.name, content: rec.content });
          }
        }
      } catch {}
      const seatBundles = () => (bundlesFor() || [])
        .filter((b) => seatHasPlugin(b.id, Array.isArray(plugins) ? plugins : null, b.shipped));
      const bundleSkills = (wanted) => (wanted || []).flatMap(
        (b) => (b.skills || []).map((s) => ({ name: `${b.id}:${s.name}`, content: s.content })));

      switch (type) {
        case 'claude': {
          cmd = 'claude';
          if (preseedClaudeOnboarding({ fs, path, homeDir: os.homedir(), cwd })) {
            this._shadowLog({ type: 'claude-onboarding-preseeded', agent: name });
          }
          const sysFile = resolveSystemPromptFile(systemPromptFile, Array.isArray(plugins) ? plugins : null, resolvedTeam);
          const spillVerbs = backend
            ? []
            : [...SPILL_VERBS].filter((k) => intentEnabled(k.split('.')[0], intents));
          spillArmedForRecord = spillVerbs.length > 0;
          promptRecipe = {
            extraArgs,
            intents,
            execCommands,
            spillArmed: spillVerbs.length > 0,
            spillExamples: existingEntry && existingEntry.ephemeral === true ? 1 : 2,
            // Captured at spawn like `intents`: refreshPrompt replays this object, so a member re-reading persistence
            // would make clear/compact stage a delta the spawn never baked.
            pluginGrants: (existingEntry && existingEntry.pluginGrants) || null,
            plugins: Array.isArray(plugins) ? plugins : null,
            appendPromptFiles,
            inlineBody: systemPromptBody || null,
            hasSystemFile: !!sysFile,
            ipcDisabled: mergedEnv.CLODEX_DISABLE_IPC_PROMPT === '1',
          };
          const { cleaned, realIpc } = this._realIpcFor(promptRecipe, teamBlock, resolvedTeam, name);
          args = cleaned;
          const staleSettings = args.findIndex(
            (a, i) => a === '--settings' && (args[i + 1] || '').startsWith('/tmp/wb-wrap/'));
          if (staleSettings !== -1) args.splice(staleSettings, 2);
          // Register with the in-process wire before the PTY exists (identity is spawn-bound), chaining to the external proxy.
          // A wire failure falls back to the normal path: a tee must never block a session from starting.
          let wireBase = null;
          if (WIRE_SHADOW && !wireOff) {
            try {
              const wire = await this._ensureWire();
              wireBase = wire.registerAgent(name, {
                sessionId: resumeId || null,
                upstreams: proxyBase
                  ? { anthropic: `${proxyBase}/agent/${proxyAgent || name}/anthropic` }
                  : null,
                spill: spillVerbs.length
                  ? {
                    root: REGISTRY_DIR,
                    verbs: spillVerbs,
                    turnInjected: () => this.sessions.get(name)?.lastSubmitInjected === true,
                    examples: existingEntry && existingEntry.ephemeral === true ? 1 : 2,
                  }
                  : null,
              });
            } catch (e) {
              console.error('wire shadow unavailable, spawning unshadowed:', e.message);
            }
          }
          wireRouted = !!wireBase;
          if (wireBase && WIRE_INTENTS_LIVE) {
            // Bedrock/Vertex seats route straight to AWS/GCP and ignore the injected ANTHROPIC_BASE_URL, so the wire tee never sees
            // turn.completed; keep the registration but take intents from the JsonlWatcher, which reads the transcript.
            if (backend) this._shadowLog({ type: 'wire-tee-blind', agent: name, backend });
            else intentSource = 'wire';
          }
          // A user-supplied --settings in extraArgs replaces the whole hooks block, so ipcdelta.sh and every other drain is absent
          // for that seat, which the frozen-prompt decision below depends on.
          let hookInstalled = false;
          if (!args.includes('--settings')) {
            if (Array.isArray(disabledSkills) && disabledSkills.includes('*')
                && typeof knownSkillNames !== 'function') {
              abandonHint();
              throw new Error('disabledSkills "*" needs the knownSkillNames dep');
            }
            const skillsOff = expandSkillsOff(disabledSkills, {
              known: Array.isArray(disabledSkills) && disabledSkills.includes('*') ? knownSkillNames() : [],
              injectSkills,
            });
            const settingsPath = setupClaudeHook(name, proxyBase, proxyAgent, denyBuiltins, disabledTools, skillsOff, wireBase, createdAt, Array.isArray(shellDeny) ? shellDeny : [], streamIo, effortLevel);
            args.push('--settings', settingsPath);
            hookInstalled = true;
          }
          if (!hookInstalled && effortLevel) warnings.push(`effort ${effortLevel} not applied: the seat's extra args carry their own --settings.`);
          ensureDir(MSG_DIR);
          if (!args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
          if (getUiSettings().get().disableClaudeDesignMcp
              && !args.includes('--strict-mcp-config')
              && !args.includes('--mcp-config')) {
            let probe = null;
            if (proxyBase) {
              try { probe = await ProxyClient.probe(proxyBase); } catch {}
            }
            const reason = strictMcpReason(proxyBase, probe);
            if (reason) {
              args.push('--strict-mcp-config');
              this._broadcast('ipc-message', {
                type: 'system', from: name, to: name,
                body: `MCP: all MCP servers disabled for this session (--strict-mcp-config) — ${STRICT_MCP_EXPLANATION[reason]}.`,
              });
            }
          }
          // Sample before the agents block pushes its own --plugin-dir, or the skills gate reads our push as the user's
          // and drops every injected skill; a user plugin dir replaces the skills scaffold but must not drop the agent library.
          const userPluginDir = args.includes('--plugin-dir');
          const agentRecords = effectiveInjectedAgents(name, agents);
          const injectedAgents = [];
          const injectedSkills = [];
          if (!args.includes('--agents')) {
            const agentPluginDir = writeAgentPlugin(name, agents);
            if (agentPluginDir) args.push('--plugin-dir', agentPluginDir);
            for (const rec of agentRecords) injectedAgents.push({ ...rec, qualified: qualifiedAgentName(rec.name) });
          } else {
            cleanupAgentPlugin(name);
          }
          if (!userPluginDir) {
            const delivery = deliverSkills('claude', name, librarySkills);
            if (delivery) args.push(...delivery.args);
            for (const rec of librarySkills) injectedSkills.push({ ...rec });
            try {
              for (const b of writeBundles(name, seatBundles())) {
                args.push('--plugin-dir', b.dir);
                for (const s of b.skills) injectedSkills.push({ name: `${b.id}:${s.name}`, content: s.content });
                for (const a of b.agents) injectedAgents.push({ ...a, qualified: `${b.id}:${a.name}`, bundle: true });
              }
            } catch (e) {
              warnings.push(`Plugin-owned skills and agents could not be scaffolded for this session: ${(e && e.message) || e}`);
            }
          } else {
            cleanupSkills('claude', name);
          }
          for (const rec of injectedAgents) {
            const dropped = DROPPED_AGENT_FIELDS.filter((f) => (rec.meta || {})[f]);
            if (dropped.length) {
              warnings.push(`Agent "${rec.bundle ? rec.qualified : rec.name}" sets ${dropped.join(', ')}, which the plugin loader ignores — that field has no effect on this session. Move the agent to .claude/agents/ if you need it.`);
            }
          }
          try {
            if (injectedSkills.length) {
              const deny = Array.isArray(denyBuiltins) ? denyBuiltins : [];
              // Injected agents match by qualified name only (a skill naming a bare `test-runner` does not dispatch);
              // built-ins keep bare names.
              const enabled = new Set([
                ...injectedAgents.map((a) => a.qualified),
                ...BUILTIN_AGENTS.filter((b) => !deny.includes(b)),
              ]);
              for (const { skill, ref } of unresolvedSubagentRefs(injectedSkills, enabled)) {
                const owner = injectedAgents.find((a) => a.name === ref);
                const hint = owner
                  ? ` Use "${owner.qualified}" — injected subagents are namespaced.`
                  : ' Enable it (or remove the deny) in the session\'s agents.';
                warnings.push(`Skill "${skill}" calls subagent "${ref}", which isn't enabled for this session — that delegation will fail.${hint}`);
              }
            }
          } catch {}
          if (streamIo) {
            args.unshift(...streamSpec.argv({ resumeId, sessionId: randomUUID(), fork, ...streamCtx }));
          } else if (resumeId && !args.includes('--resume') && !args.includes('-r')) {
            args.push('--resume', resumeId);
            if (fork && !args.includes('--fork-session')) args.push('--fork-session');
          }
          if (sysFile && !args.includes('--system-prompt-file') && !args.includes('--system-prompt')) {
            args.push('--system-prompt-file', sysFile);
          }
          const promptPath = pathFor(REGISTRY_DIR, name, 'appendPrompt');
          // Freeze on resume only with resumeId, !mint and hookInstalled: a mint must regenerate (a dead namesake's frozen bytes are
          // a stranger's prompt), and without ipcdelta.sh a staged delta is never delivered, so freezing is permanent staleness.
          if (resumeId && !mint && !hookInstalled) {
            warnings.push(`This session's own --settings replaces Clodex's hooks, so the IPC protocol-change channel isn't installed. Its system prompt will be regenerated on every resume instead of frozen — correct, but it re-reads the whole prompt each time.`);
          }
          const reuse = !!resumeId && !mint && hookInstalled;
          const freeze = reuse && !freshBake;
          const baked = bakePrompt(REGISTRY_DIR, name, realIpc, freeze,
            { snapshot: freeze ? this._snapshotBlockFor(name, cwd, accountDir, resumeId) : null });
          // Enqueue per session here, not in a startup fan-out (a seat unarchived weeks later would learn nothing);
          // the else clears so a mint never delivers the undrained notice of a dead namesake.
          try {
            if (reuse) {
              const notice = versionNoticeFor(existingEntry && existingEntry.appVersion, appVersion);
              if (notice) enqueueNotice(REGISTRY_DIR, name, notice);
            } else {
              clearNotices(REGISTRY_DIR, name);
            }
          } catch { /* an advisory must never block a spawn */ }
          // Link and dir are made here because setupClaudeHook, which normally makes them, is skipped for a user --settings;
          // without them the write ENOENTs and the seat is exempt from the seat layout (ensureSeatLink never adopts a real legacy dir).
          ensureSeatLink({ root: REGISTRY_DIR, name, kind: 'run', fs });
          ensureDir(runDirFor(REGISTRY_DIR, name));
          fs.writeFileSync(promptPath, baked, { mode: 0o600 });
          args.push('--append-system-prompt-file', promptPath);
          break;
        }
        case 'codex': {
          cmd = 'codex';
          const seatPlugins = Array.isArray(plugins) ? plugins : null;
          const codexSystemBody = readSystemPromptBody
            ? readSystemPromptBody(systemPromptFile, seatPlugins, resolvedTeam)
            : (systemPromptFile ? getPromptLibrary().raw('system', systemPromptFile) : null);
          const codexAppendBodies = readAppendBodies(appendPromptFiles, seatPlugins, resolvedTeam);
          const codexIpc = mergedEnv.CLODEX_DISABLE_IPC_PROMPT === '1'
            ? null
            : buildIpcPrompt(intents, this._resolveExecDefs(execCommands, resolvedTeam), pluginGrammarLines(intents, Array.isArray(plugins) ? plugins : null),
              { teamLead: !!resolvedTeam && resolvedTeam.lead === name });
          const { cleaned, merged } = mergeCodexInstructions(extraArgs, codexIpc, {
            systemBody: codexSystemBody, appendBodies: codexAppendBodies, inlineBody: systemPromptBody || null,
          });
          args = [...cleaned];
          if (streamIo) {
            const stripped = stripCodexStreamArgs(args);
            args = stripped.args;
            if (stripped.dropped.length) log.info('session', `stream ${name}: codex app-server refuses ${[...new Set(stripped.dropped)].join(' ')}; posture and model ride the codec`);
          }
          setupCodexHook(name, cwd);
          if (!args.includes('hooks') && !args.includes('codex_hooks')) args.push('--enable', 'hooks');
          if (!streamIo && !args.includes('--no-alt-screen')) args.push('--no-alt-screen');
          if (!streamIo && !args.some(a => a.startsWith('tui.status_line'))) {
            args.push('-c', codexStatusLineArg(getUiSettings()));
          }
          if (effortLevel && !args.some((a) => typeof a === 'string' && a.startsWith('model_reasoning_effort='))) {
            args.push('-c', `model_reasoning_effort="${effortLevel}"`);
          }
          ensureDir(MSG_DIR);
          if (!streamIo && !args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
          if (streamIo && streamCtx.model && !args.some((a) => /^model=/.test(a))) args.push('-c', `model="${streamCtx.model}"`);
          const codexSkills = deliverSkills('codex', name, [...librarySkills, ...bundleSkills(seatBundles())]);
          const codexBody = codexSkills && codexSkills.instructions
            ? `${merged}\n\n${codexSkills.instructions}`
            : merged;
          if (codexSkills) args.push(...codexSkills.args);
          const instructionsPath = pathFor(REGISTRY_DIR, name, 'instructions');
          fs.writeFileSync(instructionsPath, teamBlock ? `${codexBody}\n\n${teamBlock}\n` : codexBody, { mode: 0o600 });
          args.push('-c', `model_instructions_file=${instructionsPath}`);
          if (proxyBase && !args.some(a => a.startsWith('openai_base_url='))) {
            args.push('-c', `openai_base_url=${proxyBase}/agent/${proxyAgent || name}/openai/v1`);
          }
          if (streamIo) {
            args.unshift(...streamSpec.argv({ resumeId, sessionId: null, fork, ...streamCtx }));
          } else if (resumeId) {
            const uuidMatch = resumeId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
            const uuid = uuidMatch ? uuidMatch[1] : resumeId;
            args.push(fork ? 'fork' : 'resume', uuid);
          }
          if (!streamIo) {
            codexLink = {
              home: mergedEnv.CODEX_HOME || path.join(os.homedir(), '.codex'),
              sessionId: resumeId && !fork ? (resumeId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i) || [null, resumeId])[1] : null,
              cwd: cwd || process.env.HOME || os.homedir(),
            };
          }
          break;
        }
        case 'muse': {
          cmd = 'muse';
          const seatPlugins = Array.isArray(plugins) ? plugins : null;
          const museSystemBody = readSystemPromptBody
            ? readSystemPromptBody(systemPromptFile, seatPlugins, resolvedTeam)
            : (systemPromptFile ? getPromptLibrary().raw('system', systemPromptFile) : null);
          const museAppendBodies = readAppendBodies(appendPromptFiles, seatPlugins, resolvedTeam);
          const museIpc = mergedEnv.CLODEX_DISABLE_IPC_PROMPT === '1'
            ? null
            : buildIpcPrompt(intents, this._resolveExecDefs(execCommands, resolvedTeam), pluginGrammarLines(intents, seatPlugins),
              { teamLead: !!resolvedTeam && resolvedTeam.lead === name });
          const museMerged = mergeInstructionBodies(museIpc, {
            systemBody: museSystemBody, appendBodies: museAppendBodies, inlineBody: systemPromptBody || null,
          });
          const museSkills = deliverSkills('muse', name, [...librarySkills, ...bundleSkills(seatBundles())]);
          if (museSkills?.skillsDir) fs.symlinkSync(museSkills.skillsDir, path.join(seatConfigDir, 'muse', 'skills'));
          fs.writeFileSync(path.join(seatConfigDir, 'muse', 'AGENTS.md'),
            `You are the clodex agent named '${name}'.\n\n${teamBlock ? `${museMerged}\n\n${teamBlock}\n` : museMerged}`, { mode: 0o600 });
          museSid = resumeId || null;
          let museProbe = null;
          if (proxyBase) { try { museProbe = await ProxyClient.probe(proxyBase); } catch {} }
          const museRouted = !!(proxyBase && museProbe && museProbe.capabilities && museProbe.capabilities.muse);
          if (proxyBase && !museRouted) {
            warnings.push(`muse: wirescope at ${proxyBase} does not report capabilities.muse — this seat talks to Meta directly, unrouted.`);
          }
          const museRoute = museRouted ? `${proxyBase}/agent/${proxyAgent || name}/meta` : null;
          const museBaseUrl = museRoute ? ['--base-url', museRoute] : [];
          const museEffortArgs = (effortLevel && !extraArgs.some((a) => typeof a === 'string' && (a === '--reasoning-effort' || a.startsWith('--reasoning-effort='))))
            ? ['--reasoning-effort', effortLevel] : [];
          const museEnv = { ...mergedEnv, CLODEX_HOME: REGISTRY_DIR, MUSE_NO_AUTO_UPDATE: '1' };
          museData = museDataHome({ env: museEnv, os, path });
          if (streamIo) {
            ensureDir(runDirFor(REGISTRY_DIR, name));
            const museSeatPatch = {
              ...(museRoute ? { endpoint_transport: { base_url: museRoute } } : {}),
              ...(effortLevel ? { reasoning_effort: effortLevel } : {}),
            };
            if (Object.keys(museSeatPatch).length) {
              const museSettingsPath = path.join(seatConfigDir, 'muse', 'settings.json');
              try {
                const museSettings = JSON.parse(fs.readFileSync(museSettingsPath, 'utf-8'));
                fs.writeFileSync(museSettingsPath,
                  `${JSON.stringify(deepMerge(museSettings, museSeatPatch), null, 2)}\n`, { mode: 0o600 });
              } catch (e) {
                abandonHint();
                throw e;
              }
            }
            if (extraArgs.length) log.info('session', `stream ${name}: muse serve takes no TUI flags, dropped ${extraArgs.join(' ')}; posture and model ride the codec`);
            args = streamSpec.argv({ resumeId, sessionId: museSid, fork, ...streamCtx });
          } else if (museSid) {
            const museTranscript = findMuseTranscript({ fs, path }, museData, museSid);
            if (!museTranscript) {
              abandonHint();
              throw new Error(`muse session ${museSid} has no transcript under ${museData}`);
            }
            ensureDir(runDirFor(REGISTRY_DIR, name));
            linkTranscript({ fs }, pathFor(REGISTRY_DIR, name, 'transcript'), museTranscript);
            if (fork) warnings.push(`muse has no fork: resuming session ${museSid} instead.`);
            args = [...extraArgs, ...museEffortArgs, '--trust-workspace', '--provider', 'meta', ...museBaseUrl, 'resume', museSid];
          } else {
            ensureDir(runDirFor(REGISTRY_DIR, name));
            args = [...extraArgs, ...museEffortArgs, '--trust-workspace', '--provider', 'meta', ...museBaseUrl];
          }
          break;
        }
        case 'bash':
          cmd = shell;
          args = [...extraArgs];
          break;
        default:
          cmd = type;
          args = [...extraArgs];
      }

      // App-owned keys applied after the scope merge override env scopes: CLODEX_HOME must match the tree the exec route uses,
      // and FORCE_HYPERLINK removes inheritance of how Clodex was launched (terminal vs Finder); link clicks scan rendered text.
      const env = withUtf8Charset({ ...mergedEnv, TERM: 'xterm-256color', CLODEX_HOME: REGISTRY_DIR, FORCE_HYPERLINK: '1' });
      if (type === 'codex') env.WB_WRAP_NAME = name;
      if (type === 'muse') env.MUSE_NO_AUTO_UPDATE = '1';

      let ptyProc = null;
      let streamSeat = null;
      const streamEarly = [];
      let streamRoute = (ev) => { streamEarly.push(ev); };
      const ptyEarly = [];
      let ptyExitRoute = (ev) => { ptyEarly.push(ev); };
      const unwindSpawn = () => {
        abandonHint();
        if (streamSeat) streamSeat.kill();
        if (ptyProc) { try { ptyProc.kill(); } catch {} }
      };
      try {
        if (streamIo) {
          streamSeat = spawnStreamSeat({
            cmd,
            args,
            cwd: cwd || process.env.HOME || os.homedir(),
            env,
            log,
            onLine: (obj) => streamRoute({ line: obj }),
            onClose: (code, signal) => streamRoute({ close: { code, signal } }),
          });
          if (!(streamSeat.pid > 0)) throw new Error(`spawn ${cmd} failed: no pid`);
        } else {
          ptyProc = pty.spawn(cmd, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd: cwd || process.env.HOME || os.homedir(),
            env,
          });
          ptyProc.onExit((ev) => ptyExitRoute(ev));
        }
      } catch (e) {
        unwindSpawn();
        const d = collectSystemDiagnostics();
        const resolved = whichBin(cmd);
        const warning = diagWarning(d);
        throw new Error(
          `${e.message}${warning ? ` — ${warning}` : ''} `
          + `[cmd=${cmd} resolved=${resolved || 'NOT FOUND on PATH'} `
          + `cwd=${cwd || '(home)'} ${diagSummary(d)}]`,
        );
      }

      let transport = null;
      let socketPath = null;
      if (agentType) {
        ensureDir(runDirFor(REGISTRY_DIR, name));
        socketPath = pathFor(REGISTRY_DIR, name, 'socket');

        // Probe before binding: Transport.start() unlinks the name-derived socketPath, so a probe after the bind reports live even
        // for a ghost whose recycled pid isAlive() would otherwise wedge the name; a null verdict keeps the pid-only check.
        let blockerLive = null;
        // The verdict describes these bytes only: the probe awaits, so a record replaced meanwhile must not inherit it
        // (else `blockerLive === false` force-cleans a live agent).
        let blockerRaw = null;
        try {
          blockerRaw = fs.readFileSync(pathFor(REGISTRY_DIR, name, 'registry'), 'utf-8');
          const blocker = JSON.parse(blockerRaw);
          if (blocker && blocker.socket) {
            blockerLive = await Transport.isSocketLive(blocker.socket);
          }
        } catch {}

        // Register first, bind second: Transport.start() and a force-clean both unlink the name-derived socket, and doing so after
        // our own bind pulls the inode from under a live net.Server that keeps listening, unreachable.
        try {
          registry.register(name, socketPath, cwd);
        } catch (e) {
          if (e.code !== 'EEXIST') { unwindSpawn(); throw e; }
          let existingRaw = null;
          let existing = {};
          try {
            existingRaw = fs.readFileSync(pathFor(REGISTRY_DIR, name, 'registry'), 'utf-8');
            existing = JSON.parse(existingRaw) || {};
          } catch {}
          if (existingRaw !== blockerRaw) blockerLive = null;
        // Proven-not-live overrides isStaleRegistration (null keeps the pid verdict); proven-live vetoes the own-pid clause, since
        // two concurrent creates both pass sessions.has() before the map is written and the second would rebind over the first.
          if (blockerLive === false || (blockerLive !== true && isStaleRegistration(existing.pid, process.pid, isAlive))) {
            registry.unregister(name);
            try { fs.unlinkSync(existing.socket); } catch {}
            registry.register(name, socketPath, cwd);
          } else {
            unwindSpawn();
            throw new Error(
              `Session "${name}" is already running elsewhere (pid ${existing.pid})`,
            );
          }
        }

        transport = new Transport(socketPath, (msg) => {
          this._onIncoming(name, msg);
        });
        try {
          await transport.start();
        } catch (e) {
          unwindSpawn();
          registry.unregister(name);
          transport = null;
          throw e;
        }
      }

      const session = {
        name, type, cwd, pty: ptyProc, transport, socketPath,
        io: streamIo ? 'stream' : 'pty',
        ...(streamIo ? {
          stream: streamSeat,
          streamCodec,
          outbox: [],
          streamPid: { pid: streamSeat.pid, startTime: streamSeat.startTime ?? streamSeat.startedAt },
        } : {}),
        spawnedAt: Date.now(),
        createdAt,
        agentType, lineBuffer: '', watcher: null,
        sessionId: resumeId || null,
        accountDir: seatConfigDir || accountDir || null,
        forked: !!fork,
        workspaceId,
        proxyAgent, proxyBase,
        // Recorded from the POST actually made, not re-read in kill(): env can change under a live seat, and a clear
        // driven by the new value would leak a row or clear one this seat never set.
        spawnerHintSet,
        // Never persisted: its absence from a resumed record is the signal that this process was not handed its open tickets'
        // specs (_replayOpenTickets); sessionId cannot serve because --resume carries the same id.
        incarnation: nextIncarnation(),
        // Not named `proxy`: _handleSpawnIntent and _handleTeamReview read `.proxy ?? null` off the live session and expect null,
        // so naming it proxy would make a child silently inherit its spawner's route.
        proxyRequested: typeof proxy === 'string' ? normalizeProxyBase(proxy) : (proxy === false ? false : null),
        intentSource, wireRouted, backend, noWire: wireOff, sentinel: null,
        ...(fixHost ? { fixFor: fixHost } : {}),
        fileTouches: [],
        filedRing: this._seedFiledRing(name),
        // Defensive because this runs after the agent socket is bound: an absent observer dep must degrade to no feed,
        // never throw out of create() and strand a listening socket.
        subagentStore: createSubagentStore ? createSubagentStore() : null,
        // Restores seed from the resumed transcript's mtime (the last real turn): seeding now would reset idle clocks on every GUI
        // restart and let DMs to long-cold peers past the hold gate for 30 minutes.
        activityState: 'idle',
        // Math.min clamps a future mtime (NFS, rsync -t, clock step): a future seed would stick, keep idleMs negative,
        // and make `idleMs < DM_HOLD_IDLE_MS` always true, so the seat could never be held.
        activityTs: Math.min(lastTranscriptWrite(agentType, cwd, resumeId) || Date.now(), Date.now()),
        needsAttention: null,
        // A spawned or resumed CLI is parked at its prompt; without this seed a GUI restart wipes the turn.completed stamp
        // and an idle restored seat can never pass the auto-compact atPrompt guard.
        lastMainStop: { isTurn: true, ts: Date.now(), seeded: true },
        lastSubmitInjected: false,
        bootResumeId: resumeId || null,
        promptRecipe,
        // Recompute, do not re-write: setupClaudeHook already wrote the digest file pre-spawn, and a rewrite here
        // would race the SessionStart hook cat-ing it (writeFileSync is not atomic).
        digestNonEmpty: agentType === 'claude' && composeDigest(memoryStore.list(name)) !== null,
      };
      this.sessions.set(name, session);

      // Recomposed here: the hook cats the digest only for source startup|clear|compact, so a resumed session gets none;
      // recording it would claim FULL for units the model never saw, hence a resume records nothing.
      if (agentType === 'claude' && !resumeId) {
        try { memLoad.noteDigest(name, tiersOf(memoryStore.list(name))); } catch { /* observer-grade */ }
      }

      getPersistence().upsert({
        name, type, cwd,
        extraArgs,
        createdAt,
        // Written unconditionally: this is the advance half of the upgrade-notice comparison, and omitting it on any path
        // leaves the old version so every later resume re-enqueues the same notice.
        appVersion,
        sessionId: resumeId || null,
        workspaceId,
        systemPrompt: systemPromptBody || null,
        systemPromptFile: systemPromptFile || null,
        appendPromptFiles: Array.isArray(appendPromptFiles) ? appendPromptFiles : [],
        proxy: typeof proxy === 'string' ? normalizeProxyBase(proxy) : (proxy === false ? false : null),
        proxyAgent,
        // Written unconditionally, even `false`: upsert spread-merges (stores.js), so omitting it leaves a stale `true` and the
        // exits that drop the record without a session (forget, reviewer sweep) would clear a row this seat never set.
        spawnerHintSet,
        agents: Array.isArray(agents) ? agents : [],
        // Written unconditionally like spawnerHintSet: upsert spread-merges, so omitting `false` leaves a stale `true`
        // and the seat silently stays wire-off after being turned back on.
        noWire: wireOff,
        intentSpill: spillArmedForRecord && wireRouted,
        io: streamIo ? 'stream' : 'pty',
        effort: effortLevel,
        streamPid: streamIo ? { pid: streamSeat.pid, startTime: streamSeat.startTime ?? streamSeat.startedAt } : null,
        ...(fixHost ? { fixFor: fixHost } : {}),
        denyBuiltins: Array.isArray(denyBuiltins) ? denyBuiltins : [],
        disabledTools: Array.isArray(disabledTools) ? disabledTools : [],
        ...(Array.isArray(shellDeny) ? { shellDeny } : {}),
        disabledSkills: Array.isArray(disabledSkills) ? disabledSkills : [],
        injectSkills: Array.isArray(injectSkills) ? injectSkills : [],
        // Persisted by create's own upsert so it survives kill()+recreate, which rebuilds the record from spawn args only;
        // an absent list must stay absent (never freeze `intents: null`) while `[]` is a real value.
        ...(Array.isArray(intents) ? { intents: intents.map(String) } : {}),
        // Same conditional-omit rule as `intents`: an absent plugins list means core-shipped only, never freeze `null`.
        ...(Array.isArray(plugins) ? { plugins: plugins.map(String) } : {}),
        ...(Array.isArray(execCommands) && execCommands.length ? { execCommands: execCommands.map(String) } : {}),
        // Persisted so --resume respawns with the same env (a wrong AWS identity would be silent); sanitizeFlat re-applies the
        // key/deny/newline gate at the persistence door so a junk key or value never lands on sessions.json.
        ...(() => {
          const clean = sanitizeFlat(sessionEnv);
          return Object.keys(clean).length ? { env: clean } : {};
        })(),
      });
      if (existingEntry && existingEntry.exitedAt) getPersistence().setExited(name, null);

      const onSessionId = (sessionId) => {
        const priorSid = session.sessionId;
        if (priorSid && sessionId && priorSid !== sessionId) {
          try { this._stampSeatCost(session, 'clear'); } catch {}
        }
        session.sessionId = sessionId;
        getPersistence().setSessionId(name, sessionId);
        if (sessionId && priorSid !== sessionId) this._repointStreamTranscript(session, sessionId);
        // Must run before memLoad.noteSession, which owns the same transition but reports nothing back; the first id
        // (attach, resume) is not a clear and must not reset.
        if (priorSid && sessionId && priorSid !== sessionId) {
          this._noteSessionLeft(session, priorSid);
          try { if (this._holdKeeper) this._holdKeeper.endSession(priorSid); } catch { /* observer-grade */ }
          session._holdRearmed = false;
          try { arm.onContextReset(name); } catch { /* observer-grade */ }
          this._voidScratchMark(session,
            'the conversation was cleared after the mark — every mark is gone and nothing can be cut. '
            + 'Your summary is in your own turn above; carry on from it.');
          // Refresh before the continuation: the clear discarded every delivered delta, so the gap is re-staged for the new
          // conversation's first turn. The CLI rebuilds its system block from its own snapshot, so the frozen prompt file is left alone.
          const snapshotSid = session.forked ? sessionId : priorSid;
          session.forked = false;
          try { this.refreshPrompt(name, 'clear', { sid: snapshotSid }); } catch { /* never block the continuation on a refresh */ }
          this._firePostClearContinuation(session);
        }
        // noteSession resets only on a change, so the first id (attach, resume) adopts; otherwise the digest recorded in
        // create() a moment earlier would be wiped by the very event that carried it.
        try { memLoad.noteSession(name, sessionId); } catch { /* observer-grade */ }
        this._noteConversationForDigest(session, sessionId);
      };
      if (agentType && session.intentSource === 'wire') {
        const { TranscriptSentinel } = require('./wire-intents');
        session.sentinel = new TranscriptSentinel({
          linkPath: pathFor(REGISTRY_DIR, name, 'transcript'),
          onSessionId,
          makeWatcher: ({ onText, onCompactSummary }) => new JsonlWatcher(
            name, onText || (() => {}), () => {}, () => {}, onCompactSummary || (() => {}),
            undefined, { reader: readerFor(adapterFor(agentType).transcript.reader) }),
        });
        session.sentinel.start();
      } else if (agentType) {
        session.watcher = new JsonlWatcher(
          name,
          (text, touches, meta) => this._scanJsonlText(text, name, touches, meta),
          onSessionId,
          (state, turnEnd) => this._emitActivity(name, state, state === 'idle' && !!turnEnd),
          () => this._fireCompactContinuation(session),
          (touches) => this._noteFileTouches(session, touches),
          { reader: readerFor(adapterFor(agentType).transcript.reader) },
        );
        session.watcher.start();
      }

      if (type === 'muse' && ptyProc && ptyProc.pid && museData) {
        let linkDone = null;
        session._museLinkDone = new Promise((resolve) => { linkDone = resolve; });
        const stop = (outcome) => { clearInterval(poll); clearTimeout(deadline); linkDone(outcome); };
        const poll = setInterval(() => {
          if (this.sessions.get(name) !== session) { stop('gone'); return; }
          const rec = museRegistryFor({ fs, path }, museData, ptyProc.pid);
          const sid = rec && typeof rec.session_id === 'string' ? rec.session_id : null;
          if (!sid) return;
          if (sid === session.sessionId) { stop('agreed'); return; }
          const target = findMuseTranscript({ fs, path }, museData, sid);
          if (!target) return;
          try { linkTranscript({ fs }, pathFor(REGISTRY_DIR, name, 'transcript'), target); } catch { return; }
          stop('linked');
        }, this._museLinkPollMs ?? MUSE_LINK_POLL_MS);
        const deadline = setTimeout(() => {
          if (this.sessions.get(name) !== session) { stop('gone'); return; }
          if (session.sessionId) {
            stop('deadline');
            log.info('muse', `${name}: registry never confirmed ${session.sessionId} for pid ${ptyProc.pid} within ${MUSE_LINK_DEADLINE_MS} ms`);
            return;
          }
          const taken = [];
          let until = null;
          let seen = false;
          for (const [other, s] of this.sessions) {
            if (other === name) { seen = true; continue; }
            if (s.agentType !== 'muse') continue;
            const later = s.spawnedAt > session.spawnedAt || (s.spawnedAt === session.spawnedAt && seen);
            if (later && (until === null || s.spawnedAt < until)) until = s.spawnedAt;
            try { taken.push(fs.readlinkSync(pathFor(REGISTRY_DIR, other, 'transcript'))); } catch {}
          }
          const fallback = oldestMuseTranscript({ fs, path }, museData, session.spawnedAt, taken, until);
          if (fallback) {
            try {
              linkTranscript({ fs }, pathFor(REGISTRY_DIR, name, 'transcript'), fallback);
              stop('fallback');
              log.info('muse', `${name}: no session registered for pid ${ptyProc.pid} within ${MUSE_LINK_DEADLINE_MS} ms — linked transcript ${fallback}`);
              return;
            } catch {}
          }
          stop('deadline');
          log.warn('muse', `${name}: no session registered for pid ${ptyProc.pid} within ${MUSE_LINK_DEADLINE_MS} ms — transcript link pending`);
        }, MUSE_LINK_DEADLINE_MS);
        if (poll.unref) poll.unref();
        if (deadline.unref) deadline.unref();
      }

      if (type === 'codex' && ptyProc && codexLink) {
        let linkDone = null;
        session._codexLinkDone = new Promise((resolve) => { linkDone = resolve; });
        const linkPath = pathFor(REGISTRY_DIR, name, 'transcript');
        let slow = null;
        const stop = (outcome) => { clearInterval(poll); clearInterval(slow); clearTimeout(deadline); linkDone(outcome); };
        const tick = () => {
          if (this.sessions.get(name) !== session) { stop('gone'); return; }
          if (!codexLink.sessionId && !session.firstInputAt) return;
          const taken = [];
          if (!codexLink.sessionId) {
            for (const [other, s] of this.sessions) {
              if (other === name || s.agentType !== 'codex') continue;
              try { taken.push(fs.readlinkSync(pathFor(REGISTRY_DIR, other, 'transcript'))); } catch {}
            }
          }
          const target = findCodexRollout({ fs, path }, codexLink.home, {
            sessionId: codexLink.sessionId, cwd: codexLink.cwd, sinceMs: codexLink.sessionId ? session.spawnedAt : session.firstInputAt, excludePaths: taken,
          });
          if (!target) return;
          try {
            ensureDir(runDirFor(REGISTRY_DIR, name));
            linkTranscript({ fs }, linkPath, target);
          } catch { return; }
          stop('linked');
        };
        const poll = setInterval(tick, this._codexLinkPollMs ?? CODEX_LINK_POLL_MS);
        const deadline = setTimeout(() => {
          clearInterval(poll);
          if (this.sessions.get(name) !== session) { stop('gone'); return; }
          log.warn('codex', `${name}: no rollout under ${path.join(codexLink.home, 'sessions')} after ${CODEX_LINK_DEADLINE_MS / 1000} s — still polling every ${CODEX_LINK_SLOW_POLL_MS / 1000} s`);
          slow = setInterval(tick, this._codexLinkSlowPollMs ?? CODEX_LINK_SLOW_POLL_MS);
          if (slow.unref) slow.unref();
        }, this._codexLinkDeadlineMs ?? CODEX_LINK_DEADLINE_MS);
        if (poll.unref) poll.unref();
        if (deadline.unref) deadline.unref();
      }

      if (agentType === 'claude') {
        const ctxPath = pathFor(REGISTRY_DIR, name, 'ctx');
        let lastRaw = null;
        const readCtx = () => {
          try {
            const raw = fs.readFileSync(ctxPath, 'utf-8').trim();
            if (raw === lastRaw) return;
            lastRaw = raw;
            const c = parseCtxFile(raw);
            if (c.pct != null) {
              this._sendToSession(name, 'session-ctx', name, c.pct, c.tok, c.size, c.cost, c.modelName);
              session.ctxInfo = { pct: c.pct, tok: c.tok, size: c.size, cost: c.cost, modelName: c.modelName };
              if (getRemoteServer()) {
                try { getRemoteServer().pushTelemetry(name, { ctx: session.ctxInfo }); } catch {}
              }
              const warnPath = pathFor(REGISTRY_DIR, name, 'ctxwarn');
              // Gate on the CTX_THRESHOLD_MIN floor, not the shipped nudge: sanitizeThresholdPair drops rows below it, so this skips the
              // ui-settings re-parse for a quiet session without capping how low an operator can set the threshold.
              let ctxOverrides = null;
              if (c.tok >= CTX_THRESHOLD_MIN) {
                try { ctxOverrides = getUiSettings().get().ctxReminderThresholds; } catch {}
              }
              let warn = ctxReminderFor(c.tok, ctxThresholdsFor(c.model, ctxOverrides));
              // Ephemeral seats are never nudged (a compact costs the context their rework needs), suppressed here so ctxReminderFor stays pure.
              // Read the record lazily and memoize only a returned one, so a failed read leaves the seat nudged rather than silenced.
              if (warn) {
                if (session._ephemeralSeat === undefined) {
                  let rec = null;
                  try { rec = getPersistence().get(name); } catch {}
                  if (rec) session._ephemeralSeat = !!rec.ephemeral;
                }
                if (session._ephemeralSeat) warn = null;
              }
              try {
                if (warn) fs.writeFileSync(warnPath, warn);
                else fs.rmSync(warnPath, { force: true });
              } catch {}
            }
          } catch {}
        };
        const attnPath = pathFor(REGISTRY_DIR, name, 'attn');
        let attnOffset = 0;
        const readAttn = () => {
          try {
            const st = fs.statSync(attnPath);
            if (st.size <= attnOffset) return;
            const fd = fs.openSync(attnPath, 'r');
            const buf = Buffer.alloc(st.size - attnOffset);
            fs.readSync(fd, buf, 0, buf.length, attnOffset);
            fs.closeSync(fd);
            attnOffset = st.size;
            for (const line of buf.toString('utf-8').split('\n')) {
              if (!line.trim()) continue;
              let entry = null;
              try { entry = JSON.parse(line); } catch {}
              this._routeAttnEntry(session, entry);
            }
          } catch { /* observer-grade */ }
        };
        try {
          session.ctxWatcher = fs.watch(runDirFor(REGISTRY_DIR, name), (_event, fname) => {
            if (fname === 'ctx') readCtx();
            else if (fname === 'attn.jsonl') readAttn();
          });
        } catch {}
        readCtx();
      }

      if (ptyProc) ptyProc.onData((data) => {
        session._lastPtyDataAt = Date.now();
        if (typeof session._bootNudgeEcho === 'string') session._bootNudgeEcho = (session._bootNudgeEcho + data).slice(-BOOT_NUDGE_ECHO_CAP);
        session.scrollback = ((session.scrollback || '') + data);
        if (session.scrollback.length > SCROLLBACK_MAX) {
          session.scrollback = session.scrollback.slice(-SCROLLBACK_MAX);
        }
        this._sendToSession(name, 'pty-data', name, data);
        if (getRemoteServer()) { try { getRemoteServer().pushOutput(name, data); } catch {} }

        if (data.includes('\x1b[?2004')) {
          session._pasteModeOn = pasteModeSignal(data, session._pasteModeOn);
          if (session._pasteModeOn && !session._bootReadySeen) {
            session._bootReadySeen = true;
            session._bootReadyAt = Date.now();
            clearTimeout(session._bootDrainTimer);
            session._bootDrainTimer = setTimeout(() => {
              session._bootDrainTimer = null;
              this._drainPendingAtBootReady(session);
              // Same margin: a ticket spec written before the readline loop is up is wiped by the boot re-render, and the replay
              // stamps it delivered, so the loss is silent until the next respawn.
              this._replayWhenQueueEmpty(session);
            }, BOOT_DRAIN_SETTLE_MS);
          }
        }

        if (!agentType) {
          this._scanPtyOutput(session, data);
        }

        if (session._bootSettling) this._armBootSettle(session);
      });

      const onProcExit = ({ exitCode, signal }) => {
        // Mark dead first: after exit any node-pty write/resize/kill throws an uncaught Napi::Error that aborts the app (SIGABRT),
        // so deferred ops bail on _dead.
        session._dead = true;
        log.info('session', `exit ${name} code=${exitCode}${signal ? ` signal=${signal}` : ''}`);
        const { expected, dropRecord, stampExited } = exitDisposition({
          agentType,
          userKilled: session._userKilled,
          shuttingDown: session._shuttingDown,
          archived: session._archived,
          moving: session._moving,
        });
        const missingTool = missingToolOnExit({
          expected, exitCode, signal,
          elapsedMs: Date.now() - (session.spawnedAt || 0), cmd, whichBin,
        });
        // Send session-exit before _cleanup so the renderer can still resolve session to workspace to window,
        // or the sidebar tab sticks around as a dead entry.
        this._sendToSession(name, 'session-exit', name, exitCode, { expected, signal: signal || null, agentType: agentType || null, missingTool });
        this._broadcast('ipc-message', {
          type: 'exit', from: name, to: 'exit',
          body: `code=${exitCode}${signal ? ` signal=${signal}` : ''}${expected ? '' : ' unexpected'}`,
        });
        if (getRemoteServer()) { try { getRemoteServer().notifyExit(name, exitCode); } catch {} }
        try { this._stampSeatCost(session, 'exit'); } catch {}
        if (dropRecord) {
          getPersistence().remove(name);
        }
        if (stampExited) {
          try { getPersistence().setExited(name, { exitCode, signal: signal || null }); } catch {}
        }
        try { getPluginHooks && getPluginHooks() && getPluginHooks().fireExit(name); } catch {}
        this._cleanup(name);
        if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
        if (typeof refreshAppMenu === 'function') refreshAppMenu();
      };
      if (ptyProc) {
        ptyExitRoute = onProcExit;
        setImmediate(() => { for (const ev of ptyEarly.splice(0)) onProcExit(ev); });
      } else {
        const opening = typeof streamCodec.open === 'function' ? streamCodec.open() : null;
        if (Array.isArray(opening) && opening.length) {
          session.streamBusy = true;
          this._emitActivity(name, 'thinking', false);
          for (const obj of opening) this._streamSend(session, obj);
          this._armStreamInitWatchdog(session);
        }
        streamRoute = (ev) => this._onStreamEvent(session, ev, onSessionId, onProcExit);
        for (const ev of streamEarly.splice(0)) streamRoute(ev);
      }
      const procPid = ptyProc ? ptyProc.pid : streamSeat.pid;

      if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
      if (typeof refreshAppMenu === 'function') refreshAppMenu();
      if (getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
      log.info('session', `spawn ${name} (${type}) pid=${procPid}${streamIo ? ' io=stream' : ''}${resumeId ? ' resumed' : ''} cwd=${cwd}`);
      if (resolvedTeam) {
        this._maybeInjectComposition(session, resolvedTeam, existingEntry);
        session._replayTicketsPending = true;
        if (streamIo) {
          if (resumeId) this._replayTicketsOnce(session);
          session._replayAtInit = !!session._replayTicketsPending;
        } else if (session.agentType !== 'claude') {
          session._bootSettling = true;
          session._bootSettleSince = Date.now();
          // The cap is not wall-clock: _settleBoot runs only from _armBootSettle, which runs only from onData, so a silent codex
          // seat never settles; this timer fires only when onData never ran (`!_bootSettleTimer`).
          session._replayFallbackTimer = setTimeout(() => {
            session._replayFallbackTimer = null;
            if (session._bootSettleTimer) return;
            this._replayTicketsOnce(session);
          }, INJECT_BOOT_MAXWAIT);
        } else {
          // Claude's replay rides the same BOOT_DRAIN_SETTLE_MS defer as the drain; the fallback covers a seat that never emits
          // mode-2004, where the edge-armed drain never runs and the spec would be lost for the life of the process.
          this._armReplayFallback(session, INJECT_BOOT_MAXWAIT, Date.now() + 3 * INJECT_BOOT_MAXWAIT);
        }
      }
      try { getPluginHooks && getPluginHooks() && getPluginHooks().fireCreate(name); } catch {}
      return { name, type, pid: procPid, backend, noWire: wireOff, ...(streamIo ? { io: 'stream' } : {}), ...(teamName ? { team: teamName } : {}), ...(missingPrompt ? { missingPrompt } : {}), ...(warnings.length ? { warnings } : {}) };
    }

    lastOperatorInputAt() {
      return this._lastOperatorInputAt || 0;
    }

    inFlightExecRuns() {
      const out = [];
      for (const s of this.sessions.values()) {
        if (!s || s._dead || !Array.isArray(s.execRuns)) continue;
        for (const r of s.execRuns) {
          if (r && r.state === 'running') out.push(`${s.name} run #${r.seq} (${r.cmd})`);
        }
      }
      return out;
    }

    _execLedgerPath() {
      return path.join(REGISTRY_DIR, EXEC_RUN_LEDGER_FILE);
    }

    _loadLostExecRuns() {
      if (Array.isArray(this._lostExecRuns)) return this._lostExecRuns;
      let rows = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(this._execLedgerPath(), 'utf-8'));
        if (Array.isArray(parsed)) rows = parsed;
      } catch { rows = []; }
      this._lostExecRuns = rows.filter((r) => r && typeof r.name === 'string' && r.name
        && Number.isFinite(r.seq) && typeof r.cmd === 'string');
      return this._lostExecRuns;
    }

    _writeExecLedger() {
      try {
        const rows = this._loadLostExecRuns().slice();
        for (const s of this.sessions.values()) {
          if (!s || !Array.isArray(s.execRuns)) continue;
          for (const r of s.execRuns) {
            if (r && r.state === 'running') {
              rows.push({ name: s.name, seq: r.seq, cmd: r.cmd, pid: r.pid, startedAt: r.startedAt });
            }
          }
        }
        const file = this._execLedgerPath();
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(rows));
        fs.renameSync(tmp, file);
      } catch (e) {
        log.warn('intent', `exec run ledger write failed: ${e.message}`);
      }
    }

    deliverLostExecRuns() {
      const pending = this._loadLostExecRuns();
      if (!pending.length) return 0;
      const keep = [];
      let delivered = 0;
      for (const r of pending) {
        const target = this.sessions.get(r.name);
        if (!target || target._dead) {
          let entry = null;
          try { entry = getPersistence().get(r.name); } catch { entry = null; }
          if (entry) keep.push(r);
          else log.info('intent', `exec run #${r.seq} (${r.cmd}) of ${r.name} lost to a host restart — seat gone, dropped`);
          continue;
        }
        const runs = target.execRuns || (target.execRuns = []);
        const body = `run #${r.seq} (${r.cmd}) lost to a host restart; re-emit it`;
        if (!runs.some((x) => x && x.seq === r.seq)) {
          const now = Date.now();
          runs.push({
            seq: r.seq, cmd: r.cmd, pid: r.pid, startedAt: Number.isFinite(r.startedAt) ? r.startedAt : now,
            endedAt: now, state: 'lost', tail: body, ceilingMin: 0,
          });
          runs.sort((a, b) => a.seq - b.seq);
          while (runs.length > EXEC_RUN_RECORD_CAP) runs.shift();
        }
        this._injectText(target, `[agent:exec] ${body}`, { parkable: true });
        log.warn('intent', `exec ${r.cmd} by ${r.name}: run #${r.seq} lost to a host restart (pid ${r.pid})`);
        delivered += 1;
      }
      this._lostExecRuns = keep;
      this._writeExecLedger();
      return delivered;
    }

    _procPid(s) {
      if (s.pty) return s.pty.pid;
      return s.stream ? s.stream.pid : undefined;
    }

    seatSend(name, text, images = []) {
      const s = this.sessions.get(name);
      if (!s || s._dead || s.io !== 'stream' || !s.stream) return { ok: false, error: 'not a live stream seat' };
      const body = String(text == null ? '' : text);
      const imgs = Array.isArray(images) ? images : [];
      if (!body.trim() && !imgs.length) return { ok: false, error: 'empty message' };
      this._lastOperatorInputAt = Date.now();
      const landed = this._armSubmit(s, body);
      if (landed && typeof landed.then === 'function') {
        const wait = { until: Date.now() + STREAM_ARM_WAIT_MS };
        s._armWait = wait;
        Promise.resolve(landed).finally(() => {
          if (s._armWait !== wait) return;
          s._armWait = null;
          this._streamReleaseHeld(s);
        });
      }
      return { ok: true, queued: this._streamEnqueue(s, { text: body, images: imgs, origin: 'operator' }) };
    }

    seatCommands(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead || s.io !== 'stream' || !s.stream) return { ok: false, error: 'not a live stream seat' };
      if (s.agentType !== 'claude' || !Array.isArray(s._slashCommands)) return { ok: true, commands: SEAT_CONTROL_COMMANDS.map((c) => ({ ...c })) };
      const hidden = new Set(s._terminalSlashCommands || []);
      const described = [];
      const rest = [];
      for (const cmd of new Set(s._slashCommands)) {
        if (hidden.has(cmd)) continue;
        const description = CLAUDE_SLASH_DESCRIPTIONS[cmd] || '';
        (description ? described : rest).push({ name: `/${cmd}`, kind: 'text', description });
      }
      const order = Object.keys(CLAUDE_SLASH_DESCRIPTIONS);
      described.sort((a, b) => order.indexOf(a.name.slice(1)) - order.indexOf(b.name.slice(1)));
      rest.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { ok: true, commands: [...described, ...rest] };
    }

    seatControl(name, sub) {
      const s = this.sessions.get(name);
      if (!s || s._dead || s.io !== 'stream' || !s.stream) return { ok: false, error: 'not a live stream seat' };
      if (sub === 'stop') return this.seatInterrupt(name);
      if (sub !== 'compact' && sub !== 'clear') return { ok: false, error: `unknown control "${sub}"` };
      if (s._reloadInFlight) return { ok: false, error: 'a reload is already in flight' };
      if (sub === 'compact' && isInjectInFlight({ pending: s._compactPending, guard: s._compactGuard, continuation: s._compactContinuation })) {
        return { ok: false, error: 'a compact is already in flight' };
      }
      if (sub === 'clear' && s._postClearContinuation) return { ok: false, error: 'a clear is already in flight' };
      const wireCtx = typeof s.streamCodec.encodeContext === 'function';
      const map = SessionManager.CONTEXT_COMMANDS[s.type];
      const cmd = wireCtx ? s.streamCodec.encodeContext(sub) : (map && map[sub]);
      if (!cmd) return { ok: false, error: `${sub} is not available on this seat yet` };
      this._lastOperatorInputAt = Date.now();
      if (sub === 'compact') {
        this._executeCompact(s, cmd, '');
        return { ok: true };
      }
      if (wireCtx) this._streamEnqueue(s, { text: '', images: [], origin: 'system', wire: cmd });
      else this._injectText(s, cmd, { bypassHold: true });
      log.info('session', `clear ${s.name} → ${wireCtx ? cmd.method : cmd} (operator control)`);
      return { ok: true };
    }

    seatDraft(name, text) {
      const s = this.sessions.get(name);
      if (!s || s._dead || s.io !== 'stream') return;
      const draft = String(text == null ? '' : text);
      try {
        if (!draft.trim()) arm.disarm(s.name, this._armCtx(s));
        else arm.onDraft(s.name, draft, this._armCtx(s));
      } catch (e) { log.debug('hint', `seat draft arm failed for ${s.name}: ${e.message}`); }
    }

    _streamHintHeld(s) {
      const now = Date.now();
      if (now - (s._streamHeldSince || now) >= HINT_HOLD_MAX_MS) return false;
      if (s._armWait && now < s._armWait.until) return true;
      try { return !!arm.holding(s.name); } catch { return false; }
    }

    _streamReleaseHeld(s) {
      if (s._dead || s.streamBusy || !s.outbox.length) { s._streamHeldSince = 0; return; }
      if (this._streamHintHeld(s)) { this._streamHoldPoll(s); return; }
      this._streamTurnEnd(s);
      s._streamHeldSince = 0;
    }

    _streamHoldPoll(s) {
      if (!s._streamHeldSince) s._streamHeldSince = Date.now();
      if (s._streamHoldTimer) return;
      s._streamHoldTimer = setTimeout(() => {
        s._streamHoldTimer = null;
        this._streamReleaseHeld(s);
      }, STREAM_HINT_POLL_MS);
      if (typeof s._streamHoldTimer.unref === 'function') s._streamHoldTimer.unref();
    }

    _streamEnqueue(s, item, onSend = null, produce = null, parkKey = null) {
      if (onSend) Object.defineProperty(item, 'onSend', { value: onSend, enumerable: false });
      if (produce) Object.defineProperty(item, 'produce', { value: produce, enumerable: false });
      if (parkKey) Object.defineProperty(item, 'parkKey', { value: parkKey, enumerable: false });
      const held = !s.streamBusy && this._streamHintHeld(s);
      const idle = !s.streamBusy && !held;
      if (idle && !s.outbox.length && item.wire) {
        this._streamDeliver(s, { text: '', images: [], wire: item.wire });
        this._streamSent([item]);
        return 0;
      }
      if (idle && !s.outbox.length) {
        const payload = this._streamJoin([item]);
        if (!payload.text.trim() && !payload.images.length) return 0;
        this._streamDeliver(s, payload);
        this._streamSent([item]);
        return 0;
      }
      const same = parkKey ? s.outbox.findIndex((q) => q.parkKey === parkKey) : -1;
      if (same >= 0) {
        s.outbox[same] = item;
      } else if (item.origin === 'operator') {
        let i = 0;
        while (i < s.outbox.length && s.outbox[i].origin === 'operator') i += 1;
        s.outbox.splice(i, 0, item);
      } else {
        s.outbox.push(item);
      }
      if (held) this._streamHoldPoll(s);
      this._streamOutboxChanged(s);
      if (idle && !s._streamInitStalled) this._streamTurnEnd(s);
      return s.outbox.length;
    }

    _streamEnqueueSystem(s, text, produce, where, onSend = null, parkKey = null) {
      if (this._refuseStreamInject(s, text, where)) return;
      if (!produce && !String(text || '').trim()) return;
      this._streamEnqueue(s, { text: produce ? '' : String(text), images: [], origin: 'system' }, onSend, produce, parkKey);
    }

    _streamJoin(items) {
      const texts = items.map((q) => {
        if (typeof q.produce !== 'function') return q.text;
        let t = null;
        try { t = q.produce(); } catch { t = null; }
        return t ? String(t) : '';
      });
      return {
        text: texts.filter((t) => t.trim()).join('\n\n'),
        images: items.flatMap((q) => q.images),
      };
    }

    _streamSent(items) {
      for (const q of items) {
        if (typeof q.onSend === 'function') { try { q.onSend(); } catch {} }
      }
    }

    _streamOutboxChanged(s) {
      s._outboxRev = (s._outboxRev || 0) + 1;
      this._sendToSession(s.name, 'transcript-changed', s.name);
    }

    seatOutbox(name) {
      const s = this.sessions.get(name);
      if (!s || s.io !== 'stream') return null;
      return {
        rev: s._outboxRev || 0,
        items: (s.outbox || []).map((q) => ({ text: q.wire ? q.wire.method : (typeof q.produce === 'function' ? 'pending mail' : q.text), origin: q.origin, images: q.images.length })),
      };
    }

    _onStreamToolBoundary(s) {
      if (!s || s.io !== 'stream' || s._dead || !s.stream) return;
      const sys = s.outbox.filter((q) => q.origin === 'system' && !q.wire);
      if (!sys.length) return;
      const now = Date.now();
      if (s._toolDrainAt != null && now - s._toolDrainAt < STREAM_TOOL_DRAIN_MIN_MS) return;
      s._toolDrainAt = now;
      const keep = s.outbox.filter((q) => q.origin !== 'system' || q.wire);
      s.outbox.splice(0, s.outbox.length, ...keep);
      const payload = this._streamJoin(sys);
      if (payload.text.trim() || payload.images.length) {
        this._streamWrite(s, payload);
        this._streamSent(sys);
        s._toolDrainedInTurn = true;
      }
      this._streamOutboxChanged(s);
    }

    _streamDeliver(s, payload) {
      const wasBusy = s.streamBusy;
      s.streamBusy = true;
      if (!this._streamWrite(s, payload)) {
        s.streamBusy = wasBusy;
        return false;
      }
      this._emitActivity(s.name, 'thinking', false);
      return true;
    }

    _streamWrite(s, { text, images, wire = null }) {
      if (wire) {
        this._streamSend(s, wire);
        return true;
      }
      const obj = s.streamCodec.encodeUser(text, images);
      if (!obj) return false;
      s.stream.send(obj).catch((e) => {
        const imageBytes = images.reduce((n, img) => n + img.data.length, 0);
        log.warn('session', `stream send ${s.name} failed (${Buffer.byteLength(text)} bytes, ${images.length} images ${imageBytes} b64 bytes): ${e.message}`);
      });
      return true;
    }

    _streamSend(s, obj) {
      s.stream.send(obj).catch((e) => {
        log.warn('session', `stream send ${s.name} failed (${(obj && obj.method) || `reply ${obj && obj.id}`}): ${e.message}`);
      });
    }

    seatInterrupt(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead || s.io !== 'stream' || !s.stream) return { ok: false, error: 'not a live stream seat' };
      const obj = typeof s.streamCodec.encodeInterrupt === 'function' ? s.streamCodec.encodeInterrupt() : null;
      if (!obj) return { ok: false, error: 'no interruptible turn' };
      this._streamSend(s, obj);
      return { ok: true };
    }

    _armStreamInitWatchdog(s) {
      this._clearStreamInitWatchdog(s);
      const ms = STREAM_INIT_MS;
      s._streamInitTimer = setTimeout(() => {
        s._streamInitTimer = null;
        if (s._dead) return;
        const tail = s.stream && s.stream.stderrTail ? s.stream.stderrTail.slice(-400) : '';
        log.warn('session', `stream ${s.name} never initialized after ${ms}ms; stderr: ${tail}`);
        s.streamBusy = false;
        s._streamInitStalled = true;
        const message = `never answered the opening handshake after ${ms}ms`;
        this._setAttention(s, { kind: 'other', ts: Date.now(), message });
        this._broadcast('ipc-message', { type: 'attention', from: s.name, to: '', body: `other: ${message}` });
      }, ms);
      if (typeof s._streamInitTimer.unref === 'function') s._streamInitTimer.unref();
    }

    _clearStreamInitWatchdog(s) {
      if (!s._streamInitTimer) return;
      clearTimeout(s._streamInitTimer);
      s._streamInitTimer = null;
    }

    _clearStreamResultHold(s) {
      if (!s._resultHold) return;
      clearTimeout(s._resultHold);
      s._resultHold = null;
    }

    _streamTurnEnd(s) {
      this._clearStreamInitWatchdog(s);
      s.streamBusy = false;
      if (s.outbox.length && this._streamHintHeld(s)) {
        this._emitActivity(s.name, 'idle', true);
        this._streamHoldPoll(s);
        return;
      }
      const w = s.outbox.findIndex((q) => q.wire);
      const queued = s.outbox.splice(0, w === 0 ? 1 : (w > 0 ? w : s.outbox.length));
      if (queued.length) this._streamOutboxChanged(s);
      const payload = !queued.length ? null
        : (queued[0].wire ? { text: '', images: [], wire: queued[0].wire } : this._streamJoin(queued));
      let delivered = false;
      if (payload && (payload.wire || payload.text.trim() || payload.images.length)) {
        delivered = this._streamDeliver(s, payload);
        this._streamSent(queued);
      }
      if (!delivered) this._emitActivity(s.name, 'idle', true);
    }

    _onStreamPermission(s, rec) {
      if (!s.streamPermissions) s.streamPermissions = new Map();
      const ts = Date.now();
      s.streamPermissions.set(rec.id, { ...rec, ts });
      s._streamPermRev = (s._streamPermRev || 0) + 1;
      this._setAttention(s, { kind: 'permission', ts, message: rec.displayName + (rec.preview ? ': ' + rec.preview : '') });
      this._broadcast('ipc-message', {
        type: 'attention', from: s.name, to: '',
        body: `permission: ${s.needsAttention.message || '(no message)'}`,
      });
      const owningWin = this.windowForSession(s.name);
      if (!owningWin || !owningWin.isFocused()) {
        try {
          notifyOS({
            title: `${s.name} needs you`,
            body: s.needsAttention.message || 'Waiting on a dialog.',
            silent: false,
          });
        } catch {}
      }
      this._sendToSession(s.name, 'transcript-changed', s.name);
    }

    _dropStreamPermissions(s) {
      const had = !!(s.streamPermissions && s.streamPermissions.size);
      if (had) {
        s.streamPermissions.clear();
        s._streamPermRev = (s._streamPermRev || 0) + 1;
      }
      if (s.needsAttention && s.needsAttention.kind === 'permission') this._setAttention(s, null);
      if (had) this._sendToSession(s.name, 'transcript-changed', s.name);
    }

    seatPermission(name, id, choiceId) {
      const s = this.sessions.get(name);
      if (!s) return { ok: false, error: 'no such session' };
      if (s.io !== 'stream') return { ok: false, error: 'not a stream seat' };
      if (!s.streamPermissions || !s.streamPermissions.has(id)) return { ok: false, error: 'no such request' };
      if (!s.streamCodec || typeof s.streamCodec.encodePermission !== 'function') return { ok: false, error: 'codec cannot answer' };
      const wire = s.streamCodec.encodePermission(id, choiceId);
      s.streamPermissions.delete(id);
      s._streamPermRev = (s._streamPermRev || 0) + 1;
      if (wire == null) {
        if (!s.streamPermissions.size && s.needsAttention && s.needsAttention.kind === 'permission') this._setAttention(s, null);
        this._sendToSession(s.name, 'transcript-changed', s.name);
        return { ok: false, error: 'request is stale' };
      }
      for (const obj of Array.isArray(wire) ? wire : [wire]) this._streamSend(s, obj);
      if (!s.streamPermissions.size) this._setAttention(s, null);
      this._sendToSession(s.name, 'transcript-changed', s.name);
      return { ok: true };
    }

    seatPermissions(name) {
      const s = this.sessions.get(name);
      if (!s || s.io !== 'stream') return null;
      return { rev: s._streamPermRev || 0, items: s.streamPermissions ? [...s.streamPermissions.values()] : [] };
    }

    _onStreamEvent(s, ev, onSessionId, onProcExit) {
      if (ev.close) {
        this._clearStreamResultHold(s);
        this._clearStreamInitWatchdog(s);
        this._dropStreamPermissions(s);
        const { code, signal } = ev.close;
        if (s.stream && s.stream.stderrTail && code) {
          log.warn('session', `stream ${s.name} stderr: ${s.stream.stderrTail.slice(-400)}`);
        }
        onProcExit({ exitCode: code, signal: signal || undefined });
        return;
      }
      const rec = s.streamCodec.decode(ev.line);
      if (Array.isArray(rec.send)) for (const obj of rec.send) this._streamSend(s, obj);
      switch (rec.kind) {
        case 'init':
          this._clearStreamResultHold(s);
          this._clearStreamInitWatchdog(s);
          if (s._streamInitStalled) {
            s._streamInitStalled = false;
            if (s.needsAttention && s.needsAttention.kind === 'other') this._setAttention(s, null);
          }
          this._dropStreamPermissions(s);
          if (Array.isArray(rec.slashCommands)) s._slashCommands = rec.slashCommands.filter((c) => typeof c === 'string');
          if (Array.isArray(rec.terminalSlashCommands)) s._terminalSlashCommands = rec.terminalSlashCommands.filter((c) => typeof c === 'string');
          if (rec.transcriptPath) this._repointStreamTranscript(s, rec.sessionId, rec.transcriptPath);
          if (rec.sessionId && rec.sessionId !== s.sessionId) onSessionId(rec.sessionId);
          if (s._replayAtInit) {
            this._replayTicketsOnce(s);
            s._replayAtInit = !!s._replayTicketsPending;
          }
          if (rec.turnEnd) this._streamTurnEnd(s);
          break;
        case 'result':
          this._clearStreamResultHold(s);
          this._dropStreamPermissions(s);
          if (s._toolDrainedInTurn) {
            s._toolDrainedInTurn = false;
            s._resultHold = setTimeout(() => {
              s._resultHold = null;
              if (!s._dead) this._streamTurnEnd(s);
            }, STREAM_RESULT_HOLD_MS);
            break;
          }
          this._streamTurnEnd(s);
          break;
        case 'compact':
          if (typeof s.streamCodec.encodeContext === 'function') this._fireCompactContinuation(s);
          else this._onCompactEnd(s, 'done');
          if (rec.turnEnd) this._streamTurnEnd(s);
          break;
        case 'reset':
          this._dropStreamPermissions(s);
          log.info('session', `stream ${s.name}: conversation reset (${rec.newConversationId}); the next init carries the resumable id`);
          break;
        case 'status':
          if (rec.status) this._emitActivity(s.name, 'thinking', false);
          break;
        case 'tool-boundary':
          this._onStreamToolBoundary(s);
          break;
        case 'permission-request':
          this._onStreamPermission(s, rec);
          break;
        default:
          break;
      }
    }

    _repointStreamTranscript(s, sid, recordPath = null) {
      if (s.io !== 'stream' || !s.cwd) return;
      const mode = streamFor(s.type)?.transcriptRepoint;
      if (mode === 'record') {
        if (!recordPath) return;
        const link = pathFor(REGISTRY_DIR, s.name, 'transcript');
        try {
          let current = null;
          try { current = fs.readlinkSync(link); } catch {}
          if (current === recordPath) return;
          ensureDir(runDirFor(REGISTRY_DIR, s.name));
          linkTranscript({ fs }, link, recordPath);
        } catch (e) {
          log.warn('session', `stream ${s.name}: transcript link failed: ${e.message}`);
        }
        return;
      }
      if (mode !== 'claude') {
        if (!s._repointSkipLogged) {
          s._repointSkipLogged = true;
          log.debug('session', `stream ${s.name}: no transcript repoint for ${s.type}`);
        }
        return;
      }
      const link = pathFor(REGISTRY_DIR, s.name, 'transcript');
      try {
        let current = null;
        try { current = fs.readlinkSync(link); } catch {}
        const target = current ? path.join(path.dirname(current), `${sid}.jsonl`) : this._claudeTranscriptPath(s.cwd, s.accountDir, sid);
        if (target === current) return;
        linkTranscript({ fs }, link, target);
      } catch (e) {
        log.warn('session', `stream ${s.name}: transcript link repoint failed: ${e.message}`);
      }
    }

    _refuseStreamInject(s, text, where) {
      if (!s || s.io !== 'stream') return false;
      if (!s._dead && s.stream) return false;
      const buf = Buffer.from(String(text == null ? '' : text));
      log.warn('inject', `${s.name}: stream seat ${s._dead ? 'dead' : 'has no stream'} — ${where} dropped ${buf.length} bytes: ${JSON.stringify(buf.subarray(0, 80).toString('utf8'))}`);
      return true;
    }

    write(name, data) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      if (s.io === 'stream') {
        if (!s._ptyWriteWarned) {
          s._ptyWriteWarned = true;
          const buf = Buffer.from(String(data == null ? '' : data));
          log.warn('inject', `${name}: stream seat has no pty — write() dropped ${buf.length} bytes: ${JSON.stringify(buf.subarray(0, 40).toString('utf8'))}`);
        }
        return;
      }
      if (isHumanPtyInput(data)) {
        s.lastUserInputTs = Date.now();
        this._lastOperatorInputAt = s.lastUserInputTs;
        if (!s.firstInputAt) s.firstInputAt = s.lastUserInputTs;
        const wasInPaste = s._inPaste;
        const sig = draftChunkSignal(data, s._inPaste);
        s._inPaste = sig.inPaste;
        if (sig.closes) {
          s.lastUserSubmitTs = s.lastUserInputTs;
          s.lastSubmitInjected = false;
        }
        s.lastMainStop = null;
        if (s.needsAttention) this._setAttention(s, null);
        this._foldDraft(s, data, wasInPaste);
      }
      try { s.pty.write(data); } catch {}
    }

    _foldDraft(s, data, wasInPaste) {
      try {
        // Carry the whole previous result forward, not just the text: the cursor and the desync flag
        // are what make this a line editor rather than an append-only buffer.
        const r = foldDraft(s._draftState || s._draft || '', data, wasInPaste);
        s._draftState = r;
        s._draft = r.draft;
        const key = s.name;
        if (r.cleared) { arm.disarm(key, this._armCtx(s)); return; }
        if (r.closes) {
          const submitted = s._draft;
          s._draft = '';
          s._draftState = null;
          this._armSubmit(s, submitted, r);
          return;
        }
        arm.onDraft(key, s._draft, this._armCtx(s), { overflow: r.overflow, desync: r.desync });
      } catch (e) { log.debug('hint', `draft fold failed for ${s.name}: ${e.message}`); }
    }

    _armSubmit(s, draft, { overflow = false, desync = false } = {}) {
      const key = s.name;
      let landed;
      try {
        landed = arm.onDraft(key, draft, this._armCtx(s), { final: true, overflow, desync });
        arm.onSubmit(key);
      } catch (e) { log.debug('hint', `submit arm failed for ${key}: ${e.message}`); }
      // Retire the pending selection list on submit: holding it longer would suppress a peek
      // for text the transcript now carries.
      try {
        if (selectionArm.onSubmit(key)) this._sendToSession(key, 'selection-sent', key);
      } catch {}
      return landed;
    }

    // Prefer the exact route: the glob is fnmatchcase at the proxy, so `clodex-clodex-*` also
    // matches `clodex-clodex-hand-4f2a` and would arm every agent whose name extends it.
    _armCtx(s) {
      return {
        agent: s.name,
        // Re-resolved per draft against the live pref, used only as a boolean: reading proxyBase off
        // the session alone keeps POSTing hints after traffic optimization is unticked.
        base: resolveProxyBase(s.proxyRequested, getUiSettings()) ? s.proxyBase : null,
        route: s.proxyAgent || `${PROXY_AGENT_PREFIX}${s.name}-*`,
      };
    }

    armSelection(name, payload) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return Promise.resolve({ armed: false, reason: 'no such session' });
      return selectionArm.arm(s.name, payload || {}, this._armCtx(s));
    }

    // Must not await or throw: the caller is one write away from sending the operator's message.
    // Routed through _armCtx so the base rule and route grammar stay in one place.
    markVoiceOrigin(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      try { voiceOriginArm.arm(this._armCtx(s)); } catch {}
    }

    unmarkVoiceOrigin(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      try { voiceOriginArm.disarm(this._armCtx(s)); } catch {}
    }

    // A level the renderer keeps refreshing, not an edge: a lost 'stopped' event would leave the seat
    // marked speaking forever. Own field: stamping lastUserInputTs would change what its other readers mean.
    noteVoiceRecording(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      s.lastVoiceRecordingTs = Date.now();
      // Box-wide copy alongside the per-seat field, not replacing it: the renderer reports only the active
      // seat's recorder. Rising edge is read before the stamp below; the level arrives every ~300ms.
      const recorderJustLit = Date.now() - (this._lastVoiceRecordingTs || 0) >= INJECT_SPEAKING_STALE_MS;
      this._lastVoiceRecordingTs = Date.now();
      if (recorderJustLit) { try { speaker.interruptForRecorder(); } catch {} }
    }

    // Level stamp with its own field: the park divert reads it, and folding it into the recorder or
    // input stamps would change what those readers mean.
    noteVoiceDraft(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      s.lastVoiceDraftTs = Date.now();
    }

    // The name is stored unvalidated (a spawn may not have filled the map yet) and always updates routing;
    // the microphone moves only when the reporter is the focused window of a frontmost app.
    noteFocusedSession(name, win = null) {
      this._focusedSession = name || null;
      let reporterInFront = false;
      try { reporterInFront = !!win && win.isFocused() === true; } catch { reporterInFront = false; }
      if (!reporterInFront || !this._appFocused) return;
      this._setMicTarget(this._focusedSession);
    }

    _setMicTarget(name) {
      this._micTarget = name || null;
    }

    micTarget() { return this._micTarget; }

    // App-level focus is the host's to report: a window can be the focused window of an app that is
    // itself behind a browser, so a window's own focus cannot answer it.
    noteAppFocused(focused) {
      this._appFocusReported = true;
      this._appFocused = focused === true;
    }

    appFocused() { return this._appFocused; }

    _voiceRoute(target = null) {
      const name = target || this._focusedSession;
      if (!name) return { ok: false, error: 'no target and no focused session' };
      const s = this.sessions.get(name);
      if (!s || s._dead) return { ok: false, error: `no live session "${name}"` };
      if (this.voiceModeFor(name) === 'off') return { ok: false, error: 'voice is off for this seat' };
      const win = this.windowForSession(name);
      if (!win) return { ok: false, error: `"${name}" has no window attached` };
      return { ok: true, name, session: s, win };
    }

    // Name checked here, not in _voiceRoute: an empty string would fall back to the focused seat and arm
    // a seat nobody named. The manager owns the check because the socket is the trust boundary.
    voiceSelect(target = null) {
      if (typeof target !== 'string' || !target.trim()) {
        return { ok: false, error: 'select needs a seat name' };
      }
      const r = this._voiceRoute(target);
      if (!r.ok) return r;
      // Ahead of the tap: the tap's raise brings the window forward.
      this._sendToSession(r.name, 'request-switch-session', r.name);
      return this.voiceTap(r.name, { raise: true });
    }

    voiceModeFor(name) {
      let rec = null;
      try { rec = getPersistence().get(name); } catch { rec = null; }
      return voiceModeOf(rec);
    }

    setVoice(name, mode) {
      if (!VOICE_MODES.includes(mode)) return { ok: false, error: `unknown voice mode "${mode}" (use off|tap)` };
      const s = this.sessions.get(name);
      if (!s) return { ok: false, error: `no session "${name}"` };
      const p = getPersistence();
      if (!p || !p.setVoice(name, mode)) return { ok: false, error: `"${name}" has no record to hold a voice mode` };
      this._broadcast('seat-voice', name, mode);
      log.info('voice', `mode ${mode} on ${name}`);
      return { ok: true, name, mode };
    }

    voiceMode(mode, target = null) {
      const name = target || this._focusedSession;
      if (!name) return { ok: false, error: 'no target and no focused session' };
      return this.setVoice(name, mode);
    }

    // Explicit on/off, never a toggle: a mis-heard toggle leaves the state unknowable from across
    // the room and repeating it flips it back.
    voiceSpeech(state) {
      if (state !== 'on' && state !== 'off') return { ok: false, error: `unknown speech state "${state}" (use on|off)` };
      const store = getUiSettings && getUiSettings();
      if (!store) return { ok: false, error: 'no settings store' };
      const on = state === 'on';
      store.set({ speakReplies: on });
      log.info('voice', `speech ${state}`);
      // No broadcast: nothing subscribes to speakReplies; the speaking gate and the voice popover
      // read the store directly.
      return { ok: true, state, speakReplies: on };
    }

    voiceTap(target = null, { raise = false } = {}) {
      const r = this._voiceRoute(target);
      if (!r.ok) return r;
      const { name, win } = r;
      // The tap retargets the microphone and the automatic re-arm never does; only past every decline
      // above, and before the frame, so the seat cannot receive its own tap while another seat holds the mic.
      this._setMicTarget(name);
      if (raise || (this._appFocusReported && !this._appFocused)) {
        try { win.show(); win.focus(); } catch { /* a host that cannot raise still routes the tap */ }
      }
      this._sendToSession(name, 'voice-tap', name);
      return { ok: true, name };
    }

    releaseSelection(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return Promise.resolve({ armed: false });
      return selectionArm.release(s.name, this._armCtx(s));
    }

    inspectSelection(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return Promise.resolve(null);
      return selectionArm.inspect(s.name, this._armCtx(s));
    }

    // 'full' (body in context), 'title' (index line rode; the best hint candidate) or 'absent'; never
    // a boolean, which would collapse the states the caller needs.
    memoryLoadState(agent, id) { return memLoad.stateOf(agent, id); }
    memoryLiveSet(agent) { return memLoad.liveSet(agent); }
    memoryRecallLog(agent) { return memLoad.recallLog(agent); }

    resize(name, cols, rows, requester = 'owner') {
      const s = this.sessions.get(name);
      if (!s || s._dead || !s.pty) return;
      try { s.pty.resize(cols, rows); } catch {}
      const key = `${s.pty.cols}x${s.pty.rows}:${requester}`;
      if (s._lastLoggedResize !== key) {
        s._lastLoggedResize = key;
        log.info('resize', `${name} ${s.pty.cols}x${s.pty.rows} by ${requester}`);
      }
      if (getRemoteServer()) {
        try { getRemoteServer().notifyResize(name, s.pty.cols, s.pty.rows); } catch {}
      }
    }

    async kill(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      log.info('session', `kill ${name} (user-initiated) pid=${this._procPid(s)}`);
      s._userKilled = true;
      this._notifyComposition(s, 'retired');
      if (s.spawnerHintSet && s.proxyBase && s.proxyAgent) {
        try {
          ProxyClient.spawnerHint(s.proxyBase, s.proxyAgent, { clear: true })
            .catch((e) => log.warn('session', `spawner-hint(clear) ${s.proxyAgent} failed: ${e.message}`));
        } catch (e) {
          log.warn('session', `spawner-hint(clear) skipped: ${e.message}`);
        }
      }
      try { this._stampSeatCost(s, 'kill'); } catch {}
      getPersistence().remove(name);
      if (s.stream) { s.stream.kill(); return; }
      const ptyPid = s.pty.pid;
      setTimeout(() => { sigkillPid(ptyPid, name, log); }, 5000);
      await reapPtyDescendants({ ptyPid, name, log, childProcess });
      try { s.pty.kill(); } catch {}
    }

    // engine.js keeps its own copy of this poll for the restart paths; this one lets the
    // electron-free manager wait without an injected seam, so do not merge them.
    async _waitForExit(name, timeoutMs = 8000) {
      const start = Date.now();
      while (this.sessions.has(name) && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return !this.sessions.has(name);
    }

    // Reads the record before kill() drops it; worktree removal runs only after the pty exit,
    // and _waitForExit's 8s timeout keeps the tree.
    async destroy(name) {
      const entry = getPersistence().get(name);
      const worktree = entry && entry.worktree && entry.worktree.path ? entry.worktree : null;
      const wasLive = this.sessions.has(name);
      // clearHintForRecord before remove: the record is the last place the route id exists and the hint
      // table has no TTL. A live seat skips both because kill() already did them.
      const dropRecord = () => {
        if (wasLive) return;
        this.clearHintForRecord(name);
        getPersistence().remove(name);
      };
      const dropSeatDir = () => {
        try {
          const r = removeSeat({ root: REGISTRY_DIR, name, fs });
          for (const f of r.failed) log.warn('session', `destroy ${name}: ${f.path} not removed (${f.error})`);
        } catch (e) {
          log.warn('session', `destroy ${name}: seat dir not removed (${e.message})`);
        }
      };
      await this.kill(name);
      if (!worktree) { dropRecord(); dropSeatDir(); return { ok: true, live: wasLive }; }
      const keepRecord = () => {
        if (!wasLive) return;
        try {
          getPersistence().upsert({ ...this._stripClaimedTree(entry), archivedAt: Date.now() });
        } catch (e) {
          log.warn('session', `destroy ${name}: record for ${worktree.path} not restored (${e.message})`);
        }
      };
      if (!await this._waitForExit(name)) {
        keepRecord();
        log.warn('worktree', `destroy ${name}: process still running after 8s; ${worktree.path} kept`);
        return { ok: false, error: 'process still running after 8s; worktree kept', live: true, worktreeRemoved: false, path: worktree.path };
      }
      const r = await gitWorktree.removeWorktree(worktree.path).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok) {
        dropRecord();
        dropSeatDir();
        log.info('worktree', `removed ${worktree.path} (branch ${worktree.branch}) after destroying ${name}`);
        return { ok: true, worktreeRemoved: true, live: wasLive };
      }
      const error = (r && r.error) || 'unknown error';
      log.info('worktree', `remove failed for ${worktree.path} after destroying ${name}: ${error}`);
      keepRecord();
      // NO dropRecord() here: the tree is still on disk and this record is the only thing naming it;
      // the path rides the result so the failure reply can tell the operator what to remove by hand.
      return { ok: true, worktreeRemoved: false, error, path: worktree.path, live: wasLive };
    }

    async archive(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      log.info('session', `archive ${name} pid=${this._procPid(s)}`);
      this._notifyComposition(s, 'archived');
      getPersistence().setArchived(name, true);
      s._archived = true;
      if (s.stream) { s.stream.kill(); return; }
      const ptyPid = s.pty.pid;
      setTimeout(() => { sigkillPid(ptyPid, name, log); }, 5000);
      await reapPtyDescendants({ ptyPid, name, log, childProcess });
      try { s.pty.kill(); } catch {}
    }

    async _stopForRespawn(s, name) {
      if (s.stream) { s.stream.kill(); return; }
      const ptyPid = s.pty && s.pty.pid;
      if (ptyPid) setTimeout(() => { sigkillPid(ptyPid, name, log); }, 5000);
      await reapPtyDescendants({ ptyPid, name, log, childProcess });
      try { s.pty.kill(); } catch {}
    }

    _renameDirs(oldName, newName) {
      return [
        [path.join(REGISTRY_DIR, 'pending', oldName), path.join(REGISTRY_DIR, 'pending', newName)],
        [path.join(REGISTRY_DIR, 'library', 'memory-loadlog', `${oldName}.jsonl`), path.join(REGISTRY_DIR, 'library', 'memory-loadlog', `${newName}.jsonl`)],
      ];
    }

    async rename(name, newName) {
      if (typeof newName !== 'string' || !/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(newName)) {
        return { ok: false, error: 'Name must be 1–64 chars: letters, digits, . _ - (and not only dots)' };
      }
      if (newName === name) return { ok: false, error: `${name} is already called that` };
      const entry = getPersistence().get(name);
      if (!entry) return { ok: false, error: `Session not found: ${name}` };
      if (entry.worktree && entry.worktree.path) {
        return { ok: false, error: `${name} runs in a ticket worktree (${entry.worktree.path}) — the loop keys that seat by name, so it cannot be renamed.` };
      }
      if (entry.ephemeral) {
        return { ok: false, error: `${name} is an ephemeral seat minted by the ticket loop, which keys it by name — it cannot be renamed.` };
      }
      const team = (() => { try { return resolveTeam(entry.cwd); } catch { return null; } })();
      if (team) {
        let ids;
        try {
          const board = ticketsStore.load(team.root);
          const byName = board.filter((t) => t && t.state === 'open' && t.assignee === name).map((t) => t.id);
          ids = [...new Set([...byName, ...this._openTicketsFor(team, name).map((t) => t.id)])];
        } catch { ids = ['<ticket check unavailable>']; }
        if (ids.length) {
          return { ok: false, error: `${name} is the assignee of open ticket${ids.length > 1 ? 's' : ''} ${ids.join(', ')} — close or reassign before renaming.` };
        }
      }
      if (this.sessions.has(newName)) return { ok: false, error: `${newName} is already a live session` };
      if (getPersistence().get(newName)) return { ok: false, error: `${newName} is already a saved session` };
      for (const dest of [...renameTargets(REGISTRY_DIR, newName), ...this._renameDirs(name, newName).map(([, d]) => d)]) {
        if (pathInUse(fs, dest)) return { ok: false, error: `${newName} already owns ${dest} — a leftover from an earlier seat; clear it first` };
      }
      if (this._movingNames.has(name)) return { ok: false, error: 'move already in progress' };
      if (this._movingNames.has(newName)) return { ok: false, error: `${newName} is already being claimed by another rename` };

      this._movingNames.add(name);
      this._movingNames.add(newName);
      try {
        const s = this.sessions.get(name);
        if (s) {
          log.info('session', `rename ${name} → ${newName} pid=${this._procPid(s)}`);
          s._moving = true;
          await this._stopForRespawn(s, name);
          if (!await this._waitForExit(name)) {
            s._moving = false;
            return {
              ok: false, kept: true,
              error: 'old process did not exit in time — session not renamed',
              name, type: entry.type, cwd: entry.cwd, team: this.teamNameFor(entry.cwd),
            };
          }
        }
        if (!getPersistence().rename(name, newName)) {
          return {
            ok: false, kept: true,
            error: `${newName} was taken while ${name} was stopping — session kept as ${name}; retry from the sidebar row, or forget it.`,
            name, type: entry.type, cwd: entry.cwd, team: this.teamNameFor(entry.cwd),
          };
        }
        const sched = getRemindScheduler && getRemindScheduler();
        if (sched && typeof sched.renameAgent === 'function') {
          try { sched.renameAgent(name, newName); } catch {}
        }
        try {
          const seatRes = renameSeat({ root: REGISTRY_DIR, oldName: name, newName, fs });
          for (const f of seatRes.failed) {
            log.warn('session', `rename ${name} → ${newName}: ${f.kind} did not move (${f.error})`);
          }
        } catch (e) {
          log.warn('session', `rename ${name} → ${newName}: seat dir did not move (${e.message})`);
        }
        for (const [src, dest] of this._renameDirs(name, newName)) {
          try { if (fs.existsSync(src)) fs.renameSync(src, dest); } catch (e) {
            log.warn('session', `rename ${name} → ${newName}: ${src} did not move (${e.message})`);
          }
        }
        try { getPersistence().snapshotSeat(newName); } catch {}
        if (team && team.lead === name) {
          try { setLead(team.name, newName); } catch (e) {
            log.warn('session', `rename ${name} → ${newName}: team "${team.name}" lead pointer not repointed (${e.message})`);
          }
        }
        try {
          enqueueNotice(REGISTRY_DIR, newName,
            `This seat was renamed from '${name}' to '${newName}'. Peers address you as '${newName}' now; `
            + 'your run directory, messages and memory moved with it.');
        } catch {}
        const workspaceId = entry.workspaceId || DEFAULT_WORKSPACE_ID;
        try {
          await this.create(
            newName, entry.type, entry.cwd, entry.extraArgs || [], entry.sessionId || null, workspaceId,
            entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [],
            entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [],
            entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [],
            Array.isArray(entry.execCommands) ? entry.execCommands : [],
            Array.isArray(entry.intents) ? entry.intents : null,
            (entry.env && typeof entry.env === 'object') ? entry.env : null,
            false,
            entry.noWire === true,
            Array.isArray(entry.plugins) ? entry.plugins : null,
            Array.isArray(entry.shellDeny) ? entry.shellDeny : null,
            typeof entry.fixFor === 'string' ? entry.fixFor : null,
            entry.io || 'pty',
            typeof entry.effort === 'string' ? entry.effort : null,
          );
        } catch (err) {
          const kept = { ...entry, name: newName };
          delete kept.label;
          getPersistence().upsert(this._stripClaimedTree(kept));
          return {
            ok: false, kept: true,
            error: `${err.message} — session kept as ${newName}; retry from the sidebar row, or forget it.`,
            name: newName, type: entry.type, cwd: entry.cwd, team: this.teamNameFor(entry.cwd),
          };
        }
        return {
          ok: true,
          name: newName,
          type: entry.type,
          cwd: entry.cwd,
          backend: (this.sessions.get(newName) || {}).backend || null,
          noWire: entry.noWire === true,
          team: this.teamNameFor(entry.cwd),
        };
      } finally {
        this._movingNames.delete(name);
        this._movingNames.delete(newName);
      }
    }

    async move(name, newCwd) {
      const entry = getPersistence().get(name);
      if (!entry) return { ok: false, error: `Session not found: ${name}` };
      if (entry.worktree && entry.worktree.path) {
        return { ok: false, error: `${name} runs in a ticket worktree (${entry.worktree.path}) — that checkout belongs to the ticket loop, so it cannot be moved.` };
      }
      if (typeof newCwd !== 'string' || !newCwd || !path.isAbsolute(newCwd)) {
        return { ok: false, error: 'Destination must be an absolute path' };
      }
      let st = null;
      try { st = fs.statSync(newCwd); } catch { st = null; }
      if (!st) return { ok: false, error: `Directory does not exist: ${newCwd}` };
      if (!st.isDirectory()) return { ok: false, error: `Not a directory: ${newCwd}` };
      if (entry.cwd === newCwd) return { ok: false, error: `${name} is already in ${newCwd}` };

      if (this._movingNames.has(name)) return { ok: false, error: 'move already in progress' };
      this._movingNames.add(name);
      try {
        const s = this.sessions.get(name);
        if (s) {
          log.info('session', `move ${name} ${entry.cwd} → ${newCwd} pid=${this._procPid(s)}`);
          s._moving = true;
          await this._stopForRespawn(s, name);
          if (!await this._waitForExit(name)) {
            s._moving = false;
            return {
              ok: false, kept: true,
              error: 'old process did not exit in time — session not moved',
              type: entry.type, cwd: entry.cwd, team: this.teamNameFor(entry.cwd),
            };
          }
        }
        const teamChanged = this.teamNameFor(entry.cwd) !== this.teamNameFor(newCwd);
        const departing = s || {
          name,
          agentType: isAgentType(entry.type) ? entry.type : null,
          cwd: entry.cwd,
        };
        getPersistence().setCwd(name, newCwd);
        if (entry.archivedAt) getPersistence().setArchived(name, false);
        const workspaceId = entry.workspaceId || DEFAULT_WORKSPACE_ID;
        try {
          await this.create(
            name, entry.type, newCwd, entry.extraArgs || [], entry.sessionId || null, workspaceId,
            entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [],
            entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [],
            entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [],
            Array.isArray(entry.execCommands) ? entry.execCommands : [],
            Array.isArray(entry.intents) ? entry.intents : null,
            (entry.env && typeof entry.env === 'object') ? entry.env : null,
            false,
            entry.noWire === true,
            Array.isArray(entry.plugins) ? entry.plugins : null,
            Array.isArray(entry.shellDeny) ? entry.shellDeny : null,
            typeof entry.fixFor === 'string' ? entry.fixFor : null,
            entry.io || 'pty',
            typeof entry.effort === 'string' ? entry.effort : null,
          );
        } catch (err) {
          getPersistence().upsert(this._stripClaimedTree({ ...entry, cwd: newCwd }));
          if (entry.archivedAt) getPersistence().setArchived(name, false);
          return {
            ok: false, kept: true,
            error: `${err.message} — session kept; retry from the sidebar row, or forget it.`,
            type: entry.type, cwd: newCwd, team: this.teamNameFor(newCwd),
          };
        }
        if (teamChanged) {
          this._notifyComposition(departing, 'moved out');
          this._notifyComposition(this.sessions.get(name), 'moved in');
        }
        return {
          ok: true,
          cwd: newCwd,
          type: entry.type,
          backend: (this.sessions.get(name) || {}).backend || null,
          team: this.teamNameFor(newCwd),
        };
      } finally {
        this._movingNames.delete(name);
      }
    }

    moveToWorkspace(name, workspaceId) {
      const entry = getPersistence().get(name);
      if (!entry) return { ok: false, error: `Session not found: ${name}` };
      const ws = getWorkspaces ? getWorkspaces().get(workspaceId) : null;
      if (!ws) return { ok: false, error: 'unknown workspace' };
      const oldId = entry.workspaceId || DEFAULT_WORKSPACE_ID;
      const workspaceName = ws.name || ws.id;
      if (oldId === workspaceId) return { ok: false, error: `${name} is already in ${workspaceName}` };

      const s = this.sessions.get(name);
      if (this._movingNames.has(name) || (s && s._reloadInFlight)) {
        return { ok: false, error: `${name} is being respawned — try again once it is back` };
      }
      getPersistence().upsert({ name, workspaceId });
      if (s) s.workspaceId = workspaceId;

      const destWin = this.windowForWorkspace(workspaceId);
      const srcWin = this.windowForWorkspace(oldId);
      if (srcWin) srcWin.webContents.send('session:moved-out', { name });
      if (destWin) {
        const record = getPersistence().get(name) || entry;
        const row = s
          ? liveSnapshotFor({
            manager: this, entry: record, session: s,
            readCtxFor: readCtxFor || (() => ({ ctx: null, ctxTok: null, ctxSize: null, ctxCost: null, ctxModel: null })),
            proxyPoller: this._proxyPoller || { snapshot: () => null },
          })
          : (record.exitedAt && !record.archivedAt
            ? exitedSnapshotFor({ manager: this, entry: record })
            : archivedSnapshotFor({ manager: this, entry: record }));
        if (row.proxy) row.proxy = stampServedAge(row.proxy);
        destWin.webContents.send('session:moved-in', stampConfigFlags(row, record));
      }
      log.info('session', `move-to-workspace ${name} ${oldId} → ${workspaceId}`);
      return { ok: true, name, workspaceId, workspaceName, live: !!s };
    }

    _moveBadSegment(name) {
      const scan = (dir, prefix) => {
        for (const rel of seatRelFiles(fs, path, dir)) {
          if (rel.split('/').every((seg) => IMPORT_SEGMENT_RE.test(seg))) continue;
          return `${prefix}${rel}`;
        }
        return null;
      };
      for (const kind of Object.keys(SEAT_KINDS).filter((k) => k !== 'run').sort()) {
        const bad = scan(seatPathFor(REGISTRY_DIR, name, kind), `seat/${kind}/`);
        if (bad) return bad;
      }
      return scan(path.join(REGISTRY_DIR, 'pending', name), 'pending/');
    }

    _moveRecord(name, entry, farCwd) {
      const record = { ...entry, cwd: farCwd };
      for (const k of MOVE_TO_PEER_OMIT) delete record[k];
      const accountDir = entry.env && entry.env.CLAUDE_CONFIG_DIR;
      if (accountDir) {
        let label = null;
        try { label = getAccounts ? getAccounts().labelFor(accountDir) : null; } catch { label = null; }
        if (label) record.accountLabel = label;
      }
      return record;
    }

    _moveShipment(name, entry, transcriptPath) {
      const files = [{ relPath: 'transcript.jsonl', path: transcriptPath }];
      for (const kind of Object.keys(SEAT_KINDS).filter((k) => k !== 'run').sort()) {
        const dir = seatPathFor(REGISTRY_DIR, name, kind);
        for (const rel of seatRelFiles(fs, path, dir)) {
          files.push({ relPath: `seat/${kind}/${rel}`, path: path.join(dir, ...rel.split('/')) });
        }
      }
      const pendingDir = path.join(REGISTRY_DIR, 'pending', name);
      for (const rel of seatRelFiles(fs, path, pendingDir)) {
        files.push({ relPath: `pending/${rel}`, path: path.join(pendingDir, ...rel.split('/')) });
      }
      const loadlog = path.join(REGISTRY_DIR, 'library', 'memory-loadlog', `${name}.jsonl`);
      try { if (fs.existsSync(loadlog)) files.push({ relPath: 'loadlog.jsonl', path: loadlog }); } catch {}
      let rows = [];
      try { rows = getReminders ? (getReminders().listForAgent(name) || []) : []; } catch { rows = []; }
      if (rows.length) files.push({ relPath: 'reminders.json', bytes: Buffer.from(JSON.stringify(rows)) });

      return files;
    }

    async moveToPeer(name, peerId, { farCwd = null } = {}) {
      const entry = getPersistence().get(name);
      if (!entry) return { ok: false, error: `Session not found: ${name}` };
      if (entry.worktree && entry.worktree.path) {
        return { ok: false, error: `${name} runs in a ticket worktree (${entry.worktree.path}) — that checkout belongs to the ticket loop, so it cannot be moved.` };
      }
      if (entry.type !== 'claude') return { ok: false, error: 'only Claude seats can be moved to a peer' };
      if (!entry.sessionId) {
        return { ok: false, error: `${name} has no conversation to move — start it once, or move it locally instead` };
      }
      if (this._movingNames.has(name)) return { ok: false, error: 'move already in progress' };

      const conn = getPeerManager() ? getPeerManager().get(peerId) : null;
      if (!conn) return { ok: false, error: 'unknown peer' };
      const st = conn.status();
      const peerLabel = st.label || peerId;
      if (st.needsUpgrade) return { ok: false, error: `peer ${peerLabel} runs an older Clodex — upgrade it first` };
      if (!(st.caps || []).includes('import')) {
        return { ok: false, error: `peer ${peerLabel} does not accept moved sessions` };
      }

      if (farCwd != null && (typeof farCwd !== 'string' || !farCwd || !path.isAbsolute(farCwd))) {
        return { ok: false, error: 'Destination must be an absolute path' };
      }
      const destCwd = path.resolve(farCwd || entry.cwd);

      if (!IMPORT_SESSION_ID_RE.test(entry.sessionId)) {
        return { ok: false, error: `${name}'s conversation id '${entry.sessionId}' is not a session uuid — a peer refuses it` };
      }
      const badSegment = this._moveBadSegment(name);
      if (badSegment) {
        return { ok: false, error: `${badSegment} cannot travel — a peer refuses any file name outside [A-Za-z0-9._-]` };
      }

      const composed = path.join(
        claudeHome(), 'projects', claudeProjectSlug(entry.cwd), `${entry.sessionId}.jsonl`,
      );
      let transcriptPath = null;
      try { if (fs.existsSync(composed)) transcriptPath = composed; } catch {}
      if (!transcriptPath) {
        let linked = null;
        try { linked = fs.realpathSync(pathFor(REGISTRY_DIR, name, 'transcript')); } catch {}
        if (linked && path.basename(linked) === `${entry.sessionId}.jsonl`) transcriptPath = linked;
      }
      if (!transcriptPath) return { ok: false, error: `transcript not found at ${composed}` };

      this._movingNames.add(name);
      let stagingId = null;
      try {
        const begun = await conn.importBegin({
          name, record: this._moveRecord(name, entry, destCwd),
        });
        if (!begun || !begun.ok) {
          return { ok: false, error: (begun && begun.error) || 'peer refused the import' };
        }
        stagingId = begun.id;

        const s = this.sessions.get(name);
        if (s) {
          log.info('session', `move-to-peer ${name} → ${peerLabel}:${destCwd} pid=${this._procPid(s)}`);
          s._moving = true;
          await this._stopForRespawn(s, name);
          if (!await this._waitForExit(name)) {
            s._moving = false;
            try { await conn.importAbort(stagingId); } catch {}
            return {
              ok: false, kept: true,
              error: 'old process did not exit in time — session not moved',
              type: entry.type, cwd: entry.cwd, team: this.teamNameFor(entry.cwd),
            };
          }
        }

        const files = this._moveShipment(name, entry, transcriptPath);
        const totalBytes = files.reduce((n, f) => n + moveFileBytes(fs, f), 0);
        const progress = (phase, bytes, fileIndex) => {
          this._broadcast('session:move-progress',
            { name, phase, bytes, total: totalBytes, files: files.length, fileIndex });
        };
        progress('begin', 0, 0);
        let doneBytes = 0;
        let lastRel = null;
        let lastSent = 0;
        let fileIndex = 0;
        const out = await conn.importShip({
          id: stagingId,
          files,
          onProgress: ({ relPath, sent }) => {
            if (relPath !== lastRel) { doneBytes += lastSent; lastRel = relPath; lastSent = 0; fileIndex += 1; }
            lastSent = sent;
            progress(relPath === 'transcript.jsonl' ? 'transcript' : 'seat', doneBytes + sent, fileIndex);
          },
        });

        if (out && out.ok) {
          progress('commit', totalBytes, files.length);
          const departing = s || {
            name,
            agentType: isAgentType(entry.type) ? entry.type : null,
            cwd: entry.cwd,
          };
          const movedTo = { peer: peerId, peerLabel, farCwd: destCwd, at: Date.now(), sessionId: entry.sessionId };
          getPersistence().upsert({ name, movedTo });
          getPersistence().setArchived(name, true);
          if (this.teamNameFor(entry.cwd)) this._notifyComposition(departing, 'moved out');
          return {
            ok: true, name, peer: peerLabel, farCwd: destCwd,
            sessionId: entry.sessionId,
            dropped: Array.isArray(out.dropped) ? out.dropped : [],
          };
        }

        const farError = (out && out.error) || 'peer refused the import';
        if (!s) {
          return {
            ok: false, kept: true, error: farError,
            installed: (out && out.installed) || null,
            peer: peerLabel,
            type: entry.type, cwd: entry.cwd, team: this.teamNameFor(entry.cwd),
          };
        }
        const workspaceId = entry.workspaceId || DEFAULT_WORKSPACE_ID;
        try {
          await this.create(
            name, entry.type, entry.cwd, entry.extraArgs || [], entry.sessionId || null, workspaceId,
            entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [],
            entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [],
            entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [],
            Array.isArray(entry.execCommands) ? entry.execCommands : [],
            Array.isArray(entry.intents) ? entry.intents : null,
            (entry.env && typeof entry.env === 'object') ? entry.env : null,
            false,
            entry.noWire === true,
            Array.isArray(entry.plugins) ? entry.plugins : null,
            Array.isArray(entry.shellDeny) ? entry.shellDeny : null,
            typeof entry.fixFor === 'string' ? entry.fixFor : null,
            entry.io || 'pty',
            typeof entry.effort === 'string' ? entry.effort : null,
          );
        } catch (err) {
          getPersistence().upsert(this._stripClaimedTree({ ...entry }));
          return {
            ok: false, kept: true,
            error: `${err.message} — session kept; retry from the sidebar row, or forget it.`,
            installed: (out && out.installed) || null,
            type: entry.type, cwd: entry.cwd, team: this.teamNameFor(entry.cwd),
          };
        }
        return {
          ok: false, kept: true, respawned: true, error: farError,
          installed: (out && out.installed) || null,
          peer: peerLabel,
          type: entry.type, cwd: entry.cwd, team: this.teamNameFor(entry.cwd),
        };
      } catch (e) {
        if (stagingId) { try { await conn.importAbort(stagingId); } catch {} }
        throw e;
      } finally {
        this._movingNames.delete(name);
      }
    }

    clearHintForRecord(name) {
      const entry = getPersistence().get(name);
      if (!entry || entry.spawnerHintSet !== true || !entry.proxyAgent) return;
      const base = resolveProxyBase(entry.proxy ?? null, getUiSettings());
      if (!base) return;
      try {
        ProxyClient.spawnerHint(base, entry.proxyAgent, { clear: true })
          .catch((e) => log.warn('session', `spawner-hint(clear) ${entry.proxyAgent} failed: ${e.message}`));
      } catch (e) {
        log.warn('session', `spawner-hint(clear) skipped: ${e.message}`);
      }
    }

    _teamBlockFor(name, cwd, agentType, systemPromptFile) {
      let teamBlock = '';
      let teamName = null;
      let resolvedTeam = null;
      // Returned, not warned here: each caller has a different party who can act on it,
      // and a main-process log is where a real error hides.
      let missingPrompt = null;
      if (agentType) {
        try {
          const team = resolveTeam(cwd);
          if (team) {
            resolvedTeam = team;
            teamName = team.name;
            teamBlock = formatTeamBlock(team, name);
            const role = matchSeatRole(team, name);
            const def = role ? team.roles[role] : null;
            const promptRidesAsSystem = def && def.prompt && systemPromptFile === def.prompt;
            if (def && def.prompt) {
              // Resolved on both arms: a miss when the prompt rides as --system-prompt-file boots the seat
              // with no system prompt at all, and an empty file is not a miss.
              let rolePrompt = null;
              try { rolePrompt = readSystemPromptBody(def.prompt, null, team); }
              catch { rolePrompt = null; }
              const where = `teams/${team.name}/prompts/system or library/prompts/system`;
              if (rolePrompt == null) {
                missingPrompt = promptRidesAsSystem
                  ? `role "${role}" names system prompt "${def.prompt}", which is not installed under ${where} — ${name} boots with NO system prompt`
                  : `role "${role}" names prompt "${def.prompt}", which is not installed under ${where} — ${name} boots unbriefed`;
              } else if (!promptRidesAsSystem && rolePrompt) {
                teamBlock = `${teamBlock}\n\n${rolePrompt}`;
              }
            }
          }
        } catch { /* resolution is best-effort — never block a spawn on it */ }
      }
      return { teamBlock, teamName, resolvedTeam, missingPrompt };
    }

    _realIpcFor(recipe, teamBlock, team, name) {
      const extraGrammar = pluginGrammarLines(recipe.intents, recipe.plugins) || [];
      const ipcPrompt = recipe.ipcDisabled
        ? ''
        : buildIpcPrompt(recipe.intents, this._resolveExecDefs(recipe.execCommands, team),
          recipe.spillArmed ? [...extraGrammar, spillGrammarLine(REGISTRY_DIR, recipe.spillExamples)] : extraGrammar,
          { teamLead: !!team && team.lead === name });
      const { cleaned, append } = mergeClaudeSystemPrompt(recipe.extraArgs, ipcPrompt, {
        appendBodies: readAppendBodies(recipe.appendPromptFiles, recipe.plugins, team),
        inlineBody: recipe.inlineBody,
        hasSystemFile: recipe.hasSystemFile,
      });
      return { cleaned, realIpc: teamBlock ? `${append}\n\n${teamBlock}\n` : append };
    }

    // Never rewrite append-prompt.md: the CLI rebuilds its system block from the transcript
    // prompt_snapshot at a reset (measured 2.1.278), so a rewrite moves session.md past the model.
    refreshPrompt(name, why, opts = {}) {
      const session = this.sessions.get(name);
      if (!session || session._dead || session.agentType !== 'claude') return false;
      const entry = getPersistence().get(name);
      if (!entry) return false;
      if (!session.promptRecipe) {
        this._shadowLog({ type: 'prompt-refresh-skipped', agent: name, reason: 'no-recipe' });
        return false;
      }
      try {
        if (!fs.existsSync(pathFor(REGISTRY_DIR, name, 'appendPrompt'))) {
          this._shadowLog({ type: 'prompt-refresh-skipped', agent: name, reason: 'no-prompt-file' });
          return false;
        }
        // There is no reply channel at a clear, so the missing-prompt finding rides the
        // ipc-message this refresh already broadcasts.
        const { teamBlock, resolvedTeam, missingPrompt } = this._teamBlockFor(name, entry.cwd, session.agentType, entry.systemPromptFile || null);
        const { realIpc } = this._realIpcFor(session.promptRecipe, teamBlock, resolvedTeam, name);
        const accountDir = session.accountDir || (entry.env && entry.env.CLAUDE_CONFIG_DIR);
        const snapshot = this._snapshotBlockFor(name, entry.cwd, accountDir, opts.sid || entry.sessionId);
        const delta = restageAtReset(REGISTRY_DIR, name, realIpc, snapshot);
        if (!delta) return false;
        log.info('prompt', `restaged ${name} (${why}) — ${delta.length} bytes of delta`);
        this._broadcast('ipc-message', {
          type: 'context', from: name, to: name,
          body: `prompt delta restaged (${why})${missingPrompt ? ` — ${missingPrompt}` : ''}`,
        });
        return true;
      } catch (e) {
        this._shadowLog({ type: 'prompt-refresh-error', agent: name, error: e.message });
        return false;
      }
    }

    _claudeTranscriptPath(cwd, accountDir, sid) {
      return path.join(accountDir || claudeHome(), 'projects', claudeProjectSlug(cwd), `${sid}.jsonl`);
    }

    _snapshotBlockFor(name, cwd, accountDir, sid) {
      const candidates = [];
      if (sid && cwd) candidates.push(this._claudeTranscriptPath(cwd, accountDir, sid));
      candidates.push(pathFor(REGISTRY_DIR, name, 'transcript'));
      for (const p of candidates) {
        const found = readPromptSnapshotMemo(REGISTRY_DIR, name, p);
        if (found) return found.clodexBlock;
      }
      return null;
    }

    teamNameFor(cwd) {
      if (!cwd) return null;
      try { const t = resolveTeam(cwd); return t ? t.name : null; } catch { return null; }
    }

    // Sole board-key / live-seat scope derivation: team root unchanged, else the repo root.
    // Handlers must not reach for team.root or findProjectRoot; a solo and a team seat would split boards.
    _projectRootFor(cwd) {
      let team = null;
      try { team = resolveTeam(cwd); } catch { team = null; }
      if (team) return team.root;
      try { return findRepoRoot(cwd, { fs }); } catch { return null; }
    }

    // A stand-in team as a value, not a second code path: roles null makes matchSeatRole and
    // _ticketDispatchMode bail, and lead is the sender so lead-only gates no-op.
    _soloContext(session) {
      const root = this._projectRootFor(session && session.cwd);
      if (!root) return null;
      return { name: path.basename(root), root, lead: session.name, roles: null, solo: true };
    }

    // Warmth label computed here: team-manifest is a pure leaf and warmth is a wire-layer
    // property, so it crosses as data.
    _teamLiveSeats(teamRoot) {
      const seats = [];
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        // `_projectRootFor`, not `findProjectRoot`: that answers null for a teamless seat and
        // leaves a solo board with no live seats.
        let root; try { root = this._projectRootFor(s.cwd); } catch { root = null; }
        if (!root || root !== teamRoot) continue;
        let label = null;
        try {
          label = peerStatusLabel({
            state: s.activityState || 'idle',
            idleMs: Date.now() - (s.activityTs || Date.now()),
            payload: this._proxyPoller ? this._proxyPoller.snapshot(s.name) : null,
            attention: s.needsAttention ? s.needsAttention.kind : null,
            agentType: s.agentType,
          });
        } catch { label = null; }
        seats.push({ name: s.name, label });
      }
      return seats;
    }

    _teamLiveSeatNames(teamRoot) {
      return this._teamLiveSeats(teamRoot).map((s) => s.name);
    }

    _seatGrants(name) {
      try {
        const e = getPersistence().get(name);
        if (!e) return null;
        return Array.isArray(e.execCommands) ? e.execCommands : [];
      } catch { return null; }
    }

    // Reads cwd from persistence when the seat is not live: the boot-digest writer
    // calls this before the seat is in the map.
    composeRosterFor(name) {
      let cwd = null;
      const s = this.sessions.get(name);
      if (s && s.cwd) cwd = s.cwd;
      else { try { const e = getPersistence().get(name); if (e) cwd = e.cwd; } catch { cwd = null; } }
      if (!cwd) return null;
      let team; try { team = resolveTeam(cwd); } catch { return null; }
      if (!team) return null;
      return formatRoster(team, this._teamLiveSeats(team.root), { seat: name, grants: this._seatGrants(name), efforts: this._teamRoleEfforts(team) });
    }

    _rebakeDigest(name) {
      try { writeClaudeDigestFile(name); } catch { /* digest is best-effort */ }
    }

    _maybeInjectComposition(session, team, existingEntry) {
      if (existingEntry && existingEntry.rosterSentAt) {
        // A resumed seat gets no roster message (a duplicate costs a turn) but its digest must be
        // re-baked: the pre-spawn write ran before the seat existed.
        if (session.agentType === 'claude') this._rebakeDigest(session.name);
        return;
      }
      this._injectRoster(session, team);
      this._notifyComposition(session, 'spawned');
    }

    _markRosterSent(session) {
      const p = getPersistence();
      if (p && typeof p.setRosterSent === 'function') p.setRosterSent(session.name);
    }

    _stripClaimedTree(entry) {
      if (!entry || !entry.name || !entry.worktree || !entry.worktree.path) return entry;
      if (typeof this._ticketTreeHolder !== 'function') return entry;
      let holder = null;
      try { holder = this._ticketTreeHolder(entry.worktree.path); } catch { return entry; }
      if (!holder || holder === entry.name) return entry;
      if (log) log.info('session', `restart of ${entry.name}: dropping worktree ${entry.worktree.path} from the restored record — ${holder} holds it now`);
      // Copy-and-delete, not a `{ worktree, ...rest }` destructure: the free-identifier scanner
      // reads the object rest binding as a dangling reference.
      const stripped = { ...entry };
      delete stripped.worktree;
      return stripped;
    }

    resumeCwdOf(entry) {
      if (!entry || !entry.cwd) return entry ? entry.cwd : undefined;
      const there = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
      if (there(entry.cwd)) return entry.cwd;
      const main = entry.worktree && entry.worktree.main;
      if (!there(main)) return entry.cwd;
      if (log) log.info('session', `resume of ${entry.name}: tree ${entry.cwd} is gone, booting in ${main}`);
      try {
        getPersistence().setCwd(entry.name, main);
        getPersistence().setWorktree(entry.name, null);
      } catch {}
      return main;
    }

    _preserveAcrossRestart(name, priorEntry, fields) {
      if (!priorEntry || !Array.isArray(fields)) return;
      let seed = { name };
      for (const f of [...fields, ...ALWAYS_PRESERVE]) {
        if (priorEntry[f] !== undefined) seed[f] = priorEntry[f];
      }
      seed = this._stripClaimedTree(seed);
      if (Object.keys(seed).length <= 1) return;
      const p = getPersistence();
      if (p && typeof p.upsert === 'function') p.upsert(seed);
    }

    _injectRoster(session, team) {
      try {
        if (session.agentType === 'claude') {
          this._deliverPassive(session.name, 'team', formatRoster(team, this._teamLiveSeats(team.root), { seat: session.name, grants: this._seatGrants(session.name), efforts: this._teamRoleEfforts(team) }), 'dm');
          // The message is the first conversation's roster; the re-bake is what every conversation
          // after a context reset gets, since the message is discarded with the history.
          this._rebakeDigest(session.name);
          this._markRosterSent(session);
        } else {
          session._pendingRoster = team;
        }
      } catch (e) {
        log.error('inject', `roster inject failed for ${session.name}: ${e.message}`);
      }
    }

    _armBootSettle(session) {
      if (!session._bootSettling) return;
      if (Date.now() - (session._bootSettleSince || 0) >= ROSTER_MAX_WAIT_MS) {
        clearTimeout(session._bootSettleTimer);
        session._bootSettleTimer = null;
        this._settleBoot(session);
        return;
      }
      clearTimeout(session._bootSettleTimer);
      session._bootSettleTimer = setTimeout(() => this._settleBoot(session), ROSTER_SETTLE_MS);
    }

    _settleBoot(session) {
      session._bootSettleTimer = null;
      session._bootSettling = false;
      if (session._dead) return;
      const team = session._pendingRoster;
      if (team) {
        session._pendingRoster = null;
        try {
          this._deliverMessage(session.name, 'team', formatRoster(team, this._teamLiveSeats(team.root), { seat: session.name, grants: this._seatGrants(session.name), efforts: this._teamRoleEfforts(team) }), 'dm',
            '', () => this._markRosterSent(session));
        } catch (e) {
          log.error('inject', `roster flush failed for ${session.name}: ${e.message}`);
        }
      }
      this._replayTicketsOnce(session);
    }

    _notifyComposition(session, verb) {
      if (!session || !session.agentType) return;
      let team;
      try { team = resolveTeam(session.cwd); } catch { return; }
      if (!team) return;
      const role = matchSeatRole(team, session.name);
      const body = formatCompositionDelta(team.name, verb, { seat: session.name, role });
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead || s.name === session.name) continue;
        if (s._bootSettling) continue;   // booting codex seat: drop the delta, a miss is harmless
        let root; try { root = findProjectRoot(s.cwd); } catch { root = null; }
        if (!root || root !== team.root) continue;
        // Lead alone: a sibling restart is not actionable for other seats and only wakes a working
        // one; independent of whether the changed seat was ephemeral.
        if (s.name === team.lead) this._deliverPassive(s.name, 'team', body, 'dm');
        // Re-bake stays outside the lead-only guard: the delta dies with the next reset, and only the
        // digest makes the next boot of every seat carry the changed roster.
        if (s.agentType === 'claude') this._rebakeDigest(s.name);
      }
    }

    _accountResolver() {
      try {
        const accountsStore = (getAccounts && getAccounts()) || null;
        if (!accountsStore) return null;
        return accountsStore.labelResolver
          ? accountsStore.labelResolver()
          : (d) => accountsStore.labelFor(d);
      } catch { return null; }
    }

    _settingsModelResolver() {
      try {
        const accountsStore = (getAccounts && getAccounts()) || null;
        if (!accountsStore || !accountsStore.settingsModelResolver) return null;
        return accountsStore.settingsModelResolver();
      } catch { return null; }
    }

    modelFor(name, settingsModelFor = this._settingsModelResolver()) {
      try {
        const entry = getPersistence().get(name);
        return effectiveModel(entry, { settingsModelFor }) || '';
      } catch { return ''; }
    }

    accountFor(name, resolve = this._accountResolver()) {
      if (!resolve) return 'default';
      try {
        const entry = getPersistence().get(name);
        const dir = entry && entry.env && entry.env.CLAUDE_CONFIG_DIR;
        return dir ? (resolve(dir) || 'default') : 'default';
      } catch { return 'default'; }
    }

    _accountForWireAgent(agent) {
      if (!agent) return null;
      const s = this.sessions.get(agent);
      return s ? this.accountFor(s.name) : null;
    }

    list() {
      const teamByCwd = new Map();
      const resolvedTeamFor = (cwd) => {
        if (!cwd) return null;
        if (teamByCwd.has(cwd)) return teamByCwd.get(cwd);
        let t = null;
        try { t = resolveTeam(cwd); } catch { t = null; }
        teamByCwd.set(cwd, t);
        return t;
      };
      const teamFor = (cwd) => { const t = resolvedTeamFor(cwd); return t ? t.name : null; };
      const ticketsByRoot = new Map();
      const liveByRoot = new Map();
      const liveSeatsFor = (t) => {
        if (!liveByRoot.has(t.root)) liveByRoot.set(t.root, this._teamLiveSeatNames(t.root));
        return liveByRoot.get(t.root);
      };
      // Sole place this row resolves a role: the renderer cannot recompute it, matchSeatRole strips
      // a review tail, guards with hasOwnProperty and short-circuits on the lead pointer.
      const roleByName = new Map();
      const roleFor = (s) => {
        if (roleByName.has(s.name)) return roleByName.get(s.name);
        let role = null;
        try {
          const t = resolvedTeamFor(s.cwd);
          role = t ? matchSeatRole(t, s.name) : null;
        } catch { role = null; }
        roleByName.set(s.name, role);
        return role;
      };
      const openTicketFor = (s) => {
        try {
          const t = resolvedTeamFor(s.cwd);
          if (!t || !t.root) return null;
          if (!ticketsByRoot.has(t.root)) ticketsByRoot.set(t.root, ticketsStore.load(t.root));
          const role = roleFor(s);
          const live = liveSeatsFor(t);
          // Same filter as _reconcileTickets: a term missing there shows the ticket on first paint
          // and drops it at the next reconcile.
          const open = ticketsByRoot.get(t.root).find((tk) => tk.state === 'open' && tk.assignee != null && !tk.parked
            && (tk.assignee === s.name || tk.assignee === role
              || this._ticketAssigneeSeat(t, tk, live) === s.name));
          return open ? open.id : null;
        } catch { return null; }
      };
      const resolveAccount = this._accountResolver();
      const resolveSettingsModel = this._settingsModelResolver();
      const records = new Map();
      try { for (const e of getPersistence().list()) records.set(e.name, e); } catch {}
      return Array.from(this.sessions.values()).map(s => ({
        name: s.name,
        type: s.type,
        pid: this._procPid(s),
        io: s.io || 'pty',
        voice: voiceModeOf(records.get(s.name)),
        effort: records.get(s.name)?.effort || null,
        posture: postureOf(adapterFor(s.type), records.get(s.name)?.extraArgs || []),
        cwd: s.cwd,
        workspaceId: s.workspaceId,
        team: teamFor(s.cwd),
        role: s.agentType ? roleFor(s) : null,
        ticket: s.agentType ? openTicketFor(s) : null,
        backend: s.backend || null,
        noWire: !!s.noWire,
        ...(s.fixFor ? { fixFor: s.fixFor } : {}),
        activity: s.activityState || 'idle',
        compacting: s.compacting || null,
        attention: s.needsAttention ? s.needsAttention.kind : null,
        account: this.accountFor(s.name, resolveAccount),
        model: s.type === 'claude' ? this.modelFor(s.name, resolveSettingsModel) : null,
        pendingCount: s.agentType === 'claude' ? countPending(PENDING_DIR, s.name) : 0,
      }));
    }

    listForWorkspace(workspaceId) {
      return this.list().filter(s => s.workspaceId === workspaceId);
    }

    savedForWorkspace(workspaceId) {
      return getPersistence().listForWorkspace(workspaceId).filter(e => e && e.name && !this.sessions.has(e.name));
    }

    purgeWorkspace(workspaceId) {
      const killed = [];
      for (const s of this.listForWorkspace(workspaceId)) { killed.push(s.name); this.kill(s.name); }
      const dropped = [];
      for (const e of getPersistence().listForWorkspace(workspaceId)) {
        if (!e || !e.name) continue;
        this.clearHintForRecord(e.name);
        getPersistence().remove(e.name);
        dropped.push(e.name);
      }
      if (dropped.length) {
        log.info('session', `workspace ${workspaceId}: dropped ${dropped.length} saved/archived record(s): ${dropped.join(', ')}`);
      }
      return { killed, dropped };
    }

    livePids() {
      const pids = new Set();
      for (const s of this.sessions.values()) {
        if (s.pty && Number.isInteger(s.pty.pid)) pids.add(s.pty.pid);
        else if (s.stream && Number.isInteger(s.stream.pid)) pids.add(s.stream.pid);
      }
      return pids;
    }

    trackedSessionIds() {
      const ids = new Set();
      for (const s of this.sessions.values()) if (s.sessionId) ids.add(s.sessionId);
      for (const e of getPersistence().list()) {
        if (e.sessionId) ids.add(e.sessionId);
        if (Array.isArray(e.sessionIds)) for (const id of e.sessionIds) ids.add(id);
      }
      return ids;
    }

    pendingCountFor(name) {
      const s = this.sessions.get(name);
      return s && s.agentType === 'claude' ? countPending(PENDING_DIR, s.name) : 0;
    }

    peekPendingFor(name) {
      const s = this.sessions.get(name);
      return s && s.agentType === 'claude' ? peekPending(PENDING_DIR, s.name) : [];
    }

    // Poll, not events: the UserPromptSubmit hook drains the store out of process with a
    // dir-rename Node never observes.
    startPendingPoll(intervalMs = 1000) {
      if (this._pendingPollTimer) return;
      const tick = () => {
        const live = new Set();
        for (const s of this.sessions.values()) {
          if (s.agentType !== 'claude' || s._dead) continue;
          live.add(s.name);
          const count = countPending(PENDING_DIR, s.name);
          if ((this._lastPendingCounts.get(s.name) || 0) === count) continue;
          if (count > 0) this._lastPendingCounts.set(s.name, count);
          else this._lastPendingCounts.delete(s.name);
          this._broadcast('pending-count', { name: s.name, count });
        }
        for (const name of Array.from(this._lastPendingCounts.keys())) {
          if (live.has(name)) continue;
          this._lastPendingCounts.delete(name);
          this._broadcast('pending-count', { name, count: 0 });
        }
      };
      this._pendingPollTimer = setInterval(tick, intervalMs);
    }

    async killAll() {
      setAppQuitting(true);
      for (const s of this.sessions.values()) {
        s._shuttingDown = true;
      }
      const rows = psSnapshotSync(childProcess);
      for (const [name] of this.sessions) {
        const s = this.sessions.get(name);
        if (s.stream) { s.stream.kill(); continue; }
        if (s.pty && Number.isInteger(s.pty.pid)) reapFromSnapshot({ rows, ptyPid: s.pty.pid, name, log });
        try { s.pty.kill(); } catch {}
      }
      this.killVoiceEngine();
    }

    _voiceSleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    voiceEngineTimings() {
      return {
        bootSettleMs: voiceEngineSpec.BOOT_SETTLE_MS,
        bootMaxMs: voiceEngineSpec.BOOT_MAX_MS,
        repaintMaxMs: voiceEngineSpec.REPAINT_MAX_MS,
      };
    }

    ensureVoiceEngine(armedBy = null) {
      const live = this._voiceEngine;
      if (live && !live.dead) return live.ready.then(() => live);
      if (this._voiceEnginePending) return this._voiceEnginePending;
      const pending = this._spawnVoiceEngine(armedBy).finally(() => {
        if (this._voiceEnginePending === pending) this._voiceEnginePending = null;
      });
      this._voiceEnginePending = pending;
      return pending;
    }

    async _spawnVoiceEngine(armedBy = null) {
      const { VOICE_ENGINE_NAME, PROMPT_MARK, SCREEN_RESET, engineArgs } = voiceEngineSpec;
      const t = this.voiceEngineTimings();
      if (!WIRE_SHADOW) throw new Error('the voice engine needs the in-process wire, which is off');
      const wire = await this._ensureWire();
      const wireBase = wire.registerAgent(VOICE_ENGINE_NAME, { voiceSink: true });
      if (!wireBase) throw new Error('the wire refused the voice engine');
      const cwd = getUserDataPath();
      preseedClaudeOnboarding({ fs, path, homeDir: os.homedir(), cwd });
      const env = withUtf8Charset({ ...process.env, TERM: 'xterm-256color' });
      let proc;
      try {
        proc = pty.spawn('claude', engineArgs(wireBase), { name: 'xterm-256color', cols: 120, rows: 30, cwd, env });
      } catch (e) {
        try { wire.unregisterAgent(VOICE_ENGINE_NAME); } catch {}
        throw e;
      }
      let markReady;
      const engine = {
        name: VOICE_ENGINE_NAME, pty: proc, cols: 120, rows: 30, recording: false,
        armedBy, promptWaiters: [], dead: false, ready: new Promise((r) => { markReady = r; }),
      };
      let seen = false;
      let settle = null;
      const cap = setTimeout(() => markReady(), t.bootMaxMs);
      const firstWin = armedBy && armedBy.workspaceId ? this.windowForWorkspace(armedBy.workspaceId) : null;
      if (firstWin) firstWin.webContents.send('pty-data', VOICE_ENGINE_NAME, SCREEN_RESET);
      proc.onData((data) => {
        const marked = String(data).includes(PROMPT_MARK);
        if (!seen && marked) seen = true;
        if (seen) {
          clearTimeout(settle);
          settle = setTimeout(() => { clearTimeout(cap); markReady(); }, t.bootSettleMs);
        }
        const ws = engine.armedBy && engine.armedBy.workspaceId;
        const win = ws ? this.windowForWorkspace(ws) : null;
        if (win) win.webContents.send('pty-data', VOICE_ENGINE_NAME, data);
        if (engine.recording && voiceEngineSpec.recorderSelfStopped(data)) this._voiceEngineSelfStopped(engine);
        if (marked) for (const wake of engine.promptWaiters.splice(0)) wake();
      });
      proc.onExit(() => {
        engine.dead = true;
        clearTimeout(cap);
        clearTimeout(settle);
        for (const wake of engine.promptWaiters.splice(0)) wake();
        markReady();
        if (this._voiceEngine && this._voiceEngine !== engine) return;
        this._voiceEngine = null;
        if (this._wire) { try { this._wire.unregisterAgent(VOICE_ENGINE_NAME); } catch {} }
      });
      this._voiceEngine = engine;
      await engine.ready;
      if (engine.dead) throw new Error('the voice engine exited while starting');
      return engine;
    }

    _voiceEnginePrompt(engine, ms) {
      return new Promise((resolve) => {
        const wake = () => { clearTimeout(cap); resolve(); };
        const cap = setTimeout(() => {
          const i = engine.promptWaiters.indexOf(wake);
          if (i !== -1) engine.promptWaiters.splice(i, 1);
          resolve();
        }, ms);
        engine.promptWaiters.push(wake);
      });
    }

    async _repaintVoiceEngine(engine) {
      const { cols, rows } = engine;
      const t = this.voiceEngineTimings();
      const wider = this._voiceEnginePrompt(engine, t.repaintMaxMs);
      engine.pty.resize(cols + 1, rows);
      await wider;
      const back = this._voiceEnginePrompt(engine, t.repaintMaxMs);
      engine.pty.resize(cols, rows);
      await back;
    }

    _voiceEngineSelfStopped(engine) {
      engine.recording = false;
      const armedBy = engine.armedBy;
      const win = armedBy && armedBy.workspaceId ? this.windowForWorkspace(armedBy.workspaceId) : null;
      if (win) win.webContents.send('voice-engine-stopped', armedBy.name);
    }

    async voiceRecord(name, action, { workspaceId = null, observed = null } = {}) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return { ok: false, error: `no live session "${name}"` };
      if (!voiceEngineSpec.RECORD_ACTIONS.includes(action)) return { ok: false, error: `unknown record action "${action}"` };
      const armedBy = { name, workspaceId: workspaceId || s.workspaceId || null };
      const run = () => this._voiceRecordNow(armedBy, action, observed);
      const op = this._voiceOp.then(run, run);
      this._voiceOp = op.catch(() => {});
      return op;
    }

    async _voiceRecordNow(armedBy, action, observed = null) {
      const mode = this.voiceModeFor(armedBy.name);
      if (mode === 'off') return { ok: false, error: 'voice is off for this seat' };
      const prior = this._voiceEngine;
      let engine;
      try { engine = await this.ensureVoiceEngine(armedBy); } catch (e) { return { ok: false, error: e.message }; }
      const sameWindow = engine === prior && engine.armedBy && engine.armedBy.workspaceId === armedBy.workspaceId;
      const tracked = engine.recording;
      if (observed && typeof observed === 'object' && sameWindow) {
        const seen = observed.recording === true;
        if (seen !== engine.recording) {
          this._shadowLog({ type: 'voice-engine-resync', agent: armedBy.name, tracked: engine.recording, observed: seen });
        }
        engine.recording = seen;
        if (observed.processing === true && action !== 'stop') {
          log.info('voice', `${armedBy.name} record ${action} refused: the recorder is still transcribing`);
          return { ok: false, error: 'the recorder is still transcribing' };
        }
      }
      const plan = voiceEngineSpec.planRecord({ mode, action, recording: engine.recording });
      const clearRow = !!(plan && plan.write && plan.recording === true && sameWindow && observed && typeof observed === 'object' && observed.text === true);
      log.info('voice', `${armedBy.name} record ${action} mode=${mode} observed=${observed ? JSON.stringify(observed) : 'none'} tracked=${tracked} plan=${JSON.stringify(plan)}${plan && plan.write ? ' RECORD_KEY written' : ''}${clearRow ? ' row cleared' : ''}`);
      const { RECORD_KEY } = voiceEngineSpec;
      const prevWs = engine.armedBy && engine.armedBy.workspaceId;
      engine.armedBy = armedBy;
      if (armedBy.workspaceId && armedBy.workspaceId !== prevWs && !engine.dead) {
        try { await this._repaintVoiceEngine(engine); } catch {}
      }
      if (clearRow) {
        engine.pty.write('\x15');
        await this._voiceSleep(CTRLU_SETTLE_MS);
        if (engine.dead || this._voiceEngine !== engine) return { ok: false, error: 'the recorder engine went away' };
      }
      if (plan.write) engine.pty.write(RECORD_KEY);
      engine.recording = plan.recording;
      return { ok: true, recording: plan.recording, engine: engine.name };
    }

    killVoiceEngine() {
      const engine = this._voiceEngine;
      if (!engine) return;
      this._voiceEngine = null;
      try { engine.pty.kill(); } catch {}
      if (this._wire) { try { this._wire.unregisterAgent(engine.name); } catch {} }
    }

    _cleanup(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      clearTimeout(s._injectHoldTimer);
      clearTimeout(s._injectFlushRetry);
      clearTimeout(s._compactValveTimer);
      this._onCompactEnd(s, 'exit');
      clearTimeout(s._postClearValveTimer);
      clearTimeout(s._parkCapTimer);
      clearTimeout(s._bootSettleTimer);
      clearTimeout(s._bootDrainTimer);
      clearTimeout(s._bootNudgeTimer);
      s._bootNudgeEcho = null;
      clearTimeout(s._bootReplayTimer);
      clearTimeout(s._replayFallbackTimer);
      clearTimeout(s._parkedDrainFallbackTimer);
      clearTimeout(s._rebootNoticeRetryTimer);
      clearTimeout(s._rebootNoticeFlushTimer);
      clearTimeout(s._specConfirmTimer);
      // _specOwedTimer stays separate from _specConfirmTimer: both are live at once,
      // so one field cannot hold both.
      clearTimeout(s._specOwedTimer);
      clearTimeout(s._dmConfirmTimer);
      clearTimeout(s._reviewStartTimer);
      // Also drops the pending debounce timer and the offer cooldown: a same-named
      // replacement must not inherit a hint or start life already suppressed.
      try { arm.forget(name, name); } catch {}
      try { selectionArm.forget(name, this._armCtx(s)); } catch {}
      s._compactPending = null;
      s._postClearContinuation = null;
      if (this._wire) { try { this._wire.unregisterAgent(name, { keepSpillShown: s._shuttingDown === true }); } catch {} }
      // Watcher before speaker: stop() flushes pending text, which can start a narration
      // for the dead seat. The speaker's stop is unconditional because the speaker is box-wide.
      if (s.watcher) s.watcher.stop();
      try { speaker.stop(); } catch {}
      if (s.sentinel) { try { s.sentinel.stop(); } catch {} }
      if (s.ctxWatcher) { try { s.ctxWatcher.close(); } catch {} }
      this._scratchDropPendingBegin(s);
      if (s.transport) s.transport.stop();
      if (s.agentType) registry.unregister(name);
      if (s.agentType === 'claude') { cleanupClaudeHook(name); cleanupAgentPlugin(name); }
      if (s.agentType === 'codex') cleanupCodexHook(name, s.cwd);
      if (s.agentType === 'muse') cleanupMuseSeat(name);
      if (s.agentType) cleanupSkills(s.agentType, name);
      this.sessions.delete(name);
      const live = new Set(this.sessions.keys());
      try { this._intentDeduper.prune(live); this._activity.prune(live); } catch {}
      if (this._reportCache) { try { this._reportCache.delete(name); } catch {} }
      if (getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
    }


    _scanPtyOutput(session, data) {
      session.lineBuffer += data;
      const lines = session.lineBuffer.split(/\r?\n/);
      session.lineBuffer = (lines.pop() || '').slice(-64 * 1024);

      for (const line of lines) {
        const intent = parseIntent(line);
        if (!intent || intent.type === 'escape' || intent.type === 'end') continue;
        this._handleIntent(session.name, intent);
      }
    }

    // Do not weaken genuineSubagent's fingerprint backstop to hide the one-turn parent-as-subagent row on a fresh process.
    // The key must stay byte-identical to wirescope's instance key, or a live subagent's chip shows an empty feed.
    _noteSubagentTurn(session, t) {
      try {
        if (!session.subagentStore) return;
        noteSubagentTurn(session.subagentStore, {
          key: t.agentId || t.role,
          role: t.role,
          model: t.model,
          text: t.text,
          // thinking stays separate from text: only text reaches the intent scanner.
          thinking: t.thinking,
          tools: t.toolUses,
          truncated: t.truncated,
          thinkingTruncated: t.thinkingTruncated,
          ts: Date.now(),
        });
      } catch { /* observer-grade — never near the PTY/intent path */ }
    }

    _noteFileTouches(session, touches, sub = false) {
      try {
        noteFileTouches(session.fileTouches, touches, {
          cwd: session.cwd, ts: Date.now(), sub, resolve: path.resolve,
        });
        this._sendToSession(session.name, 'session-files', session.name, session.fileTouches);
        const count = session.fileTouches.length;
        if (session._peerFileCount !== count) {
          session._peerFileCount = count;
          try { getRemoteServer() && getRemoteServer().pushTelemetry(session.name, { files: { count } }); } catch {}
        }
      } catch { /* observer-grade — never near the PTY/intent path */ }
    }

    _emitActivity(name, state, notify) {
      const s = this.sessions.get(name);
      if (s && s.activityState !== state) {
        // Stamp from the wire's last event, not Date.now(): an inferred idle edge stamped now makes a
        // cold seat read as fresh and its dm is delivered instead of held.
        s.activityState = state;
        s.activityTs = Math.max(s.activityTs || 0, this._activity.lastEventTs(name) || Date.now());
        if (state !== 'idle') s._turnStartedAt = Date.now();
        if (typeof scheduleTrayRefresh === 'function') scheduleTrayRefresh();
      }
      if (s && state !== 'idle') s.lastMainStop = null;
      if (s && state !== 'idle') s._awaitingTurnSince = null;
      if (s && state !== 'idle' && s._parkedEscalations && s._parkedEscalations.size) this._releaseDrainedEscalations(s);
      // A turn confirms the spec write only if it is attributed to this ticket in the transcript;
      // otherwise the latch stays armed and its deadline redelivers.
      if (s && state !== 'idle' && s._specUnconfirmed) {
        const u = s._specUnconfirmed;
        // Anchor at the byte reached when this write went out: a respawned seat's transcript already
        // holds this ticket's marker. A null probe trusts the turn, never manufacturing a redelivery.
        const has = this._seatTranscriptHas(s.name, u.ticketId, u.since, undefined, u.sinceFile);
        if (has === false) {
          log.warn('inject', `${s.name} started a turn but ${u.ticketId} is absent from its transcript — not clearing the latch, the turn was something else`);
        } else {
          // A receipt exit: the other is _checkSpecConfirm's deadline re-probe, reached only when no
          // turn cleared the latch first, so the displacement episode must end here too.
          this._pruneOwedSpent(s, u);
          s._specUnconfirmed = null;
          clearTimeout(s._specConfirmTimer);
          s._specConfirmTimer = null;
        }
      }
      if (s && state !== 'idle' && ((s._dmUnconfirmed && s._dmUnconfirmed.length) || s._dmUnconfirmedLast)) {
        this._clearDmConfirm(s);
      }
      // Cheap disarm on the first turn: after a start and finish inside the window the deadline sees
      // idle again and only the transcript would say the review started.
      if (s && state !== 'idle' && s._reviewStartTimer) {
        clearTimeout(s._reviewStartTimer);
        s._reviewStartTimer = null;
      }
      if (s && state !== 'idle' && s._bootNudgeTimer) {
        clearTimeout(s._bootNudgeTimer);
        s._bootNudgeTimer = null;
        s._bootNudgeEcho = null;
      }
      if (state !== 'idle') this._touchTicketActivity(name);
      if (s && state !== 'idle' && s.needsAttention && !(s.streamPermissions && s.streamPermissions.size)) this._setAttention(s, null);
      if (s && state === 'idle') { this._maybeFlushInjectQueue(s); this._drainPendingAtIdle(s); }
      // notify marks turn-end; idle also fires mid-turn (wire gap-idle, jsonl text flush), so a consumer
      // acting on state alone acts in the middle of turns.
      this._sendToSession(name, 'session-activity', name, state, !!notify);
      if (getRemoteServer()) { try { getRemoteServer().notifyActivity(name, state, notify, s && typeof s.activityTs === 'number' ? s.activityTs : null); } catch {} }
      if (!notify) return;
      const owningWin = this.windowForSession(name);
      if (!owningWin || !owningWin.isFocused()) {
        try {
          notifyOS({
            title: `${name} finished`,
            body: 'Agent completed a turn.',
            silent: false,
          });
        } catch {}
      }
    }

    _onAttention(session, entry) {
      const kind = classifyNotification(entry);
      if (kind === 'idle') return;
      this._setAttention(session, {
        kind, ts: Date.now(),
        message: (entry && typeof entry.message === 'string') ? entry.message : '',
      });
      this._broadcast('ipc-message', {
        type: 'attention', from: session.name, to: '',
        body: `${kind}: ${session.needsAttention.message || '(no message)'}`,
      });
      const owningWin = this.windowForSession(session.name);
      if (!owningWin || !owningWin.isFocused()) {
        try {
          notifyOS({
            title: `${session.name} needs you`,
            body: session.needsAttention.message || 'Waiting on a dialog.',
            silent: false,
          });
        } catch {}
      }
    }

    _routeAttnEntry(session, entry) {
      if (entry && entry.hook_event_name === 'PreCompact') this._onCompactStart(session, entry.trigger);
      else if (entry && entry.hook_event_name === 'SessionStart') { if (entry.source === 'compact') this._onCompactEnd(session, 'done'); }
      else if (entry && entry.hook_event_name === 'PreToolUse') this._onStreamToolBoundary(session);
      else this._onAttention(session, entry || {});
    }

    _onCompactStart(session, trigger) {
      const kind = trigger === 'auto' ? 'auto' : 'manual';
      clearTimeout(session._compactingValveTimer);
      session._compactingValveTimer = setTimeout(() => {
        session._compactingValveTimer = null;
        if (!session.compacting) return;
        log.warn('session', `compacting ${session.name}: no end signal within ${COMPACTING_VALVE_MS / 1000}s, cleared`);
        this._onCompactEnd(session, 'valve');
      }, COMPACTING_VALVE_MS);
      if (session.compacting) return;
      session.compacting = { since: Date.now(), trigger: kind };
      this._sendToSession(session.name, 'session-compacting', session.name, session.compacting);
      this._broadcast('ipc-message', {
        type: 'context', from: session.name, to: session.name,
        body: `compact started (${kind})`,
      });
    }

    _onCompactEnd(session, outcome = 'done') {
      clearTimeout(session._compactingValveTimer);
      session._compactingValveTimer = null;
      const c = session.compacting;
      if (!c) return;
      session.compacting = null;
      const ms = Date.now() - c.since;
      if (outcome !== 'exit') {
        if (!session._compactNotices) session._compactNotices = [];
        session._compactNotices.push({ id: `compact:${c.since}`, ts: c.since, ms, outcome, text: noticeTextFor(outcome, ms) });
        if (session._compactNotices.length > COMPACT_NOTICE_CAP) session._compactNotices.shift();
        session._compactNoticeRev = (session._compactNoticeRev || 0) + 1;
      }
      this._sendToSession(session.name, 'session-compacting', session.name, null, { outcome, ms });
      if (outcome === 'exit') return;
      this._sendToSession(session.name, 'transcript-changed', session.name);
      if (outcome === 'done') {
        this._broadcast('ipc-message', {
          type: 'context', from: session.name, to: session.name,
          body: `compact finished in ${Math.round(ms / 1000)}s`,
        });
      }
    }

    compactNoticesFor(name) {
      const s = this.sessions.get(name);
      if (!s || !s._compactNotices || !s._compactNotices.length) return null;
      return { rev: s._compactNoticeRev || 0, notices: s._compactNotices };
    }

    _setAttention(session, attn) {
      session.needsAttention = attn;
      this._sendToSession(session.name, 'session-attention', session.name, attn);
      if (typeof scheduleTrayRefresh === 'function') scheduleTrayRefresh();
      if (!attn) this._maybeFlushInjectQueue(session);
    }

    _fireCompactContinuation(session) {
      this._onCompactEnd(session);
      try { this._stampSeatCost(session, 'compact'); } catch {}
      this._voidScratchMark(session,
        'a compact landed inside the episode — every mark is gone and nothing can be cut. Your summary '
        + 'is in your own turn above; carry on from it.');
      // Reset the live set to empty rather than model what the summarizer kept: possibly-evicted
      // must read as not loaded.
      try { memLoad.noteCompact(session.name); } catch { /* observer-grade */ }
      // Separate ledger from memLoad: already in context and already offered reset side by side.
      try { arm.onContextReset(session.name); } catch { /* observer-grade */ }
      const sched = getRemindScheduler && getRemindScheduler();
      if (this._compactRegen(session, sched)) return;
      // The whole prompt-delta gap is re-staged for the next prompt; the frozen prompt file is not
      // rewritten because the CLI would not read it.
      try { this.refreshPrompt(session.name, 'compact'); } catch { /* never block the continuation on a refresh */ }
      this._clearCompactValve(session);
      if (sched) { try { sched.fireCompactFor(session.name); } catch {} }
      const cont = session._compactContinuation;
      if (cont) {
        session._compactContinuation = null;
        setTimeout(() => {
          if (session._dead) return;
          const text = this._handoffText(session, cont);
          this._injectText(session, text, { bypassHold: true });
          const delay = text.length > LONG_TEXT_THRESHOLD ? LONG_TEXT_DELAY : SHORT_TEXT_DELAY;
          setTimeout(() => this._releaseCompactGuard(session), delay + 200);
        }, COMPACT_CONTINUATION_DELAY);
      } else {
        this._releaseCompactGuard(session);
      }
    }

    _compactRegen(session, sched) {
      const name = session.name;
      const cont = session._compactContinuation;
      if (!cont) return false;
      const entry = getPersistence().get(name);
      if (!entry || !entry.sessionId) return false;
      const regen = {};
      if (!this._promptDeltaPending(name, regen)) return false;
      session._compactContinuation = null;
      this._clearCompactValve(session);
      const onKilled = () => { if (sched) { try { sched.fireCompactFor(name); } catch {} } };
      if (!this._coldRespawn(name, entry, session, cont, 'compact', { resume: true, onKilled })) return false;
      log.info('intent', `compact ${name} → resumed with a regenerated prompt (${regen.bytes} bytes)`);
      this._broadcast('ipc-message', {
        type: 'context', from: name, to: name, body: 'context compact → resumed with a regenerated prompt',
      });
      this._shadowLog({ type: 'prompt-regen-at-compact', agent: name, bytes: regen.bytes });
      return true;
    }

    _injectHoldReason(session) {
      if (session._compactGuard) return 'compact-window';
      if (session.needsAttention && session.needsAttention.kind === 'permission') return 'dialog';
      if (session.activityState === 'thinking') return 'busy';
      return null;
    }

    _armInjectValve(session) {
      if (session._injectHoldTimer) return;
      session._injectHoldTimer = setTimeout(() => {
        session._injectHoldTimer = null;
        console.warn(`inject hold ${session.name}: release never came (${this._injectHoldReason(session) || 'none'}) — forcing flush after timeout`);
        session._compactGuard = false;
        this._maybeFlushInjectQueue(session, true);
      }, INJECT_HOLD_TIMEOUT);
    }

    _armCompactGuard(session) {
      session._compactGuard = true;
      clearTimeout(session._injectHoldTimer);
      session._injectHoldTimer = null;
      this._armInjectValve(session);
    }

    _releaseCompactGuard(session) {
      this._clearCompactValve(session);
      if (!session._compactGuard) return;
      session._compactGuard = false;
      this._maybeFlushInjectQueue(session);
    }

    _armCompactValve(session) {
      this._clearCompactValve(session);
      session._compactValveTimer = setTimeout(() => {
        session._compactValveTimer = null;
        const wasStuck = session._compactPending || session._compactGuard || session._compactContinuation;
        session._compactPending = null;
        session._compactGuard = false;
        session._compactContinuation = null;
        if (wasStuck) {
          log.warn('intent', `compact ${session.name} release valve fired — summary never landed, cleared stuck in-flight state (no retry)`);
          this._broadcast('ipc-message', {
            type: 'context', from: session.name, to: session.name,
            body: 'context compact → in-flight valve released (summary never landed)',
          });
        }
        this._maybeFlushInjectQueue(session);
      }, COMPACT_INFLIGHT_TIMEOUT);
    }

    _clearCompactValve(session) {
      if (session._compactValveTimer) { clearTimeout(session._compactValveTimer); session._compactValveTimer = null; }
    }

    // Fire only from the sessionId-change edge (create()'s onSessionId): /clear mints a new id and
    // /compact keeps it, so a timer would inject into whatever conversation is current.
    _firePostClearContinuation(session) {
      const cont = session._postClearContinuation;
      if (!cont) return;
      session._postClearContinuation = null;
      this._clearPostClearValve(session);
      setTimeout(() => {
        if (session._dead) return;
        this._injectText(session, this._handoffText(session, cont));
      }, COMPACT_CONTINUATION_DELAY);
    }

    _armPostClearValve(session) {
      this._clearPostClearValve(session);
      session._postClearValveTimer = setTimeout(() => {
        session._postClearValveTimer = null;
        const dropped = session._postClearContinuation;
        session._postClearContinuation = null;
        if (dropped) {
          log.warn('intent', `clear ${session.name} release valve fired — clear never landed, dropped the continuation (${dropped.length} chars, no retry)`);
          this._broadcast('ipc-message', {
            type: 'context', from: session.name, to: session.name,
            body: 'context clear → continuation dropped (clear never landed)',
          });
        }
      }, COMPACT_INFLIGHT_TIMEOUT);
    }

    _clearPostClearValve(session) {
      if (session._postClearValveTimer) { clearTimeout(session._postClearValveTimer); session._postClearValveTimer = null; }
    }

    _maybeFlushInjectQueue(session, force = false) {
      clearTimeout(session._injectFlushRetry);
      session._injectFlushRetry = null;
      if (session._dead) return;
      if (session.io === 'stream' && session._injectQueue && session._injectQueue.length) {
        const held = session._injectQueue.splice(0);
        for (const e of held) {
          if (e && typeof e.produce === 'function') this._streamEnqueueSystem(session, '', e.produce, 'queued flush');
          else if (e && e.opts) this._streamEnqueueSystem(session, e.text, null, 'queued flush', null, e.opts.parkKey || null);
          else this._streamEnqueueSystem(session, e, null, 'queued flush');
        }
        return;
      }
      const queue = session._injectQueue;
      if (!queue || !queue.length) {
        if (!session._compactGuard) {
          clearTimeout(session._injectHoldTimer);
          session._injectHoldTimer = null;
        }
        return;
      }
      if (!force && this._injectHoldReason(session)) return;
      clearTimeout(session._injectHoldTimer);
      session._injectHoldTimer = null;
      session._injectQueue = [];
      let run = [];
      for (const e of queue) {
        if (!e || !e.opts) { run.push(e); continue; }
        this._flushInjectRun(session, run);
        run = [];
        this._injectText(session, e.text || '', { ...e.opts, bypassHold: true });
      }
      this._flushInjectRun(session, run);
    }

    _flushInjectRun(session, queue) {
      if (!queue.length) return;
      if (queue.some((e) => e && typeof e.produce === 'function')) {
        const produce = () => {
          const parts = [];
          for (const e of queue) {
            if (e && typeof e.produce === 'function') {
              let p = null;
              try { p = e.produce(); } catch { p = null; }
              if (p) parts.push(p);
            } else if (e) parts.push(e);
          }
          return parts.length ? parts.join('\n') : null;
        };
        this._injectText(session, '', { bypassHold: true, produce });
        return;
      }
      this._injectText(session, queue.join('\n'), { bypassHold: true });
    }

    _drainPendingAtIdle(session) {
      if (!session || session.agentType !== 'claude' || session._dead || session._recycling) return;
      if (this._anyDraftOpen(session)) return;
      if (!hasActivePending(PENDING_DIR, session.name)) return;
      this._injectText(session, '', {
        parkable: true,
        parkKey: session.io === 'stream' ? PENDING_DRAIN_KEY : null,
        produce: () => {
          if (session._dead || session._recycling) return null;
          if (this._anyDraftOpen(session)) return null;
          let texts = [];
          try { texts = drainPending(PENDING_DIR, session.name, `idle.${process.pid}`, this._bornFor(session.name)); } catch { return null; }
          if (!texts.length) {
            log.debug('inject', `idle drain for ${session.name} claimed nothing — hook already drained it`);
            return null;
          }
          return texts.join('\n\n');
        },
      });
    }

    _drainPendingAtBootReady(session) {
      if (!session || session.agentType !== 'claude' || session._dead || session._recycling) return;
      if (this._anyDraftOpen(session)) return;
      if (!hasActivePending(PENDING_DIR, session.name)) return;
      const produce = () => {
        if (session._dead || session._recycling) return null;
        if (this._anyDraftOpen(session)) return null;
        let texts = [];
        try { texts = drainPending(PENDING_DIR, session.name, `boot.${process.pid}`, this._bornFor(session.name)); } catch { return null; }
        if (!texts.length) {
          log.debug('inject', `boot-ready drain for ${session.name} claimed nothing — another drainer won or every entry failed the born check`);
          return null;
        }
        return texts.join('\n\n');
      };
      this._injectQueueFor(session).enqueue('', { produce, divert: this._parkDivertFor(session) });
    }

    _replayWhenQueueEmpty(session) {
      clearTimeout(session._bootReplayTimer);
      session._bootReplayTimer = null;
      if (session._dead || !session._replayTicketsPending) return;
      const q = session._injectPtyQueue;
      const capped = Date.now() - (session._bootReadyAt || 0) >= INJECT_BOOT_MAXWAIT;
      if (q && q.length > 0 && !capped) {
        session._bootReplayTimer = setTimeout(() => this._replayWhenQueueEmpty(session), BOOT_REPLAY_POLL_MS);
        if (session._bootReplayTimer.unref) session._bootReplayTimer.unref();
        return;
      }
      this._replayTicketsOnce(session);
    }

    _recordBootNudgeProbe(session, bytes) {
      if (session._bootNudgeProbe) return;
      const probe = bootNudgeProbeOf(bytes);
      if (!probe) return;
      session._bootNudgeProbe = probe;
      session._bootNudgeEcho = '';
    }

    _bootNudgeEchoed(session) {
      if (!session._bootNudgeProbe || typeof session._bootNudgeEcho !== 'string') return false;
      const seen = inkVisibleText(session._bootNudgeEcho);
      return seen.includes(session._bootNudgeProbe) || seen.includes(BOOT_NUDGE_PASTE_PLACEHOLDER);
    }

    _armBootNudge(session, bytes) {
      if (!session || session.agentType !== 'claude' || session._dead) return;
      if (session._bootNudgeArmed) {
        if (session._bootNudgeTimer) this._recordBootNudgeProbe(session, bytes);
        return;
      }
      const readyAt = session._bootReadyAt;
      if (!readyAt || Date.now() - readyAt > INJECT_BOOT_MAXWAIT) return;
      session._bootNudgeArmed = true;
      const wroteAt = Date.now();
      this._recordBootNudgeProbe(session, bytes);
      const arm = (ms) => {
        session._bootNudgeTimer = setTimeout(fire, ms);
        if (session._bootNudgeTimer.unref) session._bootNudgeTimer.unref();
      };
      const fire = () => {
        session._bootNudgeTimer = null;
        if (session._dead) return;
        const echoed = this._bootNudgeEchoed(session);
        const painting = Date.now() - (session._lastPtyDataAt || 0) < BOOT_NUDGE_QUIET_MS;
        if (!echoed || painting || this._anyDraftOpen(session)) {
          if (Date.now() - wroteAt >= BOOT_NUDGE_MAXWAIT_MS) { session._bootNudgeEcho = null; return; }
          arm(BOOT_NUDGE_QUIET_MS);
          return;
        }
        session._bootNudgeEcho = null;
        if (!session.pty) return;
        if (!session.firstInputAt) session.firstInputAt = Date.now();
        try { session.pty.write('\r'); } catch {}
        log.info('inject', `boot-drain nudge for ${session.name} — no turn ${Date.now() - wroteAt}ms after a boot-window write, echo seen, last output at +${session._lastPtyDataAt - wroteAt}ms, sent Enter`);
      };
      arm(BOOT_NUDGE_MS);
    }


    _pointerStubOf(line) {
      const intent = parseIntent(line);
      if (!intent || !isSpillVerb(intent)) return null;
      const id = pointerOf(intent.body);
      if (!id) return null;
      const m = HEAD_RE.exec(line.trim());
      return m ? { id, head: m[0] } : null;
    }

    _expandReceipts(lines, agent) {
      const fenced = fencedLines(lines);
      const out = [];
      const spillAt = new Map();
      const unresolved = [];
      for (let i = 0; i < lines.length; i++) {
        const stub = fenced[i] ? null : this._pointerStubOf(lines[i]);
        if (stub) {
          const r = resolveSpill(REGISTRY_DIR, agent, stub.id);
          if (!r.ok) { out.push(lines[i]); continue; }
          const bodyLines = r.body.split('\n');
          spillAt.set(out.length, { id: stub.id, path: r.path });
          out.push(`${stub.head} ${bodyLines[0]}`, ...bodyLines.slice(1), '[agent:end]');
          const next = i + 1 < lines.length ? parseIntent(lines[i + 1]) : null;
          if (next && next.type === 'end') i += 1;
          continue;
        }
        const rc = fenced[i] ? null : receiptOf(lines[i]);
        if (!rc) { out.push(lines[i]); continue; }
        const r = resolveReceipt(REGISTRY_DIR, agent, rc.path);
        if (!r.ok) {
          unresolved.push({ type: rc.type, sub: rc.sub, body: '', text: rc.path, receipt: { path: rc.path, reason: r.reason } });
          continue;
        }
        const bodyLines = r.body.split('\n');
        spillAt.set(out.length, { id: r.id, path: r.path });
        out.push(`[agent:${rc.head}] ${bodyLines[0]}`, ...bodyLines.slice(1), '[agent:end]');
      }
      return { lines: out, spillAt, unresolved };
    }

    _extractIntents(text, opts = {}) {
      const intents = [];
      let lines = text.split('\n');
      let spillAt = null;
      if (opts.receiptsFor) {
        const ex = this._expandReceipts(lines, opts.receiptsFor);
        lines = ex.lines;
        spillAt = ex.spillAt.size ? ex.spillAt : null;
        intents.push(...ex.unresolved);
      }
      let unknown = null;
      for (const seg of scanIntentLines(lines, { execBodyCap, parseIntent, fencedLines, looksLikeIntent, bodyModeFor })) {
        if (seg.kind === 'near-miss') {
          if (unknown) unknown.more++;
          else { unknown = { type: 'unknown', text: seg.text.slice(0, 160), more: 0 }; intents.push(unknown); }
          continue;
        }
        if (seg.kind !== 'intent') continue;
        if (spillAt && spillAt.has(seg.from)) seg.intent.spill = spillAt.get(seg.from);
        if (seg.tail) openBodyTails.set(seg.intent, seg.tail);
        intents.push(seg.intent);
      }
      return intents;
    }

    _scanJsonlText(text, senderName, touches, meta) {
      const s = this.sessions.get(senderName);
      if (s) s._flushTurnEnd = !!(meta && meta.turnEnd);
      // Same gate as the publish below: a wire seat with a live tee already spoke from turn.completed, and
      // !s.backend keeps a tee-blind (Bedrock/Vertex) seat's watcher its only voice.
      if (!(s && s.wireRouted && !s.backend)) {
        this._maybeSpeak(senderName, text, !!(meta && meta.turnEnd));
      }
      // Shadow mode has both junctions live, so the wire wins or every turn double-delivers; !s.backend
      // keeps a tee-blind seat's watcher its only feed, and wireRouted alone blanks it.
      if (!(s && s.wireRouted && !s.backend)) {
        this._publishAgentText({
          session: senderName, text, source: 'jsonl', truncated: false,
          files: Array.isArray(touches) ? touches : [],
        });
      }
      const intents = this._extractIntents(text, { receiptsFor: senderName });
      for (const intent of intents) {
        if (meta && meta.interrupted && intent.bodyOpen) {
          if (s) this._injectText(s, `[agent:intent] your turn was interrupted while the body of `
            + `[agent:${intent.type}${intent.sub ? ' ' + intent.sub : ''}] was still open — `
            + 'the partial body was NOT applied; re-emit the whole intent and close it with [agent:end]',
          { parkable: true });
          continue;
        }
        if (WIRE_SHADOW && this._shadow && s && s.wireRouted && s.intentSource === 'jsonl') {
          try {
            this._shadow.record('jsonl', shadowIntentKey(senderName, intent), {
              agent: senderName, sessionId: (s && s.sessionId) || null,
              intentType: intent.type,
            });
          } catch { /* shadow only */ }
        }
        this._handleIntent(senderName, intent);
      }
      if (s && meta && meta.turnEnd) setImmediate(() => this._fireScratchClose(s));
      if (proseVerdictNeedsNudge({ text, intents, session: s })) {
        s._verdictNudged = true;
        log.info('team', `reviewer ${senderName} wrote a verdict with no review-done intent — nudged once`);
        this._deliverParkedActive(senderName, s.reviewFor, PROSE_VERDICT_NUDGE, 'dm');
      }
    }

    _publishAgentText(ev) {
      try {
        // Empty for every grant set; deliberately looser than the engine's per-plugin emptiness rule.
        const hasFiles = Array.isArray(ev.files) && ev.files.length;
        const hasReads = Array.isArray(ev.reads) && ev.reads.length;
        const hasTools = Array.isArray(ev.toolUses) && ev.toolUses.length;
        if (!ev.text && !hasFiles && !hasReads && !hasTools && !ev.thinking) return;
        if (getRemoteServer()) { try { getRemoteServer().notifyProgress(ev.session); } catch {} }
        const hooks = getPluginHooks && getPluginHooks();
        if (!hooks || typeof hooks.fireAgentText !== 'function') return;
        hooks.fireAgentText(ev);
      } catch { /* consume-only */ }
    }


    _maybeSpeak(name, text, turnEnd) {
      if (!turnEnd || !text) return;
      try {
        const s = this.sessions.get(name);
        if (!s || !s.agentType) return;
        const store = getUiSettings && getUiSettings();
        const cfg = store ? store.get() : null;
        if (!cfg || cfg.speakReplies !== true) return;
        // Only the seat holding control speaks: speak() kills the previous utterance. Do not reduce to
        // _micTarget alone, which is null on an alt-tabbed box before a seat is named.
        const holder = this._micTarget || this._focusedSession;
        if (!holder || name !== holder) return;
        // Read the box-wide recording stamp, never s.lastVoiceRecordingTs: the recorder is reported only for the
        // active seat. Absent evidence reads as not recording.
        if (Date.now() - (this._lastVoiceRecordingTs || 0) < INJECT_SPEAKING_STALE_MS) return;
        const say = speakable(text);
        if (!say) return;
        speaker.speak(say, { voice: cfg.speakVoice, rate: cfg.speakRate });
      } catch { /* observer-grade: speech must never break turn handling */ }
    }


    async _handleIntent(senderName, intent) {
      const session = this.sessions.get(senderName);

      if (intent.type === 'end') return;

      if (intent.type === 'unknown') {
        if (session && session.agentType) {
          const more = intent.more ? ` (+${intent.more} more unrecognized [agent:…] lines this turn)` : '';
          // Seat-scoped: this list goes into the seat's context, so naming a plugin verb the seat lacks
          // would advertise a plugin invisible to it.
          const seatPlugins = getPersistence().get(senderName)?.plugins;
          this._injectText(session,
            `[agent:?] unrecognized intent \`${intent.text}\`${more} — nothing was done. `
            + nearMissFormHint(intent.text)
            + `Valid intents: ${validIntentNames(seatPlugins).join(', ')}. `
            + 'To quote an intent literally, put it in a ``` code fence or escape it as \\[agent:…].', { parkable: true });
        }
        this._broadcast('ipc-message', {
          type: 'intent', from: senderName, to: senderName,
          body: `unrecognized intent bounced: ${intent.text}`,
        });
        return;
      }

      const spilledNote = spilledBodyOf(intent.body);
      if (spilledNote !== null) {
        this._spillTyped(session, senderName, intent, spilledNote, 'runtime note');
        return;
      }

      if (!isSpillVerb(intent) && typeof intent.body === 'string') {
        const typed = trailingPointerOf(intent.body.trim());
        if (typed) {
          this._spillTyped(session, senderName, intent, typed.pointer, 'pointer');
          return;
        }
      }

      if (isSpillVerb(intent)) {
        if (intent.receipt) {
          this._spillUnresolved(session, senderName, intent, intent.receipt.path, intent.receipt);
          return;
        }
        const stub = pointerMatch(intent.body);
        if (stub && intent.fromWire) {
          this._spillTyped(session, senderName, intent, stub.pointer, 'pointer');
          return;
        }
        if (stub) {
          const r = resolveSpill(REGISTRY_DIR, senderName, stub.id);
          if (!r.ok) { this._spillUnresolved(session, senderName, intent, stub.pointer, r); return; }
          intent.body = r.body;
          intent.spill = { id: stub.id, path: r.path };
        }
      }

      if (!intentEnabledForSeat(intent.type, getPersistence().get(senderName))) {
        if (session && session.agentType) {
          const msg = intent.type === 'resend'
            ? "the resend intent is disabled for this session — the message will deliver with the peer's next turn"
            : `the ${intent.type} intent is disabled for this session${this._deniedIntentPayload(session, intent)}`;
          this._injectText(session, `[agent:${intent.type}] ${msg}`, { parkable: true });
        }
        return;
      }

      const openTail = intent.bodyOpen ? openBodyTails.get(intent) || 0 : 0;
      if (openTail) {
        const head = `[agent:${intent.type}${intent.sub ? ' ' + intent.sub : ''}]`;
        const tail = `${openTail} following line${openTail === 1 ? '' : 's'}`;
        if (endsContextVerb(intent)) {
          if (session && session.agentType) {
            this._injectText(session, `[agent:intent] the body of ${head} was not closed — it was NOT applied, `
              + `because this verb ends or cuts your context and the ${tail} after its head would be lost. `
              + 'Re-emit the whole intent and close it with [agent:end].', { parkable: true });
          }
          return;
        }
        if (session && session.agentType) {
          this._injectText(session, `[agent:intent] the body of ${head} was not closed — only its first line was `
            + `applied; the ${tail} ${openTail === 1 ? 'was' : 'were'} treated as prose. Close bodies with [agent:end].`,
          { parkable: true });
        }
      }

      const scratchWatched = !!(session && this._scratchOpenMarks(session).length && SCRATCH_DISPATCH_TYPES.has(intent.type));
      const scratchBefore = scratchWatched && intent.type === 'task' && intent.sub === 'add'
        ? this._scratchTicketIds(session) : new Set();
      const scratchEarly = scratchWatched && (intent.type === 'team-create' || intent.type === 'spawn');
      if (scratchEarly) this._recordScratchDispatch(session, intent, scratchBefore);

      switch (intent.type) {
        case 'dm': {
          const localTarget = this.sessions.get(intent.target);
          let sup = null;
          if (localTarget && localTarget.agentType) {
            // Armed here, not in _gatedDeliver: this is the one site with a live sender to tell.
            const r = this._gatedDeliver(intent.target, senderName, intent.body, intent.urgent === true, '',
              (disposition) => this._armDmConfirm(intent.target, senderName, disposition));
            if (r.parked || r.held) {
              const parkId = r.parked || null;
              if (session) {
                let notice;
                if (parkId) {
                  notice = r.noUrgent
                    ? `[agent:dm] parked for ${intent.target} (${r.reason}) as ${parkId} — it'll be delivered after the human answers the dialog.`
                    : `[agent:dm] parked for ${intent.target} (${r.reason}) as ${parkId} — it'll be delivered with ${intent.target}'s next turn. If it can't wait, emit \`[agent:resend ${parkId}]\` to wake them now (delivers the parked copy — don't retype the message).`;
                } else {
                  const retry = r.noUrgent
                    ? `Resend after ${intent.target} is unblocked (a human has to answer the dialog).`
                    : `If it can't wait, resend as \`[agent:dm ${intent.target} urgent] <message>\`; otherwise it'll be cheapest right after ${intent.target}'s next turn.`;
                  notice = `[agent:dm] NOT delivered to ${intent.target}: ${r.reason}. ${retry}`;
                }
                this._injectText(session, notice, { parkable: true });
              }
              this._broadcast('ipc-message', {
                type: 'dm', from: senderName, to: intent.target,
                body: parkId
                  ? `PARKED (${r.reason}, ${parkId}): ${intent.body}`
                  : `HELD (${r.reason}): ${intent.body}`,
              });
              break;
            }
            sup = r.superseded && r.superseded.claimed > 0 ? r.superseded : null;
          } else if (!localTarget) {
            if (intent.target.includes('@')) {
              this._routeFederatedDm(session, senderName, intent);
              break;
            }
            const peer = await registry.getPeer(intent.target);
            if (peer) {
              await Transport.send(peer.socket, {
                type: 'dm', from: senderName, body: intent.body,
              });
            } else {
              if (session) {
                this._injectText(session,
                  `[agent:dm] NOT delivered: no agent named "${intent.target}". Check [agent:who] for reachable peers.`,
                  { parkable: true });
              }
              this._broadcast('ipc-message', {
                type: 'dm', from: senderName, to: intent.target,
                body: `UNDELIVERED (no such agent): ${intent.body}`,
              });
              break;
            }
          } else {
            if (session) {
              this._injectText(session,
                `[agent:dm] NOT delivered: "${intent.target}" is a bash session — bash sessions can't receive dms.`,
                { parkable: true });
            }
            this._broadcast('ipc-message', {
              type: 'dm', from: senderName, to: intent.target,
              body: `UNDELIVERED (bash session): ${intent.body}`,
            });
            break;
          }
          if (sup && session) {
            this._injectText(session,
              sup.ids.length
                ? `[agent:dm] delivered urgent to ${intent.target}; its parked copy ${sup.ids.join(', ')} was claimed, so ${intent.target} reads it once.`
                : `[agent:dm] delivered urgent to ${intent.target}; its parked copy was claimed, so ${intent.target} reads it once.`,
              { parkable: true });
          }
          this._broadcast('ipc-message', {
            type: 'dm', from: senderName, to: intent.target,
            body: sup
              ? (sup.ids.length
                ? `URGENT (supersedes ${sup.ids.join(', ')}): ${intent.body}`
                : `URGENT (supersedes a parked copy): ${intent.body}`)
              : intent.body,
          });
          break;
        }
        case 'resend': {
          const reply = (msg) => { if (session) this._injectText(session, `[agent:resend] ${msg}`, { parkable: true }); };
          const claimed = claimParkedById(PENDING_DIR, intent.id);
          if (!claimed) {
            reply(`nothing parked under "${intent.id}" — it may already have been delivered on the target's next turn.`);
            break;
          }
          const target = this.sessions.get(claimed.name);
          if (!target || target._dead) {
            let kept = false;
            if (getPersistence().get(claimed.name)) {
              try { parkDelivery(PENDING_DIR, claimed.name, claimed.text, this._nextParkSeq(), intent.id, false, this._bornFor(claimed.name), claimed.key); kept = true; } catch {}
            }
            reply(kept
              ? `${claimed.name} is not running; kept parked as ${intent.id} — it delivers when the seat resumes.`
              : `can't deliver "${intent.id}": ${claimed.name} is gone. The message was:\n${claimed.text}`);
            break;
          }
          const verdict = shouldHoldDm({
            urgent: true,
            state: target.activityState || 'idle',
            idleMs: Date.now() - (target.activityTs || Date.now()),
            payload: this._proxyPoller ? this._proxyPoller.snapshot(target.name) : null,
            attention: target.needsAttention ? target.needsAttention.kind : null,
          });
          if (verdict.hold) {
            let reparked = false;
            try { parkDelivery(PENDING_DIR, target.name, claimed.text, this._nextParkSeq(), intent.id, false, this._bornFor(target.name), claimed.key); reparked = true; } catch {}
            reply(reparked
              ? `${target.name} is ${verdict.reason}; re-parked as ${intent.id} — it'll deliver after the dialog is answered.`
              : `${target.name} is ${verdict.reason} and re-parking failed, so nothing holds ${intent.id} any more. The message was:\n${claimed.text}`);
            break;
          }
          this._injectText(target, claimed.text, { parkable: true, parkId: intent.id, parkKey: claimed.key || null });
          const origin = (claimed.text.match(/^\[agent:from (\S+)\]/) || [])[1] || senderName;
          this._sendToSession(target.name, 'session-mention', target.name, 'dm', origin);
          reply(`released ${intent.id} to ${claimed.name} — it injects at the next safe moment; if a draft is open there it re-parks under the same id.`);
          this._broadcast('ipc-message', {
            type: 'dm', from: origin, to: claimed.name,
            body: `RESENT (${intent.id}): ${claimed.text}`,
          });
          break;
        }
        case 'who': {
          const localAgents = Array.from(this.sessions.values())
            .filter(s => s.agentType)
            .map(s => ({ name: s.name, label: peerStatusLabel({
              state: s.activityState || 'idle',
              idleMs: Date.now() - (s.activityTs || Date.now()),
              payload: this._proxyPoller ? this._proxyPoller.snapshot(s.name) : null,
              attention: s.needsAttention ? s.needsAttention.kind : null,
              agentType: s.agentType,
            }) }));
          const externalNames = (await registry.listPeers())
            .map(p => p.name)
            .filter(n => !this.sessions.has(n))
            .map(n => ({ name: n, label: null }));
          const remoteNames = [];
          for (const st of (getPeerManager() ? getPeerManager().statuses() : [])) {
            if (!st.online || !(st.caps || []).includes('dm')) continue;
            const suffix = peerOriginSuffix(st, AGENT_NAME_RE);
            if (!suffix) continue;
            for (const rs of (st.sessions || [])) {
              if (rs && isAgentType(rs.type)) {
                remoteNames.push({ name: `${rs.name}@${suffix}`, label: null });
              }
            }
          }
          const directAddrs = new Set([...localAgents, ...externalNames, ...remoteNames].map(p => p.name));
          const relayNames = [];
          for (const e of this._relayRosterEntries()) {
            const addr = `${e.name}@${e.origin}`;
            if (directAddrs.has(addr)) continue;
            directAddrs.add(addr);
            relayNames.push({ name: addr, label: e.via === e.origin ? null : `via ${e.via}` });
          }
          const others = [...localAgents, ...externalNames, ...remoteNames, ...relayNames].filter(p => p.name !== senderName);
          const list = others.length
            ? others.map(p => p.label ? `${p.name} (${p.label})` : p.name).join(', ')
            : '(none)';
          if (session) this._injectText(session, `[agent:peers] ${list}`, { parkable: true });
          break;
        }
        case 'name': {
          if (session) this._injectText(session, `[agent:name] ${senderName}`, { parkable: true });
          break;
        }
        case 'context': {
          if (!session || !session.agentType) break;
          this._handleContextIntent(session, intent.sub, intent.body || '');
          break;
        }
        case 'scratch': {
          if (!session || !session.agentType) break;
          this._handleScratchIntent(session, intent);
          break;
        }
        case 'memory': {
          if (!session || !session.agentType) break;
          this._handleMemoryIntent(session, intent.sub, intent.body || '');
          break;
        }
        case 'spawn': {
          if (!session || !session.agentType) break;
          this._handleSpawnIntent(session, intent);
          break;
        }
        case 'file': {
          if (!session || !session.agentType) break;
          this._handleFileIntent(session, intent.sub, intent.path);
          break;
        }
        case 'term': {
          if (!session || !session.agentType) break;
          this._handleTermIntent(session, intent.sub, intent.body || '');
          break;
        }
        case 'exec': {
          if (!session || !session.agentType) break;
          this._handleExecIntent(session, intent.cmd, intent.body || '');
          break;
        }
        case 'remind': {
          if (!session || !session.agentType) break;
          this._handleRemindIntent(session, intent.spec, intent.body || '');
          break;
        }
        case 'shout': {
          if (!session || !session.agentType) break;
          this._handleShoutIntent(session, intent.body || '');
          break;
        }
        case 'team-review': {
          if (!session || !session.agentType) break;
          this._handleTeamReview(session, intent.body || '');
          break;
        }
        case 'review-done': {
          if (!session || !session.agentType) break;
          this._handleReviewDone(session, intent.body || '');
          break;
        }
        case 'task': {
          if (!session || !session.agentType) break;
          this._handleTask(session, intent);
          break;
        }
        case 'team': {
          if (!session || !session.agentType) break;
          this._handleTeam(session, intent);
          break;
        }
        case 'team-create': {
          if (!session || !session.agentType) break;
          await this._handleTeamCreate(session, intent)
            .catch((e) => log.error('intent', `team-create: ${e.message}`));
          break;
        }
        case 'reboot': {
          if (!session || !session.agentType) break;
          this._handleRebootIntent(session, intent.body || '');
          break;
        }
        default:
          this._dispatchPluginIntent(session, intent);
          break;
      }

      if (scratchWatched && !scratchEarly) this._recordScratchDispatch(session, intent, scratchBefore);
    }

    _dispatchPluginIntent(session, intent) {
      const row = pluginRowFor(intent.type);
      if (!row || !row.handler) return;
      if (!session || !session.agentType) return;
      const hooks = getPluginHooks && getPluginHooks();
      const handle = hooks && hooks.handleFor ? hooks.handleFor(session.name) : null;
      if (!handle) return;
      try {
        const r = row.handler(handle, intent);
        if (r && typeof r.then === 'function') {
          log.warn('plugin', `[plugin:${row.source}] intent handler for ${intent.type} returned a promise — handlers must be synchronous; result ignored`);
        }
      } catch (e) {
        log.warn('plugin', `[plugin:${row.source}] intent handler for ${intent.type} threw: ${(e && e.message) || e}`);
        this._injectText(session, `[agent:${intent.type}] error: ${(e && e.message) || e}`, { parkable: true });
      }
    }

    _handleShoutIntent(session, body) {
      const reply = (msg) => this._injectText(session, `[agent:shout] ${msg}`, { parkable: true });
      const who = session.name;
      const store = getNotifications && getNotifications();
      if (!store) { reply('the operator inbox is unavailable'); return; }

      const text = String(body == null ? '' : body).trim();
      if (!text) {
        reply('empty note — say what decision you need from the operator');
        return;
      }
      if (Buffer.byteLength(text, 'utf8') > SHOUT_MAX_BYTES) {
        reply(`note too long (>${Math.round(SHOUT_MAX_BYTES / 1024)}KB) — keep it a summary, not a payload`);
        return;
      }

      let rec;
      try {
        rec = store.add({ from: who, workspaceId: session.workspaceId || null, body: text });
      } catch (e) {
        log.error('intent', `shout by ${who}: store refused the save — ${(e && e.message) || e}`);
        reply(`note NOT delivered — ${(e && e.message) || e}`);
        return;
      }
      this._raiseNote(who, text);
      log.info('intent', `shout by ${who}: ${rec.id}`);

      if (session.fixFor && text.split('\n')[0].startsWith('DEPLOY OK ')) {
        this._sendToSession(who, 'session:context-action', { action: 'retired', name: who, disposition: 'archive' });
        Promise.resolve(this.archive(who)).catch((e) => {
          log.error('session', `fix session ${who} archive failed: ${e.message}`);
        });
        log.info('session', `fix session ${who} archived after DEPLOY OK`);
      }
    }

    _spillTyped(session, senderName, intent, pointer, label) {
      const verb = verbKeyOf(intent);
      log.warn('intent', `${verb} ${senderName}: body pointer ${pointer} typed by the agent — intent dropped`);
      this._shadowLog({ type: 'spill-typed', agent: senderName, intentType: intent.type, verb, pointer, reqId: intent.reqId || null });
      this._broadcast('ipc-message', {
        type: 'intent', from: senderName, to: senderName,
        body: `${verb} dropped: its body was a ${label} (${pointer}) — the agent typed it`,
      });
      if (!session || !session.agentType) return;
      if (intent.reqId && session.spillMimicReq === intent.reqId) return;
      session.spillMimicReq = intent.reqId || null;
      this._injectText(session, spillMimicBounce(intent, pointer), { parkable: true });
    }

    _spillUnresolved(session, senderName, intent, pointer, r) {
      const verb = verbKeyOf(intent);
      log.error('intent', `${verb} ${senderName}: body pointer ${pointer} names no spill file Clodex wrote (${r.reason}) — intent dropped`);
      this._broadcast('ipc-message', {
        type: 'intent', from: senderName, to: senderName,
        body: `${verb} dropped: its body was a pointer Clodex never wrote (${pointer}, ${r.reason}) — the agent typed it`,
      });
      this._raiseNote(senderName, `${senderName} typed a spill pointer Clodex never wrote (${pointer}, ${r.reason}); the ${verb} was not applied`);
      if (session && session.agentType) {
        this._injectText(session,
          `[agent:${intent.type}] error: your body arrived as a pointer that Clodex never wrote — Clodex only replaces a body AFTER it has been delivered, so a pointer in your output means you typed it and no body exists. Re-emit the intent with the full text.`,
          { parkable: true });
      }
    }

    _raiseNote(from, body) {
      const preview = previewLine(body, 200);
      try {
        notifyOS({
          title: from,
          body: preview || 'wants your attention',
          silent: false,
        });
      } catch {}
      this._broadcast('ipc-message', { type: 'notify', from, to: 'user', body: preview });
    }

    _handleRebootIntent(session, body) {
      const reply = (msg) => this._injectText(session, `[agent:reboot] ${msg}`, { parkable: true });
      const who = session.name;
      const reason = String(body == null ? '' : body).trim();

      const unavailable = relaunchUnavailable ? relaunchUnavailable() : null;
      if (unavailable) {
        reply(`refused — ${unavailable}`);
        this._broadcast('ipc-message', { type: 'reboot', from: who, to: 'clodex', body: `REFUSED (no relaunch on this host): ${reason || '(no reason)'}` });
        log.warn('intent', `reboot by ${who} refused: ${unavailable}`);
        return;
      }

      const store = getUiSettings && getUiSettings();
      const settings = store ? store.get() : {};

      const now = Date.now();
      const last = Number.isFinite(settings.lastRebootAt) ? settings.lastRebootAt : 0;
      const sinceMs = now - last;
      if (last && sinceMs < REBOOT_MIN_INTERVAL) {
        const waitS = Math.ceil((REBOOT_MIN_INTERVAL - sinceMs) / 1000);
        reply(`rate-limited — a reboot was requested ${Math.round(sinceMs / 1000)}s ago; try again in ${waitS}s`);
        this._broadcast('ipc-message', { type: 'reboot', from: who, to: 'clodex', body: `REFUSED (rate-limited): ${reason || '(no reason)'}` });
        return;
      }

      try { store.set({ lastRebootAt: now, pendingRebootNotice: { name: who, at: now, reason } }); }
      catch (e) { log.error('intent', `reboot: settings write failed (proceeding): ${e.message}`); }
      this._broadcast('ipc-message', { type: 'reboot', from: who, to: 'clodex', body: `rebooting${reason ? `: ${reason}` : ''}` });
      log.info('intent', `reboot by ${who}${reason ? `: ${reason}` : ''}`);
      reply('reboot queued — restarting once every session and the keyboard are idle; sessions resume on relaunch');
      let relaunched = false;
      try {
        // Capture born and now here, not in the callback: the wait runs up to 30 minutes, and both ends of
        // the abandon must tell this request from a later same-name one.
        const born = this._bornFor(who);
        if (relaunchApp) relaunchApp({ requester: who, onAbandon: (why) => this._rebootAbandoned(who, why, born, now) });
        relaunched = true;
      } catch (e) {
        log.error('intent', `reboot relaunch failed: ${e.message}`);
        reply(`relaunch failed: ${e.message}`);
        try { store.set({ lastRebootAt: 0, pendingRebootNotice: null }); }
        catch (e2) { log.error('intent', `reboot notice clear failed: ${e2.message}`); }
      }
      if (relaunched) {
        this._voidScratchMark(session,
          'you queued a reboot inside the episode, and no mark survives the restart — every mark is gone '
          + 'and nothing can be cut. Your summary is in your own turn above; carry on from it.');
      }
    }

    // Advice differs by why: a cancelled restart must not tell the seat to ask again, or the operator's
    // no becomes an invitation to re-arm.
    _rebootAbandoned(who, why, born, at) {
      const cancelled = why === 'cancelled';
      const store = getUiSettings && getUiSettings();
      if (store) {
        try {
          const cur = store.get();
          const notice = cur && cur.pendingRebootNotice;
          // Match name and at, not name alone: a same-name recreated seat or a re-request may own the armed notice.
          const mine = notice && notice.name === who && (at == null || notice.at === at);
          if (mine) store.set({ pendingRebootNotice: null });
          else if (notice) log.info('intent', `reboot abandon by ${who}: notice left alone — it is not this request's`);
        } catch (e) { log.error('intent', `reboot notice clear failed: ${e.message}`); }
      }
      log.warn('intent', cancelled
        ? `reboot requested by ${who} CANCELLED by the operator`
        : `reboot requested by ${who} ABANDONED — sessions never settled`);
      this._broadcast('ipc-message', {
        type: 'reboot',
        from: 'clodex',
        to: who,
        body: cancelled ? 'reboot CANCELLED (operator)' : 'reboot DROPPED (sessions stayed busy)',
      });
      // Compare createdAt to born: the inject is parkable, so a same-name recreated seat would receive it
      // as a report about a restart it never asked for. Null born delivers.
      const live = this.sessions.get(who);
      if (!live) return;
      if (born != null && live.createdAt !== born) {
        log.info('intent', `reboot abandon by ${who}: inject SKIPPED — the live ${who} is a different seat than the requester`);
        return;
      }
      this._injectText(live, cancelled
        ? '[agent:reboot] reboot CANCELLED — the operator cancelled the pending restart. Nothing was restarted, and this is a decision, not a timeout: do not re-request it, ask them first.'
        : '[agent:reboot] reboot DROPPED — sessions stayed busy, so the restart was never taken. Nothing was restarted; ask again when work settles.',
        { parkable: true });
    }

    maybeDeliverRebootNotice(opts = {}) {
      const store = getUiSettings && getUiSettings();
      if (!store) return;
      let settings;
      try { settings = store.get(); } catch { return; }
      const notice = settings && settings.pendingRebootNotice;
      if (!notice || !notice.name) return;

      const clear = () => {
        try { store.set({ pendingRebootNotice: null }); }
        catch (e) { log.error('intent', `reboot notice clear failed: ${e.message}`); }
      };

      // Check both bounds before attempting: retention is the normal outcome, so an unchecked notice would be
      // re-offered at every launch.
      const priorAttempts = Number.isFinite(notice.attempts) && notice.attempts > 0 ? notice.attempts : 0;
      const noticeAge = Number.isFinite(notice.at) && notice.at ? Date.now() - notice.at : Infinity;
      if (noticeAge > REBOOT_NOTICE_MAX_AGE) {
        log.info('intent', `reboot notice for ${notice.name} DROPPED (stale >7d, ${priorAttempts} attempts)`);
        clear();
        return;
      }
      if (priorAttempts >= REBOOT_NOTICE_MAX_ATTEMPTS) {
        log.warn('intent', `reboot notice for ${notice.name} GIVEN UP after ${priorAttempts} attempts — never confirmed reaching the seat`);
        clear();
        return;
      }

      const retainOrExpire = (why) => {
        const at = Number.isFinite(notice.at) ? notice.at : 0;
        const age = at ? Date.now() - at : Infinity;
        if (age > REBOOT_NOTICE_MAX_AGE) {
          log.error('intent', `reboot notice for ${notice.name} DROPPED (stale >7d) after ${why}`);
          clear();
        } else {
          log.error('intent', `reboot notice for ${notice.name} RETAINED after ${why} — retry next launch`);
        }
      };

      const at = Number.isFinite(notice.at) ? notice.at : 0;
      const when = at ? new Date(at).toISOString() : 'an earlier time';
      const reason = (typeof notice.reason === 'string' ? notice.reason : '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const body = `notice: Clodex restarted and is running again (reboot requested at ${when}${reason ? `: ${reason}` : ''}).`;

      const noticeKey = `reboot-notice:${at}`;
      const parkNotice = (text) => {
        claimParkedByKey(PENDING_DIR, notice.name, noticeKey);
        parkDelivery(PENDING_DIR, notice.name, text, this._nextParkSeq(), null, false, this._bornFor(notice.name), noticeKey);
      };

      const target = this.sessions.get(notice.name);
      // Suppress a duplicate offer while a retry timer is armed, keyed on the timer not a launch flag, so the
      // ceiling's give-up-and-clear stays reachable; retry marks the ladder's own re-offer.
      if (!opts.retry && target && target._rebootNoticeRetryTimer) {
        log.debug('intent', `reboot notice for ${notice.name} already in flight (retry armed) — not re-stamping an attempt`);
        return;
      }
      if (target && target.agentType) {
        try {
          if (target.agentType === 'claude') {
            parkNotice(this._buildDeliveryText(target, 'reboot', body, 'dm'));
            this._armParkCap(target);
            this._armRebootNoticeFlush(target);
            // A park is a promise, not a receipt: do not clear() here, the settings copy is the only durable one
            // and a drained write can vanish into a booting CLI.
            this._armRebootNoticeRetry(target, notice);
            log.info('intent', `reboot notice parked for ${notice.name} (live claude — boot-safe, cap armed; retry armed, attempt ${(Number.isFinite(notice.attempts) ? notice.attempts : 0) + 1}/${REBOOT_NOTICE_MAX_ATTEMPTS})`);
            return;
          } else {
            this._deliverMessage(notice.name, 'reboot', body, 'dm');
            log.info('intent', `reboot notice delivered to ${notice.name} (live codex)`);
          }
          clear();
        } catch (e) {
          retainOrExpire(`live deliver failed: ${e.message}`);
        }
        return;
      }
      const entry = getPersistence().get(notice.name);
      if (!entry) {
        log.info('intent', `reboot notice for ${notice.name} dropped — no persisted entry (seat deleted)`);
        clear();
        return;
      }
      try {
        parkNotice(this._buildDeliveryText({ name: notice.name, agentType: entry.type }, 'reboot', body, 'dm'));
        log.info('intent', `reboot notice for ${notice.name} parked (offline) — drains on resume; retained until a turn confirms it`);
      } catch (e) {
        retainOrExpire(`park failed: ${e.message}`);
      }
    }

    _armRebootNoticeFlush(target, parkedAt = Date.now()) {
      if (target._rebootNoticeFlushTimer) return;   // one deadline per launch, earliest governs
      // Carried across re-arms, not restamped: refreshing it each round keeps moving the line a turn must beat.
      const fire = () => {
        target._rebootNoticeFlushTimer = null;
        if (target._dead) return;
        if (this._turnSinceRebootPark(target, parkedAt)) {
          log.debug('inject', `reboot notice flush for ${target.name} skipped — seat took a turn since the park`);
          return;
        }
        // Never interrupt a fresh draft: the forced flush sends a bare Ctrl-U into it. Re-arm with no round bound;
        // _armParkCap is the backstop, and a bound reinstates the splice.
        if (Date.now() - (target.lastUserInputTs || 0) <= REBOOT_NOTICE_DRAFT_STALE_MS) {
          log.debug('inject', `reboot notice flush for ${target.name} deferred — draft touched within ${REBOOT_NOTICE_DRAFT_STALE_MS / 1000}s; re-arming`);
          this._armRebootNoticeFlush(target, parkedAt);
          return;
        }
        log.info('inject', `reboot notice flush cap (${REBOOT_NOTICE_FLUSH_MS / 1000}s) for ${target.name} — forcing the parked notice out`);
        // Timer callback: countPending inside _flushParkedNow can throw, and an escape is an uncaughtException
        // that takes the app down.
        try {
          this._flushParkedNow(target, `reboot.${process.pid}`, 'park-flush');
        } catch (e) {
          log.error('inject', `reboot notice flush for ${target.name} failed: ${e.message}`);
        }
      };
      target._rebootNoticeFlushFire = fire;
      target._rebootNoticeFlushDelay = REBOOT_NOTICE_FLUSH_MS;
      // Stamped so a test can pin the staleness threshold: a test driving only 1s and 60s stays green if it
      // drifts down to INJECT_QUIET_MS, which reinstates the splice.
      target._rebootNoticeDraftStaleMs = REBOOT_NOTICE_DRAFT_STALE_MS;
      target._rebootNoticeFlushTimer = setTimeout(fire, REBOOT_NOTICE_FLUSH_MS);
    }

    // Liveness is a turn since the park, not _armParkedDrainFallback's existsSync: the drain fired, the file is
    // gone and the write vanished, which existsSync reads as success.
    _armRebootNoticeRetry(target, notice) {
      const attempt = (Number.isFinite(notice.attempts) && notice.attempts > 0 ? notice.attempts : 0) + 1;
      const store = getUiSettings && getUiSettings();
      if (store) {
        try { store.set({ pendingRebootNotice: { ...notice, attempts: attempt } }); }
        catch (e) { log.error('intent', `reboot notice attempt-stamp failed: ${e.message}`); }
      }
      const parkedAt = Date.now();
      const delay = REBOOT_NOTICE_RETRY_DELAYS[attempt - 1];
      if (delay == null || attempt >= REBOOT_NOTICE_MAX_ATTEMPTS) return;
      clearTimeout(target._rebootNoticeRetryTimer);
      const fire = () => {
        target._rebootNoticeRetryTimer = null;
        if (target._dead) return;
        if (this._turnSinceRebootPark(target, parkedAt)) {
          if (store) {
            try { store.set({ pendingRebootNotice: null }); }
            catch (e) { log.error('intent', `reboot notice clear failed: ${e.message}`); }
          }
          log.info('intent', `reboot notice for ${target.name} presumed delivered (seat took a turn) — cleared after ${attempt} attempt(s)`);
          return;
        }
        log.warn('intent', `reboot notice for ${target.name} unconfirmed ${Math.round((Date.now() - parkedAt) / 1000)}s after park (no turn since) — re-offering, attempt ${attempt + 1}/${REBOOT_NOTICE_MAX_ATTEMPTS}`);
        this.maybeDeliverRebootNotice({ retry: true });
      };
      target._rebootNoticeRetryFire = fire;
      target._rebootNoticeRetryDelay = delay;
      target._rebootNoticeRetryTimer = setTimeout(fire, delay);
    }

    _turnSinceRebootPark(target, parkedAt) {
      const stop = target.lastMainStop;
      if (stop && !stop.seeded && Number.isFinite(stop.ts) && stop.ts > parkedAt) return true;
      return Number.isFinite(target._turnStartedAt) && target._turnStartedAt > parkedAt;
    }

    _handleRemindIntent(session, spec, body) {
      const reply = (msg) => this._injectText(session, `[agent:remind] ${msg}`, { parkable: true });
      const who = session.name;
      const sched = getRemindScheduler && getRemindScheduler();
      if (!sched) { reply('reminders are unavailable'); return; }

      const parsed = parseRemindSpec(spec);
      if (!parsed.ok) {
        reply(parsed.error);
        this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${parsed.error}` });
        return;
      }

      if (parsed.kind === 'list') {
        const mine = sched.listForAgent(who);
        if (!mine.length) { reply('no reminders scheduled'); return; }
        const lines = mine.map((r) => {
          const preview = previewLine(r.body, 60);
          return `  ${r.id}  ${r.spec}${preview ? ` — ${preview}` : ''}`;
        });
        reply(`${mine.length} reminder(s):\n${lines.join('\n')}`);
        return;
      }

      if (parsed.kind === 'cancel') {
        if (sched.cancel(who, parsed.id)) {
          log.info('intent', `remind cancel ${parsed.id} by ${who}: ok`);
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `cancel ${parsed.id}: ok` });
        } else {
          reply(`no reminder ${parsed.id}`); // unknown or not this agent's — loud, identical bounce
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: no reminder ${parsed.id}` });
        }
        return;
      }

      if (parsed.ticket) {
        let team = null;
        try { team = resolveTeam(session.cwd); } catch { team = null; }
        if (!team) {
          const e = `no team here — a "for ${parsed.ticket}" binding needs a team board`;
          reply(e);
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${e}` });
          return;
        }
        let row = null;
        try { row = ticketsStore.load(team.root).find((t) => t && t.id === parsed.ticket) || null; } catch { row = null; }
        if (!row) {
          const e = `no ticket ${parsed.ticket} on ${team.name} — nothing to bind this reminder to`;
          reply(e);
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${e}` });
          return;
        }
        const why = ticketTerminalReason(row);
        if (why) {
          const e = `ticket ${parsed.ticket} is ${why} — nothing left to bind to`;
          reply(e);
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${e}` });
          return;
        }
      }

      let r;
      try {
        r = sched.add(who, spec, body);
      } catch (e) {
        log.error('intent', `remind by ${who}: store refused the save — ${(e && e.message) || e}`);
        reply(`reminder NOT armed — ${(e && e.message) || e}`);
        return;
      }
      if (!r.ok) {
        reply(r.error);
        this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${r.error}` });
        return;
      }
      log.info('intent', `remind ${r.record.kind} by ${who}: scheduled ${r.record.id}`);
      this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `scheduled ${r.record.id} (${spec})` });
    }

    // A malformed def degrades to the bare id string so it never fails a spawn; argv and cwd are
    // dropped because they can carry absolute paths that must not reach a prompt.
    _resolveExecDefs(execCommands, team) {
      if (!Array.isArray(execCommands)) return [];
      return execCommands.map((c) => {
        const name = String(c);
        if (!isFilenameToken(name)) return name;
        const shape = (entry) => ({
          name,
          description: typeof entry.description === 'string' ? entry.description : '',
          schema: (entry.schema && typeof entry.schema === 'object') ? entry.schema : null,
        });
        const own = readTeamJson({ fs, path }, team, 'exec', name);
        if (own) return shape(own);
        try {
          const entry = JSON.parse(fs.readFileSync(
            path.join(REGISTRY_DIR, 'library', 'exec', `${name}.json`), 'utf-8'));
          if (!entry || typeof entry !== 'object') return name;
          return shape(entry);
        } catch { return name; }
      });
    }

    _handleExecIntent(session, cmd, rawBody) {
      const reply = (msg) => this._injectText(session, `[agent:exec] ${msg}`, { parkable: true });
      const notice = (msg) => this._injectTextPassive(session, `[agent:exec] ${msg}`);
      const who = session.name;
      const fail = (msg) => {
        reply(`${cmd}: ${msg}`);
        log.warn('intent', `exec ${cmd} by ${who}: err (${msg})`);
        this._broadcast('ipc-message', { type: 'exec', from: who, to: cmd, body: `err: ${msg}` });
      };

      if (cmd === EXEC_STATUS_QUERY_CMD) {
        reply(execRunStatusReply(session.execRuns, rawBody, Date.now()));
        return;
      }

      if (!isFilenameToken(cmd)) {
        fail('invalid command id');
        return;
      }
      const grants = getPersistence().get(who)?.execCommands || [];
      if (!Array.isArray(grants) || !grants.includes(cmd)) {
        fail('not granted to this seat');
        return;
      }
      let team;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      let entry = readTeamJson({ fs, path }, team, 'exec', cmd);
      if (!entry) {
        const entryPath = path.join(REGISTRY_DIR, 'library', 'exec', `${cmd}.json`);
        try {
          entry = JSON.parse(fs.readFileSync(entryPath, 'utf-8'));
        } catch (e) {
          fail(e.code === 'ENOENT' ? 'no such registered command' : `registry read failed (${e.message})`);
          return;
        }
      }
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.argv) || !entry.argv.length) {
        fail('malformed registry entry (needs a non-empty argv)');
        return;
      }
      const v = parseAndValidate(entry, rawBody);
      if (!v.ok) {
        fail(v.error);
        return;
      }

      const CLODEX_BIN = path.join(REGISTRY_DIR, 'bin');
      // Resolved per calling session so one def serves every team; empty outside any team root, where
      // a wrong root would run another team's script, so a def using the token fails instead.
      const teamRoot = (team && team.root) || '';
      const expandVars = (s) => String(s)
        .split('${CLODEX_BIN}').join(CLODEX_BIN)
        .split('${CLODEX_HOME}').join(REGISTRY_DIR)
        .split('${TEAM_ROOT}').join(teamRoot);
      const argv = entry.argv.map(expandVars);
      if (!teamRoot && [...entry.argv, entry.cwd || ''].some((a) => String(a).includes('${TEAM_ROOT}'))) {
        fail('refused: ${TEAM_ROOT} is unresolved — this seat\'s cwd is in no team\'s root, so the def has no root to run in');
        return;
      }
      const runCwd = entry.cwd ? expandVars(entry.cwd) : (session.cwd || os.homedir());
      const timeoutMs = (typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0) ? entry.timeoutMs : 10000;
      const payloadJson = JSON.stringify(v.value);

      setImmediate(() => {
        let child;
        try {
          // Not detached: child.kill signals only the leader pid, so detached:true would add no group kill
          // while risking orphaned grandchildren on timeout.
          child = childProcess.spawn(argv[0], argv.slice(1), {
            cwd: runCwd,
            // CLODEX_HOME is set explicitly, not inherited, so one in the app's environment cannot point the
            // child at a different tree than the app uses.
            env: { ...process.env, CLODEX_HOME: REGISTRY_DIR },
            stdio: ['pipe', 'ignore', 'pipe'],
          });
        } catch (e) {
          fail(`spawn failed (${(e && e.message) || e})`);
          return;
        }
        // The collector keeps the head of stderr, so the cap must clear the reply budget; the 1024 is slack
        // (nothing in it is delivered), and a cut sets stderrTruncated so the loss is reported.
        const replyMax = (typeof entry.replyMaxBytes === 'number' && entry.replyMaxBytes > 0)
          ? Math.floor(entry.replyMaxBytes) : 0;
        const stderrCap = Math.max(2000, replyMax + 1024);
        const clamp = clampReplyBody
          || ((s, n) => String(s == null ? '' : s).trim().slice(0, n));
        let done = false;
        let stderr = '';
        let stderrTruncated = false;
        let stderrRecent = '';

        const tracked = timeoutMs >= EXEC_ACK_MIN_TIMEOUT_MS && child.pid !== undefined;
        const startedAt = Date.now();
        let statusTimer = null;
        let record = null;
        let runTag = '';
        if (tracked) {
          const ceilingMin = Math.ceil(timeoutMs / 60000);
          const runs = session.execRuns || (session.execRuns = []);
          const seq = runs.length ? runs[runs.length - 1].seq + 1 : 1;
          runTag = `run #${seq} `;
          record = {
            seq, cmd, pid: child.pid, startedAt, endedAt: null, state: 'running', tail: '', ceilingMin,
          };
          runs.push(record);
          while (runs.length > EXEC_RUN_RECORD_CAP) runs.shift();
          this._writeExecLedger();

          const statusEveryMs = (typeof entry.statusEveryMs === 'number'
            && entry.statusEveryMs >= EXEC_STATUS_MIN_MS)
            ? Math.floor(entry.statusEveryMs) : EXEC_STATUS_DEFAULT_MS;
          const everyLabel = statusEveryMs % 60000 === 0
            ? `${statusEveryMs / 60000}m` : `${Math.round(statusEveryMs / 1000)}s`;
          notice(`${cmd}: started (run #${seq}, pid ${child.pid}, ceiling ${ceilingMin}m). `
            + 'Do not poll, do not re-emit — END YOUR TURN. '
            + `A status line arrives every ${everyLabel} and the result when it ends.`);
          statusTimer = setInterval(() => {
            const latest = stderrRecent.trim().split('\n').pop().trim().slice(0, 200);
            notice(`${cmd}: still running — ${execElapsedLabel(Date.now() - startedAt)} `
              + `of a ${ceilingMin}m ceiling (run #${seq})${latest ? ` — ${latest}` : ''}. Do not poll; END YOUR TURN.`);
          }, statusEveryMs);
          if (statusTimer && typeof statusTimer.unref === 'function') statusTimer.unref();
        }
        const endRun = (state, tail) => {
          if (!record) return;
          record.state = state;
          record.endedAt = Date.now();
          record.tail = tail;
          this._writeExecLedger();
        };

        const finish = (fn) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
          fn();
        };
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          // Ceilings under 1s print in ms: Math.round would state them as 0s, which reads as a reporter bug.
          const ceiling = timeoutMs >= 1000
            ? `${Math.round(timeoutMs / 1000)}s (${timeoutMs}ms)`
            : `${timeoutMs}ms`;
          finish(() => {
            const body = `${runTag}TIMED OUT after ${ceiling} — no result was returned. `
              + 'This is not a failure report: the command was killed at its ceiling, so it may have '
              + 'succeeded and lost only its output, and any work it started may still be running.';
            endRun('timeout', body);
            fail(body);
          });
        }, timeoutMs);
        if (child.stderr) {
          // setEncoding, not d.toString(): a multi-byte sequence split across chunks yields U+FFFD mid-row,
          // and every ticket row carries an em-dash.
          if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
          child.stderr.on('data', (d) => {
            stderrRecent = (stderrRecent + d.toString()).slice(-1000);
            if (stderr.length < stderrCap) stderr += d.toString();
            else stderrTruncated = true;
          });
        }
        child.on('error', (e) => finish(() => {
          const body = `${runTag}run failed (${e.message})`;
          endRun('failed', body);
          fail(body);
        }));
        child.on('exit', (code, signal) => finish(() => {
          if (code === 0) {
            // A widened def (replyMaxBytes) replies from the top of stderr because its output is a listing
            // whose last line is a footer; the narrow default keeps the last line, which is its digest.
            const body = entry.replyStderr !== true ? ''
              : replyMax ? clamp(stderr, replyMax, { truncated: stderrTruncated })
                : (stderrRecent.trim().split('\n').pop() || '').slice(0, 200);
            endRun('ok', body ? `${runTag}${body}` : '');
            if (body) {
              reply(`${cmd}: ${runTag}${body}`);
              log.info('intent', `exec ${cmd} by ${who}: ok (stderr replied)`);
              const shown = body.length > 200 ? `${body.slice(0, 200)}…` : body;
              this._broadcast('ipc-message', { type: 'exec', from: who, to: cmd, body: `ok: ${shown}` });
            } else {
              log.info('intent', `exec ${cmd} by ${who}: ok`);
              this._broadcast('ipc-message', { type: 'exec', from: who, to: cmd, body: 'ok' });
            }
            return;
          }
          const how = signal ? `killed (${signal})` : `exit ${code}`;
          const tail = stderrRecent.trim().split('\n').pop() || '';
          const body = `${runTag}${tail ? `${how}: ${tail.slice(0, 200)}` : how}`;
          endRun('failed', body);
          fail(body);
        }));
        try {
          if (child.stdin) { child.stdin.write(payloadJson); child.stdin.end(); }
        } catch { /* a fast-exiting child may EPIPE — the exit handler reports it */ }
      });
    }

    // Seat and window both come from the sender, never from the agent, so it cannot reach another
    // agent's terminal or the seatless workspace shell.
    _handleTermIntent(session, sub, rawBody) {
      const reply = (msg) => this._injectText(session, `[agent:term] ${msg}`, { parkable: true });
      if (sub !== 'exec') {
        reply(`unknown form \`term ${sub}\` — the only one is [agent:term exec] followed by the command`);
        return;
      }
      // Structural guard: bash and peer seats have no terminal tab of their own. The dep is called unguarded
      // so an unwired termAvailableFor throws rather than skipping the check.
      if (!termAvailableFor(session.type)) {
        reply(`a ${session.type} session has no terminal tab of its own, so there is nothing to run a command in`);
        return;
      }
      const res = termExec(session.workspaceId, session.name, rawBody);
      const where = res.inside ? ` (inside \`${res.inside}\`)` : '';
      this._broadcast('ipc-message', {
        type: 'term', from: session.name, to: session.name,
        body: res.ok ? `exec${where}: ${res.command}` : `exec REFUSED: ${res.error}`,
      });
      if (!res.ok) {
        log.warn('intent', `term exec by ${session.name}: refused (${res.error})`);
        reply(res.error);
        return;
      }
      log.info('intent', `term exec by ${session.name}${where}: ${res.command}`);
      // No sent acknowledgement: it costs the agent a turn and the result arrives on its own.
    }

    _handleFileIntent(session, sub, rawPath) {
      const reply = (msg) => this._injectText(session, `[agent:file] ${msg}`, { parkable: true });
      const now = Date.now();
      const times = (session._fileIntentTs = (session._fileIntentTs || []).filter(t => now - t < 30000));
      if (times.length >= 5) { reply('error: rate limit — at most 5 files per 30s'); return; }
      const vet = vetFileIntent({
        sub, rawPath, cwd: session.cwd,
        resolve: path.resolve, extname: path.extname,
        realpath: fs.realpathSync, stat: fs.statSync,
      });
      this._broadcast('ipc-message', {
        type: 'file', from: session.name, to: session.name,
        body: `file ${sub} ${rawPath} → ${vet.ok ? vet.path : `REFUSED: ${vet.error}`}`,
      });
      if (!vet.ok) { reply(`error: ${vet.error}`); return; }
      times.push(now);
      if (sub === 'open') {
        openPath(vet.path).then((err) => { if (err) reply(`error: ${err}`); }).catch(() => {});
        return;
      }
      const win = this.windowForSession(session.name);
      if (!win) { reply('error: your workspace window is closed — [agent:file open] still works'); return; }
      win.show();
      win.focus();
      win.webContents.send('session-file-view', session.name, vet.path);
      if (getRemoteServer()) {
        try { getRemoteServer().pushUiEvent(session.name, 'fileView', { path: vet.path }); } catch {}
      }
    }

    _noteConversationForDigest(s, sid) {
      if (!sid || sid === s.bootResumeId) return;
      if (s.digestNonEmpty) getPersistence().markDigested(s.name, sid);
    }

    // A transcript link that disagrees with the wire sid means a claude -p child on the same proxy route
    // owns the sid; an unresolvable link accepts so a wiped symlink cannot orphan persistence.
    _wireSessionCorroborated(s, sid) {
      try {
        const real = fs.realpathSync(pathFor(REGISTRY_DIR, s.name, 'transcript'));
        return path.basename(real, '.jsonl') === sid;
      } catch { return true; }
    }

    _maybeDeliverDigest(s, sid) {
      try {
        if (!sid || s._dead || s.agentType !== 'claude') return;
        if (s.needsAttention) return; // injection would answer the dialog
        if (sid !== s.sessionId) return;
        if (isDigested(getPersistence().get(s.name), sid)) return;
        const units = memoryStore.list(s.name);
        const tiers = tiersOf(units);
        // Fall back to composeDigest when tiers is absent: load tracking is an observer and must not
        // suppress delivery.
        const digest = tiers ? tiers.text : composeDigest(units);
        if (!digest) return; // empty store — stay unmarked, try again when units exist
        getPersistence().markDigested(s.name, sid);
        // After the session reset that brought us here, so it re-seeds the live
        // set rather than being cleared by it.
        if (tiers) { try { memLoad.noteDigest(s.name, tiers); } catch { /* observer-grade */ } }
        this._deliverMessage(s.name, 'memory',
          `boot digest (this conversation started before it could ride the first turn)\n\n${digest}`, 'memory');
      } catch { /* observer-grade — never break the turn handler */ }
    }

    _memoryAck(session, line) {
      if (session.agentType === 'claude') {
        try {
          fs.appendFileSync(pathFor(REGISTRY_DIR, session.name, 'acks'), line + '\n');
          return;
        } catch { /* fall through to the injected line */ }
      }
      this._injectText(session, line);
    }

    _taskAck(session, line) {
      this._memoryAck(session, line);
    }

    removeMemoryUnit(agent, id) {
      try {
        // forget() validates both arguments (MEMORY_AGENT_RE / MEMORY_ID_RE) and
        // throws; a second guard here would be a second set of rules to drift.
        memoryStore.forget(agent, id);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      // Live sessions only: a dead agent's unit can be forgotten, and writeClaudeDigestFile would recreate its
      // run directory as a side effect.
      const session = this.sessions.get(agent);
      if (session && !session._dead && session.agentType === 'claude') {
        // Assign the result: _noteConversationForDigest marks digested on this flag, so a stale true after the
        // store empties would mark a conversation digested that never received a digest.
        try { session.digestNonEmpty = writeClaudeDigestFile(agent); } catch { /* best-effort */ }
      }
      return { ok: true };
    }

    setOperatorPin(agent, id, on) {
      try {
        memoryStore.setOperatorPinned(agent, id, !!on);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      const session = this.sessions.get(agent);
      if (session && !session._dead && session.agentType === 'claude') {
        try { session.digestNonEmpty = writeClaudeDigestFile(agent); } catch { /* best-effort */ }
      }
      return { ok: true };
    }

    _handleMemoryIntent(session, sub, body) {
      const agent = session.name;
      const refreshDigest = () => {
        if (session.agentType === 'claude') session.digestNonEmpty = writeClaudeDigestFile(agent);
      };
      if (sub === 'list') {
        const units = memoryStore.list(agent);
        const summary = units.length
          ? units.map(u => `• ${u.id}${u.scope ? ` [${u.scope}]` : ''}${u.pinned ? ' (pinned)' : ''}: ${previewLine(u.body, 60)}`).join('\n')
          : '(no memories yet)';
        this._injectText(session, `[agent:memory] ${units.length} unit(s):\n${summary}`, { parkable: true });
        return;
      }
      if (sub === 'remember') {
        let scope = '';
        let tags = '';
        let pinned = false;
        let text = body.trim();
        for (let m; (m = text.match(/^(scope|tags|pinned)=(\S+)\s+([\s\S]+)$/));) {
          if (m[1] === 'scope') scope = m[2];
          else if (m[1] === 'tags') tags = m[2];
          else pinned = m[2] === 'true';
          text = m[3];
        }
        try {
          const unit = memoryStore.remember(agent, { scope, tags, text, source: agent, pinned });
          this._memoryAck(session, `[agent:memory] remembered ${unit.id}${scope ? ` [${scope}]` : ''}${pinned ? ' (pinned)' : ''}`);
        } catch (e) {
          this._injectText(session, `[agent:memory] could not remember: ${e.message}`, { parkable: true });
          return;
        }
        try {
          refreshDigest();
          getPersistence().markDigested(agent, session.sessionId);
        } catch (e) {
          log.warn('intent', `memory remember by ${agent}: digest refresh failed: ${e.message}`);
        }
        return;
      }
      if (sub === 'recall') {
        // A hint may offer a common unit's id whose body lives in another store, so fall back to
        // commonMemoryRecall or the offer names an action the agent cannot take.
        let unit = memoryStore.recall(agent, body);
        if (!unit && commonMemoryRecall) {
          try { unit = commonMemoryRecall(body); } catch { unit = null; }
        }
        if (!unit) {
          this._injectText(session, `[agent:memory] no match for "${body.trim().slice(0, 60)}"`, { parkable: true });
          return;
        }
        try { memLoad.noteRecall(agent, unit.id, session.sessionId); } catch { /* observer-grade */ }
        this._deliverMessage(agent, 'memory', `(${unit.id}${unit.scope ? ` ${unit.scope}` : ''})\n${unit.body}`, 'memory');
        return;
      }
      if (sub === 'pin' || sub === 'unpin') {
        try {
          memoryStore.setPinned(agent, body.trim(), sub === 'pin');
          refreshDigest();
          this._memoryAck(session, `[agent:memory] ${sub}ned ${body.trim()}`);
        } catch (e) {
          this._injectText(session, `[agent:memory] could not ${sub}: ${e.message}`, { parkable: true });
        }
        return;
      }
      if (sub === 'forget') {
        const res = this.removeMemoryUnit(agent, body.trim());
        if (res.ok) this._memoryAck(session, `[agent:memory] removed ${body.trim()} from the store`);
        else this._injectText(session, `[agent:memory] could not remove: ${res.error}`, { parkable: true });
        return;
      }
      this._injectText(session, `[agent:memory] unknown sub-command "${sub}" (use list|remember|recall|pin|unpin|forget)`, { parkable: true });
    }


    // Every rejecting return of a ticket command must route its reply suffix through here, or the composed
    // body is lost. A failed spill reports the failure and never a path.
    _spillRejectedPayload(session, verb, body) {
      if (!body) return '';
      try {
        const bytes = Buffer.byteLength(body);
        const path_ = spillToFile(`${verb} (rejected)`, body, session.name);
        const kept = this._keptMessagePath(path_);
        this._noteFiled(session.name, filedEntry(kept, 'message', `From: ${verb} (rejected)`));
        return kept !== path_
          ? ` — your ${verb} body (${bytes} bytes) is saved at ${kept}`
          : ` — your ${verb} body (${bytes} bytes) is saved for the next ${Math.round(MSG_MAX_AGE / 60)} minutes and then swept: ${path_} — copy it out before then`;
      } catch (e) {
        log.warn('intent', `spill of rejected ${verb} body for ${session.name} failed: ${e.message}`);
        return ` — WARNING: your ${verb} body could NOT be saved (${e.message}) and exists only in your own turn — copy it before you continue`;
      }
    }

    _deniedIntentPayload(session, intent) {
      const { how, label } = deniedBodyDisposition(intent);
      if (how === 'none') return '';
      const off = ` — this capability is off for this seat; retrying will bounce the same way, and only the operator can turn it on (Edit Session → Intents)`;
      const body = String(intent.body);
      const bytes = Buffer.byteLength(body);
      if (how === 'spill') {
        const used = (session._deniedSpills || (session._deniedSpills = new Map())).get(label) || 0;
        if (used < DENIED_SPILL_CAP) {
          try {
            const path_ = spillToFile(`${label} (denied)`, body, session.name);
            const kept = this._keptMessagePath(path_);
            this._noteFiled(session.name, filedEntry(kept, 'message', `From: ${label} (denied)`));
            session._deniedSpills.set(label, used + 1);
            return kept !== path_
              ? `${off}. Your ${label} body (${bytes} bytes) is saved at ${kept}`
              : `${off}. Your ${label} body (${bytes} bytes) is saved for the next ${Math.round(MSG_MAX_AGE / 60)} minutes and then swept: ${path_} — copy it out before then`;
          } catch (e) {
            log.warn('intent', `spill of denied ${label} body for ${session.name} failed: ${e.message}`);
            return `${off}. WARNING: your ${label} body (${bytes} bytes) could NOT be saved (${e.message}) and exists only in your own turn — copy it before you continue`;
          }
        }
        return `${off}. Your ${label} body (${bytes} bytes) was NOT saved — ${DENIED_SPILL_CAP} bodies for this verb have already been spilled this session and the rest are dropped; it exists only in your own turn`;
      }
      return `${off}. Your ${label} body (${bytes} bytes) was NOT saved and exists only in your own turn`;
    }

    static CONTEXT_COMMANDS = {
      claude: { compact: '/compact', clear: '/clear' },
      codex: { compact: '/compact', clear: '/clear' },
    };

    _promptDeltaPending(name, out = {}) {
      const session = this.sessions.get(name);
      if (!session || session._dead || session.agentType !== 'claude' || !session.promptRecipe) return false;
      const entry = getPersistence().get(name);
      if (!entry) return false;
      try {
        const { teamBlock, resolvedTeam } = this._teamBlockFor(name, entry.cwd, session.agentType, entry.systemPromptFile || null);
        const { realIpc } = this._realIpcFor(session.promptRecipe, teamBlock, resolvedTeam, name);
        out.bytes = Buffer.byteLength(realIpc, 'utf8');
        const baked = readCache(REGISTRY_DIR, name, 'session');
        if (baked == null) return false;
        const accountDir = session.accountDir || (entry.env && entry.env.CLAUDE_CONFIG_DIR);
        const snapshot = this._snapshotBlockFor(name, entry.cwd, accountDir, entry.sessionId);
        const running = (typeof snapshot === 'string' && snapshot && baked !== '') ? snapshot : baked;
        return ipcDelta(running, realIpc) != null;
      } catch (e) {
        this._shadowLog({ type: 'prompt-refresh-error', agent: name, error: e.message });
        return false;
      }
    }

    _coldRespawn(name, entry, session, handoff, why, opts = {}) {
      if (session._reloadInFlight) {
        this._broadcast('ipc-message', {
          type: 'context', from: name, to: name, body: `context ${why} → dropped (already in flight)`,
        });
        log.warn('intent', `${why} ${name} dropped — already in flight`);
        return false;
      }
      session._reloadInFlight = true;
      const waitExit = async (nm, timeoutMs = 8000) => {
        const start = Date.now();
        while (this.sessions.has(nm)) {
          if (Date.now() - start > timeoutMs) return false;
          await new Promise(r => setTimeout(r, 50));
        }
        return true;
      };
      setImmediate(async () => {
        try {
          if (this.sessions.has(name)) {
            await this.kill(name);
            if (!await waitExit(name)) throw new Error('old process did not exit in time');
          }
          if (typeof opts.onKilled === 'function') { try { opts.onKilled(); } catch {} }
          const resumeId = opts.resume === true ? (entry.sessionId || null) : null;
          if (resumeId) this._freshBakeOnce.add(name);
          // Carry the ticket-seat fields across the restart: dropped, a reloaded ticket seat reads as a standing
          // seat at accept, with no teardown and a leaked worktree.
          this._preserveAcrossRestart(name, entry, ['ephemeral', 'reviewFor', 'reviewTicket', 'createdAt']);
          const cwd = this.resumeCwdOf(entry);
          await this.create(
            name, entry.type, cwd, entry.extraArgs || [], resumeId, entry.workspaceId,
            entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [],
            entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [],
            entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [],
            Array.isArray(entry.execCommands) ? entry.execCommands : [],
            Array.isArray(entry.intents) ? entry.intents : null,
            // Session env must be passed: create() defaults it to null and re-persists the entry without it,
            // so every later --resume is wrong.
            (entry.env && typeof entry.env === 'object') ? entry.env : null,
            false,           // mint — a reload respawns an existing record
            entry.noWire === true,
            Array.isArray(entry.plugins) ? entry.plugins : null,
            Array.isArray(entry.shellDeny) ? entry.shellDeny : null,
            typeof entry.fixFor === 'string' ? entry.fixFor : null,
            entry.io || 'pty',
            typeof entry.effort === 'string' ? entry.effort : null,
          );
          const lvl = stripLevelOf(entry);
          if (lvl >= 1) getPersistence().setStripLevel(name, lvl);
          if (entry.label) getPersistence().setLabel(name, entry.label);
          this._sendToSession(name, 'session:context-action', {
            action: 'reattach', name, type: entry.type, cwd, backend: (this.sessions.get(name) || {}).backend || null, noWire: !!(this.sessions.get(name) || {}).noWire, io: (this.sessions.get(name) || {}).io || 'pty',
          });
          const fresh = this.sessions.get(name);
          if (fresh && session._scratchVoid) fresh._scratchVoid = session._scratchVoid;
          if (fresh && handoff) this._injectReloadHandoff(fresh, handoff, undefined, why);
        } catch (err) {
          session._reloadInFlight = false;
          this._freshBakeOnce.delete(name);
          console.error(`[agent:context ${why}] ${name} failed:`, err.message);
          // Re-upsert the entry without a worktree another live seat has since claimed, or the failure path
          // puts a second record on one tree (_stripClaimedTree).
          getPersistence().upsert(this._stripClaimedTree(entry));
        }
      });
      return true;
    }

    _handleContextIntent(session, sub, body = '') {
      if (sub === 'reload') {
        const name = session.name;
        const entry = getPersistence().get(name);
        if (!entry) return;
        const handoff = (body || '').trim();
        if (!handoff) {
          this._injectText(session,
            '[agent:context] reload needs a handoff body — '
            + 'reload drops all history, so the fresh process only knows what you '
            + 'pass it. Re-fire as `[agent:context reload] <briefing for your next '
            + 'self: what you were doing, what to do next>`. Reload aborted; '
            + 'this session is untouched.', { parkable: true });
          return;
        }
        if (!this._coldRespawn(name, entry, session, handoff, 'reload')) return;
        this._voidScratchMark(session,
          'the conversation was reloaded after the mark — every mark is gone and nothing can be cut. '
          + 'Your summary is in your own turn above; carry on from it.', { notify: false });
        log.info('intent', `reload ${name} → cold respawn`);
        this._broadcast('ipc-message', {
          type: 'context', from: name, to: name, body: 'context reload → fresh restart',
        });
        return;
      }
      if (session._reloadInFlight) {
        this._broadcast('ipc-message', {
          type: 'context', from: session.name, to: session.name, body: `context ${sub} → dropped (already in flight)`,
        });
        log.warn('intent', `${sub} ${session.name} dropped — already in flight`);
        return;
      }
      const map = SessionManager.CONTEXT_COMMANDS[session.type];
      const wireCtx = session.io === 'stream' && session.streamCodec && typeof session.streamCodec.encodeContext === 'function';
      const unsupported = () => {
        console.warn(`[agent:context ${sub}] from ${session.name}: unsupported for type ${session.type}`);
        this._injectText(session,
          `[agent:context] unknown or unsupported sub-command "${sub}" for a ${session.type} session (use compact|clear|reload)`,
          { parkable: true });
      };
      const encode = () => (wireCtx ? session.streamCodec.encodeContext(sub) : (map && map[sub]));
      if (wireCtx ? (sub !== 'compact' && sub !== 'clear') : !(map && map[sub])) {
        unsupported();
        return;
      }
      if (sub === 'compact' && isInjectInFlight({ pending: session._compactPending, guard: session._compactGuard, continuation: session._compactContinuation })) {
        this._broadcast('ipc-message', {
          type: 'context', from: session.name, to: session.name,
          body: 'context compact → dropped (already in flight)',
        });
        log.warn('intent', `compact ${session.name} dropped — already in flight`);
        return;
      }
      if (sub === 'compact') {
        const cmd = encode();
        if (!cmd) {
          unsupported();
          return;
        }
        const cont = (body && body.trim()) ? body.trim() : DEFAULT_COMPACT_CONTINUATION;
        if (session.intentSource === 'wire') {
          session._compactPending = { cmd, continuation: cont };
          this._armCompactValve(session);
          log.info('intent', `compact ${session.name} → latched (fires at next terminal stop, queue empty)`);
          this._broadcast('ipc-message', {
            type: 'context', from: session.name, to: session.name, body: 'context compact → latched',
          });
          return;
        }
        this._executeCompact(session, cmd, cont);
        return;
      }
      if (sub === 'clear' && session._postClearContinuation) {
        this._broadcast('ipc-message', {
          type: 'context', from: session.name, to: session.name,
          body: 'context clear → dropped (already in flight)',
        });
        log.warn('intent', `clear ${session.name} dropped — already in flight`);
        return;
      }
      const regen = {};
      if (sub === 'clear' && this._promptDeltaPending(session.name, regen)) {
        const name = session.name;
        const entry = getPersistence().get(name);
        if (!this._coldRespawn(name, entry, session, (body || '').trim(), 'clear')) return;
        this._voidScratchMark(session,
          'the conversation was cleared after the mark — every mark is gone and nothing can be cut. '
          + 'Your summary is in your own turn above; carry on from it.', { notify: false });
        log.info('intent', `clear ${name} → cold respawn (prompt regenerated, ${regen.bytes} bytes)`);
        this._broadcast('ipc-message', {
          type: 'context', from: name, to: name, body: 'context clear → cold respawn (prompt regenerated)',
        });
        this._shadowLog({ type: 'prompt-regen-at-clear', agent: name, bytes: regen.bytes });
        return;
      }
      const cmd = encode();
      if (!cmd) {
        unsupported();
        return;
      }
      // Inject clear immediately with bypassHold: a queued bare slash command must never join a flush
      // batch, or the command line swallows the rest.
      if (wireCtx) this._streamEnqueue(session, { text: '', images: [], origin: 'system', wire: cmd });
      else this._injectText(session, cmd, { bypassHold: true });
      const cont = sub === 'clear' && body ? body.trim() : '';
      if (cont) {
        session._postClearContinuation = cont;
        this._armPostClearValve(session);
      }
      const shown = wireCtx ? cmd.method : cmd;
      log.info('intent', `${sub} ${session.name} → ${shown}${cont ? ' (+continuation)' : ''}`);
      this._broadcast('ipc-message', {
        type: 'context', from: session.name, to: session.name, body: `context ${sub} → ${shown}`,
      });
    }


    _handleScratchIntent(session, intent) {
      const reply = (msg) => this._injectText(session, msg, { parkable: true });
      if (session.agentType !== 'claude') {
        reply('[agent:scratch] Claude seats only — a Codex transcript has a different shape and no rewind '
          + 'has been proven for it.');
        return;
      }
      if (intent.sub === 'begin') { this._scratchBegin(session, reply); return; }
      if (intent.sub === 'mark') { this._scratchBegin(session, reply, { label: intent.label }); return; }
      if (intent.sub === 'cancel') { this._scratchCancel(session, reply, intent); return; }
      if (intent.sub === 'end' || intent.sub === 'rewind') return this._scratchEnd(session, intent, reply);
    }

    scratchMark(name, label) {
      const session = this.sessions.get(name);
      if (!session || session._dead) throw new Error(`session ${name} is not running`);
      if (session.agentType !== 'claude') throw new Error('scratch marks are for Claude seats only');
      if (typeof label !== 'string' || !SCRATCH_LABEL_RE.test(label)) throw new Error(`invalid scratch label ${JSON.stringify(label)}`);
      const v = this._scratchBeginTail(session);
      const settled = this._scratchBeginSettled(session, v);
      const refuse = (why) => {
        const error = `scratch mark ${label} refused: ${why}`;
        this._broadcast('ipc-message', { type: 'scratch', from: name, to: name, body: error });
        return { ok: false, error };
      };
      if (!settled || v.state !== 'ok' || session.activityState === 'thinking') {
        const state = v.state === 'ok' ? 'mid-turn' : v.state;
        return refuse(`${state} — re-try when the seat is idle`);
      }
      const taken = this._scratchOpenMarks(session).find((m) => m.label && m.label !== label && m.sizeAtBegin === v.t.size);
      if (taken) return refuse(`"${taken.label}" already marks this exact point`);
      const pending = this._scratchMarksOf(session).get(label);
      if (pending && pending.closing) return refuse(`${pending.closing.verb} already pending for mark ${pending.nonce}`);
      const reply = (msg) => this._injectText(session, msg, { parkable: true });
      const mark = this._scratchMark(session, v, reply, { label, operator: true, atEnd: true });
      if (!mark) return refuse('another label already marks this point');
      return { ok: true, nonce: mark.nonce, offset: mark.sizeAtBegin };
    }

    _scratchMarksOf(session) {
      if (!(session._scratchMarks instanceof Map)) session._scratchMarks = new Map();
      return session._scratchMarks;
    }

    _scratchOpenMarks(session) {
      const named = session && session._scratchMarks instanceof Map ? [...session._scratchMarks.values()] : [];
      return session && session._scratch ? [session._scratch, ...named] : named;
    }

    _scratchLabelsRecentFirst(session) {
      return this._scratchOpenMarks(session)
        .filter((m) => m.label)
        .sort((a, b) => b.sizeAtBegin - a.sizeAtBegin)
        .map((m) => m.label);
    }

    _scratchClosingMark(session) {
      return this._scratchOpenMarks(session).find((m) => m.closing) || null;
    }

    _scratchRewindTarget(session, label) {
      if (label) {
        const marks = session._scratchMarks;
        return (marks instanceof Map && marks.get(label)) || null;
      }
      let best = null;
      for (const m of this._scratchOpenMarks(session)) {
        if (!best || m.sizeAtBegin > best.sizeAtBegin || (m.sizeAtBegin === best.sizeAtBegin && m.label)) best = m;
      }
      return best;
    }

    _scratchNoMarkLine(session, verb, label) {
      const labels = this._scratchLabelsRecentFirst(session);
      if (label && labels.length) {
        return `[agent:scratch] ${verb} refused: no mark named "${label}" is set — marks set: ${labels.join(', ')} `
          + '(most recent first). Nothing was cut.';
      }
      return `[agent:scratch] ${verb} refused: no mark is set — set one with [agent:scratch mark <label>] as the `
        + 'last line of a reply. Nothing was cut.';
    }

    _scratchTranscript(session) {
      try {
        const realpath = fs.realpathSync(pathFor(REGISTRY_DIR, session.name, 'transcript'));
        const size = fs.statSync(realpath).size;
        return { realpath, size };
      } catch { return null; }
    }

    _scratchUsageAt(records) {
      for (let i = records.length - 1; i >= 0; i--) {
        const e = records[i];
        if (e.type !== 'assistant') continue;
        const u = e.record && e.record.message && e.record.message.usage;
        if (!u || typeof u !== 'object') continue;
        return {
          input: u.input_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
        };
      }
      return null;
    }

    _scratchBeginTail(session) {
      const t = this._scratchTranscript(session);
      if (!t) return { state: 'no-transcript' };
      const from = Math.max(0, t.size - SCRATCH_TAIL_SCAN);
      let buf;
      try {
        const fd = fs.openSync(t.realpath, 'r');
        try {
          buf = Buffer.alloc(t.size - from);
          fs.readSync(fd, buf, 0, buf.length, from);
        } finally { fs.closeSync(fd); }
      } catch {
        return { state: 'unreadable' };
      }
      const { records } = scratchParseTail(buf, { baseOffset: from });
      const boundary = scratchBoundaryAt(records);
      if (boundary.ok) return { state: 'ok', t, buf, records, boundary };
      if (boundary.entry && boundary.entry.type === 'assistant') return { state: 'mid-turn' };
      return { state: 'behind' };
    }

    _scratchBeginRefuse(reply, state, opts = {}) {
      const verb = opts.label ? 'mark' : 'begin';
      if (state === 'no-transcript') {
        reply(`[agent:scratch] ${verb} refused: this seat has no readable transcript file yet, so there is `
          + 'nothing to mark. Not marked.');
        return;
      }
      if (state === 'unreadable') {
        reply(`[agent:scratch] ${verb} refused: the transcript tail could not be read, so the cut point `
          + 'cannot be proven to be a turn boundary. Not marked.');
        return;
      }
      if (state === 'behind') {
        reply(`[agent:scratch] ${verb} refused: the transcript moved on before the turn end could be confirmed `
          + `(the wait timed out after ${Math.round(SCRATCH_CLOSE_TIMEOUT / 1000)}s). Emit it again as the last line `
          + 'of your next reply. Not marked.');
        return;
      }
      reply(`[agent:scratch] ${verb} refused: it must be the last line of a reply (your reply went on to `
        + 'call tools). Emit it alone and stop; the episode opens when Clodex acks it. Not marked.');
    }

    _scratchBeginSettled(session, v) {
      if (v.state === 'behind') return false;
      if (v.state === 'ok' && v.boundary.entry.type !== 'system' && session.io !== 'stream' && session._flushTurnEnd === true) return false;
      return true;
    }

    _scratchBegin(session, reply, opts = {}) {
      if (session._scratchPendingBegin) { this._scratchDeferBegin(session, reply, opts); return; }
      const v = this._scratchBeginTail(session);
      if (!this._scratchBeginSettled(session, v)) {
        this._scratchDeferBegin(session, reply, opts);
        return;
      }
      if (v.state === 'ok') { this._scratchMark(session, v, reply, opts); return; }
      this._scratchBeginRefuse(reply, v.state, opts);
    }

    _scratchSettleRequests(session, v, requests) {
      for (const r of requests) {
        if (v.state === 'ok') this._scratchMark(session, v, r.reply, r.opts);
        else this._scratchBeginRefuse(r.reply, v.state, r.opts);
      }
    }

    _scratchDeferBegin(session, reply, opts = {}) {
      const label = opts.label || null;
      const held = session._scratchPendingBegin;
      if (held) {
        held.requests = held.requests.filter((r) => (r.opts.label || null) !== label);
        held.requests.push({ reply, opts });
        setImmediate(() => this._scratchWakePendingBegin(session, held));
        return;
      }
      const pending = { requests: [{ reply, opts }], watcher: null, timer: null };
      session._scratchPendingBegin = pending;
      const wake = () => this._scratchWakePendingBegin(session, pending);
      const t = this._scratchTranscript(session);
      try {
        pending.watcher = t ? fs.watch(t.realpath, { persistent: false }, wake) : null;
        if (pending.watcher) pending.watcher.on('error', () => {});
      } catch { pending.watcher = null; }
      pending.timer = setTimeout(() => {
        pending.timer = null;
        if (session._scratchPendingBegin !== pending) return;
        this._scratchDropPendingBegin(session);
        this._scratchSettleRequests(session, this._scratchBeginTail(session), pending.requests);
      }, SCRATCH_CLOSE_TIMEOUT);
      setImmediate(wake);
      log.info('intent', `scratch ${session.name}: ${label ? `mark ${label}` : 'begin'} waits for the transcript to reach the turn end`);
    }

    _scratchDropPendingBegin(session, label) {
      const pending = session._scratchPendingBegin;
      if (!pending) return false;
      let dropped = true;
      if (label !== undefined) {
        const before = pending.requests.length;
        pending.requests = pending.requests.filter((r) => (r.opts.label || null) !== label);
        dropped = pending.requests.length < before;
        if (pending.requests.length) return dropped;
      }
      session._scratchPendingBegin = null;
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.watcher) { try { pending.watcher.close(); } catch {} }
      return dropped;
    }

    _scratchWakePendingBegin(session, pending) {
      if (session._scratchPendingBegin !== pending) return;
      if (session._dead) { this._scratchDropPendingBegin(session); return; }
      const v = this._scratchBeginTail(session);
      if (!this._scratchBeginSettled(session, v)) return;
      this._scratchDropPendingBegin(session);
      this._scratchSettleRequests(session, v, pending.requests);
    }

    _scratchMark(session, v, reply, opts = {}) {
      const { t, buf, records, boundary } = v;
      const label = typeof opts.label === 'string' && opts.label ? opts.label : null;
      const marks = label ? this._scratchMarksOf(session) : null;
      const prior = label ? (marks.get(label) || null) : session._scratch;
      const n = scratchNonce();
      const cut = opts.atEnd === true ? null : scratchBeginCutAt(records);
      const cutOffset = cut ? cut.offset : t.size;
      const leaf = cut ? cut.leaf : boundary.entry;
      if (label) {
        const taken = [...marks.values()].find((m) => m.label !== label && m.sizeAtBegin === cutOffset);
        if (taken) {
          reply(`[agent:scratch] mark refused: "${taken.label}" already marks this exact point — one label per point. Not marked.`);
          return null;
        }
      }
      if (prior && prior.closing) {
        const verb = label ? 'mark' : 'begin';
        reply(`[agent:scratch] ${verb} refused: ${prior.closing.verb} already pending for mark ${prior.nonce}${label ? ` (${label})` : ''} — `
          + `it fires first. Not marked; ${verb} again after it settles.`);
        return null;
      }
      if (prior && prior._closeTimer) clearTimeout(prior._closeTimer);
      const end = cutOffset - (t.size - buf.length);
      const tail = buf.subarray(Math.max(0, end - SCRATCH_MARK_TAIL), end);
      const mark = {
        nonce: n,
        realpath: t.realpath,
        sessionId: session.sessionId || null,
        sizeAtBegin: cutOffset,
        tailBytes: Buffer.from(tail),
        leafUuid: (leaf && leaf.record && leaf.record.uuid) || null,
        beganAt: Date.now(),
        arrivals: [],
        dispatched: [],
        usageAtBegin: this._scratchUsageAt(records),
        closing: null,
        _closeTimer: null,
      };
      session._scratchVoid = null;
      if (!label) {
        session._scratch = mark;
        let ack = `${SCRATCH_ACK_PREFIX}${n}. Research now. Close with \`[agent:scratch end] <summary>\` … `
          + '`[agent:end]` as the last thing in a reply; a bare `[agent:scratch cancel]` drops the most recent mark and cuts nothing.';
        if (prior) {
          ack += `\nEpisode re-opened: the earlier mark ${prior.nonce} is dropped; what you read since it is `
            + 'now ordinary history and will NOT be cut.';
        }
        reply(ack);
        log.info('intent', `scratch ${session.name}: mark ${n} opened at ${cutOffset}${prior ? ` (replaces ${prior.nonce})` : ''}`);
        return mark;
      }
      mark.label = label;
      mark.notes = [];
      mark.operator = opts.operator === true;
      marks.set(label, mark);
      const by = mark.operator ? `, set by your operator at ${scratchArrivalClock(new Date(mark.beganAt).toISOString())}` : '';
      let ack = `${SCRATCH_ACK_PREFIX}${n} · label ${label}${by}. Rewind to it later with `
        + `\`[agent:scratch rewind ${label}] <note>\` … \`[agent:end]\`; a bare \`[agent:scratch rewind]\` targets the `
        + 'most recent mark, and an empty note means "negative result".';
      if (prior) {
        ack += `\nLabel ${label} re-set: the earlier point is dropped; what you read since it is ordinary history `
          + 'and will NOT be cut.';
      }
      reply(ack);
      if (mark.operator) {
        this._broadcast('ipc-message', {
          type: 'scratch', from: session.name, to: session.name,
          body: `scratch mark ${label} set by operator at ${cutOffset}`,
        });
      }
      log.info('intent', `scratch ${session.name}: mark ${n} (${label}) opened at ${cutOffset}${prior ? ` (replaces ${prior.nonce})` : ''}`);
      return mark;
    }

    _scratchCancel(session, reply, intent = {}) {
      let label = typeof intent.label === 'string' && intent.label ? intent.label : null;
      const droppedPending = this._scratchDropPendingBegin(session, label);
      session._scratchVoid = null;
      if (!label) {
        const best = this._scratchRewindTarget(session, null);
        if (best && best.label) label = best.label;
      }
      if (label) {
        const marks = session._scratchMarks;
        const named = (marks instanceof Map && marks.get(label)) || null;
        if (!named && droppedPending && intent.label === label) {
          reply(`[agent:scratch] mark ${label} cancelled before it was set`);
          log.info('intent', `scratch ${session.name}: pending mark ${label} cancelled before it was set`);
          return;
        }
        if (!named) { reply(this._scratchNoMarkLine(session, 'cancel', label)); return; }
        if (named._closeTimer) clearTimeout(named._closeTimer);
        marks.delete(label);
        reply(`[agent:scratch] mark ${label} dropped · mark ${named.nonce}. Nothing was cut; everything you read `
          + 'since it stays in your transcript as ordinary history.');
        log.info('intent', `scratch ${session.name}: mark ${named.nonce} (${label}) cancelled`);
        this._recordScratchEpisode(session, named, { body: '', replay: false },
          { outcome: 'cancelled', reason: null, stats: null, replayed: null, recycleMs: null });
        return;
      }
      const mark = session._scratch;
      if (!mark && droppedPending) {
        reply('[agent:scratch] pending begin cancelled before it opened');
        log.info('intent', `scratch ${session.name}: pending begin cancelled before it opened`);
        return;
      }
      if (!mark) {
        reply('[agent:scratch] cancel: no episode is open — nothing was cut.');
        return;
      }
      if (mark._closeTimer) clearTimeout(mark._closeTimer);
      session._scratch = null;
      reply(`[agent:scratch] episode cancelled · mark ${mark.nonce} is dropped. Nothing was cut; everything `
        + 'you read since begin stays in your transcript as ordinary history.');
      log.info('intent', `scratch ${session.name}: mark ${mark.nonce} cancelled`);
      this._recordScratchEpisode(session, mark, { body: '', replay: false },
        { outcome: 'cancelled', reason: null, stats: null, replayed: null, recycleMs: null });
    }

    _scratchEnd(session, intent, reply) {
      const verb = intent.sub === 'rewind' ? 'rewind' : 'end';
      const label = typeof intent.label === 'string' && intent.label ? intent.label : null;
      const mark = verb === 'end' ? session._scratch : this._scratchRewindTarget(session, label);
      if (!mark) {
        const tomb = session._scratchVoid;
        if (tomb) {
          session._scratchVoid = null;
          reply(`[agent:scratch] ${verb} refused: ${tomb}`);
          return;
        }
        if (verb === 'end') { reply('[agent:scratch] end refused: no episode is open — nothing was cut.'); return; }
        reply(this._scratchNoMarkLine(session, verb, label));
        return;
      }
      const body = String(intent.body == null ? '' : intent.body).trim();
      if (!body && verb === 'end') {
        reply('[agent:scratch] end refused: the summary body is empty — an empty summary is a rewind that '
          + 'loses the work. Re-emit [agent:scratch end] with the briefing (what you now know, what you '
          + `did), closed by [agent:end]. Nothing was cut; the mark ${mark.nonce} is still open.`);
        return;
      }
      const busy = this._scratchClosingMark(session);
      if (busy) {
        reply(`[agent:scratch] ${busy.closing.verb} already pending for mark ${busy.nonce} — waiting for your reply to `
          + `finish. Nothing was cut yet; the first ${busy.closing.verb} is the one that will fire.`);
        return;
      }
      mark.closing = { body, replay: intent.replay === true, verb };
      if (session._flushTurnEnd === true) {
        return new Promise((resolve) => setImmediate(() => resolve(this._fireScratchClose(session))));
      }
      mark._closeTimer = setTimeout(() => {
        mark._closeTimer = null;
        if (!this._scratchOpenMarks(session).includes(mark) || !mark.closing) return;
        mark.closing = null;
        this._injectText(session,
          `[agent:scratch] ${verb} deferred ${Math.round(SCRATCH_CLOSE_TIMEOUT / 1000)}s waiting for your reply `
          + `to finish; re-emit it as the last thing in a reply. Nothing was cut; the mark ${mark.nonce} is `
          + 'still open.', { parkable: true });
      }, SCRATCH_CLOSE_TIMEOUT);
    }

    _fireScratchClose(session) {
      if (!session || session._dead) return;
      const mark = this._scratchClosingMark(session);
      if (!mark) return;
      const closing = mark.closing;
      mark.closing = null;
      if (mark._closeTimer) { clearTimeout(mark._closeTimer); mark._closeTimer = null; }
      return this._runScratchCut(session, mark, closing).catch((e) => {
        log.error('intent', `scratch ${session.name}: cut failed: ${e.message}`);
      });
    }

    _readScratchFile(realpath) {
      try { return fs.readFileSync(realpath); } catch { return null; }
    }

    _scratchRefusalLine(mark, v, verb = 'end') {
      const tail = 'Your summary is in your own turn above; carry on from it.';
      switch (v.reason) {
        case 'cleared':
          return `[agent:scratch] ${verb} refused: the conversation was cleared/reloaded after mark ${mark.nonce} `
            + `— the mark is gone and nothing can be cut. ${tail}`;
        case 'compacted':
          return `[agent:scratch] ${verb} refused: a compact landed inside the episode after mark ${mark.nonce} `
            + `— the mark is gone and nothing can be cut. ${tail}`;
        case 'ack-missing':
          return `[agent:scratch] ${verb} refused: the episode never opened (the ack after begin never reached `
            + 'you). Nothing was cut; emit begin again when idle.';
        case 'arrivals': {
          const real = scratchRealArrivals(v.arrivals);
          const who = real.map((a) => {
            const clock = scratchArrivalClock(a.at);
            const at = clock ? ` at ${clock}` : '';
            return `${previewLine(a.text, 60)}${at}`;
          }).join(', ');
          return `[agent:scratch] ${verb} refused: ${real.length} message(s) arrived during the `
            + `episode and would be cut with it — ${who}. Handle them now if you have not, then re-emit `
            + '`[agent:scratch end replay] <summary>` to cut AND have them re-delivered verbatim after your '
            + `summary, or \`[agent:scratch cancel]\` to keep everything. Nothing was cut; the mark ${mark.nonce} is still open.`;
        }
        case 'dispatch-unmentioned': {
          const did = (mark.dispatched || [])
            .map((d) => `${d.type}${d.sub ? ` ${d.sub}` : ''} ${d.token}`)
            .join(' and ');
          return `[agent:scratch] ${verb} refused: inside this episode you dispatched ${did}, and ${v.detail}. `
            + 'After the cut you will not remember doing it. Re-emit end with each dispatch under "what I '
            + `did" (id, who, what for), or cancel. Nothing was cut; the mark ${mark.nonce} is still open.`;
        }
        default:
          return `[agent:scratch] ${verb} refused: ${v.detail || v.reason} (mark ${mark.nonce}). Nothing was cut; `
            + 'the mark is still open.';
      }
    }

    _parkHeldInjects(session) {
      const queue = session._injectQueue;
      if (!Array.isArray(queue) || !queue.length) return 0;
      const kept = [];
      let parked = 0;
      for (const e of queue) {
        if (!e || typeof e.produce === 'function') { if (e) kept.push(e); continue; }
        const o = typeof e === 'object' && e.opts ? e.opts : null;
        const text = typeof e === 'string' ? e : (o ? e.text : String(e));
        if (!text) continue;
        try {
          parkDelivery(PENDING_DIR, session.name, text, this._nextParkSeq(), (o && o.parkId) || null, false, null, (o && o.parkKey) || null);
          parked++;
        } catch (err) {
          log.warn('intent', `scratch ${session.name}: parking a held inject failed: ${err.message}`);
          kept.push(e);
        }
      }
      session._injectQueue = kept;
      return parked;
    }

    async _quiesceInjects(session) {
      session._recycling = true;
      const q = session._injectPtyQueue;
      if (q && typeof q.settled === 'function') { try { await q.settled(); } catch {} }
      return this._parkHeldInjects(session);
    }

    async _scratchRecycle(session, entry) {
      const name = session.name;
      session._moving = true;
      await this._stopForRespawn(session, name);
      if (!await this._waitForExit(name)) {
        session._moving = false;
        return false;
      }
      return true;
    }

    async _scratchRespawn(name, entry) {
      const cwd = this.resumeCwdOf(entry);
      await this.create(
        name, entry.type, cwd, entry.extraArgs || [], entry.sessionId || null,
        entry.workspaceId || DEFAULT_WORKSPACE_ID,
        entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [],
        entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [],
        entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [],
        Array.isArray(entry.execCommands) ? entry.execCommands : [],
        Array.isArray(entry.intents) ? entry.intents : null,
        (entry.env && typeof entry.env === 'object') ? entry.env : null,
        false,
        entry.noWire === true,
        Array.isArray(entry.plugins) ? entry.plugins : null,
        Array.isArray(entry.shellDeny) ? entry.shellDeny : null,
        typeof entry.fixFor === 'string' ? entry.fixFor : null,
        entry.io || 'pty',
        typeof entry.effort === 'string' ? entry.effort : null,
      );
      const fresh = this.sessions.get(name);
      const lvl = stripLevelOf(entry);
      if (lvl >= 1) getPersistence().setStripLevel(name, lvl);
      if (entry.label) getPersistence().setLabel(name, entry.label);
      this._sendToSession(name, 'session:context-action', {
        action: 'reattach', name, type: entry.type, cwd,
        backend: (fresh || {}).backend || null, noWire: !!(fresh || {}).noWire, io: (fresh || {}).io || 'pty',
      });
      return fresh || null;
    }

    async _runScratchCut(session, mark, closing) {
      let ep = null;
      try {
        ep = await this._scratchCutSteps(session, mark, closing);
      } catch (e) {
        ep = { outcome: 'failed', reason: e.message, stats: null, replayed: null, recycleMs: null };
        throw e;
      } finally {
        this._recordScratchEpisode(session, mark, closing, ep);
      }
    }

    _scratchCostPath(session) {
      const name = session && session.name;
      if (!name) return null;
      let team = null;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      try {
        if (team && team.name && teamsDir) return path.join(teamsDir, team.name, SCRATCH_COST_FILE);
        return path.join(scratchDirFor(REGISTRY_DIR, name), 'episodes.jsonl');
      } catch { return null; }
    }

    _recordScratchEpisode(session, mark, closing, ep) {
      const e = ep || { outcome: 'failed', reason: 'no disposition', stats: null, replayed: null, recycleMs: null };
      let team = null;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      const body = (closing && typeof closing.body === 'string') ? closing.body : '';
      const row = scratchCostRecord({
        seat: session.name,
        team: team && team.name ? team.name : null,
        sessionId: mark.sessionId || session.sessionId || null,
        nonce: mark.nonce,
        label: mark.label || null,
        beganAt: mark.beganAt,
        endedAt: Date.now(),
        stats: e.stats,
        summaryBytes: Buffer.byteLength(body, 'utf8'),
        replayed: e.replayed,
        dispatched: (mark.dispatched || []).map((d) => (d && typeof d.token === 'string' ? d.token : null)),
        outcome: e.outcome,
        reason: e.reason,
        recycleMs: e.recycleMs,
      });
      const file = this._scratchCostPath(session);
      if (file) {
        try {
          ensureDir(path.dirname(file));
          fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
        } catch (err) {
          log.warn('intent', `scratch ${session.name}: the measurement row could not be appended: ${err.message}`);
        }
      }
      this._broadcast('ipc-message', {
        type: 'scratch', from: session.name, to: session.name,
        body: `scratch ${mark.nonce}${row.label ? ` · ${row.label}` : ''} → ${this._scratchEpisodeLine(row)}`,
      });
    }

    _scratchEpisodeLine(row) {
      if (row.outcome !== 'cut') return `${row.outcome}${row.reason ? ` (${row.reason})` : ''}`;
      const kb = (n) => (typeof n === 'number' ? `${Math.round(n / 1024)}KB` : '?KB');
      const tok = typeof row.tokens.dropped === 'number'
        ? `~${Math.round(row.tokens.dropped / 1000)}k tokens` : 'tokens unknown';
      const replay = row.replayed ? `, replayed ${row.replayed}` : '';
      const reason = row.reason ? ` — ${row.reason}` : '';
      return `cut ${kb(row.bytes.dropped)} / ${row.turns.dropped == null ? '?' : row.turns.dropped} turns / `
        + `${tok}, summary ${kb(row.summaryBytes)}${replay}${reason}`;
    }

    async _scratchCutSteps(session, mark, closing) {
      const name = session.name;
      const reply = (msg) => this._injectText(session, msg, { parkable: true });
      const refused = (reason, stats = null) => ({ outcome: 'refused', reason, stats, replayed: null, recycleMs: null });
      const verb = closing.verb || 'end';
      const entry = getPersistence().get(name);
      if (!entry) {
        reply(`[agent:scratch] ${verb} refused: this seat has no persistence record, so it cannot be respawned `
          + `on a cut transcript. Nothing was cut; the mark ${mark.nonce} is still open.`);
        return refused('no-record');
      }

      const live = this._readScratchFile(mark.realpath);
      if (!live) {
        reply(`[agent:scratch] ${verb} refused: the marked transcript ${mark.realpath} could not be read. `
          + `Nothing was cut; the mark ${mark.nonce} is still open.`);
        return refused('unreadable');
      }
      let realpath = null;
      try { realpath = fs.realpathSync(pathFor(REGISTRY_DIR, name, 'transcript')); } catch { realpath = null; }
      const opts = { realpath: realpath === null ? undefined : realpath, body: closing.body, replay: closing.replay };
      const v1 = this._scratchValidate(mark, live, opts);
      if (!v1.ok) { reply(this._scratchRefusalLine(mark, v1, verb)); return refused(v1.reason, v1.stats); }

      if (this._movingNames.has(name)) {
        reply(`[agent:scratch] ${verb} refused: this seat is being moved or renamed right now, and cutting `
          + `across that would race two respawns under one name. Nothing was cut; the mark ${mark.nonce} `
          + `is still open — re-emit ${verb} when the move is done.`);
        return refused('moving', v1.stats);
      }
      this._movingNames.add(name);
      try {
        return await this._scratchCutAfterGuard(session, mark, closing, entry, opts, reply);
      } finally {
        this._movingNames.delete(name);
      }
    }

    async _scratchCutAfterGuard(session, mark, closing, entry, opts, reply) {
      const name = session.name;
      await this._quiesceInjects(session);
      try { if (this._holdKeeper && session.sessionId) this._holdKeeper.endSession(session.sessionId); } catch {}
      session._holdRearmed = false;

      const verb = closing.verb || 'end';
      const recycleStart = Date.now();
      if (!await this._scratchRecycle(session, entry)) {
        session._recycling = false;
        reply(`[agent:scratch] ${verb} refused: the old process did not exit in time — nothing was cut. The `
          + `mark ${mark.nonce} is still open.`);
        return { outcome: 'refused', reason: 'exit-timeout', stats: null, replayed: null, recycleMs: null };
      }

      const quiet = this._readScratchFile(mark.realpath);
      const v2 = quiet ? this._scratchValidate(mark, quiet, opts) : null;
      if (!v2 || !v2.ok) {
        const why = v2 ? (v2.detail || v2.reason) : `${mark.realpath} could not be re-read`;
        const fresh = await this._scratchRespawnSafely(session, entry, mark, null);
        if (fresh) {
          await this._injectAfterBoot(fresh,
            `[agent:scratch] the cut was ABANDONED after your process was recycled: ${why}. The transcript `
            + 'was NOT cut and your seat came back on it whole; the mark is dropped. Your summary is in your '
            + 'own turn above; carry on from it.',
            { logPrefix: '[agent:scratch]', dropBody: 'scratch → abandon notice NOT injected' });
        }
        return {
          outcome: 'refused', reason: v2 ? (v2.reason || 'revalidate') : 'unreadable',
          stats: v2 ? v2.stats : null, replayed: null, recycleMs: Date.now() - recycleStart,
        };
      }

      const dir = scratchDirFor(REGISTRY_DIR, name);
      const bak = path.join(dir, `${mark.sessionId || 'session'}.${mark.nonce}.jsonl.bak`);
      const tmp = path.join(path.dirname(mark.realpath), `.${mark.sessionId || 'session'}.${mark.nonce}.tmp`);
      try {
        ensureDir(dir);
        fs.copyFileSync(mark.realpath, bak);
        fs.chmodSync(bak, 0o600);
        this._scratchPruneBaks(dir, bak);
        fs.writeFileSync(tmp, quiet.subarray(0, v2.cutOffset));
        try {
          const fd = fs.openSync(tmp, 'r+');
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        } catch {}
        fs.renameSync(tmp, mark.realpath);
        clearCache(REGISTRY_DIR, name, 'snapshot');
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        const fresh = await this._scratchRespawnSafely(session, entry, mark, bak, { keepMark: true });
        if (fresh) {
          await this._injectAfterBoot(fresh,
            `[agent:scratch] the cut FAILED while writing: ${err.message}. The transcript was restored from `
            + `backup and your seat respawned WITHOUT cutting; the mark ${mark.nonce} is still open, so you `
            + `can re-emit ${closing.verb || 'end'}. Your summary is in your own turn above.`,
            { logPrefix: '[agent:scratch]', dropBody: 'scratch → write-failure notice NOT injected' });
        }
        return {
          outcome: 'failed', reason: `write: ${err.message}`, stats: v2.stats,
          replayed: null, recycleMs: Date.now() - recycleStart,
        };
      }

      let fresh = null;
      try {
        fresh = await this._scratchRespawn(name, entry);
      } catch (err) {
        log.error('intent', `scratch ${name}: respawn after the cut failed: ${err.message}`);
        this._scratchRestore(mark, bak);
        getPersistence().upsert(this._stripClaimedTree(entry));
        return {
          outcome: 'failed', reason: `respawn: ${err.message}`, stats: v2.stats,
          replayed: null, recycleMs: Date.now() - recycleStart,
        };
      }

      log.info('intent', `scratch ${name}: mark ${mark.nonce} cut ${v2.stats.bytes.dropped} bytes `
        + `(${v2.stats.records.dropped} records) at ${v2.cutOffset}; backup ${bak}`);
      const done = (replayed) => ({
        outcome: 'cut', reason: null, stats: v2.stats,
        replayed, recycleMs: Date.now() - recycleStart,
      });
      const notInjected = () => ({ ...done(null), reason: 'summary-not-injected' });
      if (!fresh) return notInjected();
      const kept = scratchParseTail(quiet.subarray(0, v2.cutOffset)).records;
      this._scratchCarryMarks(session, fresh, mark, v2.cutOffset, kept);
      const endedAt = Date.now();
      const landed = await this._injectAfterBoot(fresh, scratchBriefing(mark, v2.stats, closing.body, { notes: mark.notes, endedAt }), {
        logPrefix: '[agent:scratch]',
        snapshot: false,
        dropBody: `scratch ${mark.nonce} → summary NOT injected (fresh CLI never signaled boot)`,
      });
      if (!landed) {
        if (mark.label) log.info('intent', `scratch ${fresh.name}: mark ${mark.label} NOT re-armed — the briefing did not land`);
        return notInjected();
      }
      if (mark.label) this._scratchReArm(fresh, mark, closing, v2.cutOffset, quiet, kept, endedAt);
      return done(this._replayScratchArrivals(fresh, mark, closing, v2.arrivals));
    }

    _scratchValidate(mark, buf, opts) {
      const v = validateScratchCut(mark, buf, opts);
      if (v.ok || v.reason !== 'arrivals' || scratchRealArrivals(v.arrivals).length) return v;
      return validateScratchCut(mark, buf, { ...opts, replay: true });
    }

    _scratchPruneBaks(dir, keep) {
      const cutoff = Date.now() - SCRATCH_BAK_TTL_MS;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (!n.endsWith('.bak')) continue;
        const p = path.join(dir, n);
        if (p === keep) continue;
        try {
          if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
        } catch {}
      }
    }

    _scratchAckedIn(records, mark) {
      const needle = SCRATCH_ACK_PREFIX + mark.nonce;
      return records.some((e) => e.offset >= mark.sizeAtBegin && e.type === 'user'
        && typeof (e.record.message || {}).content === 'string'
        && e.record.message.content.startsWith(needle));
    }

    _scratchCarryMarks(session, fresh, mark, cutOffset, kept) {
      const carried = new Map();
      for (const m of this._scratchOpenMarks(session)) {
        if (m === mark) continue;
        const why = m.sizeAtBegin >= cutOffset ? 'younger than the cut'
          : (this._scratchAckedIn(kept, m) ? null : 'its ack is not below the cut');
        if (why) {
          if (m._closeTimer) clearTimeout(m._closeTimer);
          log.info('intent', `scratch ${session.name}: mark ${m.nonce}${m.label ? ` (${m.label})` : ''} dropped — ${why}`);
          continue;
        }
        if (m.label) carried.set(m.label, m);
        else if (mark.label) fresh._scratch = m;
      }
      fresh._scratchMarks = carried;
    }

    _scratchReArm(fresh, mark, closing, cutOffset, quiet, kept, endedAt) {
      const tail = quiet.subarray(Math.max(0, cutOffset - SCRATCH_MARK_TAIL), cutOffset);
      const notes = [...(mark.notes || [])];
      if (closing.body) notes.push({ at: endedAt, body: closing.body });
      const mark2 = {
        ...mark,
        nonce: scratchNonce(),
        sizeAtBegin: cutOffset,
        tailBytes: Buffer.from(tail),
        beganAt: Date.now(),
        arrivals: [],
        dispatched: [],
        usageAtBegin: this._scratchUsageAt(kept),
        closing: null,
        _closeTimer: null,
        notes,
      };
      this._scratchMarksOf(fresh).set(mark.label, mark2);
      try {
        this._injectText(fresh, scratchReArmLine(mark2));
      } catch (e) {
        log.warn('intent', `scratch ${fresh.name}: the re-arm ack for ${mark.label} failed: ${e.message}`);
      }
      log.info('intent', `scratch ${fresh.name}: mark ${mark2.nonce} (${mark.label}) re-armed at ${cutOffset} (was ${mark.nonce})`);
      return mark2;
    }

    _replayScratchArrivals(session, mark, closing, arrivals) {
      if (!closing.replay) return 0;
      let n = 0;
      for (const a of scratchRealArrivals(arrivals)) {
        try {
          this._injectText(session, scratchReplayLine(mark, a));
          n++;
        } catch (e) {
          log.warn('intent', `scratch ${session.name}: replaying an arrival failed: ${e.message}`);
        }
      }
      if (n) log.info('intent', `scratch ${session.name}: replayed ${n} arrival(s) after the summary`);
      return n;
    }

    _scratchRestore(mark, bak) {
      if (!bak) return false;
      try {
        if (!fs.existsSync(bak)) return false;
        fs.copyFileSync(bak, mark.realpath);
        return true;
      } catch (e) {
        log.error('intent', `scratch: restoring ${mark.realpath} from ${bak} failed: ${e.message}`);
        return false;
      }
    }

    async _scratchRespawnSafely(session, entry, mark, bak, { keepMark = false } = {}) {
      const name = session.name;
      this._scratchRestore(mark, bak);
      try {
        const fresh = await this._scratchRespawn(name, entry);
        if (fresh) {
          mark.closing = null;
          const named = new Map();
          for (const m of this._scratchOpenMarks(session)) {
            if (m === mark && !keepMark) continue;
            if (m.label) named.set(m.label, m);
            else fresh._scratch = m;
          }
          fresh._scratchMarks = named;
        }
        return fresh;
      } catch (err) {
        log.error('intent', `scratch ${name}: respawn after an abandoned cut failed: ${err.message}`);
        getPersistence().upsert(this._stripClaimedTree(entry));
        return null;
      }
    }

    _voidScratchMark(session, tail, { notify = true } = {}) {
      const marks = this._scratchOpenMarks(session);
      if (!marks.length) return;
      for (const mark of marks) {
        if (mark._closeTimer) clearTimeout(mark._closeTimer);
        log.info('intent', `scratch ${session.name}: mark ${mark.nonce}${mark.label ? ` (${mark.label})` : ''} voided`);
      }
      session._scratch = null;
      session._scratchMarks = new Map();
      session._scratchVoid = tail;
      if (!notify) return;
      try { this._injectText(session, `[agent:scratch] ${tail}`, { parkable: true }); } catch {}
    }

    _scratchTicketIds(session) {
      try {
        let team = null;
        try { team = resolveTeam(session.cwd); } catch { team = null; }
        if (!team) team = this._soloContext(session);
        if (!team || !team.root) return new Set();
        return new Set((ticketsStore.load(team.root) || []).map((t) => t && t.id).filter(Boolean));
      } catch { return new Set(); }
    }

    _scratchDispatchToken(session, intent, beforeIds) {
      switch (intent.type) {
        case 'task': {
          if (intent.sub === 'list') return null;
          if (intent.sub !== 'add') return intent.id || null;
          const fresh = [...this._scratchTicketIds(session)].filter((id) => !beforeIds.has(id));
          return fresh.length === 1 ? fresh[0] : null;
        }
        case 'spawn': return intent.name || null;
        case 'team-create': return intent.name || null;
        case 'team': return intent.name || intent.stem || null;
        case 'team-review':
        case 'review-done': return session.reviewTicket || null;
        default: return null;
      }
    }

    _recordScratchDispatch(session, intent, beforeIds) {
      const marks = this._scratchOpenMarks(session);
      if (!marks.length) return;
      const token = this._scratchDispatchToken(session, intent, beforeIds);
      if (!token) return;
      const entry = { type: intent.type, sub: intent.sub || null, token, at: Date.now() };
      for (const mark of marks) mark.dispatched.push(entry);
    }

    _executeCompact(session, cmd, continuation) {
      session._compactContinuation = continuation;
      if (session.sentinel) session.sentinel.armCompact(() => this._fireCompactContinuation(session));
      const wire = cmd && typeof cmd === 'object';
      if (wire) this._streamEnqueue(session, { text: '', images: [], origin: 'system', wire: cmd });
      else this._injectText(session, cmd, { bypassHold: true });
      this._armCompactGuard(session);
      this._armCompactValve(session);
      const shown = wire ? cmd.method : cmd;
      log.info('intent', `compact ${session.name} → ${shown}`);
      this._broadcast('ipc-message', {
        type: 'context', from: session.name, to: session.name, body: `context compact → ${shown}`,
      });
    }

    _maybeFireCompactLatch(session) {
      try {
        if (!session || session._dead) return;
        const pending = session._compactPending;
        const holdQueueLen = session._injectQueue ? session._injectQueue.length : 0;
        const ptyQueueLen = session._injectPtyQueue ? session._injectPtyQueue.length : 0;
        if (!canFireCompact({ pending, holdQueueLen, ptyQueueLen })) return;
        session._compactPending = null;
        this._executeCompact(session, pending.cmd, pending.continuation);
      } catch (e) {
        this._shadowLog({ type: 'compact-latch-fire-error', agent: session && session.name, error: e.message });
      }
    }

    async _injectReloadHandoff(session, handoff, timeoutMs = 30000, why = 'reload') {
      await this._injectAfterBoot(session, handoff, {
        logPrefix: `[agent:context ${why}]`,
        dropBody: `context ${why} → handoff NOT injected (fresh CLI never signaled boot)`,
        timeoutMs,
      });
    }

    // Gate on the transcript symlink via readlinkSync, not session.sessionId: Claude creates the transcript
    // only on the first user turn, so gating turn-one injection on sessionId deadlocks until the timeout.
    async _injectAfterBoot(session, text, opts = {}) {
      const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000;
      const linkPath = pathFor(REGISTRY_DIR, session.name, 'transcript');
      const start = Date.now();
      for (;;) {
        if (session._dead) return false;
        try { fs.readlinkSync(linkPath); break; } catch {}
        if (Date.now() - start > timeoutMs) {
          console.error(`${opts.logPrefix || '[agent:inject]'} ${session.name}: fresh CLI never signaled boot (no transcript symlink); handoff not injected`);
          this._broadcast('ipc-message', {
            type: 'context', from: session.name, to: session.name,
            body: opts.dropBody || 'handoff NOT injected (fresh CLI never signaled boot)',
          });
          return false;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, RELOAD_CONTINUATION_DELAY));
      if (session._dead) return false;
      this._injectText(session, this._handoffText(session, text, { snapshot: opts.snapshot !== false }));
      return true;
    }

    _resumeSnapshot(session, now = Date.now()) {
      const head = [`State at resume (generated by Clodex, ${new Date(now).toISOString()}; not the author's words):`];
      let root = null;
      try { root = this._projectRootFor(session && session.cwd); } catch { root = null; }
      let log = null;
      try {
        if (root && gitWorktree && typeof gitWorktree.headLogSync === 'function') log = gitWorktree.headLogSync(root);
      } catch { log = null; }
      let team = null;
      try { team = resolveTeam(session && session.cwd); } catch { team = null; }
      let trunk = null;
      try {
        if (log && typeof gitWorktree.mergeTargetForSync === 'function') trunk = gitWorktree.mergeTargetForSync({ root, trunk: team && team.trunk });
      } catch { trunk = null; }
      head.push(log
        ? `host ${appVersion || 'unknown'}; ${trunk || 'HEAD'} ${log.sha} "${log.subject}" (${root})`
        : `host ${appVersion || 'unknown'}; git: unavailable`);
      let board = '';
      if (team) {
        const role = matchSeatRole(team, session.name) || 'none';
        const seats = this._teamLiveSeats(team.root)
          .map((s) => `${s.name}${s.label ? ` (${s.label})` : ''}`);
        head.push(`team ${team.name}, role ${role}: ${seats.length ? seats.join(', ') : '(no live seats)'}`);
        try { board = this._taskListText(team, 'open', now) || ''; } catch { board = ''; }
      }
      return capResumeSnapshot(`---\n${head.join('\n')}`, board);
    }

    _handoffText(session, body, opts = {}) {
      const text = String(body == null ? '' : body);
      if (!session || session.agentType !== 'claude') return text;
      if (Buffer.byteLength(text, 'utf8') <= SPILL_MIN_BYTES) return text;
      let spilled = text;
      if (opts.snapshot !== false) {
        try { spilled = `${text}\n\n${this._resumeSnapshot(session)}\n`; } catch { spilled = text; }
      }
      const id = writeSpill(REGISTRY_DIR, session.name, spilled);
      if (!id) {
        log.warn('intent', `handoff spill for ${session.name} failed — typing the body`);
        return text;
      }
      const filePath = spillPathFor(REGISTRY_DIR, session.name, id);
      this._noteFiled(session.name, filedEntry(filePath, 'handoff', 'handoff'));
      return `Continue from your handoff: @${filePath} `;
    }

    _seedFiledRing(name) {
      const ring = createFiledRing();
      const spillDir = spillDirFor(REGISTRY_DIR, name);
      try {
        seedFiledRing(ring, [
          { dir: spillDir, kind: 'intent' },
          { dir: path.join(MSG_DIR, name), kind: 'message' },
          { dir: spillDir && nodePath.join(spillDir, 'messages'), kind: 'message', mapPath: (p) => literalMessagePathOf(p, nodePath) || p },
        ]);
      } catch (e) {
        log.warn('files', `filed seed for ${name} failed: ${e.message}`);
      }
      return ring;
    }

    _keptMessagePath(filePath) {
      const durable = typeof filePath === 'string' ? durableMessageCopyOf(filePath, nodePath) : null;
      return durable && fs.existsSync(durable) ? durable : filePath;
    }

    _noteFiled(name, entry) {
      const s = this.sessions.get(name);
      if (s && s.filedRing) s.filedRing.note(entry);
      if (getRemoteServer()) { try { getRemoteServer().notifyFiled(name); } catch {} }
    }


    _gatedDeliver(targetName, senderTag, body, urgent, tag = '', onWrite = null, opts = {}) {
      const target = this.sessions.get(targetName);
      if (!target || !target.agentType) return { error: `no such agent "${targetName}"` };
      const key = dmContentKey(senderTag, body);
      const verdict = shouldHoldDm({
        urgent: urgent === true,
        state: target.activityState || 'idle',
        idleMs: Date.now() - (target.activityTs || Date.now()),
        payload: this._proxyPoller ? this._proxyPoller.snapshot(targetName) : null,
        attention: target.needsAttention ? target.needsAttention.kind : null,
      });
      if (verdict.hold) {
        const canPark = adapterFor(target.agentType)?.caps.park === true && !target._dead;
        let parkBody = null;
        if (canPark && opts && typeof opts.rebody === 'function') {
          try { parkBody = opts.rebody('parked'); } catch { parkBody = null; }
        }
        const parkId = canPark
          ? this._parkHeldDelivery(target, this._buildDeliveryText(target, senderTag,
            typeof parkBody === 'string' && parkBody ? parkBody : body, 'dm', tag), key)
          : null;
        // onWrite fires for a park but never for a bare hold, and passes 'parked' explicitly:
        // an argument-less call reads as 'injected' to a caller confirming a write.
        if (parkId && typeof onWrite === 'function') { try { onWrite('parked'); } catch {} }
        return parkId
          ? { parked: parkId, reason: verdict.reason, noUrgent: verdict.noUrgent }
          : { held: verdict.reason, noUrgent: verdict.noUrgent };
      }
      const superseded = urgent === true ? claimParkedByKey(PENDING_DIR, targetName, key) : null;
      if (opts && opts.parkBehindQueue === true && this._parkBehindQueue(target, senderTag, body, tag, key)) {
        if (typeof onWrite === 'function') { try { onWrite('parked'); } catch {} }
        return superseded && superseded.claimed > 0 ? { queued: true, superseded } : { queued: true };
      }
      this._deliverMessage(targetName, senderTag, body, 'dm', tag, onWrite, key, null,
        opts && typeof opts.rebody === 'function' ? opts.rebody : null);
      return superseded && superseded.claimed > 0 ? { queued: true, superseded } : { queued: true };
    }

    _armDmConfirm(targetName, senderName, disposition) {
      const s = this.sessions.get(targetName);
      if (!s || !s.agentType || s._dead) return;
      // Only an injected unit is confirmable: a park is drained out-of-process, so no activity
      // edge follows it and the latch would never clear.
      if (disposition !== 'injected') return;
      if (s.activityState !== 'idle') return;
      const fifo = s._dmUnconfirmed || (s._dmUnconfirmed = []);
      // Stored raw: -1 (unreadable transcript) must not become 0, or didGrow would read the
      // seat's first written byte as growth.
      fifo.push({ sender: senderName, at: Date.now(), since: this._seatTranscriptSize(targetName) });
      while (fifo.length > DM_LATCH_CAP) this._overflowDmEntry(s, fifo.shift());
      if (!s._dmConfirmTimer) this._armDmConfirmTimer(s);
    }

    // A dropped unit is coalesced into one record per sender rather than discarded: discarding
    // it would mute the very sender whose message was starved out.
    _overflowDmEntry(session, gone) {
      const ov = session._dmOverflow || (session._dmOverflow = new Map());
      const rec = ov.get(gone.sender);
      if (rec) { rec.count += 1; rec.at = Math.min(rec.at, gone.at); }
      else ov.set(gone.sender, { count: 1, at: gone.at });
    }

    _armDmConfirmTimer(session, delayMs = SPEC_CONFIRM_MS) {
      clearTimeout(session._dmConfirmTimer);
      session._dmConfirmTimer = setTimeout(() => {
        session._dmConfirmTimer = null;
        // A throw out of this timer callback is an unhandled exception in the host process, so
        // the check stays guarded.
        try { this._checkDmConfirm(session); }
        catch (e) {
          log.error('intent', `dm confirmation check failed for ${session.name}: ${e.message}`);
          // The throw skipped every re-arm inside the check; without this a surviving fifo goes
          // unwatched until some later push.
          if (session._dmUnconfirmed && session._dmUnconfirmed.length && !session._dmConfirmTimer) {
            this._armDmConfirmTimer(session);
          }
        }
      }, delayMs);
      if (session._dmConfirmTimer.unref) session._dmConfirmTimer.unref();
    }

    // Clears _dmUnconfirmedLast too: it attributes a seat's silence, and a seat that took a
    // turn is not silent.
    _clearDmConfirm(session) {
      session._dmUnconfirmed = [];
      session._dmOverflow = null;
      session._dmUnconfirmedLast = null;
      clearTimeout(session._dmConfirmTimer);
      session._dmConfirmTimer = null;
    }

    _checkDmConfirm(session) {
      const fifo = session._dmUnconfirmed;
      if (!fifo || !fifo.length || session._dead) return;
      // A dialog is an unbounded wait: re-arm without a cap rather than clear, since the dm may
      // still be unread behind it.
      if (session.needsAttention && session.needsAttention.kind === 'permission') {
        this._armDmConfirmTimer(session);
        return;
      }
      const now = Date.now();
      // Drain only ripe units. An empty ripe set (the cap shifted out the pegged entry) must
      // re-arm, not return, or an overflowing seat goes permanently silent.
      const ripe = [];
      while (fifo.length && now - fifo[0].at >= SPEC_CONFIRM_MS) ripe.push(fifo.shift());
      if (!ripe.length) {
        this._armDmConfirmTimer(session, Math.max(0, SPEC_CONFIRM_MS - (now - fifo[0].at)));
        return;
      }
      const anchor = Math.max(...ripe.map((e) => (typeof e.since === 'number' ? e.since : -1)));
      if (didGrow(anchor, this._seatTranscriptSize(session.name))) {
        log.info('intent', `dm confirmation for ${session.name} withdrawn — its transcript grew past ${anchor} bytes since the write, so the seat consumed input and the activity edge was simply missed`);
        // Growth refutes the silence, so drop both residues: a stale _dmUnconfirmedLast would have
        // the stall sweep blame a swallowed dm for a seat that was read.
        session._dmOverflow = null;
        session._dmUnconfirmedLast = null;
        if (fifo.length) this._armDmConfirmTimer(session, Math.max(0, SPEC_CONFIRM_MS - (now - fifo[0].at)));
        return;
      }
      const overflow = session._dmOverflow
        ? [...session._dmOverflow].map(([sender, r]) => ({ sender, count: r.count, at: r.at }))
        : [];
      const dropped = overflow.reduce((n, r) => n + r.count, 0);
      session._dmOverflow = null;
      const entries = ripe.slice();
      const total = entries.length + dropped;
      const oldest = Math.min(entries[0].at, ...overflow.map((r) => r.at));
      const ageS = Math.round((now - oldest) / 1000);
      if (fifo.length) this._armDmConfirmTimer(session, Math.max(0, SPEC_CONFIRM_MS - (now - fifo[0].at)));
      // Accumulates across reports: replacing would shrink the stall sweep's evidence to the
      // last window during a sustained wedge.
      const prev = session._dmUnconfirmedLast;
      session._dmUnconfirmedLast = {
        entries: prev ? [...prev.entries, ...entries] : entries,
        dropped: (prev ? prev.dropped || 0 : 0) + dropped,
        at: prev ? Math.min(prev.at, oldest) : oldest,
        firedAt: now,
      };

      const senders = [...new Set([...entries.map((e) => e.sender), ...overflow.map((r) => r.sender)])];
      log.warn('intent', `${total} dm${total === 1 ? '' : 's'} written to ${session.name} but no turn started after ${ageS}s — telling ${senders.join(', ')}; nothing re-sent`);
      // Broadcast first and outside the per-sender loop: the notices travel by the channel whose
      // reliability is in question, so the report must not depend on it.
      this._broadcast('ipc-message', {
        ts: Date.now(), from: 'clodex', to: session.name, kind: 'dm-unconfirmed',
        body: `${total} dm${total === 1 ? '' : 's'} to ${session.name} (from ${senders.join(', ')}) written but no turn started after ${ageS}s — nothing was re-sent`,
      });

      for (const who of senders) {
        const sender = this.sessions.get(who);
        if (!sender || !sender.agentType || sender._dead) continue;
        // Count this sender's dropped units too: a sender whose only message the cap shifted out
        // would otherwise get an empty share and be told nothing.
        const ovMine = overflow.find((r) => r.sender === who);
        const mineCount = entries.filter((e) => e.sender === who).length + (ovMine ? ovMine.count : 0);
        const mineAt = Math.min(
          ...entries.filter((e) => e.sender === who).map((e) => e.at),
          ...(ovMine ? [ovMine.at] : []),
        );
        const mineAgeS = Math.round((Date.now() - mineAt) / 1000);
        // Hedge on the total outstanding, not this sender's share: another sender's concurrent
        // write may have overwritten this draft.
        const one = mineCount === 1;
        const noun = one ? 'your message' : `your ${mineCount} messages`;
        const verb = one ? 'was' : 'were';
        const when = one ? `${mineAgeS}s ago` : `(oldest ${mineAgeS}s ago)`;
        const hedge = total === 1
          ? 'it may have been swallowed before it was read'
          : `${one ? 'it' : 'they'} may not have been seen`;
        const ambiguity = total === 1 ? ''
          : ` ${total} messages were outstanding at that seat and concurrent writes overwrite one another's unsubmitted text, so which of them landed cannot be told from here.`;
        this._injectText(sender,
          `[agent:dm] ${noun} to ${session.name} ${verb} written into its terminal ${when} and ${session.name} `
          + `has not started a turn since — ${hedge}.${ambiguity} NOTHING was re-sent, and nothing will be. `
          + `If it matters, resend it yourself: \`[agent:dm ${session.name} urgent] <message>\` lands immediately. `
          + `(A seat that displayed the message and simply stayed idle looks the same from here, so this can be a false alarm.)`,
          { parkable: true });
      }
    }

    _dmLatchEvidence(seatName) {
      const s = this.sessions.get(seatName);
      if (!s) return null;
      const last = (s._dmUnconfirmedLast && s._dmUnconfirmedLast.entries) || [];
      const live = s._dmUnconfirmed || [];
      // Cap-dropped units count here as in the broadcast total, so the sweep clause and the
      // broadcast report the same number.
      const dropped = ((s._dmUnconfirmedLast && s._dmUnconfirmedLast.dropped) || 0)
        + (s._dmOverflow ? [...s._dmOverflow.values()].reduce((n, r) => n + r.count, 0) : 0);
      const all = [...last, ...live];
      const count = all.length + dropped;
      if (!count) return null;
      const at = Math.min(...all.map((e) => e.at),
        ...(s._dmOverflow ? [...s._dmOverflow.values()].map((r) => r.at) : []),
        ...(s._dmUnconfirmedLast ? [s._dmUnconfirmedLast.at] : []));
      return { count, at };
    }

    _setRelayRoster(via, roster) {
      if (!via) return;
      this._relayRosters.set(via, { roster: Array.isArray(roster) ? roster : [], at: Date.now() });
    }

    _relayRosterEntries() {
      const now = Date.now();
      const out = [];
      for (const [via, rec] of this._relayRosters) {
        if (now - rec.at > RELAY_ROSTER_TTL_MS) { this._relayRosters.delete(via); continue; }
        for (const e of rec.roster) out.push({ name: e.name, origin: e.origin, via, type: e.type });
      }
      return out;
    }

    _relayViaForOrigin(origin) {
      const now = Date.now();
      for (const [via, rec] of this._relayRosters) {
        if (now - rec.at > RELAY_ROSTER_TTL_MS) { this._relayRosters.delete(via); continue; }
        if (via === origin) continue;
        if (rec.roster.some((e) => e.origin === origin)) return via;
      }
      return null;
    }

    _routeFederatedDm(session, senderName, intent) {
      const at = intent.target.indexOf('@');
      const name = intent.target.slice(0, at);
      const origin = intent.target.slice(at + 1);
      const bounce = (msg) => { if (session) this._injectText(session, `[agent:dm] ${msg}`, { parkable: true }); };
      if (!AGENT_NAME_RE.test(name) || !AGENT_NAME_RE.test(origin)) {
        bounce(`can't route "${intent.target}" — a federated target is name@peer, both plain names.`);
        return;
      }
      const peers = getPeerManager() ? getPeerManager().statuses() : [];
      const match = findPeerByOrigin(peers, origin);
      if (match) {
        if (!match.online) { bounce(`peer '${origin}' is offline — try again when it's awake.`); return; }
        if (!(match.caps || []).includes('dm')) { bounce(`peer '${origin}' predates dm federation — update its Clodex.`); return; }
        const conn = getPeerManager().get(match.id);
        if (!conn) { bounce(`peer '${origin}' is not reachable right now.`); return; }
        conn.dm({ to: name, from: senderName, body: intent.body, urgent: intent.urgent === true }, (resp) => {
          if (resp && resp.ok && resp.delivered) {
          } else if (resp && resp.ok && resp.parked) {
            if (session) this._injectText(session,
              `[agent:dm] parked on ${origin} for ${name} — it'll be delivered with ${name}'s next turn. If it can't wait, resend as \`[agent:dm ${intent.target} urgent] <message>\`.`,
              { parkable: true });
          } else {
            const why = (resp && resp.error) || 'delivery failed';
            bounce(`NOT delivered to ${intent.target}: ${why}`);
          }
        });
        this._broadcast('ipc-message', { type: 'dm', from: senderName, to: `${name}@${origin}`, body: `WIRE→${origin}: ${intent.body}` });
        return;
      }
      if (this._knownDmOrigins.has(origin) || outboxKnowsOrigin(OUTBOX_DIR, origin)) {
        const r = enqueueOutbox(OUTBOX_DIR, origin,
          { from: senderName, to: name, body: intent.body, urgent: intent.urgent === true, ts: Date.now() },
          this._nextParkSeq());
        if (!r.ok) { bounce(`could not queue for ${intent.target}: ${r.error}`); return; }
        if (getRemoteServer()) { try { getRemoteServer().notifyDmMail(origin); } catch {} }
        this._broadcast('ipc-message', { type: 'dm', from: senderName, to: `${name}@${origin}`, body: `WIRE→${origin} (outbox): ${intent.body}` });
        return;
      }
      const via = this._relayViaForOrigin(origin);
      if (via) {
        const qualifiedFrom = `${senderName}@${SELF_LABEL}`;
        const env = buildRelayEnvelope({
          to: name, finalTarget: intent.target, from: qualifiedFrom, origin: via,
          body: intent.body, urgent: intent.urgent === true,
        });
        const r = enqueueOutbox(OUTBOX_DIR, via, { ...env, ts: Date.now() }, this._nextParkSeq());
        if (!r.ok) { bounce(`could not relay to ${intent.target} via ${via}: ${r.error}`); return; }
        if (getRemoteServer()) { try { getRemoteServer().notifyDmMail(via); } catch {} }
        if (session) this._injectText(session,
          `[agent:dm] relayed via ${via} → ${intent.target} (best-effort; no delivery receipt${intent.urgent ? '' : ', held for a warm/active recipient'}).`,
          { parkable: true });
        this._broadcast('ipc-message', { type: 'dm', from: qualifiedFrom, to: intent.target, body: `WIRE→${via} (relay→${intent.target}): ${intent.body}` });
        return;
      }
      bounce(`no route to '${intent.target}' — peer '${origin}' is not configured, has never contacted this box, and no hub advertises it.`);
    }

    _deliverClaimedDms(peerId, messages) {
      const cfg = (getUiSettings().get().peers || []).find((p) => p && p.id === peerId);
      const peerLabel = (cfg && cfg.label) || String(peerId);
      const st = (getPeerManager() ? getPeerManager().statuses() : []).find((p) => p && p.id === peerId);
      const origin = (st && peerOriginSuffix(st, AGENT_NAME_RE))
        || peerOriginSuffix({ label: peerLabel, id: peerId }, AGENT_NAME_RE)
        || String(peerId);
      for (const m of (Array.isArray(messages) ? messages : [])) {
        if (!m || typeof m.to !== 'string') continue;
        if (isRelayEnvelope(m)) { this._relayClaimedDm(peerId, peerLabel, cfg, m, origin); continue; }
        const senderTag = `${m.from || 'peer'}@${origin}`;
        const local = this.sessions.get(m.to);
        if (!local || !local.agentType) {
          this._broadcast('ipc-message', { type: 'dm', from: senderTag, to: m.to, body: `WIRE←${peerLabel} DROPPED (no local agent "${m.to}"): ${m.body || ''}` });
          log.info('peer', `claimed dm from ${senderTag} dropped — no local agent "${m.to}"`);
          continue;
        }
        this._gatedDeliver(m.to, senderTag, m.body || '', m.urgent === true);
        this._broadcast('ipc-message', { type: 'dm', from: senderTag, to: m.to, body: `WIRE←${peerLabel}: ${m.body || ''}` });
      }
    }

    _deliverClaimedInbox(peerId, notes) {
      const store = getNotifications && getNotifications();
      if (!store) return;
      const st = (getPeerManager() ? getPeerManager().statuses() : []).find((p) => p && p.id === peerId);
      const origin = (st && peerOriginSuffix(st, AGENT_NAME_RE)) || String(peerId);
      const ordered = (Array.isArray(notes) ? notes : [])
        .map((n, i) => ({ n, i }))
        .sort((a, b) => ((a.n && a.n.createdAt) || 0) - ((b.n && b.n.createdAt) || 0) || b.i - a.i)
        .map((e) => e.n);
      for (const note of ordered) {
        if (!note || typeof note.body !== 'string') continue;
        const from = `${note.from || 'peer'}@${origin}`;
        let rec;
        try {
          rec = store.add({ from, workspaceId: null, body: note.body });
        } catch (e) {
          log.error('peer', `claimed note from ${from} NOT stored: ${(e && e.message) || e}`);
          continue;
        }
        this._raiseNote(from, note.body);
        log.info('peer', `claimed note from ${from}: ${rec.id}`);
      }
    }

    _relayClaimedDm(srcId, srcLabel, srcCfg, m, srcOrigin) {
      const drop = (why) => {
        log.info('peer', `relay from ${srcLabel} → ${m.finalTarget} dropped: ${why}`);
        this._broadcast('ipc-message', { type: 'dm', from: m.from || srcLabel, to: m.finalTarget, body: `WIRE relay DROPPED (${why}): ${m.body || ''}` });
      };
      if (!relayVersionOk(m.rv)) return drop('unsupported relay version');
      const hop = hopRule(m.hops);
      if (!hop.relay) return drop('hop budget exhausted');
      const at = String(m.finalTarget || '').indexOf('@');
      if (at <= 0) return drop('malformed finalTarget');
      const destName = m.finalTarget.slice(0, at);
      const destOrigin = m.finalTarget.slice(at + 1);
      const peers = getUiSettings().get().peers || [];
      const destCfg = findPeerByOrigin(peers, destOrigin);
      const srcAllowed = !!(srcCfg && srcCfg.relayAllowed);
      const destAllowed = !!(destCfg && destCfg.relayAllowed);
      if (!srcAllowed || !destAllowed) {
        this._bounceRelaySender(srcId, m, `relay to ${m.finalTarget} not permitted (peer not relay-enabled)`);
        return drop('relay not permitted (relayAllowed gate)');
      }
      const dest = findPeerByOrigin(getPeerManager() ? getPeerManager().statuses() : [], destOrigin);
      if (!dest || !dest.online) return drop(`destination peer '${destOrigin}' offline`);
      if (!(dest.caps || []).includes('dm')) return drop(`destination peer '${destOrigin}' predates dm federation`);
      const conn = getPeerManager().get(dest.id);
      if (!conn) return drop(`destination peer '${destOrigin}' not reachable`);
      const fromAt = String(m.from || '').indexOf('@');
      const senderLocal = fromAt > 0 ? String(m.from).slice(0, fromAt) : String(m.from || '');
      const relayFrom = `${senderLocal || 'peer'}@${srcOrigin || peerOriginSuffix({ label: srcLabel, id: srcId }, AGENT_NAME_RE) || String(srcId)}`;
      conn.dm(buildTerminalDm({ to: destName, from: relayFrom, body: m.body || '', urgent: m.urgent === true }), (resp) => {
        if (!(resp && resp.ok)) log.info('peer', `relay → ${m.finalTarget} not delivered: ${(resp && resp.error) || 'no response'}`);
      });
      this._broadcast('ipc-message', { type: 'dm', from: relayFrom, to: m.finalTarget, body: `WIRE relay ${srcLabel}→${destOrigin}: ${m.body || ''}` });
    }

    _bounceRelaySender(srcId, m, why) {
      const conn = getPeerManager() ? getPeerManager().get(srcId) : null;
      if (!conn) return;
      const from = String(m.from || '');
      const at = from.indexOf('@');
      const senderLocal = at > 0 ? from.slice(0, at) : from;
      if (!senderLocal) return;
      try { conn.dm({ to: senderLocal, from: 'relay', body: `NOT delivered to ${m.finalTarget}: ${why}.`, urgent: false }, () => {}); } catch {}
    }

    _rememberDmOrigin(origin) {
      if (this._knownDmOrigins.has(origin)) return;
      this._knownDmOrigins.add(origin);
      markOutboxOrigin(OUTBOX_DIR, origin);
    }

    _isDmReachable(senderName) {
      if (!senderName) return false;
      const at = senderName.lastIndexOf('@');
      if (at > 0) {
        const origin = senderName.slice(at + 1);
        const peers = getPeerManager() ? getPeerManager().statuses() : [];
        const hit = findPeerByOrigin(peers.filter((p) => p && p.online), origin);
        if (hit) return true;
        if (this._knownDmOrigins.has(origin) || outboxKnowsOrigin(OUTBOX_DIR, origin)) return true;
        return this._relayViaForOrigin(origin) != null;
      }
      const s = this.sessions.get(senderName);
      return !!(s && s.agentType && !s._dead);
    }

    _buildDeliveryText(target, senderName, body, mtype, tag = '') {
      const prefix = `[agent:from ${senderName}]`;

      // The marker is parenthesized and never at column 1 so IntentScanner cannot read it as an
      // intent; system senders are excluded first because nothing answers them.
      const answerable = mtype === 'dm' && !SYSTEM_SENDERS.has(senderName);
      const trailer = (!answerable
          || (intentEnabled('dm', getPersistence().get(target.name)?.intents)
            && this._isDmReachable(senderName)))
        ? ''
        : '(no reply path)';

      const bytes = Buffer.byteLength(body);
      if (bytes > MSG_SPILL_THRESHOLD) {
        const filePath = spillToFile(senderName, body, target.name);
        this._noteFiled(target.name, filedEntry(filePath, 'message', `From: ${senderName}`));
        const marked = `${prefix}${tag ? ` ${tag}` : ''}`;
        // The trailing space after the path closes the @-autocomplete popup, so the deferred Enter
        // cannot select a different file.
        return target.agentType === 'claude'
          ? `${marked} Message (${bytes} bytes) attached: @${filePath} ${trailer}`
          : `${marked} Message (${bytes} bytes) saved to ${filePath} — read it with your Read tool.${trailer ? ' ' + trailer : ''}`;
      }
      const inline = senderName === 'user' && tag ? ` ${tag}` : '';
      return `${prefix}${inline} ${body}${trailer ? ' ' + trailer : ''}`;
    }

    _deliverMessage(targetName, senderName, body, mtype, tag = '', onWrite = null, parkKey = null, images = null, rebody = null) {
      const target = this.sessions.get(targetName);
      if (!target) return;
      if (this._refuseStreamInject(target, body, `${mtype || 'message'} from ${senderName}`)) return;
      const pics = Array.isArray(images) ? images : [];
      const fire = typeof onWrite === 'function' ? onWrite : null;
      const imageTail = target.io !== 'stream' && pics.length
        ? this._writeImageFiles(target.name, pics).map((p, i) => `\nImage #${i + 1}: ${p}`).join('')
        : '';
      let finalText = null;
      const plainText = () => {
        if (finalText === null) finalText = this._buildDeliveryText(target, senderName, body, mtype, tag) + imageTail;
        return finalText;
      };
      const textFor = (disposition) => {
        let b = null;
        if (rebody) { try { b = rebody(disposition); } catch { b = null; } }
        return typeof b === 'string' && b
          ? this._buildDeliveryText(target, senderName, b, mtype, tag) + imageTail
          : plainText();
      };
      if (target.io === 'stream') {
        this._streamEnqueue(target, { text: plainText(), images: pics, origin: senderName === 'user' ? 'operator' : 'system' },
          fire ? () => fire('injected') : null, null, parkKey);
      } else if (!this._maybeParkDelivery(target, () => textFor('parked'), parkKey)) {
        this._injectText(target, fire && rebody ? '' : plainText(), {
          parkable: true,
          parkKey,
          human: senderName === 'user',
          // A park via the fire-time divert is durable too; onDivert reports 'parked' so an observer
          // keying on consumption sees a file, not a write.
          ...(fire ? {
            produce: () => {
              try { fire('injected'); } catch {}
              return textFor('injected');
            },
            onDivert: (why) => { try { fire('parked', why); } catch {} },
          } : {}),
        });
      } else if (fire) {
        try { fire('parked'); } catch {}
      }
      this._sendToSession(targetName, 'session-mention', targetName, mtype, senderName);
    }

    _writeImageFiles(seatName, images) {
      const dir = path.join(MSG_DIR, seatName);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = this._imgStamp = Math.max(Date.now(), (this._imgStamp || 0) + 1);
      return images.map((img, i) => {
        const name = seatImageFileName(stamp, i + 1, img.mediaType);
        const file = path.join(dir, name);
        fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
        this._noteFiled(seatName, filedEntry(file, 'message', seatImageHead(name)));
        return file;
      });
    }

    _deliverReminder(agent, body) {
      const target = this.sessions.get(agent);
      if (target && target.agentType) {
        this._deliverMessage(agent, 'reminder', body, 'dm');
        return 'delivered';
      }
      const entry = getPersistence().get(agent);
      if (!entry) {
        log.info('intent', `remind fire for ${agent} dropped — no live session, no persisted entry`);
        return 'gone';
      }
      const finalText = this._buildDeliveryText({ name: agent, agentType: entry.type }, 'reminder', body, 'dm');
      try {
        parkDelivery(PENDING_DIR, agent, finalText, this._nextParkSeq(), null, false, this._bornFor(agent));
        log.info('intent', `remind fire for ${agent} parked (offline) — drains on resume`);
        return 'parked';
      } catch (e) {
        log.error('intent', `remind park for ${agent} failed: ${e.message}`);
        return 'error';
      }
    }

    _nextParkSeq() {
      return `${Date.now()}.${String(this._parkSeq = (this._parkSeq || 0) + 1).padStart(9, '0')}`;
    }

    // The persisted createdAt is the value create() hands the seat on restore, so an offline park's
    // stamp matches on arrival; null means no expectation, deliver rather than drop.
    _bornFor(name) {
      const s = this.sessions.get(name);
      if (s && typeof s.createdAt === 'number') return s.createdAt;
      try {
        const e = getPersistence().get(name);
        if (e && typeof e.createdAt === 'number') return e.createdAt;
      } catch {}
      return null;
    }

    _mintParkId() {
      for (let i = 0; i < 50; i++) {
        const id = randBase36(5);
        if (!parkIdInUse(PENDING_DIR, id)) return id;
      }
      return randBase36(10);
    }

    _parkHeldDelivery(target, finalText, key = null) {
      const id = this._mintParkId();
      try {
        parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq(), id, false, this._bornFor(target.name), key);
      } catch (e) {
        log.error('inject', `park-on-hold failed for ${target.name}: ${e.message}`);
        return null;
      }
      return id;
    }

    _parkBehindQueue(target, senderTag, body, tag, key = null) {
      if (!target || target.agentType !== 'claude' || target.io === 'stream' || target._dead) return false;
      if (!(target._injectPtyQueue && target._injectPtyQueue.length > 0) && !this._turnStartPending(target)) return false;
      try {
        parkDelivery(PENDING_DIR, target.name, this._buildDeliveryText(target, senderTag, body, 'dm', tag), this._nextParkSeq(), null, false, this._bornFor(target.name), key);
      } catch (e) {
        log.error('inject', `park-behind-queue failed for ${target.name}: ${e.message} — injecting instead`);
        return false;
      }
      this._armParkCap(target);
      this._sendToSession(target.name, 'session-mention', target.name, 'dm', senderTag);
      return true;
    }

    _maybeParkDelivery(target, finalText, key = null) {
      if (!target || target.agentType !== 'claude' || target._dead) return false;
      const typing = Date.now() - (target.lastUserInputTs || 0) < INJECT_QUIET_MS;
      const busy = target.activityState === 'thinking' || !!target._recycling;
      if (!typing && !busy) return false;
      try {
        const text = typeof finalText === 'function' ? finalText() : finalText;
        parkDelivery(PENDING_DIR, target.name, text, this._nextParkSeq(), null, false, this._bornFor(target.name), key);
      } catch (e) {
        log.error('inject', `park failed for ${target.name}: ${e.message} — injecting instead`);
        return false;
      }
      this._armParkCap(target);
      return true;
    }

    _armParkCap(target, delay = INJECT_QUIET_MAXWAIT) {
      if (target._parkCapTimer) return;
      target._parkCapTimer = setTimeout(() => {
        target._parkCapTimer = null;
        const oldest = typeof oldestActiveParkTs === 'function' ? oldestActiveParkTs(PENDING_DIR, target.name) : null;
        if (oldest === null && typeof oldestActiveParkTs === 'function' && countPending(PENDING_DIR, target.name) > 0) return;
        const left = oldest === null ? 0 : INJECT_QUIET_MAXWAIT - (Date.now() - oldest);
        if (left > 0) { this._armParkCap(target, Math.min(left, INJECT_QUIET_MAXWAIT)); return; }
        this._flushParkedNow(target, `cap.${process.pid}`, 'park-cap');
      }, delay);
    }

    _flushParkedNow(target, tag, kind = 'park-flush') {
      // Clear the notice's flush timer ahead of the count check: an empty mailbox means another drainer
      // took the notice, and a timer left armed would force a later unrelated park out early.
      if (target._rebootNoticeFlushTimer) { clearTimeout(target._rebootNoticeFlushTimer); target._rebootNoticeFlushTimer = null; }
      if (target._dead || target._recycling) return { ok: true, count: 0 };
      // The count is a non-destructive pre-count; the files are claimed late, inside the producer,
      // because drainPending deletes them.
      const count = countPending(PENDING_DIR, target.name);
      if (!count) {
        log.debug('inject', `${kind} for ${target.name} — nothing parked (already drained elsewhere)`);
        return { ok: true, count: 0 };
      }
      const plural = count === 1 ? 'y' : 'ies';
      const body = kind === 'park-cap'
        ? `park cap fired (${INJECT_QUIET_MAXWAIT / 1000}s, no submit) — injecting ${count} parked deliver${plural}`
        : `flushed ${count} parked deliver${plural} (operator)`;
      log.warn('inject', `${kind} for ${target.name} — draining ${count} parked deliver${plural} via queue`);
      this._broadcast('ipc-message', { ts: Date.now(), from: 'clodex', to: target.name, kind, body });
      this._injectText(target, '', {
        produce: () => {
          if (target._dead || target._recycling) return null;
          let texts = [];
          try { texts = drainPending(PENDING_DIR, target.name, tag, this._bornFor(target.name)); } catch { return null; }
          return texts.length ? texts.join('\n\n') : null;
        },
      });
      return { ok: true, count };
    }

    flushPending(name) {
      const target = this.sessions.get(name);
      if (!target || target.agentType !== 'claude' || target._dead) {
        return { ok: false, reason: 'no-such-agent' };
      }
      const hold = this._injectHoldReason(target);
      if (hold) {
        const count = countPending(PENDING_DIR, target.name);
        log.info('inject', `park-flush for ${target.name} held (${hold}) — ${count} parked entr${count === 1 ? 'y stays' : 'ies stay'} on disk`);
        return { ok: false, reason: hold === 'dialog' ? 'dialog-blocked' : hold, count };
      }
      const r = this._flushParkedNow(target, `flush.${process.pid}`, 'park-flush');
      if (target._parkCapTimer) { clearTimeout(target._parkCapTimer); target._parkCapTimer = null; }
      this._lastPendingCounts.delete(name);
      this._broadcast('pending-count', { name, count: 0 });
      return r;
    }

    _injectText(session, text, opts = {}) {
      if (session._dead) return;
      const produce = typeof opts.produce === 'function' ? opts.produce : null;
      if (session.io === 'stream') {
        this._streamEnqueueSystem(session, text, produce, 'inject', null, opts.parkKey || null);
        return;
      }
      if (!opts.bypassHold && this._injectHoldReason(session)) {
        const carry = opts.parkable || opts.human === true || typeof opts.onDivert === 'function';
        const entry = carry ? { ...(produce ? { produce } : { text }), opts } : (produce ? { produce } : text);
        (session._injectQueue = session._injectQueue || []).push(entry);
        this._armInjectValve(session);
        return;
      }
      const baseDivert = opts.parkable ? this._parkDivertFor(session, opts.parkId || null, opts.parkKey || null) : null;
      // The divert runs after produce, so a caller told 'injected' can still be parked; onDivert
      // lets it correct itself.
      const onDivert = typeof opts.onDivert === 'function' ? opts.onDivert : null;
      const divert = (baseDivert && onDivert)
        ? (t) => {
          const claimed = baseDivert(t);
          if (claimed) { try { onDivert(claimed); } catch {} }
          return claimed;
        }
        : baseDivert;
      const qopts = {};
      if (divert) qopts.divert = divert;
      if (produce) qopts.produce = produce;
      if (opts.human === true) qopts.human = true;
      this._injectQueueFor(session).enqueue(produce ? '' : text, Object.keys(qopts).length ? qopts : undefined);
    }

    // Typed and dictated drafts reach Clodex by different routes; consulting only isDraftOpen
    // treats a dictated draft as no draft.
    _anyDraftOpen(session) {
      try { return isDraftOpen(session) || this._voiceDraftOpen(session); } catch { return false; }
    }

    // The stamp expires on its own so the protection cannot outlive its release; the park cap
    // that bounds it afterwards reads no voice signal.
    _voiceDraftOpen(session) {
      return Date.now() - (session.lastVoiceDraftTs || 0) < INJECT_VOICE_DRAFT_STALE_MS;
    }

    _turnStartPending(session) {
      if (!session || session.agentType !== 'claude' || session.io === 'stream') return false;
      const since = session._awaitingTurnSince;
      return typeof since === 'number' && Date.now() - since < TURN_START_WINDOW_MS;
    }

    _parkDivertFor(session, id = null, key = null) {
      if (!session || session.agentType !== 'claude') return null;
      return (text) => {
        if (session._dead) return false;
        const churn = this._turnStartPending(session);
        if (!churn && !this._anyDraftOpen(session)) return false;
        try {
          parkDelivery(PENDING_DIR, session.name, text, this._nextParkSeq(), id, false, this._bornFor(session.name), key);
        } catch (e) {
          log.error('inject', `fire-time park failed for ${session.name}: ${e.message} — injecting instead`);
          return false;
        }
        this._armParkCap(session);
        const why = churn ? 'previous unit\'s turn not started yet' : isDraftOpen(session) ? 'draft open' : 'dictated draft open';
        log.info('inject', `diverted to park: ${why} (${session.name})`);
        return churn ? 'window' : 'draft';
      };
    }

    _injectQueueFor(session) {
      if (!session._injectPtyQueue) {
        // Claude seats wait for the mode-2004 edge plus BOOT_DRAIN_SETTLE_MS: text and Enter written before
        // the raw-mode input loop is up submit as one paste-like chunk. Codex must not be coupled to this gate.
        const isClaude = session.agentType === 'claude';
        session._injectPtyQueue = new InjectQueue({
          write: (bytes) => { if (!session.pty) return; if (!session.firstInputAt) session.firstInputAt = Date.now(); try { session.pty.write(bytes); } catch {} this._armBootNudge(session, bytes); },
          settleMsFor: (t) => (t.length > LONG_TEXT_THRESHOLD ? LONG_TEXT_DELAY : SHORT_TEXT_DELAY),
          quietMs: INJECT_QUIET_MS,
          maxWaitMs: INJECT_QUIET_MAXWAIT,
          lastHumanInputAt: () => session.lastUserInputTs || 0,
          hintHeld: () => { try { return !!(arm.holding && arm.holding(session.name)); } catch { return false; } },
          // Dictation is its own input, not a lastUserInputTs stamp, which has other readers. Absent evidence
          // reads as not speaking, opposite to recorderBlocksRearm: a deferral that cannot release wedges the seat.
          speaking: () => Date.now() - (session.lastVoiceRecordingTs || 0) < INJECT_SPEAKING_STALE_MS,
          isDead: () => !!(session._dead || session._recycling),
          onUndelivered: (t) => {
            try {
              const born = typeof session.createdAt === 'number' ? session.createdAt : null;
              parkDelivery(PENDING_DIR, session.name, t, this._nextParkSeq(), null, false, born, null);
              log.info('inject', `re-parked an undelivered inject for ${session.name} (${session._recycling ? 'recycling' : 'dead'}, ${t.length} chars)`);
            } catch (e) {
              log.error('inject', `re-park failed for ${session.name}: ${e.message} — ${t.length} chars dropped`);
            }
          },
          bracketedPaste: () => !!session._pasteModeOn,
          onSubmitted: (_t, meta) => {
            session.lastSubmitInjected = !(meta && meta.human);
            if (isClaude && session.activityState === 'idle') session._awaitingTurnSince = Date.now();
          },
          ready: isClaude ? () => !!session._bootReadySeen && Date.now() - (session._bootReadyAt || 0) >= BOOT_DRAIN_SETTLE_MS : undefined,
          readyMaxWaitMs: INJECT_BOOT_MAXWAIT,
          onReadyCapFire: isClaude ? () => {
            log.warn('inject', `boot-readiness cap fired for ${session.name} — injected before mode-2004 seen (${INJECT_BOOT_MAXWAIT / 1000}s cap)`);
          } : null,
          onCapFire: () => {
            log.warn('inject', `quiet-gate cap fired for ${session.name} — injected through active typing or dictation (${INJECT_QUIET_MAXWAIT / 1000}s cap)`);
            this._broadcast('ipc-message', {
              ts: Date.now(), from: 'clodex', to: session.name, kind: 'inject-cap',
              body: `inject quiet-gate cap fired (${INJECT_QUIET_MAXWAIT / 1000}s) — possible splice through a live draft`,
            });
          },
        });
      }
      return session._injectPtyQueue;
    }


    _onIncoming(targetName, msg) {
      const sender = msg.from || '?';
      const body = msg.body || '';
      const mtype = msg.type || 'dm';
      if (msg.delivery === 'passive') {
        this._deliverPassive(targetName, sender, body, mtype);
        return;
      }
      // voice-* are box-wide requests on whichever agent socket the sender could reach, so targetName is
      // not the seat they act on (msg.target or the focused seat is).
      if (mtype === 'voice-tap') {
        const r = this.voiceTap(typeof msg.target === 'string' ? msg.target : null);
        if (!r.ok) log.info('voice', `external tap declined: ${r.error}`);
        return;
      }
      if (mtype === 'voice-select') {
        const r = this.voiceSelect(typeof msg.target === 'string' ? msg.target : null);
        if (!r.ok) log.info('voice', `external select declined: ${r.error}`);
        return;
      }
      if (mtype === 'voice-mode') {
        const r = this.voiceMode(typeof msg.mode === 'string' ? msg.mode : null);
        if (!r.ok) log.info('voice', `external mode declined: ${r.error}`);
        return;
      }
      if (mtype === 'voice-speech') {
        const r = this.voiceSpeech(typeof msg.state === 'string' ? msg.state : null);
        if (!r.ok) log.info('voice', `external speech declined: ${r.error}`);
        return;
      }
      if (mtype === 'team-retire') {
        this._handleTeamRetire(targetName, sender).catch((e) => {
          // Also DM the requester: a main-process warn is invisible to a lead waiting on a confirmation
          // that never comes.
          log.warn('intent', `team-retire ${sender} → ${targetName} failed: ${e.message}`);
          this._deliverMessage(sender, 'clodex-team', `retire ${targetName} failed: ${e.message}`, 'dm');
        });
        return;
      }
      this._deliverMessage(targetName, sender, body, mtype);
    }

    _deliverPassive(targetName, senderName, body, mtype) {
      const target = this.sessions.get(targetName);
      if (!target) return;
      if (target.agentType !== 'claude' || target._dead) {
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      const finalText = this._buildDeliveryText(target, senderName, body, mtype);
      try {
        parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq(), null, true, this._bornFor(target.name));
      } catch (e) {
        log.error('inject', `passive park failed for ${target.name}: ${e.message} — delivering normally`);
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      this._broadcast('ipc-message', {
        ts: Date.now(), from: senderName, to: targetName, kind: 'passive',
        body: body.length > 200 ? `${body.slice(0, 200)}…` : body,
      });
    }

    _injectTextPassive(session, text) {
      if (!session || session._dead) return;
      if (session.agentType !== 'claude') {
        this._injectText(session, text, { parkable: true });
        return;
      }
      try {
        parkDelivery(PENDING_DIR, session.name, text, this._nextParkSeq(), null, true, this._bornFor(session.name));
      } catch (e) {
        log.error('inject', `passive park failed for ${session.name}: ${e.message} — delivering normally`);
        this._injectText(session, text, { parkable: true });
        return;
      }
      this._broadcast('ipc-message', {
        ts: Date.now(), from: 'clodex', to: session.name, kind: 'passive',
        body: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      });
    }

    // Parked as a non-.passive entry so hasActivePending sees it and the boot-ready edge drains it;
    // a passive park never earns a turn, and there is no spawn-time PTY write.
    _deliverParkedActive(targetName, senderName, body, mtype) {
      const target = this.sessions.get(targetName);
      if (!target) return;
      if (target.agentType !== 'claude' || target._dead) {
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      const finalText = this._buildDeliveryText(target, senderName, body, mtype);
      let parkedFile;
      try {
        parkedFile = parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq(), null, false, this._bornFor(target.name));
      } catch (e) {
        log.error('inject', `active park failed for ${target.name}: ${e.message} — delivering normally`);
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      this._armParkedDrainFallback(target, parkedFile, INJECT_BOOT_MAXWAIT, Date.now() + 3 * INJECT_BOOT_MAXWAIT);
      this._broadcast('ipc-message', {
        ts: Date.now(), from: senderName, to: targetName, kind: 'parked',
        body: body.length > 200 ? `${body.slice(0, 200)}…` : body,
      });
    }

    _armParkedDrainFallback(session, file, periodMs, deadline, drained = false) {
      if (!session || session.agentType !== 'claude') return;
      const armed = session._parkedDrainFallbackFiles || (session._parkedDrainFallbackFiles = new Map());
      if (!armed.has(file)) armed.set(file, { periodMs, deadline });
      if (session._parkedDrainFallbackTimer) return;
      const onDisk = (f) => {
        try { return fs.existsSync(path.join(PENDING_DIR, session.name, f)); } catch { return false; }
      };
      session._parkedDrainFallbackTimer = setTimeout(() => {
        session._parkedDrainFallbackTimer = null;
        if (session._dead) return;
        if (!onDisk(file)) {
          armed.delete(file);
          for (const [f, a] of armed) {
            if (onDisk(f)) { this._armParkedDrainFallback(session, f, a.periodMs, a.deadline, false); return; }
            armed.delete(f);
          }
          return;
        }
        // Re-arm rather than yield: the drain may bail. Extend the deadline so deferring cannot expire it.
        if (session._bootDrainTimer) {
          this._armParkedDrainFallback(session, file, periodMs, deadline + periodMs, drained);
          return;
        }
        if (!session._bootReadySeen && Date.now() < deadline) {
          this._armParkedDrainFallback(session, file, periodMs, deadline, drained);
          return;
        }
        if (!drained) {
          log.warn('inject', `parked-drain fallback for ${session.name} — boot-ready drain never fired (boot-ready seen=${!!session._bootReadySeen}); draining active park`);
        }
        this._drainPendingAtBootReady(session);
        this._armParkedDrainFallback(session, file, periodMs, deadline, true);
      }, periodMs);
    }
  }

  // defineProperty, not Object.assign: class methods are non-enumerable and an enumerable graft changes what for-in sees.
  // Ticket state (_ticketWatch, _stallProbing) stays initialised in the constructor; moving it needs a new init call.
  const ticketMethods = createTicketMethods(deps, { ticketsStore, nameConflict, SPEC_CONFIRM_MS });
  for (const [k, v] of Object.entries(ticketMethods)) {
    Object.defineProperty(SessionManager.prototype, k,
      { value: v, writable: true, configurable: true, enumerable: false });
  }

  return SessionManager;
}

module.exports = { createSessionManager, deniedBodyDisposition, escapeSafeTail, exitDisposition, findPeerByOrigin, isStaleRegistration, missingToolOnExit, nameConflict, peerOriginSuffix, preseedClaudeOnboarding, spillAckLine, ticketCloseLine, ticketTaskDirLine };
