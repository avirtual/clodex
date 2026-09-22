#!/usr/bin/env bash
# Build + run a systemd box that boots a LIVE headless Clodex peer.
#
#   docker/run.sh [build|up|down|reset|logs|ssh|host]
#
# The image (see Dockerfile) bakes Clodex + all deps + a pre-enabled service, so
# 'up' brings up a peer already answering on 127.0.0.1:7900 — no cold deploy.
# 'up' runs the container with reduced caps + host cgroups (see below), maps SSH
# to host port 2222, and authorizes ~/.ssh/id_rsa.pub. After it's up:
#   1) docker/run.sh host      # prints an ~/.ssh/config block to paste
#   2) Mac Clodex -> Peers -> Add peer -> ssh host = clodex-docker -> connect
#      (Test & Set Up re-runs the deploy = a fast git fetch/reset + restart)
#   3) authenticate the agent CLIs once: docker exec -it -u clodex clodex-peer \
#      bash -lc 'claude'   (then OAuth); same for `codex login`.
#
# The agent CLIs' auth dirs (~/.claude, ~/.codex) live in PERSISTENT named volumes
# (clodex-peer-claude / clodex-peer-codex), so that one-time OAuth survives
# up/down/rebuild — you don't re-auth every time. 'down' keeps the volumes;
# 'reset' wipes them (forces a fresh OAuth).
set -euo pipefail

IMAGE=clodex-peer
NAME=clodex-peer
# The container's hostname — surfaces as the peer's "host" in the hello
# ({"host":"clodex-docker",...}) instead of a random container-id, so it reads
# nicely in the Mac's peer list.
HOSTNAME_="${CLODEX_HOSTNAME:-clodex-docker}"
SSH_PORT="${SSH_PORT:-2222}"
PUBKEY="${PUBKEY:-$HOME/.ssh/id_rsa.pub}"
HERE="$(cd "$(dirname "$0")" && pwd)"

cmd="${1:-up}"

build() { docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"; }

case "$cmd" in
  build) build ;;
  up)
    docker image inspect "$IMAGE" >/dev/null 2>&1 || build
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # Each (re)build regenerates the container's SSH host keys, so the box's
    # identity changes under the same localhost:PORT. The deploy wizard connects
    # with StrictHostKeyChecking=accept-new (ssh-run.js) — which silently accepts
    # an UNKNOWN host but REFUSES a CHANGED key ("Host key verification failed").
    # Drop the stale entry here so first contact is "unknown" again and TOFU
    # re-learns the fresh key. Only touches this throwaway box's own entry.
    ssh-keygen -R "[localhost]:$SSH_PORT" >/dev/null 2>&1 || true
    [ -f "$PUBKEY" ] || { echo "no pubkey at $PUBKEY (set PUBKEY=...)" >&2; exit 1; }
    # NOT --privileged, and NOT --cap-add SYS_ADMIN. A self-run sandbox assessment
    # demonstrated that SYS_ADMIN alone is privileged-EQUIVALENT for escape here:
    # it permits mounting a cgroup-v1 hierarchy and writing `release_agent`, which
    # the kernel then runs as ROOT IN THE HOST VM's init namespace (the classic
    # release_agent escape) — reaching the Docker socket and /host_mnt/Users. The
    # default AppArmor that would normally deny that mount DOES NOT EXIST in the
    # LinuxKit VM, so there is no second line of defense. So we drop ALL caps and
    # add back only the handful a full systemd + dbus + sshd boot needs, none of
    # which enable the escape:
    #   SETUID/SETGID/SETPCAP  user switching + dbus dropping its own caps
    #   CHOWN/DAC_OVERRIDE/FOWNER  boot-time file ownership/permission fixups
    #   KILL                   systemd signalling services it doesn't uid-own
    #   NET_BIND_SERVICE       sshd binding privileged port 22
    #   SYS_CHROOT             sshd privilege-separation chroot("/run/sshd")
    # None of these re-open the escape: it needs SYS_ADMIN to mount a cgroup
    # hierarchy, and none of the above grant mount. (SYS_CHROOT only permits
    # chroot(), which can't mount or write cgroup release_agent.)
    # Electron's Chromium sandbox is the one thing that WANTED SYS_ADMIN (to build
    # its namespace sandbox in a container); the image runs it with --no-sandbox
    # instead (safe — Clodex already runs nodeIntegration+no-contextIsolation, so
    # that sandbox was never a boundary for it). See the Dockerfile service step.
    # Verified on Docker Desktop (LinuxKit, cgroup v2): systemd reaches running
    # with 0 failed units, the peer answers, and `mount -t cgroup` is denied.
    #
    # Intentionally NOT setting --security-opt no-new-privileges: it stops a process
    # from GAINING privileges via execve (setuid/file-caps stop taking effect), which
    # breaks the clodex NOPASSWD `sudo -n` deploy/update path (sudo is setuid-root).
    # Safe to omit here because SYS_ADMIN is absent from the cap bounding set, so
    # no_new_privs would add no escalation protection — the ceiling already provides
    # it. Accepted, understood gap.
    docker run -d --name "$NAME" \
      --hostname "$HOSTNAME_" \
      --cap-drop ALL \
      --cap-add SETUID --cap-add SETGID --cap-add SETPCAP \
      --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
      --cap-add KILL --cap-add NET_BIND_SERVICE --cap-add SYS_CHROOT \
      --cgroupns=host \
      -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
      --tmpfs /run --tmpfs /run/lock \
      -p "$SSH_PORT:22" \
      -v "$PUBKEY:/authorized_keys:ro" \
      -v "${NAME}-claude:/home/clodex/.claude" \
      -v "${NAME}-codex:/home/clodex/.codex" \
      -v "${NAME}-muse:/home/clodex/.config/muse" \
      "$IMAGE"
    echo "up: ssh -p $SSH_PORT clodex@localhost   (run 'docker/run.sh host' for an ssh-config block)"
    ;;
  down)  docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed $NAME (auth volumes kept; 'reset' to wipe)" || echo "not running" ;;
  reset) docker rm -f "$NAME" >/dev/null 2>&1 || true
         docker volume rm "${NAME}-claude" "${NAME}-codex" "${NAME}-muse" >/dev/null 2>&1 \
           && echo "removed $NAME + auth volumes (next 'up' needs fresh OAuth)" \
           || echo "no auth volumes to remove" ;;
  logs)  docker logs -f "$NAME" ;;
  ssh)   ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null clodex@localhost ;;
  host)
    cat <<EOF
# Add to ~/.ssh/config, then set the peer's "ssh host" to: clodex-docker
Host clodex-docker
    HostName localhost
    Port $SSH_PORT
    User clodex
    IdentityFile ${PUBKEY%.pub}
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
EOF
    ;;
  *)     echo "usage: docker/run.sh [build|up|down|reset|logs|ssh|host]" >&2; exit 1 ;;
esac
