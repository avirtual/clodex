# renderer/popovers/help-panel.js

## ensureSearchIndex
The index is built from one `api.helpPage` call per manifest page — 17 IPC reads,
~560 KB — and only on the first search of a renderer lifetime, never at open.
`buildSearchIndex` is over the raw markdown of every page, so it cannot be built
from the index payload, which carries headings but no bodies.

## initHelpPanel
Escape inside `#help-search` calls `stopPropagation`: the document-level Escape
handler in renderer.js closes the single open overlay, so without it the first
press to clear a query would dismiss the whole panel instead.

## resolveHref
`docs/help.json` carries a page's repo path, but `help:index` does not forward it,
so a relative link's target is mapped back to a page name here by the manifest's
own naming rule rather than by lookup.
