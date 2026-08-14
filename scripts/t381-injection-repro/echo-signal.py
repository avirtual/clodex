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
    drain(fd, 0.0)
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
for label, fn in [
    ('BASELINE idle (short settle)', lambda: arm_baseline(argv, SETTLE_SHORT)),
    ('BASELINE idle (long settle)',  lambda: arm_baseline(argv, SETTLE_LONG)),
    ('HEALTHY short text',           lambda: arm_inject(argv, SETTLE_SHORT, SHORT, False)),
    ('HEALTHY spec (pasted)',        lambda: arm_inject(argv, SETTLE_LONG, SPEC, True)),
]:
    vals = [fn() for _ in range(N)]
    print('%-28s %s' % (label, vals))

# modal arm needs a fresh config each run
vals = []
for i in range(N):
    d = '/tmp/t381-modal-%d-%d' % (os.getpid(), i)
    os.makedirs(d, exist_ok=True)
    vals.append(arm_inject(argv, SETTLE_SHORT, SHORT, False, {'CLAUDE_CONFIG_DIR': d}))
print('%-28s %s' % ('SWALLOWED modal short', vals))

vals = []
for i in range(N):
    d = '/tmp/t381-modalspec-%d-%d' % (os.getpid(), i)
    os.makedirs(d, exist_ok=True)
    vals.append(arm_inject(argv, SETTLE_LONG, SPEC, True, {'CLAUDE_CONFIG_DIR': d}))
print('%-28s %s' % ('SWALLOWED modal spec', vals))
