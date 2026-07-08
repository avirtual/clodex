# Headless Clodex on Linux (peer node)

Clodex ships as a macOS GUI app, but it's an Electron/Node app with
platform-aware code — so the **main process runs on Linux** too. With a virtual
display (Xvfb) it runs fully headless on a server and joins your fleet as a peer
you tunnel to from your Mac. Agents on the box can attach, take control,
`[agent:spawn]` other agents, and everything persists across restarts.

Proven end-to-end on Ubuntu 24.04 (x86_64). No app-code changes are needed —
it's stock Clodex plus the two helpers in this folder:

| File | Role |
|---|---|
| [`clodex-seed.sh`](clodex-seed.sh) | Create/remove headless sessions + (re)start the app |
| [`clodex.service`](clodex.service) | systemd **user** unit: run at boot, auto-restart, survive logout |

Copy both to the box during setup (steps below).

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
"not found"` tells you exactly what's missing.)

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

---

## Creating & removing sessions (`clodex-seed.sh`)

Clodex reads `~/.config/clodex/sessions.json` **only at launch** — there is no
live reload, and no over-the-wire "create session" endpoint (peers can attach /
control / restart existing sessions, not spawn new ones). So a headless session
is created by writing the entry and restarting the service. `clodex-seed.sh`
does exactly that, mirroring the entry shape `manager.create()` persists.

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
- **Runtime dir** `~/.clodex/` (sockets, registry, JSONL) is created by spawned
  sessions — it's output, not config. Config is `~/.config/clodex/`.
