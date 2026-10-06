# Browser Pane

Gives agents a real, logged-in browser window per **service** (a short name such
as `utility` or `irs`). An agent opens a site with `[agent:browser open utility]
https://portal.example.com/bills`, then reads it with `[agent:browser read]`: the
page text plus a numbered list of links and controls, about 2,500 tokens per
page, delivered as a file the agent reads. You watch the window, and you sign in
yourself; the agent never types a password.

This release covers `open`, `read`, `click`, `type`, `key`, `scroll`, `back`,
`forward`, `select`, `download`, `screenshot`, `inspect`, `wait`, `services` and `release`, and the take-over
controls.

While an agent acts, the bar at the top of the window turns amber, names the
agent and ignores your clicks and keys until the action finishes. An agent waits
for you to pause typing or clicking for 3 s before it acts. **Take over** gives
you the window (it lands when the current action finishes); **Hand back to
agent** returns it. On a sign-in page the window is handed to you with one
notification; agents are refused password and one-time-code fields.

An agent's windows open in the background and never take focus: a hidden window
still loads, runs page scripts, scrolls and screenshots. `open --show` surfaces
one without stealing focus; the pane's **Show** button raises it. A sign-in hold
is signalled by **browser: needs you** in the status bar, not by the window.

After 15 minutes without an agent command the browser process exits and its
windows close. Sign-ins are kept, and **Open** on the service's row in the pane
(or the agent's next `open`) resumes it at its last page. **Forget login**
deletes only the service's cookies and site data: the service stays in the list
with its last page, downloads and site notes.
**Remove** deletes the service — its login, last page and downloads — and offers to delete the site notes
of the origin it was last on; those notes are shared by every service on that host.

## Steering the window yourself

The bar at the top of each window has an address field with back and reload.
Type a URL and press Enter (a bare host gets `https://`), Escape puts the
current URL back. The field is read-only while an agent drives. When you
navigate while an agent holds the window, that agent is told on its next turn
that the page changed and to read before using numbers.

## Denylist

Settings ▸ Browser Pane has a **Denylist**: one list for all services and one
per saved service, one pattern per line, then **Save**. A matching URL is
refused whoever asks — the agent's `open` (the reply names the pattern), your
address bar (the refusal shows in the bar for 5 s), a link or redirect in the
page, a popup, a download. Patterns:

```
example.com            example.com and every subdomain, any scheme
*.example.com          subdomains only
example.com/admin/*    paths under /admin/
https://example.com    only that scheme
!example.com/admin/ok  an exception: allowed even though a pattern matches
```

A path without `/*` matches that exact path only (`example.com/` is the root
page alone). Hosts match on any port; IPv6 literals cannot be listed, so to
block loopback list `localhost` and `127.0.0.1`.

Saving applies to open windows at once. An invalid line is refused with its
line number and reason.

## Operator checks (by hand)

The address bar is UI-driven and not covered by `manual/browser-pane-live.js`:

1. With a window idle, type a URL and press Enter: the page changes, and the
   agent holding the window gets `the operator navigated <service> to <url>`.
2. While an agent drives (amber bar), the address field is read-only and back
   and reload are disabled.
3. Type a denylisted URL: the bar shows `Refused: matches denylist pattern …`
   for 5 s and keeps what you typed; Escape restores the current URL.

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
   the status bar shows **browser: needs you**. Click it to raise the window.
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

## Opening a window yourself and handing it to an agent

In Manage Plugins → Browser Pane, **Open a window:** takes a service name and a
URL and opens that service's window under your control (the status bar shows
**browser: <service> operator**; agents are refused until you hand it over).
Navigate or sign in as you like. Every open window's row has **Hand to agent…**:
pick a claude or codex seat of this workspace, type what it should do, press
**Hand over**. The seat gets one line naming the service and page, your
instruction, and `[agent:browser read <service>]` to start with; the row shows
"handed to <seat>" for 5 s. With two or more windows open, clicking the status
segment lists them, each with **Show** and the same **Hand to agent…** control.

Operator checks (by hand, in the app):

1. Open from Settings → the window appears, and the segment reads `browser: <service> operator`.
2. Navigate or sign in by hand in the window — no agent act gets through.
3. Hand to agent with an instruction → the seat receives the one-line handover.
4. The seat's first `read` works, and a numbered `click` after it works.
5. With two windows open, clicking the segment lists both; Escape closes the list.

