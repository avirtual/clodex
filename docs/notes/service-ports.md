# service-ports.js

## resolveServicePort

The env var wins over the persisted setting because a second instance on one box
starts from a default COPY of the first's `ui-settings.json`: if the file won,
the launcher's export would be dead on arrival. Mirrors `resolveRemoteToken`
(`remote-token.js`) — env, then file, then fallback.

The env value must never be written back into `ui-settings.json`. A launcher
that exports a port would otherwise permanently mutate stored config, and the
next launch without the var would silently keep it. That is why `uiSettings.set`
in `stores.js` persists `next` and applies the override only to what it returns.

An env value is a string, so it goes through the same 1–65535 coercion the
persisted value does. An unparseable or out-of-range value falls back to the
persisted setting and warns once per distinct value — never bind port 0 or NaN.

## resolveProxyUrl

`wirescopePort` and `proxyUrl` must agree or `WirescopeSupervisor.autoStartWanted`
refuses to start (`wirescope-supervisor.js`), so moving the port by env has to
move a loopback `proxyUrl` with it. A `proxyUrl` pointed at a non-loopback host
is the operator routing somewhere else deliberately, and is left alone.
