# t54 — two prerequisites for `clodexctl upgrade <ctx>`

Branch `deploy-upgrade-plumbing` off master `9fb3aba`.

## Phase 1 — read + verify the helm semantics (DONE)

### Your `--reuse-values` read is right, and I checked it rather than took it

Local helm is `v4.1.0`. `helm upgrade --help`:

> `--reuse-values` … when upgrading, reuse the last release's values and merge
> in any overrides from the command line via `--set` and `-f`.
>
> `--reset-then-reuse-values` … reset the values to the ones built into the
> chart, apply the last release's values and merge in any overrides …

The second flag's existence *is* the proof of the first flag's defect: it
exists only because `--reuse-values` does NOT re-read chart defaults. So with
`--reuse-values`, a chart whose default `image.tag` moved 4.5.0 → 4.6.0 would
keep deploying 4.5.0 — t53's authoritative pin ignored, by exactly the route
you named. Confirmed, not assumed.

`--reset-then-reuse-values` would be semantically right but it is helm ≥3.14,
and we do not control the operator's helm. So your lean stands on its own
merits too.

### Your read-back lean is right; I checked the one thing it depends on

`helm get values --help` confirms `-a, --all  dump all (computed) values` —
so plain `helm get values` is USER-SUPPLIED ONLY, which is the set we want.
`-o json` gives us a parseable blob; an override-free release renders as
`null`, which the parse must tolerate.

Two things the lean does NOT say, which I have to decide (and did):

**(a) Secrets must be stripped from the carried set.** `--set-file
secrets.wireToken=…` makes the token part of the release's USER-SUPPLIED
values, so `helm get values` hands the token value straight back. Carrying it
into a temp values file and then LOGGING what we carried would break this
verb's binding rule ("the token VALUE never enters argv, markers, logs or
errors"). It would also set up a second, competing source for a value the
Secret read-back already owns authoritatively. So: `secrets.*` is dropped from
the carried set, and the code says why.

**(b) Precedence must apply to what we DERIVE from values, not just to what we
hand helm.** Two values are read back out of the run's own flags today and
used to build the ctx entry:

| derived | from | breaks how |
|---|---|---|
| `port` → `remotePort` | `--port`, else DEFAULT_PORT | operator deployed `--port 8100`; flagless re-run now KEEPS 8100 in the release (carried) but would save a ctx with no `remotePort` → the transport port-forwards to 7900, a port the release does not serve |
| `webEnabled` → `webPort` | this run's `--set web.enabled=` | operator set `web.enabled=false`; flagless re-run keeps web off (carried) but would save `webPort: 8080` for a Service that publishes nothing |

Both are NEW inconsistencies introduced by the carry-forward — today the
silent revert keeps release and ctx accidentally consistent by resetting both.
So the carried values feed the same three-layer precedence:
chart default < carried < this run's flag. That is the half of "get the
consequences right" that is easy to miss, because the carry-forward looks
finished once helm gets the file.

### Where the carried file goes in the argv

helm merges `--values` files left-to-right (later wins) and applies `--set`
*after* all of them regardless of argv order. So:

- the carried file must be the **first** `--values`, ahead of the operator's
  own `-f` files — otherwise a carried value would beat a file passed on THIS
  run, inverting the precedence;
- `--set` beating the carried file is helm's own rule, not our ordering.

Both directions get a test; the ordering one would pass trivially if written
carelessly, so it asserts the carried file's index is *less* than the
operator's.

### Read failure is a hard error, deliberately

`helm get values` failing after `helm status` succeeded is anomalous. Falling
through to "no carried values" would silently revert — the exact defect. Hard
error, matching the local idiom two dozen lines away (the Secret read-back at
:1451 hard-errors for the same reason).

## Phase 2 — Part B shape (design)

`deploy: { flavor, …identifying names }` — a top-level sibling on the context
entry. DATA only: flavor from a fixed enum, plus scalar names. Arrays and
nested objects are REJECTED on read, which is the mechanical form of "never a
persisted argv" — an argv is an array, so the shape check refuses it.

