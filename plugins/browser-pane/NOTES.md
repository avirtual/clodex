# browser-pane — facts the code cannot carry

Lifted from the spike (`tasks/browser-pane-spike/`) and the design
(`tasks/browser-pane-design/DESIGN.md`). The plugin's `.js` files carry no
comments; these entries do that job, keyed by file and symbol.

## driver.js — withTimeout

`executeJavaScript` never settles when the document is replaced mid-call. Every
page call is raced against a timeout (8 s for scripts); `child.js` retries a
read once when it times out (null).

## driver.js — armIdle

Idle means: not loading, no in-flight XHR/fetch/document request (CDP Network;
WebSocket, EventSource and Ping excluded), and no DOM mutation, all held for
`quietMs`. Lifecycle events are recorded but not trusted: pushState transitions
fire none.

## driver.js — act

Arm the idle wait **before** acting. A click or Enter can send its XHR
synchronously, before an after-the-fact listener exists, and the wait then
returns on stale DOM.

## driver.js — pinSessionCookies

Spike Q1: without re-saving session cookies with an expiry, every tested site
was logged out after a relaunch, even on a `persist:` partition. Pinned cookies
carry an expiry, so they stop being session cookies and do not retrigger the
`changed` listener. `__Host-` cookies keep `secure`, `path=/` and no domain.

## page-scripts.js — READ_TEXT

Readability-style heuristic, no library: prefer `main`/`article`/`[role=main]`,
else the block with the most non-link text. `innerText` on a detached clone has
no layout, so the clone is attached off-screen to keep line breaks.
`select` is dropped from the text: its options are listed with the element, and a
month dropdown's ~80 options filled the 1,200-char text head. Data tables become
one line per `tr`, cells joined by ` | `, empty cells kept so a value keeps its
column. A table holding another table or a cell over `LAYOUT_CELL_CHARS` (400)
is layout and keeps its normal rendering.

## page-scripts.js — READ_INTERACTIVE

Numbers are monotonic per document: an element keeps the number it was first
given, new elements get higher ones. The number table lives in isolated world
4242, so the page cannot reset or forge it; `data-cx` is only a mirror. Open
shadow roots are walked. Identical link repeats (nav duplicated in mobile menus)
are listed once.

Beyond the standard controls, `a` without href, `[onclick]`, `[tabindex]` not
-1 and pointer-cursor elements are numbered as `clickable`. The pointer test
costs a `getComputedStyle` per element, so it is capped at `POINTER_SCAN_MAX`
(3,000) elements in document order; past that only attribute-marked clickables
are found. A pointer element whose parent is also pointer inherited the cursor
and is skipped. A clickable with no standard control inside suppresses
clickables below it (a row is numbered once, not per cell); one that contains a
standard control is a page wrapper (`<div onclick=closeMenus()>`) and does not,
unless it is a `tr` or `[role=row]`.

## page-scripts.js — FIND_TEXT

Own text only (direct text nodes, plus the value of input buttons), so the
match is the innermost element holding the text. Every listed candidate is
stamped, so its number clicks the text itself, not a wrapper.

## child.js — run

`app.setPath('userData')` and `('sessionData')` run before anything else: the
default userData is the parent's Chromium profile, and two browser processes on
one profile corrupt it. A `window-all-closed` listener keeps the child alive
when the last window closes. `console.log` goes to stderr so stdout carries only
protocol frames. stdin EOF means the parent is gone: pin cookies and quit,
capped at 2 s.

## child.js — openService

Stripping ` Electron/…` and ` Clodex/…` from the user agent makes it a plain
Chrome UA. With it, Google's refusal is an explicit `/v3/signin/rejected` page
rather than the Lite-flow dead end (spike Q1).

## driver.js — emulateFocus

Measured in T3 (Electron 43): in a window shown with `showInactive()`, synthesised
`sendInputEvent` mouse and key events reach a `data:` page but never reach an
`http:` page (no `mousedown` at all) until `Emulation.setFocusEmulationEnabled`
is on. It is re-sent before every act, since a navigation can swap the renderer.

## driver.js — S

`sendInputEvent` fires `before-input-event` / `before-mouse-event` synchronously
inside the call, so a module-level flag set around it marks our own events. CDP
`Input.dispatchKeyEvent` bypasses `before-input-event` entirely, so the filters
cannot be proven against keys from this seat; real OS keys take the native path.

