'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../src/resources');
const { CliError, EXIT } = require('../src/errors');

function client(routes) {
  const seen = [];
  return {
    seen,
    async get(path) {
      seen.push(path);
      const r = routes[path];
      if (r === undefined) throw new CliError(EXIT.NOTFOUND, `request failed: not found`);
      if (typeof r === 'function') return r();
      return r;
    },
  };
}

const NEW_NODE_DOC = {
  ok: true,
  version: 1,
  resources: [
    { name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get'], subresources: { transcript: ['get'], query: ['post'] } },
    { name: 'workspaces', singular: 'workspace', scope: 'node', verbs: ['list'] },
    { name: 'catalogs', singular: 'catalogs', scope: 'node', verbs: ['get'] },
  ],
};

function newNode(extra = {}) {
  return client({ '/api/resources': NEW_NODE_DOC, '/api/peer/hello': { ok: true, host: 'newbox', version: '5.80.0', caps: ['resources'] }, ...extra });
}

function oldNode(extra = {}) {
  return client({ '/api/peer/hello': { ok: true, host: 'oldbox', version: '5.69.0', caps: ['transcript'] }, ...extra });
}

test('parseTarget: plural, singular, and the TYPE/NAME slash form', () => {
  assert.deepStrictEqual(R.parseTarget(['sessions'], 'get').resource, 'sessions');
  assert.strictEqual(R.parseTarget(['sessions'], 'get').name, null);
  assert.strictEqual(R.parseTarget(['session', 'bob'], 'get').name, 'bob');
  assert.strictEqual(R.parseTarget(['session/bob'], 'get').name, 'bob');
  assert.strictEqual(R.parseTarget(['session/bob'], 'get').resource, 'sessions');
  assert.strictEqual(R.parseTarget(['workspace', 'main'], 'describe').resource, 'workspaces');
  assert.strictEqual(R.parseTarget(['catalogs'], 'get').resource, 'catalogs');
});

test('parseTarget: usage errors name the accepted spellings', () => {
  assert.throws(() => R.parseTarget([], 'get'), (e) => e.exitCode === EXIT.USAGE && /sessions\|session/.test(e.message));
  assert.throws(() => R.parseTarget(['pods'], 'get'), (e) => e.exitCode === EXIT.USAGE && /get pods: "pods" is not a resource — did you mean: get <session\|node\|/.test(e.message));
  assert.throws(() => R.parseTarget(['pods/x'], 'get'), (e) => e.exitCode === EXIT.USAGE && /unknown resource: pods/.test(e.message));
  assert.throws(() => R.parseTarget(['session', 'bob', 'extra'], 'get'), (e) => e.exitCode === EXIT.USAGE && /unexpected argument "extra"/.test(e.message));
  assert.throws(() => R.parseTarget(['session/bob', 'jim'], 'get'), (e) => e.exitCode === EXIT.USAGE && /already carries a name/.test(e.message));
  assert.throws(() => R.parseTarget(['session/'], 'get'), (e) => e.exitCode === EXIT.USAGE && /names no object/.test(e.message));
});

test('requireResource: a served (resource, verb) passes on ONE GET /api/resources', async () => {
  const c = newNode();
  await R.requireResource(c, 'sessions', 'get', 'prod');
  assert.deepStrictEqual(c.seen, ['/api/resources'], 'exactly one round trip, and no hello on the happy path');
});

test('requireResource: an OLD node (404) prints the upgrade line from hello, exit 1', async () => {
  const c = oldNode();
  await assert.rejects(
    () => R.requireResource(c, 'sessions', 'get', 'prod'),
    (e) => {
      assert.strictEqual(e.exitCode, EXIT.SERVER, 'D.5 says exit 1');
      assert.strictEqual(e.message, 'node oldbox (5.69.0) does not serve sessions get; run: clodexctl upgrade node prod');
      return true;
    });
  assert.deepStrictEqual(c.seen, ['/api/resources', '/api/peer/hello']);
});

test('requireResource: a new node that does not carry the verb fails the same way', async () => {
  const doc = { ok: true, version: 1, resources: [{ name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list'], subresources: {} }] };
  const c = client({ '/api/resources': doc, '/api/peer/hello': { ok: true, host: 'halfbox', version: '5.70.0' } });
  await assert.rejects(
    () => R.requireResource(c, 'sessions', 'get', 'half'),
    (e) => e.exitCode === EXIT.SERVER && /does not serve sessions get/.test(e.message));
});

test('requireResource: a resource absent from the document fails the same way', async () => {
  const c = newNode();
  await assert.rejects(
    () => R.requireResource(c, 'worktrees', 'list', 'prod'),
    (e) => e.exitCode === EXIT.SERVER && /does not serve worktrees list/.test(e.message));
});

test('the upgrade line degrades rather than throwing when hello is unreachable too', async () => {
  const c = client({});
  await assert.rejects(
    () => R.requireResource(c, 'sessions', 'get', 'dead'),
    (e) => e.exitCode === EXIT.SERVER && e.message === 'node ? (?) does not serve sessions get; run: clodexctl upgrade node dead');
});

test('a non-404 failure on /api/resources propagates untouched (not read as "too old")', async () => {
  const c = { async get() { throw new CliError(EXIT.AUTH, 'api-resources failed: unauthorized'); } };
  await assert.rejects(
    () => R.requireResource(c, 'sessions', 'get', 'prod'),
    (e) => e.exitCode === EXIT.AUTH, 'a 401 must not be reported as an out-of-date node');
});

test('requireResource: a served SUBRESOURCE verb passes on the same one round trip', async () => {
  const c = newNode();
  await R.requireResource(c, 'sessions', 'get', 'prod', 'transcript');
  await R.requireResource(c, 'sessions', 'post', 'prod', 'query');
  assert.deepStrictEqual(c.seen, ['/api/resources', '/api/resources'], 'one check, one round trip, no hello');
});

test('requireResource: a sessions row WITHOUT the subresource names <resource>/<sub> in the D.5 line', async () => {
  const doc = { ok: true, version: 1, resources: [{ name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get'], subresources: {} }] };
  const c = client({ '/api/resources': doc, '/api/peer/hello': { ok: true, host: 'halfbox', version: '5.70.0' } });
  await assert.rejects(
    () => R.requireResource(c, 'sessions', 'get', 'half', 'transcript'),
    (e) => e.exitCode === EXIT.SERVER
      && e.message === 'node halfbox (5.70.0) does not serve sessions/transcript get; run: clodexctl upgrade node half');
});

test('requireResource: a subresource present with the WRONG verb still fails', async () => {
  const doc = { ok: true, version: 1, resources: [{ name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get'], subresources: { query: ['get'] } }] };
  const c = client({ '/api/resources': doc, '/api/peer/hello': { ok: true, host: 'halfbox', version: '5.70.0' } });
  await assert.rejects(
    () => R.requireResource(c, 'sessions', 'post', 'half', 'query'),
    (e) => /does not serve sessions\/query post/.test(e.message));
});

test('requireResource: an OLD node (no /api/resources at all) fails the subresource check too', async () => {
  const c = oldNode();
  await assert.rejects(
    () => R.requireResource(c, 'sessions', 'get', 'prod', 'transcript'),
    (e) => e.exitCode === EXIT.SERVER && /does not serve sessions\/transcript get/.test(e.message));
});

test('requireResource gates on RESOURCE PRESENCE, never on the document version number', async () => {
  const row = { name: 'sessions', singular: 'session', scope: 'workspace', verbs: ['list', 'get'], subresources: { transcript: ['get'] } };
  for (const version of [1, 2, 99, '2', null, undefined]) {
    const c = client({ '/api/resources': { ok: true, version, resources: [row] }, '/api/peer/hello': { ok: true, host: 'anybox', version: '9.9.9' } });
    await R.requireResource(c, 'sessions', 'get', 'prod');
    await R.requireResource(c, 'sessions', 'get', 'prod', 'transcript');
  }
  const stale = client({ '/api/resources': { ok: true, version: 99, resources: [] }, '/api/peer/hello': { ok: true, host: 'anybox', version: '9.9.9' } });
  await assert.rejects(
    () => R.requireResource(stale, 'sessions', 'get', 'prod'),
    (e) => e.exitCode === EXIT.SERVER && /does not serve sessions get/.test(e.message),
    'a high version number does not buy a resource the document omits');
});

test('ctxLabel names the node the upgrade line tells you to upgrade', () => {
  assert.strictEqual(R.ctxLabel({ name: 'prod' }, {}), 'prod');
  assert.strictEqual(R.ctxLabel({}, { url: 'http://h:1' }), 'http://h:1');
  assert.strictEqual(R.ctxLabel(null, {}), '<ctx>');
  assert.strictEqual(R.ctxLabel({ name: '(flags)', url: 'http://h:2' }, { url: 'http://h:2' }), 'http://h:2');
  assert.strictEqual(R.ctxLabel({ name: '(env)', url: 'http://h:3' }, {}), 'http://h:3');
});
