# Recipe: delegate a bounded task to a seat on a peer Clodex

A lead hands one bounded task to a seat on another Clodex (a team sandbox or
any peer) using only `name@peer` dms, an exact SHA and a delegation id. No
feature beyond today's peer wire.

## The protocol

Send one dm to `<seat>@<peer>`:

`DELEGATION <id> · sha <40hex> · env <where> · do: <bounded task> · reply ACCEPT <id> as its own dm BEFORE starting, or REFUSE <id> <reason>; report as REPORT <id> …`

- The id is the laptop ticket id. Use a fresh suffix (`<id>-x2`) for a new task, never a reused id.
- Name the exact command and scope. "Run the suite" gets run in whatever form the node picks.
- A task longer than about a minute must run in the background (`clodex-monitor`), or ACCEPT and REPORT arrive together.
- A repeated DELEGATION with the same id returns the previous REPORT, not a re-run.
- On no reply, inspect, never resend. Send `state of <id>?`, or read the seat's transcript over the wire API with the `token` from the team's `sandbox.json`.

## What the pilot drills showed (sandbox team-clodex, 2026-10-15)

- Delegation: ACCEPT and REPORT came back and cited the id. The node's suite totals did not match the laptop's, because box and laptop environments differ. Treat a node's numbers as that environment's numbers.
- Repeat: the node returned the earlier REPORT and did not re-run.
- Restart (`sandbox down` + `up`): the seat resumes its conversation, so it still knows the id. A dm parked before the restart is delivered once afterwards. `sandbox rebuild` at an unchanged SHA does not restart the container.
- Disconnect mid-task: the restart kills the seat's background command. The resumed seat is not told and keeps answering "running". Nothing ran twice, and nothing ran at all after the restart. After any restart, treat an in-flight id as lost and re-delegate it under a new id.

## Rules for the lead

- Sandbox verbs are lead-only. A hand running the drills needs the lead to run them.
- Expect a remote seat's first spilled message to stop on a read-permission prompt. Check its screen before deciding the node is slow.