## driver.js — click

`getBoundingClientRect` is in CSS px and `sendInputEvent` takes view DIPs, so
coordinates are multiplied by `getZoomFactor()`. CDP `Input.dispatchMouseEvent`
takes CSS px and needs no scaling.

## driver.js — typeText

Per-character `keyDown`/`char`/`keyUp`, not `insertText`: `insertText` fires no
key events, and keyup-driven widgets (debounced auto-submit, typeahead) ignore
it. Characters outside the BMP fall back to `insertText`.

## page-scripts.js — SELECT

Native `<select>` popups are not drivable by input events. The value is set with
the prototype setter from the isolated world, which bypasses a main-world
instance value tracker (React's), so the page's `change` handler sees a changed
value and fires `onChange`.

## child.js — mutating

When the idle wait times out and the page is still loading (a subresource that
never finishes), the load is stopped before the login probe runs:
`executeJavaScript` waits for load in both worlds, so without the stop every later
`read` times out and the probe sees nothing. For an act the stop runs only if the
main frame committed during the act: stopping an uncommitted navigation would
cancel a slow form POST the server may already have processed.

## client.js — OP_DEADLINE_MS

Deviation from DESIGN §3.4 (50 s / 90 s), which predates `open` being gated.
`open` worst case: gate 60 s + load 25 s + idle 15 s + probe 8 s ≈ 108 s → 110 s.
Acts: gate 60 s + FIND 8 s + idle 15 s (+≈3.5 s overrun) + probe 8 s ≈ 95 s → 100 s.

## child.js — mutating (pendingNav)

`svc.doc !== docAt` proves a main-frame commit, not that no main-frame
navigation is still pending: an interstitial that auto-POSTs after committing
(3-D Secure, SAML, "processing payment") would be cancelled by the stall stop.
`svc.pendingNav` is set on a cross-document main-frame `did-start-navigation`
and cleared on `did-navigate`, a main-frame `did-fail-load` /
`did-fail-provisional-load`, or `did-stop-loading`; no `wc.stop()` while it is set.

## child.js — routerFor

One `will-download` handler per partition. Waiters match by URL against
`getURLChain()` (redirects included), else the oldest URL-less waiter (a click).
A download with no waiter is the operator's: it lands in the service's default
folder with no dialog. `setSavePath` must be called synchronously in the handler
or Electron shows a save dialog.

## child.js — opScreenshot

`capturePage` can return an empty image when the window is hidden or minimized;
CDP `Page.captureScreenshot` is the fallback.

## engine.js — removePartition

`persist:<service>` lives at `chromium/Partitions/<service>`: service names are
`[a-z0-9-]`, so Electron uses the name verbatim.

## child.js — clickWatched

A click carries a URL-less download waiter into the service's downloads folder
(or the `--to` folder the scheduler resolved inside the seat's cwd), so a download
it starts is named in the reply with its full path, size, type and source URL. A `window.open` that shows a PDF
is saved through the router and the view goes back. The idle wait stops as
soon as either happens (the PDF viewer never reports idle). Waiting on the
file is capped at `CLICK_DOWNLOAD_MS` (5 s) to stay inside the 100 s click
deadline; past it the reply says `still downloading`. The PDF popup's load and
the way back bump `svc.doc` twice, so the reply says `navigated · numbers reset`
even though the view ends on the same page: the old numbers really are void.

## child.js — withChange

Every act snapshots `document.body.innerText` (`PAGE_TEXT`, main world) before
acting and again after the idle wait; `changedRegion` reports the lines between
the common prefix and suffix. Each snapshot is capped at `SNAP_MS` (2 s), not
the 8 s script timeout, so the two snapshots stay inside the 100 s act deadline.
A navigated act, a download or a popup skips the second snapshot.

## child.js — routerFor (dedupe)

After an agent waiter's download lands, it is hashed (sha256) only when a
same-size regular file already sits in its folder; on a match the new file is
deleted and the reply names the existing one (`same as`). Operator downloads
are never deduped. Hashing is synchronous in the child's main process.
`keepOrFold` never folds a waiter with a `nameHint` (`download --as=<name>`
asks for that path) or one marked `abandoned` (`settleDownload` gave up and
the reply already named the planned path, or `clickWatched` returned).

## child.js — listenersOf

`inspect` reads listeners through the attached debugger: a main-world
`Runtime.evaluate` of the element's `data-cx` mirror gives an objectId for
`DOMDebugger.getEventListeners` (depth 0). Elements inside shadow roots are not
reachable by `querySelector` from the document, so they read `unknown`. Up to
four ancestors are probed for a click/mousedown/pointerdown/mouseup listener
when the element has none of its own.

## read-format.js — chromeStrip

Lines are compared trimmed with blank lines skipped; a common top or bottom run
counts only at `CHROME_MIN_LINES` (3) and is capped at `CHROME_MAX_LINES` (40).
When the common runs cover all of the new text (same page), nothing is stripped.

## scheduler.js — runRead

The strip base is the seat's previous read of the service on the same origin.
Re-reading identical text reuses that read's base, so `--page=2` paginates the
same stripped text as page 1. The leading title line (`READ_TEXT` prepends
`document.title`) is kept out of the comparison: titles differ per page and
would otherwise end every common prefix at line 1. `--all` and `--links` skip it.

## child.js — loadingOf

`svc.watch` is an `armIdle` handle armed at the first `open` and never waited
on. A read is loading when `wc.isLoading()` or a non-skipped request has been in
flight over `LOADING_INFLIGHT_MS` (300 ms). `READ_TEXT` also counts visible
`BUSY_SEL` elements (`.loading`, spinners, `aria-busy`); either signal marks the
reply `still loading`.

## page-scripts.js — DEEP (vis)

Visible means a non-zero box that intersects the document (scroll offsets
added, against `max(scrollWidth, innerWidth)` × `max(scrollHeight, innerHeight)`),
computed opacity not `0`, no `clip: rect(0…)`/`rect(1px…)` or `clip-path:
inset(50%|100%)`, and not a ≤1×1 box with overflow hidden. e-bloc parks its
Highslide spinner (`a.highslide-loading`, "INCARCA...") at `top:-9999px`; before
this rule every read said `still loading`. The busy scan, the element list,
`FIND_TEXT`, `INSPECT` and `LOGIN_PROBE` share it. The rule is per element:
opacity or clip on an ancestor is not seen. When an ancestor scrolls
(`overflow` auto/scroll with overflowing content — app layouts with
`html,body{overflow:hidden}` and a scrolling `#app`), the box is tested against
that scroller's content range instead of the document: there `scrollY` stays 0
and the document is one screen tall. The walk stops at `document.scrollingElement`
(the body in quirks mode, where `body{overflow-x:hidden}` makes it look like an
inner scroller and would count the window scroll twice); the document range is
measured by that element. A scroller must itself be placed, so the children of a
scrolling drawer parked off-screen stay hidden. A `position:fixed` element is
tested against the viewport, since no scroller moves it. Scroller lookups are
memoised per script run.

## page-scripts.js — TABLES

One snippet renders data tables as `cell | cell` rows for both `READ_TEXT` and
`PAGE_TEXT`, so an act's changed region reads like the read. `PAGE_TEXT` inserts
its body clone into the live document, so iframes, objects, embeds and media are
removed from the clone first: a cloned iframe would re-request its `src`. A trailing
image-only cell keeps its slot as a trailing `|` (innerText trims the space).

## read-format.js — elementStrip

Key = the line without `[n] `, with `t=`/`_=`/`ts=` digit query values
blanked. A line is hidden only when the previous read had the same key under
the same number, so a number the agent saw on the previous page still clicks
the same element; a footer whose numbers shifted (more content above it) stays
listed. Form controls are never hidden, and at least one line always stays.

## scheduler.js — runRead (element strip)

The element base is the previous read of the service on the same origin and a
different URL (hash ignored); a re-read of the same URL shows every element,
except `--page>1` of an unchanged page, which reuses page 1's base so the pages
line up. The chrome strip skips a read on the same path whose text is within
`IN_PLACE_LINES` (2) changed lines of its base, so a one-line in-place change
is not reported as a stripped header.

## driver.js — armIdle (watch reset)

`reset()` clears the in-flight map; `child.js` calls it on every main-frame
`did-navigate`, so a request of the previous document that never finishes is
not counted as loading forever. `fired.lifecycle` keeps the last
`LIFECYCLE_MAX` (64) events, since `svc.watch` is never detached.
