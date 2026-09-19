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
defaults copy silently missed every DISCOVERED skill — a plugin's, a project's —
which could therefore never be pre-unchecked. The defaults shape is deliberately
NARROWER (no `outOfScope`/`disabledSkills`/`skillLib`/`injectSkills`): a default
disabled-list must not inherit one seat's per-session state.

`names` is filtered through `isSkillDenyDirective`: a seat's `disabledSkills`
feeds the union and may hold `*` or `!name`, neither of which is a skill. A
directive that reached the list would draw as a checkbox row and collect into
someone's off list as a skill by that literal name.

## applySessionSkills

PERSISTS only. The settings file the CLI reads is written by `setupClaudeHook`,
whose one call site is `session-manager.js`'s spawn arm, so a skill toggled from
the per-session popover applies on the seat's next fresh start — which is what
the popover's own confirm text says when it offers "Restart fresh".

## termExec

The `busy` refusal names the program holding the tab when `drawer-pty` supplies
one, because the unnamed wording was read as wrong: printed at an operator whose
shell sat idle inside `ssh host`, "a command is running" drew the reply "not busy
though". The refusal was right — typing would have gone to the remote shell.

An empty `running` is reachable: a C mark whose base64 payload did not decode
holds the terminal under no name. That arm keeps the old unnamed wording, since
an empty backtick pair reads as our bug rather than as "we do not know which".

## diagLines

node-pty ships its `spawn-helper` for macOS only, so the helper path, its
`exists=`/`executable=`/`arch=` probe and the three fatal helper warnings in
`diagWarning` are all darwin-only facts. On a Linux node the path names a file
that was never meant to be there, and a boot that printed it read as a fault
report. Pinned by `test/deploy-visible.test.js`.
