import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { tempRoot, fixture, until, FakeRpc, installToolFixture, rig } from "./helpers.mjs";
import { createFileTools } from "../server/modules/data/files.mjs";
import { createToolService, runWebCommand } from "../server/modules/tools/index.mjs";
import { publicUrl, publicTarget, isPublicAddress, fetchPublic } from "../server/modules/tools/public-web.mjs";
import { readWebpage } from "../server/modules/tools/web.mjs";
import { createTools as createWebTools } from "../server/modules/tools/web-tools.mjs";
import { CodexConnection } from "../server/modules/codex/connection.mjs";
import { prepareRun } from "../server/modules/codex/runtime.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { SessionService } from "../server/modules/sessions/index.mjs";
import { EventHub } from "../server/modules/events/index.mjs";

const unpack = response => JSON.parse(response.contentItems[0].text);
test("文件工具自动建立固定目录，新增/列出/读取中文文件，不覆盖版本", t => {
  const root = tempRoot(t), files = createFileTools(root);
  assert.deepEqual(files.list_files({}).entries.map(x => x.name).sort(), ["drafts", "inputs", "outputs", "research"]);
  files.write_file({ path: "drafts/主题/v1.md", content: "你好\n原始观点" });
  assert.equal(files.read_file({ path: "drafts/主题/v1.md" }).content, "你好\n原始观点");
  assert.equal(files.read_file({ path: "drafts/主题/v1.md", max_chars: 2 }).truncated, true);
  assert.throws(() => files.write_file({ path: "drafts/主题/v1.md", content: "覆盖" }), /未覆盖/);
  assert.equal(files.read_file({ path: "drafts/主题/v1.md" }).content, "你好\n原始观点");
  assert.equal(fs.statSync(path.join(files.workspace, "drafts/主题/v1.md")).mode & 0o777, 0o600);
});

test("拒绝绝对路径、越界、隐藏路径、非文本文件和 inputs 写入", t => {
  const files = createFileTools(tempRoot(t));
  for (const value of ["/etc/passwd", "../.env", "drafts/../../.env", "drafts/../outputs/a.md", "drafts/.env", "drafts/a.exe", "drafts\\a.md", "drafts/a\0.md", "else/a.md", "inputs/a.md"]) {
    assert.throws(() => files.write_file({ path: value, content: "x" }), undefined, value);
  }
  fs.writeFileSync(path.join(files.workspace, "inputs", "观点.txt"), "原稿");
  assert.equal(files.read_file({ path: "inputs/观点.txt" }).content, "原稿");
  assert.throws(() => files.write_file({ path: "drafts/big.md", content: "大".repeat(100000) }), /256 KiB/);
  fs.writeFileSync(path.join(files.workspace, "inputs", "big.txt"), "x".repeat(262145));
  assert.throws(() => files.read_file({ path: "inputs/big.txt" }), /256 KiB/);
});

test("拒绝目录/文件符号链接、硬链接及被替换的 workspace", t => {
  const root = tempRoot(t), files = createFileTools(root);
  const outside = path.join(root, "outside"); fs.mkdirSync(outside);
  const secret = path.join(outside, "secret.txt"); fs.writeFileSync(secret, "private");
  fs.symlinkSync(outside, path.join(files.workspace, "drafts", "link"));
  fs.symlinkSync(secret, path.join(files.workspace, "inputs", "link.txt"));
  fs.linkSync(secret, path.join(files.workspace, "inputs", "hard.txt"));
  assert.throws(() => files.write_file({ path: "drafts/link/x.md", content: "x" }), /符号链接/);
  assert.throws(() => files.read_file({ path: "inputs/link.txt" }), /符号链接/);
  assert.throws(() => files.read_file({ path: "inputs/hard.txt" }), /硬链接/);
  fs.renameSync(files.workspace, path.join(root, "previous-workspace"));
  fs.symlinkSync(outside, files.workspace);
  assert.throws(() => files.list_files({}), /符号链接/);
  assert.throws(() => createFileTools(root), /符号链接/);
  assert.deepEqual(fs.readdirSync(outside), ["secret.txt"]);
});

