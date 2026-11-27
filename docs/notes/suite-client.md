# suite-client.js

## HAND_RUN_SLACK_MS
The runner's setup phase (tree materialize plus the team's setup command, `setupTimeoutMs` 15 min in suite-runner.js `DEFAULT_LIMITS`) is counted by the client's run budget but not by the runner's kill timer; 17 min is that setup ceiling plus 2 min for the kill and finish.

## HAND_EXEC_SLACK_MS
The exec ceiling counts from spawn, before the client's own start, so it sits 2 min past the client's slack.
