# auth-token.js

## isLoopbackHost

A bind host counts as loopback when nothing off-box can reach it, the case where
"trust is the tunnel" holds and no token is required. `0.0.0.0` / `::` and any
specific LAN address are not loopback, so both HTTP hosts (remote.js and
web-host.js) fail closed on them when no token is configured.
