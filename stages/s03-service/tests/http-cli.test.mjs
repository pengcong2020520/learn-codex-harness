import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, statSync, existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAgentServer } from "../server/main.mjs";
import { AgentClient, loadClientConnection } from "../client/modules/connection/index.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { fixture, tempRoot, cleanup, until } from "./helpers.mjs";

// 用一个 stdio 假 Codex 代替真实 App Server：协议形状一致，不调用模型。
const mock = `
import {createInterface} from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const threads=new Map(); let number=0;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); const p=m.params||{};
 if(m.method==='initialize') send({id:m.id,result:{userAgent:'mock'}});
 if(m.method==='model/list') send({id:m.id,result:{data:[{model:'unit-model'}]}});
 if(m.method==='thread/list') send({id:m.id,result:{data:[...threads.values()],nextCursor:null}});
 if(m.method==='thread/start') {const thread={id:'thread-'+(threads.size+1),cwd:p.cwd,turns:[],originator:'app_server_project'}; threads.set(thread.id,thread);send({id:m.id,result:{thread,model:'unit-model',modelProvider:'project_api'}});}
 if(m.method==='thread/resume') send({id:m.id,result:{thread:threads.get(p.threadId),model:'unit-model',modelProvider:'project_api'}});
 if(m.method==='turn/start') {
  const thread=threads.get(p.threadId); const turn={id:'turn-'+(++number),status:'inProgress',items:[]}; thread.turns.push(turn);
  send({method:'turn/started',params:{threadId:thread.id,turn}});
  const user={id:'user-'+number,type:'userMessage',content:p.input}; turn.items.push(user);
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
});
`;

async function appFixture(t) {
  const root = tempRoot(t);
  const cli = path.join(root, "mock-codex.mjs");
  writeFileSync(cli, mock);
  const config = loadServerConfig(root, fixture); config.port = 0;
  const app = await startAgentServer({ config, cli, log: () => {} });
  cleanup(root, () => app.close());
  const api = new AgentClient({ url: app.url, token: app.token });
  return { root, app, api };
}
function client(root, app) {
  const file = fileURLToPath(new URL("../client/main.mjs", import.meta.url));
  const child = spawn(process.execPath, [file], { env: { ...process.env, AGENT_SERVER_URL: app.url, AGENT_SERVER_TOKEN: app.token }, stdio: ["pipe", "pipe", "pipe"] });
  const result = { child, output: "" };
  child.stdout.on("data", chunk => { result.output += chunk; });
  child.stderr.on("data", chunk => { result.output += chunk; });
  result.exited = new Promise(resolve => child.once("close", resolve));
  cleanup(root, async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await result.exited; });
  return result;
}

test("真实本机 HTTP + stdio 假 Codex：提交立即返回 202，结果由 GET /state 查看", async t => {
  const { app, api } = await appFixture(t);
  const session = await api.request("/sessions", {});
  const accepted = await api.request("/turns", { threadId: session.id, text: "A" });
  assert.equal(accepted.status, "inProgress");
  await until(() => app.sessions.getTurn(session.id, accepted.turnId)?.status === "completed");
  const state = await api.request(`/state?threadId=${session.id}`);
  assert.equal(state.session.turns[0].answers[`answer-${accepted.turnId}`], `mock reply ${accepted.turnId}`);
  assert.equal((await api.request("/health")).status, "ready");
});

test("上一轮没结束时再提交返回 409，服务端不替客户端排队", async t => {
  const { app, api } = await appFixture(t);
  const session = await api.request("/sessions", {});
  const first = await api.request("/turns", { threadId: session.id, text: "A" });
  await assert.rejects(api.request("/turns", { threadId: session.id, text: "B" }), /上一轮还在执行/);
  await until(() => app.sessions.getTurn(session.id, first.turnId)?.status === "completed");
  await api.request("/turns", { threadId: session.id, text: "B" });
  assert.equal(app.sessions.snapshot(session.id).turns.length, 2);
});

