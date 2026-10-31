import { testDataFactory } from './jobs-fixture.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAgentServer } from "../server/main.mjs";
import { AgentClient, loadClientConnection } from "../client/modules/connection/index.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { fixture, tempRoot, cleanup, until, installToolFixture } from "./helpers.mjs";

const mock = `
import {createInterface} from 'node:readline';
import {createToolService} from './server/modules/tools/loader.mjs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
const registry=await createToolService(dirname(fileURLToPath(import.meta.url)));
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const threads=new Map(); let number=0;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const p=m.params||{};
 if(m.method==='initialize') send({id:m.id,result:{userAgent:'mock'}});
 if(m.method==='config/read') {
  const file=readFileSync(process.env.CODEX_HOME+'/config.toml','utf8');
  const value=k=>JSON.parse(file.match(new RegExp('^'+k+' = (.+)$','m'))[1]);
  send({id:m.id,result:{config:{features:{memories:value('memories'),shell_tool:false,apply_patch_freeform:false},memories:Object.fromEntries(['use_memories','generate_memories','extract_model','consolidation_model','min_rollout_idle_hours'].map(k=>[k,value(k)]))}}});
 }
 if(m.method==='thread/memoryMode/set') send({id:m.id,result:{}});
 if(m.method==='skills/list') send({id:m.id,result:{data:[{cwd:process.cwd(),skills:[],errors:[]}]}});
 if(m.method==='mcpServerStatus/list') send({id:m.id,result:{data:[{name:'project_tools',runtimeStatus:'connected',tools:Object.fromEntries(registry.specs.map(t=>[t.name,t])),toolsError:null}],nextCursor:null}});
 if(m.method==='thread/list') send({id:m.id,result:{data:[...threads.values()],nextCursor:null}});
 if(m.method==='thread/start') {const thread={id:'thread-'+(threads.size+1),cwd:p.cwd,turns:[]}; threads.set(thread.id,thread);send({id:m.id,result:{thread,model:'unit-model',modelProvider:'project_api'}});}
 if(m.method==='thread/resume') send({id:m.id,result:{thread:threads.get(p.threadId),model:'unit-model',modelProvider:'project_api'}});
 if(m.method==='turn/start') {
  const thread=threads.get(p.threadId); const turn={id:'turn-'+(++number),status:'inProgress',items:[]}; thread.turns.push(turn);
  send({method:'turn/started',params:{threadId:thread.id,turn}});
  const user={id:'user-'+number,type:'userMessage',clientId:p.clientUserMessageId,content:p.input}; turn.items.push(user);
  send({method:'item/started',params:{threadId:thread.id,turnId:turn.id,item:user}});
  send({id:m.id,result:{turn:{id:turn.id,status:'inProgress',items:[]}}});
  ['mock ', 'reply ', turn.id].forEach((delta,index)=>setTimeout(()=>{
   send({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn.id,itemId:'answer-'+turn.id,delta}});
  },30*(index+1)));
  setTimeout(()=>{
   const item={id:'answer-'+turn.id,type:'agentMessage',text:'mock reply '+turn.id}; turn.items.push(item);turn.status='completed';
   send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});
   send({method:'turn/completed',params:{threadId:thread.id,turn}});
  },150);
 }
 if(m.method==='turn/steer') send({id:m.id,result:{turnId:p.expectedTurnId}});
});
`;

async function appFixture(t) {
  const root = installToolFixture(tempRoot(t));
  const cli = path.join(root, "mock-codex.mjs");
  writeFileSync(cli, mock);
  const config = loadServerConfig(root, fixture); config.port = 0;
  const app = await startAgentServer({ dataFactory: testDataFactory, config, cli, log: () => {} });
  cleanup(root, () => app.close());
  const api = new AgentClient({ url: app.url, token: app.token });
  return { root, app, api };
}

test("真实本机 HTTP + stdio 假 Codex：提交非阻塞，断开客户端不取消任务", async t => {
  const { app, api } = await appFixture(t);
  const session = await api.request("/sessions", {});
  const events = [];
  const stream = api.subscribe(session.id, event => events.push(event));
  await until(() => events.some(event => event.type === "snapshot"));
  const first = await api.request("/messages", { threadId: session.id, clientMessageId: "a", text: "A" });
  assert.equal(first.status, "queued");
  await api.request("/messages", { threadId: session.id, clientMessageId: "b", text: "B" });
  stream.close(); await stream.done;
  await until(() => app.messages.job("b").status === "completed");
  const state = await api.request(`/state?threadId=${session.id}`);
  assert.equal(state.session.turns.length, 2);
  assert.notEqual(app.messages.job("a").turnId, app.messages.job("b").turnId);
  assert.equal((await api.request("/health")).status, "ready");
});

