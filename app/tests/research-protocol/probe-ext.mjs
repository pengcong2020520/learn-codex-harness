// 验证：项目启动参数没关 hooks / plugins 时，CODEX_HOME、$HOME、工作目录里放进去的 hooks、插件、技能会不会被加载，能否绕开项目门禁。
// 全部在临时 HOME 下进行，不碰真实 HOME。用法：node probe-ext.mjs [--cli path] [--hardened]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadServerConfig } from "../../server/modules/config/index.mjs";
import { prepareRun } from "../../server/modules/codex/runtime.mjs";
import { prepareCodexConfig } from "../../server/modules/codex/config.mjs";
import { CodexConnection } from "../../server/modules/codex/connection.mjs";
import { sendResponse, answer, toolSpecs } from "../responses-fixture.mjs";
import { redactLocalPaths } from "./redact.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const cli = opt("--cli") ? path.resolve(opt("--cli")) : path.join(here, "../../node_modules/@openai/codex/bin/codex.js");
const outputDir = process.env.PROTOCOL_REPORT_DIR;
if (!outputDir) throw new Error("Run npm run test:protocol:research");
const codexVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "../package.json"))).version;
const hardened = argv.includes("--hardened");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let respond = () => answer("ok"); const requests = [];
const http = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const body = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString());
  requests.push(body); try { sendResponse(res, await respond(body)); } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise(r => http.listen(0, "127.0.0.1", r));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ext-"));
const HOME = path.join(root, "home"); const markers = path.join(root, "markers");
for (const d of [".runs", "workspace", "home", "markers"]) fs.mkdirSync(path.join(root, d), { recursive: true });
const config = loadServerConfig(root, { AGENT_DEFINITION: "probe-agent.json", CODEX_API_KEY: "local-test-only", CODEX_BASE_URL: `http://127.0.0.1:${http.address().port}/v1`,
  CODEX_MODEL: "local-test-model", CODEX_MODEL_CATALOG_ENABLED: "true", CODEX_MODEL_CONTEXT_WINDOW: "128000", DEMO_TIMEOUT_MS: "60000" });
const paths = prepareCodexConfig(config, {});
config.launch.env = { ...config.launch.env, HOME };
if (hardened) config.launch.args.push("-c", "features.hooks=false", "-c", "features.plugins=false");
const runtime = await prepareRun(config.launch, root);
const ws = runtime.workspaceDir;

// ---- 布置“意外”扩展 ----
const marker = name => `${process.execPath} -e "require('fs').writeFileSync('${path.join(markers, name)}', require('fs').readFileSync(0,'utf8'))"`;
const denyHook = name => `${process.execPath} -e "require('fs').writeFileSync('${path.join(markers, name)}', require('fs').readFileSync(0,'utf8')); process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'HOOK_DENY'}}))"`;
const hooksJson = prefix => ({ hooks: {
  SessionStart: [{ hooks: [{ type: "command", command: marker(prefix + "-SessionStart") }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: marker(prefix + "-UserPromptSubmit") }] }],
  PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: denyHook(prefix + "-PreToolUse") }] }],
  Stop: [{ hooks: [{ type: "command", command: `${process.execPath} -e "require('fs').writeFileSync('${path.join(markers, prefix + "-Stop")}','x');process.stdout.write('{}')"` }] }] } });
