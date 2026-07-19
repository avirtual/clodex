// agent-transport.js — the peer registry + Unix-domain-socket transport that
// back every agent session's IPC. Registry writes ~/.clodex/{name}.json via an
// atomic hardlink (register), prunes dead entries by socket-existence + live PID
// (cleanup / listPeers), and resolves a peer's socket by name (getPeer).
// Transport is the per-agent socket server plus a static send() for one-shot
// dials to a peer's socket.
//
// FACTORY (M3 DI): the bodies read two main.js globals — REGISTRY_DIR (the
// ~/.clodex runtime dir) and MAX_MSG (the 64K frame cap) — so they are injected
// as factory params, keeping every body byte-identical. isAlive is pure and is
// also returned (SessionManager reuses it for its own stale-name check).
//
// The socket/JSON I/O needs a live filesystem + net stack, so only the pure
// registry round-trip is unit-tested (against a temp dir); the socket server is
// left to integration.

const path = require('path');
const fs = require('fs');
const net = require('net');
const { ensureDir } = require('./fs-util');
const { pathFor, runDirFor } = require('./clodex-paths');

function createAgentTransport({ REGISTRY_DIR, MAX_MSG }) {
  function isAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }

  // Registry entries + sockets live per-agent at run/<name>/{agent.json,agent.sock}
  // (clodex-paths grammar). Discovery iterates run/*/agent.json instead of the
  // old flat *.json scan — we own both ends of this namespace, so there is no
  // external reader to keep compatible.
  const RUN_DIR = path.join(REGISTRY_DIR, 'run');

  // Every run/<name>/agent.json path, skipping half-written tmp files. Best
  // effort: a missing run dir just yields nothing.
  function* regEntries() {
    let names;
    try { names = fs.readdirSync(RUN_DIR); } catch { return; }
    for (const name of names) {
      const regPath = pathFor(REGISTRY_DIR, name, 'registry');
      if (!fs.existsSync(regPath)) continue;
      yield regPath;
    }
  }

  const registry = {
    register(name, socketPath, cwd = null) {
      ensureDir(runDirFor(REGISTRY_DIR, name));
      const regPath = pathFor(REGISTRY_DIR, name, 'registry');
      // cwd is additive (readers ignore unknown fields): it lets external
      // tools (exec commands, teams roster) map an agent to its project by
      // directory without a channel into the main process.
      const data = JSON.stringify({ name, socket: socketPath, pid: process.pid, ...(cwd ? { cwd } : {}) });
      const tmpPath = `${regPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, data, { mode: 0o600 });
      try {
        fs.linkSync(tmpPath, regPath);
      } catch (e) {
        fs.unlinkSync(tmpPath);
        if (e.code === 'EEXIST') throw e;
        throw e;
      }
      try { fs.unlinkSync(tmpPath); } catch {}
    },

    unregister(name) {
      try { fs.unlinkSync(pathFor(REGISTRY_DIR, name, 'registry')); } catch {}
    },

    listPeers() {
      const peers = [];
      for (const regPath of regEntries()) {
        try {
          const info = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
          if (fs.existsSync(info.socket) && isAlive(info.pid)) {
            peers.push(info);
          }
        } catch {}
      }
      return peers;
    },

    getPeer(name) {
      return this.listPeers().find(p => p.name === name) || null;
    },

    cleanup() {
      let removed = 0;
      for (const regPath of regEntries()) {
        try {
          const info = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
          if (!fs.existsSync(info.socket) || !isAlive(info.pid)) {
            fs.unlinkSync(regPath);
            if (fs.existsSync(info.socket)) fs.unlinkSync(info.socket);
            removed++;
          }
        } catch {}
      }
      return removed;
    },
  };

  class Transport {
    constructor(socketPath, onMessage) {
      this._path = socketPath;
      this._onMessage = onMessage;
      this._server = null;
    }

    start() {
      return new Promise((resolve, reject) => {
        try { fs.unlinkSync(this._path); } catch {}
        this._server = net.createServer((conn) => {
          const chunks = [];
          conn.on('data', (chunk) => chunks.push(chunk));
          conn.on('end', () => {
            const data = Buffer.concat(chunks);
            if (data.length === 0 || data.length > MAX_MSG) return;
            try {
              const msg = JSON.parse(data.toString('utf-8'));
              this._onMessage(msg);
            } catch {}
          });
          // Auto-close after 5s
          setTimeout(() => conn.destroy(), 5000);
        });
        this._server.listen(this._path, () => {
          fs.chmodSync(this._path, 0o600);
          resolve();
        });
        this._server.on('error', reject);
      });
    }

    stop() {
      return new Promise((resolve) => {
        if (this._server) {
          this._server.close(() => {
            try { fs.unlinkSync(this._path); } catch {}
            resolve();
          });
        } else {
          resolve();
        }
      });
    }

    static send(socketPath, msg) {
      return new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify(msg), 'utf-8');
        if (data.length > MAX_MSG) { resolve(false); return; }

        const conn = net.createConnection(socketPath, () => {
          conn.end(data, () => resolve(true));
        });
        conn.on('error', () => resolve(false));
        conn.setTimeout(2000, () => { conn.destroy(); resolve(false); });
      });
    }
  }

  return { isAlive, registry, Transport };
}

module.exports = { createAgentTransport };
