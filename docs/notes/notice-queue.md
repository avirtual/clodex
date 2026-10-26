# notice-queue.js

## releaseReviewNoticeFor

Edge-triggered like `versionNoticeFor`; lead-only because release.sh launches the cloud review and the lead triages its issue; the range is last-spawn→host, so a lead that missed two releases triages the whole span at once.
It goes only to the lead of a team whose root releases Clodex (`releasesClodex`): the review's issue is triaged by whoever cuts releases, and any other lead would act on a false instruction. It never fires on a downgrade.

## releasesClodex

Two markers, both required: `package.json` with `name: "clodex"` and an existing `scripts/release.sh` under the team root; any read or parse error is false.
