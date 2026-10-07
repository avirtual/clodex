# web-host.js

## createWebHost

An unset `host` is Node's all-interfaces bind, which the docker port map
(`127.0.0.1:HOST_PORT→container:8080`) depends on; a loopback container bind
breaks it. Deploys pass `CLODEX_WEB_HOST=127.0.0.1` explicitly instead. An
all-interfaces bind counts as non-loopback, so with no `CLODEX_WEB_TOKEN` the
host answers 503 unless `insecure` (`CLODEX_WEB_INSECURE=1`) is set — the
compose file sets it because its loopback-only port map is the boundary.

The token compare goes through `makeTokenGate` and is constant-time; do not
replace it with `===`.
