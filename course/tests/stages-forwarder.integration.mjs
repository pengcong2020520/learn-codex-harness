import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startGatewayForwarder } from '../deploy/run-stages.mjs';

// 以下测试使用真实回环监听；沙箱若禁止 listen，应在沙箱外跑，不自动跳过。
async function listenTestServer(t, onConnection) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    onConnection(socket);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return server;
}
async function testForwarder(t, server, options = {}) {
  const forwarder = await startGatewayForwarder({ port: 0, upstreamHost: '127.0.0.1', upstreamPort: server.address().port, ...options });
  t.after(() => forwarder.stop());
  return forwarder;
}
function testClient(t, forwarder) {
  const socket = net.createConnection({ host: '127.0.0.1', port: forwarder.address.port });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  return socket;
}
const tcpOptions = { timeout: 10_000 };

test('TCP：并发连接原样双向传输二进制大数据，客户端半关闭后仍完整收到响应', tcpOptions, async t => {
  const payload = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => i % 256));
  const received = [];
  const upstream = await listenTestServer(t, socket => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => {
      const request = Buffer.concat(chunks);
      received.push(request);
      socket.end(Buffer.concat([Buffer.from('response\0'), request]));
    });
  });
  const forwarder = await testForwarder(t, upstream);
  assert.equal(forwarder.address.address, '127.0.0.1');
  await Promise.all([1, 2].map(async () => {
    const client = testClient(t, forwarder), chunks = [];
    client.on('data', chunk => chunks.push(chunk));
    const ended = once(client, 'end');
    client.end(payload);
    await ended;
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from('response\0'), payload]));
  }));
  assert.equal(received.length, 2);
  for (const request of received) assert.deepEqual(request, payload);
});

test('TCP：上游拒绝连接时记录错误并关闭客户端，监听继续可用', tcpOptions, async t => {
  const upstream = await listenTestServer(t, () => {});
  const logs = [];
  const forwarder = await testForwarder(t, upstream, { log: line => logs.push(line) });
  await new Promise(resolve => upstream.close(resolve));
  const client = testClient(t, forwarder);
  await new Promise(resolve => client.once('close', resolve));
  assert.ok(client.destroyed);
  assert.ok(logs.some(line => /upstream connection error \(ECONNREFUSED\)/.test(line)));
  const second = testClient(t, forwarder);
  await new Promise(resolve => second.once('close', resolve));
  assert.equal(logs.length, 2);
});

test('TCP：上游复位会记录错误并关闭客户端', tcpOptions, async t => {
  const logs = [];
  const upstream = await listenTestServer(t, socket => socket.once('data', () => socket.resetAndDestroy()));
  const forwarder = await testForwarder(t, upstream, { log: line => logs.push(line) });
  const client = testClient(t, forwarder);
  const closed = new Promise(resolve => client.once('close', resolve));
  client.write('request');
  await closed;
  assert.ok(logs.some(line => /upstream connection error/.test(line)));
});

test('TCP：客户端复位关闭上游；停止转发器关闭活跃连接并释放监听端口', tcpOptions, async t => {
  let connected;
  let accepted = new Promise(resolve => { connected = resolve; });
  const upstream = await listenTestServer(t, socket => connected(socket));
  const logs = [];
  const forwarder = await testForwarder(t, upstream, { log: line => logs.push(line) });
  const client = testClient(t, forwarder);
  const remote = await accepted;
  remote.resume();
  remote.on('end', () => remote.end());
  const remoteClosed = once(remote, 'close');
  client.resetAndDestroy();
  await remoteClosed;
  assert.ok(logs.some(line => /client connection error/.test(line)));
  accepted = new Promise(resolve => { connected = resolve; });
  const second = testClient(t, forwarder);
  const secondRemote = await accepted;
  secondRemote.resume();
  secondRemote.on('end', () => secondRemote.end());
  const closed = Promise.all([once(second, 'close'), once(secondRemote, 'close')]);
  await forwarder.stop();
  await closed;
  assert.equal(await forwarder.done, null);
  const probe = net.createServer();
  t.after(() => new Promise(resolve => probe.close(resolve)));
  const listening = once(probe, 'listening');
  probe.listen(forwarder.address.port, '127.0.0.1');
  await listening;
});

test('TCP：监听端口已被占用时启动失败且记录错误', tcpOptions, async t => {
  const occupied = await listenTestServer(t, () => {}), logs = [];
  await assert.rejects(startGatewayForwarder({ port: occupied.address().port, log: line => logs.push(line) }), { code: 'EADDRINUSE' });
  assert.ok(logs.some(line => line.includes('EADDRINUSE')));
});
