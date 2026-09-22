# A batteries-included, SSH-accessible, systemd Ubuntu box that boots a LIVE
# headless Clodex peer — the container plays the role of an already-deployed VPS.
#
# The image bakes EVERYTHING a peer needs: the Electron GUI libs + Xvfb + build
# toolchain, a built checkout of Clodex in ~/wb-wrap-ui, and a pre-enabled
# systemd --user service. So `docker/run.sh up` gives you a peer already
# answering the protocol on 127.0.0.1:7900 — no 10-minute cold deploy. Adding a
# peer becomes: bring the box up, tunnel, connect. Keeping it current is a fast
# `git fetch/reset + npm install (noop) + restart` — which is exactly what the
# "Deploy peer" wizard's re-run (Batch B "Update Clodex") does, so that path is
# still exercised; only the slow cold-install is pre-baked away.
#
# The one manual step after first boot is the interactive OAuth for the agent
# CLIs (the peer server itself runs without it):
#   docker exec -it -u clodex clodex-peer bash -lc 'claude'       # then OAuth
#   docker exec -it -u clodex clodex-peer bash -lc 'codex login'
#
# Build:  docker build -t clodex-peer -f docker/Dockerfile docker
#         (override the source with --build-arg BRANCH=... / REPO_URL=...)
# Run:    docker/run.sh up   (reduced caps + cgroups + key + port)
#
# ── SECURITY / THREAT MODEL (local throwaway test box, NOT a deploy template) ──
# This image exists to run a peer on a laptop for dev/testing. It is deliberately
# permissive and MUST NOT be copied verbatim to a real, internet-facing peer.
# A self-run sandbox assessment (the `docker` agent, uid 1001) enumerated it;
# what we fixed vs. what we accept:
#
#   FIXED here / in run.sh:
#     - No login password on the clodex user (key auth only; PasswordAuthentication
#       no). The old `clodex:clodex` password was dead weight — we only ever use
#       SSH keys + `sudo -n`.
#     - Container escape CLOSED. run.sh runs with NO --privileged and NO
#       CAP_SYS_ADMIN (the assessment showed SYS_ADMIN alone is escape-equivalent
#       via the cgroup-v1 release_agent trick — there is no AppArmor in the
#       LinuxKit VM to block the mount). Instead: --cap-drop ALL + only the caps a
#       systemd/dbus/sshd boot needs, plus Electron launched with --no-sandbox
#       (the sole remaining SYS_ADMIN consumer; harmless to drop since Clodex's
#       renderer already runs with node integration, so that sandbox was never a
#       boundary for it). Verified: `mount -t cgroup` is denied, peer still boots.
#
#   ACCEPTED for a local test box (would be UNACCEPTABLE on a real deploy):
#     - NOPASSWD:ALL sudo (below) — the deploy/update path runs arbitrary
#       `apt install`, so we can't scope it without breaking that path.
#     - Unrestricted outbound egress — the deploy needs Anthropic API, npm, apt,
#       GitHub. A real box wants default-deny egress with an allowlist.
#     - The agent shares the `clodex` uid with the Electron UI + wirescope proxy +
#       claude CLI, and can read ~/.claude/.credentials.json (0600), its own
#       hook.json, and its transcript. Fine when the agent is trusted and the box
#       is disposable; a real deploy wants a separate uid + Yama ptrace_scope + the
#       token injected at the wirescope layer instead of an on-disk creds file.
#     - Docker Desktop bridges the Mac's /Users into the LinuxKit VM by default
#       (/run/host_mark/Users) — that is a Docker Desktop *file-sharing setting*,
#       not something this image sets. To harden, narrow Docker Desktop ▸ Settings
#       ▸ Resources ▸ File sharing to only the dirs you actually need.
#
#   For a real deploy: give the peer its own non-privileged uid, drop NOPASSWD,
#   no --privileged / no SYS_ADMIN, lock egress, and don't share the host home
#   into the VM. If a future need forces SYS_ADMIN back, pair it with
#   userns-remap (in-container root != host root, so release_agent can't be
#   written) or a stronger runtime (gVisor) — SYS_ADMIN without one of those is
#   not a containment boundary.
# ──────────────────────────────────────────────────────────────────────────────

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

# Where Clodex lives, matching peering/clodex-deploy.sh's SRC_DIR default
# ($HOME/wb-wrap-ui) and the systemd unit's WorkingDirectory — so a later wizard
# re-run finds this git tree and just fast-forwards it.
ARG REPO_URL=https://github.com/avirtual/clodex
ARG BRANCH=master

