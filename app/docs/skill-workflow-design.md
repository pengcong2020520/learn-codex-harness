# Skill 与 Workflow 设计

**范围：** Agent 包、Skill 安装与读取、Workflow 权限、步骤与任务提议。
**锁定版本：** Codex 0.154.0

总体入口：[本阶段 README](../README.md)。本文说明 `workflows` 配置维度，以及 Skill 的存放与安装方式。

---

## 1 设计原则

**P1 Skill 只教方法，不授权。** 权限只来自 Agent 定义与 Workflow。Skill 被调用、被提及都不改变任何权限。

**P2 Workflow 管边界和终点，不管路径。** Workflow 规定一件事能动用哪些权限、做到什么算完成、哪里必须停下来让人确认；怎么拆解、先做什么、调用哪些工具、调几次，由 Codex 的执行循环自主决定。

**P3 Agent 定义与 workspace 分离。** Agent 定义是受信配置，workspace 是用户和模型读写的数据；后者里的任何文件都不能改变前者，也不能进入模型的系统指令。

**P4 执行循环留在 Codex。** 不在 Node 端实现规划器或 DAG 引擎。多步流程只是同一会话里按顺序发出的多个 Turn，加上人工确认点。

**P5 默认完全自主。** 不指定 workflow 的消息走 `chat`：在 Agent 基础权限内由模型自主完成，不设步骤、不设额外检查。

### 1.1 防止 Workflow 侵蚀自主性的四条规则

1. **只在两种地方切步骤**：权限要变的地方，以及必须由人做决定的地方。不能按"怎么做"切（例如"搜索 → 阅读 → 写作"）。
2. **Workflow 只写目标、边界、验收**。方法写进 Skill，只作参考，模型可以根据情况不用。
3. **验收只看结果**。可以检查"产物存在、格式合规、引用了来源、Wiki 已生效"，不能检查"是否调用过某个工具""是否按某个顺序做"。
4. **确认点从严**。一个 workflow 的人工确认点应当是个位数；"写文章"只有"确认大纲"一个。

---

## 2 四个区与信任边界

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

## 3 Agent 包与 Skill

### 3.1 Agent 包

一个 Agent 一个目录 `agents/<id>/`，`config/runtime/project.json` 指向其中的 `agent.json`。定义使用 `schemaVersion: "1.2"`，也兼容 `1.1`。

- 角色、Skill 路径都相对 Agent 包；`trustedFile` 的检查（不能出包、不能是符号链接）同样适用于 Skill。
- `examples/` 包含"Agent 包"与"workspace 模板"两部分；`npm run agent:init` 根据 Agent 包创建 workspace 目录骨架。
- 创建新 Agent = 复制一个 Agent 包、改配置、绑定一个 workspace。

### 3.2 Skill 的存放、安装与核验

| 环节 | 做法 |
|------|------|
| 存放 | `agents/<id>/skills/<skill>/SKILL.md`，可带 `references/*.md`；只允许文本文件，单文件不超过 128 KiB |
| 安装 | 服务启动时同步到 `CODEX_HOME/skills/<skill>/`（Codex 的 `user` 范围）；同目录写一份受管清单，只清理本服务装过、现已移除的 Skill，不碰 `.system/` |
| 核验 | 沿用 `verifySkills`：只启用 Agent 声明的 Skill，其余（含 `~/.agents/skills` 与 Codex 自带的 6 个）一律关闭，关不掉就拒绝启动 |
| 版本 | Skill 内容纳入 `sourceHash`；Agent 包里的 Skill 被修改即撤销，与角色文件相同 |
| 脚本 | Skill 不带可执行脚本。需要执行能力时写成 MCP 工具（`server/modules/tools` + `config/tools/*.json`），Skill 只写工具名；`requires` 声明"依赖哪些工具"，装配时检查它们都在 `tools.allow` 中 |

### 3.3 Skill 的触发

