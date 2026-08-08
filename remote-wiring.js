// Seams, not conveniences: persistence/uiSettings/workspaces are assigned in
// app.whenReady() and are still in TDZ when this factory runs, so they must
// cross as getters — a captured value stays undefined forever. remoteServer /
// remoteError are main.js singletons this module writes and other code reads,
// hence get+set. No electron require here: this runs under a headless host.

const { pathFor } = require('./clodex-paths');
// Exec grants are LOCAL-ONLY — this pure leaf sanitizes them off the wire in both
// directions (require-const, like pathFor above; no injected-seam needed).
const { withoutExecGrants, withoutLocalOnly } = require('./session-args');
// Registry-aware strip (t8 F1). NOT intent-catalog's: its PRIVILEGED_INTENTS Set
// knows only core's verbs, so it passes plugin verbs — which are forced
// privileged — straight through to a remote caller's grant.
const { withoutPrivilegedIntentsFor } = require('./intent-registry');
// Env scopes cross the wire on a create body — never trust the client: sanitize
// server-side (drops invalid/denied/newline keys) before it reaches create().
const { sanitizeFlat } = require('./env-scopes');
// The peer-terminal grant (t219). A pure leaf shared with peer-client and the
// renderer so the three cannot disagree about what the operator granted.
const { shellCapGranted } = require('./peer-shell');

