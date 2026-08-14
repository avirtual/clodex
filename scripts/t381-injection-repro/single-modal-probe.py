#!/usr/bin/env python3
"""Does a SECOND delivery land when the swallowing modal does NOT chain?

This is the case that decides shape (a) (post-write redelivery).
`redeliver-probe.py` answers it for first-run onboarding, whose modals chain BY
CONSTRUCTION (theme picker -> terminal setup -> ...), so its "the retry is
swallowed too" result cannot be generalised to every non-composer state.

The only real-world datum points the other way: the operator poked
`clodex-reviewer-377-r1` ONCE with "there?" and it woke and began reviewing --
a successful single redelivery into the actual failure state.

A permission dialog would be the ideal subject, but it is not reachable on a box
whose settings auto-approve (measured: both `echo` and `curl` ran with no
prompt). So this takes the other route: CALIBRATE the onboarding chain's length,
then replay it stopping ONE modal short, so exactly one modal is up when the
first delivery arrives. That isolates "a single modal" from "a chain".

  phase 1  press Enter until the composer accepts text; count the presses (N)
  phase 2  fresh CLI, press Enter N-1 times -> exactly one modal remains
           delivery 1 -> expected swallowed
           delivery 2 -> THE QUESTION: does it land?

In production `shouldHoldDm` sees `needsAttention.kind === 'permission'` and
holds/parks rather than injecting, so a KNOWN dialog is already avoided; this is
about a non-composer state entered anyway.
"""
import os, pty, sys, time, select, re, fcntl, termios, struct

CTRLU_SETTLE_MS = 30
SHORT_TEXT_DELAY = 50
MARKER = 'PINEAPPLE'
NUDGE = 'say the single word %s and nothing else' % MARKER

def set_size(fd, r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))

def strip_ansi(s):
    s = re.sub(r'\x1b\][^\x07\x1b]*(\x07|\x1b\\)', '', s)
    s = re.sub(r'\x1b[@-Z\\-_]', '', s)
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', s)

def drain(fd, sec):
    end = time.time() + sec
    got = []
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                break
            if not d:
                break
            got.append(d)
    return b''.join(got)

def inject(fd, text, settle=SHORT_TEXT_DELAY / 1000):
    """Exactly inject-queue.js _drain for single-line text."""
    os.write(fd, b'\x15')
    time.sleep(CTRLU_SETTLE_MS / 1000)
    os.write(fd, text.encode())
    time.sleep(settle)
    os.write(fd, b'\r')

def boot(tag, argv):
    d = '/tmp/t381-single-%s-%d' % (tag, os.getpid())
    os.makedirs(d, exist_ok=True)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        # Drop the inherited Claude session wholesale: this probe runs from
        # inside a seat, and an inherited session/permission env is exactly what
        # makes the child skip the modal we need.
        for k in [k for k in os.environ if k.startswith('CLAUDE')]:
            os.environ.pop(k, None)
        os.environ.pop('CLAUDECODE', None)
        os.environ['CLAUDE_CONFIG_DIR'] = d
        os.execvp(argv[0], argv)
    set_size(fd, 40, 100)
    drain(fd, 12)
    return pid, fd

def kill(pid, fd):
    try:
        os.kill(pid, 9); os.waitpid(pid, 0); os.close(fd)
    except Exception:
        pass

def composer_accepts(fd):
    """Is the composer live? Type a probe string and see if it echoes."""
    probe = 'ZZPROBEZZ'
    os.write(fd, b'\x15')
    time.sleep(CTRLU_SETTLE_MS / 1000)
    os.write(fd, probe.encode())
    time.sleep(0.35)
    seen = probe in strip_ansi(drain(fd, 0.5).decode('utf-8', 'replace'))
    os.write(fd, b'\x15')          # clear the probe text again
    time.sleep(0.05)
    drain(fd, 0.2)
    return seen

argv = sys.argv[1:] or ['claude']

# --- phase 1: how many Enters does the chain need? --------------------------
pid, fd = boot('cal', argv)
N = None
for i in range(0, 8):
    if composer_accepts(fd):
        N = i
        break
    os.write(fd, b'\r')
    drain(fd, 2.5)
kill(pid, fd)

if N is None:
    print('INCONCLUSIVE: composer never became reachable within 8 Enters.')
    sys.exit(2)
print('calibration: %d Enter(s) dismiss the chain' % N)
if N < 1:
    print('INCONCLUSIVE: no modal on this config; nothing to test.')
    sys.exit(2)

# --- phase 2: stop ONE modal short, then two deliveries ---------------------
pid, fd = boot('run', argv)
for _ in range(N - 1):
    os.write(fd, b'\r')
    drain(fd, 2.5)
print('advanced %d/%d -> exactly one modal should remain' % (N - 1, N))
pre = composer_accepts(fd)
print('composer live before delivery 1 (want False):', pre)

inject(fd, NUDGE)
out1 = strip_ansi(drain(fd, 8).decode('utf-8', 'replace'))
echoed1 = NUDGE[:25] in out1
answered1 = MARKER in out1.replace(NUDGE, '')
print('delivery 1 -- echoed: %s  answered: %s' % (echoed1, answered1))

inject(fd, NUDGE)
out2 = strip_ansi(drain(fd, 25).decode('utf-8', 'replace'))
echoed2 = NUDGE[:25] in out2
answered2 = MARKER in out2.replace(NUDGE, '')
print('delivery 2 -- echoed: %s  answered: %s' % (echoed2, answered2))

print()
if pre:
    print('INCONCLUSIVE: composer was already live, so delivery 1 was not swallowed.')
elif answered1:
    print('INCONCLUSIVE: delivery 1 landed; no loss to recover from.')
elif echoed2 or answered2:
    print('RESULT: a single (non-chaining) modal -- REDELIVERY LANDS.')
    print('        Shape (a) IS viable for a one-shot non-composer state.')
else:
    print('RESULT: a single (non-chaining) modal -- redelivery is ALSO swallowed.')
    print('        Shape (a) does not rescue even a one-shot modal.')
print('--- tail after delivery 2 ---')
print(out2[-1200:])
kill(pid, fd)
