# docs/notes/headless-restart.md

## createHeadlessRestart

Headless restarts by EXITING (code 64) and letting a supervisor start the
process again. That makes two things true which are false on the Electron host,
and t910 fixed both:

- The exit is synchronous and lands mid-turn. `[agent:reboot]` is scanned inside
  the requesting seat's own turn, so exiting there destroys the turn boundary the
  reboot notice is delivered across — the rule `main.js` states at its
  `restartHostWhenIdle` seam. Headless had no deferred seam, and `engine.js`'s
  `restartHostWhenIdle = seams.restartHostWhenIdle || restartHost` put the agent
  path on the immediate exit. It now arms the same `createIdleWaiter` the desktop
  arms.
- Nothing may relaunch it. Exit 64 is a contract; unsupervised it is a kill with
  extra steps.

`notify` (the 30-minute give-up) logs at WARN instead of raising an OS
notification: there is no operator surface on this host, and the ops log is what
`journalctl`/`docker logs` show. `onAbandon` still reaches the requesting seat
through the waiter — that callback is the only way an agent learns its relaunch
is never coming, and losing it strands the seat silently.

`disarm` is exported for symmetry with the waiter but has NO caller: unlike
`main.js`, which disarms on `before-quit` because Electron can cancel a quit,
this host's `terminate()` ends in `process.exit(0)` and takes the poll timer with
it. Read it as available, not as a wired path.

## supervisorDeclared

Declared by `CLODEX_SUPERVISED`, never DETECTED. A process cannot know whether
its parent will restart it — a PPID of 1, a systemd cgroup, a docker
`restart:` policy are all guessable and all wrong some of the time — and a wrong
guess is either a box that stays down or an intent that lies to an agent.
Absent means unsupervised, which is the safe answer for a manual `node
headless-main.js`. `0/false/no/off` also decline, so a drop-in written to turn
the capability OFF cannot turn it on by being present.

Every launcher this repo ships restarts the host, so every one of them sets it:
`peering/clodex.service` (the unit `cli/deploy/clodex-deploy.sh` installs on each
spoke, and which `docker/Dockerfile` copies with a WorkingDirectory-only sed, so
the peer box inherits it) and `docker/web/Dockerfile` (run under the
`restart: always` compose `sandbox.js` generates). The restart policy and the
declaration are a PAIR — one without the other either strands the box or lies to
the agent — and `test/supervised-launchers.test.js` pins them together, since
nothing else in the tree would notice them drifting apart.

## restartUnavailable

Asked as its OWN seam rather than inferred from the restart seams, because
`engine.js`'s `|| restartHost` fallback means omitting a restart seam says "use
the immediate one", never "I cannot relaunch" — a host has no way to express the
refusal by leaving something out. It returns a reason string (or null), and
`_handleRebootIntent` asks it AHEAD of the `lastRebootAt` stamp: the stamp is
written at queue time, before any restart seam is reached, so a gate placed after
it leaves a five-minute cooldown behind a request that did nothing.

BOTH restart paths consult it (t969): the agent's `[agent:reboot]`, and the human
one — the peer Restart button's `POST /api/restart` (409 with the reason, and
`restartApp` is never reached) and the web view's `app:restart`. The human path
is a REFUSAL with a visible reason, not a silent no-op: the sidebar toasts the
409 body's `error` and the web menubar alerts it, which is why routing it through
the gate costs the operator nothing.
