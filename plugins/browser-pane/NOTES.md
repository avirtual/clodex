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

## child.js — barNav

The bar (`bar.html`, the window's own webContents) talks to the child only by
`console.log`: `cxb:takeover`, `cxb:handback`, `cxb:back`, `cxb:reload` and
`cxb:go <typed text>`. Typed text gets `https://` unless it carries a scheme
(`urlpolicy.typedUrl`), then `checkOpenUrl` and the policy. Bar actions run
only while the service is `idle` or `held`, through `serial` so they never
overlap an agent op, and stamp `svc.lastInput` so an agent's quiet gate waits.
A committed navigation sends `operator-nav`; the engine tells the lease holder
once per 5 s per service. `driver.installFilters` sits on the page view's
webContents, not the bar's, so typing in the address bar is never filtered.

## child.js — policyDenies

The one denylist check, called from every navigation path: agent `open`, the
address bar, `block` (`will-navigate`, `will-frame-navigate`, `will-redirect`,
also attached to every allowed popup via `guardPopup`), both
`setWindowOpenHandler`s, `viaUrl`, and the per-partition `will-download`
router. The child gets the lists with every `open` (`args.policy`) and with the
`policy` op the engine sends on a Settings save. Repeats of one URL within
1 s send one `denied` event. A `will-redirect` refusal during an agent open
reads as `NAV_FAILED`, not the refusal text.

## urlpolicy.js — compilePolicy

`host` matches the host and its subdomains on any scheme and port; `*.host`
subdomains only; `host/path/*` a path prefix, `host/path` the exact path;
`http://` or `https://` pins the scheme; `!` makes an allow exception, checked
across both lists before any deny. Host compare is case-insensitive (WHATWG
host parsing), path compare exact-case. Ports, IPv6, `?`, `#` and inner `*` are
rejected. 200 patterns per list, 512 chars each; blank lines are dropped.
