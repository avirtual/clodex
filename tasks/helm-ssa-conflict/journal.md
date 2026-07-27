# t56 — helm SSA conflict: an actionable error and an opt-in remedy

Branch `helm-ssa-conflict` off `0d8b6db` (v4.6.0; clodex's spec said a9804b1,
which is v4.6.0's parent — I branched off the tip so the packaged version pins
match the shipped release. Flagged in the report; trivially rebasable).

## Phase 1 — verification (both of clodex's "I may be wrong" questions)

Everything below is MEASURED against helm v4.1.0 + docker-desktop, not read out
of the docs. Two scratch namespaces were used (`clodexctl-ssa-probe`,
`clodexctl-ssa-probe2`) with a throwaway ConfigMap chart; the operator's real
`clodex` namespace was only ever READ.

### Q1: is `--server-side auto` what our releases actually get? — YES, but it is
### release-scoped, not build-scoped, and clodex is right that it is version-dependent.

`helm get metadata <rel>` exposes `APPLY_METHOD`, and the release record itself
(the `sh.helm.release.v1.*` Secret, gzipped JSON) carries the field verbatim:

| release | APPLY_METHOD |
|---|---|
| operator's live `clodex` rev 1 (installed 2026-07-23, app 3.5.3) | `server-side apply` |
| operator's live `clodex` rev 2 (the failed 4.6.0 upgrade) | `server-side apply` |
| fresh install by helm 4.1.0 | `server-side apply` |
| same record with `apply_method` REMOVED (simulating a helm-3 install) | `client-side apply (defaulted)` |

Decisive experiment: I decoded the probe's release Secret, deleted the
`apply_method` key, re-encoded it, and re-ran a plain `helm upgrade`. `auto`
resolved to **client-side**, the upgrade recorded `client-side apply`, and — the
part that matters — a subsequent `kubectl-edit` hand-edit of the same field
**did not conflict at all**. The upgrade just succeeded and overwrote it.

So the failure is: **releases installed by helm 4.x conflict; releases installed
by helm 3.x and never converted do not.** Same clodexctl build, same chart, same
hand-edit — opposite outcomes, decided by which helm first installed the
release. The error message must therefore not say "helm applies server-side";
it must say server-side apply is what THIS RELEASE uses, which is why the
operator's colleague on an older release never saw this.

### Q2: does `--take-ownership` matter here? — NO. It is a different failure.

Measured on one object with one conflicting field manager, three runs back to
back:

| flags | result |
|---|---|
| (none) | `UPGRADE FAILED: … Apply failed with 1 conflict: conflict with "kubectl-edit" using v1: .data.k` |
| `--take-ownership` | **identical failure, byte for byte** |
| `--force-conflicts` | `STATUS: deployed` — value applied, `kubectl-edit` gone from managedFields |

`--take-ownership` addresses the ADJACENT case, and I hit that one by accident
while setting the probe up: installing a release over an object that already
carries another release's `meta.helm.sh/release-name` annotation fails with
`invalid ownership metadata; annotation validation error`. That is helm's own
bookkeeping check, before the apply. Nothing to do with field managers.

**Decision: `--force-conflicts` only.** Adding `--take-ownership` because it
sounds adjacent would ship a flag that provably does not fix the failure we are
documenting it against.

### Conflict message shapes (both captured live — the test fixtures)

One conflict (singular "conflict with", inline field):

```
Error: UPGRADE FAILED: conflict occurred while applying object clodexctl-ssa-probe2/ssaprobe /v1, Kind=ConfigMap: Apply failed with 1 conflict: conflict with "kubectl-edit" using v1: .data.k
```

Two or more (plural "conflicts with", fields as a bullet LIST on following lines):

```
Error: UPGRADE FAILED: conflict occurred while applying object clodexctl-ssa-probe2/ssaprobe /v1, Kind=ConfigMap: Apply failed with 2 conflicts: conflicts with "kubectl-edit" using v1:
- .data.j
- .data.k
```

The operator's real one (StatefulSet, from the ticket, matches the singular
shape):

```
Error: UPGRADE FAILED: conflict occurred while applying object clodex/clodex apps/v1, Kind=StatefulSet: Apply failed with 1 conflict: conflict with "kubectl-edit" using apps/v1: .spec.template.spec.containers[name="clodex"].image
```

The singular/plural split is the reason the parser must handle both rather than
regex the one sample from the ticket. Note also that helm prints a `level=WARN
msg="upgrade failed"` line with the SAME text JSON-escaped before the `Error:`
line — the parser sees whatever `runVendor` collected, so it must not assume
the string starts at `Error:`.

