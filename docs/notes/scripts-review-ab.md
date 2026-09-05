# scripts/review-ab.js

## readRows

REVIEW-COST.jsonl is appended by a best-effort writer that returns rather than
throws, so a crash mid-append leaves a partial final line. That line is skipped
and the rest of the file is kept: dropping the whole file to one torn row would
silently halve a group in the A/B.
