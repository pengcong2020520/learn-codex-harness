// 旧 demo 与共用配置模块的回归测试。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { loadEnvironment, buildModelCatalog, buildAppServerLaunch, prepareRun, createLogRedactor, parseOptions, createChatInput, listProjectThreads, runAppServer } from "./05-app-server.mjs";
import { AGENT_INSTRUCTIONS } from "./server/modules/role/index.mjs";

const fixture = {
  CODEX_API_KEY: "test-not-a-real-key",
  CODEX_BASE_URL: "https://provider.invalid/v1",
  CODEX_MODEL: "unit-model",
  DEMO_TIMEOUT_MS: "3000"
};
const catalogFixture = {
  ...fixture,
  CODEX_MODEL_CATALOG_ENABLED: "true",
  CODEX_MODEL_CONTEXT_WINDOW: "128000",
  CODEX_MODEL_INPUT_MODALITIES: "text,image",
  CODEX_MODEL_REASONING_LEVELS: "low,high",
  CODEX_MODEL_DEFAULT_REASONING_LEVEL: "high"
};
function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), "app-server-project-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("读取指定项目 .env，终端环境变量优先且不修改原对象", t => {
  const root = workspace(t);
  writeFileSync(path.join(root, ".env"), "CODEX_MODEL=file-model\nCODEX_API_KEY=fake-file-key\n");
  const inherited = { CODEX_MODEL: "shell-model" };
  const env = loadEnvironment(root, inherited);
  assert.equal(env.CODEX_MODEL, "shell-model");
  assert.equal(env.CODEX_API_KEY, "fake-file-key");
  assert.deepEqual(inherited, { CODEX_MODEL: "shell-model" });
});
test("没有 .env 时只使用传入环境，不扫描父目录", t => {
  assert.deepEqual(loadEnvironment(workspace(t), {}), {});
});
test("未启用自动生成时保留 Codex 默认目录来源", () => {
  assert.equal(buildModelCatalog(fixture), null);
  assert.equal(buildModelCatalog({ ...catalogFixture, CODEX_MODEL_CATALOG_ENABLED: "false" }), null);
  assert.ok(!buildAppServerLaunch(fixture).args.some(x => x.startsWith("model_catalog_json=")));
});
test("目录复用固定角色，模型参数来自环境配置，不按服务商硬编码", () => {
  const launch = buildAppServerLaunch(catalogFixture);
  assert.equal(launch.model, "unit-model");
  assert.ok(launch.args.includes('model_provider="project_api"'));
  assert.equal(launch.authMode, "apiKey");
  const model = launch.catalog.models[0];
  assert.equal(model.slug, "unit-model");
  assert.equal(model.display_name, "unit-model");
  assert.equal(model.context_window, 128000);
  assert.equal(model.max_context_window, 128000);
  assert.deepEqual(model.input_modalities, ["text", "image"]);
  assert.deepEqual(model.supported_reasoning_levels.map(x => x.effort), ["low", "high"]);
  assert.equal(model.default_reasoning_level, "high");
  assert.equal(model.model_messages.instructions_template, AGENT_INSTRUCTIONS);
});
test("已有登录路线也可使用环境变量生成目录", () => {
  const { CODEX_API_KEY, CODEX_BASE_URL, ...env } = catalogFixture;
  const launch = buildAppServerLaunch(env);
  assert.equal(launch.authMode, "existing");
  assert.ok(launch.catalog);
});
test("旧路径配置不再悄悄参与加载", () => {
  assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_CATALOG_JSON: "old.json" }), /已停用/);
});
for (const name of ["CODEX_MODEL", "CODEX_MODEL_CONTEXT_WINDOW"]) {
  test(`生成目录必须配置 ${name}`, () => {
    assert.throws(() => buildModelCatalog({ ...catalogFixture, [name]: " " }), new RegExp(name));
  });
}
test("数字配置必须是正整数，百分比和最大上下文有边界", () => {
  for (const value of ["0", "-2", "Infinity", "1.5", "1e6", "9007199254740992"]) {
    assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_CONTEXT_WINDOW: value }), /CONTEXT_WINDOW/);
  }
  assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_MAX_CONTEXT_WINDOW: "100" }), /不能小于/);
  assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_PERCENT: "101" }), /PERCENT/);
  assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_TOOL_OUTPUT_LIMIT: "no" }), /TOOL_OUTPUT_LIMIT/);
});
test("布尔配置和枚举必须合法", () => {
  for (const [name, value] of [
    ["CODEX_MODEL_CATALOG_ENABLED", "yes"],
    ["CODEX_MODEL_SUPPORT_VERBOSITY", "1"],
    ["CODEX_MODEL_SUPPORTS_IMAGE_DETAIL_ORIGINAL", "truthy"],
    ["CODEX_MODEL_SHELL_TYPE", "unknown"],
    ["CODEX_MODEL_APPLY_PATCH_TOOL_TYPE", "unknown"],
    ["CODEX_MODEL_REASONING_SUMMARY", "unknown"],
    ["CODEX_MODEL_DEFAULT_VERBOSITY", "unknown"]
  ]) assert.throws(() => buildModelCatalog({ ...catalogFixture, [name]: value }), new RegExp(name));
});
test("列表拒绝重复、空项和非法值；接受值两侧空格", () => {
  for (const value of ["text,text", "text,", "text,unknown"]) assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_INPUT_MODALITIES: value }), /INPUT_MODALITIES/);
  assert.deepEqual(buildModelCatalog({ ...catalogFixture, CODEX_MODEL_INPUT_MODALITIES: " text, image " }).models[0].input_modalities, ["text", "image"]);
  assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_REASONING_LEVELS: "low,low" }), /REASONING_LEVELS/);
  assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_DEFAULT_REASONING_LEVEL: "medium" }), /DEFAULT_REASONING_LEVEL/);
});
test("不支持推理档位的模型可以不声明 reasoning levels", () => {
  const model = buildModelCatalog({ ...catalogFixture, CODEX_MODEL_REASONING_LEVELS: "", CODEX_MODEL_DEFAULT_REASONING_LEVEL: "" }).models[0];
  assert.deepEqual(model.supported_reasoning_levels, []);
  assert.equal(model.default_reasoning_level, null);
});
test("拒绝互相矛盾的图片和详细程度声明", () => {
  assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_INPUT_MODALITIES: "text", CODEX_MODEL_SUPPORTS_IMAGE_DETAIL_ORIGINAL: "true" }), /image/);
  assert.throws(() => buildModelCatalog({ ...catalogFixture, CODEX_MODEL_DEFAULT_VERBOSITY: "low" }), /SUPPORT_VERBOSITY/);
});
test("模板中的参数能完整生成目录，且不带密钥、地址等认证信息", () => {
  const template = parseEnv(readFileSync(new URL(".env.example", import.meta.url), "utf8"));
  const catalog = buildModelCatalog({ ...template, CODEX_API_KEY: fixture.CODEX_API_KEY, OTHER_SECRET: "not-for-catalog" });
  const model = catalog.models[0];
  assert.equal(model.slug, template.CODEX_MODEL);
  assert.equal(model.context_window, Number(template.CODEX_MODEL_CONTEXT_WINDOW));
  assert.equal(Object.hasOwn(template, "AGENT_INSTRUCTIONS"), false);
  assert.equal(model.model_messages.instructions_template, AGENT_INSTRUCTIONS);
  assert.ok(!JSON.stringify(catalog).includes(fixture.CODEX_API_KEY));
  assert.ok(!JSON.stringify(catalog).includes("not-for-catalog"));
  assert.ok(!JSON.stringify(catalog).includes(template.CODEX_BASE_URL));
});
test("配置构建是纯操作，不创建运行文件，也不改变传入环境", t => {
  const root = workspace(t);
  const source = { ...catalogFixture };
  const before = { ...source };
  buildAppServerLaunch(source);
  assert.deepEqual(source, before);
  assert.ok(!existsSync(path.join(root, ".runs")));
});
test("启动前生成私有 JSON，参数指向绝对路径，且原启动参数不被修改", async t => {
  const root = workspace(t);
  const launch = buildAppServerLaunch(catalogFixture);
  const originalArgs = [...launch.args];
  const run = await prepareRun(launch, root);
  assert.equal(run.catalogFile, path.join(run.workspace, "models.json"));
  assert.ok(path.isAbsolute(run.catalogFile));
  assert.ok(run.args.includes(`model_catalog_json=${JSON.stringify(run.catalogFile)}`));
  assert.deepEqual(JSON.parse(readFileSync(run.catalogFile, "utf8")), launch.catalog);
  assert.equal(statSync(run.catalogFile).mode & 0o777, 0o600);
  assert.deepEqual(launch.args, originalArgs);
  assert.ok(!readFileSync(run.catalogFile, "utf8").includes(fixture.CODEX_API_KEY));
});
test("并发运行生成独立文件，不覆盖其他模型或上次的目录", async t => {
  const root = workspace(t);
  const [first, second] = await Promise.all([
    prepareRun(buildAppServerLaunch(catalogFixture), root),
    prepareRun(buildAppServerLaunch({ ...catalogFixture, CODEX_MODEL: "other-model" }), root)
  ]);
  assert.notEqual(first.catalogFile, second.catalogFile);
  assert.equal(JSON.parse(readFileSync(first.catalogFile, "utf8")).models[0].slug, "unit-model");
  assert.equal(JSON.parse(readFileSync(second.catalogFile, "utf8")).models[0].slug, "other-model");
});
test("未启用模型目录时，只保存运行状态，不生成 models.json", async t => {
  const launch = buildAppServerLaunch(fixture);
  const run = await prepareRun(launch, workspace(t));
  assert.equal(run.catalogFile, null);
  assert.deepEqual(readdirSync(run.workspace), ["run.json"]);
  assert.equal(JSON.parse(readFileSync(path.join(run.workspace, "run.json"), "utf8")).pid, process.pid);
  assert.ok(!run.args.some(value => value.startsWith("model_catalog_json=")));
});
for (const name of ["CODEX_API_KEY", "CODEX_BASE_URL", "CODEX_MODEL"]) {
  test(`API 路线必须填写 ${name}`, () => {
    assert.throws(() => buildAppServerLaunch({ ...fixture, [name]: " " }), new RegExp(name));
  });
}
test("拒绝不安全或误填操作地址的 URL，允许本机测试", () => {
  for (const value of ["bad-url", "http://provider.invalid", "https://user:pass@provider.invalid", "https://provider.invalid?key=x", "https://provider.invalid/responses", "https://provider.invalid/chat/completions"]) {
    assert.throws(() => buildAppServerLaunch({ ...fixture, CODEX_BASE_URL: value }), /CODEX_BASE_URL/);
  }
  assert.equal(buildAppServerLaunch({ ...fixture, CODEX_BASE_URL: "http://127.0.0.1:1234" }).authMode, "apiKey");
});
test("拒绝无效超时时间", () => {
  for (const value of ["0", "-1", "NaN", "1.5", "2147483648"]) assert.throws(() => buildAppServerLaunch({ ...fixture, DEMO_TIMEOUT_MS: value }), /DEMO_TIMEOUT_MS/);
});
test("已知密钥和认证字段脱敏，不改变实际协议对象", () => {
  const key = 'fake-"key\\value';
  const redact = createLogRedactor(key);
  const raw = { apiKey: "another-fake-key", text: key };
  const safe = JSON.parse(redact(raw));
  assert.equal(safe.apiKey, "[REDACTED]");
  assert.equal(safe.text, "[REDACTED]");
  assert.equal(raw.text, key);
});
test("命令行支持默认测试、单轮自定义问题和检查模式", () => {
  assert.equal(parseOptions([]).mode, "run");
  assert.equal(parseOptions(["你好"]).prompt, "你好");
  assert.equal(parseOptions(["--prompt", "你好"]).prompt, "你好");
  assert.equal(parseOptions(["--check"]).mode, "check");
  assert.equal(parseOptions(["--chat"]).mode, "chat");
  assert.equal(parseOptions(["--handshake-only"]).mode, "check-server");
  assert.throws(() => parseOptions(["--unknown"]), /参数/);
  assert.throws(() => parseOptions(["--check", "你好"]), /参数/);
});