test("客户端在回复途中被关掉，服务端这一轮照常完成；重新连接后能看到结果", async t => {
  const { root, app, api } = await appFixture(t);
  const chat = client(root, app);
  chat.child.stdin.write("first\n");
  await until(() => chat.output.includes("Agent：mock "));
  chat.child.kill("SIGTERM");
  await chat.exited;
  const [session] = [...app.sessions.sessions.values()];
  await until(() => app.sessions.getTurn(session.id, "turn-1")?.status === "completed");
  const resumed = await api.request("/sessions/resume", { threadId: session.id });
  assert.equal(resumed.turns[0].answers["answer-turn-1"], "mock reply turn-1");
});

test("CLI 管道连续输入并 /exit：逐条交给服务端，每条是一个新的 turn", async t => {
  const { root, app } = await appFixture(t);
  const chat = client(root, app);
  chat.child.stdin.end("first\nsecond\n/exit\n");
  assert.equal(await chat.exited, 0, chat.output);
  assert.match(chat.output, /已退出客户端/);
  const [session] = [...app.sessions.sessions.values()];
  assert.deepEqual(app.sessions.snapshot(session.id).turns.map(turn => turn.status), ["completed", "completed"]);
  assert.ok(!chat.output.includes(fixture.CODEX_API_KEY));
  assert.ok(!chat.output.includes(app.token));
});

test("CLI 轮询快照增量显示，连续两轮的回复不换行拆碎", async t => {
  const { root, app } = await appFixture(t);
  const chat = client(root, app);
  chat.child.stdin.write("first\n");
  await until(() => chat.output.includes("Agent：mock reply turn-1\n"));
  chat.child.stdin.write("second\n");
  await until(() => chat.output.includes("Agent：mock reply turn-2\n"));
  chat.child.stdin.end("/exit\n");
  assert.equal(await chat.exited, 0, chat.output);
  assert.match(chat.output, /turn id: turn-1\nAgent：mock reply turn-1\nturn id: turn-2\nAgent：mock reply turn-2\n/);
  assert.equal(chat.output.split("Agent：").length - 1, 2);
  assert.equal(chat.output.split("Thread id: thread-1").length - 1, 1);
});

test("认证令牌私有保存；拒绝未认证、跨源和错误 JSON 请求；关闭后清理连接信息和锁", async t => {
  const { root, app, api } = await appFixture(t);
  const file = path.join(root, ".data", "connection.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadClientConnection({}, root).url, app.url);
  assert.ok(!readFileSync(file, "utf8").includes(fixture.CODEX_API_KEY));
  assert.equal((await fetch(app.url + "/health")).status, 401);
  assert.equal((await fetch(app.url + "/health", { headers: { authorization: `Bearer ${app.token}`, origin: "https://untrusted.invalid" } })).status, 403);
  const bad = await fetch(app.url + "/turns", { method: "POST", headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" }, body: "null" });
  assert.equal(bad.status, 400);
  await assert.rejects(api.request("/messages", { threadId: "x", text: "A" }), /接口不存在/);
  assert.equal((await api.request("/health")).model, "unit-model");
  await app.close();
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(path.join(root, ".data", "server.lock")), false);
});

test("重复启动同项目会明确拒绝，不出现两个服务", async t => {
  const { app } = await appFixture(t);
  await assert.rejects(startAgentServer({ config: app.config, log: () => {} }), /已有 Agent 服务/);
});

test("Codex 状态写在本服务的 .data/codex，并关闭原生记忆", async t => {
  const { root, app } = await appFixture(t);
  const home = path.join(root, ".data", "codex");
  assert.equal(app.config.launch.env.CODEX_HOME, home);
  const toml = readFileSync(path.join(home, "config.toml"), "utf8");
  assert.match(toml, /^# project-managed Codex configuration\n/);
  assert.match(toml, /\[features\]\nmemories = false/);
  assert.ok(existsSync(path.join(app.runtime.runDir, "protocol.jsonl")));
  assert.equal(app.runtime.workspaceDir, realpathSync(path.join(root, "workspace")));
});
