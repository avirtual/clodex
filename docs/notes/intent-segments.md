# intent-segments.js

## scanIntentLines
The parse helpers are overridable through `opts` because session-manager's
tests inject their own `parseIntent`/`looksLikeIntent`; the defaults are the
real intent-scanner and intent-registry functions, which transcript-records uses.