| flavor | names | save site |
|---|---|---|
| `ssh` | `host` | deploy.js:383 |
| `docker` | `container`, `host?` | deploy.js:599 |
| `ssm` | `target`, `region?`, `profile?` | deploy.js:1213 |
| `helm` | `release`, `namespace`, `kubeContext` | deploy.js:1513 |
| `fargate` | `stack`, `region?`, `profile?` | deploy.js:2002 |

`deploy.js:563` is the docker *verify* ctx (never persisted) — not a save site;
:599 is the persisted one.

The ambiguity this exists to kill: ssh saves `{ssh: dest}` and remote-docker
saves `{ssh: sshDest}`. Identical transport, different flavor. Pinned by a test.

**Forward-compat trade, stated because contexts.js claims the opposite for
kind-object fields:** validating the enum means a context written by a NEWER
clodexctl carrying a flavor this build does not know is REJECTED — for every
verb, not just upgrade. I am taking that because the field's whole purpose is
to route an execution path, and a value we cannot route is one we must refuse
to carry. Flagged to clodex rather than decided silently.

## Journal

- **Phase 1 — read + semantics check.** DONE (above).
- **Phase 2 — Part A: carry-forward + precedence + help.js:285.** DONE.
  - `helmGetValuesArgs` (no `-a`), `parseCarriedValues` + `HELM_NEVER_CARRY`
    (drops `secrets`), both exported.
  - `helmArgv` gained `carriedValuesFile`, emitted BEFORE `valuesFiles`.
  - Step 2b in `deployHelmVerb`: read-back (hard error on failure), log the
    carried + dropped key names, then apply precedence to the two DERIVED
    values (`port` via `portFlagged`, `webEnabled` via `webEnabledFlag`).
  - Carried file is JSON in the existing 0600 tempdir, same `finally` cleanup.
  - Merge order verified empirically on helm v4.1.0 with `helm template`:
    later `--values` wins; `--set` beats files regardless of argv position.
  - `help.js:285` rewritten; `--dry-run` gained a line (the cluster is not
    touched on dry-run, so it states the behaviour without listing keys).
- **Phase 3 — Part B: the flavor record + validation + save sites.** DONE.
  - `contexts.js`: `DEPLOY_FLAVORS` + `validateDeploy`, called from
    `validateEntry` only when `entry.deploy != null`. Both exported.
  - Save sites: `:387` ssh, `:604` docker (both arms, one `dep` const),
    `:1232` ssm, `:1693` helm, `:2185` fargate. The helm `--dry-run` preview
    entry got the field too, with `kubeContext: null` when unflagged (it is
    resolved only in the preflight, which dry-run never reaches).
  - Two field choices that differ from the plan, both because the plan's name
    was the less honest one:
    - docker stores `dockerHost` (the normalized DOCKER_HOST), not the ssh
      dest — a `tcp://` daemon has no ssh dest, so `host` would have been
      empty exactly where it is load-bearing.
    - helm stores `release` even though it equals the ctx key today. The
      identity an upgrade addresses must not depend on the key staying equal
      to it; a ctx rename would otherwise silently retarget the upgrade.

  **The scalar rule is doing the work the constraint asks for.** `validateDeploy`
  rejects any non-scalar field value, so an argv (array) and a flag blob
  (object) are refused by the SHAPE, not by a naming convention someone has to
  remember. There is no spelling of "the command line we ran" that fits.
- **Phase 4 — tests, revert proofs, window question, full suite, commits.**
  IN PROGRESS: tests written, 9 reverts proven, window question asked.

## Revert proofs (9, all restored from a pristine scratchpad copy between runs)

