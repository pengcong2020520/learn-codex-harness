# Skill 与 Workflow 设计

**状态：** 设计确认，按第 8 节的 PR 顺序实施；第 0 步验证与第 1–4 个 PR 已完成。
**日期：** 2026-10-31
**锁定版本：** Codex 0.154.0

总体设计入口：[基于 Codex App Server 的 Agent 脚手架设计方案](agent-core-design.md)。本文新增第 9 个配置维度 `workflows`，并调整 Skill 的存放与安装方式。

---

## 1 要解决的问题

| # | 问题 | 现状依据 |
|---|------|---------|
| Q1 | **知识维护写死在 4 个地方**。再加一种"写文章"任务，4 处都要再改一遍 | 消息的 `knowledge` 字段（`messages/index.mjs`）、`gate.maintenance()` 与任务上下文的 `maintenanceKb`（`permissions/index.mjs`）、自动加 `$knowledge` 前缀（`messages/index.mjs:150`）、CLI 的 `knowledge maintain` 入口 |
| Q2 | **流程只写在角色提示词里**。模型跳步了服务端不知道，中间没有确认点，做完也无法判断算不算完成 | `agents/roles/writing-assistant.md` 的 7 步流程与保存规则 |
| Q3 | **Skill 放在用户数据目录里，且实际上只能显式触发** | `bindings.skills.*.path` 相对 workspace，靠 `knowledge init` 复制；shell 关闭后模型无法自己读取 SKILL.md |
| Q4 | **用户数据目录里的指令文件会进入模型上下文** | 第 0 步验证：workspace 及其上级目录的 `AGENTS.md` 均被 Codex 加载 |
| Q5 | **Codex 原生"目标"机制可以绕过任务队列自动发起轮次** | 第 0 步验证：`create_goal` 对模型可见；设置目标后 Codex 自动连续发起轮次，直到目标完成 |

---

## 2 设计原则

**P1 Skill 只教方法，不授权。** 权限只来自 Agent 定义与 Workflow。Skill 被调用、被提及都不改变任何权限。

**P2 Workflow 管边界和终点，不管路径。** Workflow 规定一件事能动用哪些权限、做到什么算完成、哪里必须停下来让人确认；怎么拆解、先做什么、调用哪些工具、调几次，由 Codex 的执行循环自主决定。

**P3 Agent 定义与 workspace 分离。** Agent 定义是受信配置，workspace 是用户和模型读写的数据；后者里的任何文件都不能改变前者，也不能进入模型的系统指令。

**P4 执行循环留在 Codex。** 不在 Node 端实现规划器或 DAG 引擎。多步流程只是同一会话里按顺序发出的多个 Turn，加上人工确认点。

**P5 默认完全自主。** 不指定 workflow 的消息走 `chat`：在 Agent 基础权限内由模型自主完成，不设步骤、不设额外检查。

### 2.1 防止 Workflow 侵蚀自主性的四条规则

1. **只在两种地方切步骤**：权限要变的地方，以及必须由人做决定的地方。不能按"怎么做"切（例如"搜索 → 阅读 → 写作"）。
2. **Workflow 只写目标、边界、验收**。方法写进 Skill，只作参考，模型可以根据情况不用。
3. **验收只看结果**。可以检查"产物存在、格式合规、引用了来源、Wiki 已生效"，不能检查"是否调用过某个工具""是否按某个顺序做"。
4. **确认点从严**。一个 workflow 的人工确认点应当是个位数；"写文章"只有"确认大纲"一个。

---

## 3 四个区与信任边界

| 区 | 内容 | 谁能改 | 变更方式 |
|---|------|-------|---------|
| 代码区 | 工具实现、授权类型、验收检查、内置 workflow | 开发者 | PR + 测试 |
| Agent 包 | `agent.json`、角色、Skill、workflow 声明 | 部署者 | 只能组合代码区提供的积木；改动触发撤销，受控重启后生效 |
| Workspace | 用户资料、过程文件、交付物、Wiki | 用户与模型（模型受资源规则约束） | 运行时 |
| 运行状态区 | `.data/`（含 `CODEX_HOME`）、`.runs/` | 只有服务 | 服务自身 |

