# t53 — the deploy assets' pinned image version

Branch `deploy-version-pin` off master `261b0ab`.

## Test-first, and its failure is on the record

Written and run BEFORE any fix, per the ticket. Pre-fix digest on `261b0ab`:

```
✖ deploy asset pins the app version: cli/deploy/helm/clodex/values.yaml
✖ deploy asset pins the app version: cli/deploy/helm/clodex/Chart.yaml
✖ deploy asset pins the app version: cli/deploy/clodex-fargate.yaml
✔ the helm CHART version is hand-managed, not tied to the app release
ℹ pass 1  ℹ fail 3
```

Each by message, naming both numbers, e.g.

> `cli/deploy/helm/clodex/Chart.yaml (appVersion — the app version this chart
> deploys) pins 3.5.3 but this app is 4.5.0 — deploying from this checkout runs
> a 3.5.3 node, and re-running the deploy would revert an operator's
> hand-upgraded one back to it`

So the window is entered by construction: the test fails on the real drift, on
the real files, before anything was touched.

## (2) Chart.yaml's two version fields — your lean is right, and there is a
## second reason for it

`appVersion` → `$NEW_VERSION`. `version` (the CHART version) stays hand-managed.

The convention reason is the one you gave: `version` moves when the chart's own
structure changes. The reason I would add is mechanical rather than stylistic —
**helm itself reads that field.** It is the identity helm records per release
revision and what `helm history` / `rollback` report. Tying it to the app
release would assert a structural change on every patch, so an operator reading
`helm history` could no longer tell "the chart changed" from "the app was
rebuilt" — the field would still be populated and would have stopped carrying
information. That is worse than leaving it stale: a wrong answer where there
used to be a right one.

The chart is also at `0.1.0`, i.e. it has never been revved. Sweeping it to
4.5.0 would silently claim four majors of chart evolution that did not happen.

Pinned by a fourth test asserting the chart version is NOT the app version, so
the next person adding a sync line has to decide rather than sweep it in.

## Journal

- **Phase 1 — read + test-first.** DONE. Test written, run, fails 3/4 on the
  real drift (above).
- **Phase 2 — release.sh sync + the asset values.** DONE.
- **Phase 3 — revert proofs, full suite, commits, report.** DONE.

## (1) The sync, and why it verifies twice

`sync_pin file anchor want` in `scripts/release.sh`, three calls, inserted after
the bump and the tag-collision check and before the notes/build/commit. It:

1. dies if the file is missing,
2. dies unless the anchor matches **exactly once** (`grep -cE`),
3. `sed -E -i ''` substitutes,
4. dies unless the expected line is then present **exactly once** (`grep -cFx`).

Step 4 is not belt-and-braces. Step 2 catches "the anchor stopped matching";
only step 4 catches "the substitution ran and produced the wrong bytes" — a
mis-escaped replacement, a `|` appearing in a version string, an anchor that
matches a line the replacement does not reproduce. Those fail silently and land
in the commit that the same script then pushes and tags.

`sed -i ''` is the BSD form. The script is macOS-only by construction already
(arm64 DMG + ad-hoc codesign), so that is the right dialect rather than
portability the rest of the file does not have. Noted in the comment so it does
not read as an oversight.

### Exercised against a scratch copy of cli/deploy (not on the repo)

| case | result |
|---|---|
| normal run, 4.x → 9.9.9 | all three pinned; `version: 0.1.0` untouched |
| re-run at the same version | idempotent, still exactly one match |
| anchor removed (`tag: 9.9.9` unquoted) | dies: "anchor matched 0 times, expected exactly 1" |
| anchor duplicated (second `appVersion:` line appended) | dies: "matched 2 times" |

Both failures exit 1 under `set -e` before anything is committed.

## Revert proofs (test file, 3)

| # | reverted | fails | message |
|---|---|---|---|
| A | `values.yaml` tag back to 4.1.0 | that file's test | "pins 4.1.0 but this app is 4.5.0 — … re-running the deploy would revert an operator's hand-upgraded one back to it" |
| B | chart `version:` swept to 4.5.0 | chart-version test | "the chart version now tracks the app version — if that is intended, delete this test and say why" |
| C | `tag:` unquoted (asset restructured) | that file's test | "no line matched the version anchor — … this test can no longer see it" |

C is the one worth having: without it a restructured asset makes the test stop
checking anything and stay green, which is the same silent-no-match failure the
sync's own step 2 guards against. The test and the script fail on the same
condition, by construction — they share the anchor.

## Two things I did NOT do, deliberately

- **No `upgrade` verb, no `--reuse-values`, no contexts.js/deploy.js.** Fenced
  by the ticket; the revert-on-redeploy behaviour is real but it is the
  follow-on.
- **Did not run a release.** The three assets were brought to 4.5.0 by applying
  the same three substitutions by hand, which is what the script would have done
  at the last release. Verified by the test, not by trusting the edit.
