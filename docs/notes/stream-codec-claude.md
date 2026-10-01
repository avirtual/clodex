# stream-codec-claude.js

## encodeUser

stream-json user input accepts an array `content` of base64 `image` blocks followed by a `text` block; confirmed live against `claude -p --model haiku` (t1151: a 2x2 red PNG answered "Red."). No temp-file fallback is needed.

## encodeSetModel

CLI 2.1.286 answers `set_model` only after a 1-token probe request to the new model, so the ack can take a full API round trip; an error ack (`catalog_unknown` for an id the API does not know, `check_failed` for a 5xx/408/429 probe) leaves the session on its old model. A success is followed by a fresh `system init` and an `isReplay` user record. The ack is matched by `request_id`, not by the next `init`, because an `init` arrives before every turn anyway (t1492 CAPTURE.md).