| # | reverted | fails | message |
|---|---|---|---|
| A | drop `carriedValuesFile` from the argv | 3 tests | "exactly one carried-values file · 0 !== 1" |
| B | carried file AFTER the operator's `--values` | precedence-2 | "must precede the operator's own --values (got carried@15, operator@13) — later files win…" |
| C | `HELM_NEVER_CARRY = []` | 2 tests | "the token value never reaches a file we wrote from values" |
| D | derived port/webEnabled ignore carried values | ctx-precedence | "the ctx must name the port the release actually serves, not the default the flags fell back to" |
| E | get-values failure falls back silently | hard-error | "exit 0 means the run continued and deployed a value set with every operator override missing…" |
| F | `helm get values -a` | argv | "must NEVER ask for the computed set (-a/--all)…" |
| G | `validateDeploy` not called from `validateEntry` | 2 tests | "Missing expected exception: an off-enum flavor must be REJECTED on read…" |
| H | scalar rule deleted | argv test | "Missing expected exception: a persisted ARGV was accepted…" |
| I | docker save site stamps `flavor: 'ssh'` | ambiguity pin | "these two entries have IDENTICAL transports, so a wrong or missing flavor here means an upgrade would re-run the ssh installer against a container node" |

**Three assertions were rewritten because the proof exposed them, not because
they failed.** E failed as a bare `0 !== 1`; F's exact-argv `deepStrictEqual`
fired before the `-a` check, so the reader got "these arrays differ" instead of
the reason; G/H's `assert.throws` said only "Missing expected exception". A
passing revert proof with an unreadable message is half the bar — it proves the
test fires, not that the next person will know why. Fixed by adding real
messages and by moving F's semantic check ahead of its equality check.

## The window question, asked separately per test

The proof above shows each test FIRES. This asks whether it enters the
situation it claims to be about — the question that has caught nine blind
tests on this project.

| test | window it names | does it enter? |
|---|---|---|
| prior override SURVIVES | a re-run of a release that HAS overrides | yes — `releaseExists: true` AND `priorValues` non-empty, and the assertion is on the FILE'S BYTES, not on the flag's presence. A `--values` pointing at `{}` would satisfy "a file was passed" and still revert everything; asserting the parsed body is what closes that. |
| flag BEATS carried | both a carried value and a conflicting flag, live at once | yes — priorValues sets `image.tag=4.5.0` while `--set image.tag=4.6.0` is passed, so the two really do collide. The ordering half asserts the INDEX, because "both files are present" is equally true in the broken order (revert B is exactly that, and it fails). |
| carried port/web → ctx | a carried value that the ctx DERIVES from | yes, and this is the window I nearly missed: the carry-forward looks finished once helm has the file. The test reads the SAVED CTX, not the argv, which is the only place the derived-value bug is visible. |
| hard error on unreadable | the read-back failing on a release that exists | yes — `getValuesFail` fires only on the `helm get values` branch, and `helm status` still succeeds, so the code is inside the "release exists, carry forward" arm when it fails. It also asserts helm NEVER RAN and no ctx was written, so a run that failed later for another reason could not pass it. |
| secrets not re-applied | a release whose values legitimately contain the token | yes — `priorValues` includes `secrets.wireToken` with the SAME value the Secret hands back, which is what a real `helm get values` returns for any release this verb installed. Not a synthetic key. |
| fresh install: no read-back | `releaseExists: false` | yes, and it is the negative control for the arm above: it asserts `get values` was never called at all, so a read-back that ran unconditionally would fail here rather than pass everywhere. |
| ssh vs docker ambiguity | two real deploys colliding in one store | yes — it runs BOTH real verbs into ONE contexts file and asserts the collision as a PREMISE (`a.ssh === b.ssh`) before asserting the distinction. If the transports ever stopped colliding, the premise fails and the test says the field is less load-bearing, instead of passing vacuously. |
| argv rejected | a `deploy` record containing an actual argv array | yes — the array is a real `['helm','upgrade','--install','n']`, not a placeholder, and there is a sibling case for the object-blob spelling one indirection away. |
| enum checked on read | a flavor no build can route | yes — `'kubernetes'` is the plausible wrong answer (someone hand-editing), not a nonsense string. |
