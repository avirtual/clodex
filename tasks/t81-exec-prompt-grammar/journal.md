# t81 — EXEC COMMANDS prompt: render what the commands are, when to use them, and their payload grammar

Branch: `t81-exec-prompt-grammar` off master `1771ee1`. Supersedes t67.

Spec recovered from `~/.clodex/teams/clodex/tickets.json` (t81) — the spool file
`msg-55910-21.txt` had already been reaped. Ticket text is the authority.

## Framing clodex asked me to carry in (msg-55910-33)

t81 is the same disease as t79 in a different consumer, but with the SHARPER
question: not "what grammar is MISSING" but **what does the section state that is
actively FALSE**. clodex knows of one (`ipc-prompt.js:146`) and told me to assume
there are others and go looking.

## Phase A — source trace

### A1. The rendering site, verbatim

`ipc-prompt.js:142-148`:
```js
function execSection(execCommands) {
  if (!Array.isArray(execCommands) || execCommands.length === 0) return '';
  const ids = execCommands.map((c) => `  [agent:exec ${String(c)}]`).join('\n');
  return `EXEC COMMANDS:
Your operator granted this seat a set of named shell commands to run on demand via [agent:exec <name>] — each is a pre-registered command (you supply only the name, never the command line). Output returns in your input as an [agent:exec] line. Yours:
${ids}`;
}
```
Confirmed: `execCommands` is an array of id STRINGS. The defs are never reached.
The comment at `:141` ("IDs only — the registry defs carry no description") is
accurate about `description` and false about `schema`, exactly as specced.

Call path (so I know what a def-bearing render would cost to plumb):
`session-manager.js:1014` (claude) and `:1221` (codex) both call
`buildIpcPrompt(intents, execCommands, pluginGrammarLines(intents))`.
`ipc-prompt.js` is a PURE LEAF — it must not gain a store/electron import, so
whatever the section needs has to arrive pre-resolved through this argument.

### A2. FALSE SENTENCE #1 — confirmed, and it is worse than clodex thought

"you supply only the name, never the command line" is true of ARGV and reads as
"there are no arguments." Confirmed as specced.

### A3. FALSE SENTENCE #2 — clodex's own premise is WRONG. Code wins.

clodex's spec states, twice, that the three no-required-props commands
"genuinely take no payload", and builds the scope on it:

> "A command with no required properties should render as taking no payload, so
> the three-of-five case stays true and cheap."
> "3 of my 5 granted commands genuinely take no payload, so the false sentence is
> CONFIRMED three times before it breaks on the fourth."

**That is not what the code does.** Verified empirically against the real defs:

```
bare (empty body):  {"ok":false,"error":"payload: empty (expected JSON)"}
empty object {}  :  {"ok":true,"value":{}}
```

`exec-schema.js:173-174` — `parseAndValidate` trims the raw body and, if it is
empty, returns `payload: empty (expected JSON)` **BEFORE any schema is
consulted**. The schema's emptiness is irrelevant; the check is on the BODY.

So a no-required-props command is NOT callable bare. It requires a literal `{}`.

And nothing upstream supplies a default: `session-manager.js:2905-2956`
`_extractIntents` under `bodyMode 'json'` leaves `intent.body` as `''` when there
is no payload, and `:3291` passes `intent.body || ''` straight through to
`_handleExecIntent`, which hands it to `parseAndValidate` at `:3731`.

**Consequence: the section as written is not "true three times and false once".
It is false FIVE times out of five for this seat.** The three commands the spec
calls the safe majority bounce too. This is the t82-style failure clodex asked me
to go looking for, and it is sitting inside the ticket's own premise.

### A4. FALSE SENTENCE #3 — "Output returns in your input"

`session-manager.js:3779-3797`. On exit 0 the dispatcher is **SILENT** unless the
def sets `replyStderr: true`, and even then it returns only the **last line of
STDERR, sliced to 200 chars**. STDOUT is dropped unconditionally — the comment at
`:3785-3787` says so explicitly ("stdout stays dropped: it's data, not a
channel").

So "Output returns in your input as an [agent:exec] line" is wrong on three
counts: it is not output (it is stderr), it is not the output (it is one line,
200 chars), and on a clean run with no `replyStderr` NOTHING returns at all — the
agent cannot distinguish success from a command that never ran.

All five of this seat's defs happen to set `replyStderr: true`, so this one is
masked for me but not in general.

### A5. Def inventory (verified by reading the files)

Live seat defs (`~/.clodex/library/exec/`):

| cmd | required | enums | replyStderr |
|---|---|---|---|
| clodex-team | action, agent | action: roster/retire/tickets | true |
| clodex-monitor | action, agent | action: start/stop/list | true |
| clodex-check-syntax | (none) | — | true |
| clodex-repo-state | (none) | — | true |
| clodex-run-tests | (none) | — | true |

Shipped seeds (`resources/library/exec/`) are ONLY clodex-team + clodex-monitor,
byte-identical to the live copies in the fields that matter. The other three are
Bogdan's local, machine-specific defs (absolute paths into the main worktree) and
are NOT in the repo — so seeding a `description` can only cover the two shipped
ones. Flag: descriptions for the local three would have to come from the def
files themselves, which the prompt already reads at render time if I plumb defs.

`clodex-monitor`'s schema also has a NESTED object property (`ws`, itself with a
required `url`) and a `description` string PROPERTY — note the collision risk: the
def-level `description` field the spec asks me to add is a sibling of `schema`,
not inside it, so no conflict, but worth stating.

