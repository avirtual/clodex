# suite-client.js

## handSlackMs
The runner's setup phase (tree materialize plus the team's setup command, killed at the team's `setup.timeoutMs`, else the runner's `setupTimeoutMs` of 15 min, up to 30 min) is counted by the client's run budget but not by the runner's kill timer; the slack is that setup limit plus 2 min for the kill and finish.

## handExecSlackMs
The exec ceiling counts from spawn, before the client's own start, so it sits 2 min past the client's slack.

## BOX_TIER
`probing` (a runner whose named box probe has not finished) ranks with `can-build`, the worst tier a pick accepts; a 5.208 source has no `probing` row and skips that member as `no box for this job`, which is how it treated the timeout the answer replaces.
