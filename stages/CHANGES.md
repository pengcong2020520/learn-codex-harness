# 每个阶段改了什么

> 由 `node stages/build-changes.mjs` 根据相邻两个阶段的快照自动生成，请不要手改。只统计实现代码与配置；测试、文档、课程材料不算在内。

| 阶段 | 主题 | 新增文件 | 改动文件 | 删除文件 | 行数 |
|---|---|---|---|---|---|
| [s01](#s01) | 先打通一次问答 | 8 | 2 | 5 | +570 / −233 |
| [s02](#s02) | 让同一段对话继续下去 | 2 | 4 | 0 | +689 / −9 |
| [s03](#s03) | 用配置装配一个能做事的 Agent | 35 | 9 | 1 | +3128 / −199 |
| [s08](#s08) | 让任务与产物有据可查 | 9 | 11 | 0 | +1531 / −112 |
| [s09](#s09) | 知识层与门禁：依据什么，能碰什么 | 8 | 17 | 0 | +1061 / −111 |
| [s10](#s10) | Skill 教方法，Workflow 管边界和终点 | 19 | 31 | 1 | +1767 / −337 |
| [s11](#s11) | 模型网关：Codex 只连网关 | 15 | 24 | 0 | +1639 / −153 |

<a id="s01"></a>

## s01：先打通一次问答

相比 [s00-sdk-quickstart](s00-sdk-quickstart/)：自己写客户端，经 JSON-RPC 驱动 App Server；只有本轮成功结束，才算答完。

**新增模块**：单轮客户端（接入与会话，发请求、核对终态）

**新增环境变量**：`CODEX_MODEL_CATALOG_ENABLED`、`CODEX_MODEL_DISPLAY_NAME`、`CODEX_MODEL_DESCRIPTION`、`CODEX_MODEL_CONTEXT_WINDOW`、`CODEX_MODEL_MAX_CONTEXT_WINDOW`、`CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_PERCENT`、`CODEX_MODEL_INPUT_MODALITIES`、`CODEX_MODEL_SUPPORTS_IMAGE_DETAIL_ORIGINAL`、`CODEX_MODEL_REASONING_LEVELS`、`CODEX_MODEL_DEFAULT_REASONING_LEVEL`、`CODEX_MODEL_REASONING_SUMMARY`、`CODEX_MODEL_SHELL_TYPE`、`CODEX_MODEL_APPLY_PATCH_TOOL_TYPE`、`CODEX_MODEL_SUPPORT_VERBOSITY`、`CODEX_MODEL_DEFAULT_VERBOSITY`、`CODEX_MODEL_TOOL_OUTPUT_LIMIT`

| 状态 | 文件 | 所属模块 | 行数 |
|---|---|---|---|
| 新增 | [`shared/errors.mjs`](s01-single-turn/shared/errors.mjs) | 共享代码 | +21 / −0 |
| 新增 | [`shared/paths.mjs`](s01-single-turn/shared/paths.mjs) | 共享代码 | +2 / −0 |
| 新增 | [`server/modules/codex/runtime.mjs`](s01-single-turn/server/modules/codex/runtime.mjs) | 基础设施 | +28 / −0 |
| 新增 | [`server/modules/config/index.mjs`](s01-single-turn/server/modules/config/index.mjs) | 基础设施 | +173 / −0 |
| 新增 | [`server/modules/role/index.mjs`](s01-single-turn/server/modules/role/index.mjs) | 基础设施 | +2 / −0 |
| 新增 | [`server/modules/storage/index.mjs`](s01-single-turn/server/modules/storage/index.mjs) | 基础设施 | +56 / −0 |
| 删除 | [`scripts/doctor.mjs`](s00-sdk-quickstart/scripts/doctor.mjs) | 脚本 | +0 / −32 |
| 新增 | [`05-app-server.mjs`](s01-single-turn/05-app-server.mjs) | 客户端 | +244 / −0 |
| 新增 | [`main.mjs`](s01-single-turn/main.mjs) | 客户端 | +3 / −0 |
| 改动 | [`.env.example`](s01-single-turn/.env.example) | 项目文件 | +35 / −11 |
| 删除 | [`fixture/add.mjs`](s00-sdk-quickstart/fixture/add.mjs) | 项目文件 | +0 / −3 |
| 删除 | [`fixture/add.test.mjs`](s00-sdk-quickstart/fixture/add.test.mjs) | 项目文件 | +0 / −7 |
| 删除 | [`lib/app-server-config.mjs`](s00-sdk-quickstart/lib/app-server-config.mjs) | 项目文件 | +0 / −70 |
| 删除 | [`lib/common.mjs`](s00-sdk-quickstart/lib/common.mjs) | 项目文件 | +0 / −99 |
| 改动 | [`package.json`](s01-single-turn/package.json) | 项目文件 | +6 / −11 |

<a id="s02"></a>

## s02：让同一段对话继续下去

相比 [s01-single-turn](s01-single-turn/)：输入先排队再发送；每轮只发新输入，历史由 Codex 原生保存，退出后可以恢复。

**新增模块**：会话与排队（接入与会话，先进先出，复用 Thread）

| 状态 | 文件 | 所属模块 | 行数 |
|---|---|---|---|
| 新增 | [`server/modules/sessions/history.mjs`](s02-multi-turn/server/modules/sessions/history.mjs) | 会话与排队 | +141 / −0 |
| 改动 | [`05-app-server.mjs`](s02-multi-turn/05-app-server.mjs) | 客户端 | +106 / −5 |
| 新增 | [`05-app-server.test.mjs`](s02-multi-turn/05-app-server.test.mjs) | 客户端 | +438 / −0 |
| 改动 | [`main.mjs`](s02-multi-turn/main.mjs) | 客户端 | +1 / −1 |
| 改动 | [`.env.example`](s02-multi-turn/.env.example) | 项目文件 | +1 / −1 |
| 改动 | [`package.json`](s02-multi-turn/package.json) | 项目文件 | +2 / −2 |

<a id="s03"></a>

## s03：用配置装配一个能做事的 Agent

相比 [s02-multi-turn](s02-multi-turn/)：服务常驻，通过 HTTP / SSE 接入；一份 JSON 决定角色、Skills、可用工具和资料边界，记忆由服务端管控。

**新增模块**：HTTP / SSE 接口（接入与会话，终端与浏览器接入）；任务与消息（接入与会话，任务排队与调度）；事件推送（接入与会话，状态变化推给客户端）；Agent 定义（Agent 装配，JSON 校验 + 版本哈希）；角色与 Skills（Agent 装配，做什么、怎么做）；工具与资料边界（Agent 装配，白名单 + 参数校验）；MCP 工具入口（Agent 装配，Codex 回调本地工具）；生命周期与清理（运行支撑，启停、运行目录回收）；记忆（运行支撑，Codex 提炼，服务端管控）；任务记录（数据，任务状态与产物登记）

**新增工具**：`list_files`、`read_file`、`write_file`、`read_webpage`

**新增接口**：`GET /workbench`、`GET /workspace`、`GET /workspace/read`、`GET /resources/read`、`GET /preferences`、`POST /preferences`、`GET /memory`、`GET /memory/summary`、`POST /memory/contribution`、`GET /tools`、`GET /health`、`GET /sessions`、`POST /sessions`、`POST /sessions/resume`、`GET /state`、`POST /messages`、`POST /queue/continue`、`GET /events`

**新增环境变量**：`AGENT_PORT`、`AGENT_DEFINITION`、`AGENT_MEMORY_ENABLED`、`AGENT_MEMORY_USE`、`AGENT_MEMORY_GENERATE`、`AGENT_MEMORY_EXTRACT_MODEL`、`AGENT_MEMORY_CONSOLIDATION_MODEL`、`AGENT_MEMORY_MIN_IDLE_HOURS`

| 状态 | 文件 | 所属模块 | 行数 |
|---|---|---|---|
| 新增 | [`server/check.mjs`](s03-agent-core/server/check.mjs) | 服务入口 | +29 / −0 |
| 新增 | [`server/main.mjs`](s03-agent-core/server/main.mjs) | 服务入口 | +129 / −0 |
| 新增 | [`config/tools/files.json`](s03-agent-core/config/tools/files.json) | 工具与资料边界 | +75 / −0 |
| 新增 | [`config/tools/web.json`](s03-agent-core/config/tools/web.json) | 工具与资料边界 | +11 / −0 |
| 新增 | [`server/modules/data/files.mjs`](s03-agent-core/server/modules/data/files.mjs) | 工具与资料边界 | +251 / −0 |
| 新增 | [`server/modules/tools/files.mjs`](s03-agent-core/server/modules/tools/files.mjs) | 工具与资料边界 | +5 / −0 |
| 新增 | [`server/modules/tools/index.mjs`](s03-agent-core/server/modules/tools/index.mjs) | 工具与资料边界 | +143 / −0 |
| 新增 | [`server/modules/tools/loader.mjs`](s03-agent-core/server/modules/tools/loader.mjs) | 工具与资料边界 | +120 / −0 |
| 新增 | [`server/modules/tools/public-web.mjs`](s03-agent-core/server/modules/tools/public-web.mjs) | 工具与资料边界 | +99 / −0 |
| 新增 | [`server/modules/tools/web-cli.mjs`](s03-agent-core/server/modules/tools/web-cli.mjs) | 工具与资料边界 | +18 / −0 |
| 新增 | [`server/modules/tools/web-tools.mjs`](s03-agent-core/server/modules/tools/web-tools.mjs) | 工具与资料边界 | +37 / −0 |
| 新增 | [`server/modules/tools/web.mjs`](s03-agent-core/server/modules/tools/web.mjs) | 工具与资料边界 | +30 / −0 |
| 改动 | [`server/modules/sessions/history.mjs`](s03-agent-core/server/modules/sessions/history.mjs) | 会话与排队 | +13 / −6 |
| 新增 | [`server/modules/sessions/index.mjs`](s03-agent-core/server/modules/sessions/index.mjs) | 会话与排队 | +191 / −0 |
| 新增 | [`server/modules/codex/config.mjs`](s03-agent-core/server/modules/codex/config.mjs) | 基础设施 | +45 / −0 |
| 新增 | [`server/modules/codex/connection.mjs`](s03-agent-core/server/modules/codex/connection.mjs) | 基础设施 | +187 / −0 |
| 新增 | [`server/modules/codex/launch.mjs`](s03-agent-core/server/modules/codex/launch.mjs) | 基础设施 | +149 / −0 |
| 改动 | [`server/modules/codex/runtime.mjs`](s03-agent-core/server/modules/codex/runtime.mjs) | 基础设施 | +19 / −4 |
| 改动 | [`server/modules/config/index.mjs`](s03-agent-core/server/modules/config/index.mjs) | 基础设施 | +32 / −138 |
| 改动 | [`server/modules/storage/index.mjs`](s03-agent-core/server/modules/storage/index.mjs) | 基础设施 | +3 / −13 |
| 新增 | [`server/modules/memory/index.mjs`](s03-agent-core/server/modules/memory/index.mjs) | 记忆 | +84 / −0 |
| 新增 | [`server/modules/codex/skills.mjs`](s03-agent-core/server/modules/codex/skills.mjs) | 角色与 Skills | +35 / −0 |
| 改动 | [`server/modules/role/index.mjs`](s03-agent-core/server/modules/role/index.mjs) | 角色与 Skills | +11 / −2 |
| 新增 | [`scripts/smoke.mjs`](s03-agent-core/scripts/smoke.mjs) | 脚本 | +29 / −0 |
| 改动 | [`05-app-server.mjs`](s03-agent-core/05-app-server.mjs) | 客户端 | +16 / −23 |
| 改动 | [`05-app-server.test.mjs`](s03-agent-core/05-app-server.test.mjs) | 客户端 | +1 / −1 |
| 新增 | [`client/main.mjs`](s03-agent-core/client/main.mjs) | 客户端 | +18 / −0 |
| 新增 | [`client/modules/chat/index.mjs`](s03-agent-core/client/modules/chat/index.mjs) | 客户端 | +193 / −0 |
| 新增 | [`client/modules/connection/index.mjs`](s03-agent-core/client/modules/connection/index.mjs) | 客户端 | +77 / −0 |
| 新增 | [`client/modules/terminal/index.mjs`](s03-agent-core/client/modules/terminal/index.mjs) | 客户端 | +65 / −0 |
| 删除 | [`main.mjs`](s02-multi-turn/main.mjs) | 客户端 | +0 / −3 |
| 新增 | [`server/modules/data/index.mjs`](s03-agent-core/server/modules/data/index.mjs) | 任务记录 | +40 / −0 |
| 新增 | [`server/modules/data/jobs.mjs`](s03-agent-core/server/modules/data/jobs.mjs) | 任务记录 | +2 / −0 |
| 新增 | [`server/modules/messages/index.mjs`](s03-agent-core/server/modules/messages/index.mjs) | 任务与消息 | +332 / −0 |
| 新增 | [`server/modules/lifecycle/index.mjs`](s03-agent-core/server/modules/lifecycle/index.mjs) | 生命周期与清理 | +25 / −0 |
| 新增 | [`server/modules/maintenance/index.mjs`](s03-agent-core/server/modules/maintenance/index.mjs) | 生命周期与清理 | +131 / −0 |
| 新增 | [`server/modules/events/index.mjs`](s03-agent-core/server/modules/events/index.mjs) | 事件推送 | +11 / −0 |
| 改动 | [`.env.example`](s03-agent-core/.env.example) | 项目文件 | +23 / −4 |
| 改动 | [`package.json`](s03-agent-core/package.json) | 项目文件 | +17 / −5 |
| 新增 | [`agents/writing-agent.json`](s03-agent-core/agents/writing-agent.json) | Agent 定义 | +30 / −0 |
| 新增 | [`server/modules/agents/boundary.mjs`](s03-agent-core/server/modules/agents/boundary.mjs) | Agent 定义 | +25 / −0 |
| 新增 | [`server/modules/agents/index.mjs`](s03-agent-core/server/modules/agents/index.mjs) | Agent 定义 | +150 / −0 |
| 新增 | [`server/modules/agents/schema.mjs`](s03-agent-core/server/modules/agents/schema.mjs) | Agent 定义 | +30 / −0 |
| 新增 | [`server/modules/http/index.mjs`](s03-agent-core/server/modules/http/index.mjs) | HTTP / SSE 接口 | +141 / −0 |
| 新增 | [`server/modules/tools/mcp-server.mjs`](s03-agent-core/server/modules/tools/mcp-server.mjs) | MCP 工具入口 | +56 / −0 |

<a id="s08"></a>

## s08：让任务与产物有据可查

相比 [s03-agent-core](s03-agent-core/)：业务记录迁入 PostgreSQL，提交后经 Redis 唤醒执行；每个产物登记版本与来源。

**新增模块**：PostgreSQL（数据，业务状态的依据）；Outbox + Redis（数据，提交后再唤醒）；资源版本（数据，产物可追溯来源）

**新增环境变量**：`DATABASE_URL`、`REDIS_URL`

| 状态 | 文件 | 所属模块 | 行数 |
|---|---|---|---|
| 改动 | [`server/main.mjs`](s08-data-layer/server/main.mjs) | 服务入口 | +1 / −1 |
| 改动 | [`config/tools/files.json`](s08-data-layer/config/tools/files.json) | 工具与资料边界 | +8 / −62 |
| 改动 | [`server/modules/tools/loader.mjs`](s08-data-layer/server/modules/tools/loader.mjs) | 工具与资料边界 | +6 / −1 |
| 改动 | [`server/modules/config/index.mjs`](s08-data-layer/server/modules/config/index.mjs) | 基础设施 | +1 / −1 |
| 新增 | [`scripts/data.mjs`](s08-data-layer/scripts/data.mjs) | 脚本 | +103 / −0 |
| 新增 | [`scripts/test-data.mjs`](s08-data-layer/scripts/test-data.mjs) | 脚本 | +113 / −0 |
| 改动 | [`server/modules/data/index.mjs`](s08-data-layer/server/modules/data/index.mjs) | 任务记录 | +61 / −38 |
| 改动 | [`server/modules/data/jobs.mjs`](s08-data-layer/server/modules/data/jobs.mjs) | 任务记录 | +161 / −0 |
| 改动 | [`server/modules/messages/index.mjs`](s08-data-layer/server/modules/messages/index.mjs) | 任务与消息 | +2 / −3 |
| 改动 | [`.env.example`](s08-data-layer/.env.example) | 项目文件 | +5 / −2 |
| 新增 | [`compose.yaml`](s08-data-layer/compose.yaml) | 项目文件 | +22 / −0 |
| 改动 | [`package.json`](s08-data-layer/package.json) | 项目文件 | +8 / −2 |
| 新增 | [`server/modules/data/resources.mjs`](s08-data-layer/server/modules/data/resources.mjs) | 资源版本 | +475 / −0 |
| 改动 | [`server/modules/agents/index.mjs`](s08-data-layer/server/modules/agents/index.mjs) | Agent 定义 | +1 / −1 |
| 改动 | [`server/modules/http/index.mjs`](s08-data-layer/server/modules/http/index.mjs) | HTTP / SSE 接口 | +1 / −1 |
| 新增 | [`server/modules/data/queue.mjs`](s08-data-layer/server/modules/data/queue.mjs) | Outbox + Redis | +86 / −0 |
| 新增 | [`server/modules/data/database.mjs`](s08-data-layer/server/modules/data/database.mjs) | PostgreSQL | +153 / −0 |
| 新增 | [`server/modules/data/legacy.mjs`](s08-data-layer/server/modules/data/legacy.mjs) | PostgreSQL | +142 / −0 |
| 新增 | [`server/modules/data/repository.mjs`](s08-data-layer/server/modules/data/repository.mjs) | PostgreSQL | +98 / −0 |
| 新增 | [`server/modules/data/schema.sql`](s08-data-layer/server/modules/data/schema.sql) | PostgreSQL | +84 / −0 |

<a id="s09"></a>

## s09：知识层与门禁：依据什么，能碰什么

相比 [s08-data-layer](s08-data-layer/)：身份由服务端签发；文件、知识、索引共用一道门禁，Wiki / RAG 保留原文依据。

**新增模块**：可信门禁（知识与工作流，服务端签发身份）；Wiki / RAG（知识与工作流，带原文依据的知识）

**新增工具**：`kb_list`、`kb_read`、`kb_search`、`kb_submit_revision`

**新增接口**：`GET /knowledge/pages`、`POST /knowledge/source`、`GET /knowledge`、`GET /knowledge/read`、`POST /knowledge/search`、`POST /knowledge/index`、`GET /knowledge/job`

**新增环境变量**：`CHROMA_URL`、`EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`

**新增数据迁移**：`002-knowledge.sql`

| 状态 | 文件 | 所属模块 | 行数 |
|---|---|---|---|
| 改动 | [`server/main.mjs`](s09-knowledge-layer/server/main.mjs) | 服务入口 | +38 / −10 |
| 新增 | [`config/tools/knowledge.json`](s09-knowledge-layer/config/tools/knowledge.json) | 工具与资料边界 | +134 / −0 |
| 改动 | [`server/modules/tools/index.mjs`](s09-knowledge-layer/server/modules/tools/index.mjs) | 工具与资料边界 | +19 / −11 |
| 改动 | [`server/modules/tools/loader.mjs`](s09-knowledge-layer/server/modules/tools/loader.mjs) | 工具与资料边界 | +10 / −5 |
| 改动 | [`server/modules/sessions/index.mjs`](s09-knowledge-layer/server/modules/sessions/index.mjs) | 会话与排队 | +1 / −1 |
| 改动 | [`server/modules/config/index.mjs`](s09-knowledge-layer/server/modules/config/index.mjs) | 基础设施 | +6 / −3 |
| 新增 | [`scripts/knowledge.mjs`](s09-knowledge-layer/scripts/knowledge.mjs) | 脚本 | +47 / −0 |
| 改动 | [`scripts/test-data.mjs`](s09-knowledge-layer/scripts/test-data.mjs) | 脚本 | +27 / −2 |
| 新增 | [`server/modules/permissions/index.mjs`](s09-knowledge-layer/server/modules/permissions/index.mjs) | 可信门禁 | +86 / −0 |
| 改动 | [`server/modules/data/jobs.mjs`](s09-knowledge-layer/server/modules/data/jobs.mjs) | 任务记录 | +4 / −3 |
| 改动 | [`server/modules/messages/index.mjs`](s09-knowledge-layer/server/modules/messages/index.mjs) | 任务与消息 | +13 / −4 |
| 改动 | [`.env.example`](s09-knowledge-layer/.env.example) | 项目文件 | +10 / −3 |
| 改动 | [`compose.yaml`](s09-knowledge-layer/compose.yaml) | 项目文件 | +8 / −2 |
| 改动 | [`package.json`](s09-knowledge-layer/package.json) | 项目文件 | +7 / −1 |
| 改动 | [`server/modules/data/resources.mjs`](s09-knowledge-layer/server/modules/data/resources.mjs) | 资源版本 | +8 / −3 |
| 改动 | [`agents/writing-agent.json`](s09-knowledge-layer/agents/writing-agent.json) | Agent 定义 | +124 / −16 |
| 改动 | [`server/modules/agents/index.mjs`](s09-knowledge-layer/server/modules/agents/index.mjs) | Agent 定义 | +3 / −1 |
| 改动 | [`server/modules/agents/schema.mjs`](s09-knowledge-layer/server/modules/agents/schema.mjs) | Agent 定义 | +4 / −2 |
| 改动 | [`server/modules/http/index.mjs`](s09-knowledge-layer/server/modules/http/index.mjs) | HTTP / SSE 接口 | +19 / −4 |
| 改动 | [`server/modules/data/database.mjs`](s09-knowledge-layer/server/modules/data/database.mjs) | PostgreSQL | +18 / −40 |
| 新增 | [`server/modules/data/migrations/002-knowledge.sql`](s09-knowledge-layer/server/modules/data/migrations/002-knowledge.sql) | PostgreSQL | +42 / −0 |
| 新增 | [`server/modules/knowledge/index.mjs`](s09-knowledge-layer/server/modules/knowledge/index.mjs) | Wiki / RAG | +215 / −0 |
| 新增 | [`server/modules/knowledge/rag.mjs`](s09-knowledge-layer/server/modules/knowledge/rag.mjs) | Wiki / RAG | +174 / −0 |
| 新增 | [`server/modules/knowledge/worker.mjs`](s09-knowledge-layer/server/modules/knowledge/worker.mjs) | Wiki / RAG | +36 / −0 |
| 新增 | [`server/modules/tools/knowledge.mjs`](s09-knowledge-layer/server/modules/tools/knowledge.mjs) | Wiki / RAG | +8 / −0 |

<a id="s10"></a>

## s10：Skill 教方法，Workflow 管边界和终点

相比 [s09-knowledge-layer](s09-knowledge-layer/)：一类任务一份配置；多步任务在关键处停下等人确认，模型可以提议提权，不能自己批准。

**新增模块**：Workflow（知识与工作流，步骤、确认与验收）；审批与提权（知识与工作流，可以提议，不能自批）

**新增工具**：`skill_read`、`propose_task`

**新增接口**：`POST /tasks/confirm`、`POST /tasks/cancel`

**新增数据迁移**：`003-workflows.sql`、`004-workflow-steps.sql`、`005-task-proposals.sql`

| 状态 | 文件 | 所属模块 | 行数 |
|---|---|---|---|
| 改动 | [`server/check.mjs`](s10-skill-workflow/server/check.mjs) | 服务入口 | +4 / −4 |
| 改动 | [`server/main.mjs`](s10-skill-workflow/server/main.mjs) | 服务入口 | +13 / −7 |
| 改动 | [`config/tools/files.json`](s10-skill-workflow/config/tools/files.json) | 工具与资料边界 | +2 / −2 |
| 新增 | [`config/tools/skills.json`](s10-skill-workflow/config/tools/skills.json) | 工具与资料边界 | +21 / −0 |
| 新增 | [`config/tools/tasks.json`](s10-skill-workflow/config/tools/tasks.json) | 工具与资料边界 | +23 / −0 |
| 改动 | [`server/modules/data/files.mjs`](s10-skill-workflow/server/modules/data/files.mjs) | 工具与资料边界 | +6 / −12 |
| 改动 | [`server/modules/tools/index.mjs`](s10-skill-workflow/server/modules/tools/index.mjs) | 工具与资料边界 | +4 / −4 |
| 改动 | [`server/modules/tools/loader.mjs`](s10-skill-workflow/server/modules/tools/loader.mjs) | 工具与资料边界 | +15 / −5 |
| 新增 | [`server/modules/tools/skills.mjs`](s10-skill-workflow/server/modules/tools/skills.mjs) | 工具与资料边界 | +9 / −0 |
| 新增 | [`shared/session-events.mjs`](s10-skill-workflow/shared/session-events.mjs) | 共享代码 | +32 / −0 |
| 改动 | [`server/modules/sessions/index.mjs`](s10-skill-workflow/server/modules/sessions/index.mjs) | 会话与排队 | +99 / −18 |
| 新增 | [`server/modules/codex/compatibility.mjs`](s10-skill-workflow/server/modules/codex/compatibility.mjs) | 基础设施 | +75 / −0 |
| 改动 | [`server/modules/codex/connection.mjs`](s10-skill-workflow/server/modules/codex/connection.mjs) | 基础设施 | +28 / −9 |
| 改动 | [`server/modules/codex/launch.mjs`](s10-skill-workflow/server/modules/codex/launch.mjs) | 基础设施 | +5 / −2 |
| 改动 | [`server/modules/codex/runtime.mjs`](s10-skill-workflow/server/modules/codex/runtime.mjs) | 基础设施 | +6 / −1 |
| 改动 | [`server/modules/config/index.mjs`](s10-skill-workflow/server/modules/config/index.mjs) | 基础设施 | +35 / −3 |
| 新增 | [`server/modules/data/paths.mjs`](s10-skill-workflow/server/modules/data/paths.mjs) | 基础设施 | +31 / −0 |
| 改动 | [`server/modules/codex/skills.mjs`](s10-skill-workflow/server/modules/codex/skills.mjs) | 角色与 Skills | +39 / −3 |
| 改动 | [`server/modules/role/index.mjs`](s10-skill-workflow/server/modules/role/index.mjs) | 角色与 Skills | +7 / −2 |
| 改动 | [`scripts/data.mjs`](s10-skill-workflow/scripts/data.mjs) | 脚本 | +2 / −4 |
| 新增 | [`scripts/init-agent.mjs`](s10-skill-workflow/scripts/init-agent.mjs) | 脚本 | +63 / −0 |
| 改动 | [`scripts/knowledge.mjs`](s10-skill-workflow/scripts/knowledge.mjs) | 脚本 | +7 / −11 |
| 新增 | [`scripts/real-smoke.mjs`](s10-skill-workflow/scripts/real-smoke.mjs) | 脚本 | +200 / −0 |
| 改动 | [`scripts/test-data.mjs`](s10-skill-workflow/scripts/test-data.mjs) | 脚本 | +2 / −2 |
| 新增 | [`scripts/upgrade-sessions.mjs`](s10-skill-workflow/scripts/upgrade-sessions.mjs) | 脚本 | +99 / −0 |
| 改动 | [`server/modules/permissions/index.mjs`](s10-skill-workflow/server/modules/permissions/index.mjs) | 可信门禁 | +23 / −13 |
| 改动 | [`client/modules/chat/index.mjs`](s10-skill-workflow/client/modules/chat/index.mjs) | 客户端 | +54 / −8 |
| 改动 | [`client/modules/connection/index.mjs`](s10-skill-workflow/client/modules/connection/index.mjs) | 客户端 | +14 / −5 |
| 新增 | [`config/runtime/project.json`](s10-skill-workflow/config/runtime/project.json) | 配置 | +3 / −0 |
| 改动 | [`server/modules/data/jobs.mjs`](s10-skill-workflow/server/modules/data/jobs.mjs) | 任务记录 | +16 / −8 |
| 改动 | [`server/modules/messages/index.mjs`](s10-skill-workflow/server/modules/messages/index.mjs) | 任务与消息 | +121 / −17 |
| 新增 | [`server/modules/tools/tasks.mjs`](s10-skill-workflow/server/modules/tools/tasks.mjs) | 审批与提权 | +9 / −0 |
| 改动 | [`server/modules/events/index.mjs`](s10-skill-workflow/server/modules/events/index.mjs) | 事件推送 | +18 / −1 |
| 改动 | [`.env.example`](s10-skill-workflow/.env.example) | 项目文件 | +4 / −4 |
| 改动 | [`compose.yaml`](s10-skill-workflow/compose.yaml) | 项目文件 | +2 / −2 |
| 改动 | [`package.json`](s10-skill-workflow/package.json) | 项目文件 | +5 / −1 |
| 改动 | [`server/modules/data/resources.mjs`](s10-skill-workflow/server/modules/data/resources.mjs) | 资源版本 | +1 / −1 |
| 删除 | [`agents/writing-agent.json`](s09-knowledge-layer/agents/writing-agent.json) | Agent 定义 | +0 / −138 |
| 新增 | [`agents/writing/agent.json`](s10-skill-workflow/agents/writing/agent.json) | Agent 定义 | +181 / −0 |
| 新增 | [`server/modules/agents/contracts.mjs`](s10-skill-workflow/server/modules/agents/contracts.mjs) | Agent 定义 | +81 / −0 |
| 改动 | [`server/modules/agents/index.mjs`](s10-skill-workflow/server/modules/agents/index.mjs) | Agent 定义 | +98 / −29 |
| 改动 | [`server/modules/agents/schema.mjs`](s10-skill-workflow/server/modules/agents/schema.mjs) | Agent 定义 | +19 / −3 |
| 新增 | [`server/modules/agents/selection.mjs`](s10-skill-workflow/server/modules/agents/selection.mjs) | Agent 定义 | +16 / −0 |
| 新增 | [`server/modules/agents/upgrade.mjs`](s10-skill-workflow/server/modules/agents/upgrade.mjs) | Agent 定义 | +95 / −0 |
| 改动 | [`server/modules/http/index.mjs`](s10-skill-workflow/server/modules/http/index.mjs) | HTTP / SSE 接口 | +30 / −10 |
| 改动 | [`server/modules/data/database.mjs`](s10-skill-workflow/server/modules/data/database.mjs) | PostgreSQL | +1 / −1 |
| 新增 | [`server/modules/data/migrations/003-workflows.sql`](s10-skill-workflow/server/modules/data/migrations/003-workflows.sql) | PostgreSQL | +9 / −0 |
| 新增 | [`server/modules/data/migrations/004-workflow-steps.sql`](s10-skill-workflow/server/modules/data/migrations/004-workflow-steps.sql) | PostgreSQL | +6 / −0 |
| 新增 | [`server/modules/data/migrations/005-task-proposals.sql`](s10-skill-workflow/server/modules/data/migrations/005-task-proposals.sql) | PostgreSQL | +5 / −0 |
| 改动 | [`server/modules/knowledge/index.mjs`](s10-skill-workflow/server/modules/knowledge/index.mjs) | Wiki / RAG | +9 / −7 |
| 新增 | [`server/modules/workflows/index.mjs`](s10-skill-workflow/server/modules/workflows/index.mjs) | Workflow | +120 / −0 |

<a id="s11"></a>

## s11：模型网关：Codex 只连网关

相比 [s10-skill-workflow](s10-skill-workflow/)：网关统一协议、按任务把请求路由到各家模型；每轮记录 token 用量，超出预算就停止派发。

**新增模块**：生图与生视频（模型网关，异步任务，结果存为产物）；用量与预算（模型网关，超额停止派发）；模型路由（模型网关，统一协议，转给上游）

**新增工具**：`generate_image`、`generate_video`、`media_status`

**新增接口**：`GET /models`、`GET /usage`

**新增环境变量**：`AGENT_DB_PASSWORD`、`AGENT_PG_PORT`、`AGENT_REDIS_PORT`、`AGENT_GATEWAY_KEY`、`AGENT_GATEWAY_PORT`、`AGENT_BUDGET_DAILY_TOKENS`、`AGENT_BUDGET_MONTHLY_TOKENS`、`AGENT_BUDGET_DAILY_COST`、`AGENT_BUDGET_MONTHLY_COST`、`AGENT_BUDGET_TIMEZONE`、`AGENT_BUDGET_DOWNGRADE_AT`、`AGENT_BUDGET_DOWNGRADE_SCENE`、`AGENT_GATEWAY_DAILY_TOKENS`、`ARK_API_KEY`、`KIMI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`XAI_API_KEY`、`ZHIPU_API_KEY`、`HUGGINGFACE_API_KEY`、`OLLAMA_BASE_URL`、`AGENT_WEB_SEARCH`

**新增数据迁移**：`006-usage.sql`、`007-media.sql`、`008-task-model-routing.sql`

| 状态 | 文件 | 所属模块 | 行数 |
|---|---|---|---|
| 改动 | [`server/main.mjs`](s11-model-gateway/server/main.mjs) | 服务入口 | +23 / −9 |
| 新增 | [`config/tools/media.json`](s11-model-gateway/config/tools/media.json) | 工具与资料边界 | +115 / −0 |
| 改动 | [`server/modules/data/files.mjs`](s11-model-gateway/server/modules/data/files.mjs) | 工具与资料边界 | +42 / −8 |
| 改动 | [`server/modules/tools/index.mjs`](s11-model-gateway/server/modules/tools/index.mjs) | 工具与资料边界 | +3 / −3 |
| 改动 | [`server/modules/tools/loader.mjs`](s11-model-gateway/server/modules/tools/loader.mjs) | 工具与资料边界 | +8 / −4 |
| 改动 | [`server/modules/sessions/index.mjs`](s11-model-gateway/server/modules/sessions/index.mjs) | 会话与排队 | +32 / −12 |
| 改动 | [`server/modules/codex/launch.mjs`](s11-model-gateway/server/modules/codex/launch.mjs) | 基础设施 | +96 / −53 |
| 改动 | [`server/modules/config/index.mjs`](s11-model-gateway/server/modules/config/index.mjs) | 基础设施 | +23 / −2 |
| 改动 | [`scripts/data.mjs`](s11-model-gateway/scripts/data.mjs) | 脚本 | +1 / −0 |
| 新增 | [`scripts/gateway-check.mjs`](s11-model-gateway/scripts/gateway-check.mjs) | 脚本 | +85 / −0 |
| 新增 | [`scripts/gateway-config.mjs`](s11-model-gateway/scripts/gateway-config.mjs) | 脚本 | +66 / −0 |
| 新增 | [`scripts/ollama-pull.mjs`](s11-model-gateway/scripts/ollama-pull.mjs) | 脚本 | +19 / −0 |
| 改动 | [`scripts/real-smoke.mjs`](s11-model-gateway/scripts/real-smoke.mjs) | 脚本 | +1 / −1 |
| 改动 | [`server/modules/permissions/index.mjs`](s11-model-gateway/server/modules/permissions/index.mjs) | 可信门禁 | +6 / −0 |
| 改动 | [`client/modules/chat/index.mjs`](s11-model-gateway/client/modules/chat/index.mjs) | 客户端 | +64 / −4 |
| 新增 | [`server/modules/gateway/index.mjs`](s11-model-gateway/server/modules/gateway/index.mjs) | 模型路由 | +233 / −0 |
| 新增 | [`server/modules/gateway/router.mjs`](s11-model-gateway/server/modules/gateway/router.mjs) | 模型路由 | +81 / −0 |
| 新增 | [`config/models.json`](s11-model-gateway/config/models.json) | 配置 | +46 / −0 |
| 改动 | [`server/modules/data/jobs.mjs`](s11-model-gateway/server/modules/data/jobs.mjs) | 任务记录 | +5 / −4 |
| 改动 | [`server/modules/messages/index.mjs`](s11-model-gateway/server/modules/messages/index.mjs) | 任务与消息 | +59 / −4 |
| 新增 | [`server/modules/media/index.mjs`](s11-model-gateway/server/modules/media/index.mjs) | 生图与生视频 | +169 / −0 |
| 新增 | [`server/modules/media/store.mjs`](s11-model-gateway/server/modules/media/store.mjs) | 生图与生视频 | +16 / −0 |
| 新增 | [`server/modules/tools/media.mjs`](s11-model-gateway/server/modules/tools/media.mjs) | 生图与生视频 | +8 / −0 |
| 改动 | [`.env.example`](s11-model-gateway/.env.example) | 项目文件 | +58 / −8 |
| 改动 | [`compose.yaml`](s11-model-gateway/compose.yaml) | 项目文件 | +54 / −6 |
| 改动 | [`package.json`](s11-model-gateway/package.json) | 项目文件 | +12 / −1 |
| 新增 | [`server/modules/usage/config.mjs`](s11-model-gateway/server/modules/usage/config.mjs) | 用量与预算 | +35 / −0 |
| 新增 | [`server/modules/usage/index.mjs`](s11-model-gateway/server/modules/usage/index.mjs) | 用量与预算 | +135 / −0 |
| 改动 | [`server/modules/data/resources.mjs`](s11-model-gateway/server/modules/data/resources.mjs) | 资源版本 | +56 / −13 |
| 改动 | [`agents/writing/agent.json`](s11-model-gateway/agents/writing/agent.json) | Agent 定义 | +13 / −4 |
| 改动 | [`server/modules/agents/index.mjs`](s11-model-gateway/server/modules/agents/index.mjs) | Agent 定义 | +17 / −0 |
| 改动 | [`server/modules/agents/schema.mjs`](s11-model-gateway/server/modules/agents/schema.mjs) | Agent 定义 | +5 / −2 |
| 改动 | [`server/modules/http/index.mjs`](s11-model-gateway/server/modules/http/index.mjs) | HTTP / SSE 接口 | +8 / −3 |
| 改动 | [`server/modules/data/database.mjs`](s11-model-gateway/server/modules/data/database.mjs) | PostgreSQL | +1 / −1 |
| 新增 | [`server/modules/data/migrations/006-usage.sql`](s11-model-gateway/server/modules/data/migrations/006-usage.sql) | PostgreSQL | +13 / −0 |
| 新增 | [`server/modules/data/migrations/007-media.sql`](s11-model-gateway/server/modules/data/migrations/007-media.sql) | PostgreSQL | +12 / −0 |
| 新增 | [`server/modules/data/migrations/008-task-model-routing.sql`](s11-model-gateway/server/modules/data/migrations/008-task-model-routing.sql) | PostgreSQL | +4 / −0 |
| 改动 | [`server/modules/knowledge/rag.mjs`](s11-model-gateway/server/modules/knowledge/rag.mjs) | Wiki / RAG | +13 / −9 |
| 改动 | [`server/modules/workflows/index.mjs`](s11-model-gateway/server/modules/workflows/index.mjs) | Workflow | +2 / −2 |
