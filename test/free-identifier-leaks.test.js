// Regression guard for the M3/M4 class of bug: an extracted module referencing
// a COORDINATOR-scope identifier that was never injected through its deps
// object / factory params. Those are free identifiers — a ReferenceError at
// runtime — and they only explode when the code path runs. Three real escapes
// motivated this: the five cli-hooks fns missing from SessionManager's deps
// (broke session restore), POLL_INTERVAL/TURN_COMPLETE_TIMEOUT left behind by
// the JsonlWatcher move (broke every non-wire agent spawn), and five
// identifiers missing from createProxyPoller (killed the status bar silently —
// the tick's .catch(() => {}) ate the ReferenceError). All shipped green
// through the unit suite because their paths need a PTY / live proxy.
//
// Heuristic static scan, not a parser: collect the COORDINATOR SCOPE's
// module-scope names, collect the module's own definitions (functions, classes,
// consts, deps destructures, function/factory params), strip
// comments/strings/object keys, and flag any identifier the module uses that
// only the coordinator scope defines. Imperfect stripping means a small
// per-module whitelist; every entry must be justified inline.
//
// THE COORDINATOR SCOPE IS TWO FILES, NOT ONE (see MAIN_SCOPE below). The
// 2026-07 engine extraction moved the wiring out of main.js into engine.js, so
// a scan pointed at main.js alone measures the file the coordinator moved OUT
// of — which is what this gate did from that extraction until 2026-08, issuing
// green on 57 assertions that could not see a single moved name. Both files are
// scanned, and a scope file appearing in one of the lists below is scanned
// against the REST of the scope, never against itself.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// The coordinator scope the modules below are measured against. main.js was the
// whole of it until the engine extraction; engine.js now assembles the
// electron-free module graph and main.js is a thin Electron adapter that still
// hosts names of its own. A module reaching for a name from EITHER is the same
// escape, so the forward scan unions both scopes rather than picking one —
// keeping main.js's coverage and adding back everything the extraction moved.
const MAIN_SCOPE = ['main.js', 'engine.js'];

