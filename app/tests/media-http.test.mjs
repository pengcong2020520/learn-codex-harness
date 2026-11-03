import test from 'node:test';
import http from 'node:http';
import { mediaScenarios } from './media-fixture.mjs';

mediaScenarios(test, async (t, handler) => {
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const part of req) body += part;
      const result = await handler({ url: req.url, method: req.method, authorization: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      res.setHeader('Content-Type', Buffer.isBuffer(result) ? 'video/mp4' : 'application/json');
      res.end(Buffer.isBuffer(result) ? result : JSON.stringify(result));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { endpoint: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-bf-test-only' } };
});
