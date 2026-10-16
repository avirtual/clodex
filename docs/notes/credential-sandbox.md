# credential-sandbox

Notes for `credential-sandbox.js`: facts the code cannot state. Provable ones are tests instead.

## dataWriteDeny

Measured on CLI 2.1.301, macOS: a `denyWrite` entry wins over a narrower `allowWrite` inside it, so the data dir is
listed child by child minus `projects` rather than denied whole with `projects` re-allowed.

## realSocketPath

Measured on CLI 2.1.301, macOS: `allowUnixSockets` matches the socket's real path only; `/tmp/...` was refused with
EPERM where `/private/tmp/...` connected.

## buildCredentialSandbox

`allowWrite: ['/']` is there because the sandbox's default confines writes to the cwd and temp dir, which would
break worktree commits (they write the main checkout's `.git`).
