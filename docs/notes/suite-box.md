# suite-box.js

## listProcs
`ps -A -ww -o pid=,args=`, not `ps -ax`: procps in UNIX mode reads `-a` as "processes with a tty", which hides a detached build client and lets `confirmNoClient` pass falsely; `-A` means every process on both macOS and procps. `-ww` keeps the line untruncated so the build token at the end of a long `docker build` line stays visible.

## listBoxImages
Image retention: a runner removes a `clodex-box:<hash12>` image (label `clodex.box`) once no job has started with its definition and no build of it has succeeded for `cacheIdleMs` (14 days); `pruneBoxImages` in suite-runner.js decides and calls `removeImage`. An image with no usedAt record is stamped on first sight and kept for that pass. Never removed: an image without the `clodex.box` label, an image a live job or the build in progress names, and an image Docker refuses to remove: `removeImage` runs `docker image rm` without `-f`, so an image a container uses, or one tagged more than once, stays and the refusal is logged. A failed `docker image ls` or `inspect` removes nothing. Box images do not count toward `cacheMaxBytes`; age is the only rule. Docker's build cache, volumes and other images are not touched.

## removeTreeAsync
`reap` removes the job dir with this, after the container clear; a failure rejects with `removal: true` so `finish` in suite-runner.js logs it without entering the box hold (the hold is for unconfirmed container cleanup).
