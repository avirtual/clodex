"""Intent-body spill: replace a large greedy intent body on the wire with a
content-addressed pointer, and write the body to a file the consumer resolves.

Wire format contract: scratchpad/SPILL-WIRE-FORMAT.md (agreed with clodex
2026-09-19). The consumer builds the `@spill:<id>` resolver; we build this,
the response-side buffer.

WHY THIS IS A RESPONSE TRANSFORM. A clodex intent body is emitted by the model
into its ANSWER TEXT, and response text mutation is durable — it persists into
the CLI transcript (never touch thinking blocks, they're signed). So rewriting
the text_delta stream both delivers the pointer to the consumer's intent scanner
AND stops the body re-shipping as history carriage on every later turn. That
second half is the whole point: a 40 KB ticket spec pasted into a transcript is
re-read for the rest of the session.

THE ONE INVARIANT: a truncated task spec is worse than a spammy transcript.
Every failure mode forwards the ORIGINAL body untouched, and a pointer is only
ever emitted after the body is fully and durably on disk — write-then-rewrite,
never rewrite-then-write.
"""
import hashlib
import os
import re

# --- configuration (read at launch; both DIR and VERBS required to arm) -------
# The dir is a PARAMETER, not a hardcoded ~/.clodex/spill: the proxy should not
# bake a consumer's private layout in, and clodex passes the same constant to
# both the env we read and the root its resolver uses, so they cannot drift.
SPILL_DIR = os.environ.get("WIRESCOPE_SPILL_DIR") or None
SPILL_VERBS = frozenset(
    v.strip() for v in (os.environ.get("WIRESCOPE_SPILL_VERBS") or "").split(",")
    if v.strip())
SPILL_MIN_BYTES = int(os.environ.get("WIRESCOPE_SPILL_MIN_BYTES") or 800)
SPILL_MAX_BYTES = int(os.environ.get("WIRESCOPE_SPILL_MAX_BYTES") or 262144)

# Seat-name charset, mirroring clodex's own minting rule
# `^(?!\.+$)[a-zA-Z0-9._-]{1,64}$` (dots legal, `.hidden` deliberate, all-dots
# rejected). \Z not $: in Python `$` also matches before a trailing newline, so
# `$` would accept "ok\n" as a directory component. The route regex cannot
# produce one today — this is belt-and-braces on a value that becomes a path.
_AGENT_RE = re.compile(r"^(?!\.+\Z)[a-zA-Z0-9._-]{1,64}\Z")

# The DELIMITERS are configuration, not code. A durable ruling stands behind
# this (CLAUDE.md, WB_INTENT_DISPATCH retired 2026-06-12): "proxy-side
# app-specific intent parsing is gone ... No app-specific protocol parsing
# remains in the proxy." Hardcoding `[agent:` / `[agent:end]` would quietly
# overturn that for one consumer. So the proxy knows only the SHAPE — an opener
# token, a verb, a `]`, a body, a terminator line — and the consumer supplies
# its own tokens, exactly as it already supplies the verb vocabulary.
# No default: a grammar we default to is a grammar we ship.
SPILL_OPEN = os.environ.get("WIRESCOPE_SPILL_OPEN") or None      # e.g. "[agent:"
SPILL_END = os.environ.get("WIRESCOPE_SPILL_END") or None        # e.g. "[agent:end]"


def _head_re():
    """Opener + verb (+ optional sub-verb) + modifiers + ']'. Built per call so
    the tokens stay rebindable (tests and /_status read them live)."""
    if not SPILL_OPEN:
        return None
    return re.compile(re.escape(SPILL_OPEN)
                      + r"([a-z]+)(?:\s+([a-z-]+))?\b([^\]]*)\]")


def enabled():
    """All four knobs required. Absent = today's behaviour, no path differs."""
    return bool(SPILL_DIR and SPILL_VERBS and SPILL_OPEN and SPILL_END)


def _verb_key(m):
    """('task','add') -> 'task.add'; a one-word verb -> 'notify-user'."""
    head, sub = m.group(1), m.group(2)
    return f"{head}.{sub}" if sub else head


def valid_agent(name):
    return bool(name) and bool(_AGENT_RE.match(name))


