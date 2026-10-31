# Codex Agent Harness — 配置驱动的 Agent 脚手架

本项目是基于 [OpenAI Codex](https://learn.chatgpt.com/docs/app-server) 原生 App Server 协议的本机 Agent 服务（默认提供写作示例），监听 `127.0.0.1`，单机单用户本地开发，无多用户公网授权。角色行为、工具权限、资料绑定均由单一 JSON 配置文件集中管理；服务读取配置后挂载原生 Codex 并通过 HTTP/SSE 对外提供 CLI 与本地 Web 接入。

> **设计文档**：[docs/agent-core-design.md](docs/agent-core-design.md)（实施前基线，供参考）；实际实现以本 README 为准。

本期数据层已接入 PostgreSQL + Redis + 文件存储，并保留 Codex 原生存储。审查结论、迁移步骤和验收边界见 [数据层升级说明](docs/data-layer.md)。当前仍是本机单用户入口，未实现账号登录或多用户运行环境隔离。

知识层设计基线见 [知识层架构方案](docs/knowledge-layer-design.md)及[图文阅读版](docs/knowledge-layer-design.html)：复用 Codex 原生执行与 Skills，新增通用权限门禁，分离能力执行与资源管理；默认 Wiki、可选 Chroma + BM25。s05 已实现统一门禁、版本化 Wiki 与可选 Chroma + BM25，具体接口、运行方式和剩余边界见 [知识层实现说明](docs/knowledge-implementation.md)。

运行要求 Node.js ≥ 24；npm 依赖锁定 `@openai/codex` 0.154.0，无需全局安装 Codex。第三方模型端点必须支持 Responses API；只有 Chat Completions 接口不能直接接入，生成模型目录 JSON 不会转换协议。

## 五个阶段的教学与 Web 工作台

在本目录运行 `npm run web`，打开 [互动课程](http://127.0.0.1:4320/course/) 或 [Agent 工作台](http://127.0.0.1:4320/)。课程无需模型服务；工作台可切换五个阶段和当前项目，连接已启动的对应服务。完整操作与边界见 [web/README.md](web/README.md)。

两个可复制场景见 [examples](examples/README.md)。配置选择、会话兼容、工具身份接口及冒烟模板见 [脚手架升级说明](docs/harness-upgrade.md)。

## 快速启动

```bash
# 1. 进入项目目录并安装依赖
cd app
npm ci

# 2. 准备环境变量（已有 .env 则跳过，不覆盖）
test -f .env || cp .env.example .env
# 编辑 .env，填写模型配置，以及 DATABASE_URL、REDIS_URL
# 启动 PostgreSQL / Redis（Docker，详见 docs/data-layer.md），再初始化：
npm run db:up
npm run data:migrate
npm run data:check
# 有旧 JSON 状态时先停服备份，预检并显式导入：
npm run data:import
# 确认预检后执行 npm run data:import -- --apply

# 3. 准备工作区与知识目录，然后启动服务（Agent 包里的 Skill 在启动时自动安装）
npm run agent:init
npm run knowledge:init
# 默认端口 4317，监听 127.0.0.1
npm run server

# 4. 另开终端，启动 CLI
npm run chat
```

## 部署到服务器

把服务常驻部署到 Linux 服务器（systemd 管理、Docker 运行数据服务、只监听 127.0.0.1、SSH 隧道访问）见 [deploy/README.md](deploy/README.md)：

```bash
export DEPLOY_HOST=root@<服务器地址>
app/deploy/remote.sh init-env && app/deploy/remote.sh deploy   # 首次部署
app/deploy/remote.sh tunnel                                     # 浏览器打开 http://127.0.0.1:14320/
```

## 环境变量（`.env`）

| 变量 | 说明 | 默认值 |
|---|---|---|
| `CODEX_API_KEY` | 模型 API 密钥，API Key 接入时必填 | — |
| `CODEX_BASE_URL` | 模型 API 基础 URL | 见 `.env.example` |
| `CODEX_MODEL` | 使用的模型名称 | 见 `.env.example` |
| `AGENT_PORT` | HTTP 服务监听端口 | `4317` |
| `AGENT_DEFINITION` | Agent 配置文件路径（相对服务根） | 读取 `config/runtime/project.json` |
| `DATABASE_URL` | PostgreSQL 业务数据库地址，正常服务必填 | — |
| `REDIS_URL` | Redis 调度服务地址，正常服务必填 | — |
| `AGENT_MEMORY_ENABLED` | 记忆总开关（服务级） | `false` |
| `AGENT_MEMORY_USE` | 服务级读记忆开关 | `true` |
| `AGENT_MEMORY_GENERATE` | 后台摘要生成独立开关 | `true` |

> `.env` 不被 Git 追踪；`.env.example` 保留全部可用变量及注释。模板中 `CODEX_BASE_URL` 预设 DeepSeek 兼容端点，但 DeepSeek 对 Responses 协议的完整兼容性需自行核实。

## Agent 配置：Agent 包 `agents/writing/`

一个 Agent 一个目录（Agent 包），由 `config/runtime/project.json` 或环境变量 `AGENT_DEFINITION` 选择：

```
agents/writing/
├── agent.json                 # 角色、工具、资料绑定、Skill，schemaVersion "1.2"
├── role.md                    # 角色指令
└── skills/knowledge/SKILL.md  # 本 Agent 的 Skill，启动时同步到 .data/codex/skills/
```

Agent 包是受信配置，workspace 是用户和模型读写的数据：角色和 Skill 不能放进 workspace，workspace 也不能包含服务目录。新建 Agent = 复制一个 Agent 包、改配置、绑定一个 workspace。定义遵循 `schemaVersion: "1.2"`（兼容 1.0、1.1），未知字段和不支持的方法直接拒绝。设计见 [skill-workflow-design.md](docs/skill-workflow-design.md)。

**六项核心字段**：

| 字段 | 作用 |
|---|---|
| `agent.instructions` | 角色指令文件路径，相对 JSON 所在目录，实际正文在 [`agents/writing/role.md`](agents/writing/role.md) |
| `agent.skills` | 原生 Skill 启用列表，格式 `[{"id": "outline", "required": true}]`；默认启用可选的 `knowledge` |
| `agent.tools.allow` | 工具白名单，仅此列表内的工具可被模型调用 |
| `agent.dataBindings` | 资料绑定，控制配置声明的任意资料目录及读写权限 |
| `agent.outputs` | 产物规则，声明允许创建的输出格式与路径 |
| `agent.memory` | 记忆开关：`{"use": false, "contribute": false}` |
| `agent.workflows` | 启用的 Workflow（1.2 起）：只写 `id` 启用内置的，带其他字段的是自定义组合；`chat` 始终存在，见下文 |

**`bindings` 块**：

- `bindings.workspaceDir`：工作区根目录，相对 JSON 所在目录解析，默认 `../../workspace`。仅默认工作区自动创建；外部工作区不存在时明确报错。
- `bindings.sources`：资料源映射；用 `readOnly: true` 声明只读，不依赖目录名字。
- `bindings.executions`：执行策略表（不是执行目录）。
- `bindings.skills`：Skill 路径映射，指向 Agent 包内的 `SKILL.md`（1.1 及以前相对工作区）。
- `agent.executionRef`：执行环境引用字段，指向 `bindings.executions` 中的策略条目。

> 修改此文件、角色或 Skill 后，服务检测到变更会拒绝后续请求，需重启。

**最小修改示例**（只需调整以下片段）：

```jsonc
// 启用 Skill：先在 Agent 包里放 skills/outline/SKILL.md
"agent": {
  "skills": [{"id": "outline", "required": true}]
},
"bindings": {
  "skills": {
    "outline": {"path": "skills/outline/SKILL.md"}
  }
}
```

## 核心模块与数据目录

**启动流程**（[`server/main.mjs`](server/main.mjs)）：
核验 PostgreSQL / Redis、取得实例锁 → 读取 Agent 定义 → 准备路径 → 注册受限资源服务与工具 → 连接原生 Codex → 核验 Skill / 原生动态工具 / 记忆 → 描述符入库、恢复任务 → HTTP 就绪。

**关键目录**：

| 目录 | 说明 |
|---|---|
| `agents/` | Agent 包：`agent.json`、`role.md`、`skills/` |
| `workspace/` | 默认工作区，含 inputs / research / drafts / outputs |
| `.data/` | 实例身份 `identity.json`、不可变正文 `files/`、Codex 原生存储 `codex/`、本机连接与兼容索引；旧 JSON 原件保留但不再作为正常服务权威 |
| `.runs/` | 运行目录，格式 `app-server-*`，保留最近 5 次和 7 天内记录 |
| `config/tools/` | 工具配置 JSON，与 `server/modules/tools` 工厂配合实现配置驱动 |

> PostgreSQL `tasks` 保存用户输入；旧 `.data/messages.json` 和 `.runs` 日志仍可能含私密内容，不要对外公开。数据库、正文、实例身份和原生历史都需备份，不属于缓存。

## 实时事件（`GET /events`，协议 v2）

| 事件 | 何时推送 | 客户端处理 |
|---|---|---|
| `snapshot` | 建立连接，或断点无法补发时 | `data.session` 替换本地会话，`data.queue` 替换队列 |
| `session` | 新建、恢复会话 | 整体替换会话 |
| `turn` | 轮次开始与结束、工具和回复条目变化 | 按 `turn.id` 替换这一轮 |
| `delta` | 回复文字增量，100 ms 合并一次 | 按 `offset` 追加；接不上本地文字就放弃断点，重新同步快照 |
| `queue` / `tools` / `fatal` | 队列、工具目录、服务异常 | 与之前相同 |

每帧带 `id: <进程前缀>-<序号>`。客户端重连时把最后收到的编号放进 `Last-Event-ID` 请求头；服务端缓冲最近 500 个事件，覆盖得到就只补发错过的事件，否则重新发快照。事件归并逻辑在 [`shared/session-events.mjs`](shared/session-events.mjs)，CLI 与 Web 工作台共用。`stages/` 下的冻结快照仍是协议 v1（只有 `snapshot` 与 `session`），工作台两种都能处理。

## 文件工具权限边界

- 默认只允许 `.md`、`.txt`，单文件上限 256 KiB，create-only，不跟随链接，拒绝目录遍历。
- 写作示例将 `inputs` 配置为只读；`research` / `drafts` 可读可创建；`outputs` 通过产物规则允许创建。客服等场景可配置完全不同的目录。
- `articles` 是指向 `outputs` 的来源 ID，不是目录。删除这一读取绑定后，仍能创建 `outputs` 产物，但不能读取它们。
- `read_file` 返回内容、来源 ID、内容 SHA256、定位路径和更新时间；`list_files` 同样过滤未授权来源。
- 文件成功落盘后，检查文件存在性与扩展名并归入 `turn.artifacts`；不证明语义正确或引用真实性，模型自述"已保存"不等于文件真正写入成功。

## Workflow

Workflow 规定一类任务的边界和终点：本任务额外的授权、注入哪个 Skill、做完后检查什么。**怎么做由 Codex 自主决定**，Workflow 不写步骤。不指定时走 `chat`，在 Agent 基础权限内完全自主。设计见 [skill-workflow-design.md](docs/skill-workflow-design.md)。

| 内置 | 参数 | 额外授权 | 验收 |
|---|---|---|---|
| `chat` | 无 | 无 | 无 |
| `knowledge-maintain` | `kbId` | 本任务可以更新该知识库 | 本轮至少一次 Wiki 修订生效 |

默认写作 Agent 还声明了自定义的两步 Workflow `write-article`：第 1 步确定立意与大纲（只能写 `drafts/`），完成后等待确认；确认后第 2 步研究、写作、核查并定稿，检查产物存在且格式合规。每一步之内怎么做由模型决定。

自定义 Workflow 只能组合代码里提供的积木：

```jsonc
"workflows": [
  { "id": "knowledge-maintain" },
  { "id": "report", "label": "写报告", "skill": "report", "checks": ["file-exists", "format", "sources-cited"] }
]
```

- **提交**：`POST /messages` 带 `workflow` 与 `params`；CLI 用 `/workflow 名称 键=值 内容`。旧的 `knowledge: { kbId, operation: "update" }` 字段兼容一个版本，等价于 `knowledge-maintain`。
- **派发**：服务端在用户原文之前加一段任务说明（目标、授权、验收），注入 Workflow 指定的 Skill；权限门为本任务签发 `grants`，任务结束即失效。追加消息沿用当前任务的授权，不能更换 Workflow。
- **验收**：只看结果——`file-exists`、`format`、`sources-cited`、`wiki-effective`。不通过的任务记为 `needs-review` 并推送给客户端，不暂停队列、不自动重试。
- **多步与确认点**：`steps` 只在权限要变或需要人拍板的地方切步骤，每步是同一会话里的一轮。`writes` 收窄本步可新建文件的位置（由权限门执行），`confirm` 表示本步完成后进入 `waiting`。确认用 `POST /tasks/confirm`（可带补充说明作为下一步输入）或 CLI `/confirm`；结束用 `POST /tasks/cancel` 或 `/reject`。等待期间普通对话照常执行。
- **提议**：Agent 在 `tools.allow` 里允许 `propose_task` 时，模型发现需要某个 Workflow 而当前任务没有授权，可以提议。提议记录为 `proposed`，不排队、不授权；用户确认（`/confirm`、工作台"执行提议"）后才在用户身份下核对授权并排队，`/reject` 忽略。每个会话最多 3 个待确认提议。需要数据层的任务身份。
- **升级**：任务表新增 `workflow`、`params`、`checks`、`step`、`note`、`reason` 列（迁移 003–005），升级后先运行 `npm run data:migrate`。

## Skill 使用说明

1. **准备文件**：在 Agent 包的 `skills/<id>/` 下放符合原生规范的 `SKILL.md`，可带 `references/` 下的 `.md`/`.txt`；不能有脚本、链接或其他文件，单文件不超过 128 KiB。
2. **安装**：服务启动时同步到 `.data/codex/skills/<id>/`（Codex 的 user 范围），只清理本服务装过的旧副本，不覆盖其他目录。
3. **发现与收紧**：通过 `skills/list` 发现，用 `skills/config/write` 只启用 Agent 声明的 Skill；工作区、`~/.agents/skills` 与 Codex 自带的 Skill 一律关闭；每轮前复查。
4. **显式调用**：显式 `$skill-name` 或 Workflow 指定的 Skill，会将 `{type: skill, name, path}` 传入，由 Codex 注入正文，不自建解析器。
5. **隐式调用**：已启用 Skill 的名称和描述会出现在 Codex 的技能清单里。Agent 允许 `skill_read` 时，模型可以自行决定按名称读取 `SKILL.md` 或 `references/` 下的文件；只能读已启用 Skill 的白名单文件，读取不授予任何权限。
6. **权限声明**：`requires` 中声明 `shell / fileWrite / assets` 意味着本版不支持的依赖——必需项直接报错，可选项降级；额外工具依赖一律拒绝。
7. **限制**：只支持文本 Skill。需要执行能力时写成工具（`server/modules/tools` + `config/tools/*.json`），Skill 里只写工具名。

## 记忆边界

挂载知识库时，当前版本要求 `AGENT_MEMORY_ENABLED=false`；以下原生记忆能力只在未挂载知识库的配置中使用。

记忆开关分别控制以下行为：

- **读记忆**：`AGENT_MEMORY_USE`（服务级）与 `agent.memory.use`（Agent 级）的交集；两者均为 true 且记忆总开关开启后，才允许原生召回。
- **贡献记忆**：`AGENT_MEMORY_ENABLED`（服务级）与 `agent.memory.contribute`（Agent 级）的交集。`contribute: false` 不禁止读取、不删除旧记忆、不取消已排队任务。
- **后台生成**：`AGENT_MEMORY_GENERATE` 独立控制后台摘要生成，整体 memories 特性还受 `AGENT_MEMORY_ENABLED` 总开关约束。
- 当前禁用原生写工具，导致最终合并摘要仍处于 blocked 状态，该限制已明确。读开关与提炼限制路径已通过真实 Codex + 模拟 Responses 测试；真实模型完整记忆生成链路尚未最终验收。

## 版本与旧会话边界

- 服务启动时生成 **Agent 描述符**并保存到 PostgreSQL `agent_versions`，`conversations` 绑定其版本；记录角色哈希、Skill 版本、工具版本、有效资源策略，不含角色全文或密钥。配置文件仍是唯一可编辑入口。
- 配置、角色、已绑定 Skill 变更被检测后拒绝后续任务和工具调用；恢复文件也需受控重启。
- 正常服务只检索 PostgreSQL 中登记的会话；没有合法绑定的旧历史不会自动接管。已登记且版本相同的 Thread 可跨重启恢复，**不能声称历史无损自动迁移**。
- 描述符使用语义契约，不再包含内核源码全文 hash；实现注释/排版变化不会破坏会话，权限或工具契约变化仍拒绝续用。旧全文指纹可用 `sessions:upgrade` 提供历史证据后预检迁移，详见升级说明。

## CLI 命令速查

| 命令 | 说明 |
|---|---|
| `/new` | 新建会话 |
| `/resume [关键词]` | 按关键词搜索 Thread，再输入完整 Thread ID 选择恢复 |
| `/append 内容` | 向当前轮次追加内容 |
| `/append-to <turnId> 内容` | 向指定 turn 追加内容 |
| `/workflow` | 列出当前 Agent 启用的 Workflow |
| `/workflow <ID> [键=值 ...] 内容` | 按 Workflow 提交新任务，结束后报告验收结果 |
| `/confirm [补充说明]` | 确认等待中的 Workflow 步骤，或执行 Agent 的任务提议 |
| `/reject` | 结束等待确认的 Workflow 任务，或忽略 Agent 的提议 |
| `/queue` | 查看排队任务 |
| `/continue` | 继续暂停的尚未执行队列，不重发未确认任务 |
| `/tools` | 查看当前可用工具 |
| `/memory` | 查看记忆状态 |
| `/exit` | 退出 CLI（不停止服务） |
| `/help` | 显示帮助 |

## 测试命令与现有证据

```bash
# 单元与集成测试
npm test

# 真实 Codex + 本机模拟 Responses 工具测试
npm run test:codex-tools

# 真实 Codex + 本机模拟 Responses 记忆限制测试
npm run test:codex-memory

# 静态检查（不请求模型）
npm run check

# 复用完整服务启动核验；先停止当前服务，不发送模型生成请求
npm run check:server
```

协议、工具和记忆集成使用真实 Codex + 本地模拟 Responses。另有 `npm run smoke:real` 对当前生产路径做真实模型验收：写作与客服示例的资料读取、文件落盘、重启续聊、Wiki 维护和可信身份均已通过，见 [真实报告](docs/verification/real-model-smoke.json)。

`npm run test:protocol` 检查原生 Schema 与实际开关；`npm run test:protocol:research` 运行已接入的研究实验员探针（含超时、多连接、MCP 重载和扩展加载）；`npm run test:data` 验证隔离的 PostgreSQL/Redis；`npm run test:rag` 加入真实 Chroma。完整命令和边界见 [升级说明](docs/harness-upgrade.md)。

**尚未验收**：联网搜索效果、真实模型完整记忆生成链路、多用户认证与隔离。

## 演进历史

当前实现包含配置装配、结构化来源、Wiki、可选 RAG 和可信工具上下文；真实模型完整记忆生成及多用户认证/运行隔离仍后置。

工作区设计基线见 [workspace-design.md](docs/workspace-design.md)；Skill 与 Workflow 的设计和实施计划见 [skill-workflow-design.md](docs/skill-workflow-design.md)；独立教学版本见 [s03–s05 演进总览](../stages/README.md)，演进总览见 [stages/README.md](../stages/README.md)。
