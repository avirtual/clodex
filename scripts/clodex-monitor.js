#!/usr/bin/env node
'use strict';

// clodex-monitor.js — first of the "clodex tools" that ride the exec intent.
//
// The exec intent ([agent:exec <cmd>] {json}) is a one-shot, schema-validated,
// fire-and-forget control channel: argv comes wholly from the operator registry,
// the agent's JSON payload arrives on STDIN, stdout is dropped, and the launcher
// is SIGKILLed at the registry's (short) timeoutMs. That's a perfect CONTROL
// plane and a useless DATA plane — which is exactly the split a monitor wants.
//
// So this tool is two processes:
//   * LAUNCHER (this file, no --daemon): reads the STDIN payload, and for `start`
//     spawns a DETACHED watcher that outlives the exec's SIGKILL, then exits 0
//     immediately. `stop`/`list` act on the monitor registry and return. All
//     feedback rides the exec entry's replyStderr (last stderr line → agent).
//   * WATCHER (this file, --daemon): runs the agent's `command` and streams its
//     stdout back to the invoking agent as DMs over the agent's Unix socket —
//     the same "message from outside clodex to an agent inside" path that wake
//     scripts use ({from,body,type} → run/<agent>/agent.sock). Fire-and-forget
//     stays fire-and-forget; the watcher notifies only when the target emits.
//
// v1 scope: the invoking agent supplies its own name as `agent` in the payload
// (it knows it from SessionStart / [agent:name]). A later revision can have the
// exec runner pass the invoker via env and drop that field.

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

const CLODEX_HOME = process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex');

// --- shared paths -----------------------------------------------------------

function monitorsDir(agent) {
  return path.join(CLODEX_HOME, 'monitors', agent);
}
function statePath(agent, id) {
  return path.join(monitorsDir(agent), `${id}.json`);
}
function logPath(agent, id) {
  return path.join(monitorsDir(agent), `${id}.log`);
}
// The agent's inbound socket, read from its registry entry so we track the
// canonical path rather than re-deriving the run/<name>/agent.sock grammar.
function agentSocket(agent) {
  const regPath = path.join(CLODEX_HOME, 'run', agent, 'agent.json');
  const info = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
  if (!info || !info.socket) throw new Error('agent registry has no socket');
  return info.socket;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

// A short, filename-safe monitor id.
function mintId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// Best-effort DM to an agent's socket: {from,body,type:'dm'}. `passive:true`
// adds delivery:'passive' — the core parks it for an organic hook drain (rides
// the agent's next turn) instead of waking the agent; an older core ignores the
// field and wakes, so this degrades to noisy, never to dropped. Resolves to a
// boolean so the watcher can count consecutive failures (dead agent → shut down
// rather than orphan a daemon forever).
function sendDm(socketPath, from, body, passive = false) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const msg = { from, body, type: 'dm' };
    if (passive) msg.delivery = 'passive';
    const payload = Buffer.from(JSON.stringify(msg), 'utf-8');
    const conn = net.createConnection(socketPath, () => conn.end(payload, () => done(true)));
    conn.on('error', () => done(false));
    conn.setTimeout(2000, () => { conn.destroy(); done(false); });
  });
}

// ===========================================================================
// WATCHER (detached daemon)
// ===========================================================================

