#!/usr/bin/env python3
"""Does a real spec-sized, multi-line, bracketed-pasted injection ECHO verbatim?

If the CLI renders it as "[Pasted text #1 +N lines]", an echo-based pre-Enter
check is structurally unable to confirm the payload that actually matters.
"""
import os, pty, sys, time, select, fcntl, termios, struct, re

PASTE_START = '\x1b[200~'
PASTE_END = '\x1b[201~'

def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

def strip_ansi(s):
    s = re.sub(r'\x1b\][^\x07\x1b]*(\x07|\x1b\\)', '', s)
    s = re.sub(r'\x1b[@-Z\\-_]', '', s)
    s = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', s)
    return s

def drain(fd, buf, seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return
            if not d:
                return
            buf.append(d)

# a realistic spec: long, multi-line
SPEC = ('[ticket t999] tasks/some-task — a representative spec body\n'
        'WORK IN: /tmp/some/worktree (git worktree, branch t999-x)\n'
        'CLOSE WITH: [agent:task done t999] <report>\n'
        + '\n'.join('detail line %d with some substance to it, about this long' % i
                    for i in range(12))
        + '\nUNIQUE_SPEC_MARKER_ZQX\n')

argv = sys.argv[1:] or ['claude']
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    # Dropped in EVERY probe here: these run from inside a Claude seat,
    # and an inherited session env changes what the child does.
    # CLAUDE_CONFIG_DIR is EXEMPT from the drop: it is how this probe's modal arm
    # selects a fresh, un-onboarded config, and popping it turns the swallow case
    # back into a healthy composer -- measuring nothing while looking like a pass.
    _cfg = os.environ.get('CLAUDE_CONFIG_DIR')
    for _k in [_k for _k in os.environ if _k.startswith('CLAUDE')]:
        os.environ.pop(_k, None)
    os.environ.pop('CLAUDECODE', None)
    if _cfg:
        os.environ['CLAUDE_CONFIG_DIR'] = _cfg
    os.execvp(argv[0], argv)
set_size(fd, 40, 100)
buf = []
drain(fd, buf, 12)
mark = len(buf)

os.write(fd, b'\x15')
time.sleep(0.03)
out = SPEC.replace('\n', '\r')
out = PASTE_START + out + PASTE_END
os.write(fd, out.encode())
time.sleep(1.0)          # LONG_TEXT_DELAY
drain(fd, buf, 0.6)

tail = strip_ansi(b''.join(buf[mark:]).decode('utf-8', 'replace'))
print('len(SPEC) =', len(SPEC))
print('UNIQUE_SPEC_MARKER_ZQX echoed:', 'UNIQUE_SPEC_MARKER_ZQX' in tail)
print('first spec line echoed:', 'a representative spec body' in tail)
# The CLI's own redraw interleaves cursor moves between glyphs, so strip_ansi
# leaves "[Pastedtext#1+16lines]" with the spaces gone. Matching on spaced text
# silently reports False and inverts the finding -- allow optional whitespace.
placeholder = bool(re.search(r'Pasted\s*text|\+\s*\d+\s*lines', tail))
verbatim = 'UNIQUE_SPEC_MARKER_ZQX' in tail
print('rendered as Pasted-text placeholder:', placeholder)
# Why shape (b) cannot work for the payload that matters: a content check over the
# echo is blind to a spec, because the spec's text never reaches the screen.
print('FINDING a spec does NOT echo verbatim (so echo-matching is blind to it): %s'
      % (placeholder and not verbatim))
print('--- echo tail ---')
print(tail[-1800:])
try:
    os.kill(pid, 9); os.waitpid(pid, 0)
except Exception:
    pass
