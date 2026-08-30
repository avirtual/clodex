'use strict';
// The dep names createTicketMethods reads, taken at RUNTIME from the factory
// itself rather than parsed out of the source: the destructure at the top of
// createTicketMethods reads every name it needs before returning, so a Proxy
// standing in for `deps` records exactly the set the module requires. Nothing
// here can drift from what the module actually destructures.
//
// This exists because a missing dep is SILENT. It arrives as `undefined`, and
// the failure that follows is usually swallowed — t574 measured two call sites
// in team-tickets.js whose TypeError lands in a catch that means "no ledger
// yet" and "no scheduler", so a fixture missing them asserted a system it did
// not model while staying green.
//
// Deliberately a SUBSET check and not the deepStrictEqual CLAUDE.md's fixture
// rule reaches for: a fixture is free to inject anything extra it likes (every
// loop fixture injects a dozen deps this factory never reads, for the manager
// around it), so a whole-object pin would fail on every unrelated addition and
// get loosened. This direction fails only when the module starts reading a name
// the fixture does not provide, which is the drift that has actually happened.

const { createTicketMethods } = require('../../team-tickets');

function requiredTicketDeps() {
  const reads = new Set();
  const probe = new Proxy({}, {
    get(_t, k) { if (typeof k === 'string') reads.add(k); return undefined; },
    has: () => true,
  });
  createTicketMethods(probe, {});
  return reads;
}

// `assert` is passed in rather than required here so a failure is reported
// against the calling fixture's file.
function assertTicketDepsCovered(assert, deps, { optional = [] } = {}) {
  const required = requiredTicketDeps();
  assert.ok(required.size > 20,
    `ENTER: only ${required.size} dep names came back from the factory probe — the destructure moved and this guard is measuring nothing`);
  for (const anchor of ['AGENT_NAME_RE', 'getPersistence', 'gitWorktree']) {
    assert.ok(required.has(anchor), `ENTER: ${anchor} missing from the probe — the factory did not run`);
  }
  const exempt = new Set(optional);
  const missing = [...required].filter((n) => !exempt.has(n) && !(n in deps)).sort();
  assert.deepStrictEqual(missing, [],
    `team-tickets.js reads these deps and this fixture does not inject them: ${missing.join(', ')}. `
    + 'They arrive as `undefined`, and the throw is swallowed on several paths — wire the real value, '
    + 'or add the name to `optional` with the reason it is deliberately absent.');
}

module.exports = { requiredTicketDeps, assertTicketDepsCovered };
