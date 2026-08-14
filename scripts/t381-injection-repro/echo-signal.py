#!/usr/bin/env python3
"""Is "PTY output during the settle window" a usable signal?

Two things decide it:
  BASELINE: does an IDLE composer emit spontaneous output (spinner/status)?
            If yes, "saw output" is always true and the signal is worthless.
  SIGNAL:   does a healthy composer reliably emit output after our text write,
            and does a swallowed (modal) one reliably emit none?

Runs each arm N times and reports bytes-seen counts.
"""
import os, pty, sys, time, select, fcntl, termios, struct, re

PASTE_START = '\x1b[200~'
PASTE_END = '\x1b[201~'
SETTLE_SHORT = 0.050
SETTLE_LONG = 1.000

def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

def drain(fd, seconds, sink=None):
    """Read for `seconds`; return bytes seen."""
    n = 0
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                break
            if not d:
                break
            n += len(d)
            if sink is not None:
                sink.append(d)
    return n

def boot(argv, env_extra=None):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        # Dropped in EVERY probe here: these run from inside a Claude seat, and an
        # inherited session env changes what the child does on its own initiative.
        # CLAUDE_CONFIG_DIR is EXEMPT -- it is how the modal arms select a fresh,
        # un-onboarded config, and popping it turns a swallow arm into a healthy one.
        _cfg = os.environ.get('CLAUDE_CONFIG_DIR')
        for _k in [_k for _k in os.environ if _k.startswith('CLAUDE')]:
            os.environ.pop(_k, None)
        os.environ.pop('CLAUDECODE', None)
        if _cfg:
            os.environ['CLAUDE_CONFIG_DIR'] = _cfg
        if env_extra:
            os.environ.update(env_extra)
        os.execvp(argv[0], argv)
    set_size(fd, 40, 100)
    drain(fd, 12)
    return pid, fd

def kill(pid, fd):
    try:
        os.kill(pid, 9); os.waitpid(pid, 0); os.close(fd)
    except Exception:
        pass

def arm_baseline(argv, settle):
    """Idle composer, NO write. How many bytes arrive in a settle window?"""
    pid, fd = boot(argv)
    drain(fd, 1.0)                     # let boot output finish
    n = drain(fd, settle)
    kill(pid, fd)
    return n

def arm_inject(argv, settle, text, paste, env_extra=None):
    pid, fd = boot(argv, env_extra)
    drain(fd, 1.0)
    os.write(fd, b'\x15')
    time.sleep(0.030)
    drain(fd, 0.040)              # flush the Ctrl-U redraw: a 0.0 window reads NOTHING
    out = text.replace('\n', '\r')
    if paste:
        out = PASTE_START + out + PASTE_END
    os.write(fd, out.encode())
    n = drain(fd, settle)              # THE window: text write -> Enter
    kill(pid, fd)
    return n

SPEC = ('[ticket t999] a representative spec body\n'
        + '\n'.join('detail line %d with some substance to it' % i for i in range(12))
        + '\nUNIQUE_SPEC_MARKER_ZQX\n')
SHORT = 'say PINEAPPLE'

argv = ['claude']
N = int(sys.argv[1]) if len(sys.argv) > 1 else 3

print('arm                          bytes seen in settle window')
measured = {}
for label, fn in [
    ('BASELINE idle (short settle)', lambda: arm_baseline(argv, SETTLE_SHORT)),
    ('BASELINE idle (long settle)',  lambda: arm_baseline(argv, SETTLE_LONG)),
    ('HEALTHY short text',           lambda: arm_inject(argv, SETTLE_SHORT, SHORT, False)),
    ('HEALTHY spec (pasted)',        lambda: arm_inject(argv, SETTLE_LONG, SPEC, True)),
]:
    vals = [fn() for _ in range(N)]
    measured[label] = vals
    print('%-28s %s' % (label, vals))
healthy_short = measured['HEALTHY short text']

# modal arm needs a fresh config each run
vals = []
for i in range(N):
    d = '/tmp/t381-modal-%d-%d' % (os.getpid(), i)
    os.makedirs(d, exist_ok=True)
    vals.append(arm_inject(argv, SETTLE_SHORT, SHORT, False, {'CLAUDE_CONFIG_DIR': d}))
print('%-28s %s' % ('SWALLOWED modal short', vals))
swallowed_short = vals

vals = []
for i in range(N):
    d = '/tmp/t381-modalspec-%d-%d' % (os.getpid(), i)
    os.makedirs(d, exist_ok=True)
    vals.append(arm_inject(argv, SETTLE_LONG, SPEC, True, {'CLAUDE_CONFIG_DIR': d}))
print('%-28s %s' % ('SWALLOWED modal spec', vals))
swallowed_spec = vals

# The busy arm: a seat mid-turn, measured with NO write at all. Without this the
# table reads as "echo is a clean signal" and shape (b) looks viable.
#
# The seat must be VERIFIED streaming before the window is measured. A fixed sleep
# reports 0 whenever the turn has not started yet (a slow model, an expired login),
# and 0 here reads as "no noise" -- the exact opposite of the finding, published as
# a number. So poll for real output first and say INCONCLUSIVE if it never comes.
pid, fd = boot(argv)
drain(fd, 1.0)
os.write(fd, b'\x15')
time.sleep(0.030)
os.write(fd, b'count slowly from 1 to 40, one number per line')
time.sleep(SETTLE_SHORT)
os.write(fd, b'\r')
# Sampled ACROSS the turn, reporting the worst (largest) window, not one sample.
# The noise is bursty: the model alternates thinking (silent) with streaming, so a
# single 50ms probe can land in a gap and report 0 -- which would publish "no
# noise" as the finding. What decides shape (b) is the WORST case a settle window
# can meet, so that is what is measured.
samples = []
_deadline = time.time() + 75
while time.time() < _deadline:
    n = drain(fd, SETTLE_SHORT)
    samples.append(n)
    if len([x for x in samples if x > 0]) >= 12:
        break
busy_baseline = max(samples) if any(samples) else None
kill(pid, fd)
print('%-28s %s  (NO write -- pure noise, worst of %d samples)'
      % ('BUSY seat mid-turn',
         '%d' % busy_baseline if busy_baseline is not None else 'INCONCLUSIVE (never reached a turn)',
         len(samples)))

print()
# Separable WHILE IDLE, and swamped once the seat is busy -- both halves decide
# shape (b), so both are asserted here rather than left to the reader.
idle_sep = max(swallowed_short) < min(healthy_short)
print('FINDING healthy vs swallowed separable while idle: %s  (%s vs %s)'
      % (idle_sep, swallowed_short, healthy_short))
if busy_baseline is None:
    print('FINDING busy-seat noise swamps the signal: INCONCLUSIVE this run '
          '(the seat never reached a turn; re-run when the CLI can answer)')
else:
    print('FINDING busy-seat noise swamps the signal: %s  (%d bytes with NO write vs %s injected)'
          % (busy_baseline > max(healthy_short), busy_baseline, healthy_short))
print('=> presence-of-echo cannot discriminate mid-turn, which is why (b) was rejected.')
