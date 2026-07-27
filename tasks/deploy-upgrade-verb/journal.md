# t55 — `clodexctl upgrade <ctx>` (+ the t54 enum correction)

Branch `deploy-upgrade-verb` off master `55ed80d`.

## Phase 1 — read + design (this file)

### Part A — the enum check comes out, and I agree with the reasoning

I flagged the forward-compat trade in t54 and clodex overturned it on blast
radius, not posture: `validateEntry` gates EVERY verb, so rejecting an unknown
flavor kills `sessions`/`web`/`ctx test` against a node that is up and whose
TRANSPORT this build understands perfectly. The advisory field is read by one
verb; the refusal landed on all of them.

The partition to hold:

| rule | stays / goes | why |
|---|---|---|
| `deploy` must be an object | STAYS | shape |
| every field a scalar (no arrays, no nested objects) | STAYS | this is what makes DATA-not-CODE mechanical — an argv is an array |
| `flavor` present, non-empty, a STRING | STAYS | a deploy record with no usable flavor is malformed, not forward-compatible |
| `flavor` ∈ `DEPLOY_FLAVORS` | GOES | advisory; `upgrade` refuses to route it, naming the flavor |

`DEPLOY_FLAVORS` stays in contexts.js only as the list the "needs a flavor"
message names. The routing enum lives in upgrade.js, where the verb that
needs it is.

### Part B — shape: `upgrade` is THIN, and delegates

The important realisation. The helm upgrade arm is `deployHelmVerb` minus the
fresh-install path: token read-back + oauth preservation + carry-forward +
tempfile staging + verify + ctx upsert are all already there and all correct
for an upgrade. Re-implementing them in upgrade.js would be a second copy of
the most security-sensitive code in the CLI, drifting from the day it lands.

So `upgrade` does the four things `deploy` cannot do, then DELEGATES:

1. route on `entry.deploy.flavor` (never on the transport);
2. refuse to create — probe existence FIRST, so the deploy verb it delegates
   to can never reach its install path;
3. report FROM → TO and no-op when equal;
4. force the image pin EXPLICIT, which is the whole point of the verb.

