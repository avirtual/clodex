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

## 2. Two headless instances

Instance A:

```sh
export CLODEX_HOME=~/clodex-a
export CLODEX_DATA_DIR=~/clodex-a/data
export CLODEX_LABEL=box-a
export CLODEX_WEB_PORT=8080
export CLODEX_REMOTE_ENABLE=1
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
export CLODEX_REMOTE_TOKEN=$(openssl rand -hex 16)
node headless-main.js
```

Keep each token — step 3 below needs B's.

**The two service ports are not environment.** The peer wire's port (default
`7900`) and wirescope's (default `7800`) are per-instance *persisted settings*,
living in each instance's own `CLODEX_DATA_DIR`. Change them in that instance's
Settings — there is no env override, and two instances left on the defaults
collide on both. Give B, say, `7901` and `7801`.

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

## 4. Caveats

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
