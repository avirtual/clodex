# Browser Pane

Gives agents a real, logged-in browser window per **service** (a short name such
as `utility` or `irs`). An agent opens a site with `[agent:browser open utility]
https://portal.example.com/bills`, then reads it with `[agent:browser read]`: the
page text plus a numbered list of links and controls, about 2,500 tokens per
page, delivered as a file the agent reads. You watch the window, and you sign in
yourself; the agent never types a password.

This release covers `open`, `read`, `click`, `type`, `key`, `select`,
`download`, `screenshot`, `wait`, `services` and `release`, and the take-over
controls.

While an agent acts, the bar at the top of the window turns amber, names the
agent and ignores your clicks and keys until the action finishes. An agent waits
for you to pause typing or clicking for 3 s before it acts. **Take over** gives
you the window (it lands when the current action finishes); **Hand back to
agent** returns it. On a sign-in page the window is handed to you with one
notification; agents are refused password and one-time-code fields.

## Turning it on

1. Enable **Browser Pane** in Plugins. It is off by default.
2. On each seat that should use it, tick the plugin in the seat's plugin list
   **and** tick the `browser` verb in the seat's intent checklist. The verb is
   privileged (plugin-api §7): until it is ticked, `[agent:browser …]` lines from
   that seat are silently inert.

The desktop app is required. A headless Clodex answers every command with
`browser unavailable — this Clodex host has no Electron (headless)`.

## The workflow: sign in once, then hand back

1. Grant the verb on the seat (above). Ask the agent for the files, e.g. "download
   my last 30 monthly statements from the utility portal into `bills/`".
2. The agent opens the portal. When it lands on a sign-in page, the window is
   handed to you: you get one notification ("Browser: sign in to utility"), and
   the status bar shows **browser: needs you**. Click it, or find the
   "utility — Clodex Browser" window.
3. Sign in yourself in that window, including any one-time code. The agent never
   sees what you type and is refused password and code fields.
4. Press **Hand back to agent**. The agent's `wait` resolves and it carries on:
   it picks each month, clicks through, and downloads each PDF.

Files land in the pane's downloads folder,
`<userData>/plugins/browser-pane/downloads/<service>/` (**Reveal downloads** in
Manage Plugins opens it), or in a folder inside the agent's working directory
when it passes `--to=<folder>`. Each download reply says whether the file really
is a PDF; a web page saved instead (an expired session) is flagged.

The login persists: the next run, even after a restart, starts signed in until
the portal's own session timeout. **Forget login** in Manage Plugins deletes a
service's cookies.

## Limits

- **Google sign-in does not work.** Google refuses sign-in inside embedded
  browsers ("This browser or app may not be secure"). The agent is told to stop
  and say so; use the portal's own email/password login if it has one, or
  download by hand.
- **iframes are not read.** The read file's header names the frames it skipped;
  the agent may open a frame's URL in the same service.
- **Closed shadow roots are not read** (open ones are).
- **Infinite scroll** is only partly covered, by `key PageDown` / `key End`.
- **Keychain prompt**: on macOS a one-time prompt for "Clodex Safe Storage" can
  appear after an ad-hoc re-sign; it guards the browser's cookie encryption.
- **Two "Clodex" Dock icons** while a browser window is open: the browser is the
  same app bundle. Its icon is hidden whenever no browser window is open.
- **The verb is privileged**: until `browser` is ticked in a seat's intent
  checklist, that seat's `[agent:browser …]` lines are silently inert, with no
  error reply.

## What the agent can do

```
[agent:browser open <service>] <url>
[agent:browser read [service] [--text|--links] [--main] [--filter=<s>] [--page=N] [--max=<tokens>]]
[agent:browser click [service] <n>]
[agent:browser type [service] <n> [--enter]] <text>
[agent:browser key [service]] <Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Space>
[agent:browser select [service] <n>] <option text or value>
[agent:browser download [service] [<n>] [--to=<dir>] [--as=<name>]] [<url>]
[agent:browser screenshot [service]]
[agent:browser wait [service] [--ms=N] [--for=<text>]]
[agent:browser services]
[agent:browser release [service]]
```

`<n>` comes from the seat's latest `read` of that page. One seat holds a service
at a time; it frees after 5 min without commands, on `release`, or when the
seat's session ends.

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
