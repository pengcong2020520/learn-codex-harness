import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import { prepareRun, resolveWorkspace } from "../server/modules/codex/runtime.mjs";
import { createFileTools } from "../server/modules/data/files.mjs";
import { createToolService } from "../server/modules/tools/loader.mjs";
import { verifySkills } from "../server/modules/codex/skills.mjs";
import { fixture, installToolFixture, tempRoot, rig, until } from "./helpers.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";

function edit(root, change) {
  const file = path.join(root, "agents/writing-agent.json"), value = JSON.parse(fs.readFileSync(file));
  change(value); fs.writeFileSync(file, JSON.stringify(value));
}
async function assemble(t, change = () => {}) {
  const root = installToolFixture(tempRoot(t)); edit(root, change);
  const config = loadServerConfig(root, fixture), agent = new AgentDefinition(root);
  const runtime = await prepareRun(config.launch, root, { workspaceDir: agent.workspacePath, instructions: agent.instructions });
  agent.configure(config, runtime);
  const files = createFileTools(root, { workspaceDir: runtime.workspaceDir, sources: agent.sources, outputs: agent.outputs, assertCurrent: () => agent.assertCurrent() });
  const registry = await createToolService(root, { agent, files }); agent.activate(registry.version);
  return { root, config, agent, runtime, files, registry };
}

test("稳定工作区与 runDir 分离；缺失外部工作区和服务状态目录显式拒绝", async t => {
  const { root, runtime } = await assemble(t);
  const second = await prepareRun({ args: [] }, root);
  assert.equal(runtime.workspaceDir, second.workspaceDir); assert.notEqual(runtime.runDir, second.runDir);
  await assert.rejects(resolveWorkspace(root, path.join(root, "missing")), /工作区不存在/);
  await assert.rejects(resolveWorkspace(root, root), /不能把服务/);
  const external = tempRoot(t);
  assert.equal(await resolveWorkspace(root, external), fs.realpathSync(external));
});

test("Agent schema 拒绝未知字段、缺失必需引用、原生权限提升和不支持的来源方法", t => {
  const root = installToolFixture(tempRoot(t)), original = fs.readFileSync(path.join(root, "agents/writing-agent.json"));
  for (const change of [v => v.extra = true, v => v.agent.executionRef = "missing", v => delete v.bindings.sources.originals,
    v => v.bindings.executions["restricted-local"].nativeShell = true, v => v.agent.dataBindings[0].methods = ["sql"],
    v => v.agent.outputs.directory = "inputs", v => v.agent.dataBindings[0].actions = ["create"],
    v => v.bindings.sources.originals.root = "inputs/../drafts", v => v.agent.instructions = "../.env"]) {
    fs.writeFileSync(path.join(root, "agents/writing-agent.json"), original); edit(root, change);
    assert.throws(() => new AgentDefinition(root));
  }
});

test("来源范围收窄，list/read 一致过滤；产物创建不附带读取权；读结果带溯源", async t => {
  const { root, files } = await assemble(t, v => {
    v.agent.dataBindings = [v.agent.dataBindings[0]];
  });
  fs.writeFileSync(path.join(root, "workspace/inputs/source.md"), "原始观点");
  assert.deepEqual(files.list_files({}).entries.map(item => item.name), ["inputs"]);
  assert.throws(() => files.list_files({ path: "drafts" }), /未授权/);
  assert.throws(() => files.read_file({ path: "outputs/new.md" }), /未授权/);
  assert.throws(() => files.write_file({ path: "drafts/no.md", content: "no" }), /未授权/);
  const read = files.read_file({ path: "inputs/source.md" });
  assert.equal(read.sourceId, "originals"); assert.equal(read.locator, "inputs/source.md"); assert.match(read.revision, /^[a-f0-9]{64}$/);
  const output = files.write_file({ path: "outputs/new.md", content: "文章" });
  assert.deepEqual(output.artifact.checks, ["file-exists", "format"]);
  assert.equal(fs.readFileSync(path.join(root, "workspace/outputs/new.md"), "utf8"), "文章");
  assert.throws(() => files.write_file({ path: "outputs/new.md", content: "覆盖" }), /未覆盖/);
});

test("普通记录复用现有写入接口，按需创建 notes 子目录且仍禁止覆盖", async t => {
  const { root, registry } = await assemble(t);
  const relative = "outputs/notes/check001.txt", content = "这是一个验证文件，验证代码check001";
  assert.equal(fs.existsSync(path.join(root, "workspace/outputs/notes")), false);
  const call = () => registry.call({ tool: "write_file", arguments: { path: relative, content } });
  // 只验证规则对应的工具路径可执行，不将夹具当成模型分类准确率测试。
  const saved = await call();
  assert.equal(saved.success, true);
  assert.equal(JSON.parse(saved.contentItems[0].text).path, relative);
  const read = await registry.call({ tool: "read_file", arguments: { path: relative } });
  assert.equal(read.success, true);
  assert.equal(JSON.parse(read.contentItems[0].text).content, content);
  const duplicate = await call();
  assert.equal(duplicate.success, false);
  assert.match(duplicate.contentItems[0].text, /未覆盖/);
  assert.equal(fs.readFileSync(path.join(root, "workspace", relative), "utf8"), content);
});

