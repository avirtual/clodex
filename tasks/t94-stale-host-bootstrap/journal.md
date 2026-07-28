# t94 — the stale surface is blind on the host that motivated t93

Branch `t94-stale-host-bootstrap` off master `2c2fb99`.
Two deliverables: (1) fix a false comment, (2) substantiate staleness with no
stamp — **if it can be done honestly**, else make the silence legible.

## Phase A — is the fallback sound? (design before code)

### The bug is real and reproduced from outside

Live registry: `~/.clodex/run/clodex/agent.json` → `pid 55910`.
`ps -o lstart= -p 55910` → `Tue Jul 28 02:33:56 2026` (14h45m at time of check).
`find ~/.clodex/run -maxdepth 1 -type f` → only `.migrated`. No `.host.json`.

So `staleHostLine()` returns `''` at :203 on the very host whose staleness
motivated t93. Confirmed by construction: the stamp is written by the host at
boot (`main.js:550`), and this host booted ~12h before `host-stamp.js` existed.

Counted directly: **9 top-level `*.js` have mtime > boot** — `cli-hooks`,
`engine`, `exec-schema`, `host-stamp`, `intent-registry`, `ipc-prompt`, `main`,
`pending-store`, `session-manager`. Including `session-manager.js`, which is the
module that produced the t92 misdiagnosis.

### Fix 1 — the comment at :168-172 is false, and falser than it looks

It claims this surface "reports correctly even when the running host is itself
too old to know this check exists". It cannot: no stamp, no comparison,
silence. My own comment at :190-193 already says the opposite. The two
contradict each other in the same file, ~20 lines apart.

This is the t91 failure exactly — a shipping artifact making a claim its
author's own notes disprove. Same root cause too: I reasoned about the
mechanism correctly at :190 and then wrote the marketing sentence at :168
from the design intent instead of from the mechanism.

### Fix 2 — does the process-start-time fallback hold up?

clodex's proposal: pid is in the registry, start time from the OS, and "a
module whose mtime is newer than the process start time is provably not loaded
by it."

**The premise is FALSE as stated, and the source says so.** Node `require` is
lazy — a module required inside a function body loads at CALL time, not at
boot, and this repo does that heavily:

    main.js:579          require('./ipc-handlers')
    peer-wiring.js:64-65 require('./peer-client'), require('./relay-protocol')
    session-manager.js:428,445-448,454,466,645  wire-intents, wire/hold,
                         wire/proxy, wire/role, wire/shadow, wire/warmth,
                         wire-telemetry
    remote-wiring.js:100, headless-main.js:204, sandbox.js:486, engine.js:168

A module edited after boot but before its first lazy require IS live in the
host. So "newer than start time ⟹ not loaded" does not hold per-module, and I
am not going to ship a notice that asserts it.

**What DOES hold, and is checkable rather than inferred:** the file's bytes
changed after the process started. That is a fact about two timestamps, with no
claim about the module system. So the fallback states the evidence and stops:

> N top-level modules changed since this host started (Xh ago). No boot stamp
> — this host predates the check — so staleness cannot be confirmed precisely.

That is weaker than the stamped line and it is the strongest honest form. It is
also sufficient for the failure it exists to prevent: clodex concluded "the
source is broken" from a reply; a line naming 9 changed modules and a 14h-old
host would have stopped that cold.

### False positives I could not rule out, and how each is handled

| Hazard | Verdict |
|---|---|
| Lazy require loads new bytes post-boot | REAL — wording states evidence, not loadedness (above) |
| pid reuse: registry pid now a stranger | Ruled out by matching `ps -o args=` to the app root in the same call |
| Wrong dir digested | Dir is DERIVED from the live process's own argv, never guessed; must contain the app's own marker files or we report unknown |
| mtime in the future (tarball extract, clock skew) | REAL but unfixable and pre-existing: the stamped path shares it. git never sets future mtimes. Accepted, flagged. |
| Packaged app (asar) | Not unknown — correctly FRESH. asar bytes never change, so silence is true there. |

### The third state must be visible (the ticket's explicit ask)

Three states, three outputs, and the third must not read like the first:

1. stamp + digest match → **silent** (t82: happy path says nothing)
2. stamp + digest differ → the existing STALE line
3. no stamp → **the evidence line above**, or, when the host cannot be
   identified at all, an explicit `cannot determine` line

