import test from "node:test";
import assert from "node:assert/strict";
import { buildAppServerLaunch, createLogRedactor } from "../lib/app-server-config.mjs";

const fixture = {
  CODEX_API_KEY: "test-not-a-real-secret",
  CODEX_BASE_URL: "https://example.invalid/v1",
  CODEX_MODEL: "provider-model",
  PATH: "/example/bin",
};

test("未配置 API Key 时保留已有登录路线", () => {
  const launch = buildAppServerLaunch({ CODEX_MODEL: " selected-model " });
  assert.equal(launch.authMode, "existing");
  assert.equal(launch.model, "selected-model");
  assert.deepEqual(launch.args, ["app-server", "--listen", "stdio://"]);
});

test("API Key 仅经环境变量传递，不进入命令参数", () => {
  const source = { ...fixture, CODEX_API_KEY: ` ${fixture.CODEX_API_KEY} ` };
  const launch = buildAppServerLaunch(source);
  assert.equal(launch.authMode, "apiKey");
  assert.equal(launch.env.CODEX_API_KEY, fixture.CODEX_API_KEY);
  assert.equal(launch.env.PATH, fixture.PATH);
  assert.equal(source.CODEX_API_KEY, ` ${fixture.CODEX_API_KEY} `);
  assert.ok(!launch.args.join(" ").includes(fixture.CODEX_API_KEY));
  assert.ok(launch.args.includes('model_provider="codex_harness_demo_api"'));
  assert.ok(launch.args.includes('model_providers.codex_harness_demo_api.env_key="CODEX_API_KEY"'));
  assert.ok(launch.args.includes('model_providers.codex_harness_demo_api.requires_openai_auth=false'));
  assert.ok(launch.args.includes('model_providers.codex_harness_demo_api.wire_api="responses"'));
});

for (const name of ["CODEX_API_KEY", "CODEX_BASE_URL", "CODEX_MODEL"]) {
  test(`API 模式缺少 ${name} 时不静默回退登录`, () => {
    const env = { ...fixture, [name]: "  " };
    assert.throws(() => buildAppServerLaunch(env), new RegExp(name));
  });
}

for (const baseUrl of [
  "not-a-url", "http://example.invalid/v1", "ftp://localhost/v1",
  "https://user:password@example.invalid/v1", "https://example.invalid/v1?key=test",
  "https://example.invalid/v1#fragment", "https://example.invalid/v1/responses",
  "https://example.invalid/v1/chat/completions/",
]) {
  test(`拒绝无效、不安全或完整操作端点：${baseUrl}`, () => {
    assert.throws(() => buildAppServerLaunch({ ...fixture, CODEX_BASE_URL: baseUrl }), /CODEX_BASE_URL/);
  });
}

test("本机模型服务允许 HTTP 回环地址", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(buildAppServerLaunch({ ...fixture, CODEX_BASE_URL: `http://${host}:1234/v1` }).authMode, "apiKey");
  }
});

test("错误不会回显误填在地址中的密钥", () => {
  try {
    buildAppServerLaunch({ ...fixture, CODEX_BASE_URL: fixture.CODEX_API_KEY });
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(!error.message.includes(fixture.CODEX_API_KEY));
  }
});

test("拒绝控制字符，模型名称使用带引号的配置值", () => {
  assert.throws(() => buildAppServerLaunch({ ...fixture, CODEX_MODEL: "model\nother" }), /控制字符/);
  const launch = buildAppServerLaunch({ ...fixture, CODEX_MODEL: 'provider/model-"quoted"' });
  assert.ok(launch.args.includes(`model=${JSON.stringify('provider/model-"quoted"')}`));
});

test("协议日志隐藏已知 Key 和认证字段，但不改动原始消息", () => {
  const redact = createLogRedactor(fixture.CODEX_API_KEY);
  const original = {
    params: { apiKey: "another-secret", accessToken: "token", env_key: "CODEX_API_KEY" },
    error: `provider echoed ${fixture.CODEX_API_KEY}`,
  };
  const safe = JSON.parse(redact(original));
  assert.equal(safe.params.apiKey, "[REDACTED]");
  assert.equal(safe.params.accessToken, "[REDACTED]");
  assert.equal(safe.params.env_key, "CODEX_API_KEY");
  assert.ok(!safe.error.includes(fixture.CODEX_API_KEY));
  assert.equal(original.params.apiKey, "another-secret");
});

test("日志脱敏覆盖转义字符串和多次出现的 Key", () => {
  const key = 'fake-"key\\value';
  const redact = createLogRedactor(key);
  assert.equal(redact(`${key} ${key}`), "[REDACTED] [REDACTED]");
  assert.deepEqual(JSON.parse(redact({ value: key })), { value: "[REDACTED]" });
});

test("没有 Key 时，普通协议日志仍正常输出", () => {
  assert.equal(createLogRedactor()({ id: 1, result: "ok" }), '{"id":1,"result":"ok"}');
});
