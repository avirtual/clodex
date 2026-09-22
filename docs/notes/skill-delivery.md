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

## deliverMuse

Muse 1.3.0 discovers user-scope skills from `$XDG_CONFIG_HOME/muse/skills/<dir>/SKILL.md`,
so the seat overlay gets `muse/skills` symlinked at the returned `skillsDir` and no catalog
text. Measured with `XDG_CONFIG_HOME=<seatDir> muse skills list --source user --json`:
the id is the frontmatter `name`, not the dir name (which is why `skillMd` seeds it);
`scope` is `user`; `path` is the literal `$CONFIG_DIR/skills/<dir>/SKILL.md`, the same
key `muse skills disable X --scope user` writes under `skills.activation.user`; colons
in the dir and the name are fine (`stocks:foo` lists); a symlinked skill dir AND a
symlinked `muse/skills` root both list. `bootstrapSeatConfig` never copies the
operator's own `muse/skills`, so the link hides nothing that was visible before.

## cleanupSeatDir

The seat dir is shared with the claude adapter and with `writeBundlePlugins`,
whose bundle dirs nest under `skill-plugins/<seat>/bundles/`. That nesting is
what lets one teardown reap all three; a second deleter would be a second
unconfined join for no new coverage.