test("工作区内的窄来源不能通过父目录、遍历或链接绕过", async t => {
  const root = installToolFixture(tempRoot(t));
  fs.mkdirSync(path.join(root, "workspace/inputs/allowed"), { recursive: true });
  fs.mkdirSync(path.join(root, "workspace/inputs/private"));
  fs.writeFileSync(path.join(root, "workspace/inputs/private/secret.md"), "private");
  edit(root, v => { v.agent.dataBindings = [v.agent.dataBindings[0]]; v.bindings.sources.originals.root = "inputs/allowed"; });
  const agent = new AgentDefinition(root);
  const files = createFileTools(root, { sources: agent.sources, outputs: agent.outputs });
  assert.deepEqual(files.list_files({ path: "inputs" }).entries.map(item => item.name), ["allowed"]);
  for (const relative of ["inputs/private/secret.md", "inputs/allowed/../private/secret.md", "/etc/passwd"]) assert.throws(() => files.read_file({ path: relative }));
  fs.symlinkSync(path.join(root, "workspace/inputs/private/secret.md"), path.join(root, "workspace/inputs/allowed/link.md"));
  assert.throws(() => files.read_file({ path: "inputs/allowed/link.md" }), /符号链接/);
});

test("工具双重范围检查；篡改调用和 Agent 热变更立即拒绝，不能恢复旧权限", async t => {
  const { root, registry } = await assemble(t, v => v.agent.tools.allow = ["list_files"]);
  assert.deepEqual(registry.specs.map(tool => tool.name), ["list_files"]);
  assert.equal((await registry.call({ tool: "write_file", arguments: { path: "outputs/no.md", content: "no" } })).success, false);
  edit(root, v => v.agent.tools.allow = []);
  assert.throws(() => registry.specs, /已变更/);
  assert.equal((await registry.call({ tool: "list_files", arguments: {} })).success, false);
  edit(root, v => v.agent.tools.allow = ["list_files"]);
  assert.equal((await registry.call({ tool: "list_files", arguments: {} })).success, false, "撤销被检测后，恢复文件也不能免重启恢复旧权限");
});

test("工具目录撤销立即约束旧快照，不等待活动 turn 结束", async t => {
  const { root, registry } = await assemble(t);
  const file = path.join(root, "config/tools/files.json"), value = JSON.parse(fs.readFileSync(file));
  value.enabled = false; fs.writeFileSync(file, JSON.stringify(value));
  assert.ok(!registry.specs.some(tool => tool.name === "read_file"));
  assert.equal((await registry.call({ tool: "read_file", arguments: { path: "inputs/source.md" } })).success, false);
});

test("描述符不复制正文或密钥；无绑定的旧会话和不兼容版本明确拒绝", async t => {
  const { agent, root } = await assemble(t);
  agent.bind("thread-test"); agent.assertCompatible("thread-test");
  assert.throws(() => agent.assertCompatible("legacy"), /旧会话/);
  assert.throws(() => agent.assertCompatible("thread-test", "old-job"), /不兼容/);
  const descriptor = fs.readFileSync(path.join(root, ".data/agent-descriptors", `${agent.descriptor.hash}.json`), "utf8");
  assert.ok(!descriptor.includes(fixture.CODEX_API_KEY)); assert.ok(!descriptor.includes("你的任务是"));
  agent.activate("other-tools"); assert.throws(() => agent.assertCompatible("thread-test"), /不兼容/);
});

test("排队执行前检查版本；版本变化不发送下一轮、不重复重发", async t => {
  const r = await rig(t); await r.submit("first", "a");
  await until(() => r.messages.job("a").status === "running");
  await r.submit("next", "b");
  r.config.agent.activate("changed-tools"); r.rpc.finish(r.session.id);
  await until(() => r.messages.job("b").status === "failed");
  assert.equal(r.rpc.calls.filter(call => call.method === "turn/start").length, 1);
});

test("原生 Skill 发现核验与显式输入；新发现的范围外 Skill 被禁用", async t => {
  const { agent, runtime } = await assemble(t);
  const discovered = [{ path: "/allowed/SKILL.md", name: "allowed", enabled: false }, { path: "/other/SKILL.md", name: "other", enabled: true }];
  // 仅接口夹具：不声称此处证明原生 Skill 解析行为。
  const configured = { ...agent, skills: [{ id: "allowed-id", path: discovered[0].path, required: true, version: "v1" }] };
  const rpc = { async request(method, params) {
    if (method === "skills/list") return { data: [{ skills: structuredClone(discovered) }] };
    if (method === "skills/config/write") { discovered.find(item => item.path === params.path).enabled = params.enabled; return {}; }
    throw new Error(method);
  } };
  const skills = await verifySkills(rpc, configured, runtime.workspaceDir);
  assert.equal(discovered[1].enabled, false); assert.equal(skills[0].name, "allowed");
  agent.availableSkills = skills;
  agent.deniedSkillNames = configured.deniedSkillNames;
  assert.equal(agent.input("$allowed 提炼观点")[1].type, "skill");
  assert.throws(() => agent.input("$other 执行"), /未授权/);
  assert.equal(agent.input("请解释 $HOME 变量").length, 1, "普通变量文字不能被误当成非法 Skill");
  assert.equal(agent.input("$allowed-longer").length, 1, "Skill 名称不能按前缀误匹配");
});

test("必需 Skill 缺失或有未满足依赖启动报错；可选引用明确降级", t => {
  const root = installToolFixture(tempRoot(t));
  edit(root, v => v.agent.skills = [{ id: "missing", required: true }]);
  assert.throws(() => new AgentDefinition(root), /缺少必需 Skill/);
  edit(root, v => v.agent.skills[0].required = false);
  assert.match(new AgentDefinition(root).warnings[0], /可选 Skill/);
  edit(root, v => { v.agent.skills[0].required = true; v.bindings.skills.missing = { path: "not-installed", requires: ["shell"] }; });
  assert.throws(() => new AgentDefinition(root), /依赖尚未支持/);
});
