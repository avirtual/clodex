'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { RemoteServer } = require('../remote');
const { PeerConnection } = require('../peer-client');
const { createSuiteDesk } = require('../suite-desk');
const { createSuiteRunner, noneIsolation, statePaths } = require('../suite-runner');
const { createSuiteClient } = require('../suite-client');
const { createSuiteClaimer } = require('../suite-claimer');
const { suiteRoute } = require('../suite-dispatch');
const { suiteClaimerFor, suiteClaimRows } = require('../peer-wiring');
const { snapshotTree, releaseSnapshot, buildPack } = require('../suite-snapshot');

const OP_TOKEN = 'operator-token-pull-5c1d';
const STDOUT = 'ran tree\nTOTALS: 3 pass, 0 fail, 3 tests\n';
const RUN_OFFER = { scope: 'run', enabled: true, boxes: 1, availability: 'always', peers: [{ name: 'murmur' }] };
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];

function g(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...IDENT, ...args], { env: ENV, encoding: 'utf8' });
}

function makeRepo(root) {
  const repo = path.join(root, 'near');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

async function waitFor(pred, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function fakeClock(start = 5000) {
  let t = start;
  const armed = new Set();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const h = { at: t + ms, fn }; armed.add(h); return h; },
      clearTimeout(h) { armed.delete(h); },
      setInterval() { return {}; },
      clearInterval() {},
    },
    advance(ms) {
      t += ms;
      for (const h of [...armed]) if (h.at <= t) { armed.delete(h); h.fn(); }
    },
    armed,
  };
}

async function startLead(t) {
  const clock = fakeClock();
  const lead = { bell: true, dropped: 0, claims: [], clock, server: null };
  const desk = createSuiteDesk({
    now: clock.now, timers: clock.timers,
    notify: (origin) => { if (lead.bell && lead.server) lead.server.notifySuiteMail(origin); else lead.dropped += 1; },
  });
  const claim = desk.claim;
  desk.claim = (origin, session) => {
    const out = claim(origin, session);
    lead.claims.push({ session, status: out.status, calls: (out.calls || []).map((c) => ({ method: c.method, path: c.path, headers: c.headers })) });
    return out;
  };
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: '/nonexistent', hostLabel: 'murmur', version: '9.9.9',
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    token: OP_TOKEN, suiteDesk: desk,
  });
  await server.start();
  lead.server = server;
  t.after(() => { desk.close(); server.stop(); });
  return { ...lead, lead, desk, port: server.port, conn: desk.conn('laptop') };
}

function spawner() {
  const st = { count: 0, hold: false, held: [], children: [] };
  st.spawn = (cmd, args, opts) => {
    st.count += 1;
    const child = new EventEmitter();
    child.pid = 7000 + st.count;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.end = (out, code, signal) => {
      if (child.ended) return;
      child.ended = true;
      child.stdout.end(out);
      child.stderr.end('');
      setImmediate(() => child.emit('close', code, signal));
    };
    st.children.push(child);
    const finish = () => child.end(`ran ${path.basename(opts.cwd)}\nTOTALS: 3 pass, 0 fail, 3 tests\n`, 0, null);
    if (st.hold) st.held.push(finish);
    else setImmediate(finish);
    return child;
  };
  st.kill = (pid) => {
    const child = st.children.find((c) => c.pid === -pid);
    if (child) { child.killed = true; child.end('', null, 'SIGKILL'); }
  };
  st.release = () => { for (const f of st.held.splice(0)) f(); };
  return st;
}

function engineAt(t, root, { sp = spawner(), timers } = {}) {
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  const runner = createSuiteRunner({
    root, work, isolation: noneIsolation({ user: 'suite-test', kill: sp.kill }), spawn: sp.spawn,
    ...(timers ? { timers } : {}),
  });
  t.after(() => { sp.hold = false; sp.release(); for (const c of sp.children) c.end('', null, 'SIGKILL'); runner.close(); spawnSync('chmod', ['-R', 'u+w', root]); });
  return { runner, sp, root };
}

