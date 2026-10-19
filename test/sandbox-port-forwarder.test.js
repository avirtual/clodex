'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { createForwarder, parseTarget, readMap } = require('../sandbox-port-forwarder');

function listen(handler) {
  const server = net.createServer({ allowHalfOpen: true }, handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function forwarderTo(backendPort) {
  const fwd = createForwarder([{ host: 0, target: `127.0.0.1:${backendPort}` }], { listenHost: '127.0.0.1' });
  await fwd.ready;
  return fwd;
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const c = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true }, () => resolve(c));
    c.once('error', reject);
  });
}

function collect(socket) {
  return new Promise((resolve) => {
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
  });
}

test('parseTarget / readMap: host:port split and a garbage env reads as no map', () => {
  assert.deepStrictEqual(parseTarget('sandbox:3000'), { host: 'sandbox', port: 3000 });
  assert.strictEqual(parseTarget('nohost'), null);
  assert.strictEqual(parseTarget('x:99999'), null);
  assert.deepStrictEqual(readMap({ CLODEX_PORT_MAP: '[{"host":3000,"target":"clodex:3000"}]' }), [{ host: 3000, target: 'clodex:3000' }]);
  assert.deepStrictEqual(readMap({ CLODEX_PORT_MAP: '{not json' }), []);
  assert.deepStrictEqual(readMap({}), []);
});

test('round trip: bytes reach the backend and its reply reaches the client', async () => {
  const backend = await listen((s) => {
    s.on('data', (d) => s.write(`echo:${d}`));
    s.on('end', () => s.end());
  });
  const fwd = await forwarderTo(backend.address().port);
  const c = await connect(fwd.ports()[0]);
  const reply = await new Promise((resolve) => { c.once('data', (d) => resolve(String(d))); c.write('ping'); });
  assert.strictEqual(reply, 'echo:ping');
  c.destroy();
  await fwd.close();
  await closeServer(backend);
});

test('backend down at connect: the client is closed', async () => {
  const gone = await listen(() => {});
  const port = gone.address().port;
  await closeServer(gone);
  const fwd = await forwarderTo(port);
  const c = await connect(fwd.ports()[0]);
  c.on('error', () => {});
  assert.strictEqual(await collect(c), '');
  c.destroy();
  await fwd.close();
});

test('backend closes mid-stream: the client sees the end after the data', async () => {
  const backend = await listen((s) => { s.end('bye'); });
  const fwd = await forwarderTo(backend.address().port);
  const c = await connect(fwd.ports()[0]);
  assert.strictEqual(await collect(c), 'bye');
  c.destroy();
  await fwd.close();
  await closeServer(backend);
});

test('client half-close reaches the backend, which can still answer', async () => {
  const backend = await listen((s) => {
    let got = '';
    s.on('data', (d) => { got += d; });
    s.on('end', () => s.end(`got:${got}`));
  });
  const fwd = await forwarderTo(backend.address().port);
  const c = await connect(fwd.ports()[0]);
  const reply = collect(c);
  c.end('half');
  assert.strictEqual(await reply, 'got:half');
  await fwd.close();
  await closeServer(backend);
});

test('close() frees the listening port', async () => {
  const backend = await listen(() => {});
  const fwd = await forwarderTo(backend.address().port);
  const port = fwd.ports()[0];
  await fwd.close();
  const again = net.createServer();
  await new Promise((resolve, reject) => { again.once('error', reject); again.listen(port, '127.0.0.1', resolve); });
  await closeServer(again);
  await closeServer(backend);
});
