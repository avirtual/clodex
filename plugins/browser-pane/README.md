# Browser Pane

Gives agents a real, logged-in browser window per **service** (a short name such
as `utility` or `irs`). An agent opens a site with `[agent:browser open utility]
https://portal.example.com/bills`, then reads it with `[agent:browser read]`: the
page text plus a numbered list of links and controls, about 2,500 tokens per
page, delivered as a file the agent reads. You watch the window, and you sign in
yourself; the agent never types a password.

This release covers `open`, `read`, `services` and `release`. Clicking, typing,
downloads and the take-over controls come in later releases.

## Turning it on

1. Enable **Browser Pane** in Plugins. It is off by default.
2. On each seat that should use it, tick the plugin in the seat's plugin list
   **and** tick the `browser` verb in the seat's intent checklist. The verb is
   privileged (plugin-api §7): until it is ticked, `[agent:browser …]` lines from
   that seat are silently inert.

The desktop app is required. A headless Clodex answers every command with
`browser unavailable — this Clodex host has no Electron (headless)`.

## What the agent can do

```
[agent:browser open <service>] <url>
[agent:browser read [service] [--text|--links] [--main] [--filter=<s>] [--page=N] [--max=<tokens>]]
[agent:browser services]
[agent:browser release [service]]
```

Omitting `[service]` means the last service that seat opened or read. Only
`http:` and `https:` URLs open, and a URL carrying `user:pass@` is refused.

Each `read` writes `$TMPDIR/clodex-browser-pane/<seat>/r-<n>.txt` (directory
0700, files 0600; the 50 newest per seat are kept, and nothing older than a day)
and replies with one line pointing at it.

## Where data lives

```
<userData>/plugins/browser-pane/
  state.json            the services registry: last URL (origin + path), title, sign-in state
  chromium/             the browser's own profile, separate from Clodex's
    Partitions/<service>/   cookies, storage and cache for one service
$TMPDIR/clodex-browser-pane/<seat>/   read files, ephemeral
```

Logins persist across restarts: session cookies are re-saved with a 30-day
expiry. A server-side session timeout still wins, and the next read then shows
a sign-in page.

The browser runs as a separate process, started on the first command and
stopped after 15 minutes without one. If it crashes three times within five
minutes, the plugin refuses for ten minutes and says so in the reply.

On macOS a one-time Keychain prompt for "Clodex Safe Storage" can appear after
an ad-hoc re-sign; it guards the browser's cookie encryption.
