# suite-box.js

## listProcs
`ps -A -ww -o pid=,args=`, not `ps -ax`: procps in UNIX mode reads `-a` as "processes with a tty", which hides a detached build client and lets `confirmNoClient` pass falsely; `-A` means every process on both macOS and procps. `-ww` keeps the line untruncated so the build token at the end of a long `docker build` line stays visible.
