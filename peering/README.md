# Headless Clodex (peer node)

Clodex ships as a macOS GUI app, but its main process is plain Node with
platform-aware code, so it runs fully headless on a server and joins your fleet
as a peer you tunnel to from your Mac. Agents on the box can attach, take
control, `[agent:spawn]` other agents, and everything persists across restarts.

There are **two ways** to run it headless:

| Path | Command | Runtime | Status |
|---|---|---|---|
| **Native Node** | `node headless-main.js` | plain Node, no Electron | **current** — no Xvfb, no GUI libs, no SUID sandbox |
| **Xvfb under Electron** | `xvfb-run npm start` | full Electron under a virtual X display | **legacy** — kept working until every spoke migrates |

The native path runs `headless-main.js`, a second host for the same engine
(`engine.js`) that `main.js` — the desktop app — drives: same sessions, same
peer wire, same persistence, none of the GUI baggage. Prefer it for new boxes.
The Xvfb path (the original) is documented in full further down and stays
supported meanwhile. Both are proven on Ubuntu 24.04 (x86_64), no app-code
changes needed.

---

## Native headless path (`node headless-main.js`)

`headless-main.js` stands the engine up under plain Node — no Electron runtime,
so **no Xvfb, no Chromium GUI libs, and no SUID chrome-sandbox** (none of the
legacy steps 4–5 below). node-pty compiles against Node's own ABI, so a plain
`npm install` builds it — **not** `npx electron-rebuild`, which targets
Electron's ABI and would make `node headless-main.js` fail to load node-pty.

### Setup

Toolchain + Claude CLI login are steps 1–2 of the legacy setup below, unchanged
(Node ≥ 20 / git / a C++ toolchain for node-pty, then the `claude` OAuth once).
Then:

```bash
git clone https://github.com/avirtual/clodex.git ~/wb-wrap-ui
cd ~/wb-wrap-ui
npm install          # builds node-pty against Node's ABI — NO electron-rebuild
```

### Run

```bash
node headless-main.js
```

Configuration is by environment:

- **`CLODEX_DATA_DIR`** — the persistence dir (`sessions.json` + the stores).
  Defaults to what a *non-packaged* Electron run resolves `app.getPath('userData')`
  to: `~/.config/clodex` on Linux (**lowercase** — the dev/package name, since
  spokes run `npm start`, never the packaged `Clodex` bundle). So on a box that
  has been running the legacy `xvfb-run npm start` path, a bare `node
  headless-main.js` **auto-adopts the existing `~/.config/clodex/sessions.json`
  unchanged** — the sessions carry straight over. Set it explicitly to migrate
  from a packaged build or to relocate the data dir. Since this version the
  desktop app honours it too — it moves `userData` before taking the
  single-instance lock, so a second Clodex can run beside the first — with the
  same Finder caveat as `CLODEX_HOME` below.
- **`CLODEX_HOME`** — the registry root: teams, the library, `run/<name>/`,
  memory, messages, projects and `clodex.log`. Defaults to `~/.clodex`. Every
  host reads it (`main.js`, `headless-main.js`, `sandbox.js` and the engine all
  resolve through `defaultClodexHome()`), and each spawned agent's `[agent:exec]`
  children are given the resolved root, so one setting moves the whole tree —
  which is how you run **two instances on one box**. Caveat for the desktop app:
  a packaged `.app` launched from Finder inherits no shell environment, so the
  override reaches it only when it is launched from a shell.
