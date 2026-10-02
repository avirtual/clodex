'use strict';

const { randomUUID, randomBytes } = require('crypto');

const SCRATCH_CLONE_REFUSAL = 'you are a scratch clone — put it in your summary; only [agent:scratch end] and harness subagents are yours';

function scratchCloneBrief(parentName, brief) {
  return `You are a scratch clone of ${parentName}. Do exactly this, then end with [agent:scratch end] <summary> `
    + '(closed by [agent:end]); you receive no messages and your other intents are refused:\n' + brief;
}

function createScratchCloneMethods(deps, shared) {
  const { getPersistence, ProxyClient, log, stripLevelOf, AGENT_NAME_RE } = deps;
  const { SCRATCH_CLONE_CEILING_MS } = shared;

  return {
    _scratchCloneStripLevel(parent) {
      const poller = this._proxyPoller;
      const asserted = poller && poller.stripAsserted instanceof Map ? poller.stripAsserted.get(parent.name) : null;
      if (asserted && asserted.sessionId === parent.sessionId && typeof asserted.level === 'number') {
        return { level: asserted.level, source: 'asserted' };
      }
      return { level: stripLevelOf(getPersistence().get(parent.name)), source: 'record' };
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
      return this._scratchCloneSpawn(parent, entry, cloneName, brief, reply);
    },

    async _scratchCloneSpawn(parent, entry, cloneName, brief, reply) {
      const cloneSid = randomUUID();
      const { level, source } = this._scratchCloneStripLevel(parent);
      const stripBase = level >= 1 && parent.proxyBase ? parent.proxyBase : null;
      try {
        if (stripBase) await ProxyClient.stripThinking(stripBase, cloneSid, level);
      } catch (e) {
        parent._scratchClone = null;
        reply(`[agent:scratch] begin refused: setting the clone's strip level failed (${e.message}), and without it the clone pays a full cache write. Nothing was forked.`);
        return;
      }
      if (!(this._scratchCloneSpawning instanceof Map)) this._scratchCloneSpawning = new Map();
      this._scratchCloneSpawning.set(cloneName, parent.name);
      try {
        await this.create(...this._recordCreateArgs(cloneName, entry, {
          cwd: parent.cwd,
          extraArgs: [...(entry.extraArgs || []), '--session-id', cloneSid],
          resumeId: parent.sessionId,
          fork: true,
        }));
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
      if (!clone) { parent._scratchClone = null; return; }
      clone.clone = parent.name;
      clone._scratchCloneSid = cloneSid;
      clone._scratchCloneStripBase = stripBase;
      if (parent._scratchClone !== cloneName || parent._dead) { this._scratchCloneRetire(clone); return; }
      clone._scratchCloneTimer = setTimeout(() => this._scratchCloneExpire(clone), SCRATCH_CLONE_CEILING_MS);
      if (typeof clone._scratchCloneTimer.unref === 'function') clone._scratchCloneTimer.unref();
      log.info('intent', `scratch clone ${cloneName} of ${parent.name} sid=${cloneSid} strip=${stripBase ? `${level} (${source})` : 'none'}`);
      this._injectText(clone, scratchCloneBrief(parent.name, brief), { parkable: true });
      reply(`[agent:scratch] clone ${cloneName} forked — it reads, you idle; its summary arrives as a message from scratch.`);
    },

    _scratchCloneEnd(clone, intent, reply) {
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
      if (clone._dead) return;
      Promise.resolve().then(() => this.kill(clone.name)).catch((e) => {
        log.warn('intent', `scratch clone ${clone.name}: kill failed: ${e.message}`);
      });
    },
  };
}

module.exports = { createScratchCloneMethods, scratchCloneBrief, SCRATCH_CLONE_REFUSAL };
