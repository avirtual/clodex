# git-branches

Shows each local session's current git branch as a badge on its sidebar row, and
adds an `[agent:branch]` intent verb that reports the branch back to the agent
that asked.

Built against `hostApi "1"`. `NOTES.md` records what the API did and did not tell
me; `VERIFY.md` is the ordered script for confirming, in a real app, the four
things a stub harness cannot reach.

## Install

Drop this directory into `<repo>/plugins/` and restart the app. It is enabled by
default; toggle it under the **Plugins** menu.

## What you should see

- A branch chip on the row of every local session whose directory is a git repo.
- Nothing on rows that are not repos, have no working directory, or are remote
  sessions — a row badge is the wrong place to explain an absence.
- Detached HEAD renders as the short sha, in italics.
- A repo with no commits yet still shows its branch name, dimmed.

## The `[agent:branch]` verb

An agent emits:

```
[agent:branch]
```

and receives, on its next turn:

```
[git-branches] branch: main
```

or one of `detached HEAD at <sha>`, `not a git repository`,
`not available for remote sessions`, `no branch: <reason>`.

> **It will not fire until you grant it.** Plugin verbs are always privileged
> (§7 of the API): the verb is off for every seat until it is explicitly granted
> in the per-seat intent checklist. Until then nothing happens and nothing is
> logged — that is the host's design, not a bug in this plugin.

## Settings

**Preferences ▸ Git Branches**

| Setting | Default | Range |
|---|---|---|
| Refresh interval (seconds) | 10 | 3–600 |
| Maximum badge length | 18 | 4–60 |

The refresh interval is how often each window re-asks. It is also the floor on
how often `git` actually runs: the engine caches per session with a TTL just
under this, so opening a second window does not double the git processes.

## How it stays correct

`git` runs only in the engine half, only after `host.sessions.fsScope(name)`
approves the session — the same guard core uses, and the thing that refuses
remote sessions. The renderer half never touches the filesystem and never sees a
`cwd`.

Branch state is resolved **on demand**, the first time the sidebar asks about a
session, so sessions that were already running before this plugin was enabled are
covered as well as new ones. Session create/exit invalidate the cache; a
`git checkout` is picked up by the poll, because the API has no event for it.

## Troubleshooting

- **No badges at all** — check the app log for `plugin:git-branches`. If `git` is
  not on the app's `PATH` you will see `git executable not found`.
- **Is it this plugin?** `CLODEX_PLUGINS=0` disables all plugins.

## Files

```
manifest.json   id, entry points, style, announce
engine.js       git resolution, per-session cache, ipc methods, [agent:branch]
renderer.js     row badge + preferences section, one activation per window
style.css       three prefixed classes, theme-neutral
NOTES.md        assumed / missing / misleading — the findings log
VERIFY.md       install-and-verify steps for a real Clodex
```