- **`CLODEX_LABEL`** — the origin this instance announces to the peers it
  **dials**: a dialed box tags our agents `name@<our label>`, keys its reply
  outbox by it, and its agents reply to that address. It is also the hello
  `host` field that box displays for us. (On the *dialing* side the suffix is
  that side's own configured peer label instead.) Defaults to the box's
  hostname minus a `.local` suffix, which is what two instances on one box
  would otherwise share — leaving every peer they both dial to conflate their
  agents and their reply outboxes. Must clear the same charset gate a
  wire-supplied origin does (`[A-Za-z0-9._-]`, 1–64 chars, not `.` or `..`);
  anything else is ignored with a warning in `clodex.log` and the hostname is
  used.
- **`CLODEX_WORKSPACES`** — comma-separated workspace ids to restore. Defaults to
  the single default workspace (headless nodes are single-workspace by
  convention).

The full two-instances-on-one-box walkthrough, with every instance-scoped
variable in one table, is `docs/recipes/two-instances.md`.

### Exit codes & supervision

`headless-main.js` is built to run under a supervisor:

- **0** — clean SIGTERM/SIGINT teardown (kills PTYs, stops remote/peer/tunnel).
- **1** — another headless instance already holds the pidfile
  (`$CLODEX_DATA_DIR/headless.pid`).
- **64** — restart requested (the phone/menu restart over the peer wire). The
  process shuts down cleanly and exits; **the supervisor does the relaunch.**

So the systemd **user** unit wants `Restart=always` — it relaunches on both a
crash and the deliberate exit-64 restart:

```ini
[Unit]
Description=Clodex (headless, native Node) — multi-agent PTY manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/wb-wrap-ui
# claude CLI lives in the user-global npm prefix; put it on PATH for spawns.
Environment=PATH=%h/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Optional: Environment=CLODEX_DATA_DIR=%h/.config/clodex  (bare default shown)
#           Environment=CLODEX_WORKSPACES=default
ExecStart=/usr/bin/node headless-main.js
Restart=always
RestartSec=5
# exit 64 = a deliberate restart request; Restart=always relaunches it like a
# crash. Give the app time to release its pidfile + unix sockets first.
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

Install it the same way as the legacy unit — drop it in
`~/.config/systemd/user/`, then `loginctl enable-linger <user>` and `systemctl
--user enable --now <unit>` (see *Persistent service* below for the exact
commands). `journalctl --user -u <unit> -f` tails it; the app also mirrors to
`~/.clodex/clodex.log` and to stdout/stderr.

Creating/removing sessions and peering from your Mac are identical to the legacy
path — see *Creating &amp; removing sessions* and *Peering to it from your Mac*
below (same `~/.config/clodex/sessions.json`, same 127.0.0.1:7900 peer server
over an SSH tunnel). The one difference: with no live reload, a seeded session
needs a `systemctl --user restart <unit>` to spawn, same as today.

---

## Legacy path (Xvfb under Electron)

> **Legacy.** This runs the *full Electron app* under a virtual X display. It
> still works and is what deployed spokes use today — migrate them to the native
> `node headless-main.js` path above when convenient. Everything from here down
> describes this path; it's stock Clodex plus the three helpers in this folder:

| File | Role |
|---|---|
| [`clodex-deploy.sh`](clodex-deploy.sh) | Idempotent one-shot install/update: clone → build → sandbox fix → enable the peer server → systemd unit. Re-run = update. |
| [`clodex-seed.sh`](clodex-seed.sh) | Create/remove headless sessions + (re)start the app |
| [`clodex.service`](clodex.service) | systemd **user** unit: run at boot, auto-restart, survive logout |

The fastest path is the Mac wizard (**Peers → Add peer → Test &amp; Set Up**),
which runs `clodex-deploy.sh` on the box for you over SSH. The manual steps below
are the reference/fallback; copy the helpers to the box during setup.

---

## Why it works (and the two things it needs)

`npm start` is just `electron .`, and Electron has a Linux binary. `main.js`
already branches on `process.platform` (it was never macOS-only). node-pty
compiles fine on Linux (it uses `forkpty()` directly; the separate
`spawn-helper` binary is a macOS-only artifact — the "spawn-helper not found"
startup diagnostic is a benign false alarm on Linux).

Electron is still a **GUI binary**, so headless needs:
1. **A virtual display** — `Xvfb` (Electron won't start without an X server).
2. **Chromium's system libs** — a fixed set of `.so` packages.

Neither is macOS-specific; both are stock apt packages.

---

## One-time setup

> **Automated path.** Steps 3–7 below (clone, build, sandbox fix, enable the
> peer server, install + start the systemd unit) are exactly what
> [`clodex-deploy.sh`](clodex-deploy.sh) does — idempotently, so a re-run is the
> update path. Run it directly on the box (`PORT=7900 bash clodex-deploy.sh`) or,
> from your Mac, let **Peers → Add peer → Test &amp; Set Up** run it over SSH. It
> emits `::step`/`::ok`/`::fail` markers and, if it needs root without a
> passwordless `sudo`, prints the exact commands and stops (never prompts). You
> still do steps 1–2 (toolchain + the Claude CLI login) by hand — the OAuth is
> interactive.

### 1. Toolchain (as the app user)
Node ≥ 20, npm, git, and a C/C++ toolchain (make/g++/python3) for node-pty.
On a fresh box these are usually present or a one-line apt install.

### 2. Claude CLI — user-global, no root
```bash
npm config set prefix ~/.npm-global
npm install -g @anthropic-ai/claude-code
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
```
Then authenticate once: run `claude` in a plain shell and complete the OAuth.
Credentials persist to `~/.claude/.credentials.json` and every spawned session
picks them up.

### 3. Clone + build Clodex
```bash
git clone https://github.com/avirtual/clodex.git ~/wb-wrap-ui
cd ~/wb-wrap-ui
npm install
npx electron-rebuild          # rebuild node-pty against Electron's ABI
```

### 4. Electron GUI libs + Xvfb (needs root — apt)
```bash
sudo apt-get update
sudo apt-get install -y \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 \
  libcups2t64 libgtk-3-0t64 libasound2t64 libxdamage1 libcairo2 \
  libpango-1.0-0 libgbm1 xvfb
```
(Package names are Ubuntu 24.04 "noble"; the `t64` suffix is the time_t
transition. On other releases, `ldd node_modules/electron/dist/electron | grep
"not found"` tells you exactly what's missing.) `clodex-deploy.sh` checks for
these with the unsuffixed names *and* their `t64` aliases (`dpkg -s libasound2
|| dpkg -s libasound2t64`), so an already-satisfied box isn't re-flagged as
missing on every re-run — keep the two lists in sync.

### 5. Fix Chromium's SUID sandbox (needs root, one-time)
```bash
sudo chown root:root ~/wb-wrap-ui/node_modules/electron/dist/chrome-sandbox
sudo chmod 4755      ~/wb-wrap-ui/node_modules/electron/dist/chrome-sandbox
```
This is the correct fix — do NOT use `--no-sandbox`. (An `electron-rebuild` or
reinstall resets this; re-run if node-pty is rebuilt.)

### 6. Install the helpers
```bash
cp peering/clodex-seed.sh ~/clodex-seed.sh && chmod +x ~/clodex-seed.sh
mkdir -p ~/.config/systemd/user
cp peering/clodex.service ~/.config/systemd/user/clodex.service
```
(Copy them off a checkout of this repo, or `scp` from your Mac.)

### 7. Smoke test
```bash
cd ~/wb-wrap-ui
xvfb-run -a npm start      # Ctrl-C after you see "Clodex startup diagnostics"
```
GTK accelerator warnings are cosmetic (no menu bar in headless). If it prints
the diagnostics and finds your `claude` binary, it's up.

---

## Persistent service (systemd user unit)

The unit (`clodex.service`) runs at boot without login (linger), auto-restarts
on crash, survives logout. Enable it:

```bash
sudo loginctl enable-linger <user>        # boot without login (root)
export XDG_RUNTIME_DIR=/run/user/$(id -u) # needed for --user over SSH
systemctl --user daemon-reload
systemctl --user enable --now clodex.service
```

Manage (over SSH, always export `XDG_RUNTIME_DIR` first):
```bash
systemctl --user status  clodex
systemctl --user restart clodex           # every session --resumes with history
systemctl --user stop    clodex
journalctl   --user -u   clodex -f        # live app logs
```

## macOS peers

A mac is a supported deploy target for **source install/update over SSH**, but
Clodex is **not** auto-started there. `clodex-deploy.sh` is OS-aware (`uname -s`):
on Darwin it walks preflight → source → npm → electron-rebuild → settings and
**skips** the Linux-only steps (apt deps, the SUID chrome-sandbox, the systemd
service + linger) with a note per step — no `systemctl`, no unit, no brew.

- **Update path** (header-menu *Update Clodex* against a mac): the script updates
  the checkout, then the wizard restarts the already-running app via
  `POST /api/restart` — no service manager involved. `verify` probes hello for
  ~5s; the still-running OLD app answers, and the post-restart hello is the real
  version check.
- **Fresh deploy** on a mac ends with the source built but nothing running —
  start it manually (`npm start`, or launch the app). `verify` notes this on
  stderr instead of failing (nothing auto-starts by design).

---

## Creating & removing sessions (`clodex-seed.sh`)

Since v2.10.0 a peer **can** create / kill / restart sessions over the wire (the
`create` capability — that's what the Mac wizard's new-session dialog and the
per-row restart/kill use), so day-to-day you rarely touch this script anymore.
It still earns its keep for **bulk/scripted** seeding and for editing entries
while the app is down: Clodex reads `~/.config/clodex/sessions.json` **only at
launch** (no live reload), so a seeded session needs a restart to spawn.
`clodex-seed.sh` writes the entry (mirroring the shape `manager.create()`
persists) and restarts.

```bash
# add / update a session, then restart (existing agents --resume untouched)
~/clodex-seed.sh <name> [claude|codex] [cwd]

# remove a session: drop the entry, restart (kills it), wipe its runtime files
~/clodex-seed.sh remove <name>

# edit files only, no restart (apply later with systemctl --user restart clodex)
SKIP_LAUNCH=1 ~/clodex-seed.sh <name> ...
```

The script auto-detects the systemd unit and restarts it; on boxes without the
service it falls back to a tmux + `xvfb-run` launch.

**Gotcha: never run an agent in `$HOME`.** Claude's trust-dir prompt nags
forever there. Use a real project dir, e.g. `~/projects/<name>` (the script
warns you if you try).

Sessions can also be created from *within* Clodex via `[agent:spawn name:X
cwd:Y]` — that goes through the live `create()` path, so it spawns immediately
AND auto-persists to `sessions.json` (restored on the next restart, same as a
seeded one).

---

## Peering to it from your Mac

The peer server binds `127.0.0.1:7900` **by design** — you reach it over an SSH
tunnel, which Clodex's tunnel manager creates for you. On the Mac:

1. Clodex → Peers → **Add peer**
2. **label**: anything (e.g. the box hostname); **ssh host**: `user@host`
3. Leave URL blank; remotePort defaults to 7900 (matches the box). Save.

Clodex runs `ssh -N -L <freeport>:127.0.0.1:7900 user@host` itself. It uses
`BatchMode=yes` (**key auth only** — no password prompt), so make sure your Mac
can `ssh user@host` with a key first. The peer header goes online in a few
seconds and the box's sessions appear as remote tabs.

---

## Notes / troubleshooting

- **`systemctl --user` over SSH does nothing / "Failed to connect to bus"** —
  export `XDG_RUNTIME_DIR=/run/user/$(id -u)` first.
- **"chrome-sandbox … is not configured correctly" → SIGTRAP** — step 5 not
  applied (or reset by a rebuild).
- **`error while loading shared libraries: lib*.so`** — a step-4 package is
  missing; `ldd` the electron binary to find which.
- **App runs but sessions don't spawn** — check `~/.clodex/clodex.log` for
  `spawn <name>` lines and `journalctl --user -u clodex`.
- **Runtime dir** `~/.clodex/` is created by spawned sessions — it's output,
  not config (config is `~/.config/clodex/`). Per-agent artifacts (socket,
  registry entry, transcript symlink, hook scripts, side-channels) live under
  `~/.clodex/run/<name>/`; shared state stays at the root (`messages/`,
  `pending/`, `agents/`, `skills/`). No manual cleanup needed — a stale flat
  layout from an older build is migrated once on the next launch.
