# docs/notes/engine.md

## writeBundlePlugins

Writes INSIDE `skill-plugins/<session>/bundles/`, unlike the two flat
scaffolders which each own a root. Two consequences the code cannot show:

- `writeSkillPlugin` must run FIRST at every spawn. Its `rmSync` clears
  `skill-plugins/<session>`, which contains `bundles/`, so a bundle written
  before it is deleted after being written. Pinned by
  `test/plugin-bundle-spawn.test.js`.
- There is deliberately no `cleanupBundlePlugins`: `cleanupSkillPlugin` already
  rm -rf's the seat dir on every exit path, so bundles die with it. A second
  deleter would be a second unconfined join for no new coverage.

The CLI plugin name inside a bundle is the Clodex plugin id, which is what makes
the CLI namespace its contents `<plugin-id>:<skill>` / `<plugin-id>:<agent>`.

A skill's companion files ride the record `readBundle` built, capped there at
64 files / 1 MiB per skill — over either, the whole skill is dropped. They are
written 0600, except under `scripts/`, which Claude Code executes and which
therefore gets 0700.

## sweepDiscoveredSkills

Head-bounded at 256 KiB per transcript: the CLI writes its `skill_listing` near
the top of a session — measured live, every seat's first initial listing sat
below 23 KiB while two transcripts had passed 38 MB, and the bounded sweep over
17 seats took 9.6 ms for the same 21 names a full read (221 ms, 88.7 MB) found.
Truncating at the last newline keeps the tail's partial line out of the JSON
parse. Folded into `skillsSeen`, so a box whose run dirs went still has them.

## readSkillCatalog

Takes `{name}` for a seat or `{cwd}` for the defaults dialog, which has no
session and so no transcript to scan. These were two separate unions, and the
defaults copy silently missed every DISCOVERED skill — `design`, `dataviz` —
which could therefore never be pre-unchecked. The defaults shape is deliberately
NARROWER (no `outOfScope`/`disabledSkills`/`skillLib`/`injectSkills`): a default
disabled-list must not inherit one seat's per-session state.
