# t57 — registry liveness: stop trusting the pid, stop deleting what we did not re-check

Branch `registry-liveness` off master `0d8b6db` (v4.6.0). Spec:
`~/.clodex/messages/clodex-hand/msg-86216-3.txt`. Evidence base:
`tasks/registry-unification/audit.md` §5.1 (pid-recycle ghost) and §5.2
(cleanup TOCTOU).

## Phase 1 — re-verify the spec's two load-bearing facts, and the B pre-check

clodex named two facts and told me to re-verify rather than inherit them. Both
hold, read at the source on this branch:

| Fact | Line | What I read |
|---|---|---|
| `Transport.start()` unlinks before `listen` | `agent-transport.js:113` | `try { fs.unlinkSync(this._path); } catch {}` is the first statement in the `start()` promise, before `net.createServer` and before `listen` at `:128`. A leftover socket file therefore never blocks a rebind — the bind path always clears its own address first. |
| The server discards zero-length frames | `agent-transport.js:119` | `if (data.length === 0 \|\| data.length > MAX_MSG) return;` in the `conn.on('end')` handler, BEFORE `JSON.parse` and before `this._onMessage`. A connect-and-close with no write produces a zero-byte `Buffer.concat` and returns early. So a probe that only connects is inert: it cannot be mistaken for a message, and it cannot reach `_onIncoming`. |

Consequence for the design: a probe may connect and immediately close, and the
probed agent sees nothing. And removing cleanup's socket unlink cannot strand a
future bind, because the future bind unlinks the path itself.

### Defect B pre-check — can an orphan socket file make a dead agent look alive?

The spec says: establish this, and **if it can, stop; the design changes**. It
cannot. Every reader of a socket path reaches it *through* a registry entry —
there is no code path that scans for `agent.sock` files.

Grep of every `info.socket` / socket-path reader in product code:

| Site | Reads | Guarded by |
|---|---|---|
| `agent-transport.js:76` (`listPeers`) | `info.socket` | iterates `regEntries()` (`run/*/agent.json`); ANDs `existsSync(info.socket)` with `isAlive(info.pid)` — both come off a parsed entry |
| `agent-transport.js:93,95` (`cleanup`) | `info.socket` | same — entry first, socket second |
| `agent-transport.js:84` (`getPeer`) | — | delegates to `listPeers` |
| `session-manager.js:1243` | `existing.socket` | parsed from the blocking `agent.json` |
| `session-manager.js:2907` | `peer.socket` | `peer` comes from `getPeer` |
| `scripts/clodex-monitor.js:51-52`, `scripts/clodex-team.js:189` | `info.socket` | read the agent.json entry, and throw when it has no socket |
| `session-manager.js:1223` | `pathFor(..., 'socket')` | derives its OWN path to bind; does not consult the filesystem for liveness |

`regEntries()` (`:37-45`) yields `agent.json` paths only. So a socket file with
no `agent.json` beside it is invisible to the whole system — nothing enumerates
it, nothing dials it, nothing counts it as a peer.

The reverse direction is what matters and it is also safe: an `agent.json` never
exists without its socket having been bound, because both `registry.register`
call sites (`session-manager.js:1230` and the retry at `:1244`) run *after*
`await transport.start()` at `:1227`. And if the same name registers again
later, `start()`'s pre-bind unlink at `:113` replaces the orphan rather than
inheriting it.

So leaving an orphan socket behind is inert in both directions. B proceeds.

### The window I am deliberately leaving open

`session-manager.js:1242-1243` has the same read-then-unlink shape as `cleanup`:
the entry is read at `:1236`, decided on at `:1241`, then unregistered and its
socket unlinked. Defect A's probe narrows it — the force-clean now follows a
proof that nothing is listening on that socket — but it does not close it: a
third party could re-register in the gap between the probe and the unlink. Per
the spec I am not adding locking; a lease protocol is a separate ticket.

## Phase 2 — implementation

