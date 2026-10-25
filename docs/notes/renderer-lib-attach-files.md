# renderer/lib/attach-files.js

## splitAttachable
Browsers give `File.type === ''` for an unknown extension (and for many Finder copies), so a file is never refused by type: only a seat image type routes to the image door, everything else to the file door.

## SEAT_FILE_MAX
Copied from `seat-files.js`, which the web bundle cannot inline (it requires `node:path`); `test/attach-files.test.js` pins the two equal.
