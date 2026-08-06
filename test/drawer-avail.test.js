'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { termAvailableFor } = require('../renderer/lib/drawer-avail');

// Both exclusions are shipped defects, so each gets a test naming what it did
// rather than asserting a boolean twice.

test('an agent seat gets a terminal', () => {
  assert.strictEqual(termAvailableFor('claude'), true);
  assert.strictEqual(termAvailableFor('codex'), true);
});

test('a bash seat gets no terminal — the session is already a shell', () => {
  assert.strictEqual(termAvailableFor('bash'), false);
});

// The sharp one. A peer seat's key is `name@id`, `@` fails ipc-handlers' seat
// grammar, and a rejected seat becomes null — the SEATLESS workspace shell. So
// before this predicate existed, every peer row in a workspace was handed the
// same local shell, shared with each other and with the no-session drawer.
test('a peer seat gets no terminal — a local shell is not a remote box', () => {
  assert.strictEqual(termAvailableFor('remote'), false);
});

// The seatless drawer is the workspace-wide shell's legitimate home, and it is
// the ONE caller for which a null type is not a missing answer.
test('the seatless drawer keeps the workspace-wide shell', () => {
  assert.strictEqual(termAvailableFor(null), true);
});

// An unknown type must not silently lose its terminal: the exclusions are a
// DENY list on purpose, so a session type added later keeps working and its
// author decides deliberately whether to exclude it.
test('an unrecognized seat type is allowed, not denied by default', () => {
  assert.strictEqual(termAvailableFor('gemini'), true);
});
