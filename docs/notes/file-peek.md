# file-peek.js

## IMAGE_MAX_BYTES

720 KiB, not 4 MiB: a remote peek rides `PeerConnection._request` (peer-client.js), which destroys any reply over 1 MiB of JSON; 720 KiB of base64 is ~983 KB, leaving ~65 KB for the envelope. The web host's ws send path has no cap. The 720 KB figure is repeated in `paintFile`'s over-limit note (renderer/file-tab.js).
