# Clodex in a browser — the containerized web frontend

Run Clodex as a Docker container and drive its GUI from a browser, instead of
the macOS desktop app. Same engine, same multi-agent workflow; the frontend is
a web client served over WebSocket by the headless host inside the container.

> This is the **web frontend** image. It is unrelated to [`../Dockerfile`](../Dockerfile),
> which is the peering arc's SSH/systemd peer test-box. They only share a parent
> directory.

## Quickstart

```sh
npm run docker:build   # build the image
npm run docker:up      # start (detached)
```

(These wrap `docker compose -f docker/web/compose.yaml …`; `docker:down` and
`docker:logs` exist too. Or run compose directly with `up --build`.)

Then open **http://localhost:7810**. You get the full Clodex UI: create
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
  - "127.0.0.1:7810:8080"
```

So only your own machine can reach it, and no token is required — that's the
localhost-trust stance. (The host side is 7810; the container side is always
8080, the port the engine listens on internally. To move it, change only the
left-hand side.)

To reach it from anywhere else — another machine on your LAN, a tunnel — you
must set a token first:

```sh
CLODEX_WEB_TOKEN=$(openssl rand -hex 32) \
  docker compose -f docker/web/compose.yaml up --build
```

and widen the publish (e.g. `"0.0.0.0:7810:8080"`). The browser then loads
`http://<host>:7810/?token=<secret>`; the token gates every route and the
WebSocket upgrade. **Never widen the publish without a token.**

This is auth v1 — a shared secret, no TLS, no per-user login. For anything
serious, front it with a reverse proxy that terminates TLS and adds real
authentication (that layered arc is future work; the token predicate is the
single seam it will replace). Treat the token like a password: anyone who has
it has full control of the agents.

## Where your work lives (read this before `down`)

The container filesystem is a throwaway: `stop`/`restart` keep it, but
`down` (and any rebuild) destroys it. Everything that matters is therefore
on volumes, which survive `down`, rebuilds, and image upgrades:

| Volume | Mount | Holds |
|---|---|---|
| `clodex-data` | `/data` | `sessions.json`, stores, saved exports |
| `clodex-dot` | `/home/clodex/.clodex` | agent registry, inter-agent messages, log |
| `claude-auth` | `/home/clodex/.claude` | Claude login (see below) |
| `clodex-work` | `/home/clodex/work` | the agents' workspace |

Only `down -v` deletes the volumes — that is the "wipe everything" switch
(sessions, login, and the work volume included).

**Recommended: bind-mount a real host folder as the workspace.** The
`clodex-work` named volume is just the safety net so nothing is lost by
default; a named volume is awkward to reach from the host. Point the
workspace at a host directory instead, in `compose.yaml`:

```yaml
      - ~/clodex-work:/home/clodex/work
```

Now everything agents create or clone lands on your disk — editable,
backed up, and still there when the container is long gone. Put existing
checkouts in that folder to hand them to the agents; it is the only host
path they can touch.

If you switch from the named volume to a bind later, copy anything you
want to keep out of the volume first (`docker compose -f
docker/web/compose.yaml cp clodex:/home/clodex/work ./rescued-work`,
while it's up).

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

## Wire telemetry

The image bundles the wirescope snapshot the desktop app ships, and the
engine autostarts it inside the container (default settings point at the
managed local port). First boot builds its Python venv under `/data` —
give it ~30s and a network connection once; the data volume persists it.
Proxy charts and per-session wire telemetry then work exactly as on the
desktop. To turn it off, disable the proxy in Preferences.

The **full dashboard** links (the "Open full dashboard →" jump-outs in the
cost/bust popovers) open wirescope's own web UI, which runs on the container's
port 7800 — a *different* service from the browser frontend, not gated by
`CLODEX_WEB_TOKEN`. The compose file publishes it loopback-only on host **7811**
(`127.0.0.1:7811:7800`, same localhost-trust stance as 7810) and points the web
client at it via `CLODEX_WIRESCOPE_PUBLIC_URL` (default `http://localhost:7811`),
so those links resolve from your browser instead of the container's unreachable
loopback address. If you remap 7811, change `CLODEX_WIRESCOPE_PUBLIC_URL` to
match.

That variable answers the case where your browser is on the container's own
host, and **for the direct-URL peering described below it remains the only
answer** — so keep it set. It cannot answer the other case: a `localhost:7811`
served to a viewer on a DIFFERENT machine points at that viewer's own machine.

There is now a second mechanism, but it does not apply to this deployment.
A desktop Clodex opening a box's frontend through its peer web view (↗)
forwards that box's wirescope alongside and passes the local port on the page
URL as `?wirescope=<port>`, which takes precedence over
`CLODEX_WIRESCOPE_PUBLIC_URL`. It requires a peer Clodex DIALS itself — ssh,
SSM, kubectl, GCP IAP or Azure Bastion — because there has to be a transport to
raise the forward over. A direct-URL peer, which is exactly what the section
below sets up, is reached over a network path Clodex does not own, so the web
view refuses it and neither ↗ nor `?wirescope=` ever engages here. Relevant if
you peer this container over ssh instead; see `docs/peering.md` §2a.

## Peering the container with your desktop

You can add this container to your desktop Clodex as a **peer** — see and drive
its sessions from the desktop's peer tabs, exchange agent DMs. The container
publishes the peer wire loopback-only on host **7820** (`127.0.0.1:7820:7900`,
same trust stance as the rest) and brings it up automatically at first boot
(`CLODEX_REMOTE_ENABLE=1` in the image — no in-app toggle to reach).

In the desktop app: **Window ▸ Manage Peered Clodexes…**, add a peer with the
destination `http://127.0.0.1:7820` as a **direct-URL** peer. No SSH — the
loopback publish is the boundary, exactly like the browser port. Once it's up
the container's sessions appear under that peer.

The compose file pins `hostname: sandbox` — that name is the peer's label on
your desktop and the origin suffix on agent DMs (`agent@sandbox`). It must be
stable: without the pin Docker assigns the random container id, which changes
on every recreate and breaks DM reply routing. Rename it to taste, but keep it
fixed once peers know it.

(This is the reverse of the browser frontend: the browser is a *frontend for the
container's engine*; peering makes the container a *peer of your desktop's
engine*. Both can be used at once.)

## Operating notes

- **Logs**: `docker compose -f docker/web/compose.yaml logs -f`.
- **Health**: the container reports healthy once `/healthz` answers 200
  (unauthenticated liveness only).
- **Restart contract**: the service restarts automatically on a clean exit and
  on an in-app restart request (a deliberate exit code the supervisor relaunches).
- **Stop / wipe**: `down` keeps the volumes; add `-v` to delete them (this drops
  sessions, the agent login, AND the `clodex-work` volume — bind-mounted host
  folders are never touched).
- **New workspaces don't auto-restore**: the container restores only the
  workspaces listed in `CLODEX_WORKSPACES` (default `default`) at (re)launch. A
  workspace you create in the browser (Window ▸ New Workspace) works for the
  running session but is NOT added to that list, so its sessions won't come back
  after a `restart`/relaunch unless you add its id to `CLODEX_WORKSPACES` in
  `compose.yaml`. Its conversation transcripts on disk are preserved regardless.
