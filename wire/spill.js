'use strict';

const {
  SPILL_MIN_BYTES, SPILL_MAX_BYTES, HEAD_RE, validAgent, writeSpill: defaultWriteSpill, mimicKindOf, pointerText,
} = require('../intent-spill');
const { cleanLine } = require('../intent-scanner');
const { titleLine, ticketTitle } = require('../tickets-store');

const TERMINATOR = '[agent:end]';
const OPEN = '[agent:';
const MIMIC_LINE_CAP = 1024;

function couldBeHead(s) {
  return OPEN.startsWith(s.slice(0, OPEN.length)) || s.startsWith(OPEN);
}

class SpillFilter {
  constructor(opts = {}) {
    this.agent = opts.agent || null;
    this.root = opts.root || null;
    this.verbs = new Set(opts.verbs || []);
    this.minBytes = Number.isFinite(opts.minBytes) ? opts.minBytes : SPILL_MIN_BYTES;
    this.maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : SPILL_MAX_BYTES;
    this.onSpill = typeof opts.onSpill === 'function' ? opts.onSpill : null;
    this.onBail = typeof opts.onBail === 'function' ? opts.onBail : null;
    this.onMimic = typeof opts.onMimic === 'function' ? opts.onMimic : null;
    this._write = typeof opts.writeSpill === 'function' ? opts.writeSpill : defaultWriteSpill;
    this.intentSpills = (opts.intentSpills && typeof opts.intentSpills.count === 'number') ? opts.intentSpills : null;

    this.proseSpill = opts.proseSpill === true;

    this.passthru = !validAgent(this.agent);
    this.listenerFailed = false;

    this.lineBuf = '';
    this.lineSkip = false;
    this.tail = '';
    this.foreignBody = false;
    this.pending = '';
    this.holding = false;
    this.head = '';
    this.rawRest = '';
    this.headBodyCount = 0;
    this.verb = null;
    this.body = [];
    this.bodyLen = 0;
    this._fired = 0;
  }

  get fired() { return this._fired; }

  get latched() { return this.passthru; }

  _notify(fn, info) {
    if (!fn) return;
    try { fn(info); } catch { this.listenerFailed = true; }
  }

  _observe(text) {
    if (!this.onMimic) return;
    let s = this.lineBuf + text;
    for (;;) {
      const nl = s.indexOf('\n');
      if (nl === -1) break;
      if (!this.lineSkip) this._mimic(s.slice(0, nl));
      this.lineSkip = false;
      s = s.slice(nl + 1);
    }
    if (s.length > MIMIC_LINE_CAP) { this.lineSkip = true; s = ''; }
    this.lineBuf = s;
  }

  _mimic(line) {
    const kind = mimicKindOf(line);
    if (kind) this._notify(this.onMimic, { kind });
  }

  _shadow(partial) {
    if (!this.onMimic || this.lineSkip) return;
    const s = this.lineBuf + partial;
    if (s.length > MIMIC_LINE_CAP) { this.lineSkip = true; this.lineBuf = ''; return; }
    this.lineBuf = s;
  }

  _mimicLine(line) {
    if (this.onMimic && !this.lineSkip && !this.holding && !this.foreignBody) this._mimic(this.lineBuf + line);
    this.lineBuf = '';
    this.lineSkip = false;
  }

  _latch(rest) {
    this.lineBuf = '';
    this.lineSkip = rest.length > 0 && !rest.endsWith('\n');
    this.pending = '';
    this.passthru = true;
  }