// Every module extracted from main.js OR from the engine scope it became. New
// extraction phases MUST add their modules here (M5: ipc-handlers,
// remote-wiring, peer-wiring, app-menus).
const SCANNED_MODULES = [
  'dev-reload.js',
  'session-manager.js',
  'app-menus.js',
  'ipc-handlers.js',
  'remote-wiring.js',
  'peer-wiring.js',
  'jsonl-watcher.js',
  'wirescope-proxy.js',
  'wirescope-supervisor.js',
  'cli-hooks.js',
  'agent-transport.js',
  'update-checker.js',
  'ipc-prompt.js',
  'stores.js',
  'catalogs.js',
  'statusline.js',
  'intent-scanner.js',
  'host-stamp.js',
  'intent-catalog.js',
  'intent-registry.js',
  'prompt-rails.js',
  'exec-schema.js',
  // The team-manifest preflight resolver (t414). Every disk touch is an injected
  // probe, which is the whole reason its findings table is assertable without a
  // library on disk — a reach for `fs` or `REGISTRY_DIR` would quietly undo that.
  'team-preflight.js',
  'remind-schedule.js',
  'remind-scheduler.js',
  'argv-merge.js',
  'transcript.js',
  // The spoken-reply pair. speakable.js is a pure string leaf; speaker.js
  // owns the `say` child and must reach for NOTHING in the engine scope — it is
  // constructed there and injected, so a grab for `uiSettings` or a session map
  // would put the "may I speak" decision in the process owner, where the gates
  // that answer it do not live.
  'speakable.js',
  'speaker.js',
  'fs-util.js',
  'claude-env.js',
  'env-scopes.js',
  'relay-protocol.js',
  'session-restore.js',
  'session-discovery.js',
  'git-worktree.js',
  // The ticket loop's review scope builder (t309). A pure string leaf — the
  // record and the diff path arrive as arguments, which is what lets the scope's
  // contents be asserted without a session, a team or a git repo.
  'ticket-review-scope.js',
  // The ticket record store (t309). Scanned for the same reason the scope is:
  // `ticketInFlight` was extracted here from two literal copies in
  // session-manager.js, and a dangling reference left by that kind of move is
  // caught by nothing else in this file. `fs`/`path` arrive as parameters, so
  // it is a pure leaf.
  'tickets-store.js',
  // The stall alarm's evidence reader (t322). `fs` arrives as a parameter and
  // the manager reads it through the deps object, so a `log.`/`path.` reaching
  // back into the coordinator scope from here would otherwise ship green —
  // nothing else in this file guards it.
  'stall-evidence.js',
  'session-meta.js',
  // The skill_listing classifier (t401). A pure string/JSON leaf: engine.js
  // keeps the realpath+read and passes lines in, which is what lets the roster
  // vs directory-scoped split be asserted against fixtures without a session.
  'skill-roster.js',
  // The ⓘ panel's data layer (t-sessioninfo). Every source it reads — fs,
  // readline, homedir, the registry dir, userData — arrives injected, which is
  // what makes the transcript scan testable against fixtures without an app.
  'session-info.js',
  // The frozen-system-prompt cache (t61). A pure fs/string leaf like
  // ctx-reminder.js, read by session-manager's claude arm through the deps
  // object — so the forward scan says something real: a name it reached for in
  // session-manager's scope instead of taking by injection would show up here.
  'ipc-prompt-cache.js',
  // The deferred-notice queue (t240). Same shape and the same reason as the
  // prompt cache above: a pure fs/string leaf, injected into session-manager
  // and required DIRECTLY by cli-hooks for the horizon constant it interpolates
  // into the generated drain. That direct require is the interesting half — it
  // is what keeps one copy of the number, and it only works while this stays
  // electron-free, which is what the forward scan holds.
  'notice-queue.js',
  // Contextual hint arming (t139). hint-arm.js takes its retriever, composer,
  // load lookup and proxy calls by injection, and session-manager reaches for
  // none of its internals — the reverse scan is what keeps the retriever seam
  // real, since a second retriever must slot in without hint-arm.js changing.
  'hint-arm.js',
  // The drawer selection's armer, same shape and the same reason: its proxy
  // calls, its pref and its scrubber all arrive injected, so the reverse scan is
  // what keeps session-manager from reaching into its registers instead of
  // going through arm/release.
  'selection-arm.js',
  // The voice-origin marker's armer (t572), scanned for the third instance of
  // the same reason: its one proxy call arrives injected, so the reverse scan is
  // what keeps session-manager going through arm() rather than reaching for the
  // hint id or its text.
  'voice-origin-arm.js',
  'hint-retrieve.js',
  // The second retriever the seam above was built for. It shares only the
  // tokenizer with hint-retrieve.js; its thresholds are deliberately its own,
  // because the ones derived on the memory store do not transfer to a corpus
  // three orders of magnitude larger.
  'basket-retrieve.js',
  // The semantic re-ranker. Takes its fetch, cache and corpus by injection so
  // the no-daemon path is testable without one installed; hint-arm.js holds it
  // as an optional dep and must keep working with it absent.
  'hint-embed.js',
  // The append-only vector store behind continuous ingestion. A pure leaf over
  // node:fs with its fs seams injected, so it stays testable without a daemon
  // and without a real corpus.
  'vector-store.js',
  // Both a SCOPE file (MAIN_SCOPE) and a scanned module. It is scanned against
  // the rest of the scope — main.js — and never against itself: a file's own
  // names are all in its own defs, so a self-scan is empty by construction and
  // passes vacuously. main.js is the right question for it anyway, since
  // engine.js is what was extracted FROM main.js.
  'engine.js',
  'headless-main.js',
  'sandbox.js',
  // Plugin core (plugin-plan.md [internal design doc, not in this repo] Phase 0/1). plugin-api.js is a pure leaf
  // (no requires at all); plugin-host-engine.js is a deps-object factory. Both
  // join the list by the same convention as every other extraction.
  'plugin-api.js',
  'plugin-host-engine.js',
  // Phase 2: discovery + the enabled set. Deps-object factory, fs/path injected.
  'plugin-loader.js',
  // The shared dial (t42/L1), collapsing three copies of spawn-and-kill. Listed
  // because the ticket requires every new extraction to join this list — but be
  // honest about what it proves HERE: this is a cli/ leaf that was never carved
  // out of main.js, so the forward scan can only catch it accidentally using a
  // name main.js happens to define. That is a weak statement compared to what
  // this test does for a real main.js extraction. The strong guard for cli/ is
  // its leaf property — no upward require in the SHIPPED tree, `cli/src` and
  // `cli/bin` (`cli/test` does require upward) — which `cli/package.json`'s
  // `files` array, and a real install, are what enforce.
  'cli/src/dial.js',
  // The shared SSE frame decoder (t47/L3), collapsing two copies of the
  // framing. Same honest caveat as dial.js above: a cli/ leaf never carved out
  // of main.js, so the forward scan only catches it accidentally. Listed
  // because the convention says every new extraction joins; the real guard for
  // this one is its leaf property — it has NO requires at all.
  'cli/src/sse-frame.js',
  // The shared tunnel supervisor (t49/L2), collapsing peer-tunnel.js's `Tunnel`
  // and web-tunnel.js's `WebTunnel`. Unlike the two cli/ leaves above, this one
  // is a root main-process module and the forward scan says something real about
  // it: it is required BY peer-wiring.js (which was itself carved out of
  // main.js), so a main.js name reaching it through that path is exactly the
  // escape this test exists to catch.
  'tunnel-supervisor.js',
  // The drawer's clodexctl REPL service (t214). Same standing as
  // tunnel-supervisor above: a root main-process module required BY engine.js
  // (itself an extraction), so a main.js name reaching it through that path is
  // exactly this test's case. It must also stay electron-free, which the
  // require-shape test in ctl-service.test.js pins separately.
  'ctl-service.js',
  // The drawer's workbench PTY (t215). Same standing, and the forward scan
  // carries an extra claim here: this module takes node-pty and the window send
  // by injection, so a bare `pty` or `manager` name appearing in it means it
  // reached for the session machinery it is defined by not using.
  'drawer-pty.js',
  // OSC 133 terminal reporting. Both are pure leaves taking everything by
  // argument (term-marks is fed bytes and emits records; term-shim is handed a
  // dir, a shell and an env), so any free identifier here is a reach into the
  // coordinator that neither is allowed to see.
  'term-marks.js',
  'term-shim.js',
  // Moved out of renderer/lib/ when [agent:term exec] gave it a SECOND reader
  // in the main process (session-manager's refusal path) — one predicate, two
  // processes, and a copy in each is how the two drift. It is scanned against
  // main.js now rather than renderer.js: the renderer half (term-tab) still
  // reads it, but a leaked identifier here would be a main-scope name.
  'drawer-avail.js',
  // The peer-terminal grant decisions (t219). Read by remote-wiring (whether to
  // register the serving handlers), peer-client and the renderer (whether to
  // ask) — three readers across both processes and both ends of the wire, so a
  // free identifier here would be a reach into whichever scope happened to be
  // loaded first.
  'peer-shell.js',
  // The teams/tickets half of SessionManager (t380). Carved out of
  // session-manager.js, which is itself an extraction from the main scope, so a
  // MAIN_SCOPE name reaching it through that path is this test's case exactly.
  // The forward scan is the weaker half of its guard: the methods here run
  // grafted onto SessionManager.prototype, so their reach into core is carried
  // by `this.*`, which resolves on the prototype chain at runtime and NEVER
  // appears as a free identifier. That seam is gated by
  // test/ticket-mixin-surface.test.js; this entry only catches the module-scope
  // half (a moved body still reaching for a coordinator const).
  'team-tickets.js',
  // The team helper's measured layer (t474). Pure leaf: fs/path/childProcess all
  // arrive by injection, which is what makes its findings table assertable
  // against a fixture directory with no repo wired up. A reach for a real `fs`
  // or a coordinator const would quietly undo that.
  'team-measure.js',
];

