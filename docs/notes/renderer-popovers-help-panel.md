# renderer/popovers/help-panel.js

## ensureSearchIndex
The index is built from one `api.helpPage` call per manifest page — 17 IPC reads,
~560 KB — and only on the first search of a renderer lifetime. What is memoized is
the in-flight PROMISE, not its result: a result-keyed cache does not dedupe, and
every keystroke during the ~17 awaits would start its own build. A build that saw
any page fail drops the memo so the next search retries rather than pinning a
partial index for the lifetime.

## initHelpPanel
Escape inside `#help-search` calls `stopPropagation` only when the input is
non-empty, so the press that clears a query does not also close the panel while an
Escape on an empty box still reaches the document-level handler in renderer.js —
which is the only thing that closes the overlay, and the input holds focus from the
moment it opens.

## resolveHref
`docs/help.json` carries a page's repo path, but `help:index` does not forward it,
so a relative link's target is mapped back to a page name here by the manifest's
own naming rule rather than by lookup.