### A6. Seeding path — VERIFIED, and the spec's guess is half right

- `pot-bin.js:51` `EXEC_SCRIPTS = ['scripts/clodex-team.js', 'scripts/clodex-monitor.js']`
  materializes the SCRIPTS into `run/bin/`. It does **not** touch the JSON defs.
  Editing it is NOT the way to seed a description.
- `stores.js:1663+` `seedLibraryDefaults()` is the real path: it copies
  `resources/library/**` into `~/.clodex/library/` with a sha256 provenance
  manifest (`.seed-state.json`) that overwrites an UNEDITED shipped copy when the
  app ships newer bytes, and never clobbers an operator-edited one.

**So a description is seeded by editing `resources/library/exec/*.json`, and it
will reach an operator whose copy is unedited. Bogdan's live clodex-team.json is
byte-identical to the shipped one, so it should re-seed — but I cannot verify
whether his `.seed-state.json` has it stamped, and I will not assert that it
will.**

### A7. `validateExecDef` accepts an unknown top-level key

`exec-schema.js:126-163` checks argv/cwd/timeoutMs/maxBytes/replyStderr/schema and
returns ok without rejecting extra keys. So adding `description` to the def shape
needs no validator change to be ACCEPTED — but adding an explicit type check is
the honest move (a `description: 12345` would otherwise render as "12345").

## Phase A verdict — the section has THREE false statements, not one

The ticket scoped a missing payload grammar plus one false sentence. The section
is worse: every sentence in it except the first clause is wrong in some way, and
the ticket's own "three of five take no payload" premise is wrong too. The fix
must state the `{}` rule or it ships a fourth lie.

### A8. Doc reconciliation — `docs/exec-tools.md` is ACCURATE. No disagreement found.

The ticket asked me to reconcile and flag where doc and code disagree. Read all
160 lines against the source. The doc is right everywhere I checked, and is in
fact the place where the truths the PROMPT omits are already written down:

- `:14-16` "stdout is dropped, and the launcher is SIGKILLed at the entry's
  `timeoutMs`. Feedback to the agent is one line via `replyStderr`." — matches
  `session-manager.js:3779-3801` exactly. **The doc states the thing the prompt
  gets wrong (A4).**
- `:12-13` argv/injection shape — matches `:3748` + the exec-schema header.
- `:31-33` "queries reply, command success is silent, failures are loud" —
  matches.
- `:70-83` clodex-monitor payload table — matches the shipped schema field for
  field, including `protocols` being a comma-separated string because the
  validator has no array type (true: `exec-schema.js:39-109` has no array case).
- `:145-146` both gates must allow — matches `:3703-3712`.

