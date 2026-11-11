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
const UNREACHABLE = new Set([0, 429, 502, 503, 504]);
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
  getPeerManager, ledgerFile = null, log = () => {}, now = Date.now, sleep = defaultSleep,
  randomUUID = () => crypto.randomUUID(), snapshot = snapshotLib, pollWaitMs = POLL_WAIT_MS, retryMs = RETRY_MS,
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
      onProgress = () => {}, onJob = () => {},
    } = opts;
    const ctx = {
      id: opts.runId || randomUUID(), peer, tree: path.resolve(tree), kind, scope, team, ticket, seat,
      jobId: null, attempt: 0, treeHash: null, sha: null, queuedAt: null, startedAt: null, env: null, started: false,
      deadline: now() + budgetMs, budgetMs, timeoutMs,
    };
    const progress = (line) => {
      log(line);
      try { onProgress(line); } catch {}
    };
    let snap;
    try {
      snap = await snapshot.snapshotTree(tree);
    } catch (e) {
      return conclude(ctx, { unknown: `snapshot failed: ${e.message}` });
    }
    ctx.treeHash = snap.treeHash;
    ctx.sha = snap.head;
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
          return conclude(ctx, { unknown: `client error: ${e.message}` });
        }
        if (out.retry && !used.has(out.retry) && now() < ctx.deadline) {
          used.add(out.retry);
          if (out.retry === 'incomplete') full = true;
          progress(`runner ${peer}: ${RETRY_TEXT[out.retry]}, resubmitting`);
          continue;
        }
        return conclude(ctx, out.retry ? { unknown: RETRY_TEXT[out.retry], job: out.job } : out);
      }
    } finally {
      snapshot.releaseSnapshot(snap);
    }
  }

  async function ask(ctx, fn, progress) {
    for (;;) {
      const r = await once(ctx.peer, fn);
      if (!UNREACHABLE.has(r.status)) return r;
      if (now() + retryMs >= ctx.deadline) return { ...r, unreachable: true };
      progress(`waiting for runner ${ctx.peer}`);
      await sleep(retryMs);
    }
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
    if (ctx.queuedAt == null) ctx.queuedAt = now();
    const sub = await ask(ctx, (c) => c.suiteAsk('POST', '/api/suite/jobs', body), progress);
    if (sub.unreachable) return { unknown: 'runner unreachable' };
    if (!sub.body || !sub.body.ok) return { unknown: `runner refused the job: ${(sub.body && sub.body.error) || sub.error || `status ${sub.status}`}` };
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
      id: ctx.id, phase: 'start', where: 'remote', runner: ctx.peer, jobId: ctx.jobId, attempt: ctx.attempt,
      kind: ctx.kind, scope: ctx.scope, team: ctx.team, ticket: ctx.ticket, seat: ctx.seat,
      tree: ctx.tree, sha: ctx.sha, treeHash: ctx.treeHash, pid: null,
      queuedAt: iso(ctx.queuedAt), startedAt: iso(ctx.startedAt), env: ctx.env,
    });
  }

  async function waitDone(ctx, jobId, progress) {
    let last = null;
    for (;;) {
      const left = ctx.deadline - now();
      if (left <= 0) {
        await cancel(ctx.peer, jobId);
        return { unknown: `no result within the ${ctx.budgetMs}ms budget (cancelled)`, outcome: 'timeout' };
      }
      const wait = Math.min(pollWaitMs, left);
      const r = await ask(ctx, (c) => c.suiteAsk('GET', `/api/suite/jobs?ids=${encodeURIComponent(jobId)}&wait=${wait}`, null, wait + POLL_SLACK_MS), progress);
      if (r.unreachable) {
        await cancel(ctx.peer, jobId);
        return { unknown: 'runner unreachable' };
      }
      if (!r.body || !r.body.ok) return { retry: 'runner-restart' };
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
      id: ctx.id, phase: 'end', where: 'remote', runner: ctx.peer, jobId: ctx.jobId, attempt: ctx.attempt,
      kind: ctx.kind, scope: ctx.scope, team: ctx.team, ticket: ctx.ticket, seat: ctx.seat,
      sha: ctx.sha, treeHash: ctx.treeHash, queuedAt: iso(ctx.queuedAt),
      outcome, reason: unknown, pass: totals ? totals.pass : null, fail: totals ? totals.fail : null, tests: totals ? totals.tests : null,
      endedAt: iso(endedAt), durationMs: ctx.startedAt != null ? endedAt - ctx.startedAt : null,
      queueMs: job ? job.queueMs : null, setupMs: job ? job.setupMs : null, runMs: job ? job.runMs : null,
      env: ctx.env,
    };
    appendLedger(record);
    return { res, unknown, record };
  }

  return { reachable, run, cancel };
}

module.exports = { createSuiteClient, lastTotals };
