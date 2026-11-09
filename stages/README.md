# stages — 教学迭代路线

这套教程带你亲手做一个**云端 Agent**：一个常驻在服务器上、随时可以连上去用的写作助手。从 [导论](introduction.md) 开始，先弄清 Codex harness 是什么、App Server 怎么用，以及一个 Agent 要回答的六个问题里，哪些 Codex 已经替你回答了，哪些要由我们在外面补上。后面每一章给这个 Agent 加上一块：先在本机跑通、变成服务、装配成写作助手，再部署上云、让多个用户共用，最后扩展到多台机器。持续开发的完整项目在 [app](../app/README.md)。

每个阶段是一份**独立、可运行**的源码快照：有自己的 `package.json`、`.env`、`.data`、`.runs` 和 `workspace`，互不共享，可以单独复制出去运行。阶段之间只做增量：下一阶段在上一阶段基础上只加一个主要能力。

## 演进路径

| 阶段 | 核心能力 | 新引入的机制 | 默认端口 |
|------|---------|-------------|---------|
| [导论](introduction.md) | 理解 Codex harness | harness 的能力、App Server 协议、Item / Turn / Thread、六个问题 | — |
| [s00-sdk-quickstart](s00-sdk-quickstart/README.md) | 用官方 SDK 调用 Codex | Thread / Turn、事件流、结构化输出、沙箱 | — |
| [s01-single-turn](s01-single-turn/README.md) | 单轮对话 | 直连 App Server JSON-RPC，按终态判定成败 | — |
| [s02-multi-turn](s02-multi-turn/README.md) | 单进程多轮对话 | FIFO 输入、同一 Thread 多 Turn、原生历史恢复 | — |
| [s03-service](s03-service/README.md) | 服务化 | 常驻服务端 + 终端客户端、连接令牌、生命周期、运行目录清理 | 4313 |
| [s04-events-messages](s04-events-messages/README.md) | 事件与消息 | 服务端任务队列（先进先出、追加、暂停与继续）、JSON 任务记录、SSE 事件推送与快照重连 | 4319 |
| [s05-agent-assembly](s05-agent-assembly/README.md) | Agent 装配 | Agent JSON 定义与 schema 校验、角色文件、原生 Skill 白名单、版本描述符与会话绑定 | 4323 |
| [s06-tools](s06-tools/README.md) | 工具 | 配置装配工具注册表、Agent 工具白名单与参数校验、按用途授权的资料目录、MCP 回调 | 4324 |
| [s07-memory](s07-memory/README.md) | 记忆 | Codex 原生记忆、服务端开关与会话参与 | 4325 |
| [s08-data-layer](s08-data-layer/README.md) | 数据层 | PostgreSQL 持久任务 + outbox、Redis 调度、资源版本 | 4314 |
| [s09-knowledge-layer](s09-knowledge-layer/README.md) | 知识层 + 通用门禁 | 可信权限上下文、版本化 Wiki、可选 Chroma + BM25 RAG、dynamicTools | 4315 |
| [s10-skill-workflow](s10-skill-workflow/README.md) | Skill 与 Workflow | Agent 包、Skill 同步与隐式读取、Workflow（授权 / 步骤 / 验收）、任务提议 | 4316 |
| [s11-model-gateway](s11-model-gateway/README.md) | 模型网关 | Bifrost 网关、模型清单（用途 / 能力 / 价格）、按用途与场景路由、备用链、模型自带的联网搜索、生图与生视频、用量账本与预算 | 4318 |
| [s12-deploy](s12-deploy/README.md) | 上云部署 | Compose 交付、健康与就绪探测、容量与限流、优雅关闭、备份与回滚 | 4326 |
| [s13-auth](s13-auth/README.md) | 账号与认证 | 密码与不透明令牌、吊销、请求身份随执行传递、按 owner 归属与 404 | 4327 |
| [s14-isolation](s14-isolation/README.md) | 用户隔离 | 每用户 Codex 进程与 CODEX_HOME、系统 uid/gid、进程池与回收 | 4328 |
| [s15-hub](s15-hub/README.md) | 权限与资源 Hub | 资源范围、指定用户授权、权益与配额、Skill 审批、只追加审计 | 4329 |
| [s16-coordination](s16-coordination/README.md) | 协调面 | etcd 成员租约与 Watch、control 选举、任期隔离、自我隔离与重新加入 | 4334（入口），4340–4342（节点） |
| [s17-sharding](s17-sharding/README.md) | 分片与路由 | 按用户分片、分片归属表与路由缓存、STALE_ROUTE 重试、按分片隔离写入、用户迁移 | 4335（入口），4340–4342（节点） |
| [s18-replication](s18-replication/README.md) | 副本与故障接管 | 边界快照与异步复制、复制位点、租约过期接管、尾部丢失标记、旧主回归追平 | 4336（入口），4340–4342（节点） |
| [../app](../app/README.md) | 持续开发的完整项目 | 在 s11 之上继续演进：Docker 部署、Web 工作台与互动课程（不含 s12–s18） | 4317 |

课程、Web 工作台、服务 API 与实验命令统一使用这套编号，例如 `/api/agent/s09`、`npm run lesson -- s01-transport`。

## 互动课程与 Web 工作台

