import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import { validateDefinition } from "../server/modules/agents/schema.mjs";
import { verifySkills } from "../server/modules/codex/skills.mjs";
import { installAgentFixture, tempRoot } from "./helpers.mjs";

test("Skill scope 缺省与显式 system 均记录描述符，不改变发现和输入授权", async t => {
  const root = installAgentFixture(tempRoot(t)), file = path.join(root, "agents/writing-agent.json");
  const base = JSON.parse(fs.readFileSync(file)), outcomes = [];
  base.agent.skills = [{ id: "scope-fixture", required: true }];
  if (base.agent.workflows) base.agent.workflows = [];
  base.bindings.skills = { "scope-fixture": { path: "skills/scope-fixture/SKILL.md" } };
  const workspace = path.resolve(path.dirname(file), base.bindings.workspaceDir);
  const skillFile = path.resolve(false ? path.dirname(file) : workspace, base.bindings.skills["scope-fixture"].path);
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, "---\nname: scope-fixture\ndescription: fixture\n---\nFixture.");
  for (const scope of [undefined, "system"]) {
    const value = structuredClone(base);
    if (scope !== undefined) value.agent.skills[0].scope = scope;
    fs.writeFileSync(file, JSON.stringify(value));
    const agent = new AgentDefinition(root, file);
    assert.equal(agent.definition.agent.skills[0].scope, "system");
    assert.equal(agent.skills[0].scope, "system");
    const discovered = [{ name: "scope-fixture", path: agent.skills[0].path, enabled: false },
      { name: "outside", path: path.join(root, "outside/SKILL.md"), enabled: true }];
    const rpc = { async request(method, params) {
      if (method === "skills/list") return { data: [{ skills: structuredClone(discovered) }] };
      if (method === "skills/config/write") { discovered.find(s => s.path === params.path).enabled = params.enabled; return {}; }
      throw new Error(method);
    } };
    const skills = await verifySkills(rpc, agent, workspace);
    agent.runtime = { workspaceDir: workspace };
    await agent.activate(skills);
    assert.equal(agent.descriptor.skills[0].scope, "system");
    const saved = JSON.parse(fs.readFileSync(path.join(root, ".data/agent-descriptors", `${agent.descriptor.hash}.json`)));
    assert.equal(saved.skills[0].scope, "system");
    assert.equal(discovered[1].enabled, false);
    assert.throws(() => agent.input("$outside 执行"), /未授权/);
    outcomes.push({ input: agent.input("$scope-fixture 执行"), execution: agent.execution, enabled: discovered.map(s => s.enabled) });
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
  for (const scope of ["private", "shared", "SYSTEM", "", null, false, 1]) {
    const value = structuredClone(base); value.agent.skills[0].scope = scope;
    assert.throws(() => validateDefinition(value), /Agent 定义无效/);
  }
});