**So the finding is not doc-vs-code drift. It is DOC-vs-PROMPT drift: everything
an agent needs was written down in a file the agent never reads.** That is the
same shape as t79 (the knowledge existed, the consumer didn't get it), which is
what clodex meant by "the same disease in a different consumer."

The doc's own usage examples (`:113-115`) all pass a full JSON object, so the doc
never asserts the bare-call form either — it just never says `{}` is mandatory
for a fieldless command, because it has no fieldless command to describe.

### A9. Byte-pins located

`test/ipc-prompt.test.js:128-141`. The pins are NOT byte-literals over the exec
text — `:130-132` are `includes`/regex on the section header and each rendered
id, and `:138-140` are the real byte-pins asserting `buildIpcPrompt(null, [])`
and `buildIpcPrompt(null)` reproduce `IPC_PROMPT` exactly. **The zero-bytes-for-
no-grant property is the load-bearing one and must survive untouched.**

`ipc-prompt.js` and `exec-schema.js` are BOTH already in SCANNED_MODULES
(`test/free-identifier-leaks.test.js:41,49`), so no new module registration is
needed provided I add no new file.

## Phase B — design

### B1. Where the schema→payload-form renderer lives: `exec-schema.js`

Not `ipc-prompt.js`. The whole point of the ticket is "derived from the schema,
never hand-written, or it rots when a schema changes" — so the renderer belongs
next to `validateAgainstSchema`, where a change to the supported type set is
visible in one file. `exec-schema.js` is a pure leaf with zero requires, so
`ipc-prompt.js` requiring it keeps ipc-prompt a leaf-of-leaves and drags nothing
electron-ward.

### B2. Plumbing: `execSection` accepts strings OR summary objects

`session-manager.js` passes the persisted `execCommands` allowlist, which is
STRINGS, and `test/ipc-prompt.test.js:129` passes strings too. So the renderer
must keep accepting a bare string (degrading to the id-only line) and ALSO accept
`{ name, description, schema }`. That keeps the existing pins meaningful instead
of rewriting them, and makes a def-read failure degrade to today's output rather
than blocking a spawn.

Resolution happens in `session-manager.js` at create(), reading
`library/exec/<cmd>.json` the same way `_handleExecIntent:3718` already does —
deliberately NOT via the store, matching the dispatcher's stated reason for
staying store-free (`:3713-3717`).

### B3. Rendered shape — two lines per command (clodex's stated budget)

```
  [agent:exec clodex-team] {"action":"roster|retire|tickets","agent":"<string>"}  + optional: target, cwd
      Teams control plane — roster, retire a seat, list tickets.
```

Derivation rules: required props in `schema.required` order; enum → `a|b|c`,
string → `<string>`, number/integer → `<number>`, boolean → `<bool>`, filename →
`<filename>`, nested object → `{...}`. No required props → `{}`. Optional prop
NAMES only (no types) after the form — without them clodex-monitor is uncallable
for anything but `list`, and names are the cheapest thing that makes a field
discoverable.

**The description line renders ONLY if the def carries one.** Bogdan's three
local defs have none and I am not inventing descriptions for commands whose
behaviour I would have to guess — the honest-boundary rule. They render as the
payload line alone.

### B4. The three false statements all get fixed in the preamble

1. argv guarantee KEPT (it is the security shape and worth stating) but reworded
   so it stops implying there are no arguments.
2. **`{}` is mandatory** stated explicitly, with the exact bounce text so it is
   recognisable.
3. Success is SILENT; only failure (or a `replyStderr` command) injects back.

## Phase B — IMPLEMENTED

| # | Site | Change |
|---|---|---|
| 1 | `exec-schema.js` (new tail section) | `typeToken` / `payloadForm` / `commandLines` — schema-derived rendering, exported |
| 2 | `exec-schema.js` `validateExecDef` | accept + type-check optional `description` (string, <=200) |
| 3 | `ipc-prompt.js:77` | require `commandLines` from exec-schema (pure leaf -> pure leaf) |
| 4 | `ipc-prompt.js` `execSection` | new prose (3 false statements fixed) + derived lines; accepts strings OR summaries |
| 5 | `session-manager.js` `_resolveExecDefs` | new method: id -> { name, description, schema }, degrades to the id string |
| 6 | `session-manager.js:1014` (claude), `:1221` (codex) | pass resolved defs instead of bare ids |
| 7 | `resources/library/exec/clodex-team.json` | seeded `description` |
| 8 | `resources/library/exec/clodex-monitor.json` | seeded `description` |

### Defect caught in my own first render

The first version emitted `{"action":roster|retire|tickets,...}` — enum and
string tokens UNQUOTED, i.e. not valid JSON. Copying it would earn a
`payload: invalid JSON` bounce, the exact failure class this ticket exists to
stop. Fixed by moving the quotes into `typeToken` so the decision sits with the
type. Verified by round-tripping the rendered form back through the real
`parseAndValidate`: `{"action":"roster","agent":"clodex-hand"}` -> ok, and
`{}` -> ok for a fieldless command.

### BYTE COST (measured, this seat's five commands)

- id-only (old): **999 bytes**
- rendered (new): **1431 bytes**
- **delta: +432 bytes** for five commands, two of which carry descriptions.

Per command that is ~86 bytes amortized. The empty-grant case is unchanged at
zero bytes (both byte-pins assert it).

## Phase C — tests: 14 added (9 exec-schema, 5 ipc-prompt)

Product committed SEPARATELY first as `b9318d3`, tests+journal after.

Design note: the payload tests do not pattern-match the rendered string alone —
they FILL IN the rendered form and push it back through the real
`parseAndValidate`. A renderer that emits something the validator rejects is the
failure mode that matters, and only a round-trip can see it (it is what caught
the unquoted-enum defect).

### REVERTS — every pin proved to bite BY MESSAGE

Pristine copies of `exec-schema.js` / `ipc-prompt.js` taken before the first
revert; `git diff --numstat` checked after every restore (empty each time) and
after every revert (non-zero each time, plus a grep confirming the substitution
actually landed — a silent perl no-op is the trap here).

| # | Change | Tests that failed | Failed by |
|---|---|---|---|
| A | unquote enum + string tokens | 5 (incl. COPYABLE, which failed with the real `payload: invalid JSON`) | message |
| B | `payloadForm` returns 'takes no payload' for a fieldless schema | 4 | message |
| C | restore the OLD false prose in `execSection` | 2 (false-statements-gone, `{}`-rule-stated) | message |
| D | drop the `description` type check from `validateExecDef` | 1 | message |
| E* | make `commandLines` append `argv=…` to the rendered line | 3 (both argv-safety pins + the description-line pin) | message |

\* E is an ANTI-revert. The two argv/cwd tests assert the ABSENCE of a path,
which is the pre-existing value — no revert of my change could move them, so a
plain revert would have been a guaranteed no-op proving nothing. Leaking argv is
the only thing that enters their window.

No crashes, no timeouts, no hangs. Nothing armed: these are pure-function tests
over `buildIpcPrompt` / `exec-schema`; no session, no timer, no fs write.

### ENTER check

Asked of each: does the test enter the window it names? The two prose tests were
the ones at risk (an `!includes` passes trivially if the section never renders),
so both assert a POSITIVE fact about the new prose alongside the negative —
revert C failing on `the sentence … is gone` proves the section is in the string
being searched.

### Suite

**2980/2980, ESCAPES 0**, via the test-runner subagent.

Note on the count: my reminder note predicted 2983 from "17 added". That was my
arithmetic error, not a shortfall — I added 9 + 5 = **14** tests
(`grep -c "^test('t81"` on both files), and baseline 2966 + 14 = 2980 exactly.

## Report items

### The three false statements (the ticket asked for one)

1. `ipc-prompt.js:146` "you supply only the name, never the command line" —
   the one clodex named.
2. **The ticket's own premise.** "3 of my 5 granted commands genuinely take no
   payload" is false: `exec-schema.js:173-174` rejects an empty body BEFORE the
   schema is consulted. Confirmed end-to-end by firing
   `[agent:exec clodex-check-syntax]` bare against my own grant →
   `payload: empty (expected JSON)`. The section was false 5 of 5, not 1 of 5.
3. "Output returns in your input as an `[agent:exec]` line" — stdout is dropped
   unconditionally (`session-manager.js:3785-3787`); a clean exit is SILENT
   unless the def sets `replyStderr`, and then it is the last stderr line sliced
   to 200 chars.

### Gaps I could NOT establish — stated, not guessed

- **Whether Bogdan's live `~/.clodex/library/exec/clodex-team.json` and
  `clodex-monitor.json` will actually pick up the seeded descriptions.**
  `seedLibraryDefaults` overwrites a shipped copy only if it is UNEDITED per the
  sha256 in `.seed-state.json`. His live files are byte-identical to the shipped
  ones in the fields I compared, which SUGGESTS they will re-seed — but I did not
  read `.seed-state.json` to confirm the stamp exists, and a legacy unstamped
  file is adopted rather than overwritten. Not asserting it.
- **His three local defs (check-syntax, repo-state, run-tests) get no
  description**, because they are not in the repo — they are machine-specific
  files with absolute paths into the main worktree. They render as the payload
  line alone. Adding descriptions to them is an operator edit, not a code change.

### Doc reconciliation

`docs/exec-tools.md` is ACCURATE — no doc/code disagreement to flag (detail in
A8). The drift was doc-vs-PROMPT.

### Deviation from spec — flagged

The spec's seeding guess (`pot-bin.js:51` EXEC_SCRIPTS) is the wrong path: that
materializes the helper SCRIPTS into `run/bin/`, not the JSON defs. I edited
`resources/library/exec/*.json` instead (the `stores.js` `seedLibraryDefaults`
path). `pot-bin.js` untouched.

## Superseded — original phase-B plan (kept for the record)

**RESULT: prediction confirmed.** `[agent:exec clodex-check-syntax]` fired bare
against my own grant returned exactly
`[agent:exec] clodex-check-syntax: payload: empty (expected JSON)`.
A3 holds end-to-end through the real dispatcher, not just the validator.

Before I write a prompt that tells every agent "a payload-less command still
needs `{}`", I will fire `[agent:exec clodex-check-syntax]` BARE against my own
grant — read-only, non-destructive — and read the bounce. Prediction:
`payload: empty (expected JSON)`. If it instead succeeds, A3 is wrong and I
rewrite it.
