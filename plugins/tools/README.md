# Plugin author tools

Run from the repo root. The whole loop:

```
node plugins/tools/build-context.js            # 1. the context pack for an agent
node plugins/tools/scaffold.js my-plugin       # 2. a valid, empty plugin
node plugins/tools/verify.js plugins/my-plugin # 3. does it run?
```

A plugin directory is always named for its manifest `id` — the loader matches
them and refuses a mismatch, which is why step 2 generates the pair together.

## `build-context.js` — the authoring context pack

```
node plugins/tools/build-context.js [out.md]          # full  (~41k tokens)
node plugins/tools/build-context.js --lean [out.md]   # drops plugin-sources.md
```

Concatenates this directory's docs, `plugin-api.md`, `plugin-sources.md`, and the
complete `git-branches` source, behind a **generated facts table** — `hostApi`,
the id and verb regexes, the reserved ids, and every verb core already owns —
read out of `plugin-api.js` and `intent-registry.js` at run time.

Pass it to an agent as its system prompt (`claude --system-prompt-file`) and the
plugin becomes an implementation task rather than a discovery task.

Generated on demand, never committed: a checked-in pack is a second copy of the
docs, and a drifted pack is worse than none because the author cannot see why
their plugin fails. `--lean` is a hypothesis, not a recommendation — the full
pack is the only composition a real trial has built a working plugin from.

## `scaffold.js` — start from something that already passes

```
node plugins/tools/scaffold.js my-plugin [target-dir] [--skill <name>] \
  [--prompt <kind>/<stem>] [--template <stem>]
```

Writes `manifest.json`, `engine.js`, `renderer.js` with the id and directory name
generated from one argument, so they cannot disagree. The id is checked with the
host's own `isValidPluginId`, which also refuses reserved names a bare regex
test would accept. The result passes `verify.js` before you write any logic.

`--skill <name>` also writes `skills/<name>/SKILL.md` — a two-line stub with the
frontmatter the CLI needs — so the plugin ships a skill the seats that have it
invoke as `/<plugin-id>:<name>`. `--prompt <kind>/<stem>` writes
`prompts/<kind>/<stem>.md` (kind is `system` or `append`), and `--template <stem>`
writes `templates/<stem>.json`. Every name is checked against the host's
`AGENT_NAME_RE`, the same rule the loader applies when it reads the bundle, so a
name the app would skip is refused here instead of written and silently ignored.

Given both `--prompt` and `--template`, the generated template references the
generated prompt **by bare stem**, which is what the loader rewrites to
`<plugin-id>:<stem>` on read — so the stub demonstrates the form authors should
write rather than the form the app stores.

## `verify.js` — does this plugin actually run?

```
node plugins/tools/verify.js plugins/git-branches
node plugins/tools/verify.js ~/.clodex/plugins/my-plugin
```

Drives your plugin through the **real** `plugin-loader.js` and
`plugin-host-engine.js` — the same two factories the app uses — so a pass means
`activate()` ran against the true host surface, not a mock of it. Exits 0 when
every check passes, 1 otherwise.

Checks: manifest parses and is discoverable, `hostApi` matches this host, every
declared file exists, every `.js` passes `node --check`, `activate()` succeeds
and registers at least one surface, each declared ipc method answers without
crashing, session hooks fire without logging an error, and `deactivate()`
releases everything.

It also reports the **content bundle** the loader read out of the folder: how many
skills, agents, prompts (split by kind) and templates it accepted, each under its
`<plugin-id>:<name>`, whether a copy under this root is editable in the app, and one
line per entry it skipped with the loader's own reason (a name failing
`AGENT_NAME_RE`, a `skills/<name>/` with no readable `SKILL.md`, a template that is
not parseable JSON). The counts come from the real
`readBundle` by way of `discover()`, not a second reading, so what you see is what
a seat would get. A bundle entry counts as a registered surface, which is what
lets a content-only plugin — a manifest naming neither half — pass.

Lines beginning `note` are observations, not requirements — an intent verb is
optional, so its absence is reported and never failed, and so is an empty bundle.

A plugin that only *parses* is not a plugin that *works*: `node --check` is the
floor here, not the test.

## `control.js` — is `verify.js` still able to fail?

```
node plugins/tools/control.js
```

Copies the shipped `git-branches`, breaks it eight ways (one defect each), and
requires `verify.js` to fail every mutant and pass the unmutated baseline.
Exits 0 only if all eight are handled correctly.

Run this after changing `verify.js`. A verifier that only ever prints PASS is
indistinguishable from one with a broken assertion, so the checks are worth
nothing until the instrument is shown to detect a defect that is present.
