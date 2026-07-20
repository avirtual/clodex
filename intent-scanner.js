// Intent Scanner (port of wb-wrap/scanner.py). Turns one line of assistant
// output into a structured `[agent:…]` intent (or null). Pure string work — no
// Electron, no main.js state — so the grammar (dm/who/name/context/memory/
// spawn/file/resend/exec/remind/notify-user/team-review/review-done/task/reboot
// + the `\[agent:` escape) is unit-testable in isolation.
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

  // `end` = explicit body TERMINATOR, the only intent that IS nothing: it
  // closes an open multi-line body capture (dm/memory/remind/notify-user/…)
  // and is then discarded — _extractIntents never emits it and _handleIntent
  // never sees it. Exists because free-text bodies otherwise run to the next
  // intent or end of turn, so an agent could not write operator prose AFTER
  // a body (the prose was swallowed into the message — observed live on a
  // memory-remember). Bare-only like who/name: trailing text would be
  // ambiguous (body? prose?), so it doesn't parse.
  if (/^\[agent:end\]\s*$/.test(cleaned)) return { type: 'end' };

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

  // `exec` = fire-and-forget invocation of an OPERATOR-REGISTERED command by id
  // (registry lives at ~/.clodex/library/exec/<cmd>.json; agents cannot register
  // one). `cmd` names the command; the body is the JSON DATA payload, captured
  // to the next col-1 intent exactly like dm/memory (multi-line — see
  // _extractIntents' allow-set, which exec MUST join or the JSON truncates at the
  // first newline). The payload is DATA only: it reaches the command via stdin,
  // NEVER spliced into argv — argv comes wholly from the registry entry, so the
  // shell-injection class is gone by construction. Registered-only; there is no
  // arbitrary-shell variant.
  const execMatch = cleaned.match(/^\[agent:exec\s+(\S+)\]\s*(.*)/s);
  if (execMatch) return { type: 'exec', cmd: execMatch[1], body: execMatch[2] };

  // `remind` = schedule a SELF-reminder (see remind-schedule.js for the spec
  // grammar: every|in|at|cron|on compact|list|cancel). Unlike every other
  // intent the SPEC spans a space (`every 30m`, `on compact`, `at 09:00`), so
  // it's captured as everything up to the closing bracket ([^\]]+, not \S+);
  // the reminder text is the body, captured to the next col-1 intent exactly
  // like dm (multi-line — remind MUST join _extractIntents' allow-set or the
  // text truncates at the first newline). Parse/validation of the spec lives in
  // remind-schedule.parseRemindSpec, invoked by the handler, not here.
  const remindMatch = cleaned.match(/^\[agent:remind\s+([^\]]+)\]\s*(.*)/s);
  if (remindMatch) return { type: 'remind', spec: remindMatch[1].trim(), body: remindMatch[2] };

  // `notify-user` = raise a note into the operator's persistent inbox to get
  // Bogdan's attention when the agent is blocked on his decision. No
  // sub-command, no target — the whole thing is a free-text body, captured to
  // the next col-1 intent like dm (multi-line — notify-user MUST join
  // _extractIntents' allow-set or the body truncates at the first newline). The
  // empty-body bounce + 16KB cap live in the handler, not here.
  const notifyMatch = cleaned.match(/^\[agent:notify-user\]\s*(.*)/s);
  if (notifyMatch) return { type: 'notify-user', body: notifyMatch[1] };

  // `team-review` / `review-done` = the ephemeral cold-review handshake (Task
  // 24). A team LEAD writes ONLY the review scope (`[agent:team-review] <scope>`)
  // and clodex owns the machinery (spawn an ephemeral reviewer seat, brief it,
  // inject the scope); the reviewer ends its pass with `[agent:review-done]
  // <verdict>`, which clodex routes back to the lead and then retires the seat.
  // Both carry a free-text body captured to the next col-1 intent exactly like dm
  // (multi-line — both MUST join _extractIntents' allow-set or the body truncates
  // at the first newline). Sender-role guards (lead-only / reviewer-only) + the
  // spawn/retire lifecycle live in the handler, not here.
  const teamReviewMatch = cleaned.match(/^\[agent:team-review\]\s*(.*)/s);
  if (teamReviewMatch) return { type: 'team-review', body: teamReviewMatch[1] };

  const reviewDoneMatch = cleaned.match(/^\[agent:review-done\]\s*(.*)/s);
  if (reviewDoneMatch) return { type: 'review-done', body: reviewDoneMatch[1] };

  // `reboot` = operator-gated full app relaunch (Task 27). Bodyless-or-body like
  // notify-user: the optional body is a free-text REASON (logged only). The
  // handler owns the allowlist + rate-limit gates; the scanner just parses. NOT
  // in _extractIntents' multi-line allow-set — the reason is a single line, so a
  // following line stays its own intent (like who/name/file).
  const rebootMatch = cleaned.match(/^\[agent:reboot\]\s*(.*)/s);
  if (rebootMatch) return { type: 'reboot', body: rebootMatch[1] };

  // `task` = the team ticket protocol (Task 25). Six sub-verbs; a team LEAD opens
  // and directs tickets, an ASSIGNEE closes them, and clodex owns the registry +
  // lifecycle + stall watchdog. The sub-verb alternation is CLOSED (only the six):
  // a typo like `[agent:task foo]` falls through to null → the near-miss bounce,
  // exactly like a bad dm. Bracket-arg shapes per verb:
  //   add            → optional <role|name> in the bracket (the mint+assign common
  //                    case), plus the spec text as a free-text BODY (greedy like dm).
  //   assign <id> <role|name> → no body (the spec lives on the ticket).
  //   done   <id>    → report text BODY. reject <id> → reason BODY.
  //   cancel <id>    → optional reason BODY. list → no args, no body.
  // Body capture for add/done/reject/cancel is in _extractIntents' allow-set (like
  // dm); assign/list deliberately carry no body. All guards + lifecycle live in the
  // handler, not here.
  const taskMatch = cleaned.match(/^\[agent:task\s+(add|assign|done|reject|cancel|list)\b([^\]]*)\]\s*(.*)/s);
  if (taskMatch) {
    const sub = taskMatch[1];
    const argToks = taskMatch[2].trim().split(/\s+/).filter(Boolean);
    const body = taskMatch[3];
    if (sub === 'add') return { type: 'task', sub, who: argToks[0] || null, id: null, body };
    if (sub === 'assign') return { type: 'task', sub, id: argToks[0] || null, who: argToks[1] || null, body: '' };
    if (sub === 'list') return { type: 'task', sub, id: null, who: null, body: '' };
    // done / reject / cancel — a single <id> arg + a free-text body.
    return { type: 'task', sub, id: argToks[0] || null, who: null, body };
  }

  // `team` = team metadata mutation (T29 Layer A). Five sub-verbs; a team LEAD
  // edits the role map + the stall watchdog (the lead-gate lives in the handler).
  // CLOSED alternation (only the five): a typo like `[agent:team foo]` falls
  // through to null → the near-miss bounce, exactly like a bad task/dm. Bracket
  // shapes per verb, modeled on the `task` family + spawn's `key:val` tokens:
  //   role-add <name>    → the brief as a free-text BODY (greedy like dm); prompt/
  //                        template as key:val tokens in the bracket (like spawn:).
  //   role-set <name>    → same shape (edit an existing role's descriptive fields).
  //   role-rm   <name>   → no body.
  //   role-rename <from> <to> → no body.
  //   watchdog <ms>      → no body.
  // Body capture for role-add/role-set is in _extractIntents' allow-set; the other
  // three carry no body (like task assign/list). Guards + the mutators live in the
  // handler, not here.
  const teamMatch = cleaned.match(/^\[agent:team\s+(role-add|role-set|role-rm|role-rename|watchdog)\b([^\]]*)\]\s*(.*)/s);
  if (teamMatch) {
    const sub = teamMatch[1];
    const argStr = teamMatch[2];
    const body = teamMatch[3];
    // key:val tokens (prompt:, template:) — whitespace-free by construction (\S+),
    // like spawn's template:. Positional tokens are those WITHOUT a `key:` prefix.
    const promptM = argStr.match(/\bprompt:(\S+)/);
    const templateM = argStr.match(/\btemplate:(\S+)/);
    const positional = argStr.trim().split(/\s+/).filter((t) => t && !/^\w+:/.test(t));
    if (sub === 'role-add' || sub === 'role-set') {
      return { type: 'team', sub, name: positional[0] || null, prompt: promptM ? promptM[1] : null, template: templateM ? templateM[1] : null, body };
    }
    if (sub === 'role-rm') return { type: 'team', sub, name: positional[0] || null, body: '' };
    if (sub === 'role-rename') return { type: 'team', sub, name: positional[0] || null, to: positional[1] || null, body: '' };
    // watchdog <ms> — a single numeric arg; a non-number → null (handler bounces).
    const ms = positional[0] != null ? Number(positional[0]) : null;
    return { type: 'team', sub, ms: Number.isFinite(ms) ? ms : null, body: '' };
  }

  const spawnMatch = cleaned.match(/^\[agent:spawn\s+(.+)\]\s*$/);
  if (spawnMatch) {
    const argstr = spawnMatch[1];
    const nameM = argstr.match(/\bname:(\S+)/);
    const cwdM = argstr.match(/\bcwd:(\S+)/);
    // Optional template: reference — matched by NAME (case-insensitive exact) at
    // apply time. Whitespace-free by construction (\S+), so spaced template
    // names are UI-only and can't be referenced from an intent.
    const tplM = argstr.match(/\btemplate:(\S+)/);
    return {
      type: 'spawn',
      name: nameM ? nameM[1] : null,
      cwd: cwdM ? cwdM[1] : null,
      template: tplM ? tplM[1] : null,
    };
  }

  return null;
}

