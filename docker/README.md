# Clodex in Docker — a live peer you can tunnel to

A starting point for running Clodex headless inside a container and peering to it
from your Mac. The image bakes **everything** a peer needs — Electron GUI libs,
Xvfb, a built checkout of Clodex, and a pre-enabled systemd service — so
`docker/run.sh up` gives you a peer **already answering the protocol**, not a
bare box you then wait ten minutes to deploy onto.

> **This is a local, throwaway TEST box, not a production template.** It runs
> with passwordless sudo and unrestricted egress so the deploy/update path works
> unattended. Read the **Security** section before copying any of it toward a
> real, internet-facing peer. The threat model is documented in full at the top
> of [`Dockerfile`](Dockerfile).

Proven on Docker Desktop for Mac (Apple Silicon, LinuxKit VM, cgroup v2).

| File | Role |
|---|---|
| [`Dockerfile`](Dockerfile) | Batteries-included image: deps + baked Clodex + pre-enabled `--user` service + threat-model header |
| [`run.sh`](run.sh) | `build \| up \| down \| reset \| logs \| ssh \| host` — the only command you run |
| [`authorize-key.sh`](authorize-key.sh) / [`authorize-key.service`](authorize-key.service) | Boot unit that installs the mounted pubkey into `clodex`'s `authorized_keys` |

---

## Prerequisites

- **Docker Desktop** running (`docker info` works).
- **An SSH keypair** at `~/.ssh/id_rsa` / `~/.ssh/id_rsa.pub`. The container
  authorizes your public key; auth is **key-only** (no passwords). Override with
  `PUBKEY=~/.ssh/other.pub docker/run.sh up`.

---

## Quick start

Run these from the repo root.

```bash
docker/run.sh up            # build if needed, then boot the peer (SSH on :2222)
docker/run.sh logs          # watch systemd boot (Ctrl-C to stop watching)
```

Within a few seconds the peer is answering on `127.0.0.1:7900` **inside** the
container. Confirm:

```bash
docker exec -u clodex clodex-peer \
  bash -lc 'curl -fsS http://127.0.0.1:7900/api/peer/hello'
# {"ok":true,"app":"clodex","host":"clodex-docker","version":"…","caps":[…]}
```

### 1. Authenticate the agent CLIs (once)

The peer server runs without it, but agents need a logged-in `claude` / `codex` / `muse`.
Do this once — it persists (see *Credentials persist*):

```bash
docker exec -it -u clodex clodex-peer bash -lc 'claude'       # then OAuth in browser
docker exec -it -u clodex clodex-peer bash -lc 'codex login'  # optional
docker exec -it -u clodex clodex-peer bash -lc 'muse'         # optional, device login
```

### 2. Peer to it from the Mac

The container only binds `127.0.0.1:7900` inside itself; Clodex reaches it over
an SSH tunnel it manages for you. Give SSH a host alias:

```bash
docker/run.sh host >> ~/.ssh/config     # appends a ready-to-use 'clodex-docker' block
```

Then in the Mac app: **Peers → Add peer**, set **ssh host** to `clodex-docker`,
connect. Clodex opens the tunnel, sees the hello, and the box joins your fleet —
you can attach, take control, `[agent:dm]`/`[agent:spawn]`, and it all persists
across restarts.

> Prefer the wizard's **Test & Set Up**? It works too — it re-runs the deploy
> script over SSH, which on this pre-baked image is just a fast `git fetch/reset`
> + `npm install` (near-noop) + restart. The slow cold-install is already done.

---

## `run.sh` commands

| Command | What it does |
|---|---|
| `up` | Build if the image is missing, drop the stale host key, boot the container (`--cap-drop ALL` + minimal caps + cgroups + key + auth volumes) |
| `down` | Remove the container. **Keeps** the auth volumes — next `up` is still logged in |
| `reset` | Remove the container **and** the auth volumes — next `up` needs fresh OAuth |
| `build` | Rebuild the image (picks up a newer `master`; see *Updating*) |
| `logs` | Follow the container's systemd/boot logs |
| `ssh` | Open an interactive shell as `clodex` (key auth, host-key checks off) |
| `host` | Print an `~/.ssh/config` block aliasing the box as `clodex-docker` |