test("schema 与运行时共用参数定义，未知工具/命名空间/额外参数不会执行", async t => {
  const tools = await createToolService(installToolFixture(tempRoot(t)));
  assert.equal(tools.specs.length, 4);
  assert.ok(tools.specs.every(spec => !spec.inputSchema.additionalProperties));
  for (const [tool, args] of [["bash", { command: "ls" }], ["read_webpage", { url: "https://example.com", command: "whoami" }],
    ["read_file", {}], ["list_files", { path: 1 }], ["write_file", { path: "drafts/a.md", content: null }],
    ["read_webpage", { url: "https://example.com", max_chars: 40001 }]]) assert.throws(() => tools.validate(tool, args));
  const denied = await tools.call({ tool: "write_file", namespace: "unknown", arguments: { path: "drafts/a.md", content: "x" } });
  assert.equal(denied.success, false);
  const missing = await tools.call({ tool: "read_file", arguments: { path: "inputs/missing.txt" } });
  assert.equal(unpack(missing).error, "文件或目录不存在。");
  assert.ok(!JSON.stringify(missing).includes(tools.workspace));
});

test("URL 和 DNS 拒绝本机、内网、保留/混合 IP、非 HTTP 和特殊端口", async () => {
  for (const value of ["127.0.0.1", "10.0.0.1", "172.16.2.3", "192.168.1.1", "169.254.169.254", "100.64.1.1", "198.18.1.1", "224.1.1.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) assert.equal(isPublicAddress(value), false, value);
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700::1111"), true);
  for (const url of ["file:///etc/passwd", "ftp://example.com", "http://localhost", "http://127.1", "http://2130706433", "http://[::1]", "http://example.com:4317", "https://u:p@example.com", "https://host.local/"]) assert.throws(() => publicUrl(url), undefined, url);
  await assert.rejects(publicTarget("https://example.com", async () => [{ address: "127.0.0.1", family: 4 }]), /非公网/);
  await assert.rejects(publicTarget("https://example.com", async () => [{ address: "198.18.0.134", family: 4 }]), /Fake-IP/);
  await assert.rejects(publicTarget("https://example.com", async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]), /非公网/);
});

test("调试模式兼容 HTTPS 域名的 Fake-IP；HTTP、显式保留 IP 和真正内网仍拒绝", async () => {
  const resolve = async () => [{ address: "198.18.0.134", family: 4 }];
  const debug = { allowProxyFakeIp: true };
  const result = await publicTarget("https://www.google.com/search", resolve, debug);
  assert.equal(result.addresses[0].address, "198.18.0.134");
  await assert.rejects(publicTarget("https://www.google.com/search", resolve), /Fake-IP/);
  await assert.rejects(publicTarget("http://www.google.com/search", resolve, debug), /Fake-IP/);
  await assert.rejects(publicTarget("https://198.18.0.134", resolve, debug), /公开/);
  await assert.rejects(publicTarget("https://localhost", resolve, debug), /公开/);
  await assert.rejects(publicTarget("https://example.com", async () => [
    { address: "198.18.0.134", family: 4 }, { address: "10.0.0.1", family: 4 }
  ], debug), /非公网/);
});

test("调试模式仍固定解析地址、保留 HTTPS 校验，重定向每次重新检查", async () => {
  const resolve = async () => [{ address: "198.18.0.134", family: 4 }];
  let count = 0;
  const request = fakeHttp([{ status: 302, headers: { location: "https://127.0.0.1/private" } }], (url, options) => {
    count++;
    assert.equal(url.hostname, "example.com");
    assert.notEqual(options.rejectUnauthorized, false);
    options.lookup("example.com", { all: true }, (error, addresses) => assert.deepEqual(addresses, [{ address: "198.18.0.134", family: 4 }]));
  });
  await assert.rejects(fetchPublic("https://example.com", { resolve, request, allowProxyFakeIp: true }), /公开/);
  assert.equal(count, 1);
});

test("服务默认调试模式，无需工具授权开关；生产模式传入固定网络子进程", async t => {
  const calls = [];
  const runWeb = async (...args) => { calls.push(args); return { content: "测试正文" }; };
  const debug = await createToolService(installToolFixture(tempRoot(t)), { runWeb, nodeEnv: "development" });
  const production = await createToolService(installToolFixture(tempRoot(t)), { runWeb, nodeEnv: "production" });
  const params = { tool: "read_webpage", arguments: { url: "https://example.com" } };
  assert.equal(debug.networkMode, "proxy-debug"); assert.equal(production.networkMode, "strict");
  assert.equal((await debug.call(params)).success, true);
  assert.equal((await production.call(params)).success, true);
  assert.deepEqual(calls.map(call => call[3]), ["development", "production"]);
});

function fakeHttp(pages, observer = () => {}) {
  let count = 0;
  return (url, options, callback) => {
    observer(url, options);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const page = pages[count++];
      assert.ok(page, "不能出现意料之外的额外请求");
      const response = Readable.from([Buffer.from(page.body || "")]);
      response.statusCode = page.status || 200;
      response.headers = { "content-type": "text/html; charset=utf-8", ...page.headers };
      callback(response);
    });
    return req;
  };
}

