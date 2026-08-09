'use strict';
// renderer-events-figures.test.js — F009. The two headline figures in
// docs/renderer-events.md, pinned to the file they are derived from.
//
// This is the ONE place in the doc corpus where a test is the right remedy, and
// the bar it had to clear is worth stating so the next person does not pin
// twenty more:
//
//   - LOAD-BEARING. They are the opening sentence of the document that defines
//     the browser contract, and a reader sizing the web-host port makes a
//     different decision if "165" is really 196.
//   - CHEAP AND STABLE to derive. One require, two row-kind counts. A doc test
//     that reaches into rendering or formatting fails for everyone on every
//     unrelated change, which is worse than a stale number because it taxes
//     people who did nothing wrong.
//   - SELF-CHECKING. invoke + send + on equals the contract's total row count,
//     so a single misreading of the file cannot move both figures in a way that
//     still adds up. Both headline numbers were wrong together before, in the
//     doc's first nine lines, precisely because they share a derivation.
//
// Every other stale figure F009 found got the cheaper remedy — the number was
// deleted or narrowed and the deriving command written beside the claim —
// because a count nobody quotes does not earn a test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const contract = require('../api-contract');
const DOC = path.join(__dirname, '..', 'docs', 'renderer-events.md');

// api-contract.js exports the rows under one of a few plausible names; resolve
// it structurally rather than pinning an export name this test does not own.
function rows() {
  for (const v of [contract, ...Object.values(contract)]) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'kind' in v[0]) return v;
  }
  throw new Error('api-contract.js: could not find the row array (shape changed?)');
}

const byKind = (k) => rows().filter((r) => r.kind === k).length;

test('renderer-events.md: the endpoint and channel counts match api-contract.js', () => {
  const invoke = byKind('invoke');
  const send = byKind('send');
  const on = byKind('on');
  const doc = fs.readFileSync(DOC, 'utf-8');

  // The arithmetic closes on itself: if it does not, the row array is not what
  // this test thinks it is and the two assertions below would be meaningless.
  assert.strictEqual(invoke + send + on, rows().length,
    'invoke + send + on must account for every contract row');

  const endpoints = invoke + send;
  assert.match(doc, new RegExp(`request half of \`window\\.api\` \\(${endpoints} endpoints\\)`),
    `docs/renderer-events.md:4 must say ${endpoints} endpoints (invoke ${invoke} + send ${send}). `
    + 'This is the opening claim of the browser-contract doc; update the sentence, not this test.');

  assert.match(doc, new RegExp(`\`preload\\.js\` \\(${on} channels\\)`),
    `docs/renderer-events.md:9 must say ${on} channels. Update the sentence, not this test.`);
});

// F006. Not a figure — a citation. The doc's interception model quotes a banner
// out of session-manager.js by name and in quotes, and that header had been
// deleted, so the doc pointed a reader at a heading that was not there. Prose
// cannot be pinned, but its ANCHOR can: this asserts only that the quoted string
// still names something real, which is the failure that actually happened.
test('renderer-events.md: the session-manager.js header it quotes exists', () => {
  const BANNER = 'WINDOW BRIDGE / opaque-handle contract';
  const doc = fs.readFileSync(DOC, 'utf-8');
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf-8');

  // The doc is hard-wrapped, so the quoted banner can straddle a line break —
  // compare with whitespace collapsed or this asserts the wrap, not the quote.
  const flat = (s) => s.replace(/\s+/g, ' ');
  assert.ok(flat(doc).includes(BANNER), 'this test is only warranted while the doc quotes the banner');
  assert.ok(src.includes(BANNER),
    `session-manager.js must contain the banner "${BANNER}" — docs/renderer-events.md quotes it `
    + 'verbatim as the source for the five-method handle contract. Renaming the header means '
    + 'updating that citation in the same change.');
});