  feed(text) {
    if (this.passthru) {
      this._observe(text);
      return text;
    }
    const out = [];
    this.pending += text;
    for (;;) {
      if (this.holding
          && this.bodyLen + Buffer.byteLength(this.pending, 'utf8') > this.maxBytes) {
        out.push(this.originalHeld());
        out.push(this.pending);
        this._clear();
        this._latch(this.pending);
        const capped = this.verb;
        this.verb = null;
        this._notify(this.onBail, { reason: 'cap', verb: capped });
        return out.join('');
      }
      if (this.proseSpill && !this.holding
          && Buffer.byteLength(this.tail, 'utf8')
             + Buffer.byteLength(this.pending, 'utf8') > this.maxBytes) {
        out.push(this.tail);
        out.push(this.pending);
        this.tail = '';
        this._latch(this.pending);
        this._notify(this.onBail, { reason: 'cap', verb: null });
        return out.join('');
      }
      const nl = this.pending.indexOf('\n');
      if (nl === -1) {
        if (couldBeHead(this.pending)
            && Buffer.byteLength(this.pending, 'utf8') > this.maxBytes) {
          out.push(this.tail);
          this.tail = '';
          out.push(this.pending);
          this._latch(this.pending);
          this._notify(this.onBail, { reason: 'cap', verb: null });
          return out.join('');
        }
        break;
      }
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this._mimicLine(line);
      out.push(this._line(line));
      if (this.passthru) {
        out.push(this.pending);
        this._latch(this.pending);
        return out.join('');
      }
    }
    if (this.pending && !this.holding && !this.proseSpill && !couldBeHead(this.pending)) {
      this._shadow(this.pending);
      out.push(this.pending);
      this.pending = '';
    }
    return out.join('');
  }

  _flushTail() {
    const t = this.tail;
    this.tail = '';
    return t;
  }

  _line(line) {
    if (this.holding) {
      if (line.trim() === TERMINATOR) return this._resolve() + line + '\n';
      if (cleanLine(line).startsWith(OPEN)) {
        const held = this.originalHeld();
        this._clear();
        this.passthru = true;
        const nested = this.verb;
        this.verb = null;
        this._notify(this.onBail, { reason: 'nested-intent', verb: nested });
        return held + line + '\n';
      }
      this.body.push(line);
      this.bodyLen += Buffer.byteLength(line, 'utf8') + 1;
      return '';
    }

    const m = HEAD_RE.exec(line);
    const key = m
      ? (this.verbs.has(m[1]) ? m[1] : (m[2] ? `${m[1]}.${m[2]}` : m[1]))
      : null;
    if (m && this.verbs.has(key)) {
      const flushed = this.proseSpill ? this._flushTail() : '';
      this.foreignBody = false;
      const cut = m[0].length;
      this.holding = true;
      this.verb = key;
      this.head = line.slice(0, cut);
      this.rawRest = line.slice(cut);
      const rest = this.rawRest.trim();
      this.body = rest ? [rest] : [];
      this.headBodyCount = this.body.length;
      this.bodyLen = Buffer.byteLength(rest, 'utf8');
      return flushed;
    }
    if (this.proseSpill) {
      const cleaned = cleanLine(line).trim();
      if (cleaned.startsWith(`\\${OPEN}`)) {
        return this._flushTail() + line + '\n';
      }
      if (cleaned.startsWith(OPEN)) {
        this.foreignBody = cleaned !== TERMINATOR;
        return this._flushTail() + line + '\n';
      }
      if (this.foreignBody) return `${line}\n`;
      this.tail += `${line}\n`;
      return '';
    }
    const cleaned = cleanLine(line).trim();
    if (cleaned.startsWith(OPEN)) this.foreignBody = cleaned !== TERMINATOR;
    return line + '\n';
  }

  _bodyText() {
    let end = this.body.length;
    while (end > this.headBodyCount && !this.body[end - 1].trim()) end -= 1;
    return this.body.slice(0, end).join('\n');
  }

  originalHeld() {
    if (!this.holding) return '';
    const tail = this.body.slice(this.headBodyCount);
    return `${this.head}${this.rawRest}\n${tail.map((l) => `${l}\n`).join('')}`;
  }

  _clear() {
    this.holding = false;
    this.head = '';
    this.rawRest = '';
    this.headBodyCount = 0;
    this.body = [];
    this.bodyLen = 0;
  }

