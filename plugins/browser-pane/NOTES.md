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

## child.js — opOpen

When the idle wait times out and the page is still loading (a subresource that
never finishes), the load is stopped before the login probe runs:
`executeJavaScript` waits for load in both worlds, so without the stop every later
`read` times out and the probe sees nothing.
