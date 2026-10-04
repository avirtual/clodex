# electron-child.js

## CHILD_FLAG

The child script travels on argv, not in an env variable: env is inherited by
everything the parent spawns, so an env marker would turn the child's own
subprocesses (a pty, a helper Electron) into children too.

The dispatch in `main.js` does no plugin-root check. Anyone who can launch the
binary can already run arbitrary JS through it (the RunAsNode fuse is on, and
`scripts/dmg-pty-probe.sh` relies on `ELECTRON_RUN_AS_NODE=1 <exe>`), and the
registered plugin roots are not known before the engine boots. Containment of
what a plugin may launch lives in `host.runtime.electronChild`.

## runChild

A flag that is present but malformed exits 2 and never falls through to the
main boot: falling through would start a second Clodex, lose the
single-instance lock and focus the operator's window, the failure this seam
exists to remove.

## childSpawnSpec

Dev passes `app.getAppPath()` before the flag because the dev binary is
default_app, which loads the path argument as the app. The packaged binary
ignores a path argument and always boots `app.asar`, so it gets the flag alone.

A child shares the parent's default userData; it must `app.setPath('userData')`
and `app.setPath('sessionData')` to a directory of its own before anything
else, or two Chromium instances open one profile.
