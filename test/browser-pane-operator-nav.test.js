'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../plugins/browser-pane/replies');
const { createScheduler } = require('../plugins/browser-pane/scheduler');

const CHILD = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'browser-pane', 'child.js'), 'utf8');
const count = (re) => (CHILD.match(re) || []).length;

test('replies: operatorNav is one line naming service, url and title', () => {
  assert.strictEqual(R.operatorNav('utility', 'https://portal.example.com/bills', 'Bills\nJuly'),
    '[agent:browser] the operator navigated utility to https://portal.example.com/bills ("Bills July") — read before using numbers');
  assert.strictEqual(R.operatorNav('utility', 'https://x.com/', ''), '[agent:browser] the operator navigated utility to https://x.com/ ("") — read before using numbers');
});

test('replies: denylist refusals name the url, the pattern and the list', () => {
  assert.strictEqual(R.errorReply(R.TEXT.denied('https://x.com/blocked/1', 'x.com/blocked/*', null)),
    '[agent:browser] error: open refused: https://x.com/blocked/1 matches denylist pattern "x.com/blocked/*" (global) — ask the operator to change the browser pane denylist in Settings');
  assert.strictEqual(R.TEXT.denied('https://x.com/a', 'x.com', 'utility', 'download'),
    'download refused: https://x.com/a matches denylist pattern "x.com" (service utility) — ask the operator to change the browser pane denylist in Settings');
  assert.strictEqual(R.TEXT.deniedBar('x.com', 'utility'), 'Refused: matches denylist pattern "x.com" (service utility)');
  assert.strictEqual(R.TEXT.deniedBar('x.com', null), 'Refused: matches denylist pattern "x.com" (global)');
});

test('child: policyDenies is the one check referenced from every navigation site (9 call sites)', () => {
  assert.strictEqual(count(/policyDenies\(/g), 9, 'open, operator open, address bar, agent back/forward, block, main popup handler, guarded popup handler, viaUrl, will-download');
  assert.strictEqual(count(/(?<!down)loadURL\(/g), 5, 'a new loadURL site must run policyDenies first; then bump this count');
  assert.strictEqual(count(/downloadURL\(/g), 2, 'a new downloadURL site must run policyDenies first; then bump this count');
  assert.strictEqual(count(/'will-download'/g), 1);
  const block = /const block = \(e, url\) => \{[\s\S]*?\n {4}\};/.exec(CHILD);
  assert.ok(block && /policyDenies\(svc, target, 'page'\)/.test(block[0]), 'block runs the policy');
  for (const m of CHILD.matchAll(/\.on\('(will-navigate|will-frame-navigate|will-redirect)', ([^)]+)\)/g)) {
    assert.ok(m[2] === 'block' || m[2] === '(e', `${m[1]} → ${m[2]}`);
  }
  assert.strictEqual(count(/\.on\('will-(navigate|frame-navigate|redirect)', block\)/g), 3);
  assert.ok(/for \(const ev of \['will-navigate', 'will-frame-navigate', 'will-redirect'\]\) pwc\.on\(ev, block\)/.test(CHILD));
  const opens = [...CHILD.matchAll(/setWindowOpenHandler\(([\s\S]{0,90})/g)].map((m) => m[1]);
  assert.strictEqual(opens.length, 3);
  for (const body of opens) assert.ok(/policyDenies\(svc, url, 'page'\)/.test(body) || /^\(\) => \(\{ action: 'deny' \}\)/.test(body), body);
  const router = /ses\.on\('will-download', [\s\S]*?item\.setSavePath/.exec(CHILD);
  assert.ok(router && /policyDenies\(owner, u,/.test(router[0]) && router[0].indexOf('policyDenies') < router[0].indexOf('setSavePath'));
});

test('child: agent back/forward checks the target history entry against the agent policy before it moves, and says NO_HISTORY at either end', () => {
  const nav = /async function opNav\([\s\S]*?\n {2}\}\n/.exec(CHILD);
  assert.ok(nav, 'opNav exists');
  const body = nav[0];
  assert.ok(/h\.getEntryAtIndex\(h\.getActiveIndex\(\) \+ \(dir === 'back' \? -1 : 1\)\)/.test(body));
  assert.ok(/policyDenies\(svc, target, 'agent'\)/.test(body));
  assert.ok(body.indexOf('policyDenies') < body.indexOf('h.goBack()'));
  assert.ok(body.includes("codedError('NO_HISTORY', `NO_HISTORY: nothing to go ${dir} to on ${name}`)"));
  assert.ok(/if \(op === 'nav'\) return opNav\(name, frame, args\);/.test(CHILD));
  assert.ok(/'NO_HISTORY'\]\);/.test(CHILD), 'NO_HISTORY is a code the child passes through');
});

test('scheduler: leaseHolder names the seat holding the lease and null after release', async () => {
  const injected = [];
  const client = { request: async () => ({ status: 200, url: 'https://x.com/', title: 'X', doc: 1, idle: { ok: true, ms: 1 }, login: {} }) };
  const store = { v: 1, services: {} };
  const s = createScheduler({ client, storage: { get: () => store, set: () => {} }, now: () => 1000 });
  const handle = { name: 'seat-a', inject: (t) => injected.push(t) };
  assert.strictEqual(s.leaseHolder('x'), null);
  s.submit(handle, { sub: 'open', service: 'x', url: 'https://x.com/' });
  assert.strictEqual(s.leaseHolder('x'), 'seat-a');
  s.submit(handle, { sub: 'release', service: 'x' });
  assert.strictEqual(s.leaseHolder('x'), null);
});
