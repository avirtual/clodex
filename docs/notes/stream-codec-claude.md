# stream-codec-claude.js

## encodeUser

stream-json user input accepts an array `content` of base64 `image` blocks followed by a `text` block; confirmed live against `claude -p --model haiku` (t1151: a 2x2 red PNG answered "Red."). No temp-file fallback is needed.
