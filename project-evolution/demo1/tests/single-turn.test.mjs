import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { buildAppServerLaunch, parseOptions, runAppServer } from "../05-app-server.mjs";
import { AGENT_INSTRUCTIONS } from "../server/modules/role/index.mjs";
const fixture = { CODEX_API_KEY: "test-not-a-real-key", CODEX_BASE_URL: "https://provider.invalid/v1",
  CODEX_MODEL: "unit-model", DEMO_TIMEOUT_MS: "3000" };
const catalogFixture = { ...fixture, CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000" };
function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), "demo1-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
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

test("单轮入口接受问题和检查模式，不提供多轮入口", () => {
  assert.equal(parseOptions([]).mode, "run");
  assert.equal(parseOptions(["我的问题"]).prompt, "我的问题");
  assert.equal(parseOptions(["--check"]).mode, "check");
  assert.throws(() => parseOptions(["--chat"]));
});
test("空密钥模板可由用户填写，目录不包含密钥", () => {
  const template = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  assert.equal(template.CODEX_API_KEY, "");
  const launch = buildAppServerLaunch({ ...template, ...fixture });
  assert.equal(launch.catalog.models[0].model_messages.instructions_template, AGENT_INSTRUCTIONS);
  assert.ok(!JSON.stringify(launch.catalog).includes(fixture.CODEX_API_KEY));
});
for (const mode of ["success", "early"]) {
  test(`单轮闭环：${mode}；只创建一个 Thread 和一个 turn`, async t => {
    const { root, cli, launch } = mockFixture(t, mode);
    const logs = [];
    t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
    await runAppServer(launch, { mode: "run", prompt: "你好" }, cli, root);
    const calls = protocol(root).filter(row => row.direction === "client").map(row => row.message);
    assert.equal(calls.filter(call => call.method === "thread/start").length, 1);
    assert.equal(calls.filter(call => call.method === "turn/start").length, 1);
    assert.equal(calls.find(call => call.method === "turn/start").params.input[0].text, "你好");
    assert.ok(logs.includes("模型回复： test reply 1"));
    assert.ok(!JSON.stringify(calls).includes(fixture.CODEX_API_KEY));
  });
}
for (const [mode, pattern] of [["failed", /simulated failure/], ["hang", /超时/]]) {
  test(`单轮错误不冒充成功：${mode}`, async t => {
    const { root, cli, launch } = mockFixture(t, mode);
    t.mock.method(console, "log", () => {});
    if (mode === "hang") launch.timeoutMs = 150;
    await assert.rejects(runAppServer(launch, { mode: "run", prompt: "你好" }, cli, root), pattern);
  });
}
