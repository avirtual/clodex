# stream-reap.js

## START_MATCH_MS

A recorded pid is ours only if its kernel start time (`ps -o lstart=`, whole-second resolution) is within 2 s of the one recorded at spawn; otherwise the pid was recycled and is left alone.
