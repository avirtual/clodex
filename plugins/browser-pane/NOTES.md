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

## page-scripts.js — READ_INTERACTIVE

Numbers are monotonic per document: an element keeps the number it was first
given, new elements get higher ones. The number table lives in isolated world
4242, so the page cannot reset or forge it; `data-cx` is only a mirror. Open
shadow roots are walked. Identical link repeats (nav duplicated in mobile menus)
are listed once.

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