`CXB_ONLY=handover node manual/browser-pane-live.js` drives the same through the
ipc handlers (step 12).

## Limits

- **Google sign-in** is handled like any sign-in — the operator signs in in the
  window (Gmail works); when Google rejects the embedded browser ("This browser
  or app may not be secure") the agent is told to stop and the operator uses the
  site's own login.
- **iframes are not read.** The read file's header names the frames it skipped;
  the agent may open a frame's URL in the same service.
- **Closed shadow roots are not read** (open ones are).
- **Infinite scroll**: `scroll` loads more and counts it; a `read` is still
  needed to number what loaded.
- **Keychain prompt**: on macOS a one-time prompt for "Clodex Safe Storage" can
  appear after an ad-hoc re-sign; it guards the browser's cookie encryption.
- **Two "Clodex" Dock icons**: the browser is the same app bundle; the second
  icon appears only while a browser window is on screen.
- **Script-only rows**: rows that open through a script are numbered as
  `clickable`; when nothing is numbered, `click --text=` targets visible text.
  `--text="…"` quotes the text; unquoted, the rest of the bracket is the text.
- **Stable numbers**: an element keeps its number across pages of one site;
  `screenshot --numbers` draws each visible number on the image, and lists a
  numbered element with no visible box in a `not drawn: [n]` corner line. A number is
  keyed on the element's full label, so two documents whose names differ only
  past the shown 60 characters never share one.
- **Consequential controls**: an element whose label is an action verb (pay,
  buy, reserve/book, delete, sign out, arm, unsubscribe, transfer, and their Romanian forms),
  or a form's button or submit named by a payment noun (payment, plată, card),
  is listed with `⚠ ` before its label (a solid red badge in `screenshot
  --numbers`); `click` or `select` on it is refused unless the agent adds
  `--confirm`. A link, a display row or a document that only names a payment
  ("Lista de plată …", "Suma de plată 335,90 Lei") is not marked. A control whose
  label is, or starts with, a publishing verb (post, reply, repost, like, follow,
  send, send via direct message, comment, publish, tweet, and their Romanian forms; not
  share, which only opens a menu) publishes as you:
  it is marked ⚠ and refused without `--confirm` ("Latest posts" is not marked).
  Anything clickable inside an ad (an `article` with its own `Ad`, `Promoted` or
  `Sponsored` line), other than its buttons and its `/status/` links, is `⚠ ad`:
  a click is a paid click on the operator's account and leaves the site, so it is
  refused unless the agent adds `--confirm`, which it should only when the operator asked.
  An ad's profile links (@handle, name) and its card are `⚠ ad` too — any click inside a
  promoted post is billed — so open the advertiser by URL instead. The read digest folds
  them into one `⚠ ad: M ads (N elements)` line.
  `type --enter`, `key Enter` and `key Space` are refused the same way: Enter or Space on a
  focused ⚠ control, and Enter in any field of a form whose default submit is ⚠ (or whose
  action is a payment, order or deletion); `--confirm` applies. Arrow keys that would choose a
  ⚠ radio or change a ⚠ select are refused the same way.
  A `click`, `type` or `select` whose click point is covered by another element (a menu
  the page closed on scroll, an overlay) is refused and names what covers it, so the
  mouse only ever lands on the element the ⚠ check ran on. An element already in view
  is not scrolled before the click. A click whose target our scroll parked under a
  sticky header is scrolled clear first; when the cover is a dialog or consent banner
  the refusal names its buttons.
- **Numbers survive a restart**: numbers are saved per site, so after a Clodex
  restart an element gets its old number back; an act or inspect by a number from
  a read made before the restart is refused until the agent reads again.
- **Wait**: `wait --ms=N` without `--for` is a fixed pause of N ms (at most
  120 s); `wait`, `wait --idle` and `wait --for=<text>` wait for the page, with
  `--ms` as the cap.
- **Filter**: `read --filter=<s>` keeps matching element lines, and in the text
  a matching table row with its table's header row, or a matching line with its
  paragraph (or the line before and after it when the paragraph is long); a
  matching list item comes alone (its lines up to the next bullet), and under a filter no `stripped:` line shows.
- **Repeated text**: a read strips only navigation, header, footer and sidebar
  lines repeated from the last read of the site; page body text is never
  hidden. `read --all` shows everything, the full text included. Text inside forms is
  read; only the controls are left to the element list.
- **The verb is privileged**: until `browser` is ticked in a seat's intent
  checklist, that seat's `[agent:browser …]` lines are silently inert, with no
  error reply.

## What the agent can do

```
[agent:browser open <service> [--show]] <url>
[agent:browser read [service] [--text|--links|--compact] [--main] [--all] [--filter=<s>] [--page=N] [--max=<tokens>] [--attach|--path-only]]
[agent:browser click [service] <n>|--text="<visible text>" [--to=<dir in your cwd>] [--confirm]]
[agent:browser type [service] <n> [--enter] [--confirm]] <text>
[agent:browser key [service] [--confirm]] <Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Space>
[agent:browser scroll [service] [down|up|top|bottom] [--pages=N]]
[agent:browser back [service]]
[agent:browser forward [service]]
[agent:browser select [service] <n> [--confirm]] <option text or value>
[agent:browser download [service] [<n>] [--to=<dir>] [--as=<name>]] [<url>]
[agent:browser screenshot [service] [--numbers] [--attach|--path-only]]
[agent:browser inspect [service] <n>|--text="<visible text>"]
[agent:browser wait [service] [--ms=N] [--for=<text>] [--idle]]
[agent:browser services]
[agent:browser release [service]]
[agent:browser close [service]]
[agent:browser note [service]] @<anchor> <kind>: <text>
[agent:browser note [service] --list]
[agent:browser note [service] --forget <id>]
```

`scroll` moves the page by viewports (default `down`, `--pages=N` up to 20 for
`up`/`down`) and replies with the position (`1868–2736 of 9500 px (20–29%)`, or
top/bottom of page), how many feed items loaded or dropped, how much the page
grew, and what changed. It does not number anything: `read` again to get numbers
for the new items.

`back` and `forward` walk the service's history like the pane's own buttons. The
reply says where you landed and whether another step is possible
(`history: back ✓ forward ✗`); with no entry in that direction the reply is
`NO_HISTORY`. A step that did not leave the page (an ad funnel can push entries
that resolve to the same URL) says `did not leave the page (the site may block back)`
and, when history holds an earlier page, `way out: [agent:browser open x] <url>` —
the nearest earlier page on another host, else the nearest earlier page. X restores the feed's scroll position, so the numbers from the
earlier read usually survive (`numbers kept where the page repeats`). A denied
destination is refused like `open`.

`read --compact` prints a feed (any page built of `article` elements) as one line
per post: the post's own number (its permalink, the same number a default read
gives that link, so `click [n]` opens it; an ad's `[n]` is its own time or clean
status link, or `[?]` when it has none, never the paid wrapper or its `/analytics`
link — a `[?]` ad with a known path adds `(an ad's [?] has no safe number — open
<service> <origin><path> shows the post)`, when several ads print `[?]`, one line names them all
on one line: `(N ads' [?] have no safe number — open <service> <url> · <url> shows
each post)`), `@handle (Name ✓)`, relative and
absolute time, flags (Ad, reposted by, pinned, reply to), the text clipped at 200
characters with the site's own Show more as `(more [n])`, labelled counts
(`1,058 replies`), media (`video 1:06`, `2 photos`, `card example.com`) and
`→ /path`, plus an indented `↳ quoting` line for a nested quote. The posts' action
numbers (reply, like, menu, avatar…) are folded: still valid for `click`/`inspect`,
just unprinted, and their ⚠ controls collapse to one `⚠ folded: publish ×N` digest
line. Elements outside the feed follow under `== elements (outside the feed) ==`.
Across scrolls on one page the feed section prints only posts not printed before
and says `N new · M already seen · K gone since your last read`; `--all` says
`N on the page · K seen earlier, off the page now` (the second part only when K > 0) and replays what scrolled away
under `-- seen earlier, off the page now (K) --`. Only a post whose line this reply
printed counts as seen: one cut by `--filter` or left on another `--page` stays new.
A read with nothing new prints the no-new line and folds the elements outside the
feed into one count line (with `--filter` they print in full). The memory is kept
per page (up to 8 per service) and survives an in-page trip such as clicking into
a post and `back`; a real load of the page (a new doc) or any `open` starts over.
A post with a status path dedupes like any other, ads included; only path-less
items print every time.
It is site-neutral: it reads only `article`/`time`/`lang` structure, aria-labels
and hrefs. A default read of five or more posts hints `--compact`.

