'use strict';

const { IMPORT_CHUNK_MAX } = require('./seat-import');

const SUITE_PREFIX = '/api/suite/';
const SUITE_SUBMIT_MAX = 256 * 1024;
const SUITE_COMMIT_MAX = 64 * 1024;
const SUITE_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONTENT_RANGE_RE = /^bytes\s+(\d+)-(\d+)\/\*$/i;

const SUITE_VERBS = Object.freeze([
  { verb: 'info', method: 'GET', path: ['info'], body: 'none' },
  { verb: 'poll', method: 'GET', path: ['jobs'], body: 'none' },
  { verb: 'submit', method: 'POST', path: ['jobs'], body: 'json', max: SUITE_SUBMIT_MAX },
  { verb: 'cancel', method: 'DELETE', path: ['jobs', ':id'], body: 'none' },
  { verb: 'putPack', method: 'PUT', path: ['jobs', ':id', 'pack'], body: 'raw', max: IMPORT_CHUNK_MAX },
  { verb: 'commit', method: 'POST', path: ['jobs', ':id', 'commit'], body: 'json', max: SUITE_COMMIT_MAX },
  { verb: 'output', method: 'GET', path: ['jobs', ':id', 'output'], body: 'none' },
].map((row) => Object.freeze({ ...row, path: Object.freeze(row.path) })));

const fail = (status, error) => ({ answer: { status, body: { ok: false, error } } });
const NOT_FOUND = () => fail(404, 'not found');

function decodeSeg(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

function parseJsonObject(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return null; }
  return msg && typeof msg === 'object' ? msg : null;
}

function rowFor(method, segs) {
  return SUITE_VERBS.find((row) => row.method === method
    && row.path.length === segs.length
    && row.path.every((part, i) => part === ':id' || part === segs[i])) || null;
}

function suiteRoute({ method, path, headers } = {}) {
  if (typeof path !== 'string' || !path.startsWith(SUITE_PREFIX)) return NOT_FOUND();
  const q = path.indexOf('?');
  const pathname = q < 0 ? path : path.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : path.slice(q + 1));
  const segs = pathname.slice(SUITE_PREFIX.length).split('/');
  const row = rowFor(method, segs);
  if (!row) return NOT_FOUND();
  const out = { row, query, id: null, offset: null };
  const at = row.path.indexOf(':id');
  if (at >= 0) {
    out.id = decodeSeg(segs[at]);
    if (out.id == null || !SUITE_JOB_ID_RE.test(out.id)) return fail(400, 'bad job id');
  }
  if (row.verb === 'putPack') {
    const range = headers && headers['content-range'];
    const m = CONTENT_RANGE_RE.exec(String(range || '').trim());
    if (!m) return fail(400, 'bad Content-Range (expected bytes <start>-<end>/*)');
    out.offset = Number(m[1]);
    if (!Number.isSafeInteger(out.offset)) return fail(400, 'bad Content-Range start');
  }
  return out;
}

function readJson(row, body) {
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > row.max) return fail(413, 'message too large');
    const msg = parseJsonObject(body);
    return msg ? { msg } : fail(400, 'bad JSON');
  }
  if (!body || typeof body !== 'object') return fail(400, 'bad JSON');
  if (Buffer.byteLength(JSON.stringify(body)) > row.max) return fail(413, 'message too large');
  return { msg: body };
}

function checkBody(row, body, bytes) {
  if (row.body === 'none') return body == null && bytes == null ? {} : fail(400, 'unexpected body');
  if (row.body === 'raw') {
    if (body != null || !Buffer.isBuffer(bytes)) return fail(400, 'expected a byte body');
    if (bytes.length > row.max) return fail(413, `chunk exceeds the ${row.max} byte cap`);
    return {};
  }
  if (bytes != null) return fail(400, 'unexpected byte body');
  return readJson(row, body);
}

function invoke(runner, route, msg, bytes) {
  const { row, id, query } = route;
  switch (row.verb) {
    case 'info': return runner.info();
    case 'poll': {
      const ids = String(query.get('ids') || '').split(',').filter(Boolean);
      const wait = Math.max(0, Number(query.get('wait')) || 0);
      return runner.poll(ids, { wait });
    }
    case 'submit': return runner.submit(msg);
    case 'cancel': return runner.cancel(id);
    case 'putPack': return runner.putPack(id, route.offset, bytes);
    case 'commit': return runner.commit(id, { bytes: msg.bytes, sha256: msg.sha256 });
    case 'output': {
      const opts = { stream: query.get('stream') || 'stdout', offset: Number(query.get('offset')) || 0 };
      if (query.get('length') != null) opts.length = Number(query.get('length')) || 0;
      return runner.output(id, opts);
    }
    default: return null;
  }
}

function suiteDispatch(runner, { method, path, headers, body, bytes } = {}) {
  if (!runner) return Promise.resolve({ status: 501, body: { ok: false, error: 'this node is not a test runner' } });
  const route = suiteRoute({ method, path, headers });
  if (route.answer) return Promise.resolve(route.answer);
  const checked = checkBody(route.row, body, bytes);
  if (checked.answer) return Promise.resolve(checked.answer);
  return Promise.resolve()
    .then(() => invoke(runner, route, checked.msg, bytes))
    .then((out) => ({ status: out && out.ok ? 200 : (out && out.status) || 500, body: out || { ok: false, error: 'no answer' } }))
    .catch((e) => ({ status: 500, body: { ok: false, error: e.message } }));
}

module.exports = { suiteDispatch, suiteRoute, SUITE_VERBS, SUITE_PREFIX, SUITE_SUBMIT_MAX, SUITE_COMMIT_MAX, SUITE_JOB_ID_RE };
