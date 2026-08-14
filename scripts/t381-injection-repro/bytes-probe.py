#!/usr/bin/env python3
"""What EXACTLY does the CLI emit in the settle window, in each state?

Byte counts alone would make any threshold a magic number. Print the raw bytes.
Also measures the BUSY case: a seat mid-turn streams output constantly, which
would swamp a presence-of-output signal.
"""
import os, pty, sys, time, select, fcntl, termios, struct, re

PASTE_START = '\x1b[200~'
PASTE_END = '\x1b[201~'

def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

def drain(fd, seconds, sink):
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
            sink.append(d)
    return b''.join(sink)

def boot(env_extra=None):
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
        os.execvp('claude', ['claude'])
    set_size(fd, 40, 100)
    drain(fd, 12, [])
    return pid, fd

def kill(pid, fd):
    try:
        os.kill(pid, 9); os.waitpid(pid, 0); os.close(fd)
    except Exception:
        pass

def inject(fd, text, paste, settle):
    os.write(fd, b'\x15')
    time.sleep(0.030)
    drain(fd, 0.040, [])          # flush the Ctrl-U redraw: a 0.0 window reads NOTHING
    out = text.replace('\n', '\r')
    if paste:
        out = PASTE_START + out + PASTE_END
    os.write(fd, out.encode())
    return drain(fd, settle, [])

SHORT = 'say PINEAPPLE'

print('=== HEALTHY idle composer, short text ===')
pid, fd = boot(); drain(fd, 1.0, [])
print(repr(inject(fd, SHORT, False, 0.050)))
kill(pid, fd)

print()
print('=== SWALLOWED modal, short text (expect EMPTY) ===')
d = '/tmp/t381-bp-%d' % os.getpid(); os.makedirs(d, exist_ok=True)
pid, fd = boot({'CLAUDE_CONFIG_DIR': d}); drain(fd, 1.0, [])
print(repr(inject(fd, SHORT, False, 0.050)))
kill(pid, fd)

print()
print('  (empty is the finding: a swallowed injection produces NO echo at all.')
print('   The 4 bytes reported before this probe fixed its dead flush were the')
print('   Ctrl-U redraw leaking into the window, not anything the text did.)')
print()
print('=== BUSY seat (mid-turn), NO WRITE -- baseline only ===')
pid, fd = boot(); drain(fd, 1.0, [])
# start a long turn
os.write(fd, b'\x15'); time.sleep(0.03)
os.write(fd, b'count slowly from 1 to 40, one number per line')
time.sleep(0.05); os.write(fd, b'\r')
time.sleep(6)                       # it is now streaming
sink = []
busy_baseline = drain(fd, 0.050, sink)
print('BUSY baseline, NO write, 50ms window: %d bytes' % len(busy_baseline))
print('  sample:', repr(busy_baseline[:120]))
kill(pid, fd)
