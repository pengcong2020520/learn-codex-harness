# s06: Skill 与 Workflow — Skill 教方法，Workflow 管边界和终点

[s00](../s00-sdk-quickstart/) → [s01](../s01-single-turn/) → [s02](../s02-multi-turn/) → [s03](../s03-agent-core/) → [s04](../s04-data-layer/) → [s05](../s05-knowledge-layer/) → `s06` → [app](../../app/)
> *"可以提议，不能自批"* — 判断要不要做交给模型，给不给权限留在模型之外。
>
> **Harness 层**: 任务 — 一类任务能动用哪些权限、做到什么算完成、哪里必须停下来问人。

---

## 问题

s05 的知识维护能跑通，但它是写死的。在代码里搜一下，它散落在四个地方：消息里的 `knowledge` 字段、权限门里的 `maintenanceKb`、调度时给原文悄悄加的 `$knowledge` 前缀、CLI 的单独入口。想再加一种"写文章"任务，四处都要再改一遍。

写文章本身也有问题。"理解观点 → 研究 → 大纲 → 初稿 → 核查 → 润色 → 定稿"只写在角色提示词里：模型跳了步，服务端不知道；用户想先看大纲再决定，没有地方停下来；做完了，也没法判断算不算完成。

Skill 那边还有两个坑：

1. Skill 放在 `workspace/.agents/skills/`，靠 `knowledge init` 复制进去。工作区是用户和模型读写的数据，**受信配置不该放在这里**。
2. shell 关闭后，模型看得到技能清单，却打不开 SKILL.md。Skill 实际上只能靠 `$name` 显式触发。

最后，第 0 步验证还发现两处缺口：工作区及其上级目录的 `AGENTS.md` 会进入模型上下文；Codex 原生的"线程目标"一旦设置，会绕过任务队列自动连续发起轮次。

---

## 解决方案

![Skill 与 Workflow](images/skill-workflow.svg)

把三件事分开：

| 层 | 回答什么 | 谁定义 | 能否授权 | 放在哪里 |
|----|---------|-------|---------|---------|
| Skill | 怎么做：方法、规范、模板 | 部署者，跟着 Agent 包 | **不能** | `agents/<id>/skills/` → 启动时同步到 `CODEX_HOME` |
| Workflow | 本任务额外的授权、注入哪个 Skill、做完检查什么、哪里停下来 | 部署者，只能组合代码提供的积木 | 能，只在本任务有效 | `agent.json` 的 `workflows` |
| Workspace | 数据放在哪 | 用户与模型（受资源规则约束） | — | `bindings.workspaceDir` |

Workflow 只管边界和终点，**不管路径**。怎么拆解、先查什么、调哪些工具、调几次，仍由 Codex 的执行循环决定。为了不把 Workflow 写成脚本流水线，定了四条规则：

1. 只在**权限要变**或**必须由人拍板**的地方切步骤，不按"怎么做"切。
2. Workflow 只写目标、边界、验收；方法写进 Skill，只作参考。
3. 验收只看结果，不检查调用过哪些工具、按什么顺序。
4. 确认点从严："写文章"只在大纲之后停一次。

---

## 工作原理

**第 1 步**：受限启动再收紧两项。关掉原生线程目标，不加载 `AGENTS.md`；启动后用 `config/read` 核对生效值，没生效就拒绝启动（[`launch.mjs`](server/modules/codex/launch.mjs)）。

```javascript
launch.args.push("-c", "features.goals=false", "-c", "project_doc_max_bytes=0",
```

**第 2 步**：一个 Agent 一个目录（Agent 包）。角色和 Skill 都相对 `agent.json` 解析，而且不能落在工作区里；启动时把 Skill 同步到 `CODEX_HOME/skills`，只清理自己装过的副本（[`agents/index.mjs`](server/modules/agents/index.mjs)、[`codex/skills.mjs`](server/modules/codex/skills.mjs)）。

```javascript
if (inside(this.workspacePath, this.roleFile)) throw new Error("角色文件不能放在工作区里。");

export function installSkills(agent, codexHome) {
  const root = path.join(codexHome, "skills");
  // …
  for (const skill of packaged)
    if (fs.existsSync(path.join(root, skill.id)) && !managed.has(skill.id))
      throw new Error(`CODEX_HOME/skills/${skill.id} 已存在且不是本服务安装的，未覆盖。`);
```

**第 3 步**：在 `agent.json` 里声明 Workflow。只写 `id` 是启用内置的，带其他字段的是自定义组合。默认写作 Agent 的"写文章"分两步，第 1 步只能写 `drafts/`，做完停下来等确认：

```json
"workflows": [
  { "id": "knowledge-maintain" },
  { "id": "write-article", "label": "写文章", "skill": "write-article", "steps": [
    { "id": "outline", "goal": "理解用户观点，确定立意与大纲，保存到 drafts/ 并请用户确认", "writes": ["drafts"], "confirm": true },
    { "id": "final", "goal": "按确认的大纲完成研究、写作、事实核查和润色，定稿保存到 outputs/",
      "writes": ["research", "drafts", "outputs"], "checks": ["file-exists", "format"] } ] }
]
```