def spill_body(agent, body):
    """Write `body` (str) under <root>/<agent>/<id>.md. Returns the id, or None
    if anything at all went wrong — callers MUST forward the original body on
    None. Content-addressed, so a re-emitted identical body (retry, --resume)
    resolves to the same file; an existing file is left alone rather than
    rewritten, which also removes any torn-read window.

    Synchronous on purpose: the pointer may not be emitted before these bytes
    are durable, so this cannot be handed to the writer thread. Files are small
    (<= SPILL_MAX_BYTES) and spills are rare.
    """
    if not enabled() or not valid_agent(agent):
        return None
    try:
        raw = body.encode("utf-8")
        sid = hashlib.sha256(raw).hexdigest()[:16]
        d = os.path.join(SPILL_DIR, agent)
        os.makedirs(d, mode=0o700, exist_ok=True)
        final = os.path.join(d, f"{sid}.md")
        if os.path.exists(final):
            return sid                      # identical content already durable
        tmp = f"{final}.tmp-{os.getpid()}"
        with open(tmp, "wb") as fh:
            fh.write(raw)
            fh.flush()
            # NOT covered by any test: no in-process check can observe an fsync
            # (it only matters across power loss). It is here because the
            # pointer outlives this process and the body must too.
            os.fsync(fh.fileno())           # durable BEFORE the pointer exists
        os.replace(tmp, final)
        return sid
    except Exception:
        return None                         # never lose a spec to an IO error


class _SpillFilter:
    """Line-oriented state machine over an intent-bearing text stream.

    PASS: text flows through untouched. A partial trailing line is held back
    ONLY while it could still become an `[agent:` head line, so ordinary prose
    streams with zero added latency.

    HOLD: a listed verb's head line was seen; the body accumulates until the
    `[agent:end]` line. On close we emit `<head>] @spill:<id>` — or, on any
    failure or overflow, the original bytes.
    """

    def __init__(self, agent):
        self.agent = agent
        self.pending = ""        # incomplete trailing line
        self.holding = False
        self.head = ""           # the head line, preserved byte-for-byte
        self.body = []           # body lines, in order
        self.body_len = 0
        # Set once a body blows the cap, never unset. DELIBERATE: after a
        # bail-out we have already emitted bytes the line scanner never
        # consumed, so resynchronising it against the remainder is what
        # corrupted `[agent:end]` into `[ag\nent:end]`. The cost is that a
        # LATER, in-cap intent in the same response forwards whole instead of
        # spilling — no spec is lost, only the saving, on a response that
        # already contains a >256 KiB body. Correctness over the last increment.
        self.passthru = False
        self.fired = 0           # pointers emitted; counted where the decision is

    # A partial line is only interesting while it could still become an opener.
    @staticmethod
    def _could_be_head(s):
        op = SPILL_OPEN or ""
        return bool(op) and (op.startswith(s[:len(op)]) or s.startswith(op))

    def feed(self, text):
        if self.passthru:           # a body blew the cap: verbatim, forever
            return text
        out = []
        self.pending += text
        while True:
            # The cap is enforced on HELD bytes BEFORE consuming a line: a body
            # is very often ONE long line, so a per-line check both fires too
            # late (the line is already fully buffered) and never fires
            # mid-line, and the oversized body spills anyway (test, 2026-09-19).
            if self.holding \
                    and self.body_len + len(self.pending.encode("utf-8")) > SPILL_MAX_BYTES:
                # Bail out: emit the head, everything held, and the partial line
                # exactly as received — no added newline, since the source one
                # has not arrived. Then stop filtering for the REST OF THIS
                # RESPONSE rather than trying to resynchronise a line scanner
                # against bytes we have already emitted (that desync corrupted
                # `[agent:end]` into `[ag\nent:end]` before this was simplified).
                # `body` holds COMPLETED lines with their newlines stripped by
                # the split, so restore the terminator for each; `pending` is
                # the partial line whose newline has genuinely not arrived.
                held = self.head + " " + "".join(l + "\n" for l in self.body)
                out.append(held)
                out.append(self.pending)
                self.passthru = True
                self.holding, self.head, self.body, self.body_len = False, "", [], 0
                self.pending = ""
                return "".join(out)
            if "\n" not in self.pending:
                break
            line, self.pending = self.pending.split("\n", 1)
            out.append(self._line(line))
        # Flush the partial tail unless it might still become a head line, or we
        # are mid-body (where everything is held by definition).
        if self.pending and not self.holding and not self._could_be_head(self.pending):
            out.append(self.pending)
            self.pending = ""
        return "".join(out)

    def _line(self, line):
        if self.holding:
            if line.strip() == SPILL_END:
                return self._resolve() + line + "\n"
            self.body.append(line)
            self.body_len += len(line.encode("utf-8")) + 1
            return ""       # the cap is enforced in feed(), on held bytes

        hre = _head_re()
        m = hre.match(line) if hre else None
        if m and _verb_key(m) in SPILL_VERBS:
            self.holding = True
            cut = m.end()                       # index just past the ']'
            self.head = line[:cut]
            rest = line[cut:]
            if rest.startswith(" "):            # skip EXACTLY one space
                rest = rest[1:]
            self.body = [rest] if rest else []
            self.body_len = len(rest.encode("utf-8"))
            return ""
        return line + "\n"

    def _body_text(self):
        return "\n".join(self.body)

    def _flush_original(self, newline=True):
        """Emit the head line and everything held, untouched.

        `newline=False` for a MID-LINE overflow flush: the source newline has
        not arrived yet, so adding one would corrupt the very body we are
        bailing out to preserve.
        """
        if not self.head:
            return ""
        s = self.head + " " + self._body_text() + ("\n" if newline else "")
        self.holding = False
        self.head, self.body, self.body_len = "", [], 0
        return s

    def _resolve(self):
        """End of a held body: spill it, or forward it unchanged."""
        body = self._body_text()
        head = self.head
        # Strict '>' on the UTF-8 bytes of exactly what a recipient will read.
        if len(body.encode("utf-8")) > SPILL_MIN_BYTES:
            sid = spill_body(self.agent, body)
            if sid:
                self.holding = False
                self.head, self.body, self.body_len = "", [], 0
                self.fired += 1
                return f"{head} @spill:{sid}\n"
        return self._flush_original()

    def close(self):
        """Stream end. An unterminated body is held text that must not vanish."""
        out = ""
        if self.holding:
            out += self._flush_original()
        if self.pending:
            out += self.pending
            self.pending = ""
        return out