Multiple field managers on one object is also possible (the live StatefulSet has
three: `helm Apply`, `kubectl-edit Update`, `kube-controller-manager Update`) —
but only conflicting ones appear in the message, and the observed grammar names
exactly one manager per message.

## Cleanup owed

`kubectl delete ns clodexctl-ssa-probe clodexctl-ssa-probe2` before reporting.
The operator's `clodex` namespace must NOT be touched — it holds their real
node, currently in a failed rev 2, which is the bug report.

## Phase 2 — plan (next turn)

1. `helmArgv` gains `forceConflicts = false` → `--force-conflicts` when set.
   Placement: after `--wait`/before nothing that cares; it takes no value.
2. A pure classifier in deploy.js, e.g. `ssaConflictHint(stderr)` → null or a
   rewritten hint. Pure + exported = leaf-testable without a cluster.
3. The `catch` at deploy.js:1669 asks the classifier FIRST; only if it returns
   null does the generic "partial state, re-run" hint apply.
4. `--force-conflicts` flag threaded through `deployHelmVerb` and, in
   upgrade.js, through the helm delegation's flag pass-through.
5. help.js + README in the register the re-run notes already use.

## Phase 2 — implementation (done)

| file | change |
|---|---|
| `cli/src/deploy.js` | `helmArgv` gains `forceConflicts=false` → emits `--force-conflicts`; new pure `ssaConflictHint(stderr,{name,namespace})`; the helm `catch` asks it FIRST and only falls back to the generic partial-state hint; `--json` reason becomes `helm-conflict` for this case; both `helmArgv` call sites (real + `--dry-run` preview) pass `!!flags['force-conflicts']`; `ssaConflictHint` exported |
| `cli/src/main.js` | `force-conflicts` added to the `booleans` list (else `--force-conflicts` would eat the next argv item as its value) |
| `cli/src/upgrade.js` | helm delegation passes `'force-conflicts'` EXPLICITLY rather than relying on the `...flags` spread |
| `cli/src/help.js` | `--force-conflicts` flag row + a 7th note on the `upgrade` entry |
| `cli/README.md` | `deploy helm` usage row gains the flag; a "Field conflicts" bullet after "Failure honesty" |

### Two parse bugs the REAL sample caught (an invented fixture would not have)

Both found by running the classifier against the ticket's verbatim stderr:

1. **`Kind=(\S+)` swallowed the trailing colon** → printed `get statefulset:
   clodex`, a command that does not run. Fixed to `[^\s:,]+`.
2. **The manager regex matched helm's `level=WARN` line first.** helm prints the
   same text JSON-ESCAPED in a WARN line BEFORE `Error:`, so the field came out
   as `...containers[name=\"clodex\"].image"` — with escapes and a stray quote.
   Fixed by parsing a source with `level=` lines stripped. DETECTION still scans
   the full text, so a helm that stops emitting the plain copy degrades to the
   generic details-free hint rather than to no hint.

This is precisely why the spec said "a real helm stderr sample as the fixture,
not an invented one" — an invented fixture would have had neither the WARN
duplicate nor the colon, and both bugs would have shipped green.

### Verified output against the ticket's own sample

The `See every owner:` line it prints is byte-identical to the diagnostic
command clodex ran by hand to find the cause.

## Phase 3 — tests (next turn)

Required pins (spec) + what the above adds:
1. conflict message recognized and rewritten — REAL stderr fixture, singular.
2. plural fixture (the `- field` list), since the grammar differs.
3. the WARN-duplicate must not leak escapes into the parsed field.
4. unrelated helm failure → classifier returns null, generic hint survives.
5. `--force-conflicts` reaches argv for `deploy helm`.
6. …and for `upgrade` (delegation).
7. **ABSENT by default** — both verbs. The pin against "just default it on".
8. degradation: a conflict whose shape we cannot parse still gets what/why/remedy.

## Phase 3 — tests (done): 9 new, all green

`cli/test/helm-ssa-conflict.test.js` (NEW, 6) — the pure classifier:
1. the operator's REAL conflict is recognized + rewritten (manager, field,
   object, why, both halves of the remedy, the controller warning)
2. the parsed field is CLEAN — no `\"` leaking from helm's escaped WARN copy
3. the managedFields command it prints is RUNNABLE (lowercase kind, no colon)
4. the PLURAL grammar (bullet list) parses, and the prose agrees in number
5. unrelated helm failures are NOT claimed — incl. the `--take-ownership`
   annotation error, which must keep its own path
6. an UNPARSEABLE conflict still gets what/why/remedy (degradation)

`cli/test/deploy-helm.test.js` (+3):
7. `helmArgv`: `--force-conflicts` ABSENT by default, present when asked, takes
   no value — the spec's pin against a later "just default it on"
8. `deploy helm`: a conflict REPLACES the re-run hint (asserts `partial state`
   is GONE, which is the whole point)
