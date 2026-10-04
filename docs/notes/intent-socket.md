# intent-socket notes

## createIntentRequestHandler

Until ticket B's PreToolUse hook stamps `agentId`, the subagent filter trusts the caller's claim. A main agent that claims to be a subagent only loses rights; a subagent that omits the id gets the seat's catalog.

An `agentId` equal to the seat's `sessionId` is the main agent: Codex sets `CODEX_THREAD_ID` on the main thread's shell too.

## createIntentSocketServer

The socket is chmod 0600 right after `listen`; the credential, not the mode, is the gate during that window.
