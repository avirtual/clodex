# claude-config-lock.js

## CLI_CONFIG_LOCK_STALE_MS
Read from the Claude CLI 2.1.332 bundle: the global-config save locks `<config path>.lock` (the path string as given, never realpath'd) with a proper-lockfile-style mkdir lock and no `stale` option, so the lock library's default applies: a lock dir whose mtime is older than 10000 ms is stale; the holder refreshes its mtime every 5000 ms.
A stale lock is taken over the CLI's way: rmdir, then one more mkdir; losing that mkdir counts as held.

## CONFIG_LOCK_WAITS_MS
The waits sum to 1975 ms, the bound on a spawn's synchronous seed. The CLI itself, finding the lock held, retries after 200, 400, 800, 1600, 3200 and 4000 ms (each times 1 to 2) and then saves without the lock, so a seed holding the lock for well under a second delays it, never drops its save.

## withClaudeConfigLock
No mtime refresh while held: the seed is synchronous, and on a 40 MB `.claude.json` (this Mac's is 40.8 MB) the lock was measured held about 340 ms, far under the 10000 ms stale threshold.