// Fenced code blocks are QUOTES. A markdown fence only RENDERS as a quoted
// block — in the raw turn text every line inside it is still its own line at
// column 1, so before this, an intent-shaped example inside a fence FIRED
// (observed live: a documentation block sent two real dms). fencedLines maps
// each line of a turn to whether it sits in a fence (delimiter lines
// inclusive); the caller treats fenced lines as literal text — no intent
// parse, no body boundary, no near-miss bounce. Only LINE-anchored fences
// count: inline backticks are already safe (all intent regexes are
// ^-anchored, mid-line never fires), so there is no character-level backtick
// counting. CommonMark rules, pragmatically: an opener is 3+ backticks or
// tildes after optional indentation (info string allowed); the closer must
// use the opener's char, run at least as long, and carry nothing but
// whitespace — anything else is fence CONTENT (``` inside a ~~~ block stays
// literal). An unclosed fence runs to end of turn: correct markdown
// semantics, and the failure mode (a real intent below swallowed as quoted
// text) is visible in the rendered output, unlike the misfire it replaces.
function fencedLines(lines) {
  const fenced = new Array(lines.length).fill(false);
  let open = null; // { ch, len } of the current opener
  for (let k = 0; k < lines.length; k++) {
    const m = lines[k].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (m) {
      const ch = m[1][0];
      if (!open) {
        open = { ch, len: m[1].length };
        fenced[k] = true;
        continue;
      }
      if (ch === open.ch && m[1].length >= open.len && !m[2].trim()) {
        open = null;
        fenced[k] = true;
        continue;
      }
    }
    if (open) fenced[k] = true;
  }
  return fenced;
}

