# Recipe: two Clodexes on one box

One machine, two independent instances — separate registries, separate session
stores, separate names on the peer wire, and each reachable from the other as an
ordinary peer. Useful for keeping a client's work off your own tree, for running
a staging instance beside the one you depend on, or for exercising the peer wire
without a second machine.

Everything that makes an instance an instance is environment. No config file
edit, no build flag.

## 1. The instance-scoped environment

| Variable | What it scopes | Default |
|---|---|---|
| `CLODEX_HOME` | the registry root — teams, library, `run/<name>/`, memory, messages, projects, tickets, `clodex.log`. Read by `main.js`, `headless-main.js`, `sandbox.js` and the engine, and handed to every agent's `[agent:exec]` children | `~/.clodex` |
| `CLODEX_DATA_DIR` | the persistence dir — `sessions.json` and the settings stores (peers, ports, workspaces). The desktop app moves `userData` here before taking its single-instance lock | platform userData: `~/Library/Application Support/clodex` (macOS), `$XDG_CONFIG_HOME`/`~/.config/clodex` (Linux), `%APPDATA%/clodex` (Windows) |
| `CLODEX_LABEL` | the origin this instance announces to the peers it **dials** — the address their agents reach ours at, and the hello `host` field they display. Must match the outbox origin charset (`[A-Za-z0-9._-]`, 1–64, not `.`/`..`); a value that does not is ignored with a warning in `clodex.log` | the box's hostname, minus a `.local` suffix |
| `CLODEX_WEB_PORT` | the browser frontend's port (headless only) | unset — no web host is started |
| `CLODEX_WEB_HOST` | the interface the web host binds | unset — all interfaces |
| `CLODEX_WEB_TOKEN` | the web frontend's bearer token | unset — localhost trust |
| `CLODEX_WORKSPACES` | comma-separated workspace ids to restore at boot | the single default workspace |
| `CLODEX_REMOTE_ENABLE` | `1` brings the peer wire up with no settings write (the headless-container door) | unset — the wire follows the persisted `remoteEnabled` setting |
| `CLODEX_REMOTE_HOST` | the interface the peer wire binds | `127.0.0.1` |
| `CLODEX_REMOTE_TOKEN` | the peer wire's bearer token; wins over the token file | unset — the token file, else localhost trust |
| `CLODEX_REMOTE_PORT` | the port the peer wire listens on; wins over the persisted `remotePort` setting and is never written back to it | unset — the persisted setting, else `7900` |
| `CLODEX_WIRESCOPE_PORT` | the port wirescope listens on; wins over the persisted `wirescopePort` setting and is never written back. A persisted `proxyUrl` pointed at loopback follows it, so routing stays consistent | unset — the persisted setting, else `7800` |

## 2. Two headless instances

Instance A:

```sh
export CLODEX_HOME=~/clodex-a
export CLODEX_DATA_DIR=~/clodex-a/data
export CLODEX_LABEL=box-a
export CLODEX_WEB_PORT=8080
export CLODEX_REMOTE_ENABLE=1
export CLODEX_REMOTE_PORT=7900
export CLODEX_WIRESCOPE_PORT=7800
export CLODEX_REMOTE_TOKEN=$(openssl rand -hex 16)
node headless-main.js
```

Instance B, in another shell:

```sh
export CLODEX_HOME=~/clodex-b
export CLODEX_DATA_DIR=~/clodex-b/data
export CLODEX_LABEL=box-b
export CLODEX_WEB_PORT=8081
export CLODEX_REMOTE_ENABLE=1
export CLODEX_REMOTE_PORT=7901
export CLODEX_WIRESCOPE_PORT=7801
export CLODEX_REMOTE_TOKEN=$(openssl rand -hex 16)
node headless-main.js
```

Keep each token — step 3 below needs B's.