test("HTTP 实际连接使用已检查的 IP，重定向内网被拦截，不转发秘密", async () => {
  let lookups = 0, requests = 0;
  const resolve = async () => { lookups++; return [{ address: "93.184.216.34", family: 4 }]; };
  const request = fakeHttp([{ status: 302, headers: { location: "http://127.0.0.1/secret" } }], (url, options) => {
    requests++;
    assert.equal(options.agent, false);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    options.lookup("example.com", { all: true }, (error, result) => assert.deepEqual(result, [{ address: "93.184.216.34", family: 4 }]));
  });
  await assert.rejects(fetchPublic("https://example.com", { resolve, request }), /公开/);
  assert.equal(requests, 1); assert.equal(lookups, 1);
});

test("HTTP 限制响应大小、格式、状态和重定向次数", async () => {
  const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
  await assert.rejects(fetchPublic("https://example.com", { resolve, maxBytes: 10, request: fakeHttp([{ body: "x".repeat(11) }]) }), /上限/);
  await assert.rejects(fetchPublic("https://example.com", { resolve, request: fakeHttp([{ status: 429 }]) }), /429/);
  await assert.rejects(fetchPublic("https://example.com", { resolve, request: fakeHttp([{ status: 302, headers: { location: "http://[invalid" } }]) }), /地址无效/);
  await assert.rejects(fetchPublic("https://example.com", { resolve, request: fakeHttp([{ headers: { "content-type": "application/pdf" } }]) }), /PDF/);
  await assert.rejects(fetchPublic("https://example.com", { resolve, request: fakeHttp(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: "/again" } }))) }), /重定向次数/);
});

test("网页只读静态正文，剔除脚本导航并标记截断，纯文本不被当成 HTML", async () => {
  const result = await readWebpage({ url: "https://example.com", max_chars: 4 }, async () => ({ url: "https://example.com/article", contentType: "text/html", text: '<title>测试</title><nav>菜单</nav><article><h1>观点</h1><p>证据 &amp; 来源</p><script>DO NOT RUN</script></article>' }));
  assert.equal(result.title, "测试"); assert.equal(result.content, "观点\n证"); assert.equal(result.truncated, true);
  assert.doesNotMatch(result.content, /DO NOT RUN|菜单/);
  const plain = await readWebpage({ url: "https://example.com" }, async () => ({ url: "https://example.com", contentType: "text/plain", text: "a < b" }));
  assert.equal(plain.content, "a < b");
});

test("没有注册搜索工具；网页失败不缓存，文件调用不受网络失败影响", async t => {
  let failures = 0;
  const broken = await createToolService(installToolFixture(tempRoot(t)), { runWeb: async () => { failures++; throw new Error("网页不可用"); } });
  assert.ok(!broken.specs.some(spec => spec.name === "search_web"));
  assert.equal((await broken.call({ tool: "search_web", arguments: { query: "旧搜索" } })).success, false);
  const params = { tool: "read_webpage", arguments: { url: "https://example.com" } };
  assert.match(unpack(await broken.call(params)).error, /网页不可用/);
  assert.match(unpack(await broken.call(params)).error, /网页不可用/); assert.equal(failures, 2);
  assert.equal((await broken.call({ tool: "write_file", arguments: { path: "research/notes.md", content: "待核实" } })).success, true);
  const controller = new AbortController(); controller.abort();
  assert.equal((await broken.call({ tool: "write_file", arguments: { path: "drafts/cancelled.md", content: "x" } }, { signal: controller.signal })).success, false);
  assert.equal(fs.existsSync(path.join(broken.workspace, "drafts/cancelled.md")), false);
});

