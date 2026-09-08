# docs/notes/skill-delivery.md

## deliverCodex

Codex 0.153.4 has no per-process skill root, which is why the delivery is an
instruction-layer catalog rather than a flag. Measured against the real binary
with `codex debug prompt-input`: `-c skills.config=[{path,enabled}]` only
re-toggles skills the CLI already discovered, so a path it has never seen is
ignored. The two other candidates were rejected for non-vendor reasons —
`<cwd>/.agents/skills` writes into the user's own repo and leaks between seats
sharing a cwd, and a private `CODEX_HOME` needs the operator's `auth.json`
copied into it.

## cleanupSeatDir

The seat dir is shared with the claude adapter and with `writeBundlePlugins`,
whose bundle dirs nest under `skill-plugins/<seat>/bundles/`. That nesting is
what lets one teardown reap all three; a second deleter would be a second
unconfined join for no new coverage.