State 3 speaking is not a t82 violation: silence is reserved for *fresh*, and
"cannot determine" is not fresh. The reason today's bug is expensive is that
state 3 was rendered as state 1.

### `ps` from a strict leaf — allowed?

`scripts/clodex-team.js` is flat-copied into `run/bin/` and may require **node
builtins only**. `child_process` is a builtin, so the rule holds; the leaf
currently requires fs/net/path/os only, and `scripts/` peers already use
`child_process` (electron-smoke:21, clodex-monitor:31, run-tests:23).

t93's journal gave "no child process" as a reason to prefer the digest over git
HEAD. That reasoning was about the PRIMARY path, which runs on every
invocation. The fallback runs only when there is no stamp, and there is no
builtin API for another process's start time on macOS (no `/proc`). So it is
`ps` or nothing.

`ps -o etimes=` is **not supported on macOS** (verified: "keyword not found").
`lstart` is, and `new Date('Tue Jul 28 02:33:56 2026')` parses to the correct
local epoch (verified). Month/day names are locale-sensitive → spawn with
`LC_ALL=C`.

### Decisions

- Fallback ships, with evidence-wording, not inference-wording.
- Pure logic lands in `host-stamp.js` (injectable seams → testable without a
  real clock, real `ps`, or a real app); the leaf duplicates it for the
  documented strict-leaf reason and the existing parity test is extended to
  cover the new grammar too.
- No change to `computeModuleDigest`, so t93's parity pin is untouched.

## Phase B — implementation

### Shipped

**`scripts/clodex-team.js:168-172`** — the false comment replaced. It now
separates the claim that survives (a fresh process prints the line, so a stale
host cannot SUPPRESS it) from the one that did not (that it can therefore
*know* the answer). Records what was observed live, so the next reader does not
re-derive it.

**`host-stamp.js`** — three additions, all pure:
- `changedSince(dir, sinceMs, fsImpl)` — watched modules whose mtime postdates
  a moment; `null` = cannot tell. Same `WATCHED_RE` as the digest, so scope
  cannot drift between the two paths.
- `bootstrapNotice(host, opts)` — the stamp-less line. **Takes the host's
  identity as an argument rather than discovering it**, see below.
- `hostNotice(runRoot, dir, host, opts)` — the one entry point: stamped answer
  when stamped, evidence answer when not, `null` only when genuinely fine.

**`session-manager.js`** — `_staleHostSuffix` now calls `hostNotice`, passing
`{ pid: process.pid, startedAt: now - process.uptime()*1000, root: __dirname }`.

**`scripts/clodex-team.js`** — `hostProcess(pid)` + `liveHost()` +
a rewritten `staleHostLine()` covering all three states.

### The design change that matters: who discovers the host

My first cut had `bootstrapNotice` find the host itself — read the registry,
spawn `ps`, parse it. Wrong, and I backed it out before testing.

**The in-host surface must never spawn `ps`.** That code runs INSIDE the host,
so the answer is already in hand: `process.pid`, `process.uptime()`,
`__dirname`. Shelling out to ask the OS about yourself, on every ticket intent,
is both absurd and a real cost on a hot path — and t93 already established that
a diagnostic must not be able to damage the protocol it rides on.

So the pure core takes the host as a parameter and the two surfaces supply it
the way each one can: the host from itself, the leaf from `ps`. One wording,
one comparison, two discovery mechanisms. It also means the core needs neither
a real clock, a real `ps`, nor a live app to be tested.

### Verified functionally against the LIVE machine, not just `node --check`

Extracted the leaf's new block and ran it against the real registry and the
real running host:

    liveHost() → {"pid":55910,"startedAt":1785195236000,
                  "root":"/Users/bogdan/projects/tmux/wb-wrap-ui","packaged":false}
    staleHostLine() → "(HOST MAY BE STALE: 9 modules changed since pid 55910
        started 15h ago — cli-hooks.js, engine.js, exec-schema.js, ....
        No boot stamp (this host predates the check), so staleness is
        UNCONFIRMED; restart the app if a fix you expect to be live is not)"

