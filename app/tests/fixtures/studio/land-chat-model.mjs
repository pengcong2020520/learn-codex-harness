// 仅作为 Compose 测试服务运行，无宿主端口，不记录请求或凭据。
import http from 'node:http';
import { answer, sendResponse } from '../../responses-fixture.mjs';
http.createServer((request, response) => {
  request.resume();
  if (request.method === 'GET' && request.url === '/health') { response.end('ok'); return; }
  if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
    response.writeHead(404); response.end(); return;
  }
  sendResponse(response, answer('已收到事项清单，可以继续整理。'));
}).listen(8098, '0.0.0.0');