function startRunner(t, port, { offer = RUN_OFFER, engine = null, concurrency, date } = {}) {
  const state = { offer, engine, date: date || new Date(), logs: [] };
  const factory = suiteClaimerFor({
    getBoxOffer: () => state.offer,
    getSuiteEngine: () => state.engine,
    log: { warn: (_tag, m) => state.logs.push(m) },
    now: () => state.date,
    concurrency,
  });
  const conn = new PeerConnection({
    id: 'p-murmur', label: 'murmur', url: `http://127.0.0.1:${port}`, token: OP_TOKEN,
    emit: () => {}, selfLabel: 'laptop', helloIntervalMs: 600000, suiteClaimer: factory,
  });
  t.after(() => conn.stop());
  const claimer = conn._suiteClaimer;
  const rings = [];
  const ring = claimer.ring;
  claimer.ring = () => { const p = ring(); rings.push(p); return p; };
  const tick = async () => {
    const n = rings.length;
    clearTimeout(conn._helloTimer);
    conn._helloLoop();
    await waitFor(() => rings.length > n, 'a ring on the hello tick');
    await rings[rings.length - 1];
  };
  return { conn, state, claimer, rings, tick };
}

async function attach(t, lead, opts) {
  const r = startRunner(t, lead.port, opts);
  const before = lead.claims.length;
  r.conn.start();
  await waitFor(() => lead.claims.length > before && r.conn._eventsReq, 'the first claim and the event stream');
  return r;
}

function submitBody(snap, id) {
  return {
    id, attempt: 1, repoKey: snap.repoKey, kind: 'hand', scope: 'full',
    snap: snap.snap, treeHash: snap.treeHash, indexTree: snap.indexTree, sha: snap.head,
    branch: snap.branch, trunk: snap.trunk, refs: snap.refs, candidates: snap.candidates,
    files: [], flags: {}, full: true,
  };
}

async function snapOf(t, repo) {
  const snap = await snapshotTree(repo);
  t.after(() => releaseSnapshot(snap));
  const pack = fs.readFileSync((await buildPack(snap, { have: [] })).file);
  return { snap, pack, sha256: crypto.createHash('sha256').update(pack).digest('hex') };
}

async function runJob(conn, s, id) {
  const sub = await conn.suiteAsk('POST', '/api/suite/jobs', submitBody(s.snap, id));
  assert.strictEqual(sub.status, 200, `ENTER: submit of ${id} accepted: ${JSON.stringify(sub)}`);
  const put = await conn.suitePut(`/api/suite/jobs/${id}/pack`, s.pack, { 'Content-Range': `bytes 0-${s.pack.length - 1}/*` });
  assert.strictEqual(put.status, 200, `ENTER: pack of ${id} accepted: ${JSON.stringify(put)}`);
  const commit = await conn.suiteAsk('POST', `/api/suite/jobs/${id}/commit`, { bytes: s.pack.length, sha256: s.sha256 });
  assert.strictEqual(commit.status, 200, `ENTER: commit of ${id} accepted: ${JSON.stringify(commit)}`);
}

async function jobView(runner, id) {
  return (await runner.poll([id])).jobs[0];
}

const verbs = (claims) => {
  const out = [];
  for (const c of claims) {
    for (const call of c.calls) {
      const route = suiteRoute(call);
      const v = route.row ? route.row.verb : `${call.method} ${call.path}`;
      if (out[out.length - 1] !== v) out.push(v);
    }
  }
  return out;
};

test('a job goes submit, pack, commit, poll to done and output through the desk, and the output is the child\'s', async (t) => {
  const root = mkTmpRoot('pull-wire-');
  const repo = makeRepo(root);
  const { runner } = engineAt(t, path.join(root, 'b'));
  const lead = await startLead(t);
  await attach(t, lead, { engine: runner });
  const client = createSuiteClient({ getPeerManager: () => ({ get: () => lead.conn }), randomUUID: () => 'pull-0001' });
  const out = await client.run({ peer: 'pull:laptop', tree: repo, kind: 'verify' });
  assert.strictEqual(out.unknown, null, `run unknown: ${out.unknown}`);
  assert.deepStrictEqual([out.res.status, out.res.jobId, out.res.stdout, out.record.outcome], [0, 'pull-0001', STDOUT, 'pass']);
  assert.deepStrictEqual(verbs(lead.claims), ['info', 'submit', 'putPack', 'commit', 'poll', 'output']);
});

test('without a run grant the runner never claims, counted after a granted row claimed', async (t) => {
  const lead = await startLead(t);
  const root = mkTmpRoot('pull-wire-');
  const { runner } = engineAt(t, root);
  const r = await attach(t, lead, { engine: runner });
  const granted = lead.claims.length;
  assert.ok(granted >= 1, 'ENTER: the granted row claimed');
  const rows = [
    ['scope discovery', { ...RUN_OFFER, scope: 'discovery' }],
    ['peer unticked', { ...RUN_OFFER, peers: [{ name: 'other' }] }],
    ['offer disabled', { ...RUN_OFFER, enabled: false }],
  ];
  const seen = [];
  for (const [label, offer] of rows) {
    r.state.offer = offer;
    await r.tick();
    seen.push([label, lead.claims.length - granted]);
  }
  assert.deepStrictEqual(seen, [['scope discovery', 0], ['peer unticked', 0], ['offer disabled', 0]]);
});

