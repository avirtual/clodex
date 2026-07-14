# Clodex in a browser — the containerized web frontend

Run Clodex as a Docker container and drive its GUI from a browser, instead of
the macOS desktop app. Same engine, same multi-agent workflow; the frontend is
a web client served over WebSocket by the headless host inside the container.

> This is the **web frontend** image. It is unrelated to [`../Dockerfile`](../Dockerfile),
> which is the peering arc's SSH/systemd peer test-box. They only share a parent
> directory.

## Quickstart

```sh
docker compose -f docker/web/compose.yaml up --build
```

Then open **http://localhost:8080**. You get the full Clodex UI: create
sessions, run Claude/Codex agents, watch their terminals, message between them.

First run has one manual step — log the agent CLIs in (see
[Agent login](#agent-login-the-macos-oauth-gotcha) below).

## Why a container

The point is blast radius. An agent you let run tools can read, write, and
execute — so what it can reach matters. In the container, an agent's world is:

- the container's own filesystem, and
- exactly the host paths you mount in (nothing else).

Everything the agent does happens on a throwaway Linux box you can stop and
delete. Your host — its home directory, its keychain, its other projects — is
not in reach unless you explicitly mount it. Give agents the checkouts they
need under `/home/clodex/work` and nothing more.

One consequence: the agents' world becomes **Linux**. Mac-native workloads stay
on the host — including this repo's own DMG build, which needs macOS codesigning
and can't run in here. Use the container for the agent work; use the host for
the things only the host can do.

## Auth (v1)

The security boundary is **the publish address**. The compose file binds the
port to loopback only:

```yaml
ports:
  - "127.0.0.1:8080:8080"
```

So only your own machine can reach it, and no token is required — that's the
localhost-trust stance.

To reach it from anywhere else — another machine on your LAN, a tunnel — you
must set a token first:

```sh
CLODEX_WEB_TOKEN=$(openssl rand -hex 32) \
  docker compose -f docker/web/compose.yaml up --build
```

and widen the publish (e.g. `"0.0.0.0:8080:8080"`). The browser then loads
`http://<host>:8080/?token=<secret>`; the token gates every route and the
WebSocket upgrade. **Never widen the publish without a token.**

This is auth v1 — a shared secret, no TLS, no per-user login. For anything
serious, front it with a reverse proxy that terminates TLS and adds real
authentication (that layered arc is future work; the token predicate is the
single seam it will replace). Treat the token like a password: anyone who has
it has full control of the agents.

## Volumes

Three named volumes persist state across `up`/`down`/rebuild:

| Volume | Mount | Holds |
|---|---|---|
| `clodex-data` | `/data` | `sessions.json`, stores, saved exports |
| `clodex-dot` | `/home/clodex/.clodex` | agent registry, inter-agent messages, log |
| `claude-auth` | `/home/clodex/.claude` | Claude login (see below) |

To let agents work on a real checkout, mount it under the home directory by
uncommenting the example bind in `compose.yaml`:

```yaml
    # - ./work:/home/clodex/work
```

Point the left side at a host directory; whatever you put there is the agents'
workspace and the only host path they can touch.

## Agent login (the macOS OAuth gotcha)

**Mounting your Mac's `~/.claude` does NOT log the container in.** On macOS the
Claude OAuth credential lives in the **Keychain**, not in `~/.claude` — so the
directory you'd mount doesn't carry the login. Log in *inside* the container
once:

```sh
docker compose -f docker/web/compose.yaml exec clodex claude
```

Follow the OAuth flow (or use `claude setup-token` for a token-based login).
Because `/home/clodex/.claude` is the `claude-auth` named volume, the login
persists across restarts and rebuilds — you do this once. Codex logs in the
same way (`codex login`).

While you're in there, set the container's git identity so agent commits are
attributed:

```sh
docker compose -f docker/web/compose.yaml exec clodex \
  bash -lc 'git config --global user.name "You" && git config --global user.email "you@example.com"'
```

## Operating notes

- **Logs**: `docker compose -f docker/web/compose.yaml logs -f`.
- **Health**: the container reports healthy once `/healthz` answers 200
  (unauthenticated liveness only).
- **Restart contract**: the service restarts automatically on a clean exit and
  on an in-app restart request (a deliberate exit code the supervisor relaunches).
- **Stop / wipe**: `down` keeps the volumes; add `-v` to delete them (this drops
  sessions AND the agent login, forcing a fresh OAuth).
