// 角色提示词评估：在独立的临时项目里，用真实模型跑 eval/role/scenarios 下的固定场景，记录 token、工具调用与产出。
// 需要与正式服务相同的数据层（PostgreSQL / Redis）和模型配置。每次运行都用新的项目目录和数据身份，不影响正在运行的服务；
// 会真实调用模型、产生费用。
//
// node scripts/eval-role.mjs --variant current=agents/writing --variant slim=<Agent 包目录> [--repeat 3] [--only s1-local-doc,s4-report]
//   [--env .env] [--out .runs/eval-role/<时间>] [--timeout-min 20] [--capture]
// --capture 在 Codex 与模型服务之间放一个透传代理，记下每次请求的内容与组成（不改动请求和响应）。
// 之后用 scripts/eval-role-score.mjs 打分并生成报告。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { startAgentServer } from "../server/main.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { modelEndpoint } from "../server/modules/gateway/index.mjs";
import { captureProxy, composition } from "./eval/capture-proxy.mjs";

const app = fileURLToPath(new URL("../", import.meta.url));
const scenarioRoot = path.join(app, "eval/role/scenarios");
const ended = ["completed", "failed", "unconfirmed", "interrupted", "needs-review", "waiting", "cancelled", "proposed"];

export function loadScenarios(only = []) {
  return fs.readdirSync(scenarioRoot).sort().filter(id => !only.length || only.includes(id)).map(id => {
    const dir = path.join(scenarioRoot, id), scenario = JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf8"));
    if (scenario.id !== id) throw new Error(`场景目录名与 id 不一致：${id}`);
    return { ...scenario, inputs: fs.existsSync(path.join(dir, "inputs")) ? path.join(dir, "inputs") : null };
  });
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [{ path: path.relative(base, full).split(path.sep).join("/"), content: fs.readFileSync(full, "utf8") }];
  });
}

// 与 installToolFixture 相同的做法：复制服务代码与配置，Agent 包换成待评估的版本，依赖目录用链接。
export function prepareRoot(agentDir, scenario) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-role-")));
  for (const dir of ["config", "server", "shared"]) fs.cpSync(path.join(app, dir), path.join(root, dir), { recursive: true });
  fs.cpSync(agentDir, path.join(root, "agents/writing"), { recursive: true });
  fs.symlinkSync(path.join(app, "node_modules"), path.join(root, "node_modules"), "dir");
  const definition = JSON.parse(fs.readFileSync(path.join(root, "agents/writing/agent.json"), "utf8"));
  const workspace = path.resolve(root, "agents/writing", definition.bindings.workspaceDir);
  const dirs = [...Object.values(definition.bindings.sources).map(source => source.root), definition.agent.outputs.directory,
    ...Object.values(definition.bindings.knowledgeBases || {}).flatMap(kb => [kb.sourceRoot, kb.wikiRoot])];
  for (const dir of dirs) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  if (scenario.inputs) fs.cpSync(scenario.inputs, path.join(workspace, "inputs"), { recursive: true });
  return { root, workspace };
}

