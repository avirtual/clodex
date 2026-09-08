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
| `CLODEX_LABEL` | what this instance calls itself on the peer wire — the hello `host` field a peer displays, and the `@origin` half of the sender tag on relayed DMs. Not the address other boxes dm it by (see step 3). Must match the outbox origin charset (`[A-Za-z0-9._-]`, 1–64, not `.`/`..`); a value that does not is ignored with a warning in `clodex.log` | the box's hostname, minus a `.local` suffix |
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

The suffix there is **A's own peer label for B**, set in A's Settings — not
B's `CLODEX_LABEL`. A dm target is matched against A's peer list, so renaming
the peer in A renames the address A's agents type, and B never learns of it.

What `CLODEX_LABEL` changes is what B calls *itself*: the host name A's peers
panel shows for B, and the `@origin` half of the sender tag on DMs relayed
through a hub. That is why two instances on one box want it — left at the
default they both self-label as the hostname, and a hub's spokes cannot tell
which of the two a relayed message came from. Keeping the peer label and
`CLODEX_LABEL` the same word means the address you type and the name on the
screen agree.

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
  have a `worker`, and the two are different seats — reached from the other
  instance by the peer label it was given there. Two instances sharing a root
  would not be two instances.