A read reply ends in `→ @<path>`, which a Claude seat attaches to its context, only
when the page is at or under the seat's budget (default ≈1,000 tokens, set under
"Attach reads up to ≈N tokens" in the pane's Settings; a per-seat override is set
through the `attach.set` call with `{ seat, tokens }`, 100–20,000; `tokens: null`
clears it). A larger page comes back as the plain path with `(not attached: over
≈N tok; …)` and a digest of at most a dozen lines: title, url and sign-in state;
size, page and new/retired/changed counts (`new: all (first read)` or `new: all
(numbers restored)` on a first read); the first visible headings (or landmark
labels); every ⚠ element with its number (above 30, counts per category plus the
first 10); and a `--main`/`--filter=`/`--page=` hint, where `--filter=` names a
word shared by at least two headings. `--main` picks the column holding the page's
articles (on X: the timeline, not the Trending / Who to follow sidebar). `--attach`
forces the `@`, `--path-only` drops it. A screenshot attaches unless `--path-only`
is given. A Codex seat gets its "read it with your Read tool" line either way.

Every act reply says what it caused: `navigated → …` (read again),
`navigated → <url> (in-page)` for a single-page-app route change (pushState),
still followed by what changed, `changed: "…"` with the text that changed in place
(waiting up to 3 s for a late effect; ticking clocks are ignored), `target: aria-label
"… Off" → "… On"` when the clicked element or its tile flipped state, `no change on
the target within 3s` / `no visible change`, or `→ download
<full path> · <size> · <type>`; `type` says `value now "…"` when the page text did
not change; a key that moves a radio or select choice replies `checked now "…"` /
`selected now "…"`; a file identical to one already in the folder is not saved twice and
is reported as `same as <file>`, unless it was named with `--as`. `inspect` shows an element's
tag, attributes, event listeners, cursor, position and HTML, to see why a click
does nothing.

