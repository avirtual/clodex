# t115 — reject dot-only session and library names

Shape applied everywhere: `/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/`.
Rejects `.`, `..`, `...`, any run of dots. Keeps `a.b`, `my.agent`, `.hidden`,
`..a`, `a..`.

Done as instructed: shape changed IN PLACE at every site, duplication left
exactly as found, no shared constant introduced.

## Enumeration — what the starting set missed

The spec's list was 18 sites and accurate. Closing it found **six more
executable copies**, all outside the directories the spec's grep covered:

| site | why it was missed |
|---|---|
| `cli/src/verbs.js:588` `NAME_RE` | `cli/` subtree |
| `cli/src/attach.js:221` `NAME_RE` | `cli/` subtree |
| `cli/src/deploy.js:24` `NAME_RE` | `cli/` subtree |
| `scripts/clodex-team.js:311,337` (×2 inline) | `scripts/` subtree |
| `plugins/memory-viewer/engine.js:27` `AGENT_NAME_RE` | `plugins/` subtree |
| `peering/clodex-seed.sh:76,113` (×2, bash) | not a `.js` file |

The plugin one matters beyond bookkeeping: `plugins/memory-viewer/engine.js` is
the guard that t114's ticket identified as *the only correct confinement on the
memory path*. It had the same dot-blind charset regex as everything else — its
correctness came entirely from the separate `agentDir()` dirname check, not
from this regex. Fixing the regex here does not make `agentDir()` redundant.

**`clodex-seed.sh` could not take the same edit.** Bash `=~` is ERE and has no
lookahead, so `(?!\.+$)` is not portable to it — a literal port would have
compiled to something that matches nothing useful and failed open or closed
silently. Written as a second clause instead:

```bash
if [[ ! "$NAME" =~ ^[a-zA-Z0-9._-]{1,64}$ || "$NAME" =~ ^\.+$ ]]; then
```

Verified under `bash` specifically (`bash -n` + a behaviour probe). My first
probe ran under **zsh** and reported `a.b` as rejected — a false failure from
the wrong interpreter, not from the code. Worth recording: this repo's default
shell is zsh, and `[[ =~ ]]` does not agree between the two.

## Deliberately NOT changed, with reasons

- **`team-manifest.js:10` `ROLE_RE`** (and its `renderer/lib/team-roles.js:19`
  twin). A role name never becomes a path segment by itself — seats are
  `<team>-<role>`, always prefixed — so a dot-only role cannot traverse. Left
  as-is and **asserted in the test** (`validateAddRole({name:'..'}).ok === true`)
  so the omission reads as a decision rather than a miss.
- **`exec-schema.js:29` `FILENAME_RE`**. Same charset, different rule: its
  `isFilenameToken()` already rejects any leading dot (`!v.startsWith('.')`),
  which covers every dot-only string. Adding the lookahead would be redundant,
  and changing `FILENAME_RE` alone without the leading-dot check would be a
  behaviour change to exec payloads. Untouched.
- **`peer-deploy.js:105`** — prose only, no regex. Comment updated to the new
  shape, plus a note that the dot-only half needs no mirroring there because
  every name it mints is `fix-`-prefixed.
- **Test-file copies** (`test/session-manager.test.js`, `test/peer.test.js`,
  `test/remote-create.test.js`, `test/engine-web-info-seam.test.js`,
  `test/peer-deploy.test.js`). These are injected fakes and local mirrors, not
  product gates. Updating them would change what the fakes admit and prove
  nothing. Left alone deliberately.

`web-dist/index.html` is generated — `npm run build:web` re-run, all 9 bundled
copies carry the guard.

## Tests — `test/name-dot-only.test.js`, 10 cases

One per named constant, plus a tree-wide sweep and a bash-script case. Every
case asserts BOTH halves (reject the dots, still accept `a.b` / `.hidden`).

Two constants (`MEMORY_AGENT_RE`, `PROMPT_NAME_RE`, and `remote.js`/
`team-manifest.js` `NAME_RE`) are module-private, so they are read out of the
source and `eval`'d. Weaker than an import, and noted as such in the file: it
pins the literal, not that the gate runs.

`validOrigin` in `peer-outbox.js` gets its own assertion. It carried the only
correct dot check in the codebase — a hand-rolled `!== '.' && !== '..'` pair —
which was right about the reported case and blind to `...`. The regex now
covers it; the pair is harmless and stays.

### Mutation verification — every case proven by reverting the product

Reverted each site to `^[a-zA-Z0-9._-]{1,64}$` one at a time, ran the file,
restored from a pristine copy:

| reverted | result |
|---|---|
| `catalogs.js`, `memory-store.js`, `stores.js`, `remote.js`, `peer-outbox.js`, `relay-protocol.js`, `team-manifest.js`, `renderer/lib/team-roles.js` | 8 pass / **2 fail** each (own case + sweep) |
| `renderer.js`, `library-drawers.js`, `ipc-handlers.js`, `clodex-team.js`, `verbs.js`, `attach.js`, `deploy.js`, `memory-viewer/engine.js` | 9 pass / **1 fail** each (sweep only — these have no seam) |
| `clodex-seed.sh` dot clause removed | 9 pass / **1 fail** |

Every one of the 17 sites reddens something. No site is covered by nothing.

**The over-eager fix is also caught.** Replacing the shape with
`^[a-zA-Z0-9_-]{1,64}$` (bans dots entirely — passes every rejection case)
reddens the accept half: 9 pass / 1 fail. That is the case the spec called out
as the one not to skip, and it earns its place.

## State

Full suite **3138 pass / 0 fail** (baseline 3128, +10 — this file). Not
committed.

**Tree overlap with t114, for the split:** `memory-store.js` carries changes
from BOTH tickets — the t115 regex line, and t114's `_dir()` confinement +
`confine()` import + the MEMORY_AGENT_RE comment. `plugins/memory-viewer/
engine.js` is t115-only. Everything else separates cleanly by file.
