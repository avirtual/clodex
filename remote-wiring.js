// remote-wiring.js — the RemoteServer construction + reconciliation, extracted
// verbatim from main.js (M5). createRemoteWiring(deps) returns { syncRemoteServer };
// main.js destructures it so its existing call sites stay byte-identical.
//
// Move-only. Body changes are seams only:
//   * store getters — persistence, uiSettings, workspaces are `let`s assigned in
//     app.whenReady(), still in TDZ when this factory runs at module eval, so they
//     cross as lazy getters (a captured value would be undefined).
//   * remoteServer / remoteError are main.js `let` singletons THIS function writes
//     and other main.js code reads; they cross as get+set (getRemoteServer /
//     setRemoteServer / setRemoteError) — the M4 appQuitting/setAppQuitting pattern.
// manager and proxyPoller are module-eval `const` defined before the call site, so
// they value-inject with zero seams. Everything else (path/fs/os, the require-const
// helpers, the hoisted fns restartClodex/restartSession/peerProxyView/fetch*) is
// stable and value-injected byte-identical. The two former electron reads cross as
// seams — `appVersion` by value (package.json version; Electron's getVersion()
// reads the same field, so it's host-agnostic) and `isPackaged()` as a getter fn
// (same pattern wirescope-supervisor uses) — so this module holds NO electron
// require and runs unchanged under a headless host.

const { pathFor } = require('./clodex-paths');
// Exec grants are LOCAL-ONLY — this pure leaf sanitizes them off the wire in both
// directions (require-const, like pathFor above; no injected-seam needed).
const { withoutExecGrants } = require('./session-args');