function createRemoteWiring(deps) {
  const {
    path, fs, os, log,
    DEFAULT_WORKSPACE_ID, AGENT_NAME_RE, REGISTRY_DIR, OUTBOX_DIR, SELF_LABEL,
    parseCtxFile, jsonlToMessages, ensureDir, homeRelativize,
    claimOutbox, listOutboxOrigins,
    manager, proxyPoller,
    restartClodex, restartSession, peerProxyView,
    readSessionArgs, applySessionArgs,
    readSkillCatalog, applySessionSkills,
    fetchProxyContext, fetchProxyReport, fetchProxyBust,
    fetchSessionFiles, fetchFilePeek, fetchFileDiff,
    CLAUDE_TOOLS, getPromptLibrary, getAgentLibrary, getSkillLibrary,
    getPersistence, getUiSettings, getWorkspaces,
    getRemoteServer, setRemoteServer, setRemoteError, getDrawerPtys,
    readRemoteEnvToken, resolveRemoteToken,
    appVersion, isPackaged,
    // The browser frontend's host, or null when this host has none (t30). A
    // getter because web-host.js starts after the engine builds this wiring.
    getWebInfo,
  } = deps;

  function syncRemoteServer() {
    const s = getUiSettings().get();
    const envEnabled = process.env.CLODEX_REMOTE_ENABLE === '1';
    const enabled = s.remoteEnabled || envEnabled;
    const bindHost = process.env.CLODEX_REMOTE_HOST || '127.0.0.1';
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
          manager._deliverMessage(name, 'user', text, 'dm');
          return { ok: true };
        },
        restartApp: () => { log.info('app', 'restart requested remotely'); restartClodex(); },
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
          const sessionEnv = sanitizeFlat(b.env);
          const sessionEnvKeys = Object.keys(sessionEnv).sort();
          try {
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
              // Privileged intents (reboot) are stripped over the wire (Task 27):
              // a remote viewer isn't the box's local operator, so it can't grant a
              // box session an app-relaunch capability — mirror of the exec-grant
              // wire strip above. null passes through untouched.
              withoutPrivilegedIntentsFor(Array.isArray(b.intents) ? b.intents : null),
              // Session env (T46) — 19th positional. Already sanitized above; pass
              // null (not {}) when empty so create()'s conditional-omit persist and
              // no-scopes byte-identity both hold exactly as for a local spawn.
              sessionEnvKeys.length ? sessionEnv : null,
// mint=true: a peer spawn is a front door, never a restore — a remote adopt
// carries a resumeId and is still a mint. The axis is front-door-vs-restore,
// not resumeId: the frozen prompt baseline must regenerate, not be inherited.
              true,
            );
            // stripLevel isn't a create() param (it's a proxy-side override the
            // poller asserts once the session links) — seed it onto the entry after
            // create, EXPLICIT-only: the client is authoritative for a wire create,
            // so NO agentDefaults fallback (Decision 6). Absent key → no seed, box
            // behavior unchanged.
            if (b.stripLevel === 1 || b.stripLevel === 2) getPersistence().setStripLevel(name, b.stripLevel);
            if (getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
            log.info('session', `create ${name} (${t}) via peer @ ${dir} pid=${out.pid}`);
            return {
              ok: true, name: out.name, type: out.type, pid: out.pid,
// Echo the env keys actually applied so a caller can detect a silent drop by
// an older box. Keys only, never values — this is a read/ack surface.
              envKeys: sessionEnvKeys,
              ...(out.warnings && out.warnings.length ? { warnings: out.warnings } : {}),
            };
          } catch (e) {
            log.error('session', `create ${name} via peer failed: ${e.message}`);
            return { ok: false, error: `spawn failed: ${e.message}` };
          }
        },
        getCatalogs: () => ({
          agents: getAgentLibrary().list(),
          prompts: getPromptLibrary().list(),
          skills: getSkillLibrary().list(),
          claudeTools: CLAUDE_TOOLS,
          proxyUrl: getUiSettings().get().proxyUrl,
          proxyEnabled: getUiSettings().get().proxyEnabled,
        }),
        killSession: async (name) => {
          name = String(name || '').trim();
          const sess = manager.sessions.get(name);
          if (!sess) return { ok: false, error: `no such session "${name}"` };
          await manager.kill(name);
          if (getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
          log.info('session', `kill ${name} via peer`);
          return { ok: true, name };
        },
        restartSession: async (name, opts = {}) => {
          name = String(name || '').trim();
          const entry = getPersistence().get(name);
          const wsId = (entry && entry.workspaceId) || DEFAULT_WORKSPACE_ID;
          const out = await restartSession(name, { fresh: !!(opts && opts.fresh) }, wsId);
          if (out && out.ok && getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
          log.info('session', `restart ${name} via peer (${opts && opts.fresh ? 'fresh' : 'resume'})${out && out.ok ? '' : ` failed: ${out && out.error}`}`);
          return out;
        },
        getSessionArgs: (name) => {
          const base = readSessionArgs(name);
          if (!base || !base.ok) return base || { ok: false };
          // Exec grants AND session env (T46b) are LOCAL-ONLY — never expose the
          // box's grant list or env (values may be creds; there's no secret masking)
          // over the wire. readSessionArgs always includes both; withoutLocalOnly
          // drops execCommands + env in one named barrier (pinned both directions).
          return {
            ...withoutLocalOnly(base),
            catalogs: {
              agents: base.agentCatalog || [],
              prompts: getPromptLibrary().list(),
              claudeTools: CLAUDE_TOOLS,
              proxyUrl: getUiSettings().get().proxyUrl,
              proxyEnabled: getUiSettings().get().proxyEnabled,
            },
          };
        },
        setSessionArgs: async (name, patch) => {
          name = String(name || '').trim();
          const entry = getPersistence().get(name);
          const wsId = (entry && entry.workspaceId) || DEFAULT_WORKSPACE_ID;
// Backstop: a peer can never set the box's exec allowlist or session env —
// dropping both leaves each undefined = untouched by the resolver. Same for
// privileged intents on a requested allowlist (a plain intents edit still applies).
          const safePatch = withoutLocalOnly(patch || {});
          if (Array.isArray(safePatch.intents)) safePatch.intents = withoutPrivilegedIntentsFor(safePatch.intents);
          const out = await applySessionArgs(name, safePatch, wsId);
          if (out && out.ok && out.restarted && getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
          log.info('session', `setArgs ${name} via peer${out && out.ok ? (out.restarted ? ' (respawned)' : '') : ` failed: ${out && out.error}`}`);
          return out;
        },
        getSkillCatalog: (name) => readSkillCatalog(name),
        setSessionSkills: (name, disabledSkills, injectSkills) => {
          name = String(name || '').trim();
          const out = applySessionSkills(name, disabledSkills, injectSkills);
          log.info('session', `setSkills ${name} via peer${out && out.ok ? '' : ` failed: ${out && out.error}`}`);
          return out;
        },
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
          // The WIRE field stays `delivered` — it is the peer protocol and an older
          // Clodex on the far side reads exactly that key. Only the local return was
          // renamed to `queued` (it is a queue acceptance, not a write), so this is
          // the one place the two vocabularies meet. Do not "tidy" them into one.
          if (r.queued) return { ok: true, delivered: true };
          if (r.parked) return { ok: true, parked: r.parked };
          const why = r.held || r.error || 'not delivered';
          log.info('peer', `dm from ${senderTag} to ${to} not delivered: ${why}`);
          return { ok: false, error: why };
        },
        claimDms: (origin) => {
          const messages = claimOutbox(OUTBOX_DIR, origin);
          if (messages.length) log.info('peer', `outbox claim by ${origin}: ${messages.length} message(s)`);
          return messages;
        },
        listDmOrigins: () => listOutboxOrigins(OUTBOX_DIR),
// Presence of this callback is what advertises the 'relay' cap in the hello.
        receiveRoster: ({ via, roster }) => {
          manager._setRelayRoster(via, roster);
          log.info('peer', `relay roster from ${via}: ${roster.length} agent(s)`);
        },
        // ---- Peer terminal (t219) ----
        // Spread, not four properties: the four are passed TOGETHER or not at
        // all, and `shell` in the hello is derived from wtermOpen's presence, so
        // splitting them would let a box advertise a terminal it cannot drive.
        ...wtermCallbacks(),
        // Deliberately OUTSIDE the bundle and never reconciled with the grant:
        // this is the seat indicator, and the moment it matters most is
        // revocation, when the streams close and the operator must watch the
        // marks go out. Wired into the grant, it would be nulled before the
        // final empty report and every seat would stay marked forever.
        onWtermStreams: (seats) => manager._broadcast('served-terminals', seats),
        hostLabel: SELF_LABEL,
        version: appVersion,
        srcDir: isPackaged() ? null : homeRelativize(__dirname, os.homedir()),
        getWebInfo: typeof getWebInfo === 'function' ? getWebInfo : () => null,
        getAttachInfo: (name) => {
          const sess = manager.sessions.get(name);
          if (!sess || sess._dead) return { ok: false };
          return {
            ok: true,
            scrollback: Buffer.from(sess.scrollback || '', 'utf8'),
            cols: sess.pty.cols, rows: sess.pty.rows,
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
          manager.resize(name, cols, rows, 'peer-control');
          return { ok: true };
        },
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
    // Reconciled on EVERY sync, not only at construct: the server outlives a
    // grant toggle, so a constructor-only wiring would leave the capability
    // frozen at whatever it was when the box started serving. The setter owns
    // the close-before-drop ordering.
    const wterm = wtermCallbacks();
    getRemoteServer().setWtermCallbacks(wterm.wtermOpen ? wterm : null);
    setRemoteError(null);
    getRemoteServer().start().catch((e) => {
      setRemoteError(e.message);
      setRemoteServer(null);
    });
  }

  // The four peer-terminal callbacks, or an all-null bundle when nothing grants
  // it. Returning nulls rather than omitting the keys keeps the shape constant
  // for the spread at construct; remote.js turns absence into a 501 and a
  // missing `shell` cap either way.
  //
  // The grant is re-read HERE on every call, so a revoked grant cannot be
  // outlived by a callback captured earlier. Belt to the setter's braces: the
  // reconcile drops the callbacks, and if one somehow survived, `granted()`
  // inside each closure refuses anyway.
  function wtermCallbacks() {
    const granted = () => shellCapGranted(getUiSettings().get());
    if (!granted()) return { wtermOpen: null, wtermInput: null, wtermResize: null, wtermClose: null };

    // A peer's terminal is the seat's OWN drawer shell in the window that owns
    // the seat, never a shell of its own. That is the shared-PTY ruling, and it
    // is what makes a remote shell visible — but only under a precondition the
    // ruling does not state and this file has to enforce: that the window
    // exists. `wtermOpen`'s windowForWorkspace check below is the line that
    // makes the sentence above true; without it the shell is real and the tab
    // it is supposed to be visible in is not.
    const wsFor = (seat) => {
      const sess = manager.sessions.get(seat);
      return sess ? sess.workspaceId : null;
    };
    const chip = (seat, kind, body) => {
      manager._broadcast('ipc-message', { ts: Date.now(), from: 'peer', to: seat, kind, body });
      log.info('peer', body);
    };

    return {
      wtermOpen: (seat, ctx) => {
        if (!granted()) return { ok: false, error: 'terminal sharing is not enabled on this box' };
        const w = getDrawerPtys && getDrawerPtys();
        // A host with drawer services off has no terminals to share. The peer
        // terminal INHERITS that refusal rather than building its own PTY —
        // routing around it would resurrect the hazard that gate exists for.
        // `code` picks the HTTP status remote.js answers with, and the status is
        // what the consumer reads: a config bit of this box is 501, a missing
        // seat is 404. Without it both arrive as 404 and the remote operator is
        // sent looking for a session that was never the problem.
        if (!w) return { ok: false, code: 'no-services', error: 'drawer terminals are unavailable on this box' };
        const ws = wsFor(seat);
        if (!ws) return { ok: false, code: 'no-seat', error: 'no such session' };
        // A session OUTLIVES its window (main.js's `closed` handler kills the
        // workspace's drawer PTYs and leaves the session), so a live session is
        // not evidence that anything is on screen. Spawning here would hand a
        // peer a fresh login shell in a workspace the operator has closed: the
        // mark is a sidebar row attribute, the row lives only in that
        // workspace's own window, and engine's `send` no-ops without one — so
        // the announcement lands nowhere and the heartbeat re-asserts it into
        // the void. With no windows open at all (normal on macOS, the app lives
        // in the tray) there is nothing on screen to see it.
        //
        // `no-seat` rather than a code of its own: from the consumer's side a
        // seat whose window is closed is unreachable in the same way a missing
        // one is, and a distinct code would invite a retry loop against a state
        // only the local operator can change.
        if (!manager.windowForWorkspace(ws)) return { ok: false, code: 'no-seat', error: 'no such session' };
        const out = w.spawn(ws, seat, {});
        if (!out || !out.ok) return out || { ok: false, error: 'could not open a terminal' };
        // Never silent — but a flaky tunnel reconnects the SAME viewer to the
        // SAME shell every few seconds, and an ops log that says "a peer opened
        // your terminal" twelve times a minute is one the operator stops
        // reading, which costs exactly the property this row exists for. Both
        // halves have to be true to call it a reconnect: `out.fresh === false`
        // says the shell was already running (a resumed one is not a new
        // exposure), and `ctx.attached` says a stream was still watching it at
        // the moment this one arrived. A reconnect after a real detach is a new
        // remote party and still announces.
        const reconnect = out.fresh === false && !!(ctx && ctx.attached);
        if (!reconnect) chip(seat, 'peer-terminal-open', `a peer opened the terminal for ${seat}`);
        return { ok: true, scrollback: Buffer.from(out.scrollback || '', 'utf8'), cols: out.cols, rows: out.rows };
      },
      wtermInput: (seat, data) => {
        if (!granted()) return { ok: false, error: 'terminal sharing is not enabled on this box' };
        const w = getDrawerPtys && getDrawerPtys();
        const ws = wsFor(seat);
        if (!w || !ws) return { ok: false, error: 'no such session' };
        return w.write(ws, seat, data) ? { ok: true } : { ok: false, error: 'no terminal for that seat' };
      },
      wtermResize: (seat, cols, rows) => {
        if (!granted()) return { ok: false, error: 'terminal sharing is not enabled on this box' };
        const w = getDrawerPtys && getDrawerPtys();
        const ws = wsFor(seat);
        if (!w || !ws) return { ok: false, error: 'no such session' };
        return w.resize(ws, seat, cols, rows) ? { ok: true } : { ok: false, error: 'no terminal for that seat' };
      },
      // Detach only. The shell stays: it is the local operator's, their tab is
      // showing it, and a remote party closing its view must not close their
      // terminal.
      wtermClose: (seat) => {
        chip(seat, 'peer-terminal-close', `a peer closed its view of the terminal for ${seat}`);
        return { ok: true };
      },
    };
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
