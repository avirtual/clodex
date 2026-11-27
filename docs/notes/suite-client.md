# suite-client.js

## handSlackMs
The runner's setup phase (tree materialize plus the team's setup command, killed at the team's `setup.timeoutMs`, else the runner's `setupTimeoutMs` of 15 min, up to 30 min) is counted by the client's run budget but not by the runner's kill timer; the slack is that setup limit plus 2 min for the kill and finish.

## handExecSlackMs
The exec ceiling counts from spawn, before the client's own start, so it sits 2 min past the client's slack.
