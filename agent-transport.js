
const path = require('path');
const fs = require('fs');
const net = require('net');
const { ensureDir } = require('./fs-util');
const { pathFor, runDirFor } = require('./clodex-paths');

// 250ms, not send()'s 2000ms: this probe runs on the session-start path, and a
// Unix-domain connect either succeeds in microseconds or nothing is bound there.
// A longer wait would sit in front of every recovery from an unclean shutdown.
const SOCKET_PROBE_TIMEOUT = 250;

function createAgentTransport({ REGISTRY_DIR, MAX_MSG }) {
  function isAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
  }

  const RUN_DIR = path.join(REGISTRY_DIR, 'run');

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

// The dial is load-bearing: after an unclean shutdown the socket file survives
// and the OS can hand the pid to a stranger, so existsSync(socket) && isAlive(pid)
// reads identically for a ghost and a live agent. Nothing readable from the
// filesystem separates them. Measured: a refused dial 0.046ms, a live one
// 0.136ms, vs 2.349ms to fork `ps` for a start time (darwin has no /proc).
    async listPeers() {
      const peers = [];
      for (const regPath of regEntries()) {
        try {
          const info = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
          if (!fs.existsSync(info.socket) || !isAlive(info.pid)) continue;
          if (await Transport.isSocketLive(info.socket)) peers.push(info);
        } catch {}
      }
      return peers;
    },

    async getPeer(name) {
      return (await this.listPeers()).find(p => p.name === name) || null;
    },

    cleanup() {
      let removed = 0;
      for (const regPath of regEntries()) {
        try {
          const raw = fs.readFileSync(regPath, 'utf-8');
          const info = JSON.parse(raw);
          if (!fs.existsSync(info.socket) || !isAlive(info.pid)) {
// The dead verdict describes the bytes in `raw`; if the entry was replaced since
// (create()'s re-register path force-cleans a blocking record and writes a fresh
// one), unlinking anyway removes a LIVE agent's registration and nothing notices.
// The re-read narrows the window to two adjacent syscalls; it cannot close it,
// since there is no atomic compare-and-unlink. Today cleanup() is fully
// synchronous, so no in-process interleave exists — add an await anywhere in this
// loop and this guard becomes load-bearing.
            let current = null;
            try { current = fs.readFileSync(regPath, 'utf-8'); } catch {}
            if (current !== raw) continue;   // replaced or already gone — not ours to delete
            fs.unlinkSync(regPath);
// Deliberately does not unlink the socket file. This read-then-delete never
// re-validates, so on a re-registration race we would unlink a LIVE socket — and
// a net.Server whose inode has been unlinked keeps listening with no error and
// no event, leaving that agent permanently unreachable. Orphans are harmless:
// nothing enumerates socket files, and Transport.start unlinks before it binds.
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

// Resolves true only on a successful connect; ECONNREFUSED (file present, nothing
// bound — the ghost), ENOENT and timeout all mean not-live. Never rejects.
// The probe writes nothing and closes immediately: safe only because start()'s
// 'end' handler discards zero-length frames before parsing, so a connect-and-close
// can never reach onMessage.
    static isSocketLive(socketPath) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (live) => {
          if (done) return;
          done = true;
          try { conn.destroy(); } catch {}
          resolve(live);
        };
        const conn = net.createConnection(socketPath, () => finish(true));
        conn.on('error', () => finish(false));
        conn.setTimeout(SOCKET_PROBE_TIMEOUT, () => finish(false));
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