# systemd (as init) + sshd + sudo + the deploy script's preflight toolchain, PLUS
# everything the deploy would otherwise apt-install at peer-setup time: Electron's
# GUI libs, Xvfb, and the build toolchain for the node-pty native addon. Baking
# them here is what turns a 10-minute cold deploy into a fast restart. The t64
# package names are the Ubuntu 24.04 (noble) time_t-transition renames — hardcoded
# because FROM is pinned to 24.04 (clodex-deploy.sh discovers them at runtime
# instead, since it can't assume the release). Keep this list synced with
# clodex-deploy.sh's APT_PKGS and peering/README.md.
#
# python3-venv is here too: the vendored wirescope runs as `uvicorn logproxy:app`
# in a Clodex-managed venv, and Ubuntu's `python3` ships WITHOUT ensurepip — so a
# pip-less venv half-builds and the supervisor silently degrades (no telemetry).
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session \
      openssh-server sudo ca-certificates curl git gnupg \
      python3-venv python3-pip \
      xvfb libnss3 libgbm1 build-essential \
      libatk1.0-0t64 libatk-bridge2.0-0t64 libgtk-3-0t64 libasound2t64 \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Strip systemd units that are pointless in a container and only add noise.
# NOTE: keep systemd-logind — it processes /var/lib/systemd/linger at boot,
# which is what starts clodex's per-user systemd manager (see the linger step
# below). Without it `systemctl --user` in the deploy has no bus to talk to.
RUN find /etc/systemd/system /lib/systemd/system \
      -path '*.wants/*' \
      \( -name '*getty*' -o -name '*udev*' -o -name '*mount*' \
         -o -name 'systemd-tmpfiles*' \) \
      -delete 2>/dev/null; true

# Mask apt's daily timers. On a freshly-booted box they fire immediately and
# grab the dpkg lock, so the deploy wizard's apt-get install loses the race with
# "Could not get lock /var/lib/dpkg/lock-frontend". Also turn off the Periodic
# settings so nothing re-triggers them.
RUN systemctl mask \
      apt-daily.timer apt-daily.service \
      apt-daily-upgrade.timer apt-daily-upgrade.service \
 && printf 'APT::Periodic::Enable "0";\n' > /etc/apt/apt.conf.d/99-no-periodic

# App user with PASSWORDLESS sudo — the deploy script uses `sudo -n` for the
# apt install, the SUID chrome-sandbox, and `loginctl enable-linger`.
# NOPASSWD:ALL is TEST-BOX-ONLY: the deploy/update path runs arbitrary
# `apt install`, so it can't be scoped without breaking it. A real peer must not
# ship this. No login password is set — access is SSH key only (see sshd below).
RUN useradd -m -u 1001 -s /bin/bash clodex \
 && echo 'clodex ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/clodex \
 && chmod 440 /etc/sudoers.d/clodex

USER clodex
WORKDIR /home/clodex

# Agent CLIs, user-global for clodex. The deploy wizard builds Clodex but never
# installs these (per peering/README.md they're a manual step because the login
# is interactive OAuth) — so a spawned session has no `claude`/`codex` to run
# unless we bake them in. PATH is set here and in peering/clodex.service so both
# a login shell and the systemd unit find them. You still authenticate ONCE
# inside the container after first boot (see the header).
ENV PATH=/home/clodex/.npm-global/bin:/home/clodex/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Install the CLIs in SEPARATE steps and VERIFY the bin shims resolve. A
# single `npm install -g pkgA pkgB` was observed to leave claude's bin symlink as
# a dangling staging name (~/.npm-global/bin/.claude-<hash> instead of `claude`)
# — npm creates the shim under a temp name and renames it last, and that rename
# didn't land, so `claude` was command-not-found at runtime with no build error.
# One package per RUN avoids the race, and the `command -v` guards turn any future
# recurrence into a BUILD failure instead of a broken image.
RUN npm config set prefix /home/clodex/.npm-global \
 && echo 'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"' >> /home/clodex/.bashrc \
 && echo 'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"' >> /home/clodex/.profile
RUN npm install -g @anthropic-ai/claude-code --no-audit --no-fund --loglevel=error \
 && command -v claude
RUN npm install -g @openai/codex --no-audit --no-fund --loglevel=error \
 && command -v codex
RUN mkdir -p /home/clodex/.local/bin \
 && curl -fsSL https://api.meta.ai/muse-launcher.sh -o /home/clodex/.local/bin/muse \
 && chmod +x /home/clodex/.local/bin/muse \
 && MUSE_LAUNCHER_INSTALL=1 MUSE_LOGIN=0 /home/clodex/.local/bin/muse \
 && command -v muse

