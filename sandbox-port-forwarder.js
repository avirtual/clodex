'use strict';

const net = require('node:net');

function parseTarget(target) {
  const s = String(target || '');
  const i = s.lastIndexOf(':');
  const port = parseInt(s.slice(i + 1), 10);
  if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: s.slice(0, i), port };
}

function pipeConnection(client, target) {
  const backend = net.connect({ host: target.host, port: target.port, allowHalfOpen: true });
  backend.on('connect', () => {
    client.pipe(backend);
    backend.pipe(client);
  });
  backend.on('error', () => client.destroy());
  client.on('error', () => backend.destroy());
  backend.on('close', () => { if (!client.destroyed && !client.writableEnded) client.end(); });
  client.on('close', () => backend.destroy());
}

function createForwarder(map, opts = {}) {
  const listenHost = opts.listenHost || '0.0.0.0';
  const servers = [];
  const sockets = new Set();
  for (const row of Array.isArray(map) ? map : []) {
    const target = parseTarget(row && row.target);
    if (!target || !Number.isInteger(row.host)) continue;
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      pipeConnection(client, target);
    });
    server.listen(row.host, listenHost);
    servers.push(server);
  }
  const ready = Promise.all(servers.map((s) => (s.listening ? Promise.resolve() : new Promise((resolve, reject) => {
    s.once('listening', resolve);
    s.once('error', reject);
  }))));
  function close() {
    for (const s of sockets) s.destroy();
    return Promise.all(servers.map((s) => new Promise((resolve) => s.close(() => resolve()))));
  }
  function ports() { return servers.map((s) => s.address() && s.address().port); }
  return { ready, close, ports };
}

function readMap(env) {
  try {
    const parsed = JSON.parse(env.CLODEX_PORT_MAP || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

if (require.main === module) {
  const fwd = createForwarder(readMap(process.env));
  fwd.ready.catch((e) => {
    process.stderr.write(`sandbox-port-forwarder: ${(e && e.message) || e}\n`);
    process.exit(1);
  });
  const stop = () => { fwd.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createForwarder, parseTarget, readMap };
