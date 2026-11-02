# plugins/workbench/git-scm.js

## fetchEachRemote
`git fetch <name>` expands a `remotes.<name>` group before it looks up a remote of that name, and a multi-remote fetch's child processes do not get `--upload-pack`, so a remote that shares a group's name is skipped.
The group keys are re-read before each fetch, but a seat that can write the repo's config can still add a same-named group between that lookup and the fetch; the window is milliseconds, not closed.