fs.writeFileSync(path.join(paths.home, "hooks.json"), JSON.stringify(hooksJson("codexhome")));          // CODEX_HOME 层
fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });
fs.writeFileSync(path.join(ws, ".codex/hooks.json"), JSON.stringify(hooksJson("workspace")));          // 工作目录项目层
const skill = (dir, name) => { fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: LEAKMARK-${name} test skill\n---\nbody\n`); };
skill(path.join(HOME, ".agents/skills"), "home-skill");        // $HOME 层技能
skill(path.join(ws, ".agents/skills"), "workspace-skill");      // 工作目录技能
skill(path.join(paths.home, "skills"), "codexhome-skill");      // CODEX_HOME 技能
// $HOME 个人插件市场 + 默认安装的本地插件（带技能、MCP、hooks）
const plug = path.join(HOME, ".codex/plugins/leak-plugin");
fs.mkdirSync(path.join(plug, ".codex-plugin"), { recursive: true });
fs.writeFileSync(path.join(plug, ".codex-plugin/plugin.json"), JSON.stringify({ name: "leak-plugin", version: "1.0.0", description: "test",
  skills: "./skills/", mcpServers: "./.mcp.json", hooks: "./hooks/hooks.json" }));
skill(path.join(plug, "skills"), "plugin-skill");
const toolsFile = path.join(root, "plugin-tools.json"); fs.writeFileSync(toolsFile, JSON.stringify(["plugin_tool"]));
fs.writeFileSync(path.join(plug, ".mcp.json"), JSON.stringify({ mcpServers: { leakmcp: { command: process.execPath, args: [path.join(here, "hub-mcp.mjs"), toolsFile] } } }));
fs.mkdirSync(path.join(plug, "hooks"), { recursive: true }); fs.writeFileSync(path.join(plug, "hooks/hooks.json"), JSON.stringify(hooksJson("plugin")));
fs.mkdirSync(path.join(HOME, ".agents/plugins"), { recursive: true });
fs.writeFileSync(path.join(HOME, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "leak-market", plugins: [{ name: "leak-plugin",
  source: { source: "local", path: "./.codex/plugins/leak-plugin" }, policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" }, category: "Productivity" }] }));

// ---- 跑 ----
const rpc = new CodexConnection({ launch: config.launch, runtime, redact: x => typeof x === "string" ? x : JSON.stringify(x), cli, log: () => {} });
await rpc.open();
let handlerCalls = 0; rpc.toolHandler = async () => { handlerCalls++; return { success: true, contentItems: [{ type: "inputText", text: "HANDLER_RAN" }] }; };
const DYN = [{ type: "function", name: "probe_echo", description: "Echo.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
const safe = async (m, p) => { try { return await rpc.request(m, p); } catch (e) { return { error: e.message }; } };
const out = { codexVersion, hardened, launchArgs: config.launch.args.filter(a => a.includes("features") || a.includes("tools.") || a.includes("agents")) };
out.hooksList = await safe("hooks/list", { cwds: [ws] });
out.skillsList = await safe("skills/list", { cwds: [ws], forceReload: true });
if (argv.includes("--disable-skills")) { // 模拟项目 verifySkills：把范围外 Skill 全部关掉
  for (const sk of out.skillsList.data[0].skills) await safe("skills/config/write", { path: sk.path, enabled: false });
  out.skillsAfterDisable = (await safe("skills/list", { cwds: [ws], forceReload: true })).data?.[0]?.skills.map(x => x.name + ":" + x.enabled); }
out.pluginList = await safe("plugin/list", { cwds: [ws] });
out.pluginInstalled = await safe("plugin/installed", { cwds: [ws] });
let toolOut;
respond = body => { const inp = body.input || []; const o = inp.filter(i => i.type === "function_call_output");
  if (o.length) { toolOut = o.at(-1).output; return answer("done"); }
  const s = toolSpecs(body).find(x => x.name === "probe_echo"); return { type: "function_call", id: randomUUID(), call_id: randomUUID(), name: s.name, arguments: "{}", status: "completed" }; };
const t = await rpc.request("thread/start", { sandbox: "read-only", approvalPolicy: "never", baseInstructions: "probe", model: "local-test-model", modelProvider: "project_api", cwd: ws, dynamicTools: DYN });
const done = new Promise(res => rpc.on("notification", m => { if (m.method === "turn/completed") res(m.params.turn.status); }));
const hookEvents = []; rpc.on("notification", m => { if (/^hook\//.test(m.method)) hookEvents.push(m.method + ":" + (m.params?.run?.eventName || m.params?.eventName || m.params?.hook?.eventName || "")); });
await rpc.request("turn/start", { threadId: t.thread.id, input: [{ type: "text", text: "go", text_elements: [] }] });
out.turnStatus = await Promise.race([done, sleep(30000).then(() => "timeout")]);
await sleep(1000);
const all = JSON.stringify(requests);
out.modelSawTools = [...new Set(requests.flatMap(b => toolSpecs(b).map(x => (x.namespace || "") + x.name)))].sort();
out.modelContextMentions = ["home-skill", "workspace-skill", "codexhome-skill", "plugin-skill", "plugin_tool", "leak-plugin", "skill-installer", "imagegen", "plugin-creator"].filter(k => all.includes(k));
out.dynamicToolHandlerCalls = handlerCalls; out.dynamicToolOutputSeenByModel = toolOut;
out.hookMarkersWritten = fs.readdirSync(markers).sort();
out.hookNotifications = hookEvents;
await rpc.close(); http.close(); http.closeAllConnections();
const file = path.join(outputDir, `results-ext-${codexVersion}${hardened ? "-hardened" : ""}${argv.includes("--disable-skills") ? "-skills-off" : ""}.json`);
fs.writeFileSync(file, redactLocalPaths(JSON.stringify(out, null, 2))); console.log(JSON.stringify(out, null, 2));
fs.rmSync(root, { recursive: true, force: true }); process.exit(0);
