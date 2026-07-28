# registry cluster (t75-t78) — implementation journal

Branch `registry-cluster`, off master `9c977b3`. Worktree
`/Users/bogdan/projects/tmux/wb-wrap-ui-hand`, mine alone.

**One artifact, one branch, one report** — clodex's framing (msg-55910-98):
t75-t78 share `agent-transport.js` and the same underlying question, so four
separate passes would re-read the same code four times.

Note the tickets each carry their own `taskDir` (`tasks/registry-ghost-discovery`,
`tasks/registry-cleanup-revalidate`, `tasks/cleanup-ordering-pins`,
`tasks/census-scanner-comments`). Those fields predate the batching decision;
clodex's later instruction is explicit that the artifact is
`tasks/registry-cluster/`, so this file is it. Recording the divergence so the
per-ticket dirs being empty is not read later as work never done.

## Order (clodex's, not mine)

1. **t76** — cheapest, fix already exists in-tree; port it or write why not.
2. **t77** — pure test work, no product change; pins ordering t75 might disturb.
3. **t75** — the only one needing design judgment.
4. **t78** — last and independently: different file, different hazard, and its
   revert discipline must not be rushed to finish a batch.

## Dispatch verification (a lesson applied immediately)

clodex's first framing message said four tickets were assigned. Only t75 was —
Clodex fires only ONE `[agent:task assign]` intent per turn, so three of four
emitted intents silently did nothing, and the board showed `open` /
`assignee=None`, which is byte-identical to "never dispatched" because that is
what it was.

Before starting I read `~/.clodex/teams/clodex/tickets.json` myself rather than
trusting the dm. All four now show `state=open assignee=clodex-hand`. The
operational rule, which binds me too: **verify a dispatch landed by reading
tickets.json, not by having emitted the intent.** Records are a flat list; `id`
is the string `"t75"`.

I also pulled t77's and t78's full specs out of `tickets.json` rather than
waiting on their dms, since the store is the authority and the dms are a copy.

## Carried in from t96 (clodex's instruction, and my own finding)

- **Cross-turn/cross-request is the instrument shape.** My t96 tests each
  examined ONE request and a cross-turn flap is invisible within one request. I
  had the right shape in Phase B (measurement 3 joined consecutive requests) and
  stopped applying it when the task changed from measuring to proving. Applies
  directly to t77: a `_cleanup` ordering property is only observable ACROSS the
  teardown, not within one statement.
- **A check that detects vs. a check that explains.** My t96 equivalence check
  fired on the narrowed scope but could only say "boundary mismatch". A pin
  whose failure does not teach the reader WHY gets deleted by whoever trips it.
  t77 requires failure BY MESSAGE naming the consequence.
- **Code right, comment wrong is the dangerous direction** — it invites a tidy
  that reintroduces the defect. t77 is that situation BEFORE the tidy. Write the
  comment as carefully as the assertion.

---

## t76 — cleanup() read-then-unlink, no re-validation

### Spec premises checked at source

| Spec claim | At source | Verdict |
|---|---|---|
| `cleanup()` reads then unlinks with no re-validation, `agent-transport.js:100-104` | `regEntries()` loop at :100, `JSON.parse(readFileSync)` :102, verdict :103, `fs.unlinkSync(regPath)` :104 | **CONFIRMED**, line numbers exact |
| t57 correctly stopped unlinking the socket; :105-117 explains why re-adding it would be worse | comment block :105-117, verbatim on that point | **CONFIRMED** |
| The guard is already written at `session-manager.js:1350-1353` | :1350-1353 is COMMENT PROSE about bind ordering. The actual guard is **:1379-1385**: re-read `existingRaw`, then `if (existingRaw !== blockerRaw) blockerLive = null;` | **substance CONFIRMED, line ref WRONG** |

The guard's substance is exactly as described — read raw bytes, act, re-read raw
bytes, discard the verdict if the bytes changed — and it is one function away in
a different file. Only the line number is off; not a false premise.

### The race, spelled out

`register()` links atomically and throws `EEXIST` if the entry exists, so a
concurrent registration cannot quietly overwrite. The damaging interleaving is:

1. `cleanup()` reads entry X (dead pid) → verdict: remove.
2. concurrently, `create()` for the same name: `register()` → EEXIST →
   force-clean (unlinks X) → `register()` again → entry Y, LIVE pid.
3. `cleanup()` executes its `unlinkSync(regPath)` → **deletes Y**, the live one.

Recoverable rather than permanent (the socket is not unlinked, so the agent
keeps listening), but the live agent loses its registration and goes
undiscoverable.

### The open question, to be measured next turn

Is this reachable in the shipped single-engine app, or only cross-process?
`registry.cleanup()` has ONE production call site: **`engine.js:1810`** (the
spec and the older audit both say `:1724` — drifted, verify before quoting).
If that runs strictly before any `create()` within a process, the in-process gap
is empty and the hazard is cross-process only (second engine sharing
`~/.clodex`, or a Docker box without a private volume).

That does not decide the ticket by itself — clodex's actual requirement is that
the ASYMMETRY not be left looking intentional. Either port the guard or comment
why cleanup() does not need it. Reachability determines which, and it is a
reading question, not a judgment call, so it gets read.

### Status

Reading done, nothing changed yet. Next: `engine.js:1810` ordering, then decide.