| flavor | delegate | pin passed | existence probe |
|---|---|---|---|
| helm | `deployHelmVerb` | `--set image.tag=TO` (helm applies `--set` after every values file, so it beats a carried `image.tag` by helm's own rule — t54) | `helm status` |
| fargate | `deployFargateVerb` | `image: TO` → `ImageUri=TO` in the parameter overrides, ALWAYS | `describe-stacks` |
| ssh | `deployVerb` | none possible (see below) | hello probe |
| docker | REFUSED | — | — |
| ssm | decided in phase 2 | | |

`--force` is threaded into every delegation: the ctx exists by construction
(it is how we found the node), so without it the deploy verb would decline to
update its own entry.

### Version FROM / TO

- **FROM** = `hello.version` over the ctx's real transport. The honest "what is
  actually running"; never persisted, so never stale.
  A probe FAILURE does not block: warn, skip the comparison, proceed. Refusing
  there would block the upgrade that fixes an unreachable node, and an upgrade
  to the version already running is idempotent — so proceeding is the
  recoverable direction and skipping is not.
- **TO** = the PACKAGED asset pin, read from the asset itself rather than from
  package.json: `cli/deploy/helm/clodex/values.yaml` (`image.tag`) and
  `cli/deploy/clodex-fargate.yaml` (`ImageUri` Default). The asset is what
  actually deploys; if it ever drifted from package.json, the asset is the
  truth. Both readers use the SAME anchors `scripts/release.sh:sync_pin` edits,
  so a restructure that breaks the sync breaks these too, loudly.
- **ssh has no knowable TO.** The installer clones `<repo>@<branch>` and builds
  the tip; there is no pin to read. So the ssh arm reports FROM, states that TO
  is whatever the branch currently builds, and NEVER no-ops. Saying "no
  target version — the installer tracks the branch" is honest; inventing one
  from package.json would not be.

### `--force` on the no-op

`no-op when equal` exits OK. `--force` re-runs anyway (it is already threaded
down for the ctx overwrite, so it is one flag with one meaning: "do it even
though I said I would not need to").

## Phase 2 — the two flavors clodex left to me

### docker — REFUSED, and the reason is secrets, not effort

Two independent blockers, either sufficient:

1. **The run arguments are not stored, and they are not recoverable.**
   `deploy docker` takes `--env-file`, `--volume`, `--port`, `--tag/--image`,
   `--no-wirescope`. t54 stored `container` + `dockerHost` — the IDENTITY, per
   the DATA-not-CODE rule. A recreate without the operator's `--env-file` and
   extra `-v` produces a container that boots with no credentials and none of
   its mounts: a node that looks upgraded and is broken.
2. **Recovering them from `docker inspect` would put secret VALUES in argv.**
   The env file exists precisely because secrets must not cross argv — docker
   reads it itself, we never open it (deploy.js:411). `docker inspect` returns
   `Config.Env` with the values RESOLVED, so reconstructing the run would mean
   spelling each one into a `-e KEY=VALUE`. That is the exact line this
   subsystem does not cross, and no amount of care makes it safe.

Add that upgrade there is inherently destructive (`docker rm -f` + re-run — the
verb hard-fails on a duplicate container name), and a refusal is not a
half-measure but the right answer. The message names the two-step path and the
flags only the operator holds.

### ssm — SUPPORTED, with the token rotation stated LOUDLY

The installer is idempotent and re-runnable exactly like ssh, and t54 already
stored the `target`/`region`/`profile` a re-run needs — that is the field
doing its job. Refusing would send the operator to `deploy ssm --target …`,
which does *the identical thing*; a refusal pointing at a command with the same
effects is theatre, not honesty.

But one difference from every other flavor must be said out loud: **`deploy
ssm` MINTS A FRESH WIRE TOKEN on every run** (deploy.js:1145) and the installer
writes it to the box. helm reuses the release's token, fargate never rewrites
the stack's, ssh has none. So an ssm upgrade ROTATES the token. Our own ctx is
rewritten with the new one (upgrade threads `--force`, without which the ctx
save is skipped and the ctx would keep a token the box no longer accepts), but
any OTHER holder — a second operator's context, a GUI peer row, a script —
breaks. Stated before acting and repeated in `--dry-run`. That is the same
"say what changes, don't do it silently" rule clodex set for ssh's flags.

### What each flavor carries forward, and what reverts

| flavor | carried by upgrade | reverts (SAID, not silently) |
|---|---|---|
| helm | everything — t54's `helm get values` carry-forward runs inside the delegate | nothing |
| fargate | CFN reuses prior stack parameters for anything not overridden | nothing, except that ImageUri is now FORCED (which is the fix) |
| ssh | `remotePort` → `--port` (stored, so recoverable) | `--no-wirescope`, `--repo`, `--branch`, `--src`, `--ssh-opt`, `--claude-token-file` — none are stored; pass them again on the upgrade if you set them at deploy time |
| ssm | `target`, `region`, `profile`, `remotePort` → flags | `--no-wirescope`, `--repo`, `--branch`, `--claude-token-file`; plus the wire token ROTATES |

Carrying `remotePort` is the t54 lesson applied: a flagless re-run would
reinstall on 7900 while the ctx says 8100, and the transport would then
port-forward to a port nothing serves.

## Phase 3 — implementation

- `cli/src/contexts.js` — Part A: enum membership out, shape rules in (object,
  scalars only, `flavor` present + non-empty + STRING). The string check is new:
  the old code did `String(dep.flavor) === ''`, which accepted `7` and would
  have handed a consumer a number to compare against flavor names.
- `cli/src/upgrade.js` — the verb. Routes, refuses to create, reports FROM→TO,
  forces the pin, delegates. `--force` is threaded into every delegation: the
  ctx exists by construction (it is how we found the node), so without it the
  deploy verb would decline to update its own entry.
- `cli/src/main.js` — SPECIAL_VERBS + the dispatch if-chain.
- `cli/src/help.js` — the VERB_REGISTRY entry (help.test.js pins the registry
  against TOP_VERBS, so this could not have shipped without it).

Two things I got wrong and fixed while building:

1. **Two fargate tests initially failed with a `TypeError`, not an assertion.**
   I had set FROM to `4.5.0` — which IS the packaged pin — so both rode the
   no-op path, `rec.deployArgs` was never set, and the test asserted nothing
   about the argv while looking like it did. The fixture now uses a FROM that
   differs, with a comment saying why. Worth recording because it is the same
   failure mode the window question exists to catch, and it caught itself only
   because the assertion crashed rather than passing vacuously.
2. **The fargate arm needed more carried forward than the spec named.**
   `fargateParamOverrides` ALWAYS emits ClusterName and Persistent, and the
   deploy verb auto-detects subnets/SG from the DEFAULT VPC when those flags
   are absent. So a flagless delegation would have overwritten four settings
   CloudFormation would otherwise have kept — worst case moving a custom-VPC
   task onto default-VPC subnets. This is the fargate shape of t54's
   derived-values lesson, and it gets its own test.

## Phase 4 — revert proofs (10, pristine restored between every one)

| # | reverted | fails | message |
|---|---|---|---|
| A | the missing-flavor refusal | pre-t54 ctx | "a pre-t54 context must be refused by NAME — an ssh deploy and a remote docker deploy save identical transports…" |
| B | the `UPGRADABLE` membership check | unknown flavor | "the refusal must NAME the flavor it cannot route…" |
| C | the docker `KNOWN_UNSUPPORTED` branch | docker refusal | "the refusal must name the run arguments that are not stored…" |
| D | helm's not-found refuse-to-create | helm create | "an upgrade against a release that is not there must FAIL — installing silently would turn a typo'd ctx name into a surprise deployment" |
| E | the `from===to` no-op block | no-op | "the no-op must not run helm at all — a 'no-op' that still redeploys is just an upgrade with a reassuring message…" |
| F | fargate `image` only when it DIFFERS from prior | BOTH ImageUri pins | "ImageUri was NOT passed — CloudFormation then reuses the prior stack value and --no-fail-on-empty-changeset reports SUCCESS…" |
| G | fargate subnets/SG carry-forward | networking (+2 collateral) | "the stack's own subnets must be carried forward — auto-detecting instead would move the task into the default VPC…" |
| H | the helm `pin` dropped from `sets` | both explicit-pin tests | "the requested version must reach helm as an EXPLICIT --set — this is the entire point of the verb" |
| I | the ssm rotation warning | rotation | "an ssm upgrade ROTATES the wire token — the one consequence that differs from every other flavor…" |
| J | contexts.js enum membership RE-ADDED | inverted contexts test | "Got unwanted exception: a flavor this build cannot route must still be STORED and carried…" |

**Four assertions were restructured because the proof exposed them.** A, B, D
and E each failed as a bare `2 !== 0` / `0 !== 2` — which proves the test fires
but tells the next reader only that something changed. In all four the exit-code
equality was running BEFORE the message match. Fixed by asserting the message
(and for E, the consequence — "helm never ran") first and the code last, with a
line saying why. Re-proven after the change; all four now fail by message.

Revert F deserves its own note: it is the defect clodex singled out, and the
reverted form is the one a reasonable person would write ("don't pass an
override that wouldn't change anything"). It passes every other test in the
file. Only the second ImageUri test — where target and prior are deliberately
EQUAL — separates them.

## The window question, asked separately per test

| test | window it names | does it enter? |
|---|---|---|
| ImageUri always | a fargate upgrade that actually reaches the delegate | yes, and it did NOT at first — FROM equalled the packaged pin, so it no-op'd and asserted nothing. The fixture now forces FROM≠TO, and the assertion reads `rec.deployArgs`, which only exists if `cloudformation deploy` really ran. |
| ImageUri when equal | prior ImageUri === target, the case the plausible wrong fix survives | yes — `params.ImageUri` is set to the packaged pin exactly, and `--force` is what gets past the version no-op so the delegate is still reached. Without `--force` this test would silently become the no-op test. |
| helm --tag beats carried | a carried `image.tag` and a conflicting `--tag`, live at once | yes — `priorValues` really returns `{image:{tag:'4.5.0'}}` (so t54's carry-forward runs and writes a values file) while `--tag 4.9.9` is passed. It asserts BOTH that the pin is present AND that the carried file is still there — a test asserting only the pin would pass if the carry-forward had been silently discarded. |
| no-op when equal | a node already at the target | yes — FROM is read from `helmPinnedTag()` itself rather than a literal, so it cannot drift out of the window when the version bumps. Asserts helm NEVER RAN, which is the property; the message alone could be printed by a run that then upgraded anyway. |
| helm refuse-to-create | `helm status` saying not-found on a ctx that otherwise looks fine | yes — the ctx entry is a complete, valid helm context, so the ONLY thing making this a refusal is the probe. It also asserts helm upgrade never ran, so a refusal that arrived after the delegate started would fail. |
| fargate refuse-to-create | describe-stacks returning ValidationError | yes — the real AWS "does not exist" stderr shape, matched by the same regex undeploy.js uses. Asserts `deployArgs` unset. |
| ssh unconfirmed node | a probe that FAILS, without --force | yes — `probeVersion` throws, and `spawnFn` throws too, so an implementation that proceeded would fail loudly rather than pass quietly. |
| ssh reverts named | an upgrade whose flags genuinely will not survive | yes — it names all six in one assertion, so dropping any one of them from the message fails. |
| ssm rotation | the one flavor that rotates | yes, and it asserts ORDER (`warnAt < planAt`), not just presence. A warning printed after the plan would satisfy a presence-only test and be useless to the operator. |
| unknown flavor at upgrade | a flavor contexts.js now happily stores | yes — the ctx is loaded through the real store, so it only reaches upgrade because Part A lets it through. The two tests are the two halves of one rule and they would break together. |
| pre-t54 ctx | a context with no `deploy` at all | yes — a plain `{ssh, webPort}` entry, byte-identical to what pre-t54 clodexctl wrote. |
| docker refusal | a real docker ctx with a stored dockerHost | yes — the asserted commands interpolate that stored host, so a refusal that printed a generic message would fail. |
| fargate networking | a stack whose subnets are NOT the default VPC's | yes — `subnet-private-1`/`sg-locked` are deliberately not what auto-detect would return, and the test also asserts `describe-vpcs` was never called: without that, a run that auto-detected and coincidentally matched would pass. |
| packaged pins | the real shipped assets | yes — reads the actual files, and cross-checks the chart tag against the template image, so a release.sh sync_pin that silently stopped firing on ONE of them fails here. |
