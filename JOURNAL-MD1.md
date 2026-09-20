# t1028 M-D1 — far cwd validated at begin

Branch t1028-m-d1-move-to-peer-the-far-cwd-is on master 983eb2fc (ancestor confirmed).

## What landed (commit 05ce6cde)
1. seat-import.js `begin`: new `cwdRefusal()` after the resolve check — parent must exist
   and be a dir; cwd itself must not be a file; cwd must not be under any `refuseUnder`
   root. Options `refuseUnder: []` and `hostLabel: 'this box'` on `createSeatImport`.
2. remote-wiring passes `refuseUnder: [REGISTRY_DIR, ~/.claude, userDataPath]` and
   `hostLabel: SELF_LABEL`; engine.js feeds `getUserDataPath`.
3. peer-client: `importSeat` split into `importBegin({name,record})` + `importShip({id,files,onProgress})`,
   plus `importAbort(id)`. `importSeat` kept as the one-call wrapper.
4. session-manager: `_moveRecord` extracted from `_moveShipment`; `moveToPeer` probes with
   `conn.importBegin` BEFORE quiesce (refusal → `{ok:false,error}`, no `kept`), and calls
   `conn.importAbort(stagingId)` on the quiesce-timeout arm. Ship leg now `conn.importShip`.
5. renderer/lib/far-cwd-guess.js (new pure helper) + peers-ui prefill via it; renderer.js
   feeds `move.farPlatform` from `peerStatuses`; kept-arm toast appends the non-null
   `installed` keys.
6. Docs: peering §2b + consumer half, sessions "Move to a peer" (probe + guess),
   docs/notes/seat-import.md `## begin`, CHANGELOG bullet.

## Red-proofs (revert, run, restore — tree clean after each)
- P1 drop the parent check in `cwdRefusal` → RED `begin judges the far cwd against this box:
  parent, file-in-the-way, and Clodex data roots` (test/seat-import.test.js).
- P2 stop passing `refuseUnder`/`hostLabel` from remote-wiring → RED `begin returns the
  far-cwd refusal as a 400 and stages nothing for it` (test/seat-import-wire.test.js).
- P3 drop the pre-quiesce refusal guard + the timeout `importAbort` → RED `a far cwd the peer
  refuses at begin costs nothing…` and `the exit-TIMEOUT arm aborts the staging the pre-quiesce
  begin opened` (test/session-move-peer.test.js).
- P4 restore the verbatim prefill in peers-ui → RED `a peer on another OS warns in the note
  that the folder was guessed` (test/peer-move-dialog.test.js).

## Deviations
- Test fixtures: seat-import.test.js `CWD` and the wire test's `path.join(w.root,'proj')` were
  literal/registry-internal paths that the new rules now refuse. Moved to real tmp roots
  (`w.home`), no assertion semantics changed.
- session-move-peer.test.js's fake conn now implements importBegin/importShip/importAbort;
  `shipped[0]` still carries `{name, record}` so every existing assertion is untouched.
- Item 4 of the spec: the renderer kept-arm toast did NOT name `installed` — appended it.
