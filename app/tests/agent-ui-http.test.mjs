import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { webFixture } from './web-fixture.mjs';

test('Agent UI 真实 HTTP：示例入口、匿名静态资源、SDK 与根路径重定向', async t => {
  for (const customUi of [false, true]) {
    const fixture = await webFixture(t, { customUi });
    for (const url of [fixture.url, fixture.app.url]) {
      const root = await fetch(url + '/', { redirect: 'manual' });
      assert.equal(root.status, 302);
      assert.equal(root.headers.get('location'), customUi ? '/app/' : '/ui/');
      const entry = await fetch(url + '/app/');
      assert.equal(entry.status, customUi ? 200 : 404);
      if (customUi) {
        assert.match(await entry.text(), /自定义 Agent/);
        assert.equal(entry.headers.get('x-content-type-options'), 'nosniff');
        for (const name of ['app.js', 'styles.css']) assert.equal((await fetch(`${url}/app/${name}`)).status, 200);
        // node:http 保留原始路径，避免 fetch 在发送前折叠 .. 而失去被测输入。
        for (const suffix of ['../role.md', '%2e%2e/role.md', '%252e%252e/role.md', '..%5crole.md', '%00.js', '../health', '../ready']) {
          const status = await new Promise((resolve, reject) => {
            const req = request(url, { path: '/app/' + suffix }, res => { res.resume(); resolve(res.statusCode); });
            req.on('error', reject); req.end();
          });
          assert.ok([400, 404].includes(status), suffix);
        }
      }
      assert.equal((await fetch(url + '/sessions')).status, 401);
    }
    assert.equal((await fetch(fixture.url + '/ui/')).status, 200);
    assert.equal((await fetch(fixture.url + '/ui/modules/api.mjs')).status, 200);
  }
});
