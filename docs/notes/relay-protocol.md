# relay-protocol.js

## computeRosterFor

The hub's OWN sessions are a roster source alongside its peers', and they ride
the consent the operator already gave: the symmetric gate runs first and returns
an empty roster unless the target spoke is itself `relayAllowed`. A spoke marked
`relayAllowed` is already receiving agent names from the hub's mesh and already
able to dm them through the hub, so publishing the hub's own names to that same
spoke adds no exposure axis. An unmarked spoke gets nothing, exactly as before.
There is deliberately no second flag and no per-session opt-out.

Two of the five gates do not reach the local rows, and neither is an oversight.
Split-horizon cannot suppress them: it drops the target's own agents from what
is pushed back to the target, and the hub is never the target of its own push.
The both-endpoints gate genuinely does not apply — it exists so a third party Y
is advertised only when the operator marked Y too, and the hub is not a third
party but the operator's own instance doing the pushing; applying it would
require the hub to appear in its own allow-list, which nothing sets.

The type filter is the one gate whose failure would be a privacy leak rather
than a routing bug. Bash sessions are private by design — no registry, no
socket, invisible to `[agent:who]`, not DM-able — so a bash session reaching a
spoke's roster would publish a session the operator believes is private. The
liveness gate has no local analogue because local sessions are live by
construction, but `selfLabel` must still pass `RELAY_NAME_RE` or the rows carry
an unroutable origin and are omitted entirely.

`localSessions` and `selfLabel` are parameters, not lookups: the function is
pure and its caller (`peer-wiring.js`) owns the manager read. That read is
`manager.list()`, the unscoped in-process listing the tray uses. The rule it
looks like it might trip — no IPC channel exposes a cross-workspace listing —
is about the IPC registration surface, where web-host dispatches any channel by
name for a connection bound to ONE workspace. The peer wire is bound to no
workspace, and a hub whose roster were workspace-scoped would advertise a
different set of its own agents depending on which window happened to be
focused. Cross-workspace is the correct scope here.