```
agents/writing/                      workspace/（bindings.workspaceDir）
├── agent.json                       ├── inputs/      只读资料
├── role.md                          ├── research/    过程文件
└── skills/                          ├── drafts/
    ├── knowledge/SKILL.md           ├── outputs/     交付物
    └── write-article/SKILL.md       └── research/general/wiki  知识库
          │
          └── 启动时同步 ──→ .data/codex/skills/<id>/   （CODEX_HOME，Codex 从这里发现）
```

---

## 4 Agent 包与 Skill

### 4.1 Agent 包

一个 Agent 一个目录 `agents/<id>/`，`config/runtime/project.json` 指向其中的 `agent.json`。定义升级为 `schemaVersion: "1.2"`，`1.1` 继续可读。

- 角色、Skill 路径都相对 Agent 包；`trustedFile` 的检查（不能出包、不能是符号链接）同样适用于 Skill。
- `examples/` 拆成"Agent 包"与"workspace 模板"两部分；`npm run agent:init` 根据 Agent 包创建 workspace 目录骨架。
- 创建新 Agent = 复制一个 Agent 包、改配置、绑定一个 workspace。

### 4.2 Skill 的存放、安装与核验

| 环节 | 做法 |
|------|------|
| 存放 | `agents/<id>/skills/<skill>/SKILL.md`，可带 `references/*.md`；只允许文本文件，单文件不超过 128 KiB |
| 安装 | 服务启动时同步到 `CODEX_HOME/skills/<skill>/`（Codex 的 `user` 范围）；同目录写一份受管清单，只清理本服务装过、现已移除的 Skill，不碰 `.system/` |
| 核验 | 沿用 `verifySkills`：只启用 Agent 声明的 Skill，其余（含 `~/.agents/skills` 与 Codex 自带的 6 个）一律关闭，关不掉就拒绝启动 |
| 版本 | Skill 内容纳入 `sourceHash`；Agent 包里的 Skill 被修改即撤销，与角色文件相同 |
| 脚本 | Skill 不带可执行脚本。需要执行能力时写成 MCP 工具（`server/modules/tools` + `config/tools/*.json`），Skill 只写工具名；`requires` 改为"依赖哪些工具"，装配时检查它们都在 `tools.allow` 中 |

### 4.3 Skill 的触发

- **显式**：用户写 `$name`，或 workflow 指定 Skill，由服务端注入 `{ type: "skill", name, path }` 输入项。已实现。
- **隐式**：已启用 Skill 的名称、描述、路径会进入模型上下文（第 0 步已验证），但 shell 关闭后模型读不到文件。新增只读工具 `skill_read({ name, file? })`：只能读已启用 Skill 的目录，默认读 `SKILL.md`，`file` 只能是该目录内的相对路径。模型据描述自行决定读不读。

---

## 5 Workflow

### 5.1 定义

Agent 定义新增 `agent.workflows` 数组。只写 `id` 的条目启用同名内置 workflow；带其他字段的条目是用积木组合出的自定义 workflow。`chat` 始终存在，不需要声明。

```json
"workflows": [
  { "id": "knowledge-maintain" },
  {
    "id": "write-article",
    "label": "写文章",
    "skill": "write-article",
    "steps": [
      { "id": "outline", "goal": "确定立意与大纲，保存到 drafts/", "writes": ["drafts"], "confirm": true },
      { "id": "final", "goal": "完成研究、写作、核查并定稿", "writes": ["research", "drafts", "outputs"],
        "checks": ["file-exists", "format", "sources-cited"] }
    ]
  }
]
```

| 字段 | 含义 |
|------|------|
| `skill` | 本 workflow 注入的 Skill，必须已在 `agent.skills` 中声明 |
| `params` | 参数的 JSON Schema；消息提交时校验 |
| `grants` | 基础权限之外、仅本任务有效的授权，类型来自 5.3 的授权表，不能超出 Agent 已有能力 |
| `steps` | 可选；每步一个 Turn。`goal` 是本步的目标说明，`writes` 收窄本步可新建文件的区域，`confirm` 表示本步完成后等待用户确认 |
| `checks` | 验收检查，来自 5.4 的检查表；可写在 workflow 或步骤上 |

内置 workflow：