async function runWatcher() {
  const agent = process.env.CMON_AGENT;
  const id = process.env.CMON_ID;
  const command = process.env.CMON_COMMAND;
  const description = process.env.CMON_DESC || '';
  const persistent = process.env.CMON_PERSISTENT === '1';
  const timeoutMs = parseInt(process.env.CMON_TIMEOUT || '0', 10);

  let socketPath;
  try {
    socketPath = agentSocket(agent);
  } catch {
    // No reachable agent — nothing to notify, so there's no point running.
    cleanupState(agent, id);
    process.exit(0);
    return;
  }

  const wakeAll = process.env.CMON_WAKE === '1';
  let wsSpec = null;
  try { wsSpec = process.env.CMON_WS ? JSON.parse(process.env.CMON_WS) : null; } catch {}

  const label = description ? `${id} ${description}` : id;
  let deadDeliveries = 0;
  // wake:false (the status-tick default) sends delivery:'passive' — the core
  // parks it to ride the agent's next organic turn instead of generating one.
  // Lifecycle events always wake (silence is not success). wakeAll (payload
  // wake:true) restores built-in-Monitor behavior: every event wakes.
  const notify = async (text, { wake = false } = {}) => {
    const ok = await sendDm(socketPath, 'monitor', `[${label}] ${text}`, !(wake || wakeAll));
    deadDeliveries = ok ? 0 : deadDeliveries + 1;
    // Six straight failures ≈ the agent is gone. Tear the whole monitor down.
    if (deadDeliveries >= 6) {
      try { killTarget(); } catch {}
      cleanupState(agent, id);
      process.exit(0);
    }
  };

  // Coalesce a burst into one notification (flush on 250ms idle or a
  // line-count cap) so a chatty target doesn't fire a delivery per line.
  // Shared by both sources — command stdout lines and ws frames both land in
  // `pending` via pushLine.
  let pending = [];
  let flushTimer = null;
  const FLUSH_IDLE_MS = 250;
  const FLUSH_MAX_LINES = 20;
  // Firehose auto-stop (parity with the built-in Monitor): a target that emits
  // continuously for a long stretch gets cut off with a waking final event
  // instead of notifying forever. Counted per FLUSHED notification, rolling
  // one-minute window — passive parks are cheap but not free (they all drain
  // into some future turn's context).
  const FIREHOSE_MAX_PER_MIN = parseInt(process.env.CMON_FIREHOSE_MAX || '30', 10); // env override is for tests
  let deliveryTimes = [];
  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending.length) return;
    let text = pending.join('\n');
    if (text.length > 4000) text = text.slice(0, 4000) + `\n…(+${pending.length} lines, truncated)`;
    pending = [];
    const now = Date.now();
    deliveryTimes = deliveryTimes.filter((t) => now - t < 60000);
    deliveryTimes.push(now);
    if (deliveryTimes.length > FIREHOSE_MAX_PER_MIN && !shuttingDown) {
      notify(`too noisy (>${FIREHOSE_MAX_PER_MIN} notifications/min) — monitor stopped; restart with a tighter filter`, { wake: true })
        .then(() => { try { killTarget(); } catch {} cleanupState(agent, id); process.exit(0); });
      return;
    }
    notify(text);
  };
  const armFlush = () => {
    if (pending.length >= FLUSH_MAX_LINES) return flush();
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_IDLE_MS);
  };
  const pushLine = (line) => { if (line.length) { pending.push(line); armFlush(); } };

  let killTarget;
  let timer = null;
  // Once-guard: a stop/timeout kills the target, whose own exit event would
  // otherwise call shutdown a second time and double-notify.
  let shuttingDown = false;
  // wake:true is the default — most terminal events are real state changes of
  // the tracked item. The one exception is the agent-requested stop (see the
  // SIGTERM handler): confirmation, not news, so it rides passively.
  const shutdown = async (why, { wake = true } = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (timer) clearTimeout(timer);
    flush();
    await notify(why, { wake });
    cleanupState(agent, id);
    process.exit(0);
  };

  if (wsSpec && wsSpec.url) {
    // --- ws source: each incoming text frame is an event (built-in parity).
    // Binary frames become a placeholder line; socket close ends the watch
    // with the close code surfaced; errors surface before close.
    let ws;
    let closed = false;
    killTarget = () => { closed = true; try { ws.close(); } catch {} };
    try {
      ws = new WebSocket(wsSpec.url, Array.isArray(wsSpec.protocols) ? wsSpec.protocols : undefined);
    } catch (e) {
      await shutdown(`ws failed to open: ${String(e.message || e).slice(0, 200)}`);
      return;
    }
    let errTail = '';
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        // A multiline frame stays one event: pushed whole, newlines intact.
        pushLine(ev.data);
      } else {
        const n = ev.data && (ev.data.byteLength ?? ev.data.size ?? 0);
        pushLine(`[binary frame, ${n} bytes]`);
      }
    });
    ws.addEventListener('error', (ev) => {
      errTail = String((ev && ev.message) || 'socket error').slice(0, 200);
    });
    ws.addEventListener('close', async (ev) => {
      if (closed) return; // our own stop/timeout close — shutdown already speaks
      await shutdown(errTail
        ? `socket closed (code ${ev.code}): ${errTail}`
        : `socket closed (code ${ev.code})`);
    });
  } else {
    // --- command source: run the agent's command in a shell, in its own
    // process group so a stop or a timeout can kill the whole tree, not just
    // the shell. This mirrors the CLI Monitor: the COMMAND decides what counts
    // as a status change (poll+diff, `until`, grep --line-buffered); the
    // watcher only forwards what it emits.
    const child = childProcess.spawn('/bin/sh', ['-c', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    killTarget = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
    };

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf-8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        pushLine(line);
      }
    });

    let stderrTail = '';
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString('utf-8')).slice(-500);
    });

    child.on('exit', async (code, signal) => {
      if (buf.length) { pushLine(buf); buf = ''; }
      const how = signal ? `killed (${signal})` : `exited (code ${code})`;
      const tail = code ? (stderrTail.trim().split('\n').pop() || '') : '';
      await shutdown(tail ? `target ${how}: ${tail.slice(0, 200)}` : `target ${how}`);
    });
  }

  if (!persistent && timeoutMs > 0) {
    timer = setTimeout(async () => {
      timer = null;
      killTarget();
      await shutdown(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);
  }

  // External stop (launcher SIGTERMs us): the agent asked for this, so the
  // confirmation is administrative — passive, riding the next organic turn.
  process.on('SIGTERM', async () => { killTarget(); await shutdown('stopped', { wake: false }); });

  // The id's delivery channel: `start` is silent on the exec side (an ack is
  // not worth a turn), so the id + label arrive as a passive ride-along here.
  // `list` is the on-demand fallback if the agent needs the id sooner.
  notify('monitoring started');
}

// Remove a monitor's on-disk footprint: both the .json state and its .log. The
// two are minted together in `start`, so they die together — otherwise logs
// accumulate unbounded (list only ever reaped the .json).
function cleanupState(agent, id) {
  try { fs.unlinkSync(statePath(agent, id)); } catch {}
  try { fs.unlinkSync(logPath(agent, id)); } catch {}
}

// ===========================================================================
// LAUNCHER (the exec-invoked one-shot)
// ===========================================================================

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    // exec hands us the payload and closes stdin; guard against a hang anyway.
    setTimeout(() => resolve(data), 3000);
  });
}

