'use strict';
// helm-ssa-conflict.test.js — t56. A server-side-apply FIELD CONFLICT is the
// one helm failure for which our generic "partial state, fix and re-run" hint
// is actively wrong: re-running the identical command hits the identical wall
// forever, because nothing is partial or transient — another field manager owns
// a field helm needs, and SSA refuses to change a field it does not own.
//
// EVERY stderr fixture below was CAPTURED FROM A REAL helm v4.1.0, not written
// by hand (see tasks/helm-ssa-conflict/journal.md for how). That is not
// ceremony: an invented fixture would have lacked both the trailing colon after
// Kind= and helm's JSON-escaped `level=WARN` duplicate of the same text, and
// the parser shipped green with two bugs against a fixture that lacked them.
const { test } = require('node:test');
const assert = require('node:assert');
const D = require('../src/deploy');

// ── the real fixtures ────────────────────────────────────────────────────────

// The OPERATOR'S OWN failure, verbatim from the ticket: `clodexctl deploy helm
// clodex --namespace clodex` against docker-desktop, after they had upgraded
// the node by hand-editing the StatefulSet's image tag. Note it carries BOTH
// the `level=WARN` line (same text, JSON-escaped) and the plain `Error:` line —
// helm prints both, and what runVendor hands the classifier is whatever the
// child wrote.
const REAL_SINGULAR = [
  'helm upgrade --install failed: level=WARN msg="upgrade failed" name=clodex error="conflict occurred while applying object clodex/clodex apps/v1, Kind=StatefulSet: Apply failed with 1 conflict: conflict with \\"kubectl-edit\\" using apps/v1: .spec.template.spec.containers[name=\\"clodex\\"].image"',
  'Error: UPGRADE FAILED: conflict occurred while applying object clodex/clodex apps/v1, Kind=StatefulSet: Apply failed with 1 conflict: conflict with "kubectl-edit" using apps/v1: .spec.template.spec.containers[name="clodex"].image',
].join('\n');

// TWO conflicting fields — a DIFFERENT grammar, captured live by hand-editing
// two keys of a scratch ConfigMap: plural "conflicts with", and the fields move
// out of the message onto a bullet LIST on the following lines. A parser
// written against the singular sample alone reports zero fields here.
const REAL_PLURAL = [
  'helm upgrade --install failed: Error: UPGRADE FAILED: conflict occurred while applying object clodexctl-ssa-probe2/ssaprobe /v1, Kind=ConfigMap: Apply failed with 2 conflicts: conflicts with "kubectl-edit" using v1:',
  '- .data.j',
  '- .data.k',
].join('\n');

// ── the classifier ───────────────────────────────────────────────────────────

test('ssaConflictHint: the operator\'s real conflict is recognized and rewritten', () => {
  const hint = D.ssaConflictHint(REAL_SINGULAR, { name: 'clodex', namespace: 'clodex' });
  assert.ok(hint, 'the real failure from the ticket must be RECOGNIZED — if this returns null the operator gets the generic hint, which tells them to re-run, which is the one thing that cannot work');

  // WHO owns it and WHICH field — parsed out, because "some manager owns some
  // field" would leave the operator exactly where the raw helm error did.
  assert.match(hint, /"kubectl-edit"/, 'must name the owning field manager');
  assert.match(hint, /\.spec\.template\.spec\.containers\[name="clodex"\]\.image/, 'must name the conflicting field');
  assert.match(hint, /StatefulSet clodex\/clodex/, 'must name the object');

  // WHY, in the terms that make the remedy make sense.
  assert.match(hint, /SERVER-SIDE/, 'must say the release applies server-side — that is why an ownership conflict can block an upgrade at all');
  assert.match(hint, /Re-running the same command will fail the same way/,
    'must CONTRADICT the generic re-run advice explicitly — an operator who has seen "fix and re-run" on every other helm failure will otherwise just re-run');

  // The REMEDY, both halves.
  assert.match(hint, /--force-conflicts/, 'must name the flag that resolves it');
  assert.match(hint, /revert the out-of-band change/, 'and the non-destructive alternative — forcing is not the only way out');
  assert.match(hint, /HPA on replicas|sidecar injector/,
    'and must warn that forcing takes fields from controllers too — that warning is the entire reason the flag is opt-in, so a hint that omits it makes the default look arbitrary');
});