在 `../app` 运行 `npm run web`，打开 [互动课程](http://127.0.0.1:4320/course/) 或 [版本工作台](http://127.0.0.1:4320/)。机制课程 s01–s18 共 52 节已上线，先看架构、再逐层拆解，每节的源码摘录都直接取自本目录；工作台选择对应阶段；s12–s18 仅展示课程和独立部署说明，不连接实时服务。使用说明见 [Web 客户端说明](../app/web/README.md)。

## 关键约束

- **一个服务实例绑定一个 Agent 配置，支持多个会话 Thread**。到 s12 为止是单用户、单台机器；s13–s15 加上账号、隔离和资源权限，s16–s18 扩展到多个节点。
- **Node >= 24，`@openai/codex` 固定 `0.154.0`**。
- **不自造模型/工具执行 loop**：模型执行循环由 Codex 原生负责。
- **版本变化需新 Thread**：配置、角色、Skill 任一变更后旧 Thread 不自动兼容，需 `/new`；不删除原生历史。

## 每一阶段给云端 Agent 加了什么

- **s00** 用官方 SDK 把一个任务交给 Codex，先体验 harness 替你做了什么。
- **s01 / s02** 不用 SDK，直接对接 App Server 协议：打通到模型的链路，再支持多轮对话和恢复会话。
- **s03** 让它常驻：拆成常驻的服务端和随时来去的客户端，客户端关掉，交出去的一轮照样跑完。
- **s04** 让它会排队：输入先写进任务记录，在服务端逐条执行；状态经 SSE 推给客户端，断线重连不漏、不重发。
- **s05** 让它有身份：一份 Agent JSON 决定角色、Skill 和执行策略；配置一变，旧会话就要新建。
- **s06** 让它能动手：工具白名单与参数校验，按用途授权的资料目录，经 MCP 回调执行。
- **s07** 让它记得住：Codex 原生记忆负责提炼，开不开、哪些会话参与由服务端决定。业务状态到这里仍存在本地 JSON 文件里。
- **s08** 让它靠得住：会话、任务、资源元数据存进 PostgreSQL，Redis 负责唤醒调度，文件正文存成不可变的版本对象。
- **s09** 让它守得住：统一门禁按 Thread / Turn 绑定的可信上下文判定权限；工具改走 Codex 原生的 `dynamicTools`（保留 MCP 供兼容测试）；加上知识库（Wiki，可选 RAG）。
- **s10** 让它会干活：Agent 包、Skill 同步到 `CODEX_HOME`；Workflow 规定本任务的授权、Skill、写入位置、验收和确认点；模型可以用 `propose_task` 提议任务、用 `skill_read` 读取 Skill，但不能批准自己的提议；受限启动关闭原生线程目标和工作区 `AGENTS.md` 的加载。
- **s11** 让它管好模型：Codex 只连模型网关（Bifrost），各家密钥只在网关；一份模型清单登记用途、能力和价格，按用途、场景、能力挑模型，出错时走备用链；按模型实测开关自带的联网搜索；向量、生图、生视频也经网关；每一轮的用量记账，超预算就停派新任务，网关再按 token 限流兜底。
- **s12** 让它上云：Compose 交付到一台没人看着的服务器，自己启动、自己恢复；健康与就绪分开探测，排队和请求都有上限，关闭时执行中的轮次记为待核对，备份可校验、代码可回滚。
- **s13** 让它认得人：每个用户登录自己的账号，身份随请求和后台任务一路传递；会话、任务、知识库都有归属，别人的一律返回"不存在"。
- **s14** 让用户互不可见：每个用户一个独立的 Codex 进程、CODEX_HOME 和系统 uid，原生历史和记忆在操作系统层面也读不到彼此。
- **s15** 让资源有边界：知识库、Skill、工具、Agent 统一由 Hub 判定谁能用、谁能改、能分享给谁；权益决定配额，每次变更留审计。
- **s16** 让多台机器知道谁活着、谁说了算：etcd 成员租约、Watch 与 control 选举，任期号挡住醒来的旧 control，失联节点自我隔离。
- **s17** 让一台机器装不下时也能服务：按用户分片，任意入口按路由缓存转发到用户的主节点，数据库按分片隔离写入，支持手动迁移用户。
- **s18** 让一台机器坏了也有人接手：轮次边界异步复制到副本，主节点租约过期后由已追平的副本接管；最后一次复制之后的内容如实标为丢失。
- **app** 在 s11 之上持续开发，另有 Docker 部署、Web 工作台与互动课程；s12–s18 不并入 app，各自提供独立部署快照。

## 修改阶段快照的规则

阶段是教学材料，默认冻结；持续开发发生在 [`../app`](../app/README.md)，不与任何阶段同步。缺陷先在 `app/` 修复；只有影响教学正确性的问题才回补到阶段目录，回补后在 `app` 下运行 `npm run course:build` 更新课程源码摘录，并运行下方验证。

s10、s11 的快照取自 `app`，所以代码里还带着配置选择、会话兼容检查和流式推送协议 v2 等章节没有讲的部分；s10 的章节只讲 Skill 与 Workflow，s11 只讲模型网关。s11 的快照去掉了 Web 工作台、Docker 部署和角色评估工具，排除清单见 `s11-model-gateway/snapshot.json`。Web 工作台与互动课程只在 `app` 里。

## 验证

各阶段自带 `npm test`；集成验证从本目录运行：

```bash
node verify.mjs --docs-only          # 仅文档与结构检查（CI 默认运行）
node verify.mjs --integration        # 集成验证，结果写入 verification.json
node verify.mjs --integration --rag  # 另需 Chroma CLI，包含真实 RAG 验证
```

实际结果见 [`verification.json`](verification.json)，文档不预填数字。

s08 使用 v1 数据结构，s09 使用 v2；同时保留两个版本时，使用同一 PostgreSQL 实例中的不同数据库，避免旧版连接已经升级的库。默认示例分别为 agent_s08 / agent_s09。各 Compose 使用相同宿主端口，不要同时启动两套争抢端口；可共用一组服务并分别创建数据库。
