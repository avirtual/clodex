# wire-telemetry.js

## noteSession
The turnless binding lives in `_bound`, not `_agents`: `payload`, `seedLifetime` and `diffPoll` key on an `_agents` entry, so seeding one there would create a lifetime row and a save before any turn. `overlay` uses `_bound` only for the hold fields.