test('ssaConflictHint: the parsed field is CLEAN — helm\'s escaped WARN duplicate must not leak into it', () => {
  const hint = D.ssaConflictHint(REAL_SINGULAR, { name: 'clodex', namespace: 'clodex' });
  // helm prints the same text twice: once JSON-escaped in `level=WARN …`, once
  // plain in `Error: …`. Parsing the escaped copy yields
  // `...containers[name=\"clodex\"].image"` — backslashes and a stray trailing
  // quote. It looks close enough to pass a lazy eyeball and is not a field name
  // any kubectl command will accept.
  assert.doesNotMatch(hint, /\\"/, 'no JSON escapes may survive into the hint — that means the WARN copy was parsed instead of the plain one');
  assert.match(hint, /\.image on StatefulSet/, 'the field must end at .image, with no trailing quote dragged in from the escaped copy');
});

test('ssaConflictHint: the managedFields command it prints is the one that actually diagnoses this', () => {
  const hint = D.ssaConflictHint(REAL_SINGULAR, { name: 'clodex', namespace: 'clodex' });
  // Byte-for-byte the command used to find the cause on the live cluster. The
  // Kind must be lowercased AND must not drag the trailing colon out of
  // `Kind=StatefulSet:` — `kubectl get statefulset: clodex` does not run, and a
  // diagnostic that does not run is worse than none, because the operator
  // concludes the tool is broken rather than that their cluster needs a look.
  assert.match(hint, /kubectl -n clodex get statefulset clodex -o jsonpath='\{range \.metadata\.managedFields\[\*\]\}/,
    'must print a RUNNABLE managedFields query — lowercase kind, no trailing colon');
  assert.doesNotMatch(hint, /get statefulset:/, 'the colon from "Kind=StatefulSet:" must not survive into the command');
});

test('ssaConflictHint: the PLURAL grammar (fields on a bullet list) parses too', () => {
  const hint = D.ssaConflictHint(REAL_PLURAL, {});
  assert.ok(hint, 'a two-conflict failure must be recognized — it is the same wall');
  assert.match(hint, /\.data\.j, \.data\.k/, 'BOTH fields must be named: helm moves them onto a bullet list when there is more than one, so a parser that only reads the inline position silently reports none');
  assert.match(hint, /the fields .* are owned by/, 'and the prose must agree in number');
  // The object still parses with an EMPTY api group (core types print `/v1`).
  assert.match(hint, /ConfigMap clodexctl-ssa-probe2\/ssaprobe/, 'a core-type object (empty group before /v1) must still parse');
});

test('ssaConflictHint: an unrelated helm failure is NOT claimed — the generic hint survives', () => {
  // The classifier is a filter, not a catch-all. If it fired on every helm
  // failure, a genuinely partial release (the timeout below) would be told
  // "re-running will fail the same way" — which is false, and would stop an
  // operator from doing the one thing that fixes it.
  assert.strictEqual(D.ssaConflictHint('Error: UPGRADE FAILED: timed out waiting for the condition', { name: 'n', namespace: 'ns' }), null,
    'a --wait TIMEOUT must keep the generic hint: that release really IS in a partial state and re-running really can fix it, so claiming it would talk the operator out of the one action that works');
  assert.strictEqual(D.ssaConflictHint('Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress', {}), null,
    'a concurrent-operation lock must keep the generic hint — it clears on its own, and re-running is the remedy');
  assert.strictEqual(D.ssaConflictHint('', {}), null, 'an empty stderr must not be classified as a conflict');
  assert.strictEqual(D.ssaConflictHint(undefined, {}), null, 'and neither must a missing one — the caller passes whatever the child wrote');
  // Adjacent but DIFFERENT: helm's own annotation-ownership check. Measured
  // during t56 — `--take-ownership` fixes THIS one and provably does not fix
  // the field conflict (identical failure with and without it), which is why
  // this build ships --force-conflicts alone. Claiming this error would offer
  // the wrong flag for it.
  assert.strictEqual(D.ssaConflictHint('Error: INSTALLATION FAILED: unable to continue with install: ConfigMap "x" in namespace "y" exists and cannot be imported into the current release: invalid ownership metadata; annotation validation error: key "meta.helm.sh/release-name" must equal "b": current value is "a"', {}), null,
    'the ANNOTATION-ownership error is a different failure with a different remedy (--take-ownership, measured); classifying it here would hand the operator --force-conflicts, which provably does not fix it');
});

test('ssaConflictHint: an UNPARSEABLE conflict still gets what/why/remedy', () => {
  // A future helm may reword the details. Detection is deliberately looser than
  // extraction, so the operator keeps the actionable core (this is not
  // transient; --force-conflicts is the remedy) even when we cannot name the
  // manager. A hint that degrades beats a regex that must win.
  const hint = D.ssaConflictHint('Error: UPGRADE FAILED: Apply failed with 3 conflicts: (some future shape)', {});
  assert.ok(hint, 'the conflict must still be recognized when only the count phrasing is intact');
  assert.match(hint, /another field manager/, 'with an honest placeholder rather than a fabricated manager name');
  assert.match(hint, /--force-conflicts/, 'and the remedy, which does not depend on parsing anything');
  assert.match(hint, /Re-running the same command will fail the same way/, 'and the correction of the generic advice');
});