Two instances left on the default service ports collide on both, which is why B
exports `7901` and `7801` above. Each var wins over that instance's persisted
`remotePort` / `wirescopePort` and is never written back into its
`ui-settings.json`, so a launch without the var returns to whatever Settings
holds — the pair of shells above is the whole configuration, nothing to click.

`CLODEX_WEB_PORT` is what gives an instance a browser GUI, and an instance
launched without it has none. That failure does not look like a failure: the
instance still serves a page, because the peer wire brings up a second and
different frontend. `remote.js` is the phone viewer, a deliberately simplified
single page of some sixteen kilobytes, reachable on `CLODEX_REMOTE_PORT`.
`web-host.js` is the real browser GUI, serving the two-megabyte
`web-dist/index.html`, and `headless-main.js` constructs it only when
`CLODEX_WEB_PORT` is set. So a launcher that omits the variable yields an
instance that answers on a port and has no GUI at all — send an operator there
and they land on the wrong frontend.

Headless is the recommended shape for the second instance, not a workaround for
the Finder caveat below. `requestSingleInstanceLock` is called at exactly one
site, in `main.js`, so a headless instance never takes the Electron lock and
cannot contend with a running desktop Clodex for it. That lock is also why
`main.js` moves `userData` to `CLODEX_DATA_DIR` immediately above the
`requestSingleInstanceLock` call: Electron derives the lock's identity from
`userData`, so the move only separates two desktop instances if it happens
first.

## 3. How A reaches B

They are ordinary peers, over loopback:

