'use strict';
// ipc-unscoped-listing.test.js — F012. `ipc-handlers.js` states, in a comment
// beside `session:list`, that no IPC channel may expose an unscoped
// cross-workspace session listing: web-host dispatches any registered channel
// BY NAME without consulting api-contract, so a `manager.list()` handler hands
// an authenticated connection bound to one workspace every workspace's
// sessions. The comment even names the pattern to look for.
//
// It was violated by `session:cwdSuggestions`, registered thirty lines above
// it, calling exactly that. The rule was stated twice — here in code and in
// `.claude/CLAUDE.md` — correct in both places, and owned by nothing. This file
// is the owner. It runs the grep the comment specifies, and pins the behaviour
// the grep cannot see.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'ipc-handlers.js');

// Whole-line comments and trailing `//` comments removed. Deliberately blunt:
// the comment BESIDE the rule quotes `manager.list()` on purpose, so a check
// over the raw bytes can only ever be red.
function stripComments(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

test('no registered IPC channel calls the unscoped manager.list()', () => {
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  // ENTER: the file is the one we think it is, and the stripper is doing work
  // rather than returning an empty string that trivially passes.
  assert.match(src, /`manager\.list\(\)` handler/, 'the rule comment is missing from ipc-handlers.js');
  const code = stripComments(src);
  assert.match(code, /handle\('session:list'/, 'the stripper ate the registration source');
  assert.doesNotMatch(code, /`manager\.list\(\)` handler/, 'the stripper did not remove the rule comment');

  const hits = code
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /manager\.list\s*\(\s*\)/.test(line));

  assert.deepStrictEqual(hits, [],
    'an IPC handler calls the unscoped manager.list() — use manager.listForWorkspace(workspaceOfSender(e)); '
    + `offending lines: ${JSON.stringify(hits)}`);
});

// The grep cannot tell a correctly scoped handler from one that scopes to a
// constant, so the channel that used to violate the rule is pinned by
// behaviour too. Registration-only harness, same shape as
// drawer-services-seam.test.js: a Proxy stubs every dep the registration
// touches, and the four this handler actually needs are real.
function registerAndCapture({ sessions, workspaceOfSender }) {
  const handlers = new Map();
  const capture = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    workspaceOfSender,
    manager: {
      list: () => sessions,
      listForWorkspace: (workspaceId) => sessions.filter((s) => s.workspaceId === workspaceId),
    },
    uiSettings: { get: () => ({ recentCwds: [] }), set: () => {} },
  };
  const stub = () => () => {};
  const deps = new Proxy(capture, {
    get(target, prop) { return prop in target ? target[prop] : stub(); },
    has(target, prop) { return prop in target; },
  });
  require('../ipc-handlers').registerIpcHandlers(deps);
  return handlers;
}

test('session:cwdSuggestions counts only the sender workspace\'s sessions', () => {
  const sessions = [
    { name: 'a', workspaceId: 'ws-1', cwd: '/proj/one' },
    { name: 'b', workspaceId: 'ws-1', cwd: '/proj/one' },
    { name: 'c', workspaceId: 'ws-1', cwd: '/proj/two' },
    { name: 'd', workspaceId: 'ws-2', cwd: '/secret/other-workspace' },
    { name: 'e', workspaceId: 'ws-2', cwd: '/secret/other-workspace' },
    { name: 'f', workspaceId: 'ws-2', cwd: null },
  ];
  const handlers = registerAndCapture({ sessions, workspaceOfSender: (e) => e.workspaceId });
  const handler = handlers.get('session:cwdSuggestions');
  assert.ok(typeof handler === 'function', 'ENTER: session:cwdSuggestions registered');

  const one = handler({ workspaceId: 'ws-1' });
  assert.deepStrictEqual(one.popular, [{ cwd: '/proj/one', count: 2 }, { cwd: '/proj/two', count: 1 }]);

  // The half that matters: ws-2's directories are absent from ws-1's answer.
  // Asserted as the whole array above AND as an explicit absence here, because
  // a handler that returned only the top entry would satisfy a `length` check
  // while still leaking on a differently shaped fixture.
  const two = handler({ workspaceId: 'ws-2' });
  assert.deepStrictEqual(two.popular, [{ cwd: '/secret/other-workspace', count: 2 }]);
  assert.ok(!one.popular.some((p) => p.cwd.startsWith('/secret/')),
    'ws-1 received a cwd belonging to ws-2');

  // An unknown workspace gets nothing, not everything — the failure mode of a
  // scoping bug that falls back to the global list.
  assert.deepStrictEqual(handler({ workspaceId: 'ws-none' }).popular, []);
});
