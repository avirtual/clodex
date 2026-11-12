'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const snapshotLib = require('./suite-snapshot');

const POLL_WAIT_MS = 25000;
const POLL_SLACK_MS = 10000;
const RETRY_MS = 15000;
const COMMIT_TIMEOUT_MS = 120000;
const SLICE_BYTES = 256 * 1024;
const MAX_RESUMES = 8;
const DEFAULT_BUDGET_MS = 36 * 60 * 1000;
const DEFAULT_RUN_MS = 21 * 60 * 1000;
const SNAPSHOT_WAIT_MS = 2000;
const UNREACHABLE = new Set([0, 429, 502, 503, 504]);
const REFUSED = new Set([401, 403]);
const RETRY_TEXT = {
  'runner-restart': 'runner restarted',
  upload: 'upload failed',
  incomplete: 'runner could not complete the pack',
};

function lastTotals(text) {
  const re = /^TOTALS: (\d+) pass, (\d+) fail, (\d+) tests$/gm;
  let last = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = { pass: Number(m[1]), fail: Number(m[2]), tests: Number(m[3]) };
  return last;
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSuiteClient({
  getPeerManager, ledgerFile = null, compareFile = null, log = () => {}, now = Date.now, sleep = defaultSleep,
  randomUUID = () => crypto.randomUUID(), snapshot = snapshotLib, pollWaitMs = POLL_WAIT_MS, retryMs = RETRY_MS,
  snapshotSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
}) {
  function connFor(peer) {
    const pm = getPeerManager();
    return pm ? pm.get(peer) : null;
  }

  function appendLedger(rec) {
    if (!ledgerFile) return;
    try {
      fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
      fs.appendFileSync(ledgerFile, `${JSON.stringify(rec)}\n`);
    } catch (e) {
      log(`suite-client: ledger write failed: ${e.message}`);
    }
  }

  async function once(peer, fn) {
    const conn = connFor(peer);
    if (!conn) return { status: 0, body: null, error: `no peer ${peer}` };
    return fn(conn);
  }

  async function reachable(peer) {
    const r = await once(peer, (c) => c.suiteAsk('GET', '/api/suite/info'));
    if (r.body && r.body.ok) return { ok: true, info: r.body };
    if (REFUSED.has(r.status)) return { ok: false, why: `runner refused the token (status ${r.status})` };
    return { ok: false, why: r.error || (r.body && r.body.error) || `status ${r.status}` };
  }

  async function cancel(peer, jobId) {
    const r = await once(peer, (c) => c.suiteAsk('DELETE', `/api/suite/jobs/${encodeURIComponent(jobId)}`));
    return r.body && r.body.ok ? { ok: true } : { ok: false, error: r.error || (r.body && r.body.error) || `status ${r.status}` };
  }

  async function run(opts) {
    const {
      peer, tree, kind = 'hand', scope = 'full', team = null, ticket = null, seat = null,
      files = [], flags = {}, setup = null, env = {}, timeoutMs = null, budgetMs = DEFAULT_BUDGET_MS,
      onProgress = () => {}, onJob = () => {}, onSubmitted = () => {}, shouldStop = () => false,
      queueBudgetMs = null, runBudgetMs = null,
    } = opts;
    const ctx = {
      id: opts.runId || randomUUID(), peer, where: opts.name || peer, route: opts.route || null, override: opts.override || null,
      tree: typeof tree === 'string' && tree ? path.resolve(tree) : null, kind, scope, team, ticket, seat,
      jobId: null, attempt: 0, treeHash: null, sha: null, dirty: null, queuedAt: null, startedAt: null, env: null, started: false,
      t0: now(), budgetMs, queueBudgetMs, runBudgetMs, timeoutMs, onSubmitted, shouldStop,
    };
    const progress = (line) => {
      log(line);
      try { onProgress(line); } catch {}
    };
    let snap = opts.snap || null;
    if (!ctx.tree && !snap) return conclude(ctx, { unknown: 'no tree to measure' });
    if (!snap) {
      try {
        snap = await snapshot.snapshotTree(ctx.tree);
      } catch (e) {
        return conclude(ctx, { unknown: `snapshot failed: ${e.message}` });
      }
    }
    ctx.treeHash = snap.treeHash;
    ctx.sha = snap.head;
    ctx.dirty = snap.headTree ? snap.treeHash !== snap.headTree : null;
    try {
      const used = new Set();
      let full = false;
      for (let attempt = 1; ; attempt += 1) {
        const job = { attempt, full, files, flags, setup, env, onJob, progress };
        let out;
        try {
          out = await attemptJob(ctx, snap, job);
        } catch (e) {
          if (ctx.jobId) await cancel(peer, ctx.jobId);
          return conclude(ctx, { unknown: e.refused ? 'runner refused the token' : `client error: ${e.message}` });
        }
        if (out.retry && !used.has(out.retry) && now() < deadlineOf(ctx)) {
          used.add(out.retry);
          if (out.retry === 'incomplete') full = true;
          progress(`runner ${peer}: ${RETRY_TEXT[out.retry]}, resubmitting`);
          continue;
        }
        return conclude(ctx, out.retry ? { unknown: RETRY_TEXT[out.retry], job: out.job } : out);
      }
    } finally {
      try { snapshot.releaseSnapshot(snap); } catch (e) { log(`suite-client: snapshot release failed: ${e.message}`); }
    }
  }

  async function ask(ctx, fn, progress) {
    for (;;) {
      const r = await once(ctx.peer, fn);
      if (REFUSED.has(r.status)) throw Object.assign(new Error('runner refused the token'), { refused: true });
      if (!UNREACHABLE.has(r.status)) return r;
      const left = deadlineOf(ctx) - now();
      if (left <= 0) return { ...r, unreachable: true };
      progress(`waiting for runner ${ctx.peer}`);
      await sleep(Math.min(retryMs, left));
    }
  }

  function deadlineOf(ctx) {
    let d = ctx.t0 + ctx.budgetMs;
    if (!ctx.started && ctx.queueBudgetMs != null) d = Math.min(d, ctx.t0 + ctx.queueBudgetMs);
    if (ctx.started && ctx.runBudgetMs != null) d = Math.min(d, ctx.startedAt + ctx.runBudgetMs);
    return d;
  }

  function budgetText(ctx) {
    if (!ctx.started && ctx.queueBudgetMs != null && ctx.queueBudgetMs < ctx.budgetMs) {
      return `the job did not start within the ${ctx.queueBudgetMs}ms queue budget (cancelled)`;
    }
    if (ctx.started && ctx.runBudgetMs != null && ctx.startedAt + ctx.runBudgetMs < ctx.t0 + ctx.budgetMs) {
      return `no result within the ${ctx.runBudgetMs}ms run budget (cancelled)`;
    }
    return `no result within the ${ctx.budgetMs}ms budget (cancelled)`;
  }

  async function attemptJob(ctx, snap, { attempt, full, files, flags, setup, env, onJob, progress }) {
    const jobId = attempt === 1 ? ctx.id : `${ctx.id}-${attempt}`;
    ctx.jobId = jobId;
    ctx.attempt = attempt;
    try { onJob({ jobId, attempt }); } catch {}
    const jobPath = `/api/suite/jobs/${encodeURIComponent(jobId)}`;
    const info = await ask(ctx, (c) => c.suiteAsk('GET', '/api/suite/info'), progress);
    if (info.unreachable || !info.body || !info.body.ok) return { unknown: `runner unreachable: ${info.error || (info.body && info.body.error) || `status ${info.status}`}` };
    const limits = info.body.limits || {};
    ctx.env = info.body.env || null;
    const body = {
      id: jobId, attempt, repoKey: snap.repoKey, kind: ctx.kind, scope: ctx.scope,
      team: ctx.team, ticket: ctx.ticket, seat: ctx.seat,
      snap: snap.snap, treeHash: snap.treeHash, indexTree: snap.indexTree, sha: snap.head,
      branch: snap.branch, trunk: snap.trunk, refs: snap.refs, candidates: snap.candidates,
      files, flags, env, setup, timeoutMs: ctx.timeoutMs, full,
    };
    ctx.queuedAt = now();
    if (ctx.shouldStop()) return { unknown: 'cancelled by the caller before submit' };
    const sub = await ask(ctx, (c) => c.suiteAsk('POST', '/api/suite/jobs', body), progress);
    if (sub.unreachable) return { unknown: 'runner unreachable' };
    if (!sub.body || !sub.body.ok) return { unknown: `runner refused the job: ${(sub.body && sub.body.error) || sub.error || `status ${sub.status}`}` };
    try { ctx.onSubmitted({ jobId, attempt }); } catch {}
    if (sub.body.state === 'awaiting-pack') {
      const sent = await upload(ctx, snap, jobPath, sub.body.have || [], limits, progress);
      if (sent) {
        await cancel(ctx.peer, jobId);
        return sent;
      }
    }
    return waitDone(ctx, jobId, progress);
  }

  async function upload(ctx, snap, jobPath, have, limits, progress) {
    const pack = await snapshot.buildPack(snap, { have });
    if (limits.packMaxBytes && pack.length > limits.packMaxBytes) return { unknown: `pack of ${pack.length} bytes exceeds the runner's ${limits.packMaxBytes} byte limit` };
    const chunkMax = limits.chunkMax || 4 * 1024 * 1024;
    let offset = 0;
    let resumes = 0;
    while (offset < pack.length) {
      const chunk = pack.subarray(offset, offset + chunkMax);
      const headers = { 'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/*` };
      const r = await ask(ctx, (c) => c.suitePut(`${jobPath}/pack`, chunk, headers), progress);
      if (r.unreachable) return { unknown: 'runner unreachable' };
      if (r.body && r.body.ok) { offset = r.body.size; continue; }
      if (r.status === 409 && r.body && Number.isInteger(r.body.have) && r.body.have <= pack.length && resumes < MAX_RESUMES) {
        resumes += 1;
        offset = r.body.have;
        continue;
      }
      if (r.status === 404) return { retry: 'runner-restart' };
      return { retry: 'upload' };
    }
    const sha256 = crypto.createHash('sha256').update(pack).digest('hex');
    const done = await ask(ctx, (c) => c.suiteAsk('POST', `${jobPath}/commit`, { bytes: pack.length, sha256 }, COMMIT_TIMEOUT_MS), progress);
    if (done.unreachable) return { unknown: 'runner unreachable' };
    if (done.body && done.body.ok) return null;
    if (done.status === 409 && done.body && done.body.incomplete) return { retry: 'incomplete' };
    if (done.status === 409 && done.body && done.body.state && done.body.state !== 'awaiting-pack') return null;
    if (done.status === 404) return { retry: 'runner-restart' };
    return { retry: 'upload' };
  }

  async function readOutput(ctx, jobId, stream) {
    let text = '';
    let offset = 0;
    for (;;) {
      const q = `stream=${stream}&offset=${offset}&length=${SLICE_BYTES}`;
      const r = await once(ctx.peer, (c) => c.suiteAsk('GET', `/api/suite/jobs/${encodeURIComponent(jobId)}/output?${q}`));
      if (!r.body || !r.body.ok) return null;
      text += r.body.text;
      offset = r.body.offset + Buffer.byteLength(r.body.text);
      if (offset >= r.body.total || !r.body.text) return text;
    }
  }

  function markStarted(ctx, job) {
    if (ctx.started) return;
    ctx.started = true;
    ctx.startedAt = job.state === 'done' && job.queueMs != null ? ctx.queuedAt + job.queueMs : now();
    appendLedger({
      id: ctx.id, phase: 'start', where: ctx.where, runner: ctx.peer, jobId: ctx.jobId, attempt: ctx.attempt,
      kind: ctx.kind, scope: ctx.scope, team: ctx.team, ticket: ctx.ticket, seat: ctx.seat,
      tree: ctx.tree, sha: ctx.sha, treeHash: ctx.treeHash, dirty: ctx.dirty, pid: null, route: ctx.route, override: ctx.override,
      queuedAt: iso(ctx.queuedAt), startedAt: iso(ctx.startedAt), env: ctx.env,
    });
  }

  async function waitDone(ctx, jobId, progress) {
    let last = null;
    for (;;) {
      const left = deadlineOf(ctx) - now();
      if (left <= 0) {
        await cancel(ctx.peer, jobId);
        return { unknown: budgetText(ctx), outcome: 'timeout' };
      }
      const wait = Math.min(pollWaitMs, left);
      const r = await ask(ctx, (c) => c.suiteAsk('GET', `/api/suite/jobs?ids=${encodeURIComponent(jobId)}&wait=${wait}`, null, wait + POLL_SLACK_MS), progress);
      if (r.unreachable) {
        await cancel(ctx.peer, jobId);
        return { unknown: 'runner unreachable' };
      }
      if (!r.body || !r.body.ok) {
        await cancel(ctx.peer, jobId);
        return { retry: 'runner-restart' };
      }
      const jobs = Array.isArray(r.body.jobs) ? r.body.jobs : [];
      for (const stale of jobs.filter((j) => j && j.id !== jobId)) {
        log(`suite-client: discarded a result for job ${stale.id} while waiting on ${jobId}`);
        await cancel(ctx.peer, stale.id);
      }
      const job = jobs.find((j) => j && j.id === jobId);
      if (!job || job.state === 'gone') return { retry: 'runner-restart' };
      if (job.treeHash !== ctx.treeHash) return { unknown: `runner answered for tree ${String(job.treeHash).slice(0, 8)}, not ${ctx.treeHash.slice(0, 8)}` };
      if (job.env) ctx.env = job.env;
      if (job.state !== last) {
        last = job.state;
        progress(`runner ${ctx.peer}: job ${job.state}${job.position ? ` (#${job.position} in queue)` : ''}`);
      }
      if (job.state === 'setup' || job.state === 'running') markStarted(ctx, job);
      if (job.state !== 'done') continue;
      if (job.reason === 'runner-restart') return { retry: 'runner-restart', job };
      if (job.queueMs != null) markStarted(ctx, job);
      const stdout = await readOutput(ctx, jobId, 'stdout');
      const stderr = await readOutput(ctx, jobId, 'stderr');
      if (stdout == null || stderr == null) return { unknown: 'runner output unavailable', job };
      return { job, stdout, stderr, ...doneVerdict(ctx, job, stderr) };
    }
  }

  function doneVerdict(ctx, job, stderr) {
    if (job.reason == null) return {};
    if (job.reason === 'timeout') return { unknown: `the suite did not finish within ${ctx.timeoutMs || DEFAULT_RUN_MS}ms (killed)`, outcome: 'timeout' };
    if (job.reason === 'tree-mismatch') {
      const m = /\(([0-9a-f]{8})[0-9a-f]* != ([0-9a-f]{8})/.exec(stderr);
      return { unknown: `tree mismatch on runner${m ? ` (${m[1]} ≠ ${m[2]})` : ''}` };
    }
    return { unknown: `${job.reason} on runner` };
  }

  function conclude(ctx, out) {
    const job = out.job || null;
    const res = out.stdout != null ? {
      status: job.exit ? job.exit.code : null, signal: job.exit ? job.exit.signal : null,
      stdout: out.stdout, stderr: out.stderr, treeHash: ctx.treeHash, jobId: ctx.jobId, attempt: ctx.attempt,
      reason: job.reason, truncated: !!(job.out && job.out.truncated),
    } : null;
    const unknown = out.unknown || null;
    const totals = res && !unknown ? lastTotals(res.stdout) : null;
    const outcome = out.outcome || (unknown ? 'unknown' : !totals ? 'no-summary' : res.status === 0 ? 'pass' : 'fail');
    const endedAt = now();
    const record = {
      id: ctx.id, phase: 'end', where: ctx.where, runner: ctx.peer, jobId: ctx.jobId, attempt: ctx.attempt,
      kind: ctx.kind, scope: ctx.scope, team: ctx.team, ticket: ctx.ticket, seat: ctx.seat,
      tree: ctx.tree, sha: ctx.sha, treeHash: ctx.treeHash, queuedAt: iso(ctx.queuedAt), route: ctx.route, override: ctx.override,
      outcome, reason: unknown, pass: totals ? totals.pass : null, fail: totals ? totals.fail : null, tests: totals ? totals.tests : null,
      endedAt: iso(endedAt), durationMs: ctx.startedAt != null ? endedAt - ctx.startedAt : null,
      queueMs: job ? job.queueMs : null, setupMs: job ? job.setupMs : null, runMs: job ? job.runMs : null,
      env: ctx.env,
    };
    appendLedger(record);
    return { res, unknown, record };
  }

  const shadows = new Map();

  function appendCompare(rec) {
    if (!compareFile) return;
    try {
      fs.mkdirSync(path.dirname(compareFile), { recursive: true });
      fs.appendFileSync(compareFile, `${JSON.stringify(rec)}\n`);
    } catch (e) {
      log(`suite-client: comparison write failed: ${e.message}`);
    }
  }

  async function shadow(opts) {
    const taking = Promise.resolve().then(() => snapshot.snapshotTree(path.resolve(opts.tree)));
    const LATE = {};
    const snap = await Promise.race([taking, snapshotSleep(SNAPSHOT_WAIT_MS).then(() => LATE)]);
    if (snap === LATE) {
      log(`suite-client: the shadow snapshot of ${opts.tree} took over ${SNAPSHOT_WAIT_MS}ms; ${opts.kind} shadow run for ticket ${opts.ticket} dropped`);
      taking.then((late) => {
        try { snapshot.releaseSnapshot(late); } catch (e) { log(`suite-client: snapshot release failed: ${e.message}`); }
      }, () => {});
      return null;
    }
    const key = JSON.stringify([opts.team, opts.ticket, opts.kind]);
    const me = { treeHash: snap.treeHash, peer: opts.peer, jobId: null, superseded: false, local: null, remote: null, settled: false };
    const prev = shadows.get(key);
    if (prev && prev.treeHash !== me.treeHash) {
      prev.superseded = true;
      if (prev.jobId && !prev.remote) Promise.resolve().then(() => cancel(prev.peer, prev.jobId)).catch(() => {});
    }
    shadows.set(key, me);
    const settle = () => {
      if (!me.local || !me.remote || me.settled) return;
      me.settled = true;
      if (shadows.get(key) === me) shadows.delete(key);
      if (me.superseded) {
        log(`suite-client: discarded the shadow result of superseded job ${me.jobId}`);
        return;
      }
      const remote = remoteHalf(me.remote);
      const rec = me.remote.record || {};
      appendCompare({
        at: iso(now()), team: opts.team, kind: opts.kind, ticket: opts.ticket, treeHash: snap.treeHash, sha: snap.head || null,
        envKey: (rec.env && rec.env.envKey) || null, local: me.local, remote, agree: halvesAgree(me.local, remote),
      });
    };
    Promise.resolve()
      .then(() => run({ ...opts, snap, scope: 'full', onJob: ({ jobId }) => { me.jobId = jobId; } }))
      .catch((e) => ({ unknown: `client error: ${e.message}`, res: null, record: null }))
      .then((out) => {
        me.remote = out;
        settle();
      });
    return {
      treeHash: snap.treeHash,
      sha: snap.head || null,
      local(half) {
        me.local = half;
        settle();
      },
    };
  }

  function tally({ team, envKey = null }) {
    let text = '';
    try { text = compareFile ? fs.readFileSync(compareFile, 'utf8') : ''; } catch { text = ''; }
    const recs = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.team === team) recs.push(r);
      } catch {}
    }
    const latest = [...recs].reverse().find((r) => r.envKey);
    const key = envKey || (latest ? latest.envKey : null);
    const out = { envKey: key, agree: 0, disagree: 0, oneSided: [] };
    if (!key) return out;
    const counts = new Map();
    const bump = (side, name) => {
      const k = `${side}\0${name}`;
      const c = counts.get(k) || { side, name, count: 0 };
      c.count += 1;
      counts.set(k, c);
    };
    for (const r of recs) {
      if (r.envKey !== key) continue;
      if (r.agree === true) out.agree += 1; else out.disagree += 1;
      if (!r.local || !r.remote || !MEASURED.has(r.local.outcome) || !MEASURED.has(r.remote.outcome)) continue;
      const mine = new Set(r.local.failing || []);
      const theirs = new Set(r.remote.failing || []);
      for (const n of mine) if (!theirs.has(n)) bump('local', n);
      for (const n of theirs) if (!mine.has(n)) bump('remote', n);
    }
    out.oneSided = [...counts.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.side < b.side ? -1 : 1));
    return out;
  }

  return { reachable, run, cancel, shadow, tally };
}

const MEASURED = new Set(['pass', 'fail']);

function failingNames(text) {
  const names = [];
  for (const line of String(text).split('\n')) {
    const m = /^ *✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/.exec(line);
    if (m && !names.includes(m[1].trim())) names.push(m[1].trim());
    if (names.length >= 200) break;
  }
  return names;
}

function localHalf({ code = null, stdout = '', stderr = '', error = null, timedOut = false, durationMs = null } = {}) {
  const totals = error ? null : lastTotals(String(stdout || ''));
  const outcome = timedOut ? 'timeout' : error ? 'unknown' : !totals ? 'no-summary' : code === 0 ? 'pass' : 'fail';
  return {
    outcome, pass: totals ? totals.pass : null, fail: totals ? totals.fail : null, tests: totals ? totals.tests : null,
    failing: totals ? failingNames(`${stdout || ''}\n${stderr || ''}`) : [], durationMs,
  };
}

function remoteHalf(out) {
  const rec = (out && out.record) || {};
  const measured = out && !out.unknown && out.res && rec.tests != null;
  return {
    outcome: rec.outcome || 'unknown', reason: (out && out.unknown) || null,
    pass: rec.pass == null ? null : rec.pass, fail: rec.fail == null ? null : rec.fail, tests: rec.tests == null ? null : rec.tests,
    failing: measured ? failingNames(`${out.res.stdout || ''}\n${out.res.stderr || ''}`) : [],
    jobId: rec.jobId || null, queueMs: rec.queueMs == null ? null : rec.queueMs, runMs: rec.runMs == null ? null : rec.runMs,
  };
}

function halvesAgree(a, b) {
  if (a.outcome === 'unknown' || b.outcome === 'unknown') return false;
  if (a.outcome !== b.outcome || a.pass !== b.pass || a.fail !== b.fail || a.tests !== b.tests) return false;
  const x = new Set(a.failing);
  const y = new Set(b.failing);
  return x.size === y.size && [...x].every((n) => y.has(n));
}

const HAND_QUEUE_MS = 15 * 60 * 1000;
const HAND_RUN_MS = 21 * 60 * 1000;
const FLAG_KEYS = ['CLODEX_TEST_LOCK', 'CLODEX_TEST_SLOW_ADVISORY'];

function route({ team = null, kind = 'hand', scope = 'full', local = false } = {}) {
  const tr = team && team.testRunner;
  if (!tr || !tr.peer) return { where: 'local', why: 'no test runner' };
  if (kind !== 'hand') return { where: 'local', why: `${kind} runs are not routed` };
  const hands = tr.hands || 'off';
  if (hands !== 'full' && hands !== 'all') return { where: 'local', why: `hands:${hands}` };
  if (hands === 'full' && scope !== 'full') return { where: 'local', why: 'hands:full leaves own scope local' };
  if (local === true) return { where: 'local', why: 'local:true in the call', override: 'call' };
  return { where: 'remote', peer: tr.peer, why: `hands:${hands}` };
}

function safeFile(f) {
  return typeof f === 'string' && f.length > 0 && f.length <= 1000 && !f.startsWith('-') && !f.startsWith('/')
    && !f.includes('\0') && !f.split(/[\\/]/).includes('..');
}

function requestError(msg) {
  if (!msg || typeof msg !== 'object' || msg.op !== 'suite') return 'not a suite request';
  if (msg.scope !== 'full' && msg.scope !== 'own') return `bad scope ${JSON.stringify(msg.scope)}`;
  if (msg.files != null && !Array.isArray(msg.files)) return 'files must be a list';
  const bad = (msg.files || []).find((f) => !safeFile(f));
  if (bad !== undefined) return `bad file entry ${JSON.stringify(bad)}`;
  const flags = msg.flags == null ? {} : msg.flags;
  if (typeof flags !== 'object' || Array.isArray(flags)) return 'flags must be an object';
  for (const [k, v] of Object.entries(flags)) if (!FLAG_KEYS.includes(k) || typeof v !== 'string') return `flag not allowed: ${k}`;
  if (msg.local != null && typeof msg.local !== 'boolean') return 'local must be a boolean';
  return null;
}

function createChannelHost({
  client, team, seat = null, ticket = null, listWorktrees, resolvePeer, send,
  notifyLead = () => {}, log = () => {}, snapshot = snapshotLib, realpath = fs.realpathSync,
  queueBudgetMs = HAND_QUEUE_MS, runMs = HAND_RUN_MS,
}) {
  let asked = false;
  let finished = false;
  let wantCancel = false;
  let cancelSent = false;
  let inflight = null;
  const cancelled = new Set();
  const say = (m) => {
    try { send(m); } catch (e) { log(`suite channel: reply to ${seat} failed: ${e.message}`); }
  };
  const fireCancel = () => {
    if (!wantCancel || finished || !inflight || !inflight.jobId || cancelled.has(inflight.jobId)) return;
    cancelled.add(inflight.jobId);
    cancelSent = true;
    Promise.resolve(client.cancel(inflight.peer, inflight.jobId)).catch(() => {});
  };
  const real = (p) => {
    try { return realpath(p); } catch { return null; }
  };

  async function measured(measure) {
    if (typeof measure !== 'string' || !measure) return null;
    const want = real(measure);
    if (!want) return null;
    const listed = await listWorktrees(team.root);
    const trees = listed && listed.ok && Array.isArray(listed.worktrees) ? listed.worktrees : [];
    return trees.some((w) => w && real(w.path) === want) ? want : null;
  }

  async function treeNote(tree, treeHash) {
    let again = null;
    try {
      again = await snapshot.snapshotTree(tree);
      return again.treeHash !== treeHash ? `(tree changed during the run; the suite measured ${String(treeHash).slice(0, 8)})` : null;
    } catch (e) {
      log(`suite channel: tree re-check failed: ${e.message}`);
      return null;
    } finally {
      try { snapshot.releaseSnapshot(again); } catch {}
    }
  }

  async function handle(msg) {
    const bad = requestError(msg);
    if (bad) return say({ run: 'refused', why: bad });
    if (!team) return say({ run: 'local', why: 'no team' });
    const tree = await measured(msg.measure);
    if (!tree) return say({ run: 'refused', why: `not a worktree of team ${team.name}: ${String(msg.measure).slice(0, 300)}` });
    const d = route({ team, ticket, kind: 'hand', scope: msg.scope, local: msg.local === true });
    if (d.where === 'local') {
      if (d.override) notifyLead(`${seat}: clodex-run-tests ran here on request ({"local": true}); team ${team.name} routes hand runs to ${team.testRunner.peer}`);
      return say({ run: 'local', why: d.why, override: d.override || null });
    }
    if (!client) return say({ run: 'remote', runner: d.peer, unknown: 'no suite client on this node' });
    const peer = resolvePeer(d.peer);
    if (!peer) return say({ run: 'remote', runner: d.peer, unknown: `runner ${d.peer} is not a known peer` });
    if (wantCancel) return say({ run: 'remote', runner: d.peer, unknown: 'cancelled by the caller' });
    inflight = { peer, jobId: null };
    const tr = team.testRunner;
    const out = await client.run({
      peer, name: d.peer, tree, kind: 'hand', scope: msg.scope, team: team.name, ticket, seat,
      files: msg.files || [], flags: msg.flags || {}, setup: tr.setup || null, env: tr.env || {},
      queueBudgetMs, runBudgetMs: runMs, timeoutMs: runMs, route: d.why,
      shouldStop: () => wantCancel,
      onSubmitted: ({ jobId }) => { inflight.jobId = jobId; fireCancel(); },
      onProgress: (line) => say({ progress: line }),
    });
    finished = true;
    if (out.unknown || !out.res) return say({ run: 'remote', runner: d.peer, unknown: out.unknown || 'no result' });
    const r = out.res;
    const note = await treeNote(tree, r.treeHash);
    return say({
      run: 'remote', runner: d.peer, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr,
      error: null, unknown: null, treeHash: r.treeHash, note,
    });
  }

  return {
    onMessage(msg) {
      if (asked) return;
      asked = true;
      handle(msg).catch((e) => {
        finished = true;
        say({ run: 'remote', unknown: `host error: ${e.message}` });
      });
    },
    cancel() {
      wantCancel = true;
      fireCancel();
      return cancelSent;
    },
  };
}

module.exports = { createSuiteClient, createChannelHost, route, lastTotals, localHalf, HAND_QUEUE_MS, HAND_RUN_MS };
