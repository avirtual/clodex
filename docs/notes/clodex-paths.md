# clodex-paths.js

## runDirFor

The Unix socket path limit is 104 bytes on macOS (`sun_path`), and
`/Users/<user>/.clodex/run/<seat>/agent.sock` is what must fit it — measured:
with a 32-char user and a 64-char seat name that path is 127 bytes and already
overflows today. `seatPathFor(root, name, 'run')` is 9 bytes longer
(`sessions/<seat>/run` vs `run/<seat>`), which drops the practical seat-name
budget by 9 characters, so `runDirFor` stays the path the socket BINDS at and
the sessions-side dir is reached through it.

## seatDirFor

`sessions/<seat>/` is the real directory and each old spelling is the symlink,
not the other way round: three byte-pinned generated hook bodies build the
shared-root path in bash, and every transcript and memory already written
teaches agents `~/.clodex/messages/<seat>/` and `~/.clodex/run/<seat>/`.
