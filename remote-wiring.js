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
    getRemoteServer, setRemoteServer, setRemoteError,
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
          if (r.delivered) return { ok: true, delivered: true };
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
