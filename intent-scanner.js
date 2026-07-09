// Intent Scanner (port of wb-wrap/scanner.py). Turns one line of assistant
// output into a structured `[agent:…]` intent (or null). Pure string work — no
// Electron, no main.js state — so the grammar (dm/who/name/context/memory/
// spawn/file/resend + the `\[agent:` escape) is unit-testable in isolation.
// Seam: plain named functions on raw strings; the caller owns column-1
// anchoring by feeding it a single line at a time.
// Gotcha: cleanLine strips a leading run of DECORATOR glyphs (bullets, box
// chars) the CLI prepends to rendered lines — parseIntent trims after, so a
// bulleted `• [agent:who]` still matches, but an INDENTED one won't (the
// leading space survives cleanLine only if it's not in PREFIX_CHARS — space IS,
// so indentation is also stripped here; column-1 enforcement is the caller's).

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
const PREFIX_CHARS = new Set(' \t\u2B24\u25CF\u2022\u25B6\u25B7\u25BA\u25B9\u25CB\u25CF\u25C9\u25CE\u25C6\u25C7\u25A0\u25A1\u25AA\u25AB\u2605\u2606\u2192\u27F6\u2500\u2501\u00B7\u2023\u2219\u226B\u00BB');

function cleanLine(line) {
  line = line.replace(ANSI_RE, '');
  let i = 0;
  while (i < line.length && PREFIX_CHARS.has(line[i])) i++;
  return line.slice(i);
}

function parseIntent(rawLine) {
  const cleaned = cleanLine(rawLine).trim();
  if (!cleaned) return null;

  // Escaped intent
  const escMatch = cleaned.match(/^\\(\[agent:.*)/);
  if (escMatch) return { type: 'escape', text: escMatch[1] };

  // Optional `urgent` flag bypasses the idle/cold-cache dm hold (see
  // shouldHoldDm). Old grammar `[agent:dm target]` is untouched — the flag
  // only matches as a separate word before the bracket.
  const dmMatch = cleaned.match(/^\[agent:dm\s+(\S+?)(\s+urgent)?\]\s*(.*)/s);
  if (dmMatch) return { type: 'dm', target: dmMatch[1], urgent: !!dmMatch[2], body: dmMatch[3] };

  // Escalate a parked-on-hold dm: deliver the parked COPY now, without the
  // sender re-emitting the body. Protocol-invisible (not in IPC_PROMPT) — the
  // id only exists once a park happens, and the park notice hands the sender the
  // exact `[agent:resend <id>]` incantation. Id is the short base36 handle minted
  // at park time (see _mintParkId).
  const resendMatch = cleaned.match(/^\[agent:resend\s+([a-z0-9]+)\]\s*$/i);
  if (resendMatch) return { type: 'resend', id: resendMatch[1].toLowerCase() };

  if (/^\[agent:who\]\s*$/.test(cleaned)) return { type: 'who' };

  if (/^\[agent:name\]\s*$/.test(cleaned)) return { type: 'name' };

  // Grouped-grammar self/system intents (spec §12): one top-level verb per
  // CATEGORY, dispatched on a sub-command — keeps the namespace small and the
  // IPC_PROMPT lean (one documented line per category, not per operation).
  // `context` = the context-lifecycle set (compact|clear|reload). compact (and,
  // later, reload) may carry an OPTIONAL continuation/handoff body after the
  // bracket — native /compact parks waiting for input, so a self-fired compact
  // injects this body afterwards to keep working (clear ignores any body). The
  // col-1 `^` anchor still rejects backticked/inline mentions; only a genuinely
  // bare emission reaches here, so allowing trailing text doesn't weaken the
  // guardrail. Body capture (incl. multi-line) is in _scanJsonlText, like dm.
  const ctxMatch = cleaned.match(/^\[agent:context\s+(\S+)\]\s*(.*)/s);
  if (ctxMatch) return { type: 'context', sub: ctxMatch[1].toLowerCase(), body: ctxMatch[2] };

  // `memory` = the memory-management set (list|remember|recall). Carries a body
  // (the unit text for remember; the id/query for recall; empty for list) —
  // captured like dm, including multi-line bodies (see _scanJsonlText).
  const memMatch = cleaned.match(/^\[agent:memory\s+(\S+)\]\s*(.*)/s);
  if (memMatch) return { type: 'memory', sub: memMatch[1].toLowerCase(), body: memMatch[2] };

  // `spawn` = mint a NEW persistent top-level peer session (own socket / DM /
  // memory / registry) from inside a running agent. `name` + `cwd` are the only
  // required args; type/workspace/proxy inherit the spawner and everything else
  // takes clodex defaults (see _handleSpawnIntent). New noun (a persistent peer)
  // = a genuinely new category, so it earns its own top-level verb. Structural
  // creation (sessions.json / sockets / registry) is clodex's job; prompt CONTENT
  // deliberately stays out of the grammar (deferred, see spec Piece 2).
  // `file` = surface a file on the operator's SCREEN (view = Clodex's peek
  // modal over the session's workspace window, open = the default local app
  // via shell.openPath). Path may contain spaces — everything between the
  // sub-command and the closing bracket. Vetting (cwd-anchored realpath,
  // regular-file, no-launchables for open) lives in vetFileIntent; the
  // scanner only parses.
  const fileMatch = cleaned.match(/^\[agent:file\s+(\S+)\s+(.+?)\]\s*$/);
  if (fileMatch) return { type: 'file', sub: fileMatch[1].toLowerCase(), path: fileMatch[2].trim() };

  const spawnMatch = cleaned.match(/^\[agent:spawn\s+(.+)\]\s*$/);
  if (spawnMatch) {
    const argstr = spawnMatch[1];
    const nameM = argstr.match(/\bname:(\S+)/);
    const cwdM = argstr.match(/\bcwd:(\S+)/);
    return {
      type: 'spawn',
      name: nameM ? nameM[1] : null,
      cwd: cwdM ? cwdM[1] : null,
    };
  }

  return null;
}

// Stable identity of one intent occurrence for the wire-vs-jsonl shadow
// differ (both paths see the same assistant text, so the same intent hashes
// to the same key on both sides). Body capped so a huge dm doesn't bloat
// the shadow log's keys.
function shadowIntentKey(agent, intent) {
  // urgent is part of the identity: a held dm RESENT with the flag inside the
  // dedupe TTL must dispatch, not be swallowed as a duplicate of the bounce.
  const head = (intent.sub || intent.target || intent.name || intent.id || '') + (intent.urgent ? '+urgent' : '');
  const body = (intent.body || intent.path || '').trim().slice(0, 200);
  return `${agent}|${intent.type}|${head}|${body}`;
}

module.exports = { ANSI_RE, PREFIX_CHARS, cleanLine, parseIntent, shadowIntentKey };
