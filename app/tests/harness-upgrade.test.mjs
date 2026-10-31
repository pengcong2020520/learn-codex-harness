import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { schemaContract } from "../server/modules/agents/contracts.mjs";
import { AgentDefinition, digest } from "../server/modules/agents/index.mjs";
import {
  createToolService,
  readToolSources,
} from "../server/modules/tools/loader.mjs";
import { createFileTools } from "../server/modules/data/files.mjs";
import { PermissionGate } from "../server/modules/permissions/index.mjs";
import {
  validateLegacyUpgrade,
  recordCompatibility,
} from "../server/modules/agents/upgrade.mjs";
import {
  requireSupportedVersion,
  verifyRestrictedFeatures,
  RESTRICTED_FEATURES,
} from "../server/modules/codex/compatibility.mjs";
import { installToolFixture, tempRoot } from "./helpers.mjs";
const project = path.resolve(import.meta.dirname, "..");
async function assemble(root, options = {}) {
  const agent = new AgentDefinition(root),
    files = createFileTools(root, {
      workspaceDir: agent.workspacePath,
      sources: agent.sources,
      outputs: agent.outputs,
    });
  agent.runtime = { workspaceDir: agent.workspacePath };
  agent.memory = { enabled: false, use: false, contribute: false };
  const registry = await createToolService(root, { agent, files, ...options });
  await agent.activate(registry.compatibilityVersion);
  return { agent, registry, files };
}
function edit(file, fn) {
  const value = JSON.parse(fs.readFileSync(file));
  fn(value);
  fs.writeFileSync(file, JSON.stringify(value));
}

test("内核注释、工具实现注释、JSON 排版和版本标签不使会话失效；工具契约变化仍阻断", async (t) => {
  const root = installToolFixture(tempRoot(t)),
    first = await assemble(root);
  first.agent.bind("kept-thread");
  const hash = first.agent.descriptor.hash;
  fs.appendFileSync(
    path.join(root, "server/modules/tools/files.mjs"),
    "\n// implementation-only change\n",
  );
  fs.appendFileSync(
    path.join(root, "server/modules/data/files.mjs"),
    "\n// comment\n",
  );
  const file = path.join(root, "agents/writing-agent.json");
  edit(file, (v) => (v.agent.version = "2.0.0"));
  fs.writeFileSync(
    file,
    JSON.stringify(JSON.parse(fs.readFileSync(file)), null, 4),
  );
  edit(
    path.join(root, "config/tools/files.json"),
    (v) =>
      (v.tools[1].inputSchema.properties.path.description =
        "Different example path"),
  );
  const second = await assemble(root);
  assert.equal(second.agent.descriptor.hash, hash);
  assert.notEqual(second.registry.version, first.registry.version);
  second.agent.assertCompatible("kept-thread");
  edit(
    path.join(root, "config/tools/files.json"),
    (v) => (v.contractVersion = 2),
  );
  const breaking = await assemble(root);
  assert.notEqual(breaking.agent.descriptor.hash, hash);
  assert.throws(() => breaking.agent.assertCompatible("kept-thread"), /不兼容/);
});