class SpillTee:
    """Chunk-in / chunk-out SSE filter: rewrites `text_delta` events through a
    _SpillFilter and passes every other event through untouched.

    Only text_delta is touched. `thinking_delta` is a different event type, so
    signed thinking blocks are structurally out of reach here rather than merely
    avoided by convention.
    """

    def __init__(self, agent):
        self.f = _SpillFilter(agent)
        self.buf = bytearray()
        self.index = 0

    @staticmethod
    def _data_of(ev_text):
        for ln in ev_text.split("\n"):
            if ln.startswith("data:"):
                try:
                    import json
                    return json.loads(ln[5:].strip())
                except Exception:
                    return None
        return None

    def _delta_event(self, index, text):
        import json
        return ("event: content_block_delta\ndata: " + json.dumps(
            {"type": "content_block_delta", "index": index,
             "delta": {"type": "text_delta", "text": text}}) + "\n\n").encode("utf-8")

    def feed(self, chunk):
        """Return the (possibly rewritten) bytes to forward to the client."""
        if not enabled():
            return chunk            # not armed: never parse, never re-chunk
        out = bytearray()
        self.buf.extend(chunk)
        while True:
            i_lf, i_crlf = self.buf.find(b"\n\n"), self.buf.find(b"\r\n\r\n")
            if i_crlf != -1 and (i_lf == -1 or i_crlf < i_lf):
                cut, blen = i_crlf, 4
            elif i_lf != -1:
                cut, blen = i_lf, 2
            else:
                break
            raw = bytes(self.buf[:cut + blen])
            del self.buf[:cut + blen]
            d = self._data_of(raw.decode("utf-8", "replace"))
            if d and d.get("type") == "content_block_delta" \
                    and (d.get("delta") or {}).get("type") == "text_delta":
                self.index = d.get("index", self.index)
                src = d["delta"].get("text", "")
                txt = self.f.feed(src)
                if txt == src:
                    # Unchanged: forward the ORIGINAL bytes rather than a
                    # re-serialized copy. Re-encoding every delta would alter the
                    # wire (key spacing, dropped fields) on 100% of traffic to
                    # buy nothing on the ~0% that spills.
                    out.extend(raw)
                elif txt:
                    out.extend(self._delta_event(self.index, txt))
                continue
            if d and d.get("type") == "content_block_stop":
                tail = self.f.close()           # held text cannot outlive its block
                if tail:
                    out.extend(self._delta_event(self.index, tail))
            out.extend(raw)
        return bytes(out)

    @property
    def fired(self):
        """Pointers emitted this stream (observability)."""
        return self.f.fired

    def close(self):
        """Stream end (incl. an upstream drop mid-stream): nothing held is lost."""
        out = bytearray()
        tail = self.f.close()
        if tail:
            out.extend(self._delta_event(self.index, tail))
        if self.buf:                            # unterminated trailing event
            out.extend(bytes(self.buf))
            self.buf.clear()
        return bytes(out)
