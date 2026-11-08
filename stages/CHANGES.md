# 每个阶段多了什么

> 由 `node stages/build-changes.mjs` 根据各阶段快照自动生成，请不要手改。每个阶段的机制演示见课程的「阶段演示」页。

<a id="s00"></a>

## s00：先体验：把一件事交给 Codex

用官方 SDK 发起一轮任务；读文件、跑命令、改代码这个循环由 Codex 来转。

**新增模块**：SDK 脚本（接入与会话，官方 SDK 发起一轮）

<a id="s01"></a>

## s01：先打通一次问答

相比 [s00-sdk-quickstart](s00-sdk-quickstart/)：自己写客户端，经 JSON-RPC 驱动 App Server；只有本轮成功结束，才算答完。

**新增模块**：单轮客户端（接入与会话，发请求、核对终态）

**新增环境变量**：`CODEX_MODEL_CATALOG_ENABLED`、`CODEX_MODEL_DISPLAY_NAME`、`CODEX_MODEL_DESCRIPTION`、`CODEX_MODEL_CONTEXT_WINDOW`、`CODEX_MODEL_MAX_CONTEXT_WINDOW`、`CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_PERCENT`、`CODEX_MODEL_INPUT_MODALITIES`、`CODEX_MODEL_SUPPORTS_IMAGE_DETAIL_ORIGINAL`、`CODEX_MODEL_REASONING_LEVELS`、`CODEX_MODEL_DEFAULT_REASONING_LEVEL`、`CODEX_MODEL_REASONING_SUMMARY`、`CODEX_MODEL_SHELL_TYPE`、`CODEX_MODEL_APPLY_PATCH_TOOL_TYPE`、`CODEX_MODEL_SUPPORT_VERBOSITY`、`CODEX_MODEL_DEFAULT_VERBOSITY`、`CODEX_MODEL_TOOL_OUTPUT_LIMIT`

<a id="s02"></a>

## s02：让同一段对话继续下去

相比 [s01-single-turn](s01-single-turn/)：输入先排队再发送；每轮只发新输入，历史由 Codex 原生保存，退出后可以恢复。

**新增模块**：会话（接入与会话，复用 Thread，整理快照）

<a id="s03"></a>

## s03：变成常驻服务：客户端走了，服务还在

相比 [s02-multi-turn](s02-multi-turn/)：服务端常驻运行、持有 Codex；终端客户端经 HTTP 提交和查看，关掉客户端不影响正在执行的一轮。

**新增模块**：HTTP 接口（接入与会话，常驻服务的入口）；生命周期与清理（运行支撑，启停、运行目录回收）

**新增接口**：`GET /health`、`GET /sessions`、`POST /sessions`、`POST /sessions/resume`、`GET /state`、`POST /turns`

**新增环境变量**：`AGENT_PORT`

<a id="s04"></a>

## s04：排队搬进服务端，状态推给客户端

相比 [s03-service](s03-service/)：输入先写进任务记录，按会话先进先出逐条发给 Codex；状态变化经 SSE 推给客户端，断线重连先补快照。

**新增模块**：任务与消息（接入与会话，任务排队与调度）；事件推送（接入与会话，状态变化推给客户端）；任务记录（数据，任务状态，重启后可核对）

**新增接口**：`POST /messages`、`POST /queue/continue`、`GET /events`

**新增环境变量**：`AGENT_TURN_TIMEOUT_MS`

<a id="s05"></a>

## s05：一份 JSON 装配 Agent：角色与 Skills

相比 [s04-events-messages](s04-events-messages/)：Agent 定义决定角色、Skill、执行策略和工作区；启动时校验，内容一变旧版本就作废，会话与排队消息都要核对版本。

**新增模块**：Agent 定义（Agent 装配，JSON 校验 + 版本哈希）；角色与 Skills（Agent 装配，做什么、怎么做）

**新增环境变量**：`AGENT_DEFINITION`

<a id="s06"></a>

## s06：工具：读得到资料、存得下文章

相比 [s05-agent-assembly](s05-agent-assembly/)：工具来自配置，经 MCP 交给 Codex 调用；每次调用先核对白名单和参数，资料目录按用途授权，新建文件不覆盖。

**新增模块**：工具与资料边界（Agent 装配，白名单 + 参数校验）；MCP 工具入口（Agent 装配，Codex 回调本地工具）

**新增工具**：`list_files`、`read_file`、`write_file`、`read_webpage`

**新增接口**：`GET /tools`、`GET /workspace`、`GET /workspace/read`

**新增环境变量**：`NODE_ENV`

<a id="s07"></a>

## s07：记忆：Codex 提炼，服务端管控

相比 [s06-tools](s06-tools/)：原生记忆默认关闭；总开关、读取和每个会话是否参与提炼由服务端决定，客户端只能查看、不能传路径。

**新增模块**：记忆（运行支撑，Codex 提炼，服务端管控）

**新增接口**：`GET /memory`、`GET /memory/summary`、`POST /memory/contribution`

**新增环境变量**：`AGENT_MEMORY_ENABLED`、`AGENT_MEMORY_USE`、`AGENT_MEMORY_GENERATE`、`AGENT_MEMORY_EXTRACT_MODEL`、`AGENT_MEMORY_CONSOLIDATION_MODEL`、`AGENT_MEMORY_MIN_IDLE_HOURS`

<a id="s08"></a>

## s08：让任务与产物有据可查