test("客服示例可独立选择和运行；自定义目录没有四目录依赖，知识挂载与只读冲突在配置阶段报错", async (t) => {
  const root = installToolFixture(tempRoot(t), { knowledge: true });
  fs.cpSync(
    path.join(project, "examples/customer-support"),
    path.join(root, "example"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(root, "example/workspace/work/replies"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "config/runtime/project.json"),
    JSON.stringify({ agentDefinition: "example/agent.json" }),
  );
  fs.rmSync(path.join(root, "agents"), { recursive: true });
  fs.rmSync(path.join(root, "workspace"), { recursive: true });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(path.join(root, "server/modules/role/index.mjs")).href)});`,
    ],
    { stdio: "pipe" },
  );
  const { agent, files } = await assemble(root);
  assert.equal(agent.definition.agent.id, "customer-support");
  assert.match(
    files.read_file({ path: "handbook/policies/returns.md" }).content,
    /7|七/,
  );
  files.write_file({
    path: "work/replies/answer.md",
    content: "Customer response",
  });
  assert.throws(
    () =>
      files.write_file({
        path: "handbook/policies/forged.md",
        content: "override",
      }),
    /未授权|只读/,
  );
  assert.equal(
    fs.existsSync(path.join(root, "example/workspace/inputs")),
    false,
  );
  const file = path.join(root, "example/agent.json"),
    original = fs.readFileSync(file);
  for (const change of [
    (v) => (v.agent.knowledge[0].kbId = "missing"),
    (v) => (v.bindings.knowledgeBases.support.wikiRoot = "handbook"),
    (v) => (v.agent.outputs.directory = "handbook"),
  ]) {
    fs.writeFileSync(file, original);
    edit(file, change);
    assert.throws(() => new AgentDefinition(root));
  }
});

test("工具执行函数收到冻结的可信三元组；并行会话隔离，伪造身份和结束轮次被拒绝", async (t) => {
  const root = installToolFixture(tempRoot(t));
  fs.writeFileSync(
    path.join(root, "server/modules/tools/context.mjs"),
    `export function createTools(){return {inspect_context:async(args,{context})=>{await new Promise(r=>setTimeout(r,3));return {context,frozen:Object.isFrozen(context),claimed:args.userId};}}}`,
  );
  fs.writeFileSync(
    path.join(root, "config/tools/context.json"),
    JSON.stringify({
      module: "server/modules/tools/context.mjs",
      tools: [
        {
          name: "inspect_context",
          label: "Inspect",
          description: "Test context",
          readOnly: true,
          inputSchema: {
            type: "object",
            properties: { userId: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    }),
  );
  edit(
    path.join(root, "agents/writing-agent.json"),
    (v) => (v.agent.tools.allow = ["inspect_context"]),
  );
  const agent = new AgentDefinition(root),
    gate = new PermissionGate({ scope: { ownerId: "trusted-owner" }, agent });
  t.after(() => gate.close());
  const registry = await createToolService(root, { agent, gate });
  const contexts = ["thread-a", "thread-b"].map((threadId) => {
    gate.start({ id: threadId, userId: "trusted-owner", threadId });
    gate.started(threadId, "turn-" + threadId);
    return gate.forTurn(threadId, "turn-" + threadId);
  });
  const results = await Promise.all(
    contexts.map((permissionContext) =>
      registry.call(
        { tool: "inspect_context", arguments: { userId: "forged" } },
        { permissionContext },
      ),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].success, true);
    const v = JSON.parse(results[i].contentItems[0].text);
    assert.equal(v.context.userId, "trusted-owner");
    assert.equal(v.context.threadId, contexts[i].threadId);
    assert.equal(v.context.turnId, contexts[i].turnId);
    assert.equal(v.frozen, true);
  }
  assert.throws(() =>
    gate.start({ id: "evil", threadId: "other", userId: "forged" }),
  );
  assert.equal(
    (
      await registry.call(
        { tool: "inspect_context", arguments: {} },
        { permissionContext: { ...contexts[0] } },
      )
    ).success,
    false,
  );
  gate.end("thread-a");
  assert.equal(
    (
      await registry.call(
        { tool: "inspect_context", arguments: {} },
        { permissionContext: contexts[0] },
      )
    ).success,
    false,
  );
  assert.equal(
    (
      await registry.call(
        { tool: "inspect_context", arguments: {} },
        { permissionContext: gate.user() },
      )
    ).success,
    false,
  );
});

test("旧全文指纹只在配置、旧快照与权限证据一致时登记兼容；历史文件不变", async (t) => {
  const root = installToolFixture(tempRoot(t)),
    { agent } = await assemble(root),
    definition = JSON.parse(fs.readFileSync(agent.file));
  for (const source of Object.values(definition.bindings.sources))
    delete source.readOnly;
  const definitionText = JSON.stringify(definition),
    oldSources = agent.sources.map(({ readOnly, ...source }) => source);
  const previous = {
    ...agent.descriptor,
    schemaVersion: "1.0",
    sources: oldSources,
    definitionHash: digest(definitionText),
    toolVersion: readToolSources(root).version,
    hash: "a".repeat(64),
  };
  const options = { definitionText, toolSnapshot: root, agent };
  const plan = await validateLegacyUpgrade(previous, agent.descriptor, options);
  assert.equal(plan.nativeHistoryModified, false);
  const history = path.join(root, ".data/native-history.jsonl");
  fs.writeFileSync(history, "history-untouched");
  recordCompatibility(root, plan.from, plan.to);
  agent.checkBinding(previous.hash, previous.hash);
  agent.checkBinding(previous.hash, agent.descriptor.hash);
  assert.equal(fs.readFileSync(history, "utf8"), "history-untouched");
  await assert.rejects(
    validateLegacyUpgrade(previous, agent.descriptor, {
      ...options,
      definitionText: "{}",
    }),
    /备份/,
  );
  await assert.rejects(
    validateLegacyUpgrade(
      { ...previous, roleHash: "changed" },
      agent.descriptor,
      options,
    ),
    /roleHash/,
  );
  await assert.rejects(
    validateLegacyUpgrade(
      { ...previous, toolVersion: "wrong" },
      agent.descriptor,
      options,
    ),
    /快照/,
  );
  assert.throws(() => agent.checkBinding("b".repeat(64)), /不兼容/);
});

test("未知 Codex 版本、缺失/失效/移除的原生开关 fail closed", async () => {
  assert.equal(requireSupportedVersion("0.154.0"), "0.154.0");
  assert.throws(() => requireSupportedVersion("0.155.0"), /未通过/);
  const data = RESTRICTED_FEATURES.map((name) => ({
    name,
    enabled: false,
    stage: "stable",
  }));
  const rpc = (features, config = { project_doc_max_bytes: 0 }) => ({
    request: async (method) => (method === "config/read" ? { config } : { data: features }),
  });
  assert.equal((await verifyRestrictedFeatures(rpc(data))).verified, true);
  await assert.rejects(
    verifyRestrictedFeatures(rpc(data, { project_doc_max_bytes: 32768 })),
    /project_doc_max_bytes/,
  );
  for (const bad of [
    data.slice(1),
    data.map((f) => (f.name === "view_image" ? { ...f, enabled: true } : f)),
    data.map((f) => ({ ...f, stage: "removed" })),
  ])
    await assert.rejects(verifyRestrictedFeatures(rpc(bad)));
});

test("Schema 注释不影响兼容，但同名业务属性与 const 值不会被抹除", () => {
  const value = {
    type: "object",
    description: "annotation",
    properties: {
      description: {
        type: "string",
        description: "annotation",
        const: { description: "literal" },
      },
    },
  };
  const normalized = schemaContract(value);
  assert.equal(normalized.description, undefined);
  assert.equal(normalized.properties.description.type, "string");
  assert.deepEqual(normalized.properties.description.const, {
    description: "literal",
  });
});