// NOT scanned: anything under plugins/. This list answers "did an extraction
// from main.js leave a free identifier behind?" — it scans a module against
// MAIN.JS's module scope. A plugin was never extracted from main.js and cannot
// see its scope; the guard that a plugin reaches core only through `host` is
// test/plugin-boundary.test.js's no-backdoor walk, which is a strictly stronger
// statement (no require out at all, not merely no leaked identifier).
// git-scm.js and fs-explorer.js were on this list until W5 moved them into
// plugins/workbench/; they were DROPPED rather than repointed for that reason.

// The same guard for renderer.js extractions — these modules were carved out of
// renderer/renderer.js, so they leak against ITS module scope, not main.js's.
// findLeaks is parameterized by scope file; this list is scanned against
// renderer/renderer.js. Populated retroactively with every R1/R2 island (the M5
// review proved this bug class ships green — renderer had no guard at all until
// R3) plus every new R3 popover module.
const RENDERER_SCOPE = 'renderer/renderer.js';
const RENDERER_SCANNED_MODULES = [
  // The terminal intent-mark classification (t402). Read by intent-highlight.js,
  // which is DOM-bound and untested, and it reaches ACROSS into a root module
  // (intent-scanner) — so the guard that it never also reaches for a
  // renderer.js name is the cheap half of keeping it a pure leaf.
  'renderer/lib/intent-marks.js',
  // Its island half (t402), scanned for the same reason every other island is:
  // it runs per-terminal inside createTerminal's scope, where `sessions` and
  // `activeSession` are in easy reach, and a decoration lifecycle that grabbed
  // one would ship green without this.
  'renderer/intent-highlight.js',
  // The hands-free submit matcher and its watcher (t566). The watcher runs
  // per-terminal inside createTerminal's scope exactly like intent-highlight,
  // where `sessions` and `activeSession` are in easy reach — and this one WRITES
  // to the pty, so a reach for a renderer.js name is the difference between a
  // gate the caller can supply and one that cannot be tested at all.
  'renderer/lib/voice-submit.js',
  'renderer/voice-submit-watcher.js',
  // The broadcast-beats-late-pull latch behind the mic-target and app-focused
  // mirrors. A pure leaf read by renderer.js, which has no harness — the whole
  // reason it was lifted out of it.
  'renderer/lib/mirror-latch.js',
  'renderer/lib/constants.js',
  'renderer/lib/format.js',
  'renderer/lib/render-html.js',
  'renderer/lib/checklists.js',
  'renderer/lib/team-roles.js',
  'renderer/lib/popover-drag.js',
  'renderer/lib/args-model.js',
  'renderer/lib/session-actions.js',
  'renderer/lib/name-suggest.js',
  'renderer/lib/env-edit.js',
  // The MCP roster fold (t46). A pure leaf like the rest of lib/, read by
  // context-popover (DOM-bound, untested), so the cheap guard that it never
  // reaches for a renderer.js name is worth having.
  'renderer/lib/mcp-group.js',
  // The peer web-view affordance decision (t30b). A pure leaf rather than an
  // extraction, but it is read BY peers-ui (which is DOM-bound and untested), so
  // the cheap guard that it never reaches for a renderer.js name is worth having.
  'renderer/lib/peer-web-view.js',
  // The served-terminal notice's decision (t219). Same reason as the two above:
  // read by peers-ui, which is DOM-bound and untested, and this one is the ONLY
  // surface for a served seat whose row is filtered or collapsed out of sight.
  'renderer/lib/served-banner.js',
  // The peer-header fold defaulting (t276). Same shape as the two above: a pure
  // leaf read by peers-ui, which is DOM-bound and untested, and the whole point
  // of the leaf is that its absence-means-collapsed rule is reachable by a unit
  // test at all.
  'renderer/lib/peer-collapse.js',
  // Read by BOTH renderer.js (terminal link provider) and files-popover.js
  // (peek linkify), so a reach for a renderer.js name would break one caller
  // and not the other.
  'renderer/lib/path-scan.js',
  // Same shape as path-scan: a pure leaf feeding the DOM-bound link provider,
  // where the buffer walking that calls it has no unit tests of its own.
  'renderer/lib/gutter-scan.js',
  // Whether a newly created session may take the keyboard (t412). The names it
  // must NOT reach for are exactly the ones in scope at its call sites —
  // `activeSession` and `sessions` — and reading either directly would let the
  // policy answer from renderer state instead of the main-side draft it is
  // required to agree with.
  'renderer/lib/focus-policy.js',
  // The bottom drawer's tab host (t201) and its first tenant. The host took
  // the toggle/layout/refit mechanics OUT of ipc-log.js, so the reverse scan
  // matters as much as the forward one here: ipc-log.js keeping a name that
  // moved to the host is the same silent break as the host reaching for one of
  // renderer.js's.
  // The voice-mode selector (t509). Scanned like every island: it reports write
  // failures through `showToast`, a renderer.js name in easy reach — reaching
  // for it directly instead of through its injected seam would ship green, and
  // would break the browser frontend, where this island is bundled and that name
  // is not its to take.
  'renderer/voice-control.js',
  'renderer/drawer-host.js',
  'renderer/ipc-log.js',
  'renderer/inbox-drawer.js',
  'renderer/term-search.js',
  'renderer/banners.js',
  'renderer/themes.js',
  'renderer/library-drawers.js',
  // The drawer's Activity tenant (t204), which replaced subagent-popover.js.
  // Its two leaves are what the popover's untestable logic became, and both
  // directions matter: renderer.js kept `applySubagents` but gave the policy
  // away, so a leftover SUBAGENT_ACTIVE_S there is the reverse-scan case.
  'renderer/activity-tab.js',
  'renderer/lib/subagent-feed.js',
  'renderer/lib/subagent-policy.js',
  // The badge state machine (t210), the third leaf out of the same tenant.
  // FORWARD scan only, which is all this list buys: the reverse (dangling-ref)
  // gate is the scope loop further down, and activity-tab.js is not in it — so a
  // leftover `notified`/`lastReq`/`awayReq` in the tenant after the extraction
  // would be caught by NEITHER gate here, those names being ones renderer.js
  // never defined. That case is covered behaviourally instead, by
  // test/activity-tab-badge-order.test.js: it loads the real module, so a
  // leftover reference throws a ReferenceError on the first refreshChips.
  'renderer/lib/activity-badge.js',
  // The drawer's clodexctl tenant (t214). It holds NO logic renderer.js gave
  // up, so the reverse scan is the quiet one here; the forward scan is the
  // point — the pane must reach main only through `window.api`, and a
  // renderer.js name appearing in it is the first sign it grew a second path.
  'renderer/ctl-tab.js',
  // The drawer's workbench terminal tenant (t215), same standing as ctl-tab:
  // it must reach main only through `window.api`, and it owns an xterm, so a
  // renderer.js terminal-management name appearing here is the sign it started
  // borrowing the SESSION terminal path instead of holding its own.
  'renderer/term-tab.js',
  'renderer/session-hovercard.js',
  'renderer/tooltip.js',
  'renderer/popovers/report-panel.js',
  'renderer/popovers/cost-popover.js',
  'renderer/popovers/bust-popover.js',
  'renderer/popovers/session-info-popover.js',
  'renderer/popovers/files-popover.js',
  // The session bar's voice button (t517). Scanned for the reason every popover
  // is, with one extra: it is the SECOND surface over voice-control's core, and
  // the whole point of that split is that neither surface keeps voice state of
  // its own. Reaching for a renderer.js name here is the first sign it started
  // reading session state directly instead of through the core's snapshot.
  'renderer/popovers/voice-popover.js',
  'renderer/popovers/checklist-popovers.js',
  'renderer/popovers/team-roles-popover.js',
  'renderer/popovers/context-popover.js',
  'renderer/popovers/session-menus.js',
  'renderer/plugin-host.js',
  'renderer/peers-ui.js',
];