1. In A's Settings, add a peer at `http://127.0.0.1:<B's wire port>` with B's
   `CLODEX_REMOTE_TOKEN`, and **give that peer a label**. Use the same word B
   exports as `CLODEX_LABEL` — `box-b` — so the two names agree.
2. Once the hello lands, B's agents appear in A's `[agent:who]` as
   `name@<that peer label>`, and A's agents dm them at that address:

```
[agent:dm worker@box-b]
your message
[agent:end]
```

The two directions use **different** labels, because only A has a peer row here:

- **A → B.** The suffix A's agents type is A's own peer label for B, from A's
  Settings. It is matched against A's peer list, so renaming the peer in A
  changes the address A's agents type and B is not consulted.
- **B → A.** When A dials, it presents its `CLODEX_LABEL` as the origin. B tags
  the inbound message `worker@box-a` and remembers that origin, so B's agents
  reply with `[agent:dm worker@box-a]` — **A's `CLODEX_LABEL`**, not a peer
  label, since B has no peer row for A. The reply waits in an outbox B keys by
  that same origin, which A collects on its hello cadence. Note B's
  `[agent:who]` will not list A's agents: that listing walks configured peers
  only, so on the dialed side the address arrives in the sender tag.

`CLODEX_LABEL` also sets the host name A's peers panel displays for B.

That is why two instances on one box want distinct labels. Left at the default
both present the *same* hostname origin to every peer they dial, so that peer
sees both instances' agents under one suffix and lands their replies in one
shared outbox. Distinct labels keep them apart on every box they dial.

Give the peer label A uses for B the same word B exports as `CLODEX_LABEL`, and
the address A's agents type matches the one B's agents reply to.

## 4. Moving an existing team into the second instance

Moving a live team — its session rows, its tickets, its memory — out of an
existing root and into the new one is a file copy plus four corrections. It
needs no downtime window.

1. **Every store is read-through, so a running instance will not clobber your
   edit.** `stores.js`'s `remove()` is `_save(_load().filter(...))` and its
   `list()` is `_load()`; `team-manifest.js`'s `listTeams` and `loadManifest`
   do a `readdirSync`/`readFileSync` per call. There is no cached array waiting
   to be written back over your change, so `sessions.json` can be edited under a
   live instance. The one exception is `ui-settings.json`: the renderer holds
   settings in memory and can re-save a stale copy, so settings edits still want
   a restart.
2. **Kill the agent's CLI pid; do not retire the seat.** Killing the pid is
   lossless — `exitDisposition` in `session-manager.js` returns
   `dropRecord: !agentType && !expected`, and for an agent that is always false,
   so the row and its `sessionId` survive and the seat `--resume`s into its
   conversation once the new instance starts it. Retiring is the destructive
   path: `kill()` calls `getPersistence().remove(name)` unconditionally, and the
   record you meant to move is gone.
3. **Per-name directories do not follow the session row.** `run/<name>/` is
   transient and can be left behind, but `library/memory/<name>/` and the
   notices and messages trees are keyed by agent name and have to be copied
   deliberately. After the move the two roots hold different name sets, so
   nothing reconciles them later.
4. **Rewrite `workspaceId` on the copied rows.** A row that points at a
   workspace UUID the new root does not have is invisible in the new instance.
   Set it to `default`, or copy the workspace row across as well.
5. **Strip the peer keys from any copied settings** — `peerShellEnabled`,
   `peers`, `peerAttached`, `peerVisible`, `peerControlled`. The new instance is
   not the old one's peer set, and §3 above is how it acquires its own.

## 5. Caveats

- **No trailing slash on the paths.** Give `~/clodex-a`, not `~/clodex-a/`.
  `CLODEX_HOME` is taken as the raw string, and joins normalise it away, so a
  trailing slash leaves two spellings of one root that do not compare equal.
- **A packaged `.app` launched from Finder inherits no shell environment.** The
  desktop app honours these variables, but only when it is launched from a
  shell — e.g. `CLODEX_HOME=~/clodex-b
  /Applications/Clodex.app/Contents/MacOS/Clodex`. Otherwise run the two
  instances headless.
- **Agent names are global per root, not per workspace.** Two instances with
  different `CLODEX_HOME`s therefore have fully independent namespaces: both may
  have a `worker`, and the two are different seats. Which suffix distinguishes
  them depends on the side: on a box they **dial**, an instance's agents are
  addressed by that instance's `CLODEX_LABEL`; on the **dialing** side, by the
  peer label given there. Two instances sharing a root would not be two
  instances.
- **A fresh root's library is seeded from the shipped copies, so hand-edits do
  not come along.** `seedLibraryDefaults()` in `stores.js` populates a new
  root's `library/templates/*.json` from the versions that ship with Clodex, and
  stops re-syncing a file the moment a live copy exists. Anything you edited in
  your first root is therefore silently absent from the second: the shipped
  `clodex-team-reviewer.json` carries no `--model`, so a second instance's
  reviewers boot at 200k rather than 1M unless you copy your edited template
  across by hand. Copy every hand-edited template deliberately.
- **A free port is not an unclaimed one.** `lsof` sees a port as free when
  nothing is bound to it right now, and a Clodex-supervised tunnel
  (`ssh -L 127.0.0.1:7901:...`) reserves its local port but binds it only while
  the far end is up. Check the `ssh -L` set and the peers panel as well as
  `lsof` before you assign `CLODEX_REMOTE_PORT` or `CLODEX_WIRESCOPE_PORT`.
  Taking a port a tunnel owns is silent: the second instance starts, and an
  existing ingress route reaches it instead of the instance it was meant for.

## 6. Several people on one box

The variables in §1 are not a multi-tenancy mechanism, and a box shared by
several people should not be configured with them.

- **Environment variables give one user several instances.** They are a
  blast-radius boundary: the processes run under the same uid, the roots are
  separated by nothing but ordinary file permissions, and either process can
  read the other's variables. Good for keeping a client's work off your own
  tree; not a boundary between people.
- **A Unix account each is the real boundary.** `useradd` per person is
  kernel-enforced, and `CLODEX_HOME` and `CLODEX_DATA_DIR` then default into
  each user's own home — so the multi-user shape needs no configuration at all,
  and a recipe for it is `useradd` and nothing else.