| # | File | Change |
|---|---|---|
| 1 | `agent-transport.js` | `SOCKET_PROBE_TIMEOUT = 250` module const, with the justification the spec asked for: send()'s 2000ms is for a peer we already believe in; the probe runs on the session-start path, and a same-host UDS connect either succeeds in microseconds or nothing is bound. |
| 2 | `agent-transport.js` | `Transport.isSocketLive(socketPath)` — static beside `send`. True only on successful connect; ECONNREFUSED / ENOENT / timeout all resolve false. Never rejects. Writes nothing, closes immediately (inert by the `:119` zero-length drop). |
| 3 | `agent-transport.js` | `cleanup` no longer unlinks `info.socket`; comment records WHY, so a future reader does not re-add it as tidying. |
| 4 | `session-manager.js` | EEXIST branch probes `existing.socket` BEFORE deciding; `!live \|\| isStaleRegistration(...)` — not-live overrides the pid verdict. |

Wiring note: no `engine.js` change was needed. `Transport` is already destructured
there (`engine.js:506`) and already injected into SessionManager's deps, so a
static on the class reaches both call sites with no new seam. Nothing was added
to the deps object, so the free-identifier leak scanner has no new name to learn.

`isAlive` and `listPeers` stay synchronous, as specified. `isStaleRegistration`
and its comment are untouched — the probe is layered in front of it, not folded
into it, so the Docker same-pid case keeps its own path.

### The one existing test this changed

`test/agent-transport.test.js` had `assert.ok(!fs.existsSync(deadSock), 'cleanup
also unlinks the dead socket')` — it pinned the exact line Defect B removes. I
inverted it rather than deleting it, so the file now asserts the socket SURVIVES
and says why. That is pin (f).

## Phase 3 — tests (a)(b)(c)(f) done; (d)(e) next

