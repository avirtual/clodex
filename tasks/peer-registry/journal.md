# t32 — the record/registry axis (INVESTIGATE + PROPOSE, do not build)

Branch `t32-peer-registry`, off master `8ae1343`. **Do not commit on master**
(I did once this session; the commit was moved to `t30b-postmerge-notes`).
Do not push.

## The dispatch, as narrowed

From clodex (msg-93431-32 amendment, msg-93431-36 dispatch, msg-93431-38
carry-in):

- **SETTLED, not open**: Clodex *reuses* `cli/src/transport.js`; it does not
  grow its own SSM/kubectl/gcloud/az dialing. `openTransport`'s `localPort` IS
  the pinned port, `waitExit()` is the respawn trigger, supervision stays
  Clodex-side.
- **SETTLED**: `cli/` ships in the DMG (`"cli/**/*"` in `build.files`, README
  position updated, verified with `asar list` on a real artifact — the config
  is not the check).
- **SETTLED**: prefer importing the module over shelling out to a binary.
- **OPEN — the whole ticket**: the record/registry axis, (a)/(b)/(c) as filed,
  with `contexts.js:28-31` (the token file's chmod check) load-bearing.
  Reused dialing is inert if a peer record cannot persist `{ssm:{target,region}}`
  to dial with.
- **Disqualifier, explicit**: any shape that widens who can read a token.

## Blocking-ish gap: the filed (a)/(b)/(c) text is not in the repo

`tasks/peer-web-view/journal.md:702` references "(a)/(b)/(c) as filed" but the
t32 ticket itself was filed by clodex and is not on disk anywhere I can find
(`tasks/`, `.claude/memory.md`, the archives). Asked clodex to paste it rather
than invent three options and propose against labels that don't match his.
Continuing the code investigation meanwhile — the facts don't depend on the
labels.

## Facts established so far (reading only)

### The two registries, and what each can express

| | Clodex peers | clodexctl contexts |
|---|---|---|
| file | `ui-settings.json` (`peers[]`) in `app.getPath('userData')` | `~/.clodex/cli/contexts.json` |
| owner | GUI | CLI, "deliberately separate from the GUI's peers array" (contexts.js:2) |
| transports | `url` \| `sshHost` **only** (stores.js:234-237) | `url`\|`ssh`\|`tunnel`\|`ssm`\|`kubectl`\|`gcloud`\|`az` (contexts.js:55) |
| shape | flat scalars | cloud kinds are **typed objects**, validated per-kind (contexts.js:76-102) |
| token | `peers[].token`, presence-encoded, cap 256 (stores.js:265+) | `entry.token`, same file as the transport |
| mode | 0600 via `atomicWriteFileSync`'s `openSync(tmp,'w',0o600)` (fs-util.js:28) | 0600 on write **and chmod-checked + warned on read** (contexts.js:28-31) |

Both files already hold tokens at 0600. The asymmetry is on **read**: the CLI
warns when its token file is group/world-readable; `ui-settings.json` has no
such check. (`env-scopes` at stores.js:1646-1647 *does* chmod after rename,
so the codebase already has the stronger pattern in one place.)

### Why the Clodex side cannot express a cloud transport (finding (C), re-verified)

Three places, all by construction rather than validation-with-holes:

- `sanitizePeers` (stores.js:227) rebuilds each entry key by key; `url` must
  match `^https?://`, `sshHost` must match `^[a-zA-Z0-9._@-]{1,128}$`, and
  **`if (!url && !sshHost) continue;`** drops anything else entirely.
- `classifyPeerDest` (peer-deploy.js:253) returns exactly
  `ssh`/`url`/`empty`/`error` — a single text field, deliberately, because
  "a dropdown would tax the common ssh path".
- `resolvePeerUrls` (peer-wiring.js:164) branches `sshHost` → tunnel URL,
  else `p.url`.

## Next (phase 2)

- Read the peers dialog + `resolvePeerUrls` + `peer-tunnel`'s ctx consumption
  to size each candidate shape.
- Read `transport.js`'s `openTransport(ctx)` entry contract to see exactly what
  a record must hand it.
- Then propose against clodex's (a)/(b)/(c).