// Near-miss detector for the silent-drop bounce: a line that LOOKS like an
// intent emission (cleans to `[agent:` at its start) yet parses to nothing —
// a typo'd verb, a malformed arg list, a made-up example. parseIntent must
// keep returning null for these: it doubles as the dm-body BOUNDARY in
// _extractIntents, so recognizing near-misses there would truncate any body
// that quotes an unescaped example. The caller consults this only at the TOP
// LEVEL of its scan, where such a line is otherwise dropped in silence.
// Escaped \[agent: lines never match — the backslash survives cleanLine.
// Returns the CLEANED line (ANSI/decorators stripped, ready for a bounce
// message) on a match, null otherwise.
function looksLikeIntent(rawLine) {
  const cleaned = cleanLine(rawLine).trim();
  return cleaned.startsWith('[agent:') ? cleaned : null;
}

// Stable identity of one intent occurrence for the wire-vs-jsonl shadow
// differ (both paths see the same assistant text, so the same intent hashes
// to the same key on both sides). Body capped so a huge dm doesn't bloat
// the shadow log's keys.
function shadowIntentKey(agent, intent) {
  // urgent is part of the identity: a held dm RESENT with the flag inside the
  // dedupe TTL must dispatch, not be swallowed as a duplicate of the bounce.
  const head = (intent.sub || intent.target || intent.name || intent.id || intent.cmd || intent.spec || '') + (intent.urgent ? '+urgent' : '');
  // `text` = the synthesized `unknown` intent's raw line: without it every
  // near-miss in a turn would collapse to one dedupe key and only the first
  // distinct typo would bounce.
  const body = (intent.body || intent.path || intent.text || '').trim().slice(0, 200);
  return `${agent}|${intent.type}|${head}|${body}`;
}

module.exports = { ANSI_RE, PREFIX_CHARS, cleanLine, parseIntent, fencedLines, looksLikeIntent, shadowIntentKey };
