# scripts/review-ab.js

## readRows

REVIEW-COST.jsonl is appended by a best-effort writer that returns rather than
throws, so a crash mid-append leaves a partial final line. That line is skipped
and the rest of the file is kept: dropping the whole file to one torn row would
silently halve a group in the A/B.

## summarize

Groups on the (template, model) PAIR: the two vary independently — the default
reviewer template was moved to another model mid-experiment — so a row carrying
only the template attributes that switch to the template.

The sort compares the two fields separately rather than the joined key.
localeCompare treats the NUL separator as ignorable, so sorting on the key
orders by the bare concatenation and interleaves one template's rows into
another's. Caught by the fixture that puts two models under one template.
