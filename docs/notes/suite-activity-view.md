# suite-activity-view.js

## QUIET_MS
5 minutes. Measured 2026-11-15 by sampling a live container verify job's stdout/stderr mtimes once a second for its last 6.4 minutes (avh t1664, a ~16-minute full run): gaps between writes were 215s, 177s, 21s, 10s, 3s, 3s, so a healthy job already goes 3m35s silent. `TESTJOB_QUIET_MS` in cli/src/output.js must hold the same value (the cli package ships alone).