Environment overrides: `SSH_PORT` (default `2222`), `PUBKEY`, `CLODEX_HOSTNAME`
(default `clodex-docker` — this is the name that shows in your Mac's peer list).

---

## How it works

`npm start` is just `electron .`, and Electron has a Linux binary. Under Xvfb
(`xvfb-run -a npm start`) the whole app runs with no display. systemd is **PID 1**
(`/sbin/init`), `enable-linger` starts a per-user systemd manager at boot, and a
pre-enabled `clodex.service` (`--user`) brings the app up automatically. The
image mirrors what `peering/clodex-deploy.sh` would do over SSH — apt deps, clone,
`npm install`, the ~100 MB Electron download, the native `node-pty` rebuild, the
SUID `chrome-sandbox` fix, `ui-settings.json`, the systemd unit — but does it at
**build time** so a running peer is one command away.

**Credentials persist.** `~/.claude`, `~/.codex` and `~/.config/muse` are **named
Docker volumes** (`clodex-peer-claude`, `clodex-peer-codex`, `clodex-peer-muse`),
so your one-time OAuth survives
`up`/`down`/rebuild. Only `reset` (or `docker volume rm`) clears them.

**Host keys.** Every rebuild regenerates the container's SSH host keys. `up`
runs `ssh-keygen -R "[localhost]:2222"` first so your Mac re-learns the new key
via TOFU instead of failing with *"Host key verification failed"*.

---

## Updating Clodex on the box

The baked checkout is pinned to whatever `master` was **at image build time**.
Two ways to move it forward:

- **In place (fast):** `docker/run.sh ssh`, then
  `cd ~/wb-wrap-ui && git pull && npm install && systemctl --user restart clodex`.
  Or just run the Mac wizard's **Update Clodex** — same thing over SSH.
- **From scratch:** `docker/run.sh build` re-clones current `master`. Your auth
  volumes survive, so no re-login.

> Building from GitHub `master` means **uncommitted local work is not included**
> until you push it. Point the build elsewhere with
> `docker build --build-arg BRANCH=my-branch -t clodex-peer -f docker/Dockerfile docker`.

---

## Security / threat model

This box is deliberately permissive so an unattended deploy works. It is safe as
a **disposable local test target with a trusted agent inside**, and unsafe as a
template for a real peer. Highlights (full detail in the [`Dockerfile`](Dockerfile)
header):

**Hardened vs. the naive setup:**
- **Not `--privileged`, and no `CAP_SYS_ADMIN`.** Runs with `--cap-drop ALL` and
  adds back only CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID, SETPCAP,
  NET_BIND_SERVICE, SYS_CHROOT (`CapBnd=0x405eb`). `CAP_SYS_ADMIN` is deliberately
  NOT granted. Because it's absent from the *bounding* set — a hard ceiling — no
  setuid-root binary or file capability can restore it, so the cgroup-v1
  `release_agent` escape (a real prior finding on the SYS_ADMIN build) is
  structurally blocked: the `mount()` syscall is unusable. A seccomp filter is
  active and blocks namespace creation (`unshare` is EPERM), closing the
  user-namespace route to a namespaced SYS_ADMIN. Verified read-only on Opus 4.8:
  release_agent mount = EPERM, no raw devices (`mknod` EPERM), `/proc/sys`
  read-only, no host docker/containerd socket. (An earlier `--privileged` build
  let an agent read the shared VM disk at the block layer — that's closed too.)
- **Key-only SSH**, no login password.

**Accepted for a test box — DO NOT carry to production:**
- `NOPASSWD:ALL` sudo (the deploy runs arbitrary `apt`).
- Unrestricted outbound egress.
- The agent shares the `clodex` uid with the UI/proxy and can read its own
  `~/.claude/.credentials.json`, hook config, and transcript.
- **Docker Desktop bridges your Mac's `/Users` into the VM by default**
  (`/run/host_mark/Users`). That's a Docker Desktop *file-sharing setting*, not
  something this image sets — narrow it in **Docker Desktop → Settings →
  Resources → File sharing** if you care.

For a real deploy: separate non-privileged uid, drop `NOPASSWD`, default
seccomp/AppArmor, default-deny egress, and don't share the host home into the VM.

---

## Troubleshooting

- **"Host key verification failed" when peering.** The box was rebuilt and its
  host key changed. `docker/run.sh up` clears the stale entry automatically; if
  you hit it mid-session, run `ssh-keygen -R '[localhost]:2222'` and reconnect.
- **`claude: command not found` inside the box.** Shouldn't happen (the build
  verifies the shim), but if it does:
  `docker exec -u clodex clodex-peer bash -lc 'npm install -g @anthropic-ai/claude-code'`.
- **Asked to authenticate every time.** You're on an old image without the auth
  volumes, or you ran `reset`. Rebuild (`docker/run.sh build`), `up`, and OAuth
  once more — it'll stick.
- **systemd won't boot / cgroup errors.** Rare on Docker Desktop. If the minimal
  cap set isn't enough on your host, add back **only** the specific capability the
  boot error names — do **not** reach for `--privileged` or `--cap-add SYS_ADMIN`,
  which re-open the container-escape this build deliberately closes (see the cap
  comment in `run.sh`). If you truly need SYS_ADMIN, pair it with `userns-remap`
  or gVisor so in-container root ≠ host root.
- **Peer never appears in the Mac list.** Check the tunnel target is `clodex-docker`
  and that `docker/run.sh host` was appended to `~/.ssh/config`; confirm the hello
  responds from inside the box (command in *Quick start*).