- **显式**：用户写 `$name`，或 workflow 指定 Skill，由服务端注入 `{ type: "skill", name, path }` 输入项。
- **隐式**：已启用 Skill 的名称、描述、路径会进入模型上下文，但 shell 关闭后模型读不到文件。只读工具 `skill_read({ name, file? })`：只能读已启用 Skill 的目录，默认读 `SKILL.md`，`file` 只能是该目录内的相对路径。模型据描述自行决定读不读。

---

## 4 Workflow

### 4.1 定义

Agent 定义通过 `agent.workflows` 数组声明工作流。只写 `id` 的条目启用同名内置 workflow；带其他字段的条目是用积木组合出的自定义 workflow。`chat` 始终存在，不需要声明。

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

### 4.2 执行链路

```
POST /messages { threadId, text, workflow, params, attachments? }
  → 解析 workflow：参数校验、计算本任务授权（必须是 Agent 能力的子集）
  → 任务入库（workflow、params、step）
  → 权限模块签发任务上下文（grants 取代现在的 maintenanceKb）
  → 注入 Skill 与本步目标，turn/start
  → turn/completed → 运行本步检查
  → 有下一步：confirm 则停在 waiting，否则直接发下一步；没有下一步：completed 或 needs-review
```

非 `chat` 的 Workflow 任务不接受追加消息（`mode: "append"`），提交会返回 403。等待确认的当前步需要修改时，使用 `POST /tasks/revise`、CLI `/revise <意见>` 或网页“修改”，沿用本步权限重做。

`attachments` 是最多 4 个 `inputs/uploads/` 路径的数组，提交时验证当前用户的文件，派发时重新读取。Workflow 第一步携带附件：文本只注入路径提示，正文由模型按需读取；图片作为 Codex `image` 输入发送，并校验所选模型的 `inputs`。后续步骤沿用会话历史。附件路径保存在任务的 `attachments` 字段（`023-task-attachments.sql`）；`npm run up` 会执行迁移。

### 4.3 授权类型

授权类型在代码区定义，Agent 包只能引用。本阶段支持 `knowledge.update`：

| 类型 | 参数 | 含义 | 上限 |
|------|------|------|------|
| `knowledge.update` | `kbId` | 本任务可通过 `kb_submit_revision` 修改该知识库 | Agent 挂载了该知识库且声明了 `update` 动作 |

`writes` 只能收窄，不能放宽：步骤可新建文件的区域 = Agent 基础写入范围 ∩ `writes`。

### 4.4 验收检查

| 检查 | 通过条件 |
|------|---------|
| `file-exists` | 本步至少产生一个产物，且文件实际存在 |
| `format` | 产物扩展名属于 `outputs.formats`，包括 `html`；HTML 与 md/txt 一样遵守文本大小上限和只能新建规则，HTML 格式检查要求可解析且包含 `html` 或 `body` 元素 |
| `sources-cited` | 产物带非空的 `source_versions` |
| `wiki-effective` | 本任务内至少一次 `kb_submit_revision` 返回 `effective: true` |

检查不通过时任务标为 `needs-review` 并推送给客户端，不自动重试，不阻断后续消息。

### 4.5 让模型自己决定"该启动哪个 workflow"

工具 `propose_task({ workflow, params, text, reason })`：模型可以提议，但不能自己批准。调用后生成一条状态为 `proposed` 的任务并推送给客户端；用户确认后才在**用户身份**下核对授权并排队执行，可以附补充说明。普通对话里需要维护知识库时，模型不必再让用户自己去找入口。

- 资源规则里列出 Agent 启用的 workflow（id、名称、参数名、步数），模型据此提议。
- 提议工具需要权限门提供的会话身份（数据层模式）；每个会话最多 3 个待确认提议。
- Agent 必须在 `tools.allow` 里显式允许 `propose_task`。

### 4.6 任务记录与兼容

