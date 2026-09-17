# renderer/lib/render-doc.js

The DOM emitter for the Help window (t981 / S2 of tasks/help-window). Takes what
doc-parse.js produced and returns a DocumentFragment. It is a pure leaf: no
renderer state, no fs, and the only globals it touches are the `document` passed
in (defaulting to `globalThis.document`, which is what lets the test drive it
with a serializing stub and no jsdom).

## renderDoc

Its shape IS its security property. Every leaf is written through `textContent`
or `setAttribute`; the string `innerHTML` does not appear in the file, and
test/render-doc.test.js pins that as a source-shape scan because no runtime
assertion can tell a tree built by `textContent` from one built by `innerHTML` —
they have the same shape and the same text. The corpus is trusted today, but a
docs page is also the one surface an agent can write into, so the negative is
worth holding by construction rather than by review.

`parsed` may be the `{ blocks }` object or a bare block array; anything else
renders empty rather than throwing. An unknown block or inline type is skipped
silently — the parser can only emit the types below, so a surprise here means a
version skew, and a half-rendered page beats a thrown exception inside a panel.

## renderLink

`resolveHref(href)` is the whole policy; this file has no scheme allowlist of its
own. Four answers:

- `{kind:'external', url}` → `<a href=url target="_blank" rel="noreferrer noopener">`.
  In the desktop that reaches `setWindowOpenHandler` in main.js and goes to
  `shell.openExternal`; in the browser GUI it is a new tab.
- `{kind:'page', name, slug}` and `{kind:'anchor', slug}` → `<a href="#">` with
  `data-page` / `data-slug`. The real destination NEVER lands in `href`: the
  panel reads the data attributes on click, so a navigation cannot escape the
  app even if the resolver is wrong.
- `null`, an unknown `kind`, or no resolver at all → the link's children are
  rendered inline with no `<a>` element. That is the fallback the `javascript:`
  row of the injection table exercises: the href disappears entirely rather than
  being sanitized, so there is nothing left to get the sanitizing wrong on.

## renderBlocks

`heading` → `h1`-`h6` with `id = slug` (the anchor targets the panel scrolls to);
`anchor` → `<span id>`, the `<a name>` shape the corpus uses in plugin-api.md;
`code` → `pre > code[data-lang]`, the attribute set only when the fence named a
language; `list` → `ul`/`ol` with `start` emitted only when it is not 1, since a
`start="1"` is noise in the DOM. A list item's children are BLOCKS, so every item
carries at least a `<p>` — the panel's CSS styles that, not a bare text node.
