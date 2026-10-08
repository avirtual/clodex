# session-manager subq notes

## _queueSubagentNote

The dm route to a live subagent writes its queue directly and never calls `_gatedDeliver` or `_armDmConfirm`: the queue is the park, and a gated park or confirm would land in the seat's main conversation, not the subagent's.

`_subDmSent` is swept by each key's newest timestamp on every subagent dm, not on size: any credential holder mints agentIds freely, so a size bound alone is attacker-chosen.

A parked or held notice to a subagent drops its retry clause: the socket refuses `resend` to a subagent and the dm arm refuses `urgent`, so the advice could not be followed.
