# stages — 教学迭代路线

这套教程带你亲手做一个**云端 Agent**：一个常驻在服务器上、随时可以连上去用的写作助手。从 [导论](introduction.md) 开始，先弄清 Codex harness 是什么、App Server 怎么用，以及一个 Agent 要回答的六个问题里，哪些 Codex 已经替你回答了，哪些要由我们在外面补上。后面每一章给这个 Agent 加上一块，最后在 [app](../app/README.md) 里部署上云。

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
| [../app](../app/README.md) | 持续开发的完整项目 | 在 s11 之上继续演进：Docker 部署、Web 工作台与互动课程 | 4317 |

课程、Web 工作台、服务 API 与实验命令统一使用这套编号，例如 `/api/agent/s09`、`npm run lesson -- s01-transport`。旧书签里的 `?stage=demoN` 会自动对应到 `s0N`。

## 互动课程与 Web 工作台

在 `../app` 运行 `npm run web`，打开 [五章互动课程](http://127.0.0.1:4320/course/) 或 [版本工作台](http://127.0.0.1:4320/)。课程先看架构、再逐层拆解，共 17 节，每节的源码摘录都直接取自本目录；工作台选择对应阶段，连接它自己的运行服务和数据。使用说明见 [Web 客户端说明](../app/web/README.md)。

## 关键约束

- **单机单 owner 单 Agent 配置、多 Thread**：每服务实例绑定一个 Agent 配置，支持多个会话 Thread，不支持多账户登录、多 Agent 编排或多主机共享。这三个方向的思路分别写在 s09、s10 章节末尾的"延伸"里。
- **Node >= 24，`@openai/codex` 固定 `0.154.0`**。
- **不自造模型/工具执行 loop**：模型执行循环由 Codex 原生负责。
- **版本变化需新 Thread**：配置、角色、Skill 任一变更后旧 Thread 不自动兼容，需 `/new`；不删除原生历史。

## 每一阶段给云端 Agent 加了什么

- **s00** 用官方 SDK 把一个任务交给 Codex，先体验 harness 替你做了什么。
- **s01 / s02** 不用 SDK，直接对接 App Server 协议：打通到模型的链路，再支持多轮对话和恢复会话。
- **s03** 用一份 JSON 装配 Agent：角色、Skill、工具、记忆和资料边界一起生效；程序拆成常驻的服务端和客户端。这一阶段的业务状态存在本地 JSON 文件里。
- **s08** 让 Agent 靠得住：会话、任务、资源元数据存进 PostgreSQL，Redis 负责唤醒调度，文件正文存成不可变的版本对象。
- **s09** 让 Agent 守得住：统一门禁按 Thread / Turn 绑定的可信上下文判定权限；工具改走 Codex 原生的 `dynamicTools`（保留 MCP 供兼容测试）；加上知识库（Wiki，可选 RAG）。
- **s10** 让 Agent 会干活：Agent 包、Skill 同步到 `CODEX_HOME`；Workflow 规定本任务的授权、Skill、写入位置、验收和确认点；模型可以用 `propose_task` 提议任务、用 `skill_read` 读取 Skill，但不能批准自己的提议；受限启动关闭原生线程目标和工作区 `AGENTS.md` 的加载。
- **s11** 让 Agent 管好模型：Codex 只连模型网关（Bifrost），各家密钥只在网关；一份模型清单登记用途、能力和价格，按用途、场景、能力挑模型，出错时走备用链；按模型实测开关自带的联网搜索；向量、生图、生视频也经网关；每一轮的用量记账，超预算就停派新任务，网关再按 token 限流兜底。
- **之后（规划中）**：s12 上云部署（Docker、服务器、开机自启）→ s13 多用户（认证、按用户隔离运行环境、配额）→ s14 多 Agent 协作 → s15 多主机调度。
- **app** 在 s11 之上持续开发，s12 的上云部署已经在里面实现，另有 Web 工作台与互动课程。

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

实际结果见 [`verification.json`](verification.json)，文档不预填数字。该文件是目录重组前生成的记录，其中的 `demoN` 目录名对应现在的 s01–s09；下次运行集成验证时会按新目录名重新生成。

s08 使用 v1 数据结构，s09 使用 v2；同时保留两个版本时，使用同一 PostgreSQL 实例中的不同数据库，避免旧版连接已经升级的库。默认示例分别为 agent_s08 / agent_s09。各 Compose 使用相同宿主端口，不要同时启动两套争抢端口；可共用一组服务并分别创建数据库。