| id | skill | params | grants | checks |
|----|-------|--------|--------|--------|
| `chat` | 无 | 无 | 无 | 无 |
| `knowledge-maintain` | `knowledge` | `{ kbId }` | `knowledge.update`（限 `params.kbId`） | `wiki-effective` |

### 5.2 执行链路

```
POST /messages { threadId, text, workflow, params }
  → 解析 workflow：参数校验、计算本任务授权（必须是 Agent 能力的子集）
  → 任务入库（workflow、params、step）
  → 权限模块签发任务上下文（grants 取代现在的 maintenanceKb）
  → 注入 Skill 与本步目标，turn/start
  → turn/completed → 运行本步检查
  → 有下一步：confirm 则停在 waiting，否则直接发下一步；没有下一步：completed 或 needs-review
```

追加消息（`mode: "append"`）沿用当前任务的 workflow 与授权，不能更换 workflow，也不能扩大授权（推广现有"知识维护不能用追加提交"的规则）。

### 5.3 授权类型

授权类型在代码区定义，Agent 包只能引用。首版只有一种：

| 类型 | 参数 | 含义 | 上限 |
|------|------|------|------|
| `knowledge.update` | `kbId` | 本任务可通过 `kb_submit_revision` 修改该知识库 | Agent 挂载了该知识库且声明了 `update` 动作 |

`writes` 只能收窄，不能放宽：步骤可新建文件的区域 = Agent 基础写入范围 ∩ `writes`。

### 5.4 验收检查

| 检查 | 通过条件 |
|------|---------|
| `file-exists` | 本步至少产生一个产物，且文件实际存在 |
| `format` | 产物扩展名属于 `outputs.formats` |
| `sources-cited` | 产物带非空的 `source_versions` |
| `wiki-effective` | 本任务内至少一次 `kb_submit_revision` 返回 `effective: true` |

检查不通过时任务标为 `needs-review` 并推送给客户端，不自动重试，不阻断后续消息。

### 5.5 让模型自己决定"该启动哪个 workflow"

新增工具 `propose_task({ workflow, params, reason })`：模型可以提议，但不能自己批准。调用后生成一条状态为 `proposed` 的任务并推送给客户端；用户确认后才按 workflow 授权排队执行。普通对话里需要维护知识库时，模型不必再让用户自己去找入口。

### 5.6 任务记录与兼容

- 迁移 `003-workflows.sql`：`tasks` 新增 `workflow`（默认 `chat`）、`params`、`checks`，状态增加 `needs-review`，把已有的 `knowledge` 列转换为 `workflow = 'knowledge-maintain'`。
- 迁移 `004-workflow-steps.sql`：新增 `step`、`note`（确认时的补充说明），状态增加 `waiting`、`cancelled`。`proposed` 随 `propose_task` 加入。
- 消息里旧的 `knowledge` 字段兼容一个版本，映射为 `knowledge-maintain`。
- workflow 纳入 Agent 描述符，`CONTRACTS.agent` 升为 3。`sessions:upgrade` 识别"知识维护改为 workflow 没有扩大权限"，可以为旧会话登记兼容映射。

---

## 6 自主性：谁决定什么

| 层 | 由谁决定 | 决定的内容 |
|----|---------|-----------|
| 用户 | 人 | 要做一件什么事；在确认点拍板 |
| Workflow | 服务端，按配置 | 能动用哪些权限；做到什么算完成；哪里必须停下来 |
| Codex 执行循环 | 模型 | 怎么做：拆解、顺序、工具、次数、换方法、何时收尾 |
| Skill | 模型 | 方法参考，自行决定用不用 |

**跨轮次的自主推进**：Codex 0.154 原生提供线程目标（`thread/goal/set`，状态 `active / paused / blocked / budgetLimited / complete`）。目标处于 `active` 时，Codex 在每轮结束后自动发起下一轮，直到模型调用 `update_goal` 标记完成，或耗尽 token 预算。它是"不自造 loop"前提下实现长任务自主推进的正确机制，但这些自动轮次不经过任务队列和权限门，所以首版先关闭（第 7 节），作为后续 PR `feat/workflow-goals` 接入：由 workflow 设置目标与预算，任务上下文覆盖同一目标下的所有自动轮次，目标结束后再跑验收；模型自己创建目标的能力仍然关闭，改由 `propose_task` 提议。

