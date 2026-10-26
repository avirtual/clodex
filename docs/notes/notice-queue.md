# notice-queue.js

## releaseReviewNoticeFor

Edge-triggered like `versionNoticeFor`; lead-only because the post-release cold review is the lead's ritual; the range is last-spawn→host, so a lead that missed two releases reviews the whole span in one run.
It goes only to the lead of a team whose root releases Clodex (`releasesClodex`): the review is owed by whoever cuts releases, and any other lead would act on a false instruction. It never fires on a downgrade.

## releasesClodex

Two markers, both required: `package.json` with `name: "clodex"` and an existing `scripts/release.sh` under the team root; any read or parse error is false.
