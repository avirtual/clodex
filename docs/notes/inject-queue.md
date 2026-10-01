# inject-queue.js

## shouldWaitForReady
The claude-seat `ready` session-manager.js passes in is `_bootReadySeen` plus BOOT_DRAIN_SETTLE_MS (750 ms) past `_bootReadyAt`, not the bare latch: at the bare latch the first inject went out at edge+0 ms while the boot drain waited to edge+750 ms, and its Enter landed as pasted content.
Measured before the settle: 15 of 56 ticket-seat spawns (27%) hit the 90 s `spec unconfirmed` redelivery.

## _drain
Measured on claude 2.1.286 (tasks/paste-mode-off/MEASURE.md): mode 2004 never drops mid-session — not on a turn, a busy turn, `/clear`, `/compact`, a `!` shell escape or a permission dialog; the only `?2004l` is the `/exit` teardown. Paste is off only before the first `?2004h`, which `_drain` reaches when the boot-readiness cap fires.
A multi-line claude write waits for mode 2004 up to INJECT_PASTE_MAXWAIT, then parks (`onUndelivered`) or writes bracketed (`onPasteCapFire`); a raw multi-line write is held unsent by the composer (tasks/paste-wrap-threshold/MEASURE.md).
The wait releases on paste-on AND boot-ready (see `shouldWaitForReady`), and it runs before the fire-time divert so the draft check stays at write time.