// stderr is the only channel back to the agent (replyStderr). Keep it one line.
// Message discipline: QUERIES reply (say — list), COMMAND success is silent
// (exit 0, empty stderr → the dispatcher injects nothing, no turn), failures
// are always loud (die → exit 1 → the dispatcher injects the error regardless).
function die(msg) { process.stderr.write(String(msg) + '\n'); process.exit(1); }
function say(msg) { process.stderr.write(String(msg) + '\n'); process.exit(0); }

function listMonitors(agent) {
  let files = [];
  try { files = fs.readdirSync(monitorsDir(agent)).filter((f) => f.endsWith('.json')); }
  catch { /* no dir → none */ }
  const items = [];
  for (const f of files) {
    const fid = f.replace(/\.json$/, ''); // authoritative id = filename stem
    try {
      const s = JSON.parse(fs.readFileSync(path.join(monitorsDir(agent), f), 'utf-8'));
      const alive = s.pid && isAlive(s.pid);
      if (!alive) { cleanupState(agent, fid); continue; }
      items.push(s.description ? `${fid}(${s.description})` : fid);
    } catch { /* skip unreadable */ }
  }
  return items;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function runLauncher() {
  const raw = await readStdin();
  let p;
  try { p = JSON.parse(raw || '{}'); } catch { die('payload is not valid JSON'); return; }

  const agent = p.agent;
  if (!agent || typeof agent !== 'string') die('agent (your own name) is required');
  const action = p.action;

  if (action === 'list') {
    const items = listMonitors(agent);
    say(items.length ? `monitors: ${items.join(' ')}` : 'no monitors running');
    return;
  }

  if (action === 'stop') {
    if (!p.id) die('stop needs an id');
    let state;
    try { state = JSON.parse(fs.readFileSync(statePath(agent, p.id), 'utf-8')); }
    catch { die(`no such monitor ${p.id}`); return; }
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
    cleanupState(agent, p.id);
    process.exit(0); // silent success — the watcher's passive 'stopped' event confirms
  }

  if (action === 'start') {
    const hasCmd = p.command && typeof p.command === 'string';
    const hasWs = p.ws && typeof p.ws === 'object' && typeof p.ws.url === 'string';
    if (!hasCmd && !hasWs) die('start needs a command or a ws:{url}');
    if (hasCmd && hasWs) die('start takes command OR ws, not both');
    const id = mintId();
    ensureDir(monitorsDir(agent));
    const timeoutMs = (typeof p.timeout_ms === 'number' && p.timeout_ms > 0) ? p.timeout_ms : 300000;
    const persistent = p.persistent === true;

    // Detach the watcher so it survives our SIGKILL: own session (detached),
    // stdio to a logfile for observability, and unref so we can exit now.
    const logFd = fs.openSync(logPath(agent, id), 'a');
    const child = childProcess.spawn(process.execPath, [__filename, '--daemon'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        CMON_AGENT: agent,
        CMON_ID: id,
        CMON_COMMAND: p.command || '',
        // protocols rides the schema as a comma-separated string (the exec
        // validator has no array type); split to the array WebSocket wants.
        CMON_WS: hasWs ? JSON.stringify({
          url: p.ws.url,
          protocols: typeof p.ws.protocols === 'string'
            ? p.ws.protocols.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
        }) : '',
        CMON_DESC: p.description || '',
        CMON_PERSISTENT: persistent ? '1' : '0',
        CMON_TIMEOUT: String(timeoutMs),
        CMON_WAKE: p.wake === true ? '1' : '0',
      },
    });
    fs.writeFileSync(statePath(agent, id), JSON.stringify({
      id, pid: child.pid, command: p.command || (hasWs ? `ws ${p.ws.url}` : ''),
      description: p.description || '',
      persistent, timeout_ms: timeoutMs, startedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    child.unref();
    // Silent success: a start ack is not worth a turn. The id reaches the
    // agent as the watcher's passive 'monitoring started' ride-along.
    process.exit(0);
  }

  die(`unknown action "${action}" (start|stop|list)`);
}

// ===========================================================================

if (process.argv.includes('--daemon')) {
  runWatcher();
} else {
  runLauncher();
}
