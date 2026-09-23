# inject-queue.js

## shouldWaitForReady
The claude-seat `ready` session-manager.js passes in is `_bootReadySeen` plus BOOT_DRAIN_SETTLE_MS (750 ms) past `_bootReadyAt`, not the bare latch: at the bare latch the first inject went out at edge+0 ms while the boot drain waited to edge+750 ms, and its Enter landed as pasted content.
Measured before the settle: 15 of 56 ticket-seat spawns (27%) hit the 90 s `spec unconfirmed` redelivery.