function createRemoteWiring(deps) {
  const {
    // node builtins + stable consts
    path, fs, os, log,
    DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, REGISTRY_DIR, OUTBOX_DIR, SELF_LABEL,
    // require-const helpers
    parseCtxFile, jsonlToMessages, ensureDir, homeRelativize,
    claimOutbox, listOutboxOrigins,
    // live objects (module-eval const at call site) — value-injected
    manager, proxyPoller,
    // hoisted helpers (shared with ipc-handlers; stay in main.js, injected)
    restartClodex, restartSession, peerProxyView,
    readSessionArgs, applySessionArgs,
    readSkillCatalog, applySessionSkills,
    fetchProxyContext, fetchProxyReport, fetchProxyBust,
    fetchSessionFiles, fetchFilePeek, fetchFileDiff,
    // Edit Session catalogs: CLAUDE_TOOLS is a load-time const (value); the
    // libraries are whenReady-assigned stores read at request time (getters).
    // getAgentLibrary/getSkillLibrary back the session-less GET /api/catalogs.
    CLAUDE_TOOLS, getPromptLibrary, getAgentLibrary, getSkillLibrary,
    // store getters (whenReady-assigned / TDZ at factory call)
    getPersistence, getUiSettings, getWorkspaces,
    // mutable singletons (get+set, M4 pattern)
    getRemoteServer, setRemoteServer, setRemoteError,
    // GUI-managed operator token (remote-token.js, bound to userData in engine):
    // the file-backed fallback for the wire gate. resolveRemoteToken applies the
    // env-wins precedence.
    readRemoteEnvToken, resolveRemoteToken,
    // host seams (former electron reads): version by value, isPackaged as getter
    appVersion, isPackaged,
  } = deps;

  function syncRemoteServer() {
    const s = getUiSettings().get();
    // The web-frontend container has no GUI to toggle remote access in, so
    // CLODEX_REMOTE_ENABLE=1 brings the peer wire up at first boot with no
    // settings write and no exec-in. The desktop never sets it, so its behavior is
    // driven purely by the Preferences toggle as before. CLODEX_REMOTE_HOST widens
    // the bind (0.0.0.0 in the image) so a loopback-mapped host port can publish it.
    const envEnabled = process.env.CLODEX_REMOTE_ENABLE === '1';
    const enabled = s.remoteEnabled || envEnabled;
    const bindHost = process.env.CLODEX_REMOTE_HOST || '127.0.0.1';
    // Operator auth (docs/remote-auth-plan.md §2). CLODEX_REMOTE_TOKEN gates the
    // whole wire; CLODEX_REMOTE_INSECURE=1 is the loud escape hatch that lets a
    // non-loopback bind serve with no token (fleet-migration only) — logged so
    // it can never be silently on.
    // Env var WINS (explicit override; keeps every existing env-var deployment
    // working), else the GUI-managed <userData>/remote.env token, else null
    // (localhost-trust). readRemoteEnvToken is injected bound to userData.
    const remoteToken = resolveRemoteToken(process.env.CLODEX_REMOTE_TOKEN, readRemoteEnvToken());
    const remoteInsecure = process.env.CLODEX_REMOTE_INSECURE === '1';
    if (remoteInsecure) {
      log.error('remote', 'CLODEX_REMOTE_INSECURE=1 — the remote wire will serve with NO operator token on a non-loopback bind. This is insecure; set CLODEX_REMOTE_TOKEN and remove the flag.');
    }
    if (!enabled) {
      if (getRemoteServer()) { getRemoteServer().stop(); setRemoteServer(null); }
      setRemoteError(null);
      return;
    }
    if (getRemoteServer() && getRemoteServer().port !== s.remotePort) {
      getRemoteServer().stop();
      setRemoteServer(null);
    }
    if (!getRemoteServer()) {
      const { RemoteServer } = require('./remote');
      setRemoteServer(new RemoteServer({
        port: s.remotePort,
        host: bindHost,
        token: remoteToken,
        insecure: remoteInsecure,
        pagePath: path.join(__dirname, 'renderer', 'remote.html'),
        getSessions: () =>
          // Agents AND bash: bash sessions are IPC-private (no registry/socket/who)
          // but ARE exposed on the peer surface for visibility/attach/control. The
          // wire payload carries sess.type so the viewer buckets bash like a local
          // bash row (no ctx badge/telemetry — the stats below come back null for
          // an unrouted bash session, which the viewer already tolerates).
          Array.from(manager.sessions.values())
            .filter(sess => !sess._dead)
            .map(sess => {
              // Same sources as the GUI status bar: proxy telemetry snapshot
              // (model/cost/requests/live tokens) + the statusline ctx
              // side-channel (window size; token fallback for unrouted sessions).
              // snapshot() returns the shaped payload itself (renderer's
              // {at, payload} wrapper is renderer-side only)
              const p = proxyPoller.snapshot(sess.name);
              let ctx = null;
              try {
                ctx = parseCtxFile(fs.readFileSync(pathFor(REGISTRY_DIR, sess.name, 'ctx'), 'utf-8'));
              } catch {}
              const wireTok = p && p.context && typeof p.context.inputTokens === 'number'
                ? p.context.inputTokens : null;
              return {
                name: sess.name,
                type: sess.type,
                cwd: sess.cwd,
                workspace: (getWorkspaces().get(sess.workspaceId) || {}).name || '',
                stats: {
                  model: (p && p.model) || null,
                  cost: p && p.cost && p.cost.usd != null ? p.cost.usd : null,
                  requests: p && p.cost && p.cost.requests != null ? p.cost.requests : null,
                  ctxTok: wireTok != null ? wireTok : (ctx && ctx.tok) || null,
                  ctxSize: (ctx && ctx.size) || null,
                  ctxPct: (ctx && ctx.pct != null) ? ctx.pct : null,
                },
              };
            }),
        getTranscript: (name, limit) => {
          const sess = manager.sessions.get(name);
          if (!sess || !sess.agentType) return { ok: false, error: 'Session not found' };
          const linkPath = pathFor(REGISTRY_DIR, name, 'transcript');
          let jsonlPath;
          try { jsonlPath = fs.realpathSync(linkPath); }
          catch { return { ok: true, messages: [] }; } // no transcript yet
          try { return { ok: true, messages: jsonlToMessages(jsonlPath, limit) }; }
          catch (e) { return { ok: false, error: e.message }; }
        },
        send: (name, text) => {
          const sess = manager.sessions.get(name);
          if (!sess || !sess.agentType || sess._dead) return { ok: false, error: 'Session not found' };
          // Same path as the app's own panel: agents see "[agent:from user]",
          // oversized bodies ride the spill channel.
          manager._deliverMessage(name, 'user', text, 'dm');
          return { ok: true };
        },
        // Remote-triggered full relaunch: the normal quit path (before-quit →
        // killAll) then a fresh instance — sessions --resume, the managed
        // wirescope survives (detached) and the new launch's version check
        // picks up any pending vendor bump. Delay lets the HTTP response and
        // the ingress hop flush before the server dies under them.
        restartApp: () => { log.info('app', 'restart requested remotely'); restartClodex(); },
        // Remote session create — the FULL-param body (M5). Routes to the LIVE
        // create() path (auto-persists, exactly like [agent:spawn]), so a peer
        // becomes a cockpit for the headless box: no ssh + seed-script + restart.
        // Trust is the tunnel (settled); no token. The viewer can't see this box's
        // dialogs, so the ack IS the whole story — every failure mode returns a
        // DISTINGUISHABLE error string, and referential warnings ride out non-fatal.
        // Bare {name,type,cwd} keeps today's exact behavior: every absent key falls
        // to the SAME default the M3 hardcoded call passed. Defaults mirror the
        // spawn intent: workspace 'default' (no requesting session here to inherit
        // from), cwd created if absent (ensureDir).
        createSession: async (body = {}) => {
          // Exec grants NEVER cross the wire (Decision 2) — strip any the client
          // sent before mapping (mirror of the setSessionArgs backstop), and force
          // execCommands [] into create() regardless. The renderer never sends them.
          const b = withoutExecGrants(body) || {};
          const name = String(b.name || '').trim();
          const type = b.type;
          const t = (type === 'codex') ? 'codex' : (type === 'claude') ? 'claude' : (type === 'bash') ? 'bash' : null;
          const rawCwd = String(b.cwd || '').trim();
          if (!AGENT_NAME_RE.test(name)) {
            return { ok: false, error: `invalid name "${name}" — allowed [a-zA-Z0-9._-], 1-64 chars` };
          }
          // bash rides the peer surface for visibility/attach/control, but stays
          // IPC-private (no registry/socket/who) exactly like a local bash session.
          if (!t) return { ok: false, error: `invalid type "${type}" — must be claude, codex, or bash` };
          if (manager.sessions.has(name) || getPersistence().get(name)) {
            return { ok: false, error: `name taken "${name}"` };
          }
          if (!rawCwd) return { ok: false, error: 'cwd required' };
          const dir = path.resolve(rawCwd.replace(/^~(?=$|\/)/, os.homedir()));
          try {
            ensureDir(dir); // create the cwd if absent — mirrors [agent:spawn]
          } catch (e) {
            return { ok: false, error: `cannot create cwd "${dir}": ${e.message}` };
          }
          try {
            // Map the wire body onto create()'s 18-param positional signature
            // (session-manager.js:610). Each `|| default` reproduces the value the
            // M3 hardcoded call passed for an absent key. systemPromptBody stays
            // null (F2 — legacy inline body is never authored at create);
            // execCommands stays [] (grants never cross); workspaceId is 'default'.
            const out = await manager.create(
              name, t, dir,
              b.extraArgs || [],
              b.resumeId || null,
              DEFAULT_WORKSPACE_ID,
              null,            // systemPromptBody — F2
              !!b.fork,
              b.proxy ?? null,
              b.agents || [],
              b.denyBuiltins || [],
              b.disabledTools || [],
              b.disabledSkills || [],
              b.injectSkills || [],
              b.systemPromptFile || null,
              b.appendPromptFiles || [],
              [],              // execCommands — never cross the wire
              Array.isArray(b.intents) ? b.intents : null,
            );
            // stripLevel isn't a create() param (it's a proxy-side override the
            // poller asserts once the session links) — seed it onto the entry after
            // create, EXPLICIT-only: the client is authoritative for a wire create,
            // so NO agentDefaults fallback (Decision 6). Absent key → no seed, box
            // behavior unchanged.
            if (b.stripLevel === 1 || b.stripLevel === 2) getPersistence().setStripLevel(name, b.stripLevel);
            if (getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
            log.info('session', `create ${name} (${t}) via peer @ ${dir} pid=${out.pid}`);
            // Forward create()'s non-fatal warnings (unresolved skill/agent refs
            // against THIS box's libraries) so slice 4's create toast reads one
            // shape whether the session is local or on a peer.
            return {
              ok: true, name: out.name, type: out.type, pid: out.pid,
              ...(out.warnings && out.warnings.length ? { warnings: out.warnings } : {}),
            };
          } catch (e) {
            log.error('session', `create ${name} via peer failed: ${e.message}`);
            return { ok: false, error: `spawn failed: ${e.message}` };
          }
        },
        // Session-less catalogs for a pre-create New Session dialog targeting this
        // box (M5). A SUPERSET of getSessionArgs' catalogs block: same agents/
        // prompts/tools/proxy sources PLUS skills. The edit path reads skills from
        // the separate per-session skill-catalog endpoint (it needs a roster) —
        // there's none pre-create, so skills = the box's raw library list. agents is
        // the box's FULL agent library too: getSessionArgs scope-filters by session,
        // but there's no session to scope by here, and create-time scoping happens
        // box-side at spawn anyway. Rides the existing 'create' cap.
        getCatalogs: () => ({
          agents: getAgentLibrary().list(),
          prompts: getPromptLibrary().list(),
          skills: getSkillLibrary().list(),
          claudeTools: CLAUDE_TOOLS,
          proxyUrl: getUiSettings().get().proxyUrl,
          proxyEnabled: getUiSettings().get().proxyEnabled,
        }),
        // Remote session kill — user-initiated semantics (removes from persistence,
        // no resume), same as the UI's kill. Ack distinguishes not-found from done.
        killSession: async (name) => {
          name = String(name || '').trim();
          const sess = manager.sessions.get(name);
          // Bash included (peer-visible) — gate on existence only, not agentType.
          if (!sess) return { ok: false, error: `no such session "${name}"` };
          await manager.kill(name);
          if (getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
          log.info('session', `kill ${name} via peer`);
          return { ok: true, name };
        },
        // Remote session restart — routes to the SHARED restartSession() so the
        // strip-level re-assert + failed-respawn safety net match the local path
        // exactly. Respawn lands in the entry's own workspace (no requesting
        // window here to inherit from). {fresh} picks the two affordances the
        // viewer offers: plain restart (--resume, keeps history) vs fresh reload
        // (new conversation, re-reads skills/agents). Ack is distinguishable
        // (not-found vs respawn-failure-with-"session kept"), same as create/kill.
        restartSession: async (name, opts = {}) => {
          name = String(name || '').trim();
          const entry = getPersistence().get(name);
          const wsId = (entry && entry.workspaceId) || DEFAULT_WORKSPACE_ID;
          const out = await restartSession(name, { fresh: !!(opts && opts.fresh) }, wsId);
          if (out && out.ok && getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
          log.info('session', `restart ${name} via peer (${opts && opts.fresh ? 'fresh' : 'resume'})${out && out.ok ? '' : ` failed: ${out && out.error}`}`);
          return out;
        },
        // Remote session args read — the Edit Session dialog's source of truth for
        // a peer session. Returns EXACTLY what session:getArgs returns (via the
        // shared readSessionArgs) PLUS the box's catalogs the dialog's checklists
        // render from: the agent library, the prompt library (system+append), the
        // static claude-tools list, and the box proxy default. The viewer never
        // uses its own libraries for a remote edit — the box's are the truth for
        // its sessions. Unknown name → { ok:false } (endpoint maps to 404).
        getSessionArgs: (name) => {
          const base = readSessionArgs(name);
          if (!base || !base.ok) return base || { ok: false };
          // Exec grants are a LOCAL-ONLY capability — never expose the box's grant
          // list over the wire (a viewer can't read nor edit it; readSessionArgs
          // always includes execCommands, so strip it here explicitly).
          return {
            ...withoutExecGrants(base),
            catalogs: {
              // Agents catalog is the SCOPE-FILTERED list readSessionArgs already
              // resolved for this box session (base.agentCatalog) — so a remote
              // edit is offered exactly the box's in-scope agents, no more than a
              // local edit would be. Prompts/tools are unscoped.
              agents: base.agentCatalog || [],
              prompts: getPromptLibrary().list(),
              claudeTools: CLAUDE_TOOLS,
              proxyUrl: getUiSettings().get().proxyUrl,
              proxyEnabled: getUiSettings().get().proxyEnabled,
            },
          };
        },
        // Remote session args apply — routes to the SHARED applySessionArgs so the
        // undefined-untouched semantics, stripLevel/label re-assert and catch-upsert
        // recovery match the local path exactly. Respawn lands in the entry's OWN
        // workspace (no requesting window here), mirroring the restart callback.
        // restart:true kills+respawns; the owner's kill emits the SSE exit that the
        // attached viewer reattaches off, and notifySessions refreshes the list.
        setSessionArgs: async (name, patch) => {
          name = String(name || '').trim();
          const entry = getPersistence().get(name);
          const wsId = (entry && entry.workspaceId) || DEFAULT_WORKSPACE_ID;
          // Strip any exec grants off the inbound patch — a peer can NEVER set the
          // box's local exec allowlist (the renderer already omits it on a peer edit;
          // this is the belt-and-suspenders backstop). withoutExecGrants drops the key
          // entirely, so the resolver sees it as undefined = the box's grants untouched.
          const out = await applySessionArgs(name, withoutExecGrants(patch || {}), wsId);
          if (out && out.ok && out.restarted && getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
          log.info('session', `setArgs ${name} via peer${out && out.ok ? (out.restarted ? ' (respawned)' : '') : ` failed: ${out && out.error}`}`);
          return out;
        },
        // Remote skill catalog read — the Skills popover's source of truth for a peer
        // session (Phase 2, same 'args' cap). Returns EXACTLY what session:skillCatalog
        // returns via the shared readSkillCatalog: the roster is parsed BOX-side and
        // skillLib is the BOX's library, both correct because inject-skills materialize
        // at spawn time on the box. No extra catalogs needed — the shape is self-
        // contained. Unknown name → { ok:false } (endpoint maps to 404).
        getSkillCatalog: (name) => readSkillCatalog(name),
        // Remote skill gating apply — routes to the SHARED applySessionSkills (persist-
        // only; injectSkills optional). No restart here — the popover makes a separate
        // /api/session-restart call when the user asks to apply now; the roster is
        // frozen at conversation creation.
        setSessionSkills: (name, disabledSkills, injectSkills) => {
          name = String(name || '').trim();
          const out = applySessionSkills(name, disabledSkills, injectSkills);
          log.info('session', `setSkills ${name} via peer${out && out.ok ? '' : ` failed: ${out && out.error}`}`);
          return out;
        },
        // ---- DM federation (Clodex-to-Clodex agent messaging) ----
        // Inbound dm from a consumer: remember the origin (so this box can route
        // replies back to its outbox), run the SAME cost-gate/park path a local dm
        // takes via _gatedDeliver, and map the verdict onto the HTTP-shaped
        // response the sender reads. senderTag = from@origin so the recipient's
        // reply trailer teaches an address that routes back.
        deliverDm: ({ to, from, origin, body, urgent }) => {
          manager._knownDmOrigins.add(origin);
          // A bare `from` is a direct DM — qualify it with the origin that dialed us.
          // An already-qualified `from` (contains '@') is the terminal leg of a
          // relayed DM: the originating spoke's fully-qualified sender, carried
          // through unchanged (sacred). Use it as the senderTag directly so the
          // recipient's reply routes back to the TRUE origin, not the relay hub.
          const senderTag = from.includes('@') ? from : `${from}@${origin}`;
          const r = manager._gatedDeliver(to, senderTag, body, urgent === true);
          manager._broadcast('ipc-message', { type: 'dm', from: senderTag, to, body: `WIRE←${origin}: ${body}` });
          if (r.delivered) return { ok: true, delivered: true };
          if (r.parked) return { ok: true, parked: r.parked };
          // held (Codex/dead target) or error (not a local agent) → bounce; the
          // reason rides the response so the remote sender sees why.
          const why = r.held || r.error || 'not delivered';
          log.info('peer', `dm from ${senderTag} to ${to} not delivered: ${why}`);
          return { ok: false, error: why };
        },
        // Outbox claim: hand the consumer every reply queued under its label.
        claimDms: (origin) => {
          const messages = claimOutbox(OUTBOX_DIR, origin);
          if (messages.length) log.info('peer', `outbox claim by ${origin}: ${messages.length} message(s)`);
          return messages;
        },
        // Advertise which origins have mail waiting, so a consumer only claims when
        // there's something to fetch.
        listDmOrigins: () => listOutboxOrigins(OUTBOX_DIR),
        // ---- hub-relay federation (spoke side) ----
        // A hub (a consumer of this box) pushed us its relay roster — the agents on
        // its OTHER peers we're permitted to reach, keyed by `via` (the hub's label).
        // Cache it as our via-table so [agent:who] can surface them and
        // _routeFederatedDm can relay a dm out through `via`. Presence of this
        // callback is what advertises the 'relay' cap in the hello.
        receiveRoster: ({ via, roster }) => {
          manager._setRelayRoster(via, roster);
          log.info('peer', `relay roster from ${via}: ${roster.length} agent(s)`);
        },
        // ---- peer-attach surface (Clodex-to-Clodex) ----
        hostLabel: SELF_LABEL,
        version: appVersion,
        // Self-report our install dir (home-relative) so a consumer's Update pulls
        // THIS checkout, not a guessed default. Packaged builds report null — an
        // .app bundle isn't a git-pullable source and the ssh update path doesn't
        // apply. main.js sits at the repo root, so __dirname IS the checkout.
        srcDir: isPackaged() ? null : homeRelativize(__dirname, os.homedir()),
        getAttachInfo: (name) => {
          const sess = manager.sessions.get(name);
          // Bash included: attach mirrors the raw PTY (scrollback + geometry),
          // which every session type maintains. The telemetry seed below is
          // agent-shaped but degrades to nulls for bash (no proxy/ctx), harmless.
          if (!sess || sess._dead) return { ok: false };
          return {
            ok: true,
            scrollback: Buffer.from(sess.scrollback || '', 'utf8'),
            cols: sess.pty.cols, rows: sess.pty.rows,
            // Status-bar seed so the viewer's bar fills with the replay
            // instead of waiting out the first poll tick. The files count seeds
            // the 📄N badge baseline (the viewer treats a seed as baseline, not a
            // change, so it doesn't light the unseen highlight on attach).
            telemetry: {
              proxy: peerProxyView(proxyPoller.snapshot(name)),
              ctx: sess.ctxInfo || null,
              files: { count: (sess.fileTouches || []).length },
            },
          };
        },
        sendInput: (name, data) => {
          const sess = manager.sessions.get(name);
          if (!sess || sess._dead) return { ok: false, error: 'Session not found' };
          manager.write(name, data);
          return { ok: true };
        },
        resizePty: (name, cols, rows) => {
          const sess = manager.sessions.get(name);
          if (!sess || sess._dead) return { ok: false, error: 'Session not found' };
          // Tag the requester: this callback is only ever reached by a token-gated
          // control-holder, so a resize logged as 'peer-control' is the by-design
          // authority path — the arbiter for owner-side perturbation reports.
          manager.resize(name, cols, rows, 'peer-control');
          return { ok: true };
        },
        // Popover data pull (viewer's ctx/cost/bust/files/file-peek popups).
        // Fixed kind whitelist; agent sessions only (bash stays private, same
        // as the session list). For ctx the owner decides the utilization
        // opt-in from its own capabilities — the viewer doesn't hold them.
        query: (name, kind, args) => {
          const sess = manager.sessions.get(name);
          if (!sess || !sess.agentType || sess._dead) return { ok: false, error: 'no such session' };
          const a = args || {};
          switch (kind) {
            case 'ctx': {
              const snap = proxyPoller.snapshot(name);
              const caps = (snap && snap.capabilities) || {};
              return fetchProxyContext(name, { utilization: !!(caps.context_utilization || caps.context_skills) });
            }
            case 'report': return fetchProxyReport(name, { detail: !!a.detail });
            case 'bust': return fetchProxyBust(name);
            case 'files': return fetchSessionFiles(name);
            case 'filePeek': return fetchFilePeek(String(a.path || ''));
            case 'fileDiff': return fetchFileDiff(name, String(a.path || ''));
            default: return { ok: false, error: `unknown query kind: ${kind}` };
          }
        },
        // Owner-side visibility: chip on the session tab + a line in the IPC
        // log, so a controlled session is never silently driven.
        onControlChange: (name, holder) => {
          manager._sendToSession(name, 'session-peer-control', name, holder);
          manager._broadcast('ipc-message', {
            ts: Date.now(), from: holder || 'peer', to: name,
            kind: holder ? 'peer-control' : 'peer-release',
            body: holder ? `${holder} took control of ${name}` : `remote control of ${name} released`,
          });
          log.info('peer', holder ? `${holder} took control of ${name}` : `control of ${name} released`);
        },
      }));
    }
    setRemoteError(null);
    getRemoteServer().start().catch((e) => {
      setRemoteError(e.message);
      setRemoteServer(null);
    });
  }

  // The RemoteServer reads its operator token only at construct, so a token
  // change (remote:setToken) must tear down any live server before reconciling —
  // syncRemoteServer's own stop/start only fires on a port change or a toggle.
  // Forcing the teardown here makes the new gate live immediately.
  function refreshRemoteToken() {
    if (getRemoteServer()) { getRemoteServer().stop(); setRemoteServer(null); }
    syncRemoteServer();
  }

  return { syncRemoteServer, refreshRemoteToken };
}

module.exports = { createRemoteWiring };