  _resolve() {
    const bodyText = this._bodyText();
    const head = this.head;
    const verb = this.verb;
    const bytes = Buffer.byteLength(bodyText, 'utf8');
    if (bytes > this.minBytes && this.intentSpills && this.intentSpills.count < 2) {
      this.intentSpills.count += 1;
    } else if (bytes > this.minBytes) {
      let id = null;
      try { id = this._write(this.root, this.agent, bodyText); } catch { id = null; }
      if (id) {
        this._clear();
        this.verb = null;
        this._fired += 1;
        const words = head.slice(OPEN.length, -1).trim().replace(/\s+/g, ' ');
        this._notify(this.onSpill, { verb, id, bytes, head: words });
        const first = titleLine(bodyText);
        const title = (first && first !== bodyText.trim()) ? `${ticketTitle(bodyText)} — ` : '';
        return `${head} ${title}${pointerText(id, { root: this.root, agent: this.agent, bytes })}\n`;
      }
    }
    const held = this.originalHeld();
    this._clear();
    this.verb = null;
    return held;
  }

  _resolveTail() {
    const text = this._flushTail();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= this.minBytes) return text;
    let id = null;
    try { id = this._write(this.root, this.agent, text); } catch { id = null; }
    if (!id) return text;
    this._fired += 1;
    this._notify(this.onSpill, { verb: 'prose', id, bytes, head: null });
    return `${pointerText(id, { root: this.root, agent: this.agent, bytes, prose: true })}\n`;
  }

  endBlock() {
    let out = '';
    if (!this.holding && this.pending) this._shadow(this.pending);
    if (this.holding && this.pending.trim() === TERMINATOR && this.pending.indexOf('\n') === -1) {
      const last = this.pending;
      this.pending = '';
      out += this._resolve() + last;
    }
    if (this.holding) {
      out += this.originalHeld();
      this._clear();
      this.verb = null;
    } else if (this.proseSpill && !this.foreignBody && !couldBeHead(this.pending)) {
      this.tail += this.pending;
      this.pending = '';
    }
    if (this.pending) {
      out += this._flushTail() + this.pending;
      this.pending = '';
    }
    return out;
  }

  close() {
    let out = '';
    this._mimicLine(this.pending);
    if (this.holding && this.pending.trim() === TERMINATOR && this.pending.indexOf('\n') === -1) {
      const last = this.pending;
      this.pending = '';
      out += this._resolve() + last;
    }
    if (this.holding) {
      out += this.originalHeld();
      this._clear();
      this.verb = null;
    } else if (this.proseSpill) {
      if (!this.foreignBody && !couldBeHead(this.pending)) {
        this.tail += this.pending;
        this.pending = '';
      }
      out += this._resolveTail();
    }
    out += this._flushTail();
    if (this.pending) {
      out += this.pending;
      this.pending = '';
    }
    return out;
  }

  bail() {
    this.proseSpill = false;
    const out = this.close();
    this.passthru = true;
    return out;
  }
}

function deltaEvent(index, text) {
  return Buffer.from(`event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta', index, delta: { type: 'text_delta', text },
  })}\n\n`, 'utf8');
}

function dataOf(evText) {
  for (const ln of evText.split('\n')) {
    if (!ln.startsWith('data:')) continue;
    try { return JSON.parse(ln.slice(5)); } catch { return null; }
  }
  return null;
}

class SpillTee {
  constructor(opts = {}) {
    this.filter = new SpillFilter(opts);
    this.onBail = typeof opts.onBail === 'function' ? opts.onBail : null;
    this.buf = Buffer.alloc(0);
    this.index = 0;
    this.dead = false;
    this.heldRaw = [];
    this.heldSrc = '';
    this.heldOut = '';
    this.heldStopAt = -1;
  }

  get fired() { return this.filter.fired; }

  get latched() { return this.dead || this.filter.latched; }

  _flushHeld(out) {
    const cut = this.heldStopAt === -1 ? this.heldRaw.length : this.heldStopAt;
    if (!cut) {
      if (this.heldOut) out.push(deltaEvent(this.index, this.heldOut));
    } else if (this.heldOut === this.heldSrc) {
      for (let i = 0; i < cut; i += 1) out.push(this.heldRaw[i]);
    } else if (this.heldOut) {
      out.push(deltaEvent(this.index, this.heldOut));
    }
    for (let i = cut; i < this.heldRaw.length; i += 1) out.push(this.heldRaw[i]);
    this.heldRaw = [];
    this.heldSrc = '';
    this.heldOut = '';
    this.heldStopAt = -1;
  }

