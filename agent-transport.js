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

function createAgentTransport({ REGISTRY_DIR, MAX_MSG }) {
  function isAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }

  const registry = {
    register(name, socketPath) {
      ensureDir(REGISTRY_DIR);
      const regPath = path.join(REGISTRY_DIR, `${name}.json`);
      const data = JSON.stringify({ name, socket: socketPath, pid: process.pid });
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
      try { fs.unlinkSync(path.join(REGISTRY_DIR, `${name}.json`)); } catch {}
    },

    listPeers() {
      ensureDir(REGISTRY_DIR);
      const peers = [];
      for (const fname of fs.readdirSync(REGISTRY_DIR)) {
        if (!fname.endsWith('.json') || fname.includes('.tmp.')) continue;
        try {
          const info = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, fname), 'utf-8'));
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
      ensureDir(REGISTRY_DIR);
      let removed = 0;
      for (const fname of fs.readdirSync(REGISTRY_DIR)) {
        if (!fname.endsWith('.json') || fname.includes('.tmp.')) continue;
        try {
          const fpath = path.join(REGISTRY_DIR, fname);
          const info = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
          if (!fs.existsSync(info.socket) || !isAlive(info.pid)) {
            fs.unlinkSync(fpath);
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
