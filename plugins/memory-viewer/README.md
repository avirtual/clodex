# Memory Viewer

Browser for the memories Clodex agents save with `[agent:memory remember]`.
Opens from the "Memories" button in the sidebar footer — the only surface it
adds. Agents (with unit counts and a live-session marker) on the left, that
agent's units — scope, learned-at, source, pinned state, body — on the right.
Pinned units are highlighted; they are the ones baked into every new session's
boot digest.

Every agent directory found in the store is listed, not just agents with a
running session: memories outlive their sessions, and the dead ones are exactly
the material you cannot reach any other way.

## Deleting

Each unit has a delete control. The confirmation shows the unit's **body**, not
its id — `mem-1785440884251-q4d5j2` is unidentifiable, and confirming it would
be confirming a string. A pinned unit says so on its own line: it is served in
full to every new session of that agent, so deleting one is a bigger decision
than deleting an index entry.

Deletion is permanent. There is no archive, no trash and no undo.

Only units created by `[agent:memory remember]` can be deleted here. This
surface lists every `*.md` file with frontmatter that lives *inside* the agent's
own folder, but Clodex will refuse to delete one whose name is not a generated
unit id — a hand-authored `project-notes.md` shows up and can be read, and
removing it is a job for the shell. The refusal happens before anything is
unlinked.

An entry that resolves outside that folder is skipped entirely: the folder is
the agent's to write, so a symlink planted there is the agent choosing what the
viewer shows you, not a memory. Skipped means not listed and not read — never
deleted.

The delete goes through `host.library.remove('memory', …)` rather than
unlinking the file this plugin can plainly see. Removing a unit obliges a
boot-digest rewrite for any live claude session of that agent — core's job, on
core's timing. Everything else here is still read-only: it does not pin, unpin
or edit, and the `[agent:memory …]` intent remains the only way to write one.

## The agent folder, and the two shapes it may have

`resolveAgentDir` decides whether `library/memory/<agent>` is that agent's
folder, and accepts exactly two answers: the path resolves to ITSELF, or it
resolves to `sessions/<agent>/memory`. The second is the seat layout —
`seat-layout.js` moves a seat's memory dir under its one home and leaves a
symlink at the old spelling, so a resolve-to-itself rule alone made every
migrated seat go dark here, silently, since an empty list is also what a seat
with no memories looks like.

The security property is unchanged by that second answer, because the seat path
is derived from the agent name being ASKED FOR. A link aimed at a sibling seat's
memory (`library/memory/a -> sessions/b/memory`) resolves to neither `a`'s own
path nor `a`'s seat path, so it renders nothing — the same refusal the
resolve-to-itself rule gave, for the same reason: `agent` arrives over IPC and
need not have come from the listing.

`seatMemoryDir` mirrors core's path grammar by hand rather than importing it.
The boundary lint refuses a require that leaves this directory, so this is the
same trade `MEMORY_ROOT` already makes against `defaultClodexHome`: a change to
core's `SEAT_KINDS.memory` must reach both lines.

## Freshness

Nothing notifies a plugin when a memory file changes, so the store is read on
demand: the overlay re-reads from disk on every open, and nothing is read
before then. What you see is as of the moment you opened it.

There is no session-row badge. A standing unit count is not something you need
at all times, and carrying one meant a poll, a cache and a staleness bound on a
surface that now has none.

## Settings

None.