# Pre-create the CLIs' auth dirs so run.sh can mount PERSISTENT named volumes over
# them (claude -> ~/.claude/.credentials.json, codex -> ~/.codex/auth.json,
# muse -> ~/.config/muse/auth.json). A
# fresh named volume inherits the mount path's ownership FROM THE IMAGE — if the
# dir didn't exist here it'd mount root-owned and the CLIs (uid 1001) couldn't
# write their tokens, so you'd re-auth on every container recreation. Creating
# them as clodex is what lets the one-time OAuth survive up/down/rebuild.
RUN mkdir -p /home/clodex/.claude /home/clodex/.codex /home/clodex/.config/muse

# Bake Clodex itself: clone + npm install + electron binary + electron-rebuild.
# This is the slow part of a cold deploy (npm install + the ~100MB Electron
# download + native node-pty rebuild against the Electron ABI) — doing it at
# image-build time is the whole point. Mirrors clodex-deploy.sh's source /
# npm-install / electron-binary / electron-rebuild steps. Runs as clodex so the
# tree is owned by the user the service runs as. A later wizard/seed re-run
# fast-forwards this same git dir instead of cloning from scratch.
RUN git clone --quiet --branch "$BRANCH" "$REPO_URL" /home/clodex/wb-wrap-ui \
 && cd /home/clodex/wb-wrap-ui \
 && npm install --no-audit --no-fund --loglevel=error \
 && { [ -d node_modules/electron/dist ] || node node_modules/electron/install.js; } \
 && npx --yes electron-rebuild

# Enable the peer server (ui-settings.json, MERGE-compatible minimal file) and
# install the systemd --user service PRE-ENABLED, so user@1001 (started by linger
# at boot) brings Clodex up automatically. `systemctl --user enable` just creates
# the default.target.wants symlink — there's no user bus at build time, so we
# make the symlink by hand (identical result). WorkingDirectory is pinned to the
# baked source dir, exactly as clodex-deploy.sh's service step does. The
# --no-sandbox flag lives in peering/clodex.service itself (that unit's comment
# explains why), so a peer-update deploy reinstalling the unit can't strip it —
# we only rewrite WorkingDirectory here, matching the deploy's single sed.
RUN mkdir -p /home/clodex/.config/clodex \
             /home/clodex/.config/systemd/user/default.target.wants \
 && printf '{\n  "remoteEnabled": true,\n  "remotePort": 7900\n}\n' \
      > /home/clodex/.config/clodex/ui-settings.json \
 && sed -e 's#^WorkingDirectory=.*#WorkingDirectory=/home/clodex/wb-wrap-ui#' \
      /home/clodex/wb-wrap-ui/peering/clodex.service \
      > /home/clodex/.config/systemd/user/clodex.service \
 && ln -sf ../clodex.service \
      /home/clodex/.config/systemd/user/default.target.wants/clodex.service

USER root

# chrome-sandbox: the Chromium SUID sandbox needs root:root + mode 4755 or
# Electron refuses to start / node-pty dies with "killed". npm install (run as
# clodex) leaves it clodex-owned, so fix it here as root — mirrors the deploy
# script's `sandbox` step. Guarded in case a future Electron changes the layout.
RUN SANDBOX=/home/clodex/wb-wrap-ui/node_modules/electron/dist/chrome-sandbox \
 && if [ -f "$SANDBOX" ]; then chown root:root "$SANDBOX" && chmod 4755 "$SANDBOX"; fi

# Pre-enable systemd linger for clodex. `loginctl enable-linger` just drops this
# marker file; logind reads it at boot and starts user@1001.service + the user
# bus (/run/user/1001/bus) WITHOUT a login session — which is what starts the
# pre-enabled clodex.service above. Also what the deploy wizard's `systemctl
# --user daemon-reload` needs; doing it in the image means the bus is already up
# before the first deploy, and the script's own enable-linger is then a no-op.
RUN mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/clodex

# sshd: enable the service, key auth on (the wizard tunnels non-interactively).
# Password auth is OFF — the clodex user has no password and we only ever key-auth
# (the wizard, run.sh's `ssh`/`host` helpers, and manual login all use the key).
RUN mkdir -p /run/sshd && ssh-keygen -A \
 && sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -ri 's/^#?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
 && sed -ri 's/^#?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
 && sed -ri 's/^#?AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config \
 && systemctl enable ssh

# On boot, copy a mounted pubkey (/authorized_keys) into clodex's authorized_keys
# so the Mac can key-auth. Runs before sshd. Key auth is the ONLY way in — if no
# key is mounted, the container has no SSH access (by design).
COPY authorize-key.sh /usr/local/bin/authorize-key.sh
COPY authorize-key.service /etc/systemd/system/authorize-key.service
RUN chmod +x /usr/local/bin/authorize-key.sh \
 && systemctl enable authorize-key.service

EXPOSE 22
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