- 迁移 `003-workflows.sql`：`tasks` 新增 `workflow`（默认 `chat`）、`params`、`checks`，状态增加 `needs-review`，把已有的 `knowledge` 列转换为 `workflow = 'knowledge-maintain'`。
- 迁移 `004-workflow-steps.sql`：新增 `step`、`note`（确认时的补充说明），状态增加 `waiting`、`cancelled`。
- 迁移 `005-task-proposals.sql`：新增 `reason`（提议理由），状态增加 `proposed`。
- 迁移 `022-workflow-revise.sql`：新增 `revise_count`（任务字段 `reviseCount`），记录本步重做次数，范围为 0–10；继续到下一步时归零。
- 消息里旧的 `knowledge` 字段兼容一个版本，映射为 `knowledge-maintain`。
- workflow 属于 Agent 描述符，`CONTRACTS.agent` 为 2。`sessions:upgrade` 识别"知识维护改为 workflow 没有扩大权限"，可以为旧会话登记兼容映射。

---

## 5 自主性：谁决定什么

| 层 | 由谁决定 | 决定的内容 |
|----|---------|-----------|
| 用户 | 人 | 要做一件什么事；在确认点拍板 |
| Workflow | 服务端，按配置 | 能动用哪些权限；做到什么算完成；哪里必须停下来 |
| Codex 执行循环 | 模型 | 怎么做：拆解、顺序、工具、次数、换方法、何时收尾 |
| Skill | 模型 | 方法参考，自行决定用不用 |

**跨轮次的自主推进**：本阶段通过 `features.goals=false` 关闭 Codex 原生线程目标与目标工具，避免自动轮次绕过任务队列和权限门。模型通过 `propose_task` 提议任务。

---

## 6 原生上下文与能力边界

下表说明原生能力与服务配置的关系。本机模拟模型可检查上下文与协议，不能验证真实模型主动使用 Skill 的效果。

| 原生行为 | 行为说明 | 本阶段处理 |
|--------|------|-------------|
| Skill 放在 `CODEX_HOME/skills` | 被发现（scope `user`），显式调用时正文注入 | Skill 安装位置确定为 `CODEX_HOME/skills` |
| 已启用 Skill 的名称、描述、路径 | 进入模型上下文；被禁用的不出现 | 通过 `skill_read` 读取已启用 Skill |
| 被禁用的 Skill 直接作为输入项发给 Codex | Codex 不注入正文 | 我们的检查之外还有一层保护 |
| workspace 及其上级目录的 `AGENTS.md` | **均被加载**进模型上下文 | 启动参数设置 `project_doc_max_bytes=0`；角色指令本来就走 `instructions_template` |
| 用户真实 HOME 的 `~/.agents/skills` | 会被发现 | `verifySkills` 关闭未声明的 Skill |
| 规划类工具 | 没有 `update_plan`；有 `create_goal / get_goal / update_goal` | 见第 5 节 |
| 设置线程目标后 | **Codex 自动连续发起轮次**，直到 `update_goal(complete)` | 启动参数设置 `features.goals=false`，并校验有效开关 |
| `request_user_input` | 对模型可见，但默认模式下返回 "unavailable in Default mode"，轮次照常完成 | 不处理 |

---

## 7 验证命令与边界

在本阶段目录运行 `npm test`；检查 Codex 行为时运行 `npm run test:protocol`、`npm run test:codex-tools`；检查权限、任务表或知识库时运行 `npm run test:data`。

角色提示词与 `write-article` Skill 均保留方法说明。`skill_read` 支持读取 Skill，但真实模型是否主动读取、如何遵循方法，仍需真实模型评估；本机模拟模型不能证明这一点。

---

## 8 待验证与风险

| 项 | 说明 |
|----|------|
| 多步流程中的会话上下文 | 每步是同一会话的新 Turn，模型能看到前面步骤的历史；步骤处于 `waiting` 时可用 `POST /tasks/revise`、CLI `/revise <意见>` 或网页“修改”按意见重做当前步。同一步最多 10 次，保留已确认部分，产物使用新文件名，权限不扩大 |
| 旧会话 | 描述符变化后旧会话需 `sessions:upgrade` 登记映射，否则按现有规则拒绝续用、要求新建会话 |