// Justified survivors of imperfect stripping. Format: module -> Set of names.
const WHITELIST = {
  // `isAlive` is engine.js's (`:524`, destructured off createAgentTransport), so
  // it entered this scan the moment engine.js joined MAIN_SCOPE. But
  // plugin-host-engine.js does not REFERENCE it: `isAlive() {` is an
  // object-literal method shorthand on the frozen handle sessionHandle() returns,
  // and the only other hit is a comment. The lexer drops `key:` object
  // keys but not method shorthand, and ownDefinitions' param matcher reads the
  // shorthand's empty parameter list without adding the method name to defs — so
  // a definition reads as a use. Nothing to inject; the module is clean.
  'plugin-host-engine.js': new Set(['isAlive']),
};

function moduleScopeNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:async )?function (\w+)/gm)) names.add(m[1]);
  // Declaration lists, possibly multi-line: `let a, b,\n  c;` and `const x = …`.
  // The single-`\w+` form this replaced missed continuation lines — that is how
  // the seven stores declared as `let persistence, templates,\n …, uiSettings;`
  // stayed invisible and let ipc-handlers.js leak them all.
  for (const m of src.matchAll(/^(?:const|let) ([\w\s,]+?)(?:;|=)/gm)) {
    for (const n of m[1].split(',')) {
      const t = n.trim();
      if (/^\w+$/.test(t)) names.add(t);
    }
  }
  // Destructures, possibly multi-line — `const { a, b } =`, `let { a } =`, and
  // the whenReady reassignment `({ persistence, … } = initStores(...))`.
  for (const m of src.matchAll(/^(?:const|let)? ?\(?\{([\s\S]*?)\}\s*=/gm)) {
    for (const p of m[1].split(',')) {
      const t = p.split(':')[0].trim();
      if (/^\w+$/.test(t)) names.add(t);
    }
  }
  return names;
}

function stripComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function ownDefinitions(rawSrc) {
  // Comments first — a paren inside a comment embedded in a multi-line
  // factory param list breaks the param matcher otherwise.
  const src = stripComments(rawSrc);
  const defs = new Set();
  for (const m of src.matchAll(/^\s*(?:async )?function (\w+)/gm)) defs.add(m[1]);
  for (const m of src.matchAll(/\bclass (\w+)/g)) defs.add(m[1]);
  for (const m of src.matchAll(/^\s*(?:const|let) (\w+)/gm)) defs.add(m[1]);
  // Destructured requires/assignments: const { a, b: c } = anything
  for (const m of src.matchAll(/(?:const|let) \{([\s\S]*?)\}\s*=/g)) {
    for (const p of m[1].split(',')) {
      const n = p.split(/[:/]/)[0].trim();
      if (/^\w+$/.test(n)) defs.add(n);
    }
  }
  // Function/method parameters, including destructured factory deps objects.
  // This shares the reverse gate's balanced-paren walk instead of running a
  // `\(([^()]*)\)` matcher: that character class cannot cross a nested paren, so
  // a signature whose default is a CALL —
  // `createTicketsStore({ fs = require('fs'), path = require('path'), x } = {})`
  // — failed to match as a whole and lost EVERY name in the group, x included.
  // Those then read as free identifiers and false-alarmed, which is what the
  // tickets-store whitelist entry existed to silence. The reverse gate had
  // already replaced the same matcher for the same reason (see collectParams).
  for (const p of collectParams(src)) defs.add(p);
  for (const p of collectMethodParams(src)) defs.add(p);
  return defs;
}

