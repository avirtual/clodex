# voice-capability.js

## readVoiceCapability

Answers whether the Claude CLI on THIS machine could capture audio at all —
Clodex records nothing itself, it only toggles the CLI's `/voice` mode, and the
CLI listens on the box it runs on.

`darwin` is capable unconditionally: the CLI records through the system there
and needs no SoX.

Everywhere else SoX must be on `PATH`, and the check never spawns — a probe
that ran `sox --version` would be a process launch on a five-second poll, and
on a box without SoX the spawn failure is the slow path. `fs.existsSync` over
the `PATH` entries answers the same question with no child process, which is
why `test/voice-capability.test.js` asserts the module source requires no
`child_process`.

On `linux` a present SoX is not enough: a container or a headless node carries
the binary with no ALSA device behind it, so `/dev/snd` must exist and hold at
least one entry. A `readdirSync` that throws (absent, unreadable) reads as not
capable, never as an error the caller has to handle.

## readVoiceCapabilityCached

The IPC handler serving `settings:voiceMode` answers a renderer poll every five
seconds, so the uncached read would walk `PATH` with a stat per entry on every
tick. Neither SoX nor `/dev/snd` appears while the app runs in any way that
matters, so one read per process is the right grain; the uncached export stays
for tests, which must be able to vary platform and fs per row.