test('a dropped doorbell: the call still completes on the next hello tick', async (t) => {
  const lead = await startLead(t);
  const { runner } = engineAt(t, mkTmpRoot('pull-wire-'));
  const r = await attach(t, lead, { engine: runner });
  lead.lead.bell = false;
  const asked = lead.conn.suiteAsk('GET', '/api/suite/info');
  await waitFor(() => lead.lead.dropped === 1, 'the dropped doorbell');
  await r.tick();
  const got = await asked;
  assert.deepStrictEqual([got.status, got.body.bootId], [200, (await runner.info()).bootId]);
});

test('the engine replaced between two calls: the second call reaches the new engine', async (t) => {
  const lead = await startLead(t);
  const one = engineAt(t, mkTmpRoot('pull-wire-')).runner;
  const two = engineAt(t, mkTmpRoot('pull-wire-')).runner;
  const r = await attach(t, lead, { engine: one });
  const first = await lead.conn.suiteAsk('GET', '/api/suite/info');
  r.state.engine = two;
  const second = await lead.conn.suiteAsk('GET', '/api/suite/info');
  const ids = [(await one.info()).bootId, (await two.info()).bootId];
  assert.notStrictEqual(ids[0], ids[1]);
  assert.deepStrictEqual([first.body.bootId, second.body.bootId], ids);
});

test('a claimed call outside the suite verb table is answered 404', async (t) => {
  const lead = await startLead(t);
  const { runner } = engineAt(t, mkTmpRoot('pull-wire-'));
  await attach(t, lead, { engine: runner });
  const got = await lead.conn.suiteAsk('GET', '/api/sessions');
  assert.deepStrictEqual([got.status, got.body], [404, { ok: false, error: 'not found' }]);
  assert.ok(lead.claims.some((c) => c.calls.some((call) => call.path === '/api/sessions')), 'ENTER: the call was claimed');
});

test('a delayed tick: a call claimed inside its deadline is answered; one past it expires at the lead and is never executed', async (t) => {
  const lead = await startLead(t);
  const { runner } = engineAt(t, mkTmpRoot('pull-wire-'));
  let infos = 0;
  const counted = { ...runner, info: (...a) => { infos += 1; return runner.info(...a); } };
  const r = await attach(t, lead, { engine: counted });
  lead.lead.bell = false;
  const inside = lead.conn.suiteAsk('GET', '/api/suite/info');
  lead.clock.advance(19000);
  await r.tick();
  const insideGot = await within(inside, 3000, 'the inside answer');
  const late = lead.conn.suiteAsk('GET', '/api/suite/info');
  lead.clock.advance(20001);
  const lateGot = await late;
  await r.tick();
  assert.deepStrictEqual([insideGot.status, lateGot.status, lateGot.error, infos], [200, 0, 'runner did not answer in time', 1]);
});

test('a cancel that arrives while a long poll holds the only slot is answered without waiting for the poll', async (t) => {
  const root = mkTmpRoot('pull-wire-');
  const repo = makeRepo(root);
  const clock = fakeClock();
  const { runner } = engineAt(t, path.join(root, 'b'), { timers: clock.timers });
  let waiting = 0;
  const watched = { ...runner, poll: (ids, opts) => { if (opts && opts.wait) waiting += 1; return runner.poll(ids, opts); } };
  const lead = await startLead(t);
  await attach(t, lead, { engine: watched, concurrency: 1 });
  const s = await snapOf(t, repo);
  const sub = await lead.conn.suiteAsk('POST', '/api/suite/jobs', submitBody(s.snap, 'long-1'));
  assert.strictEqual(sub.body.state, 'awaiting-pack');
  const poll = lead.conn.suiteAsk('GET', '/api/suite/jobs?ids=long-1&wait=25000', null, 60000);
  await waitFor(() => waiting === 1, 'the long poll in the engine');
  const cancel = await within(lead.conn.suiteAsk('DELETE', '/api/suite/jobs/long-1'), 3000, 'the cancel answer');
  const polled = await within(poll, 3000, 'the poll answer');
  assert.deepStrictEqual([cancel.status, polled.status, polled.body.jobs[0].state, polled.body.jobs[0].reason], [200, 200, 'done', 'cancelled']);
});

