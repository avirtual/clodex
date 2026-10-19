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

## applyPortsNow

A port change runs `up -d --no-deps <box>-ports`, never a bare `up`: Docker
cannot add a mapping to a running container, and a general `up` would also
recreate the box whenever its own definition drifted (image, ref), killing every
seat. The gateway has no `depends_on`: one would pull the box into any plain
`up <box>-ports`. An emptied list runs `rm -sf <box>-ports` before the compose
file is rewritten, because `rm` refuses a service the file no longer names.

## validatePortsForSave

All-interfaces consent is scoped to the `(container, host)` pair it was given
for: a pair change resets it for every writer, and a non-panel writer may
neither set it nor edit or remove an entry that carries it. Entries are matched
to `prior` by pair, never by index: a wide entry on a new pair is reset whenever
a prior wide pair is gone from the same save.

## generateCompose

The gateway forwards to `clodex:<container>`, the box's compose service name:
Docker's embedded DNS resolves service names and aliases, not the `hostname:`
a service sets.

## validateLimitsForSave

The upper bounds come from `docker info` figures (`probeDockerFigures`: NCPU and
the Docker VM's MemTotal) and are skipped when those are unknown; the lower
bounds always hold. The gateway service's cap (`GATEWAY_LIMITS`) is fixed and
not configurable. `platform` applies only on Rebuild, because the image must be
pulled or built for that architecture.
