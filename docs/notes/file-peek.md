# file-peek.js

## IMAGE_MAX_BYTES

4 MiB: a remote peek rides `PeerConnection._request` (peer-client.js), whose reply cap is 8 MiB for the `filePeek` query kind only (1 MiB for every other request); 4 MiB of base64 is ~5.6 MB. The web host's ws send path has no cap. The 4 MB figure is repeated in `paintFile`'s over-limit note (renderer/file-tab.js).