test('a reply lost after execution: the lead retries and the retry does not execute twice', async (t) => {
  const root = mkTmpRoot('pull-wire-');
  const repo = makeRepo(root);
  const b = engineAt(t, path.join(root, 'b'));
  const lead = await startLead(t);
  const r = await attach(t, lead, { engine: b.runner });
  const dropped = [];
  let drop = false;
  const realReply = r.conn.suiteDeskReply.bind(r.conn);
  r.conn.suiteDeskReply = (id, claim, answer) => {
    if (!drop) return realReply(id, claim, answer);
    drop = false;
    dropped.push(answer);
    return Promise.resolve({ status: 0, body: null, error: 'dropped' });
  };
  const s = await snapOf(t, repo);
  const lostThenRetry = async (label, issue) => {
    drop = true;
    const n = dropped.length;
    const first = issue();
    await waitFor(() => dropped.length > n, 'the dropped reply');
    lead.clock.advance(20001);
    const lost = await within(first, 3000, `${label}: the expired call`);
    const again = await within(issue(), 3000, `${label}: the retry`);
    return [lost.status, dropped[n].status, again.status];
  };
  const rows = [];
  rows.push(['submit', ...await lostThenRetry('submit', () => lead.conn.suiteAsk('POST', '/api/suite/jobs', submitBody(s.snap, 'lost-1')))]);
  rows.push(['putPack', ...await lostThenRetry('putPack', () => lead.conn.suitePut('/api/suite/jobs/lost-1/pack', s.pack, { 'Content-Range': `bytes 0-${s.pack.length - 1}/*` }, 20000))]);
  rows.push(['commit', ...await lostThenRetry('commit', () => lead.conn.suiteAsk('POST', '/api/suite/jobs/lost-1/commit', { bytes: s.pack.length, sha256: s.sha256 }))]);
  await waitFor(() => b.sp.count === 1, 'the job to run');
  const sub2 = await lead.conn.suiteAsk('POST', '/api/suite/jobs', submitBody(s.snap, 'lost-2'));
  assert.strictEqual(sub2.body.state, 'awaiting-pack');
  rows.push(['cancel', ...await lostThenRetry('cancel', () => lead.conn.suiteAsk('DELETE', '/api/suite/jobs/lost-2'))]);
  assert.deepStrictEqual(rows, [
    ['submit', 0, 200, 200],
    ['putPack', 0, 200, 409],
    ['commit', 0, 200, 409],
    ['cancel', 0, 200, 200],
  ]);
  const one = await jobView(b.runner, 'lost-1');
  await waitFor(() => b.sp.children.every((c) => c.ended), 'the run to end');
  const two = await jobView(b.runner, 'lost-2');
  assert.deepStrictEqual([
    fs.readdirSync(statePaths(path.join(root, 'b')).jobs).sort(), b.sp.count, one.treeHash, two.state, two.reason,
  ], [['lost-1', 'lost-2'], 1, s.snap.treeHash, 'done', 'cancelled']);
});

test('the link dropped mid-job and re-attached with the same session: the job continues to its output', async (t) => {
  const root = mkTmpRoot('pull-wire-');
  const repo = makeRepo(root);
  const b = engineAt(t, path.join(root, 'b'));
  b.sp.hold = true;
  const lead = await startLead(t);
  const r = await attach(t, lead, { engine: b.runner });
  const s = await snapOf(t, repo);
  await runJob(lead.conn, s, 'drop-1');
  await waitFor(() => b.sp.count === 1, 'the job to run');
  lead.lead.bell = false;
  lead.clock.advance(46000);
  const detached = await lead.conn.suiteAsk('GET', '/api/suite/info');
  await r.tick();
  lead.lead.bell = true;
  b.sp.release();
  const polled = await lead.conn.suiteAsk('GET', '/api/suite/jobs?ids=drop-1&wait=25000', null, 60000);
  const view = polled.body.jobs[0].state === 'done' ? polled.body.jobs[0] : (await lead.conn.suiteAsk('GET', '/api/suite/jobs?ids=drop-1&wait=25000', null, 60000)).body.jobs[0];
  const outp = await lead.conn.suiteAsk('GET', '/api/suite/jobs/drop-1/output?stream=stdout&offset=0');
  const sessions = [...new Set(lead.claims.map((c) => c.session))];
  assert.deepStrictEqual([detached.status, sessions.length, view.state, view.reason, outp.body.text], [503, 1, 'done', null, STDOUT]);
});