---

## 7 第 0 步验证结果

在本项目的生产受限配置下启动完整服务，用本机模拟模型截获 Codex 发给模型的请求。结论将在 `fix/restricted-native-context` 中转为集成测试。

| 验证项 | 结果 | 对方案的影响 |
|--------|------|-------------|
| Skill 放在 `CODEX_HOME/skills` | 被发现（scope `user`），显式调用时正文注入 | Skill 安装位置确定为 `CODEX_HOME/skills` |
| 已启用 Skill 的名称、描述、路径 | 进入模型上下文；被禁用的不出现 | 隐式触发只差一个读取工具，即 `skill_read` |
| 被禁用的 Skill 直接作为输入项发给 Codex | Codex 不注入正文 | 我们的检查之外还有一层保护 |
| workspace 及其上级目录的 `AGENTS.md` | **均被加载**进模型上下文 | 启动参数加 `project_doc_max_bytes=0`，已验证有效；角色指令本来就走 `instructions_template` |
| 用户真实 HOME 的 `~/.agents/skills` | 会被发现 | `verifySkills` 已全部关闭，保持 |
| 规划类工具 | 没有 `update_plan`；有 `create_goal / get_goal / update_goal` | 见第 6 节 |
| 设置线程目标后 | **Codex 自动连续发起轮次**，直到 `update_goal(complete)` | 启动参数加 `features.goals=false`（已验证有效），并纳入有效开关校验；接入留给 `feat/workflow-goals` |
| `request_user_input` | 对模型可见，但默认模式下返回 "unavailable in Default mode"，轮次照常完成 | 不处理 |

---

## 8 实施计划

| 顺序 | 分支 | 内容 | 对外行为 |
|------|------|------|---------|
| 1 | `fix/restricted-native-context` | 关闭 `goals`、禁止加载 `AGENTS.md`、workspace 不能是服务目录的上级；第 0 步验证转为集成测试 | 安全修补 |
| 2 | `refactor/agent-package` | Agent 包、Skill 移出 workspace 并同步到 `CODEX_HOME`、示例拆分、通用 init | 不变 |
| 3 | `feat/workflow-registry` | Workflow 层、`chat` 与 `knowledge-maintain`、授权改造、验收检查、迁移 003、CLI 与工作台入口 | 知识维护行为不变，新增 workflow 接口 |
| 4 | `feat/workflow-steps` | 多步与确认点、`writes` 收窄、`write-article` | 新能力 |
| 5 | `feat/propose-task` | `propose_task` 工具与 `proposed` 状态 | 新能力 |
| 6 | `feat/skill-read-tool` | 隐式触发与多文件 Skill；角色提示词瘦身 | 新能力 |
| 7 | `docs/s06` | 冻结 `stages/s06`、章节 README、改写 s05 的"接下来" | 课程 |
| 后续 | `feat/workflow-goals` | 原生目标接入任务与权限门 | 待定 |

角色提示词瘦身从第 4 个 PR 移到第 6 个：Skill 能被隐式触发之前，把写作方法和保存规则移出角色，会让普通对话失去这些指引。第 4 个 PR 只把"写文章"的分步方法写进 `write-article` Skill，角色里保留原有说明并提示可以使用该工作流。

每个 PR：根目录 `npm test`；涉及 Codex 行为时加 `test:protocol`、`test:codex-tools`；涉及权限、任务表或知识库时加 `test:data`。

---

## 9 待验证与风险

| 项 | 说明 |
|----|------|
| 目标的受控接入 | 需要验证：服务端设置的目标能否在关闭模型侧 `create_goal` 的同时生效；自动轮次能否稳定关联到同一任务上下文 |
| 多步流程中的会话上下文 | 每步是同一会话的新 Turn，模型能看到前面步骤的历史；确认点之间用户可以追加修改意见，追加不得扩大授权 |
| 旧会话 | 描述符变化后旧会话需 `sessions:upgrade` 登记映射，否则按现有规则拒绝续用、要求新建会话 |
| 冻结阶段 | `stages/s03–s05` 同样存在 Q4、Q5；它们是冻结快照，按 CONTRIBUTING 的规则不回补，在 s06 章节中说明 |