  _panic(out, e) {
    this.dead = true;
    try { this.heldOut += this.filter.bail(); } catch { this.filter.passthru = true; }
    if (this.heldRaw.length && this.heldOut.length <= this.heldSrc.length) {
      for (const r of this.heldRaw) out.push(r);
      this.heldRaw = [];
      this.heldSrc = '';
      this.heldOut = '';
      this.heldStopAt = -1;
    } else {
      this._flushHeld(out);
    }
    if (this.buf.length) { out.push(this.buf); this.buf = Buffer.alloc(0); }
    if (this.onBail) {
      try { this.onBail({ reason: 'error', error: (e && e.message) || String(e) }); } catch { this.dead = true; }
    }
    return Buffer.concat(out);
  }

  feed(chunk) {
    if (this.dead) return chunk;
    const out = [];
    try {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      for (;;) {
        const iLf = this.buf.indexOf('\n\n');
        const iCrlf = this.buf.indexOf('\r\n\r\n');
        let cut;
        let blen;
        if (iCrlf !== -1 && (iLf === -1 || iCrlf < iLf)) { cut = iCrlf; blen = 4; } else if (iLf !== -1) { cut = iLf; blen = 2; } else {
          if (this.buf.length > this.filter.maxBytes) {
            this.dead = true;
            this.heldOut += this.filter.bail();
            this._flushHeld(out);
            out.push(this.buf);
            this.buf = Buffer.alloc(0);
            if (this.onBail) {
              try { this.onBail({ reason: 'frame-cap' }); } catch { this.dead = true; }
            }
          }
          break;
        }
        const raw = this.buf.slice(0, cut + blen);
        this.buf = this.buf.slice(cut + blen);
        const d = dataOf(raw.toString('utf8'));
        if (d && d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') {
          if (this.heldStopAt !== -1) this._flushHeld(out);
          if (typeof d.index === 'number') this.index = d.index;
          const src = typeof d.delta.text === 'string' ? d.delta.text : '';
          const before = this.filter.fired;
          this.heldRaw.push(raw);
          this.heldSrc += src;
          this.heldOut += this.filter.feed(src);
          if (this.filter.fired !== before || this.heldOut === this.heldSrc) this._flushHeld(out);
          continue;
        }
        if (this.filter.proseSpill) {
          if (d && d.type === 'content_block_start') {
            const isText = !!(d.content_block && d.content_block.type === 'text');
            if (!isText) this.heldOut += this.filter._flushTail();
            this._flushHeld(out);
            if (isText && typeof d.index === 'number') this.index = d.index;
            out.push(raw);
            continue;
          }
          if (d && d.type === 'content_block_stop') {
            const before = this.filter.fired;
            this.heldOut += this.filter.endBlock();
            this.heldRaw.push(raw);
            if (this.heldStopAt === -1) this.heldStopAt = this.heldRaw.length - 1;
            if (this.filter.fired !== before) this._flushHeld(out);
            continue;
          }
          if (d && d.type === 'ping') {
            out.push(raw);
            continue;
          }
          if (this.heldStopAt !== -1) {
            this.heldRaw.push(raw);
            continue;
          }
          out.push(raw);
          continue;
        }
        if (d && d.type === 'content_block_stop') {
          this.heldOut += this.filter.close();
          this._flushHeld(out);
        }
        out.push(raw);
      }
    } catch (e) {
      return this._panic(out, e);
    }
    return out.length ? Buffer.concat(out) : Buffer.alloc(0);
  }

  close() {
    if (this.dead) return Buffer.alloc(0);
    const out = [];
    try {
      this.heldOut += this.filter.close();
      this._flushHeld(out);
      if (this.buf.length) { out.push(this.buf); this.buf = Buffer.alloc(0); }
    } catch (e) {
      return this._panic(out, e);
    }
    return out.length ? Buffer.concat(out) : Buffer.alloc(0);
  }
}

module.exports = { SpillFilter, SpillTee, HEAD_RE };