test('re-attached with a new session: the lead\'s in-flight call fails as runner-restart', async (t) => {
  const root = mkTmpRoot('pull-wire-');
  const repo = makeRepo(root);
  const clock = fakeClock();
  const { runner } = engineAt(t, path.join(root, 'b'), { timers: clock.timers });
  let waiting = 0;
  const watched = { ...runner, poll: (ids, opts) => { if (opts && opts.wait) waiting += 1; return runner.poll(ids, opts); } };
  const lead = await startLead(t);
  const first = await attach(t, lead, { engine: watched });
  const s = await snapOf(t, repo);
  const sub = await lead.conn.suiteAsk('POST', '/api/suite/jobs', submitBody(s.snap, 'restart-1'));
  assert.strictEqual(sub.body.state, 'awaiting-pack');
  const poll = lead.conn.suiteAsk('GET', '/api/suite/jobs?ids=restart-1&wait=25000', null, 60000);
  await waitFor(() => waiting === 1, 'the long poll in the engine');
  first.conn.stop();
  lead.clock.advance(46000);
  await attach(t, lead, { engine: watched });
  const got = await within(poll, 3000, 'the failed poll');
  const sessions = [...new Set(lead.claims.map((c) => c.session))];
  assert.deepStrictEqual([sessions.length, got.status, got.body], [2, 404, { ok: false, error: 'runner session replaced', reason: 'runner-restart' }]);
});

test('the schedule closes during a run: a new submit is refused and the running job still reaches its output', async (t) => {
  const root = mkTmpRoot('pull-wire-');
  const repo = makeRepo(root);
  const b = engineAt(t, path.join(root, 'b'));
  b.sp.hold = true;
  const offer = { ...RUN_OFFER, availability: 'schedule', schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '18:00' }] };
  const lead = await startLead(t);
  const r = await attach(t, lead, { engine: b.runner, offer, date: new Date(2026, 0, 5, 12, 0) });
  const client = createSuiteClient({ getPeerManager: () => ({ get: () => lead.conn }), randomUUID: () => 'sched-1' });
  const running = client.run({ peer: 'pull:laptop', tree: repo, kind: 'verify' });
  await waitFor(() => b.sp.count === 1, 'the job to run');
  r.state.date = new Date(2026, 0, 5, 20, 0);
  const refused = await lead.conn.suiteAsk('POST', '/api/suite/jobs', { id: 'sched-2' });
  b.sp.release();
  const out = await running;
  assert.deepStrictEqual([refused.status, refused.body, out.unknown, out.res && out.res.stdout, out.record.outcome], [503, { ok: false, error: 'offer closed' }, null, STDOUT, 'pass']);
});

test('the grant revoked during a run cancels the job and stops the claims', async (t) => {
  const root = mkTmpRoot('pull-wire-');
  const repo = makeRepo(root);
  const b = engineAt(t, path.join(root, 'b'));
  b.sp.hold = true;
  const lead = await startLead(t);
  const r = await attach(t, lead, { engine: b.runner });
  const s = await snapOf(t, repo);
  await runJob(lead.conn, s, 'revoke-1');
  await waitFor(() => b.sp.count === 1, 'the job to run');
  assert.strictEqual((await jobView(b.runner, 'revoke-1')).state, 'running');
  r.state.offer = { ...RUN_OFFER, peers: [{ name: 'other' }] };
  const claims = lead.claims.length;
  await r.tick();
  await waitFor(() => b.sp.children[0].killed, 'the kill');
  await waitFor(() => r.claimer.status().active === 0, 'the claimer to settle');
  let view = await jobView(b.runner, 'revoke-1');
  for (let i = 0; i < 400 && view.state !== 'done'; i += 1) {
    await new Promise((res) => setTimeout(res, 5));
    view = await jobView(b.runner, 'revoke-1');
  }
  assert.deepStrictEqual([view.state, view.reason, lead.claims.length - claims], ['done', 'cancelled', 0]);
});