// A `\w+(…) {` head, balanced-paren: method shorthand and object-literal
// methods, which the arrow/`function` heads in collectParams do not cover. The
// trailing `{`/`=>` is what separates a DEFINITION from a call — `foo(a, b)`
// alone must never contribute its arguments as defs. Control keywords are
// excluded on top of that: `if (name === activeSession) {` also matches
// `word (…) {`, and absorbing its condition into own-defs silently HID a real
// missing injection (files-popover.js needed activeSession; the scan stayed
// green). A `\w+(` head that is if/for/while/…/an operator keyword is a
// statement, and its parens hold an expression, never a parameter list.
const CONTROL_KW = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else',
  'typeof', 'await', 'new', 'in', 'of', 'instanceof', 'void', 'delete', 'yield',
]);
// `withNames` also records the HEAD'S OWN NAME as a definition, for the reverse
// gate only. A class method is a binding the reverse gate must see: `this._x()`
// strips to `._x` → `.`, but the declaration `_x(a) {` leaves `_x` as a bare
// token, so without this every method of a scanned class reads as a dangling
// reference to itself. Measured on session-manager.js — the first class file the
// reverse loop ever scanned — that is 218 false positives, i.e. the gate off.
// The forward scan does NOT pass it: there a name shared with the coordinator is
// the thing being looked for, and treating a method head as a local definition
// would mask it. Over-collection here is the same safe bias as collectParams
// (it can mask a would-be dangler, never manufacture one), and the `body` check
// below is what already proves the head is a definition and not a call.
function collectMethodParams(code, withNames) {
  const defs = new Set();
  for (const m of code.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) {
    if (CONTROL_KW.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let k = open; k < code.length; k++) {
      if (code[k] === '(') depth++;
      else if (code[k] === ')') {
        depth--;
        if (depth === 0) {
          let t = k + 1;
          while (t < code.length && /\s/.test(code[t])) t++;
          const body = code[t] === '{' || (code[t] === '=' && code[t + 1] === '>');
          if (body) {
            addIds(code.slice(open + 1, k), defs);
            if (withNames) defs.add(m[1]);
          }
          break;
        }
      }
    }
  }
  return defs;
}

// Single left-to-right pass replacing strings, comments, and regex literals
// with blanks — but template literals are lexed structurally, not blanked
// wholesale. A `${…}` interpolation recurses back into code mode with brace-
// depth tracking, so (a) nested backticks inside an interpolation (e.g.
// `shellEsc(`…`)`) no longer flip the lexer state and silently drop the rest of
// the file from the scan, and (b) the interpolation EXPRESSION itself is kept as
// code — a `${diagSummary(...)}` reference is a real use and must be seen.
// Regex ordering can't do this correctly — `'http://x'` defeats comments-first
// (the // inside the string is eaten, unbalancing every quote after it),
// apostrophes in comments defeat strings-first. A regex literal is assumed when
// `/` follows a token that cannot end an expression (so `a / b` division
// survives).
function stripCommentsStringsAndKeys(src) {
  let out = '';
  let i = 0;
  let lastSig = ''; // last significant (non-space) char emitted
  const isRegexPos = () => lastSig === '' || '=(,:;!&|?{}[+-*%<>~^'.includes(lastSig);
  // Consume code until the matching close of the current `${…}` (end === '}')
  // or end of source (end === null). Braces balance so object/block braces
  // inside an interpolation don't terminate it early.
  function code(end) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (end === '}' && c === '}' && depth === 0) return;
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (c === "'" || c === '"') { str(c); continue; }
      if (c === '`') { tpl(); continue; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      if (c === '/' && isRegexPos()) { rex(); continue; }
      out += c; if (!/\s/.test(c)) lastSig = c; i++;
    }
  }
  function str(q) { i++; while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1; i++; out += q + q; lastSig = q; }
  function tpl() {
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; out += '('; lastSig = '('; code('}'); i++; out += ')'; lastSig = ')'; continue; }
      i++;
    }
    i++; out += '``'; lastSig = '`';
  }
  function rex() {
    i++;
    let inClass = false;
    while (i < src.length && (inClass || src[i] !== '/')) {
      if (src[i] === '\\') i += 2;
      else { if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false; i++; }
    }
    i++;
    while (i < src.length && /[gimsuy]/.test(src[i])) i++;
    out += '""'; lastSig = '"';
  }
  code(null);
  return out
    // Property accesses (`intent.path`, `pty.spawn`) never resolve against
    // module scope — drop the `.name` part, keep the receiver.
    .replace(/\.\s*[a-zA-Z_$][\w$]*/g, '.')
    // Object-literal keys (`Notification: [...]` in the hooks config) are
    // identifier tokens but not variable references — drop `key:` after an
    // opening brace or comma. Ternary `?:` colons don't match (no {, before).
    .replace(/([{,]\s*)\w+\s*:/g, '$1');
}

// Which scope files a given module is actually measured against. A scope file
// that is ALSO a scanned module (engine.js) drops out of its own scope: every
// name a file defines is in its own defs, so the intersection findLeaks takes is
// empty by construction and the assertion passes without asking anything. That
// vacuous pass is the failure mode this whole ticket is about, so an empty
// residue THROWS rather than reporting a clean scan.
function scopesFor(moduleFile, scopeFiles) {
  const files = (Array.isArray(scopeFiles) ? scopeFiles : [scopeFiles])
    .filter((f) => f !== moduleFile);
  if (!files.length) {
    throw new Error(
      `${moduleFile} has no scope file left to scan against (its only scope is itself). ` +
      'A self-scan is vacuous — give it a scope that does not include it, or drop it from the list.',
    );
  }
  return files;
}

function findLeaks(moduleFile, scopeFiles = MAIN_SCOPE) {
  const scopeNames = new Set();
  for (const scopeFile of scopesFor(moduleFile, scopeFiles)) {
    const scopeSrc = fs.readFileSync(path.join(ROOT, scopeFile), 'utf8');
    for (const n of moduleScopeNames(scopeSrc)) scopeNames.add(n);
  }
  const modSrc = fs.readFileSync(path.join(ROOT, moduleFile), 'utf8');
  const defs = ownDefinitions(modSrc);
  const wl = WHITELIST[moduleFile] || new Set();
  const used = new Set(stripCommentsStringsAndKeys(modSrc).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);
  return [...used].filter((n) => scopeNames.has(n) && !defs.has(n) && !wl.has(n)).sort();
}

