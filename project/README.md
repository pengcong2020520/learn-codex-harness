# Codex Agent Harness — 配置驱动的 Agent 脚手架

本项目是基于 [OpenAI Codex](https://learn.chatgpt.com/docs/app-server) 原生 App Server 协议的本机 Agent 服务（默认提供写作示例），监听 `127.0.0.1`，单机单用户本地开发，无多用户公网授权。角色行为、工具权限、资料绑定均由单一 JSON 配置文件集中管理；服务读取配置后挂载原生 Codex 并通过 HTTP/SSE 对外提供 CLI 与本地 Web 接入。

> **设计文档**：[docs/agent-core-design.md](docs/agent-core-design.md)（实施前基线，供参考）；实际实现以本 README 为准。

本期数据层已接入 PostgreSQL + Redis + 文件存储，并保留 Codex 原生存储。审查结论、迁移步骤和验收边界见 [数据层升级说明](docs/data-layer.md)。当前仍是本机单用户入口，未实现账号登录或多用户运行环境隔离。

知识层设计基线见 [知识层架构方案](docs/knowledge-layer-design.md)及[图文阅读版](docs/knowledge-layer-design.html)：复用 Codex 原生执行与 Skills，新增通用权限门禁，分离能力执行与资源管理；默认 Wiki、可选 Chroma + BM25。Demo 5 已实现统一门禁、版本化 Wiki 与可选 Chroma + BM25，具体接口、运行方式和剩余边界见 [知识层实现说明](docs/knowledge-implementation.md)。

运行要求 Node.js ≥ 24；npm 依赖锁定 `@openai/codex` 0.154.0，无需全局安装 Codex。第三方模型端点必须支持 Responses API；只有 Chat Completions 接口不能直接接入，生成模型目录 JSON 不会转换协议。

## 五个 Demo 的教学与 Web 工作台

在本目录运行 `npm run web`，打开 [互动课程](http://127.0.0.1:4320/course/) 或 [Agent 工作台](http://127.0.0.1:4320/)。课程无需模型服务；工作台可切换五个 Demo 和当前项目，连接已启动的对应服务。完整操作与边界见 [web/README.md](web/README.md)。

两个可复制场景见 [examples](examples/README.md)。配置选择、会话兼容、工具身份接口及冒烟模板见 [脚手架升级说明](docs/harness-upgrade.md)。

## 快速启动

```bash
# 1. 进入项目目录并安装依赖
cd project
npm ci

# 2. 准备环境变量（已有 .env 则跳过，不覆盖）
test -f .env || cp .env.example .env
# 编辑 .env，填写模型配置，以及 DATABASE_URL、REDIS_URL
# 先按 docs/data-layer.md 启动 PostgreSQL / Redis，再初始化：
npm run data:migrate
npm run data:check
# 有旧 JSON 状态时先停服备份，预检并显式导入：
npm run data:import
# 确认预检后执行 npm run data:import -- --apply

# 3. 准备知识目录和原生 Skill，然后启动服务
npm run agent:init
npm run knowledge:init
# 默认端口 4317，监听 127.0.0.1
npm run server

# 4. 另开终端，启动 CLI
npm run chat
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

## Agent 配置：`agents/writing-agent.json`

所有角色、工具、资料绑定集中在 [`agents/writing-agent.json`](agents/writing-agent.json)，遵循 `schemaVersion: "1.1"`（兼容 1.0），未知字段和不支持的方法直接拒绝。

**六项核心字段**：

| 字段 | 作用 |
|---|---|
| `agent.instructions` | 角色指令文件路径，相对 JSON 所在目录，实际正文在 [`agents/roles/writing-assistant.md`](agents/roles/writing-assistant.md) |
| `agent.skills` | 原生 Skill 启用列表，格式 `[{"id": "outline", "required": true}]`；**默认空数组** |
| `agent.tools.allow` | 工具白名单，仅此列表内的工具可被模型调用 |
| `agent.dataBindings` | 资料绑定，控制配置声明的任意资料目录及读写权限 |
| `agent.outputs` | 产物规则，声明允许创建的输出格式与路径 |
| `agent.memory` | 记忆开关：`{"use": false, "contribute": false}` |

**`bindings` 块**：

- `bindings.workspaceDir`：工作区根目录，相对 JSON 所在目录解析，默认 `../workspace`。仅默认工作区自动创建；外部工作区不存在时明确报错。
- `bindings.sources`：资料源映射；用 `readOnly: true` 声明只读，不依赖目录名字。
- `bindings.executions`：执行策略表（不是执行目录）。
- `bindings.skills`：Skill 路径映射。
- `agent.executionRef`：执行环境引用字段，指向 `bindings.executions` 中的策略条目。

> 修改此文件或角色 MD 后，服务检测到变更会拒绝后续请求，需重启。

**最小修改示例**（只需调整以下片段）：

```jsonc
// 启用 Skill（需先提供合规的 SKILL.md 文件）
"agent": {
  "skills": [{"id": "outline", "required": true}]
},
"bindings": {
  "skills": {
    "outline": {"path": ".agents/skills/outline/SKILL.md"}
  }
}
```

## 核心模块与数据目录

**启动流程**（[`server/main.mjs`](server/main.mjs)）：
核验 PostgreSQL / Redis、取得实例锁 → 读取 Agent 定义 → 准备路径 → 注册受限资源服务与工具 → 连接原生 Codex → 核验 Skill / 原生动态工具 / 记忆 → 描述符入库、恢复任务 → HTTP 就绪。

**关键目录**：

| 目录 | 说明 |
|---|---|
| `agents/` | Agent 配置 JSON 与角色 MD |
| `workspace/` | 默认工作区，含 inputs / research / drafts / outputs |
| `.data/` | 实例身份 `identity.json`、不可变正文 `files/`、Codex 原生存储 `codex/`、本机连接与兼容索引；旧 JSON 原件保留但不再作为正常服务权威 |
| `.runs/` | 运行目录，格式 `app-server-*`，保留最近 5 次和 7 天内记录 |
| `config/tools/` | 工具配置 JSON，与 `server/modules/tools` 工厂配合实现配置驱动 |

> PostgreSQL `tasks` 保存用户输入；旧 `.data/messages.json` 和 `.runs` 日志仍可能含私密内容，不要对外公开。数据库、正文、实例身份和原生历史都需备份，不属于缓存。

## 文件工具权限边界

- 默认只允许 `.md`、`.txt`，单文件上限 256 KiB，create-only，不跟随链接，拒绝目录遍历。
- 写作示例将 `inputs` 配置为只读；`research` / `drafts` 可读可创建；`outputs` 通过产物规则允许创建。客服等场景可配置完全不同的目录。
- `articles` 是指向 `outputs` 的来源 ID，不是目录。删除这一读取绑定后，仍能创建 `outputs` 产物，但不能读取它们。
- `read_file` 返回内容、来源 ID、内容 SHA256、定位路径和更新时间；`list_files` 同样过滤未授权来源。
- 文件成功落盘后，检查文件存在性与扩展名并归入 `turn.artifacts`；不证明语义正确或引用真实性，模型自述"已保存"不等于文件真正写入成功。

## Skill 使用说明

1. **发现**：通过 `skills/list` 发现可用 Skill；用 `skills/config/write` 收紧启用集合；每轮前复查。
2. **准备文件**：用户自行提供符合原生规范的 `SKILL.md`，路径相对工作区或为受信绝对路径，并须位于原生可发现位置；不会自动安装。
3. **修改配置**：在 `agent.skills` 添加条目，在 `bindings.skills` 声明路径，受控重启。
4. **显式调用**：显式 `$skill-name` 会将 `{type: skill, name, path}` 传入，由 Codex 注入正文，不自建解析器。
5. **权限声明**：`requires` 中声明 `shell / fileWrite / assets` 意味着本版不支持的依赖——必需项直接报错，可选项降级；额外工具依赖一律拒绝。
6. **首版限制**：仅验证原生文本指令型 Skill；带脚本/附件的完整 Skill 工作流不保证正常运行。

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

工作区设计基线见 [workspace-design.md](docs/workspace-design.md)；独立教学版本见 [Demo 3–5 演进总览](../project-evolution/README.md)，演进总览见 [project-evolution/README.md](../project-evolution/README.md)。