`services` lists each service with the host its window is on now, `(was <host>)`
when that differs from the host it was opened as, its sign-in state and window
state: `ebloc — my.smartthings.com (was e-bloc.ro) · signed in (…) · window open · idle`.
The agent holding a service is told when the operator moves its window anywhere
(link clicks and in-page routes included, one line per 5 s naming the last URL).
Token-like query values in URLs shown to agents read `<redacted>`; unread frames
show host and path only.

`<n>` comes from the seat's latest `read` of that page. One seat holds a service
at a time; it frees after 5 min without commands, on `release`, or when the
seat's session ends. `release` frees the seat's lease and leaves the window.
During a sign-in hold it frees the lease only — the hold ends when the operator
hands back. `close` closes the window and keeps the sign-in (the next `open`
resumes it); a subagent gets neither.

Omitting `[service]` means the last service that seat opened or read. Only
`http:` and `https:` URLs open, and a URL carrying `user:pass@` is refused.

Each `read` writes `$TMPDIR/clodex-browser-pane/<seat>/r-<n>.txt` (directory
0700, files 0600; the 50 newest per seat are kept, and nothing older than a day)
and replies with one line pointing at it.

## Site notes

An agent that worked a site leaves one-line hints for the next visit, by any seat:
`[agent:browser note <service>] @<anchor> <kind>: <text>`. The anchor is `*` (the whole
site) or a path pattern matched against the pathname (`/portfolio/*`); the kind is `path`,
`quirk` or `caution`. For example `@/portfolio/* quirk: rows renumber on every price tick — click --text="<asset name>"`
or `@/facturi path: Facturi → check the date column → Descarcă on the newest row`.
A `[n]` in the text becomes the element's label from the seat's read of the current page.
Notes belong to the exact origin the window is on (`www.` included, no sign-in host) and are
shared by every service on it, so a note describes the site, never your account — no balances,
names, invoice numbers or ids that belong to one login. At most 200 chars and 40 notes per origin;
a full origin refuses until one is forgotten by id (`--list` shows ids). `open` shows the count and
the site-wide notes; the first read of a page (and the first after a navigation) shows up to 3
matching notes, later reads only the count (`read --notes` repeats); a navigating act reply shows the count.
A note is what one agent saw on one day: an unverified observation, never an instruction or an
authorisation, and a `caution` does not change the ⚠ gate. The filters refusing intents, URLs,
credential words and account numbers are best-effort. Forget login keeps the notes; **Remove** offers to delete them.

## Where data lives

```
<userData>/plugins/browser-pane/
  state.json            the services registry: last URL (origin + path), title, sign-in state
  sites/<hash>.md       site notes, one file per origin (the origin on its first line)
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