相比 [s07-memory](s07-memory/)：业务记录迁入 PostgreSQL，提交后经 Redis 唤醒执行；每个产物登记版本与来源。

**新增模块**：PostgreSQL（数据，业务状态的依据）；Outbox + Redis（数据，提交后再唤醒）；资源版本（数据，产物可追溯来源）

**新增接口**：`GET /workbench`、`GET /resources/read`、`GET /preferences`、`POST /preferences`

**新增环境变量**：`DATABASE_URL`、`REDIS_URL`

<a id="s09"></a>

## s09：知识层与门禁：依据什么，能碰什么

相比 [s08-data-layer](s08-data-layer/)：身份由服务端签发；文件、知识、索引共用一道门禁，Wiki / RAG 保留原文依据。

**新增模块**：可信门禁（知识与工作流，服务端签发身份）；Wiki / RAG（知识与工作流，带原文依据的知识）

**新增工具**：`kb_list`、`kb_read`、`kb_search`、`kb_submit_revision`

**新增接口**：`GET /knowledge/pages`、`POST /knowledge/source`、`GET /knowledge`、`GET /knowledge/read`、`POST /knowledge/search`、`POST /knowledge/index`、`GET /knowledge/job`

**新增环境变量**：`CHROMA_URL`、`EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`

**新增数据迁移**：`002-knowledge.sql`、`003-knowledge-visibility.sql`

<a id="s10"></a>

## s10：Skill 教方法，Workflow 管边界和终点

相比 [s09-knowledge-layer](s09-knowledge-layer/)：一类任务一份配置；多步任务在关键处停下等人确认，模型可以提议提权，不能自己批准。

**新增模块**：Workflow（知识与工作流，步骤、确认与验收）；审批与提权（知识与工作流，可以提议，不能自批）

**新增工具**：`skill_read`、`propose_task`

**新增接口**：`POST /tasks/confirm`、`POST /tasks/cancel`

**新增数据迁移**：`003-workflows.sql`、`004-workflow-steps.sql`、`005-task-proposals.sql`、`006-knowledge-visibility.sql`

<a id="s11"></a>

## s11：模型网关：Codex 只连网关

相比 [s10-skill-workflow](s10-skill-workflow/)：网关统一协议、按任务把请求路由到各家模型；每轮记录 token 用量，超出预算就停止派发。

**新增模块**：生图与生视频（模型网关，异步任务，结果存为产物）；用量与预算（模型网关，超额停止派发）；模型路由（模型网关，统一协议，转给上游）

**新增工具**：`generate_image`、`generate_video`、`media_status`

**新增接口**：`GET /models`、`GET /usage`

**新增环境变量**：`AGENT_DB_PASSWORD`、`AGENT_PG_PORT`、`AGENT_REDIS_PORT`、`AGENT_GATEWAY_KEY`、`AGENT_GATEWAY_PORT`、`AGENT_BUDGET_DAILY_TOKENS`、`AGENT_BUDGET_MONTHLY_TOKENS`、`AGENT_BUDGET_DAILY_COST`、`AGENT_BUDGET_MONTHLY_COST`、`AGENT_BUDGET_TIMEZONE`、`AGENT_BUDGET_DOWNGRADE_AT`、`AGENT_BUDGET_DOWNGRADE_SCENE`、`AGENT_GATEWAY_DAILY_TOKENS`、`ARK_API_KEY`、`KIMI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`XAI_API_KEY`、`ZHIPU_API_KEY`、`HUGGINGFACE_API_KEY`、`OLLAMA_BASE_URL`、`AGENT_WEB_SEARCH`

**新增数据迁移**：`006-usage.sql`、`007-media.sql`、`008-task-model-routing.sql`、`009-knowledge-visibility.sql`

<a id="s12"></a>

## s12：部署：健康、就绪与恢复

相比 [s11-model-gateway](s11-model-gateway/)：独立 Compose 交付；就绪探测、容量限制与备份保护持久状态。

**新增模块**：就绪与容量（部署，健康探测、限流与关闭）

**新增接口**：`GET /ready`

**新增环境变量**：`CONTAINER_APP_DIR`、`AGENT_MAX_CONCURRENT_TURNS`、`AGENT_MAX_QUEUED`、`AGENT_RATE_LIMIT_PER_MINUTE`、`AGENT_MAX_SSE`、`POSTGRES_MEMORY_LIMIT`、`REDIS_MEMORY_LIMIT`、`GATEWAY_MEMORY_LIMIT`、`AGENT_MEMORY_LIMIT`、`NPM_REGISTRY`、`APT_MIRROR`

<a id="s13"></a>

## s13：账号与认证：请求有身份，资源有归属

相比 [s12-deploy](s12-deploy/)：登录签发不透明令牌；每次请求查库，数据、任务与事件按 owner 过滤。

**新增模块**：账号与认证（账号，登录、令牌与 owner 归属）

**新增接口**：`GET /auth/me`、`POST /auth/logout`、`POST /auth/login`

**新增数据迁移**：`010-accounts.sql`

<a id="s14"></a>

## s14：用户隔离：每个用户一个运行环境

相比 [s13-auth](s13-auth/)：可信 owner 选择独立进程与原生目录；池控制名额，uid/gid 约束文件访问。

**新增模块**：用户运行环境（用户隔离，owner 路由、进程池与 uid）

**新增数据迁移**：`011-user-runtimes.sql`、`012-runtime-migration.sql`
