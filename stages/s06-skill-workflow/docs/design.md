# s06 设计说明：Skill 与 Workflow

> 本文是设计说明，供深入阅读。章节入门（问题 → 解决方案 → 工作原理 → 试一下）见 [README](../README.md)。完整设计、第 0 步验证记录与实施顺序见 [Skill 与 Workflow 设计](skill-workflow-design.md)。

在 s05 的知识层与通用门禁之上，把"一类任务"抽象成 Workflow，把 Skill 从工作区移进 Agent 包。服务监听 `127.0.0.1:4316`。本阶段快照取自 2026-10-31 的 `app/`，因此也包含 s05 之后陆续加入的配置选择、会话升级、协议兼容检查和流式推送协议 v2；本章只讲 Skill 与 Workflow。

![Skill 与 Workflow](../images/skill-workflow.svg)

---

## 设计原理

s05 证明了"维护知识库"可以作为一种受限的任务来运行，但它是一个特例：入口、授权、Skill 注入各写各的。s06 把这个特例推广开，同时守住两条底线。

**1. 自主性不被流程吃掉**：Codex 的执行循环决定怎么做；Workflow 只规定边界（本任务额外的授权、可写的位置）和终点（验收）。默认的 `chat` 完全不设限。

**2. 权限只来自受信配置**：Agent 定义（角色、Skill、Workflow）放在 Agent 包里，工作区里的任何文件都不能改变它；模型可以提议任务，但不能批准自己的提议。

**设计要点：**

- **Skill 不授权**：Skill 被注入、被读取、被提及，都不改变任何权限。
- **积木由代码提供**：授权类型（`knowledge.update`）和验收检查（`file-exists`、`format`、`sources-cited`、`wiki-effective`）在代码里定义；Agent 包只能组合，越权在启动时报错。
- **步骤从严**：只在权限要变或必须由人拍板的地方切步骤；验收只看结果。
- **原生能力按需收紧**：关闭会绕过任务队列的原生线程目标，不加载工作区里的 `AGENTS.md`。

## 架构改进

| 区 | 内容 | 谁能改 | s06 的变化 |
|----|------|-------|-----------|
| 代码区 | 工具、授权类型、验收检查、内置 Workflow | 开发者，走 PR | 新增 `server/modules/workflows/`、`skill_read`、`propose_task` |
| Agent 包 | `agent.json`、`role.md`、`skills/` | 部署者 | 定义升级到 `schemaVersion: "1.2"`，新增 `agent.workflows` |
| 工作区 | 用户资料、过程文件、交付物、Wiki | 用户与模型 | 不再放 Skill，不加载 `AGENTS.md`，不能包含服务目录 |
| 运行状态区 | `.data/`（含 `CODEX_HOME`）、`.runs/` | 服务 | Skill 在启动时同步到 `CODEX_HOME/skills/<id>/` |

任务表经过三次迁移：`003` 新增 `workflow`、`params`、`checks` 与 `needs-review`；`004` 新增 `step`、`note` 与 `waiting`、`cancelled`；`005` 新增 `reason` 与 `proposed`。

## 技术实现流程

1. **启动**：校验 Agent 定义 → 解析 Workflow（越权即报错）→ 同步 Skill 到 `CODEX_HOME` → 启动 Codex，核对 `goals` 关闭、`project_doc_max_bytes` 为 0 → `verifySkills` 只启用声明的 Skill。
2. **提交**：`/messages` 带 `workflow` 与 `params` → 参数校验、计算授权 → 在用户身份下 `gate.authorize` → 入队，`step = 0`。
3. **派发**：任务说明 + 用户原文 + Workflow 指定的 Skill → `gate.start(job, grants, writes)` → `turn/start`。
4. **执行**：Codex 自主完成本步；需要时用 `skill_read` 读取 Skill，用 `propose_task` 提议别的 Workflow。
5. **收尾**：运行本步验收 → `needs-review` / `waiting` / 排队下一步 / `completed`；权限门在轮次结束时撤销上下文。
6. **确认**：`/tasks/confirm` 让 `waiting` 进入下一步，或让 `proposed` 在用户身份下授权后排队；`/tasks/cancel` 结束。

## 核心代码

以下为伪代码，真实实现见 `server/modules/workflows/index.mjs` 与 `server/modules/messages/index.mjs`。

```text
resolve(id, params):
  workflow = 已启用的 workflows[id] 或 拒绝（403）
  校验 params（只允许扁平字符串字段）
  grants = workflow.grants 按 params 落到具体知识库
  每个 grant 必须在 Agent 的能力之内，否则拒绝（403）
  return { id, skill, params, grants, steps 或 checks }

dispatch(job):
  workflow = resolve(job.workflow, job.params)
  step = workflow 的第 job.step 步
  input = [任务说明(workflow, step)] + (step == 0 ? 原文 : "用户已确认") + 补充说明 + [Skill(workflow.skill)]
  gate.start(job, workflow.grants, step.writes)
  turn/start(input)

on turn/completed(job, turn):
  if turn 不是 completed: 按原规则失败或中断
  checks = 验收(step.checks, turn.artifacts, turn.revisions)
  if 有检查没通过: needs-review
  else if 还有下一步: step.confirm ? waiting : 排队下一步
  else: completed

propose(context, workflow, params, text, reason):
  resolve(workflow, params)            # 只校验，不授权
  记录为 proposed                      # 不排队、不唤醒调度
confirm(task):
  if task 是 proposed: 在用户身份下 gate.authorize(grants)
  排队（proposed）或进入下一步（waiting）
```

## 限制说明

- **隐式触发的效果未经真实模型评估**：`skill_read` 证明模型能读到 Skill，不证明它会主动去读。角色提示词瘦身因此暂缓。
- **线程目标暂时关闭**：原生目标能让 Codex 跨轮次自主推进，但自动发起的轮次不经过任务队列和权限门。接入之前保持关闭。
- **提议需要数据层**：`propose_task` 依赖权限门提供的会话身份，只在 PostgreSQL 模式下可用。
- **Web 工作台与互动课程**：本阶段没有接入工作台和课程；工作台的多步与提议操作在 `app/` 中可用。
