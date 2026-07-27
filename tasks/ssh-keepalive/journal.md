# t43 — fix D4: sshArgv had no keepalive

Branch `ssh-keepalive` off master `a912da3` (the t42 merge). Baseline 2747 pass /
ESCAPES: 0. Standalone defect fix; no L1/L2/L3 work bundled in.

## The four call sites, exact values

There are **four** ssh option sets in tracked source, not five — t42 collapsed
`peer-tunnel.js`'s and `web-tunnel.js`'s byte-identical `SSH_BASE_ARGS` into
`cli/src/dial.js`, so the two GUI supervisors now share one definition. The
ticket's five predates that merge.

| # | site | const | BatchMode | ConnectTimeout | StrictHostKey | ExitOnForwardFailure | ServerAliveInterval | ServerAliveCountMax |
|---|---|---|---|---|---|---|---|---|
| 1 | `ssh-run.js:30` | `SSH_ARGS` | yes | 10 | accept-new | — | **15** | **2** |
| 2 | `cli/src/deploy.js:56` | `SSH_DEPLOY_ARGS` | yes | 10 | accept-new | — | **15** | **2** |
| 3 | `cli/src/dial.js:56` | `SSH_BASE_ARGS` | yes | 10 | accept-new | yes | **15** | **2** |
| 4 | `cli/src/transport.js:55` | `sshArgv` | yes | 10 | accept-new | yes | **MISSING** | **MISSING** |

**The three that had it AGREED exactly: `ServerAliveInterval=15`,
`ServerAliveCountMax=2`.** No winner had to be picked — I used those values.

`ExitOnForwardFailure` is present only on the two that actually forward a port
(3 and 4); 1 and 2 run a remote command over `bash -s` and have no `-L` to fail.
That is a real difference between the sets, not a drift, and it is why the guard
below asserts the keepalive property specifically rather than full-set equality.

## The fix

`cli/src/transport.js` `sshArgv`: added `-o ServerAliveInterval=15` and
`-o ServerAliveCountMax=2`, positioned as in `dial.js` (after
StrictHostKeyChecking, before ConnectTimeout).

**The header comment was part of the defect and is rewritten.** It claimed to
mirror "peer-tunnel.js's key-auth, fail-loud posture" while omitting the one
option that detects a dead far end — so a reader checking for exactly this
property would have read the comment and stopped. It now names the three sibling
definitions, states what the option does (~30s to notice a dead peer, then ssh
exits), and records why ServerAlive rather than TCP keepalive: these probes ride
the encrypted channel and need a real response from the remote sshd, so they
cannot be satisfied by a link that merely still routes packets.

## Tests

### No existing test needed updating — and that is itself a finding

I expected to touch `cli/test/transport.test.js:29` and did not. It asserts by
MEMBERSHIP (`argv.includes('-N')`, `argv.some(a => a === 'BatchMode=yes')`,
last element is the host) and never asserts full argv equality or a length, so
adding two elements passes it unchanged. Grepped for any `deepStrictEqual` on a
built ssh argv anywhere in `test/` or `cli/test/` — there is none.

So, in the ticket's terms: **zero tests were pinning the ABSENCE of the
keepalive, and zero needed an incidental full-equality update.** The suite was
simply silent on the property. That is the more useful answer than either
category — the bug was not defended by a test, it was invisible to every test,
which is why it survived four call sites' worth of opportunities to notice.

Full CLI suite passed with the fix and no test edits (92/92 across the transport,
port-forward, web, attach, verbs-ctx and integration files).

### `test/ssh-keepalive.test.js` — 6 tests, the invariant not the literal

The test worth having is the one that fails for a call site added tomorrow, so it
DISCOVERS option sets from tracked source and demands the property of each,
rather than pinning four literals (which would go green on the fix and say
nothing about a fifth site).

Discovery anchors on `'-o', 'BatchMode=yes'` as a whole matched LINE — an argv
element, present on all four by policy, not plausible for a future ssh call site
to omit, and matched line-wise so a mention in prose cannot be picked up.

**Source enumeration goes through `git ls-files`, and fails LOUDLY if git is
unavailable** rather than falling back to a filesystem walk. This is clodex's
lesson from my t39 layer 3 applied on purpose: a guard that enumerates the
filesystem inherits every developer's local state. Verified below that an
untracked file is correctly invisible.

Windows, each stated separately from the revert proof:

1. **Discovery works and finds exactly four** — the anti-vacuity test. Every
   other test asserts a property OF the found set, so a scanner that silently
   found nothing would make them all trivially true. Pins FILES, not
   `file:line`: line numbers would fail this guard whenever a comment above one
   of the arrays grew, and a guard that cries wolf on no-op edits is one someone
   eventually deletes — taking the real property with it.
2. **The property, on every discovered set** — the assertion that would have
   caught the defect; names the offending file in its message.
3. **The four agree on timings** — pins the agreement the ticket asked me to
   report. A future site choosing its own numbers fails here, which is the
   conversation worth having.
4. **The scanner's own blind spot** — `enclosingArray` on an inline literal
   (where the BatchMode line IS the opening line) and on an unterminated one
   (must return null, not swallow the file). A scanner that silently skips a call
   site makes test 2 vacuous, and unlike test 1 nothing else would notice.
