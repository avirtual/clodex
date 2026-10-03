'use strict';

const fs = require('fs');
const { randomUUID, randomBytes } = require('crypto');
const { removeSeat } = require('./seat-layout');

const SCRATCH_CLONE_REFUSAL = 'you are a scratch clone — put it in your summary; only [agent:scratch end] and harness subagents are yours';

function scratchCloneBrief(parentName, brief) {
  return `You are a scratch clone of ${parentName}. Do exactly this, then end with [agent:scratch end] <summary> `
    + '(closed by [agent:end]); you receive no messages and your other intents are refused:\n' + brief;
}

function createScratchCloneMethods(deps, shared) {
  const {
    getPersistence, ProxyClient, log, stripLevelOf, AGENT_NAME_RE, DEFAULT_WORKSPACE_ID,
    effectiveInjectedAgents, effectiveInjectedSkills, REGISTRY_DIR,
  } = deps;
  const { SCRATCH_CLONE_CEILING_MS } = shared;

  return {
    _scratchCloneStripLevel(parent) {
      const poller = this._proxyPoller;
      const shaped = poller && poller.last instanceof Map ? poller.last.get(parent.name) : null;
      const ps = shaped && shaped.sessionId === parent.sessionId && shaped.strip ? shaped.strip : null;
      const globalOn = !!(ps && (ps.globalDefaultLevel || 0) >= 1);
      const asserted = poller && poller.stripAsserted instanceof Map ? poller.stripAsserted.get(parent.name) : null;
      if (asserted && asserted.sessionId === parent.sessionId && typeof asserted.level === 'number') {
        return { level: asserted.level, explicitZero: asserted.level === 0 && globalOn, source: 'asserted' };
      }
      if (ps && typeof ps.configuredLevel === 'number') {
        return { level: ps.configuredLevel, explicitZero: ps.configuredLevel === 0 && globalOn, source: `proxy ${ps.source || '?'}` };
      }
      const cap = poller && poller.stripCapBases instanceof Map ? poller.stripCapBases.get(parent.proxyBase) : null;
      const recorded = stripLevelOf(getPersistence().get(parent.name));
      const level = cap ? Math.min(recorded, typeof cap.max_level === 'number' ? cap.max_level : 1) : recorded;
      return { level, explicitZero: false, source: 'record' };
    },

    _scratchCloneBegin(parent, body, reply) {
      const brief = String(body).trim();
      if (!brief) {
        reply('[agent:scratch] begin refused: the brief is empty — say what the clone should research, closed by [agent:end]. Nothing was forked.');
        return;
      }
      const live = parent._scratchClone ? this.sessions.get(parent._scratchClone) : null;
      if (parent._scratchClone && (!live || !live._dead)) {
        reply(`[agent:scratch] begin refused: clone ${parent._scratchClone} is still running — wait for its summary or [agent:scratch cancel] it.`);
        return;
      }
      const entry = getPersistence().get(parent.name);
      if (!entry || !parent.sessionId) {
        reply('[agent:scratch] begin refused: this seat has no session record to fork yet. Nothing was forked.');
        return;
      }
      const cloneName = `${parent.name}-scratch-${randomBytes(2).toString('hex')}`;
      if (!AGENT_NAME_RE.test(cloneName) || this.sessions.has(cloneName) || getPersistence().get(cloneName)) {
        reply(`[agent:scratch] begin refused: no usable clone name (${cloneName}). Nothing was forked.`);
        return;
      }
      parent._scratchClone = cloneName;
      return this._scratchCloneSpawn(parent, entry, cloneName, brief, reply).catch((e) => {
        parent._scratchClone = null;
        reply(`[agent:scratch] begin failed: ${e.message}. Nothing was forked.`);
      });
    },

    async _scratchCloneSpawn(parent, entry, cloneName, brief, reply) {
      const cloneSid = randomUUID();
      const { level, explicitZero, source } = this._scratchCloneStripLevel(parent);
      const stripBase = (level >= 1 || explicitZero) && parent.proxyBase ? parent.proxyBase : null;
      try {
        if (stripBase) await ProxyClient.stripThinking(stripBase, cloneSid, level, explicitZero);
      } catch (e) {
        parent._scratchClone = null;
        reply(`[agent:scratch] begin refused: setting the clone's strip level failed (${e.message}), and without it the clone pays a full cache write. Nothing was forked.`);
        return;
      }
      if (!(this._scratchCloneSpawning instanceof Map)) this._scratchCloneSpawning = new Map();
      this._scratchCloneSpawning.set(cloneName, { parent: parent.name, sid: cloneSid, stripBase });
      try {
        await this.create(
          cloneName, entry.type, parent.cwd, [...(entry.extraArgs || []), '--session-id', cloneSid], parent.sessionId,
          entry.workspaceId || DEFAULT_WORKSPACE_ID,
          entry.systemPrompt || null, true, entry.proxy ?? null,
          effectiveInjectedAgents(parent.name, entry.agents || []).map((a) => a.name),
          entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [],
          effectiveInjectedSkills(parent.name, entry.injectSkills || []).map((s) => s.name), entry.systemPromptFile || null, entry.appendPromptFiles || [],
          Array.isArray(entry.execCommands) ? entry.execCommands : [],
          Array.isArray(entry.intents) ? entry.intents : null,
          (entry.env && typeof entry.env === 'object') ? entry.env : null,
          false,
          entry.noWire === true,
          Array.isArray(entry.plugins) ? entry.plugins : null,
          Array.isArray(entry.shellDeny) ? entry.shellDeny : null,
          typeof entry.fixFor === 'string' ? entry.fixFor : null,
          entry.io || 'pty',
          typeof entry.effort === 'string' ? entry.effort : null,
        );
      } catch (e) {
        parent._scratchClone = null;
        if (stripBase) ProxyClient.stripThinking(stripBase, cloneSid, 0).catch(() => {});
        log.error('intent', `scratch clone ${cloneName} of ${parent.name} failed: ${e.message}`);
        reply(`[agent:scratch] begin failed: the clone did not start (${e.message}). Nothing was forked.`);
        return;
      } finally {
        this._scratchCloneSpawning.delete(cloneName);
      }
      const clone = this.sessions.get(cloneName);
      if (!clone) {
        if (parent._scratchClone !== cloneName) return;
        parent._scratchClone = null;
        reply(`[agent:scratch] begin failed: the clone ${cloneName} exited as it started. Nothing was forked.`);
        return;
      }
      const ours = parent._scratchClone === cloneName;
      try {
        if (!ours || parent._dead) { this._scratchCloneRetire(clone); return; }
        this._sendToSession(cloneName, 'session:context-action', {
          action: 'reattach', name: cloneName, type: clone.type, cwd: clone.cwd, backend: clone.backend || null, noWire: !!clone.noWire, io: clone.io || 'pty',
          background: true, clone: parent.name,
        });
        clone._scratchCloneTimer = setTimeout(() => this._scratchCloneExpire(clone), SCRATCH_CLONE_CEILING_MS);
        if (typeof clone._scratchCloneTimer.unref === 'function') clone._scratchCloneTimer.unref();
        log.info('intent', `scratch clone ${cloneName} of ${parent.name} sid=${cloneSid} strip=${stripBase ? `${level} (${source})` : 'none'}`);
        this._injectText(clone, scratchCloneBrief(parent.name, brief), { parkable: true });
        this._injectTextPassive(parent, `[agent:scratch] clone ${cloneName} forked — it reads, you idle; its summary arrives as a message from scratch.`);
      } catch (e) {
        log.error('intent', `scratch clone ${cloneName} of ${parent.name} failed after the fork: ${e.message}`);
        this._scratchCloneRetire(clone);
        if (!ours) return;
        if (parent._scratchClone === cloneName) parent._scratchClone = null;
        reply(`[agent:scratch] begin failed after the fork: ${e.message}; the clone was retired.`);
      }
    },

    _scratchCloneMarkerFields(name) {
      const marker = this._scratchCloneSpawning instanceof Map ? this._scratchCloneSpawning.get(name) : null;
      if (!marker) return {};
      return { clone: marker.parent, _scratchCloneSid: marker.sid, _scratchCloneStripBase: marker.stripBase };
    },

    _scratchCloneEnd(clone, intent, reply) {
      if (clone._scratchCloneRetired) return;
      if (intent.sub !== 'end') { reply(`[agent:scratch] ${SCRATCH_CLONE_REFUSAL}`); return; }
      const body = String(intent.body == null ? '' : intent.body).trim();
      if (!body) {
        reply('[agent:scratch] end refused: the summary body is empty — an empty summary loses the work. Re-emit '
          + '[agent:scratch end] with the briefing (what you now know, what you did), closed by [agent:end].');
        return;
      }
      this._scratchCloneToParent(clone, `[scratch] clone summary:\n${body}`);
      this._scratchCloneRetire(clone);
    },

    _scratchCloneCancel(parent, reply) {
      const clone = this.sessions.get(parent._scratchClone);
      parent._scratchClone = null;
      if (clone) this._scratchCloneRetire(clone);
      reply('[scratch] clone cancelled, no summary');
    },

    _scratchCloneExpire(clone) {
      clone._scratchCloneTimer = null;
      if (clone._scratchCloneRetired) return;
      const minutes = Math.round(SCRATCH_CLONE_CEILING_MS / 60000);
      this._scratchCloneToParent(clone, `[scratch] clone ${clone.name} ended without a summary (${minutes}m ceiling)`);
      this._scratchCloneRetire(clone);
    },

    _scratchCloneToParent(clone, text) {
      const parent = this.sessions.get(clone.clone);
      if (parent && !parent._dead) this._deliverMessage(parent.name, 'scratch', text, 'dm');
    },

    _scratchCloneOnExit(session) {
      if (session.clone && !session._scratchCloneRetired) {
        this._scratchCloneToParent(session, `[scratch] clone ${session.name} exited without a summary`);
        this._scratchCloneRetire(session);
      }
      const clone = session._scratchClone ? this.sessions.get(session._scratchClone) : null;
      session._scratchClone = null;
      if (clone) this._scratchCloneRetire(clone);
    },

    _scratchCloneRetire(clone) {
      if (clone._scratchCloneRetired) return;
      clone._scratchCloneRetired = true;
      if (clone._scratchCloneTimer) { clearTimeout(clone._scratchCloneTimer); clone._scratchCloneTimer = null; }
      const parent = this.sessions.get(clone.clone);
      if (parent && parent._scratchClone === clone.name) parent._scratchClone = null;
      if (clone._scratchCloneStripBase) {
        ProxyClient.stripThinking(clone._scratchCloneStripBase, clone._scratchCloneSid, 0).catch(() => {});
      }
      if (clone.proxyBase && clone.proxyAgent) {
        ProxyClient.spawnerHint(clone.proxyBase, clone.proxyAgent, { clear: true }).catch(() => {});
      }
      clone.spawnerHintSet = false;
      getPersistence().remove(clone.name);
      const dropSeat = () => {
        try {
          const r = removeSeat({ root: REGISTRY_DIR, name: clone.name, fs });
          for (const f of r.failed) log.warn('intent', `scratch clone ${clone.name}: ${f.path} not removed (${f.error})`);
        } catch (e) {
          log.warn('intent', `scratch clone ${clone.name}: seat dir not removed (${e.message})`);
        }
      };
      if (clone._dead) { dropSeat(); return; }
      Promise.resolve().then(() => this.kill(clone.name)).then(dropSeat, (e) => {
        log.warn('intent', `scratch clone ${clone.name}: kill failed: ${e.message}`);
      });
    },
  };
}

module.exports = { createScratchCloneMethods, scratchCloneBrief, SCRATCH_CLONE_REFUSAL };