That is the exact invocation that printed nothing an hour ago. The host was
found without its cooperation (via a registration's pid), the app root came
from its own argv, and the count matches the 9 counted independently in Phase A.

### Wording, deliberately

"HOST MAY BE STALE" and "staleness is UNCONFIRMED", not "STALE HOST". The
stamped line asserts; this one reports evidence. That distinction is the whole
reason this is shippable given the lazy-require finding, and it is pinned by a
test below.

## Phase C — tests

`test/host-stamp.test.js` 11 → 22; `test/session-manager.test.js` +2. Every
test drives the state it names AND a contrasting one, since the entire defect
was two different states rendering identically.

## Phase D — reverts, and three findings

| # | File | Corruption | Result |
|---|---|---|---|
| A | host-stamp | the t94 bug itself: no stamp → return null | 1 fail |
| B | host-stamp | "cannot determine" silently becomes fresh | 1 fail |
| C | host-stamp | UNCONFIRMED tightened into an assertion | 2 fail |
| D | host-stamp | changedSince scope drifts from the digest | 1 fail |
| E | host-stamp | mtime comparison flipped | 5 fail |
| F | host-stamp | stamp no longer wins over the fallback | 2 fail |
| G | clodex-team | leaf fallback removed entirely | **NO-OP → finding** |
| H | clodex-team | hedged headline asserted instead | 1 fail |
| I | clodex-team | cannot-tell state becomes silence | 1 fail |
| J | session-manager | in-host t94 wiring dropped | **NO-OP → finding** |

All bite **by message** after the fixes below. Re-run in full against the
corrected product, since the code changed after the first pass.

### Finding 1 — G and J were no-ops: I had tested around both surfaces

Two reverts deleted entire shipped behaviours and failed nothing.

**J** (in-host wiring gone): every t93 test STUBS `_staleHostSuffix`, so they
pin what `_handleTask` does *with* a suffix and never what the method computes.
The method itself had no test at all. It also could not have one: it read
`REGISTRY_DIR` and `__dirname` directly, so its only reachable state was
whatever the developer's machine happened to be in.

**G** (leaf fallback gone): my leaf tests probed `hostProcess` and the source
text, and the one that exercised behaviour called the inner function directly.
Nothing drove discovery → line.

Both are the same mistake: **testing next to a surface instead of through it.**
That is the t91 lesson one level over — there, a finding sat beside the artifact
without going into it; here, tests sat beside the code path without entering it.

Fixes, both of which changed the product to be testable at all:
- `_staleHostSuffix(now, seams)` — `runRoot`/`dir` injectable, defaulted to the
  real ones.
- `staleHostLineFor(host)` split out of `staleHostLine()`, so discovery and
  reporting can be driven separately.
- A new session-manager test drives the real method through the seams, and a
  new leaf test spawns a REAL child process behind a
  `node_modules/electron/dist/...` path so discovery runs registration → `ps` →
  argv → line for real. Faking that argv would have tested the fake, since the
  argv shape is exactly what the regex reads.

### Finding 2 — my seam broke the "instrumentation never throws" contract

Adding the seam as a DEFAULT PARAMETER —
`_staleHostSuffix(now, { runRoot = path.join(REGISTRY_DIR, 'run') } = {})` —
made an existing t93 test fail with
`TypeError: The "path" argument must be of type string`.

Default parameters are evaluated **before the function body**, so they sit
outside the method's own try/catch. With `REGISTRY_DIR` undefined the throw
escaped the method entirely and took the ticket reply with it — precisely the
failure t93 hardened against, reintroduced by a change meant only to improve
testability. Defaults now resolve inside the try.

Caught by an existing test, not by mine. Worth recording: t93's defensive test
paid for itself the first time the method was touched.

### Finding 3 — a revert that failed by SyntaxError proves nothing

My first revert I produced a broken paste; four leaf tests "failed" with
`SyntaxError: Unexpected token ';'`. That is not a failure by message — it
shows the file was unparseable, not that any assertion holds. Re-targeted to
the real regression shape (the cannot-tell branch returning `''` via valid
syntax), after which exactly one test fails, on the assertion that names it.

### ENTER checks

- The three-states test derives all three from ONE fixture, mutating only the
  stamp between them. Three independent fixtures could each pass for unrelated
  reasons; this cannot.
- Every mtime is set explicitly. The three-states test initially failed on this
  — the touch landed inside the same timestamp tick as the fixture write, so
  the digest never moved and the stamped path saw nothing to report. That is
  the flake direction that HIDES failures, and it bit inside my own suite.
- The discovery test asserts the child's own pid appears in the line, so it
  cannot pass by reporting some other process on the machine.
- `bootstrapNotice` silent-case and speaking-case are a matched pair; without
  the silent half, an unconditionally-firing notice would pass.