**第 4 步**：解析时把授权落到具体的知识库上，超出 Agent 能力的直接拒绝。权限门把授权放进本任务的上下文，任务结束即失效；`writes` 只能收窄新建文件的位置（[`workflows/index.mjs`](server/modules/workflows/index.mjs)、[`permissions/index.mjs`](server/modules/permissions/index.mjs)）。

```javascript
const grants = (workflow.grants || []).map(grant => ({ type: grant.type, kbId: typeof grant.kbId === "object" ? params[grant.kbId.param] : grant.kbId }));
for (const grant of grants) if (!updatable.has(grant.kbId)) throw new AppError(`Agent 没有更新知识库 ${grant.kbId} 的权限。`, 403, "FORBIDDEN");

if (action !== 'read' && context.kind === 'task' && !context.grants.some(g => g.type === 'knowledge.update' && g.kbId === kbId)) denied();
if (action === 'create' && context.kind === 'task' && context.writes && !context.writes.some(root => covers(root, locator))) denied();
```

**第 5 步**：派发时不改写用户原文。任务说明（目标、授权、验收）放在原文之前，Workflow 指定的 Skill 按 id 注入；第二步起只说明用户已确认，并带上补充说明（[`messages/index.mjs`](server/modules/messages/index.mjs)）。

```javascript
const workflow = this.resolve({ id: job.workflow || "chat", params: job.params ?? null });
const step = stepOf(workflow, job.step || 0);
let input = step.index ? `用户已确认上一步，请继续。${extra}` : `${job.text}${extra}`;
// …
this.gate?.start(job, workflow.grants, step.writes);
```

**第 6 步**：一步结束后只看结果决定去向：验收不通过记为 `needs-review`，还有下一步时要么停在 `waiting` 等确认，要么直接排队。

```javascript
if (checks && !checks.every(check => check.passed)) return { status: "needs-review", checks };
if (step.index < step.total - 1) return step.confirm ? { status: "waiting", checks } : { status: "queued", step: step.index + 1, checks };
return { status: "completed", checks };
```

**第 7 步**：模型那一侧多了两个工具。`skill_read` 按技能清单读已启用 Skill 的白名单文件，Skill 因此能被隐式触发；`propose_task` 只能把任务记为 `proposed`，用户确认时才在**用户身份**下核对授权。

```javascript
const skill = (this.availableSkills || []).find(item => item.name === name);
if (!skill) throw new AppError(`Skill 未启用或不存在：${name}`, 404, "SKILL_UNAVAILABLE");

if (job.status === "proposed") {
  const workflow = this.resolve({ id: job.workflow, params: job.params ?? null });
  if (workflow.grants.length) this.gate?.authorize(workflow.grants);
}
```

知识维护从四处写死变成了一条声明：`{ "id": "knowledge-maintain" }`。再加一类任务，改的是 `agent.json`，不是代码；需要新的授权类型或验收检查时，才需要写代码、走 PR。

---

## 试一下

**准备**（与 s05 相同，需要 PostgreSQL / Redis 和模型配置；本阶段端口 4316）：

```sh
cd stages/s06-skill-workflow
npm ci
cp .env.example .env    # 填入模型配置、DATABASE_URL、REDIS_URL
npm run data:migrate
npm run agent:init && npm run knowledge:init
npm run server          # 另开终端：npm run chat
```

试试这些输入：

1. `/workflow` → 列出当前 Agent 启用的工作流。
2. `/workflow write-article 写一篇关于社区咖啡馆的文章` → 大纲存进 `drafts/` 后停下。输入 `/confirm 第二部分多写案例`，看第 2 步怎么接着做、结束时报告的验收结果。
3. 普通对话里说"把 inputs/general 里的新资料整理进知识库" → Agent 直接改 Wiki 会被拒绝，它会提议 `knowledge-maintain`。`/confirm` 执行，或 `/reject` 忽略。
4. 复制一个 Agent 包：`cp -r agents/writing agents/mine`，改 `agent.json` 的 `id` 和 `role.md`，再用 `AGENT_DEFINITION=agents/mine/agent.json npm run check` 检查。

观察重点：第 2 步里，模型研究、写作、核查的顺序是谁决定的？第 3 步里，提议之后、确认之前，知识库有没有变化？

**离线实验**（不调用模型）：

```sh
npm run lesson -- list
npm run lesson -- s06-propose   # 提议只记录为 proposed，确认时才授权
npm run lesson -- s06-steps     # 停在确认点时普通对话照常执行
```

设计取舍、实施顺序与验证记录见 [s06 设计说明](docs/design.md) 和 [Skill 与 Workflow 设计](docs/skill-workflow-design.md)。

---

## 接下来

到这里，Agent 能按配置组合出不同的任务，并且每一步都有边界和终点。还有三个问题没有回答：

- 模型会不会主动去读 Skill？`skill_read` 只证明了"能读"，"会读"需要用真实模型评估，之后才能决定把哪些方法从角色提示词移进 Skill。
- 一个任务要跨很多轮才能做完时怎么办？Codex 原生的线程目标能自主推进，但现在为了安全把它关掉了，接入任务与权限门之后才能打开。
- 多个用户共用一个服务时，任务、授权和工作区怎么隔离？现在的设计默认一个服务只服务一个用户（见 [多用户升级方案](docs/multi-user-upgrade-plan.md)）。

[app](../../app/README.md) 在 s06 之上继续演进，这些问题会在那里继续解决。