9. `deploy helm --force-conflicts` reaches the real helm argv; absent without

`cli/test/upgrade.test.js` (+1):
10. `upgrade --force-conflicts` survives the DELEGATION into helm, and is
    absent by default through the spread

(9 test() blocks; #7 and #9 share the deploy-helm file, #10 the upgrade file.)

## Phase 4 — next turn

Revert proofs A–J, each against a pristine copy, failing BY MESSAGE. Then the
window question per test. Then full suite via the test-runner subagent, two
commits (product / tests+journal), report + close.

Cleanup still owed: `kubectl delete ns clodexctl-ssa-probe clodexctl-ssa-probe2`.

## Phase 4 — revert proofs (9, each vs a pristine copy, all failing BY MESSAGE)

| # | reverted | fails with |
|---|---|---|
| A | manager regex tolerates `\"` (matches helm's escaped WARN copy) | "must name the conflicting field" + "no JSON escapes may survive into the hint" |
| B | `Kind=([^\s:,]+)` → `Kind=(\S+)` (swallows the colon) | "must name the object" + "must print a RUNNABLE managedFields query" |
| C | plural bullet-list branch deleted | "BOTH fields must be named: helm moves them onto a bullet list…" |
| D | detection disabled — classifier claims EVERY helm failure | "a --wait TIMEOUT must keep the generic hint…" |
| E | kind not lowercased | "must print a RUNNABLE managedFields query — lowercase kind…" |
| F | `helmArgv` never emits `--force-conflicts` | "it must actually reach argv when asked, or the documented remedy is a no-op" (+2) |
| G | **default flipped to `true`** | "the default helm argv must NOT force conflicts — the flag is opt-in by design" |
| H | `force-conflicts` not declared boolean in main.js | "--force-conflicts must PARSE as a boolean flag…" (both verbs) |
| I | catch site never asks the classifier (`const ssa = null`) | "and the actionable hint must be there" |
| J | real helm call site drops the flag (dry-run keeps it) | "the flag must reach the real helm argv, not just the dry-run preview" (+1) |

### Two things the proofs killed (both would have shipped as decoration)

**1. A dead `level=` line filter.** The first revert I attempted — parse the
full text including helm's WARN line — exited **0**. The filter I had written to
"fix" the escaped-copy bug was never load-bearing: the manager regex requires an
UNESCAPED `"`, and the WARN copy has `\"`, so it already skipped it. I had fixed
one bug two ways and no real sample could distinguish them. Deleted the filter;
the regex is now the documented fix, and revert A (loosening it to accept `\"`)
fails properly. A line no test can kill is a line that is not doing anything.

**2. The explicit `'force-conflicts'` in upgrade.js's delegation.** Revert I as
originally planned — remove it, leave the `...flags` spread — produced **0
failures**. It was a redundant restatement of what the spread already carries,
worded to look load-bearing. Removed, with a comment saying it rides the spread
and is pinned by test. (`force: true` next to it IS restated and IS proven —
different thing, the ctx exists by construction.)

**One assertion restructured, one message set rewritten:**
- The `--force-conflicts` argv assertions crashed under revert H
  (`Cannot read properties of undefined`) instead of failing — helm never ran,
  so `helmArgs` was undefined. Now the exit code is asserted FIRST with the
  cause named, and the argv check is guarded. Re-proved: both fail by message.
- The four "not claimed" `strictEqual(…, null)` checks failed revert D with a
  bare "Expected values to be strictly equal". Each now carries the consequence
  (a timeout release really IS partial and re-running really does fix it).

## Window question — does each test ENTER the window it names?

| test | window | entered? |
|---|---|---|
| real conflict recognized | classifier returns non-null on the ticket's stderr | YES — `assert.ok(hint)` first; reverts A/B fire |
| field is CLEAN | the escaped-copy branch | YES — revert A produces exactly the `\"` output asserted against |
| managedFields command | the `inspect` line construction | YES — reverts B and E each fire on it |
| plural grammar | the bullet-list `else` branch | YES — revert C fires; the singular path cannot reach it |
| unrelated NOT claimed | early `return null` | YES — revert D fires on all five inputs |
| unparseable degradation | detection true, extraction all-null | YES — asserts `another field manager`, only reachable when `who` is null |
| helmArgv default absent | pure builder, no flag | YES — revert G fires |
| conflict replaces re-run hint | the `if (ssa) throw` branch | YES — revert I fires; `doesNotMatch(/partial state/)` |
| flag reaches real helm | the execution call site, not the preview | YES — revert J patches ONLY the real site and it fires |
| upgrade delegation | deployHelmVerb via upgrade | YES — reverts F/H/J all fire through it |