test("CLI 管道连续输入并 /exit，消息交给服务端后继续执行", async t => {
  const { app } = await appFixture(t);
  const clientFile = fileURLToPath(new URL("../client/main.mjs", import.meta.url));
  const child = spawn(process.execPath, [clientFile], { env: { ...process.env, AGENT_SERVER_URL: app.url, AGENT_SERVER_TOKEN: app.token }, stdio: ["pipe","pipe","pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once("close", resolve));
  child.stdin.end("first\nsecond\n/exit\n");
  const code = await exited;
  assert.equal(code, 0, output);
  assert.match(output, /已退出客户端/);
  assert.equal(app.messages.store.state.jobs.length, 2, output);
  await until(() => app.messages.store.state.jobs.every(job => job.status === "completed"));
  assert.ok(!output.includes(fixture.CODEX_API_KEY));
  assert.ok(!output.includes(app.token));
});

test("CLI 经真实 HTTP/SSE 接收多个流式片段，连续两轮的回复不换行拆碎", async t => {
  const { root, app } = await appFixture(t);
  const clientFile = fileURLToPath(new URL("../client/main.mjs", import.meta.url));
  const child = spawn(process.execPath, [clientFile], { env: { ...process.env, AGENT_SERVER_URL: app.url, AGENT_SERVER_TOKEN: app.token }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once("close", resolve));
  cleanup(root, async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  child.stdin.write("first\n");
  await until(() => output.includes("Agent：mock reply turn-1\n"));
  child.stdin.write("second\n");
  await until(() => output.includes("Agent：mock reply turn-2\n"));
  child.stdin.end("/exit\n");
  assert.equal(await exited, 0, output);
  assert.match(output, /turn id: turn-1\nAgent：mock reply turn-1\nturn id: turn-2\nAgent：mock reply turn-2\n/);
  assert.equal(output.split("Agent：").length - 1, 2);
  assert.equal(output.split("Thread id: thread-1").length - 1, 1);
  assert.doesNotMatch(output, /Agent \[|轮次 |消息已接收/);
  assert.ok(!output.includes(app.token));
});

test("认证令牌私有保存；拒绝未认证、跨源和错误 JSON 请求", async t => {
  const { root, app, api } = await appFixture(t);
  const file = path.join(root, ".data", "connection.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadClientConnection({}, root).url, app.url);
  assert.ok(!readFileSync(file, "utf8").includes(fixture.CODEX_API_KEY));
  assert.equal((await fetch(app.url + "/health")).status, 401);
  assert.equal((await fetch(app.url + "/health", { headers: { authorization: `Bearer ${app.token}`, origin: "https://untrusted.invalid" } })).status, 403);
  const bad = await fetch(app.url + "/messages", { method: "POST", headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" }, body: "null" });
  assert.equal(bad.status, 400);
  assert.equal((await api.request("/health")).model, "unit-model");
  await app.close();
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(path.join(root, ".data", "server.lock")), false);
});

test("重复启动同项目会明确拒绝，不出现两个调度器", async t => {
  const { app } = await appFixture(t);
  await assert.rejects(startAgentServer({ dataFactory: testDataFactory, config: app.config, log: () => {} }), /已有 Agent 服务/);
});

test("工具状态接口只返回名称和状态，不泄露 MCP 令牌、模块路径或密钥", async t => {
  const { app, api } = await appFixture(t);
  const state = await api.request("/tools");
  assert.equal(state.status, "ready"); assert.equal(state.tools.length, 6);
  assert.ok(state.tools.some(tool => tool.name === "write_file"));
  const text = JSON.stringify(state);
  assert.ok(!text.includes(app.tools.token)); assert.ok(!text.includes(fixture.CODEX_API_KEY));
  assert.ok(!text.includes(".mjs"));
});

test("记忆 HTTP 管理复用认证和会话边界，不提供任意路径或清空接口", async t => {
  const { app, api } = await appFixture(t);
  assert.equal((await fetch(app.url + "/memory")).status, 401);
  assert.equal((await fetch(app.url + "/memory/summary", { headers: { authorization: `Bearer ${app.token}`, origin: "https://untrusted.invalid" } })).status, 403);
  const state = await api.request("/memory");
  assert.equal(state.effective.enabled, false);
  assert.equal(state.hasSummary, false);
  assert.equal((await api.request("/memory/summary")).text, "");
  assert.equal(app.sessions.sessions.size, 0);
  assert.ok(!JSON.stringify(state).includes(fixture.CODEX_API_KEY));
  const session = await api.request("/sessions", {});
  const result = await api.request("/memory/contribution", { threadId: session.id, enabled: false });
  assert.equal(result.mode, "disabled");
  await assert.rejects(api.request("/memory/contribution", { threadId: session.id, enabled: false, path: "../../.env" }), /只接受/);
  await assert.rejects(api.request("/memory/reset", {}), /不存在/);
  await assert.rejects(api.request("/memory/contribution", { threadId: "foreign", enabled: false }), /未找到/);
});

test("重连先同步快照，不把客户端再次连接当成新消息", async t => {
  const { app, api } = await appFixture(t);
  const session = await api.request("/sessions", {});
  await api.request("/messages", { threadId: session.id, clientMessageId: "only-once", text: "A" });
  await until(() => app.messages.job("only-once").status === "completed");
  const events = [];
  const subscription = api.subscribe(session.id, event => events.push(event));
  await until(() => events.length > 0);
  subscription.close(); await subscription.done;
  assert.equal(events[0].type, "snapshot");
  assert.equal(events[0].data.session.turns[0].status, "completed");
  assert.equal(app.messages.store.state.jobs.length, 1);
});