// 用本地假进程验证协议与失败处理，不连接任何模型服务。
const mockServer = `
import {createInterface} from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
const mode = process.env.TEST_SERVER_MODE;
let turnNumber = 0;
createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') {
    send({id:m.id,result:{userAgent:'mock'}});
    if(mode==='idle-exit') setTimeout(()=>process.exit(3),50);
  }
  if(m.method==='model/list') send({id:m.id,result:{data:[{model:'unit-model'}]}});
  if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'test-thread'},model:'unit-model',modelProvider:'project_api'}});
  if(m.method==='thread/list') send({id:m.id,result:{data:JSON.parse(process.env.TEST_HISTORY || '[]'),nextCursor:null}});
  if(m.method==='thread/resume') {
    if(mode==='resume-failed') send({id:m.id,error:{message:'simulated resume failure'}});
    else send({id:m.id,result:{thread:{id:m.params.threadId},model:'unit-model',modelProvider:'project_api'}});
  }
  if(m.method==='turn/start') {
    const number = ++turnNumber;
    const threadId = m.params.threadId;
    const turnId = 'test-turn-'+number;
    const reply = () => send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});
    if(mode!=='early') reply();
    if(mode==='exit') {process.exit(3);return;}
    if(mode==='hang') return;
    // 第二轮故意注入上一轮事件，检查客户端不会串轮。
    if(number>1) {
      send({method:'item/agentMessage/delta',params:{threadId,turnId:'test-turn-1',itemId:'stale',delta:'STALE'}});
      send({method:'turn/completed',params:{threadId,turn:{id:'test-turn-1',status:'completed'}}});
    }
    send({id:900,method:'item/commandExecution/requestApproval',params:{}});
    const finish = () => {
      const failed = mode==='failed' || (mode==='failed-once' && number===1);
      send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'answer-'+number,delta:'test reply '+number}});
      send({method:'item/completed',params:{threadId,turnId,item:{id:'answer-'+number,type:'agentMessage',text:'test reply '+number}}});
      send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:failed?'failed':'completed',error:failed?{message:'simulated failure'}:null}}});
    };
    if(mode==='early') {finish();reply();}
    else setTimeout(finish,20);
  }
});
`;
function mockFixture(t, mode = "success") {
  const root = workspace(t);
  const cli = path.join(root, "mock-server.mjs");
  writeFileSync(cli, mockServer);
  const launch = buildAppServerLaunch({ ...catalogFixture, TEST_SERVER_MODE: mode });
  return { root, cli, launch };
}
function protocol(root) {
  const run = readdirSync(path.join(root, ".runs")).find(name => existsSync(path.join(root, ".runs", name, "protocol.jsonl")));
  return readFileSync(path.join(root, ".runs", run, "protocol.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

function chatIO(t, text) {
  const output = new PassThrough();
  output.resume();
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  return { input: Readable.from([text]), output, logs };
}

test("命令行输入保留提前输入的多行，EOF 后正常退出", async () => {
  const output = new PassThrough();
  output.resume();
  const input = createChatInput(Readable.from(["first\nsecond\n"]), output);
  assert.equal(await input.question("> "), "first");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await input.question("> "), "second");
  assert.equal(await input.question("> "), null);
  input.close();
});
test("循环聊天同一 thread 两个 turn，答案不重复、不串轮，命令不发给模型", async t => {
  const { root, cli, launch } = mockFixture(t);
  const io = chatIO(t, "\n/help\n/unknown\nfirst\nsecond\n/exit\nignored\n");
  await runAppServer(launch, { mode: "chat" }, cli, root, io);
  const rows = protocol(root).filter(x => x.direction === "client");
  assert.equal(rows.filter(x => x.message.method === "initialize").length, 1);
  assert.equal(rows.filter(x => x.message.method === "thread/start").length, 1);
  const turns = rows.filter(x => x.message.method === "turn/start");
  assert.deepEqual(turns.map(x => x.message.params.threadId), ["test-thread", "test-thread"]);
  assert.deepEqual(turns.map(x => x.message.params.input[0].text), ["first", "second"]);
  assert.deepEqual(io.logs.filter(x => x.startsWith("模型回复：")), ["模型回复： test reply 1", "模型回复： test reply 2"]);
  assert.ok(!io.logs.join("\n").includes("STALE"));
});
for (const catalog of [null, { models: [{ model_messages: { instructions_template: "过期角色" } }] }]) {
  test(`旧 demo 新建和恢复会话始终使用角色模块：${catalog ? "目录含旧角色" : "无模型目录"}`, async t => {
    const { root, cli, launch } = mockFixture(t);
    launch.catalog = catalog;
    launch.env.AGENT_INSTRUCTIONS = "残留的环境角色";
    const cwd = path.join(root, ".runs", "app-server-old");
    mkdirSync(cwd, { recursive: true });
    launch.env.TEST_HISTORY = JSON.stringify([{ id: "old-thread", cwd, preview: "history" }]);
    await runAppServer(launch, { mode: "chat" }, cli, root,
      chatIO(t, "first\n/resume history\n1\nsecond\n/exit\n"));
    const calls = protocol(root).filter(row => row.direction === "client").map(row => row.message);
    const threads = calls.filter(call => ["thread/start", "thread/resume"].includes(call.method));
    assert.deepEqual(threads.map(call => call.method), ["thread/start", "thread/resume"]);
    for (const { params } of threads) {
      assert.equal(params.baseInstructions, AGENT_INSTRUCTIONS);
      assert.equal(params.sandbox, "read-only");
      assert.equal(params.approvalPolicy, "never");
    }
    const turns = calls.filter(call => call.method === "turn/start");
    assert.deepEqual(turns.map(call => call.params.threadId), ["test-thread", "old-thread"]);
    assert.deepEqual(turns.map(call => call.params.input[0].text), ["first", "second"]);
  });
}
test("turn 事件早于 RPC 响应时仍能完整处理", async t => {
  const { root, cli, launch } = mockFixture(t, "early");
  const io = chatIO(t, "one\ntwo\n/exit\n");
  await runAppServer(launch, { mode: "chat" }, cli, root, io);
  assert.deepEqual(io.logs.filter(x => x.startsWith("模型回复：")), ["模型回复： test reply 1", "模型回复： test reply 2"]);
});
test("单轮失败后聊天可继续，不把失败显示为 completed", async t => {
  const { root, cli, launch } = mockFixture(t, "failed-once");
  const io = chatIO(t, "one\ntwo\n/exit\n");
  await runAppServer(launch, { mode: "chat" }, cli, root, io);
  assert.ok(io.logs.some(x => x.includes("simulated failure")));
  assert.equal(io.logs.filter(x => x.startsWith("本轮状态：completed")).length, 1);
  assert.equal(protocol(root).filter(x => x.message.method === "turn/start").length, 2);
});
test("等待用户输入不计入调用超时", async t => {
  const { root, cli, launch } = mockFixture(t);
  launch.timeoutMs = 200;
  const io = chatIO(t, "");
  io.input = new PassThrough();
  const timer = setTimeout(() => io.input.end("hello\n/exit\n"), 400);
  t.after(() => clearTimeout(timer));
  await runAppServer(launch, { mode: "chat" }, cli, root, io);
  assert.ok(io.logs.includes("模型回复： test reply 1"));
});
test("直接退出或 EOF 不新建空会话、不调用模型", async t => {
  for (const text of ["/exit\n", ""]) {
    const { root, cli, launch } = mockFixture(t);
    await runAppServer(launch, { mode: "chat" }, cli, root, chatIO(t, text));
    assert.deepEqual(protocol(root).filter(x => x.direction === "client").map(x => x.message.method), ["initialize", "initialized"]);
  }
});
test("搜索覆盖所有分页并按项目、来源及关键词过滤，不能看到外部会话", async t => {
  const root = workspace(t);
  const cwd = path.join(root, ".runs", "app-server-old");
  mkdirSync(cwd, { recursive: true });
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [{ id: "second", preview: "Remember TWO", cwd, updatedAt: 2 }], nextCursor: null }
      : { data: [{ id: "first", preview: "one", cwd, updatedAt: 1 }, { id: "external", preview: "two", cwd: "/other" }, { id: "foreign-origin", preview: "two", cwd, originator: "other_app" }], nextCursor: "page2" };
  };
  assert.deepEqual((await listProjectThreads(request, root, "two")).map(x => x.id), ["second"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params.cwd, [cwd]);
  assert.deepEqual(calls[0].params.sourceKinds, ["appServer", "vscode"]);
  assert.equal(calls[0].params.archived, false);
  assert.deepEqual((await listProjectThreads(request, root, "FIRST")).map(x => x.id), ["first"]);
});
test("重复分页游标不会无限循环", async t => {
  const root = workspace(t);
  mkdirSync(path.join(root, ".runs", "app-server-old"), { recursive: true });
  await assert.rejects(listProjectThreads(async () => ({ data: [], nextCursor: "same" }), root), /重复分页/);
});
test("resume 搜索、无效选择、恢复和后续消息沿用选中 ID 及只读权限", async t => {
  const { root, cli, launch } = mockFixture(t);
  const cwd = path.join(root, ".runs", "app-server-old");
  mkdirSync(cwd, { recursive: true });
  launch.env.TEST_HISTORY = JSON.stringify([{ id: "saved-thread", name: "记忆测试", cwd, updatedAt: 1 }]);
  const io = chatIO(t, "/resume\n记忆\n99\n1\ncontinue\n/exit\n");
  await runAppServer(launch, { mode: "chat" }, cli, root, io);
  const rows = protocol(root).filter(x => x.direction === "client");
  assert.ok(!rows.some(x => x.message.method === "thread/start"));
  const resumed = rows.find(x => x.message.method === "thread/resume").message.params;
  assert.equal(resumed.threadId, "saved-thread");
  assert.equal(resumed.cwd, cwd);
  assert.equal(resumed.sandbox, "read-only");
  assert.equal(resumed.approvalPolicy, "never");
  assert.equal(resumed.modelProvider, "project_api");
  assert.equal(rows.find(x => x.message.method === "turn/start").message.params.threadId, "saved-thread");
});
test("resume 分页选择可恢复第 11 条，会话搜索本身不调用模型", async t => {
  const { root, cli, launch } = mockFixture(t);
  const cwd = path.join(root, ".runs", "app-server-old");
  mkdirSync(cwd, { recursive: true });
  launch.env.TEST_HISTORY = JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ id: "saved-" + i, cwd, preview: "history " + i, updatedAt: 20 - i })));
  const io = chatIO(t, "/resume history\nn\n11\n/exit\n");
  await runAppServer(launch, { mode: "chat" }, cli, root, io);
  const rows = protocol(root);
  assert.equal(rows.find(x => x.message.method === "thread/resume").message.params.threadId, "saved-10");
  assert.ok(!rows.some(x => x.message.method === "turn/start"));
  assert.ok(io.logs.some(x => x.includes("第 2/2 页")));
});
test("resume 取消、没有结果或恢复失败时保留当前会话", async t => {
  const { root, cli, launch } = mockFixture(t, "resume-failed");
  const cwd = path.join(root, ".runs", "app-server-old");
  mkdirSync(cwd, { recursive: true });
  launch.env.TEST_HISTORY = JSON.stringify([{ id: "old-thread", cwd, preview: "history" }]);
  const io = chatIO(t, "first\n/resume\n/cancel\n/resume missing\n/resume history\n\n/resume history\n1\nsecond\n/exit\n");
  await runAppServer(launch, { mode: "chat" }, cli, root, io);
  const turns = protocol(root).filter(x => x.message.method === "turn/start");
  assert.deepEqual(turns.map(x => x.message.params.threadId), ["test-thread", "test-thread"]);
  assert.ok(io.logs.some(x => x.includes("simulated resume failure")));
});
test("搜索输入和选择界面都支持 /exit，且不发起生成", async t => {
  for (const input of ["/resume\n/exit\n", "/resume history\n/exit\n"]) {
    const { root, cli, launch } = mockFixture(t);
    const cwd = path.join(root, ".runs", "app-server-old");
    mkdirSync(cwd, { recursive: true });
    launch.env.TEST_HISTORY = JSON.stringify([{ id: "old-thread", cwd, preview: "history" }]);
    await runAppServer(launch, { mode: "chat" }, cli, root, chatIO(t, input));
    assert.ok(!protocol(root).some(x => ["thread/resume", "thread/start", "turn/start"].includes(x.message.method)));
  }
});
test("等待用户输入时服务端退出也会释放终端，不会一直挂住", { timeout: 2000 }, async t => {
  const { root, cli, launch } = mockFixture(t, "idle-exit");
  const io = chatIO(t, "");
  io.input = new PassThrough();
  t.after(() => io.input.destroy());
  await assert.rejects(runAppServer(launch, { mode: "chat" }, cli, root, io), /提前退出/);
});
test("连接检查发送握手和 model/list，不发送 turn/start", async t => {
  const { root, cli, launch } = mockFixture(t);
  await runAppServer(launch, { mode: "check-server" }, cli, root);
  const methods = protocol(root).filter(x => x.direction === "client").map(x => x.message.method);
  assert.deepEqual(methods, ["initialize", "initialized", "model/list"]);
});
test("完整单轮等待 completed 并拒绝额外审批", async t => {
  const { root, cli, launch } = mockFixture(t);
  await runAppServer(launch, { mode: "run", prompt: "hello" }, cli, root);
  const rows = protocol(root);
  assert.ok(rows.some(x => x.message.method === "turn/completed"));
  assert.ok(rows.some(x => x.direction === "client" && x.message.id === 900 && x.message.result.decision === "decline"));
  assert.ok(!JSON.stringify(rows).includes(fixture.CODEX_API_KEY));
});
for (const [mode, expected] of [["failed", /simulated failure/], ["exit", /提前退出/], ["hang", /超时/]]) {
  test(`错误不会被当成成功：${mode}`, async t => {
    const { root, cli, launch } = mockFixture(t, mode);
    if (mode === "hang") launch.timeoutMs = 150;
    await assert.rejects(runAppServer(launch, { mode: "run", prompt: "hello" }, cli, root), expected);
  });
}