`test/agent-transport.test.js`: 7 pass, 0 fail. Pins landed:
- (a) bound socket + live server → live. Also asserts the probe is INERT (the
  server's onMessage saw nothing) — if that ever breaks, probing would inject
  phantom traffic into a running agent's intent stream.
- (b) socket FILE with nothing listening → not live. This is the ghost's exact
  on-disk shape and the case `existsSync + isAlive` gets wrong.
- (c) missing path → not live, resolved not rejected.
- (f) cleanup removes the entry and LEAVES the socket file (the inverted
  pre-existing assertion).

### Next: (d) and (e), the session-manager pins

Blocker to solve first, not a spec problem: every `create()` harness in
`test/session-manager.test.js` is a BASH create (`bashCreate`, `mkBashCreateProbe`,
`mkOnDataProbe`). Bash sessions are private — `agentType` is null
(`session-manager.js:870`), so `if (agentType)` at `:1218` is false and the whole
registry/transport block, including the EEXIST branch under test, never runs. A
bash-based test for (d)/(e) would pass without ever reaching the code it claims
to cover. So (d)/(e) need an agent-typed (`'claude'`) create harness, which pulls
in the hook/prompt/library deps that `mk()` currently omits.

(d) remains the careful one: `isStaleRegistration` has its own force-clean path,
so the seeded pid must be genuinely-live-and-not-ours for the old code to refuse.
Separately from the revert, I still owe the question: does the test ENTER the
probe branch? Instrument if reading cannot tell.

## Phase 4 — (d) and (e), and the finding that changed the fix

`test/session-manager.test.js`: 309 pass, 0 fail, exits cleanly in 8.5s.

### The spec's probe placement could not work, and the test is what proved it

The spec says: in the EEXIST branch, probe before deciding. I implemented exactly
that, and pin (d) failed — `Session "ghost" is already running elsewhere (pid 1)`.

The reason is structural, not a coding slip. Socket paths are derived from the
NAME, so a blocking record's `socket` is byte-identical to the `socketPath` this
create is about to take. `create()` binds its own transport at
`session-manager.js:1227` — and `Transport.start()` unlinks the path before it
listens — BEFORE it ever calls `registry.register` and reaches the EEXIST branch.
So a probe made inside that branch dials the socket **we ourselves just bound**.
It answers "live" unconditionally: for a real agent and for a ghost alike. As
specced, the probe is not merely weak, it is a constant.

Fix: the probe moved to the pre-bind instant (`:1225-1252`), which is the only
moment the question is still answerable. Its verdict is carried into the EEXIST
branch as `blockerLive`. Tri-state on purpose — `true` / `false` / `null` for "no
answer" (no blocking record at probe time, or an unreadable one), and only
`blockerLive === false` overrides `isStaleRegistration`. A null degrades to
exactly the pid-only behaviour that shipped, so the probe can never make the
decision worse than it was.

This is a deviation from the spec's literal instruction ("in the EEXIST branch:
probe before deciding") in service of its actual intent. Flagged to clodex.

### A third instance of Defect B's failure shape, found by pin (e) — NOT fixed

Pin (e) originally asserted the live victim's socket file survives a refused
create. It does not, and the reason is a real pre-existing defect: create() binds
(unlinking the path) before it consults the registry, so by the time it honestly
refuses to displace a live agent, it has **already taken that agent's socket out
from under it** — and `transport.stop()` unlinks it again on the way out. The
victim's `net.Server` goes on listening on an unlinked inode: silently
unreachable, the same shape as §5.2, on a third path.

Fixing it means binding AFTER the registry check, which restructures session
start — out of scope for t57. The test now pins what IS true (the victim's
registry ENTRY survives, so the name is not handed over on the next attempt) and
carries a comment naming the unfixed defect rather than papering over it.

### Test-hygiene note: the hang the spec warned about, in my own harness

The first version of these two tests passed and then hung `node --test` forever —
a created agent session owns a REAL listening `net.Server`, and leaving it open
holds the event loop. The whole FILE then fails by timing out, which is the least
diagnosable failure shape there is (and exactly what the spec forbids for a
socket test). `mkAgentCreateProbe` now returns `closeAll()` and both tests call
it from `finally`.

### Why a codex-typed create

Every existing create harness in this file is bash. `agentType` is null for bash
(`session-manager.js:870`), so `if (agentType)` at `:1218` — the entire registry
block under test — is skipped. A bash-based (d)/(e) would have passed without
reaching a single line of the code it claims to cover. Codex is the lighter of
the two agent arms; claude's pulls the wire/hook/library stack for machinery this
has nothing to do with.

## Phase 5 — proofs

### Does (d) ENTER the probe branch? (asked separately from the revert)

Reading could not settle it, so I instrumented `session-manager.js` temporarily
(two `console.error` lines, removed after; pristine restored from a copy taken
before the run):

```
INSTRUMENT: probe ran, blockerLive=false
INSTRUMENT: EEXIST decision, blockerLive=false isStale=false     ← test (d)
INSTRUMENT: probe ran, blockerLive=true
INSTRUMENT: EEXIST decision, blockerLive=true  isStale=false     ← test (e)
```

`isStale=false` in (d) is the decisive value: `isStaleRegistration` REFUSES that
registration, so its pre-existing force-clean path cannot be what frees the name.
Only `blockerLive === false` can. The trap the spec named is avoided, and shown
to be avoided rather than argued to be.

### Revert table — every one fails BY MESSAGE (no crash, no timeout, no hang)

| # | Reverted | Test that caught it | Failure |
|---|---|---|---|
| A | drop `blockerLive === false` from the EEXIST decision (ship the pid-only behaviour) | (d) | `Error: Session "ghost" is already running elsewhere (pid 1)` |
| B | move the probe back to the spec's LITERAL placement (inside the EEXIST branch, post-bind) | (d) | same — independent proof the relocation is the fix, not a preference |
| C | `conn.on('error', () => finish(true))` — a probe that cannot say no | (b), (c) | "a leftover socket file with no server behind it must read NOT live…" / "ENOENT must resolve false, not reject…" |
| D | `createConnection(..., () => finish(false))` — connect ignored | (a), **(e)** | "a socket with a real server accepting connections must read live…" / "Missing expected rejection: …the probe must not turn the honest refusal into a stomp" |
| E | re-add cleanup's `fs.unlinkSync(info.socket)` (the Defect B line) | (f) | "cleanup must LEAVE the socket file — unlinking a socket it never re-checked is how a live agent goes silently unreachable" |
| F | `SOCKET_PROBE_TIMEOUT = 1` | (a) | "a socket with a real server accepting connections must read live…" — the bound sets a real floor; 250ms is not decoration |

Revert D is the one worth noting: loosening the probe in the *permissive*
direction breaks (e), i.e. the tests refuse a probe that would let create() stomp
a genuinely live agent. That is the direction that would do damage in production.

Leak scanner (`test/free-identifier-leaks.test.js`): 83 pass, 0 fail —
`agent-transport.js` stays clean, and no new injected name was added to
SessionManager's deps (the probe rides the already-injected `Transport`).