for (const mod of SCANNED_MODULES) {
  // The scopes go in the test NAME: the gate's result is an ABSENCE, and a scan
  // against 28 names and a scan against 400 print the same "no leaks". Naming
  // the scope is what makes a repointed gate visible in the output instead of
  // silently identical to the broken one.
  const scopes = scopesFor(mod, MAIN_SCOPE);
  test(`${mod} references no ${scopes.join('+')}-only identifiers`, () => {
    const leaks = findLeaks(mod, MAIN_SCOPE);
    assert.deepStrictEqual(
      leaks, [],
      `free identifiers leaked from ${scopes.join('+')} scope (add to deps + destructure): ${leaks.join(', ')}`,
    );
  });
}

for (const mod of RENDERER_SCANNED_MODULES) {
  const scopes = scopesFor(mod, RENDERER_SCOPE);
  test(`${mod} references no ${scopes.join('+')}-only identifiers`, () => {
    const leaks = findLeaks(mod, RENDERER_SCOPE);
    assert.deepStrictEqual(
      leaks, [],
      `free identifiers leaked from ${scopes.join('+')} scope (add to init params + destructure): ${leaks.join(', ')}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Reverse gate: dangling references. The forward scan above catches a MODULE
// using a name only the scope file defines. It is blind to the opposite escape
// — the SCOPE file (renderer.js / main.js) referencing a name that an
// extraction MOVED into a module and never left a binding for. That is exactly
// how R3 shipped two live ReferenceErrors: `openFilePeek` + the `filesPopover`
// handle moved into files-popover.js, but two callers stayed in renderer.js's
// peer region (a fileView mirror + a telemetry frame). A directional scan can't
// see it; this one does. For each scope file, collect every referenced
// identifier that is NOT defined anywhere in that file, NOT a language/host
// global, and NOT a property/string/object-key (the lexer already strips
// those) — the residue must be empty.

// Union of every binding target text into a set (splitting on the delimiters
// that separate identifiers in a param list / destructure pattern).
function addIds(text, defs) {
  for (const w of text.replace(/[{}[\]()]/g, ' ').split(/[\s,:=]+/)) {
    if (/^[a-zA-Z_$][\w$]*$/.test(w)) defs.add(w);
  }
}

// Balanced-paren parameter walk over comment/string-stripped code. ownDefinitions'
// `\(([^()]*)\)` matcher cannot cross a nested paren, so the pervasive
// callback shape `foo((a, b) => …)` hid every one of those params (attn, geom,
// resultIndex, …) and would have false-alarmed the reverse gate. This reads the
// real parameter group for both `=> ` arrows (parenthesized and bare) and every
// `function (…)`. Default-value refs are over-collected into defs — the SAFE
// direction (can only mask a would-be dangler, never manufacture one).
function collectParams(code) {
  const defs = new Set();
  for (let i = 0; i + 1 < code.length; i++) {
    if (code[i] === '=' && code[i + 1] === '>') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(code[j])) j--;
      if (code[j] === ')') {
        let depth = 0, k = j;
        for (; k >= 0; k--) { if (code[k] === ')') depth++; else if (code[k] === '(') { depth--; if (depth === 0) break; } }
        addIds(code.slice(k + 1, j), defs);
      } else {
        let s = j;
        while (s >= 0 && /[\w$]/.test(code[s])) s--;
        const id = code.slice(s + 1, j + 1);
        if (/^[a-zA-Z_$][\w$]*$/.test(id)) defs.add(id);
      }
    }
  }
  for (const m of code.matchAll(/\bfunction\s*\*?\s*[a-zA-Z_$]?[\w$]*\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let k = open; k < code.length; k++) {
      if (code[k] === '(') depth++;
      else if (code[k] === ')') { depth--; if (depth === 0) { addIds(code.slice(open + 1, k), defs); break; } }
    }
  }
  return defs;
}

// Brace-depth-aware declaration scanner: for each const/let/var, read the whole
// declarator list and record every binding target — single names, comma lists
// WITH initializers (`const be = x, le = y`), renamed object destructures
// (`{ id: peerId }`), and array destructures (`const [, , s, agentLib] = …`).
// ownDefinitions only grabs the first single name of each; the others slip
// through and false-alarm. Splitting only at brace/bracket/paren depth 0 keeps
// commas inside a pattern from ending a declarator early.
function collectDeclarations(code) {
  const defs = new Set();
  const re = /\b(?:const|let|var)\b/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 0, target = '', reading = true;
    for (let i = m.index + m[0].length; i < code.length; i++) {
      const c = code[i];
      if (depth === 0 && reading && c === '=' && code[i + 1] !== '=') { addIds(target, defs); reading = false; target = ''; continue; }
      if (depth === 0 && c === ',') { if (reading) addIds(target, defs); reading = true; target = ''; continue; }
      if (depth === 0 && c === ';') { if (reading) addIds(target, defs); break; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth === 0) { if (reading) addIds(target, defs); break; } depth--; }
      if (reading) target += c;
    }
  }
  return defs;
}

// Every name BOUND anywhere in a scope file: top-level (moduleScopeNames) and
// nested (ownDefinitions) declarations, plus the binding forms neither of those
// fully covers — nested-paren params, full declarator lists, named function
// EXPRESSIONS (IIFEs), and catch bindings. Over-collection here only weakens the
// gate (a real dangler could hide); it never invents one — the same safe bias
// the whole heuristic rides on.
function definedNames(rawSrc) {
  const src = stripComments(rawSrc);
  const defs = new Set([...moduleScopeNames(rawSrc), ...ownDefinitions(rawSrc)]);
  for (const p of collectParams(src)) defs.add(p);
  // withNames: class/object method heads bind their own name. See the note on
  // collectMethodParams — without it a scanned class file's every method reads
  // as dangling.
  for (const p of collectMethodParams(src, true)) defs.add(p);
  for (const d of collectDeclarations(src)) defs.add(d);
  for (const mm of src.matchAll(/\bfunction\s*\*?\s*([a-zA-Z_$][\w$]*)\s*\(/g)) defs.add(mm[1]);
  for (const mm of src.matchAll(/\bcatch\s*\(\s*([^)]*)\)/g)) addIds(mm[1], defs);
  return defs;
}

// The language + host surface a scope file legitimately references without
// defining. NOT per-file padding — it is the fixed ECMAScript/DOM/Node universe,
// every entry a well-known reserved word or global, none ambiguous. Split by
// origin so an addition has an obvious home and reviewers can spot a smuggled
// non-global. A reference that is genuinely none of these is a real dangler.
const RESERVED = [
  // Keywords the tokenizer emits as bare identifiers — mechanical, not globals.
  'this', 'super', 'true', 'false', 'null', 'void', 'typeof', 'instanceof',
  'in', 'of', 'new', 'delete', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'function', 'class', 'const', 'let',
  'var', 'try', 'catch', 'finally', 'throw', 'await', 'async', 'yield',
  'default', 'extends', 'get', 'set', 'static', 'from', 'as', 'import',
  'export', 'with', 'debugger',
];
const BUILTINS = [
  // ECMAScript built-in values/constructors.
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math',
  'JSON', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise',
  'Proxy', 'Reflect', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Function', 'Infinity',
  'NaN', 'undefined', 'globalThis', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'structuredClone', 'btoa', 'atob',
];
const HOST = [
  // Browser/DOM (renderer.js) + Node/module (main.js) ambient globals.
  'window', 'document', 'console', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'requestAnimationFrame',
  'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'fetch', 'alert', 'confirm', 'prompt',
  'getComputedStyle', 'matchMedia', 'crypto', 'CSS', 'Node', 'Element',
  'HTMLElement', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'FileReader',
  'Blob', 'URL', 'URLSearchParams', 'Image', 'Audio', 'FormData',
  'Notification', 'WebSocket', 'XMLHttpRequest', 'DOMParser', 'AbortController',
  'require', 'module', 'exports', 'process', 'Buffer', '__dirname', '__filename',
  'global', 'setImmediate', 'TextEncoder', 'TextDecoder',
];
const AMBIENT = new Set([...RESERVED, ...BUILTINS, ...HOST]);

function danglingRefs(scopeFile) {
  const src = fs.readFileSync(path.join(ROOT, scopeFile), 'utf8');
  const defs = definedNames(src);
  const used = new Set(stripCommentsStringsAndKeys(src).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);
  return [...used].filter((n) => !defs.has(n) && !AMBIENT.has(n)).sort();
}

// Justified survivors of the reverse scan, per file. Same rule as WHITELIST:
// every entry names a scanner limit, never a real dangler waived.
const DANGLING_WHITELIST = {
  // `static CONTEXT_COMMANDS = { … }` — a static class FIELD. definedNames
  // covers const/let/var, params and method heads; no declaration form in it
  // matches a class field, so the field's own name reads as a reference to
  // itself. The same shape in team-tickets.js would be caught by the forward
  // scan instead, and there are no other class fields in either file.
  'session-manager.js': new Set(['CONTEXT_COMMANDS']),
};

// engine.js is here for the same reason it is in MAIN_SCOPE: it holds the
// coordinator names now, so it is the file an extraction most plausibly leaves a
// dangling caller in. It was absent from this list entirely — the reverse half
// of F013.
//
// session-manager.js + team-tickets.js join as the t380 split's reverse half,
// and it is the half that matters most there: the forward scan measures each
// against MAIN_SCOPE, which says nothing about the ~15 ticket-owned module
// consts (TICKET_STALL_MS, humanizeAge, REVIEWER_FALLBACK, …) that moved from
// one file to the other. A use left behind in session-manager after the move is
// a runtime ReferenceError on the ticket path, and NOTHING else in this repo
// looks for it — the forward scan can't (the name is in neither MAIN_SCOPE), and
// the unit suite reaches those paths only with a PTY.
for (const scope of ['renderer/renderer.js', 'main.js', 'engine.js',
  'session-manager.js', 'team-tickets.js']) {
  test(`${scope} references no names that moved out of its scope`, () => {
    const wl = DANGLING_WHITELIST[scope] || new Set();
    const dangling = danglingRefs(scope).filter((n) => !wl.has(n));
    assert.deepStrictEqual(
      dangling, [],
      `dangling references in ${scope} (a name it uses is defined nowhere in-scope — an extraction moved it into a module without leaving a destructured binding): ${dangling.join(', ')}`,
    );
  });
}

// Scanner self-tests — lock in the two defects whose fix caught the M5 escape.
// Each reproduces the exact shape that let a real leak hide: without the fix the
// asserted token is absent and the module scan silently passes over the leak.
const tokensOf = (s) =>
  new Set(stripCommentsStringsAndKeys(s).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);

test('stripper keeps interpolation expressions as code', () => {
  // `${diagSummary(d)}` is a real reference — blanking template interiors is how
  // diagSummary leaked from session-manager.js unseen for a whole phase.
  const toks = tokensOf('const s = `cwd=${cwd} ${diagSummary(d)}`;');
  assert.ok(toks.has('diagSummary'), 'reference inside ${…} was dropped');
  assert.ok(toks.has('cwd'), 'reference inside ${…} was dropped');
});

test('stripper survives a nested backtick inside an interpolation', () => {
  // The shellEsc shape from ipc-handlers.js — a template within a ${…} within a
  // template. Whole-literal blanking flipped the lexer on the inner backtick and
  // dropped the rest of the file (that is how the `workspaces` use hid).
  const toks = tokensOf('const a = `x${shellEsc(`y`)}z`; afterMarker;');
  assert.ok(toks.has('shellEsc'), 'token inside a nested template was dropped');
  assert.ok(toks.has('afterMarker'), 'code after a nested template was dropped');
});

test('moduleScopeNames collects a multi-line declaration list', () => {
  // `let persistence, templates,\n  …, uiSettings;` — the seven-store shape.
  const names = moduleScopeNames('let persistence, templates,\n  agentLibrary, uiSettings;');
  for (const n of ['persistence', 'templates', 'agentLibrary', 'uiSettings']) {
    assert.ok(names.has(n), `multi-line let list missed ${n}`);
  }
});

test('moduleScopeNames collects a multi-line destructure', () => {
  // The whenReady store reassignment shape `({ a, b,\n c } = initStores(x))`.
  const names = moduleScopeNames('({ persistence, templates,\n  skillLibrary, uiSettings } = initStores(x));');
  for (const n of ['persistence', 'templates', 'skillLibrary', 'uiSettings']) {
    assert.ok(names.has(n), `multi-line destructure missed ${n}`);
  }
});

test('ownDefinitions does not absorb a control-flow condition as a parameter', () => {
  // `if (name === activeSession) {` matches the `word ( … ) {` param shape, so the
  // pre-hardening matcher pulled activeSession into own-defs and silently HID the
  // missing injection (files-popover.js's R3 escape). A control keyword before
  // `(` is a statement, not a definition — its condition holds no parameters.
  const defs = ownDefinitions('function f(a) {\n  if (a === leakedName) {\n    return;\n  }\n}');
  assert.ok(defs.has('a'), 'real parameter a was dropped');
  assert.ok(!defs.has('leakedName'), 'if-condition token was absorbed as a param');
  // The other control heads share the shape — none may absorb their condition.
  for (const kw of ['for', 'while', 'switch', 'catch', 'return']) {
    const d = ownDefinitions(`${kw} (x === sneaky) {}`);
    assert.ok(!d.has('sneaky'), `${kw}-condition token was absorbed as a param`);
  }
});

test('ownDefinitions keeps every param of a factory with call-expression defaults', () => {
  // The `\(([^()]*)\)` matcher could not cross the nested parens of a
  // `require(...)` default, so the group failed to match AS A WHOLE and every
  // name in it was lost — including the ones with no default at all. That is
  // what made tickets-store.js's injected fs/path read as free identifiers.
  const defs = ownDefinitions(
    "function createTicketsStore({ fs = require('fs'), path = require('path'), clodexHome } = {}) {\n}",
  );
  for (const n of ['fs', 'path', 'clodexHome']) {
    assert.ok(defs.has(n), `call-defaulted param list lost ${n}`);
  }
  // A plain CALL is not a definition — its arguments must not become defs, or
  // the gate goes blind on every name that appears as an argument anywhere.
  const callDefs = ownDefinitions('start(freeName, otherFree);');
  assert.ok(!callDefs.has('freeName'), 'call argument absorbed as a param');
  assert.ok(!callDefs.has('otherFree'), 'call argument absorbed as a param');
});

test('a class method name is a definition for the reverse gate, not for the forward one', () => {
  // The t380 defect: a class METHOD declaration binds a name, but only the
  // reverse gate may treat it as one. Without this, every method of a scanned
  // class reads as a dangling reference to itself (218 of them in
  // session-manager.js — the gate off, disguised as a whitelist).
  const cls = 'class M {\n  _taskAdd(body) { return this._taskDone(body); }\n}';
  assert.ok(definedNames(cls).has('_taskAdd'),
    'class method head not collected as a binding — the reverse gate will self-alarm');
  // …and the forward direction must NOT collect it: there, a name shared with
  // the coordinator scope is precisely the leak being hunted, so admitting a
  // method head as a local definition would mask it.
  assert.ok(!collectMethodParams(cls).has('_taskAdd'),
    'method head leaked into the forward scan defs, where it can mask a real leak');
  assert.ok(collectMethodParams(cls).has('body'),
    'method-shorthand param lost');
});

test('ownDefinitions collects method-shorthand params', () => {
  // collectParams covers arrows and `function (…)`, not object/class method
  // shorthand — which the replaced regex did cover. Losing it would newly
  // false-alarm on any shorthand method's parameters.
  const defs = ownDefinitions('const o = {\n  onData(chunk, { flush } = {}) { return chunk; },\n};');
  for (const n of ['chunk', 'flush']) {
    assert.ok(defs.has(n), `method-shorthand param list lost ${n}`);
  }
});

// Reverse-gate self-tests — lock the binding forms whose omission would
// false-alarm the dangling-ref scan, and prove a real dangler still surfaces.
// Each false-positive class here is one that a naive collector misses, letting
// a legitimate local read as an undefined reference.
test('definedNames captures the binding forms a naive collector misses', () => {
  // A nested-paren callback param — the shape that hid attn/geom/resultIndex.
  assert.ok(definedNames('api.on((id, geom) => { use(geom); });').has('geom'),
    'nested-paren callback param not collected');
  // A renamed object destructure — binding is the value side, not the key.
  assert.ok(definedNames('const { id: peerId } = entry.peer;').has('peerId'),
    'renamed destructure binding not collected');
  // An array destructure with holes.
  assert.ok(definedNames('const [, , settings, agentLib] = await all;').has('agentLib'),
    'array destructure binding not collected');
  // A comma declarator list WITH initializers — only the first name is caught
  // by the line-anchored collectors.
  const multi = definedNames('let first = null, last = null, turns = 0;');
  assert.ok(multi.has('last') && multi.has('turns'), 'later declarators in a list not collected');
  // A named function EXPRESSION inside an IIFE.
  assert.ok(definedNames('(async function initWorkspace() { loop(); })();').has('initWorkspace'),
    'named function expression not collected');
});

test('danglingRefs flags a reference whose binding was moved into a module', () => {
  // The R3 escape reproduced in miniature: a caller left behind after its
  // definition moved out, with no destructured binding to replace it. The two
  // production scope files must currently be clean (guarded by the loop above);
  // this locks that the scan actually FIRES on the escape, not just passes when
  // the file happens to be clean.
  const src = [
    "const { openFilesPopover } = initFilesPopover({ deps });",
    "window.api.onThing((key) => { openFilePeek(key); });",
  ].join('\n');
  const defs = definedNames(src);
  const used = new Set(stripCommentsStringsAndKeys(src).match(/\b[a-zA-Z_$][\w$]*\b/g) || []);
  const dangling = [...used].filter((n) => !defs.has(n) && !AMBIENT.has(n)).sort();
  assert.ok(dangling.includes('openFilePeek'),
    'the moved-out reference was not flagged as dangling');
  assert.ok(!dangling.includes('openFilesPopover'),
    'a properly destructured binding was wrongly flagged');
});
