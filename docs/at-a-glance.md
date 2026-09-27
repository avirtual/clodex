# Clodex at a glance

## Seats
A **seat** (a session in the sidebar) is one agent (Claude, Codex or Muse) or a shell that
Clodex runs for you. The corner dot says what it is doing: pulsing amber thinking, fast-pulsing
orange waiting for you; green marks the seat you have open. A square chip is a **terminal
seat**; a round one is a **stream seat**, which has no terminal. Hover a row for its effort
and approval posture, and its model when Clodex knows it.

## Views
An agent seat shows one of three views:
- **Conversation** — your messages and the agent's replies. Turns driven by tickets,
  reports and reminders fold to one line.
- **Internals** — everything: every tool call, every message from Clodex and other seats.
- **Screen** — the CLI's own screen. The Screen button on the seat's bar switches to it and back (⌘⇧T does the same).

A stream seat has Conversation and Internals only; there is no terminal to fall back to.
When the CLI shows a menu, a picker or a dialog, its terminal opens under the conversation;
answer it there. Preferences ▸ Appearance ▸ "Agent seats open in" sets where new seats start.

## The message box
Enter sends, Shift+Enter adds a line, Esc interrupts, `/` lists the CLI's commands. A message
sent while the agent works shows `queued`, then `delivered`, then `✓ read`.

## Teams and tickets
A lead seat files **tickets**; hand seats work them on their own branch; a reviewer checks
each one and the loop merges it. A seat working a ticket carries a ticket dot on its row.
The Tickets button at the bottom of the sidebar opens the board and its Feed.

## When something looks stuck
Switch to Internals to see what the agent is doing, or to Screen to see what the CLI is
showing. ⧗ on a row means it is compacting its context; a number in minutes means a long
think.
