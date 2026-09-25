# stream-codec-muse.js

## onNotification

`approval/requested` arrives as a notification with no JSON-RPC id, BEFORE any `toolCall` item for the call (unlike codex, where the request follows `item/started`); nothing on the server waits on a receipt, the `approval/decide` command is what resolves it (proxy-lab muse-serve D, Muse Code 1.3.0). Under `denyUnmatched` the server resolves it itself 1 ms later, so our abort races into -32051 (case C3). Under `promptUnmatched` the `write_file` tool was not gated: only shell stages raised approvals (case D).

A `session/resume` after the host process was killed mid-turn emits `turn/completed terminal:cancelled reason:resume_reconcile:orphaned_by_process_loss` BEFORE the resume ack (case G2).

## create

`session/compact` is never bracketed by `turn/started`/`turn/completed` (case B2): the `compaction` item is the only end signal. The captured item carries `trigger: "manual"`. The session object names its id `sessionId` and items their type `kind`.

`muse serve` refuses every top-level flag: `--provider` and `--base-url` before `serve` make muse parse the TUI options, after it they are `unknown option` (Muse Code 1.3.0), so a stream seat cannot be routed through wirescope by argv.