async function waitFor(server, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await server.messages.job(id);
    if (ended.includes(job?.status)) return job;
    if (Date.now() > deadline) return { ...job, status: "timeout" };
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

export async function runOnce({ label, agentDir, scenario, index, env, out, timeoutMs, dataFactory, capture = false }) {
  const { root, workspace } = prepareRoot(agentDir, scenario);
  const endpoint = modelEndpoint(env);
  const proxy = capture ? await captureProxy(endpoint.baseUrl) : null;
  // 采集时让 Codex 直连代理，代理再原样转给模型网关或模型服务。
  const config = loadServerConfig(root, proxy ? { ...env, AGENT_GATEWAY_KEY: "", CODEX_BASE_URL: proxy.url, CODEX_API_KEY: endpoint.apiKey } : env);
  config.port = 0;
  const started = Date.now(), usage = { total: null, requests: 0 }, tools = [];
  let server;
  const record = { label, scenario: scenario.id, index, model: config.launch.model };
  try {
    server = await startAgentServer({ config, log: () => {}, ...(dataFactory ? { dataFactory } : {}) });
    record.instructionsChars = server.agent.instructions.length;
    record.skills = server.agent.skills.map(skill => skill.id);
    server.rpc.on("notification", message => {
      const params = message.params || {};
      if (message.method === "thread/tokenUsage/updated") { usage.total = params.tokenUsage.total; usage.requests++; }
      if (message.method === "item/completed" && ["dynamicToolCall", "mcpToolCall"].includes(params.item?.type)) {
        const { tool, status, success, arguments: args } = params.item;
        tools.push({ tool, status, success: success ?? null, args: tool === "skill_read" || tool === "read_file" || tool === "write_file" || tool === "search_web"
          ? Object.fromEntries(Object.entries(args || {}).filter(([key]) => key !== "content")) : undefined });
      }
    });
    const session = await server.sessions.create();
    const id = `eval-${scenario.id}-${label}-${index}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 128);
    await server.messages.submit({ threadId: session.id, clientMessageId: id, text: scenario.prompt });
    const job = await waitFor(server, id, timeoutMs);
    const turn = job.turnId ? server.sessions.getTurn(session.id, job.turnId) : null;
    Object.assign(record, { status: job.status, error: job.error || null, reply: turn ? Object.values(turn.answers).join("\n\n") : "" });
  } catch (error) {
    Object.assign(record, { status: "error", error: error.message });
  } finally {
    record.elapsedMs = Date.now() - started;
    record.usage = usage;
    record.tools = tools;
    record.files = walk(workspace).filter(file => !file.path.startsWith("inputs/"));
    await server?.close().catch(() => {});
    await proxy?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  const dir = path.join(out, label, scenario.id);
  fs.mkdirSync(dir, { recursive: true });
  if (proxy) {
    record.requestParts = proxy.requests.map(body => body && composition(body));
    fs.writeFileSync(path.join(dir, `run-${index}.requests.json`), JSON.stringify(proxy.requests, null, 2));
  }
  fs.writeFileSync(path.join(dir, `run-${index}.json`), JSON.stringify(record, null, 2));
  return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    variant: { type: "string", multiple: true }, repeat: { type: "string", default: "3" }, only: { type: "string", default: "" },
    env: { type: "string", default: path.join(app, ".env") }, out: { type: "string" }, "timeout-min": { type: "string", default: "20" },
    capture: { type: "boolean", default: false } } });
  const variants = (values.variant || []).map(item => {
    const [label, dir] = item.split("=");
    if (!/^[a-zA-Z0-9_-]+$/.test(label || "") || !dir) throw new Error("--variant 格式：名称=Agent 包目录，名称只用字母、数字、- 和 _");
    const agentDir = path.resolve(app, dir);
    if (!fs.existsSync(path.join(agentDir, "agent.json"))) throw new Error(`没有找到 ${agentDir}/agent.json`);
    return { label, agentDir };
  });
  if (!variants.length) throw new Error("至少指定一个 --variant");
  const scenarios = loadScenarios(values.only ? values.only.split(",") : []);
  const out = path.resolve(values.out || path.join(app, ".runs/eval-role", new Date().toISOString().replace(/[:.]/g, "-")));
  const timeoutMs = Number(values["timeout-min"]) * 60_000;
  const env = { ...process.env, ...parseEnv(fs.readFileSync(values.env, "utf8")), AGENT_TURN_TIMEOUT_MS: String(timeoutMs) };
  fs.mkdirSync(out, { recursive: true });
  console.log(`输出目录：${out}`);
  // 轮流交换版本的先后顺序，减少时段差异（服务商负载、缓存）对比较的影响。
  for (let index = 1; index <= Number(values.repeat); index++) {
    for (const scenario of scenarios) {
      for (const variant of index % 2 ? variants : [...variants].reverse()) {
        const record = await runOnce({ ...variant, scenario, index, env, out, timeoutMs, capture: values.capture });
        const total = record.usage.total;
        console.log(`[${index}] ${scenario.id} ${variant.label}：${record.status}，${record.usage.requests} 次请求，` +
          `输入 ${total?.inputTokens ?? "-"}（缓存 ${total?.cachedInputTokens ?? "-"}），输出 ${total?.outputTokens ?? "-"}，` +
          `${Math.round(record.elapsedMs / 1000)} 秒${record.error ? `；${record.error}` : ""}`);
      }
    }
  }
}