test('a claimed call past its local deadline is not executed', async () => {
  const rows = [['blob took 500 of 1000 ms', 500], ['blob took 1500 of 1000 ms', 1500]];
  const seen = [];
  for (const [label, spent] of rows) {
    let t = 0;
    const executed = [];
    const replied = [];
    const logs = [];
    let batch = [{
      id: 'c1', claim: 'k1', ttlMs: 1000, method: 'PUT', path: '/api/suite/jobs/j1/pack',
      headers: { 'content-range': 'bytes 0-2/*' }, body: null, blob: { bytes: 3 },
    }];
    const claimer = createSuiteClaimer({
      claim: async () => { const calls = batch; batch = []; return { status: 200, body: { ok: true, calls } }; },
      blob: async () => { t += spent; return { status: 200, bytes: Buffer.from('abc') }; },
      execute: async (call) => { executed.push(call.path); return { status: 200, body: { ok: true, size: 3 } }; },
      reply: async (id, claim, answer) => { replied.push(answer.status); return { status: 200 }; },
      log: (m) => logs.push(m),
      now: () => t,
    });
    await claimer.ring();
    await waitFor(() => replied.length || logs.some((m) => m.includes('past its deadline')), 'the call to settle');
    seen.push([label, executed.length, replied.length]);
  }
  assert.deepStrictEqual(seen, [['blob took 500 of 1000 ms', 1, 1], ['blob took 1500 of 1000 ms', 0, 0]]);
});

test('a submit that returns after the grant was revoked is cancelled at once', async () => {
  let serve = true;
  const executed = [];
  const replied = [];
  let batch = [{ id: 'c1', claim: 'k1', ttlMs: 60000, method: 'POST', path: '/api/suite/jobs', headers: {}, body: { team: 't' } }];
  const claimer = createSuiteClaimer({
    claim: async () => { const calls = batch; batch = []; return { status: 200, body: { ok: true, calls } }; },
    blob: async () => ({ status: 404 }),
    execute: async (call) => {
      executed.push(`${call.method} ${call.path}`);
      if (call.method === 'POST') serve = false;
      return call.method === 'POST' ? { status: 200, body: { ok: true, id: 'job-9' } } : { status: 200, body: { ok: true } };
    },
    reply: async (id, claim, answer) => { replied.push(answer.status); return { status: 200 }; },
    grant: () => ({ admit: serve, serve }),
  });
  await claimer.ring();
  await waitFor(() => executed.length === 2 && replied.length === 1, 'the submit to reply and its cancel to run');
  assert.deepStrictEqual(executed, ['POST /api/suite/jobs', 'DELETE /api/suite/jobs/job-9']);
});

test('a claim that keeps failing the same way is logged once, and again after a success', async () => {
  const answers = [{ status: 409 }, { status: 409 }, { status: 409 }, { status: 200, body: { ok: true, calls: [] } }, { status: 409 }];
  const logs = [];
  const claimer = createSuiteClaimer({
    claim: async () => answers.shift(),
    blob: async () => ({ status: 404 }), execute: async () => ({ status: 200, body: {} }), reply: async () => ({ status: 200 }),
    log: (m) => logs.push(m),
  });
  for (let i = 0; i < 5; i++) await claimer.ring();
  assert.deepStrictEqual(logs, ['claim failed (409)', 'claim failed (409)']);
});

test('claim status rows: claiming, not connected and runner off, one per ticked peer of a run offer', () => {
  const conn = (label, online, caps, lastClaim) => ({
    label, online, hello: { caps }, suiteClaimStatus: () => ({ session: 's', lastClaim, serving: true, active: 0, waiting: 0 }),
  });
  const pm = { connections: () => [conn('murmur', true, ['suite-pull'], 1234), conn('desk', true, ['offers'], null), conn('far', false, ['suite-pull'], 99)] };
  const offer = { ...RUN_OFFER, peers: [{ name: 'murmur' }, { name: 'desk' }, { name: 'far' }, { name: 'gone' }] };
  const rows = (o, engine) => suiteClaimRows({ getBoxOffer: () => o, getSuiteEngine: () => engine, getPeerManager: () => pm });
  assert.deepStrictEqual(rows(offer, {}), [
    { name: 'murmur', state: 'claiming', lastClaim: 1234 },
    { name: 'desk', state: 'not-connected', lastClaim: null },
    { name: 'far', state: 'not-connected', lastClaim: null },
    { name: 'gone', state: 'not-connected', lastClaim: null },
  ]);
  assert.deepStrictEqual(rows({ ...offer, peers: [{ name: 'murmur' }] }, null), [{ name: 'murmur', state: 'runner-off', lastClaim: null }]);
  assert.deepStrictEqual(rows({ ...offer, scope: 'discovery' }, {}), []);
});
