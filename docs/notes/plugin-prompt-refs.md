# docs/notes/plugin-prompt-refs.md

Resolving a `<plugin-id>:<stem>` prompt reference against the loaded plugins.
A pure leaf — fs and the bundle list arrive as arguments — so engine.js's four
prompt seams are one-line delegates over it and the tests drive the real code.

## splitPluginPromptRef

The FIRST colon splits, so a library prompt can never be mistaken for a
namespaced one: a bare stem cannot contain a colon (the name regex forbids it),
and a leading colon leaves an empty id, which names no plugin.

## bundleForPromptRef

THROWS where the library path returns null, and the asymmetry is the point. A
missing library prompt degrades to the CLI default; a namespaced stem the seat
cannot reach means the template naming it was applied to the wrong seat, so
spawning anyway produces a seat silently missing the prompt it was configured
with. The two messages differ deliberately — "not loaded" sends the operator to
Manage Plugins, "does not hold" to the session's plugin ticks.

## pluginTemplateRows

Returns rows in the shape `templates.list()` returns, so the pickers need no
second code path. `plugins` is already merged by the loader's read, which is
what makes picking a plugin template GRANT the plugin rather than require it.
