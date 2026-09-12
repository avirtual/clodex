# sandbox

## LIBRARY_MOUNT_DIRS

Bound per catalogue directory under `library/`, never over `library/` itself:
`library/memory`, `library/memory-loadlog` and `library/common-memory`
(engine.js `MEMORY_DIR` and its siblings) are per-agent WRITE dirs, and a
read-only shadow over their parent made `[agent:memory remember]` fail ENOENT
inside a box. The `library/*` entries are emitted only when the host has them
(docker errors on a bind whose source is missing) and are therefore not
pre-created by `writeComposeFile`; `skills` and `agents` stay unconditional.

## RUN_TMPFS_OPTIONS

Docker mounts every tmpfs `noexec,nosuid,nodev` by default, and compose's long
volume syntax (`type: tmpfs` with a `tmpfs:` sub-key) exposes only `size` and
`mode` — there is no way to add `exec` in that form. The service-level short key
used here maps to `HostConfig.Tmpfs`, whose data string reaches the kernel, so a
trailing `exec` overrides the default. This matters because `cli-hooks.js` writes
`hook.sh`, `statusline.sh`, `attn.sh` and the drain scripts into `run/<name>/`
0700 and registers them as bare-path commands, which Claude Code execve's: on a
noexec mount they fail EACCES and the seat comes up nameless and deaf.

`mode=1777` in that data string is parsed by the kernel, which always reads
`mode=` as octal. The long syntax's `mode: 1777` is YAML, where a plain integer
is decimal — 1777 decimal is 0o3361, which would leave the container's non-root
`clodex` user unable to mkdir under the dir.
