# docker/web/Dockerfile — the browser-frontend Clodex image (web-frontend Phase 4).
#
# This is the packaged form of the HEADLESS host (headless-main.js, plain Node)
# plus the web frontend (web-host.js + the esbuild bundle): `node headless-main.js`
# with CLODEX_WEB_PORT set stands up the same engine the Electron app runs and
# serves the browser client over WebSocket. The Electron desktop app is unrelated
# and unchanged — it never runs in here.
#
# NOTE: this is a DIFFERENT image from ../Dockerfile (the peering arc's
# SSH/systemd peer test-box). They share a directory, nothing else.
#
# Build context is the repo root (see docker/web/compose.yaml: context ../..),
# filtered by the repo-root .dockerignore.
#
#   docker compose -f docker/web/compose.yaml up --build

# ── Stage 1: builder — install the full deps and produce web-dist/index.html.
# --ignore-scripts skips node-pty's gyp build (not needed here), esbuild's
# platform binary arrives via optionalDependencies, and — critically — skips the
# electron devDep's binary download AND our postinstall (dev-rename-electron.js /
# fix-pty-helper.js are Electron-dev-only and have no business in the image).
FROM node:22-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:web

# ── Stage 2: runtime — the headless host + the built bundle.
# node:22 (not 20) so node:sqlite exists — the wire shadow differ needs it;
# on 20 the engine logs "wire shadow unavailable" and spawns unshadowed.
FROM node:22-slim AS runtime

# git/bash/procps/ca-certificates for the engine + agents; python3/make/g++ are
# node-pty's build toolchain, kept in the final image DELIBERATELY: agents in the
# container will want to build things. python3-venv is for the wirescope
# supervisor: it builds its venv (`python3 -m venv` + pip) at first boot, and
# Debian ships venv/ensurepip as a separate package. The second line is the
# agent/bash-session toolbox — the everyday basics (fetch, JSON, edit, search)
# so a box session is usable out of the gate; anything beyond these is a
# `sudo apt-get install` away.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git bash procps ca-certificates python3 python3-venv make g++ sudo \
      curl jq vim less tree unzip zip ripgrep openssh-client \
 && rm -rf /var/lib/apt/lists/*

# The agent CLIs, globally. Pin nothing — agents self-update.
RUN npm i -g @anthropic-ai/claude-code @openai/codex

# Non-root user with a real home: agent-transport creates ~/.clodex 0700 and
# fixPathFromLoginShell runs `$SHELL -ilc`, so HOME + SHELL must be real.
# Passwordless sudo: agents in the box install their own tooling (apt-get vim,
# etc.). Root-inside-the-container is fine — the container is the isolation
# boundary, and the interesting state (volumes, host mounts) is reachable as
# the clodex user already; the host library mounts stay ro either way.
RUN useradd --create-home --shell /bin/bash clodex \
 && printf 'clodex ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/clodex \
 && chmod 0440 /etc/sudoers.d/clodex

WORKDIR /app

# Prod deps only, then rebuild node-pty against the Node ABI (the headless smoke
# recipe — the dev checkout's node-pty is built for Electron's ABI, useless here).
# Manifests first so a source-only change doesn't bust this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild node-pty

# App source (filtered by .dockerignore) + the built browser bundle from stage 1.
COPY . .
COPY --from=builder /build/web-dist ./web-dist

# Mount points owned by clodex so the named volumes come up writable by the user
# (Docker seeds an empty named volume from the image path's ownership).
# ~/.claude.json ships onboarding-complete: interactive claude IGNORES
# CLAUDE_CODE_OAUTH_TOKEN during first-run onboarding (theme picker, then a
# "Select login method" screen — verified live, v2.1.209) even though the same
# token authenticates fine in -p mode and in the post-onboarding REPL. Seeding
# the flag skips onboarding so a seeded token (M4 auth.env) just works; without
# a token, /login inside the REPL remains the documented fallback.
# It also ships the whole filesystem pre-trusted: claude's per-project trust
# check walks PARENT directories (projects["/"] covers every cwd — verified
# live, v2.1.210), and inside the box the container IS the trust boundary, so
# the "trust this folder?" dialog is pure friction on every new session. The
# file sits OUTSIDE the volumes on purpose — it's derived state, and baking it
# means every recreate starts onboarded + trusted.
RUN mkdir -p /data /home/clodex/.clodex /home/clodex/.claude /home/clodex/work \
 && printf '{"hasCompletedOnboarding": true, "projects": {"/": {"hasTrustDialogAccepted": true}}}' > /home/clodex/.claude.json \
 && chown -R clodex:clodex /app /data /home/clodex

ENV HOME=/home/clodex \
    SHELL=/bin/bash \
    CLODEX_DATA_DIR=/data \
    CLODEX_WEB_PORT=8080 \
    # Widen the wirescope + peer-wire binds to 0.0.0.0 INSIDE the container so
    # they can be published on loopback-mapped host ports (compose: 7811→7800
    # wirescope dashboard, 7820→7900 peer wire). The desktop app never sets these
    # and stays 127.0.0.1-bound. CLODEX_REMOTE_ENABLE brings the peer wire up at
    # first boot with no GUI toggle to reach in the container.
    CLODEX_WIRESCOPE_HOST=0.0.0.0 \
    CLODEX_REMOTE_HOST=0.0.0.0 \
    CLODEX_REMOTE_ENABLE=1

USER clodex
EXPOSE 8080

# No ENTRYPOINT wrapper: compose `init: true` supplies PID-1 reaping (PTYs fork
# real process trees; without a reaper, zombies accumulate).
CMD ["node", "headless-main.js"]