5. **The built argv, not the source text** — calls all four real exported
   builders. Source text proves the option is written down, not that it reaches a
   spawn; a constant can be declared and never spread in. Also asserts `-o`
   immediately precedes each option, since ssh would otherwise read it as a
   hostname.
6. **`sshArgv`'s full template** — the specific regression, pinned as a change to
   THIS function, `{port}` placeholder and `-L` element included.

### Revert proof

Restoring the pre-fix `sshArgv` (both options removed) fails **4 of 6**, all
**by message**, none by crash:

- `cli/src/transport.js:54: an ssh invocation with no ServerAliveInterval. A
  tunnel whose far end dies without closing TCP would read as open forever…`
- `ServerAliveInterval disagrees across call sites`
- `transport.sshArgv: keepalive interval missing from the built argv`
- the full-template deepStrictEqual

Tests 1 (discovery) and 4 (scanner) stay green under the revert, which is correct
— neither is about the property.

**One correction made rather than shipped.** The timings test first read
`s.text.match(/…/)[1]` directly, which on a set with NO keepalive throws a
TypeError — a guard dying by crash instead of by message tells the next reader
nothing about which call site is wrong. Now null-safe: a missing option records
as `ABSENT(<file>)` and the comparison reports it. Caught by reading the revert
output rather than just its pass/fail count.

### The guard catches a FIFTH site (proven, not assumed)

Added a tracked scratch file with a keepalive-less BatchMode array. Result: test
1 fails (`an ssh call site vanished or was added`) and test 2 fails naming
`scratch-ssh.js:2`. Removed it; green again. This also confirms the git oracle —
before `git add -N` the file was invisible to the scan, which is the intended
behaviour and the whole point of asking git rather than the disk.

## CLOUD LIVENESS — the finding clodex asked for, NOT fixed

**The cloud argv templates have no keepalive option and no equivalent to add.**
Checked all four builders in `cli/src/transport.js`:

- `ssmArgv` — `aws ssm start-session` with `AWS-StartPortForwardingSession`.
  No session-keepalive flag; the argv carries only target/document/parameters.
- `kubectlArgv` — `kubectl port-forward`. No liveness flag in the argv.
- `gcloudArgv` — `gcloud compute start-iap-tunnel`. No liveness flag in the argv.
- `azArgv` — `az network bastion tunnel`. No liveness flag in the argv.

So this is **not** a case of "three have it, one forgot" — there is nothing of
the same kind to add, which is exactly why it needs a separate decision rather
than a parity fix.

**The gap is real and already documented from live use.** `cli/src/port-forward.js:71-80`
states it plainly, and the evidence is first-hand rather than theoretical: *"An
SSM tunnel can die SILENTLY: the local child stays alive and keeps accepting TCP,
but the data channel to the box is gone (proven live during an instance OOM — the
web GUI answered, then 30s later nothing, with the tunnel child still running)."*

**What already covers it, and what does not:**

| consumer | covered? | by what |
|---|---|---|
| `clodexctl web` | YES | `startProbe`, always on — the remote IS an HTTP GUI (`web.js:97-104`) |
| `clodexctl port-forward` | OPT-IN | `--probe-http` only; off by default (`port-forward.js:186`) |
| `attach` / `logs -f` | YES | `sse-guard`'s 60s staleness watchdog |
| `deploy`'s hello polls | n/a | short-lived opens, each bounded by `WAIT_PORT_MS` |

The uncovered case is therefore **`port-forward` without `--probe-http`**: a
long-lived hold over a cloud transport with no liveness signal at any layer.

**Why `startProbe` is the right shape and a cheap signal would not be.** It is
end-to-end HTTP against the far end (`port-forward.js:76-79`): any response —
200, 401, 404 — proves the remote answered, and only a hang or refusal counts as
a failure, with 2 consecutive failures required so one slow poll cannot kill a
healthy hold. A TCP connect on the local port would be exactly the cost-nothing
signal the standing rule warns about: it reaches only the healthy local child and
would report "alive" for precisely the dead-data-channel case that motivated the
probe. Same reasoning as ssh's ServerAlive over TCP SO_KEEPALIVE, one layer up.

**The decision I am NOT taking:** whether `port-forward` should arm the probe by
default. Against: `port-forward` is transport-agnostic and the remote need not
speak HTTP at all, so a default-on HTTP probe would declare a healthy non-HTTP
forward dead — which is presumably why it is opt-in. That makes the fix a
question about what `port-forward` may assume of its remote, not a parity gap,
and it is yours.

## Verification

`TOTALS: 2753 pass, 0 fail` / `ESCAPES: 0`, read from `npm test` directly.
2747 → 2753 = +6. No existing test edited.

`npm run build:web` run — `web-dist/index.html` bundles these modules.

## Progress

- [x] four call sites enumerated with exact values; the three that had it agreed
- [x] `sshArgv` brought to parity, header comment rewritten
- [x] invariant test, 6 windows, revert by message, fifth-site proof
- [x] cloud liveness investigated and reported, NOT fixed
- [x] suite green at 2753, ESCAPES: 0
