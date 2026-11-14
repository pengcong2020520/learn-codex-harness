import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDocument } from 'htmlparser2';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
export const csp = "default-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
test('网页静态入口：Caddy /ui、302 跳转、安全响应头、只读挂载和统一白名单', () => {
  const caddy = read('deploy/Caddyfile'), compose = read('compose.yaml');
  assert.match(caddy, /redir \/ \/ui\/ 302/); assert.match(caddy, /handle_path \/ui\/\*/);
  assert.match(caddy, /root \* \/srv\/ui/); assert.match(caddy, /file_server/);
  assert.ok(caddy.includes(`Content-Security-Policy "${csp}"`));
  assert.match(caddy, /X-Content-Type-Options nosniff/); assert.match(caddy, /Referrer-Policy no-referrer/);
  assert.match(caddy, /reverse_proxy/); assert.match(compose.slice(compose.indexOf('  caddy:')), /\.\/web:\/srv\/ui:ro/);
  assert.match(compose, /environment: &node-env[\s\S]*AGENT_ALLOWED_ORIGINS:.*AGENT_PORT:-4317/);
  assert.equal((compose.match(/<<: \*node-env/g) || []).length, 2);
  assert.match(read('deploy/remote-env.mjs'), /AGENT_ALLOWED_ORIGINS:env.AGENT_ALLOWED_ORIGINS/);
});
test('网页 HTML：无内联脚本、样式或事件属性，入口模块直接加载', () => {
  const files = fs.readdirSync(new URL('../web/', import.meta.url), { recursive: true }).filter(file => file.endsWith('.html'));
  assert.ok(files.includes('index.html'));
  for (const file of files) {
    const visit = element => {
      assert.notEqual(element.name, 'style', file);
      if (element.name === 'script') { assert.ok(element.attribs.src, file); assert.equal(element.children.length, 0, file); }
      for (const [key, value] of Object.entries(element.attribs || {})) {
        assert.ok(key !== 'style' && !key.startsWith('on'), `${file}: ${key}`);
        assert.doesNotMatch(value, /^javascript:/i);
      }
      for (const child of element.children || []) visit(child);
    };
    visit(parseDocument(read(`web/${file}`)));
  }
  assert.match(read('web/index.html'), /type="module" src="\.\/app.js"/);
  assert.doesNotMatch(read('web/app.js'), /innerHTML|localStorage|document\.cookie/);
  assert.match(read('web/styles.css'), /prefers-color-scheme:dark/);
});
test('网页 HTML：含密码输入框的表单必须使用 POST', () => {
  const files = fs.readdirSync(new URL('../web/', import.meta.url), { recursive: true }).filter(file => file.endsWith('.html'));
  for (const file of files) {
    const visit = (element, form) => {
      if (element.name === 'form') form = element;
      if (form && element.name === 'input' && element.attribs.type?.toLowerCase() === 'password') {
        assert.equal(form.attribs.method?.toLowerCase(), 'post', `${file}: ${form.attribs.id || 'form'} 必须使用 POST`);
      }
      for (const child of element.children || []) visit(child, form);
    };
    visit(parseDocument(read(`web/${file}`)));
  }
});
test('网页会话事件实现与 CLI 协议保持一致（静态托管只暴露 web）', () => {
  assert.equal(read('web/modules/session-events.mjs'), read('shared/session-events.mjs'));
});

test('网页上传约束与服务端共享定义保持一致', () => {
  assert.equal(read('web/modules/uploads.mjs'), read('shared/uploads.mjs'));
});