test("网页读取最多并行两个请求，完成后释放并发名额", async () => {
  const pending = Promise.withResolvers();
  const tools = createWebTools({ runWeb: async () => pending.promise });
  const first = tools.read_webpage({ url: "https://example.com/one" });
  const second = tools.read_webpage({ url: "https://example.com/two" });
  await assert.rejects(tools.read_webpage({ url: "https://example.com/three" }), /已有两个网络任务/);
  pending.resolve({ content: "正文" });
  assert.deepEqual(await Promise.all([first, second]), [{ content: "正文" }, { content: "正文" }]);
  assert.deepEqual(await tools.read_webpage({ url: "https://example.com/three" }), { content: "正文" });
});

test("固定命令入口拒绝任意工具名，并在子进程中拦截非公网 URL", async () => {
  await assert.rejects(runWebCommand("bash", { command: "echo no" }), /未授权/);
  await assert.rejects(runWebCommand("read_webpage", { url: "http://127.0.0.1:4317" }), /公开/);
});

function connection(t) {
  const rpc = new CodexConnection({ launch: { timeoutMs: 1000 }, runtime: { runDir: tempRoot(t) }, redact: value => typeof value === "string" ? value : JSON.stringify(value) });
  const output = []; rpc.send = message => output.push(message);
  return { rpc, output };
}

test("新 Thread 不注册 dynamicTools；工具事件进入快照", async t => {
  const { config, rpc, runtime, sessions: previous } = await rig(t);
  previous.close();
  const sessions = new SessionService({ rpc, config, runtime, hub: new EventHub(), redact: x => x, tools: { label: name => name === "read_file" ? "读取文件" : name } });
  t.after(() => sessions.close());
  const session = await sessions.create();
  assert.equal(rpc.calls[0].params.dynamicTools, undefined);
  assert.equal(rpc.calls[0].params.approvalPolicy, "never");
  sessions.sessions.clear(); await sessions.ensure(session.id);
  assert.equal(Object.hasOwn(rpc.calls.find(x => x.method === "thread/resume").params, "dynamicTools"), false);
  rpc.notify("item/started", { threadId: session.id, turnId: "turn", item: { id: "tool", type: "dynamicToolCall", tool: "read_file", status: "inProgress" } });
  assert.equal(sessions.snapshot(session.id).turns[0].tools.tool.label, "读取文件");
  rpc.notify("item/completed", { threadId: session.id, turnId: "turn", item: { id: "tool", type: "dynamicToolCall", tool: "read_file", status: "completed", success: false, contentItems: [{ type: "inputText", text: '{"error":"文件不存在"}' }] } });
  assert.equal(sessions.snapshot(session.id).turns[0].tools.tool.status, "failed");
});

test("正式服务禁用任意命令/原生写文件，研究轮次超时与 RPC 超时独立", t => {
  const config = loadServerConfig(tempRoot(t), { ...fixture, CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000", CODEX_MODEL_SHELL_TYPE: "unified_exec", CODEX_MODEL_APPLY_PATCH_TOOL_TYPE: "freeform" });
  assert.equal(config.launch.catalog.models[0].shell_type, "disabled");
  assert.equal(config.launch.catalog.models[0].apply_patch_tool_type, null);
  assert.equal(config.turnTimeoutMs, 600000); assert.equal(config.launch.timeoutMs, 3000);
  assert.ok(config.launch.args.includes("features.shell_tool=false"));
  assert.throws(() => loadServerConfig(tempRoot(t), { ...fixture, AGENT_TURN_TIMEOUT_MS: "0" }), /AGENT_TURN_TIMEOUT/);
});

