# stages — 教学迭代路线

每个阶段是一份**独立、可运行、已冻结**的源码快照：有自己的 `package.json`、`.env`、`.data`、`.runs` 和 `workspace`，互不共享，可以单独复制出去运行。阶段之间只做增量：下一阶段在上一阶段基础上只引入一个主要机制。

持续开发发生在 [`../app`](../app/README.md)，**不与任何阶段同步**。s06 是 2026-10-31 从 `app` 冻结的快照，因此也带着 s05 之后加入的配置选择、会话升级、协议兼容检查和流式推送协议 v2；s06 的章节只讲 Skill 与 Workflow。Web 工作台与互动课程只在 `app` 里，s06 的快照不包含它们。

## 演进路径

| 阶段 | 核心能力 | 新引入的机制 | 默认端口 |
|------|---------|-------------|---------|
| [s00-sdk-quickstart](s00-sdk-quickstart/README.md) | 用官方 SDK 调用 Codex | Thread / Turn、事件流、结构化输出、沙箱 | — |
| [s01-single-turn](s01-single-turn/README.md) | 单轮对话 | 直连 App Server JSON-RPC，按终态判定成败 | — |
| [s02-multi-turn](s02-multi-turn/README.md) | 单进程多轮对话 | FIFO 输入、同一 Thread 多 Turn、原生历史恢复 | — |
| [s03-agent-core](s03-agent-core/README.md) | 配置驱动 Agent 核心 | Agent JSON 装配、Skills、MCP 工具注册表、工作区边界 | 4313 |
| [s04-data-layer](s04-data-layer/README.md) | 数据层 | PostgreSQL 持久任务 + outbox、Redis 调度、资源版本 | 4314 |
| [s05-knowledge-layer](s05-knowledge-layer/README.md) | 知识层 + 通用门禁 | 可信权限上下文、版本化 Wiki、可选 Chroma + BM25 RAG、dynamicTools | 4315 |
| [s06-skill-workflow](s06-skill-workflow/README.md) | Skill 与 Workflow | Agent 包、Skill 同步与隐式读取、Workflow（授权 / 步骤 / 验收）、任务提议 | 4316 |
| [../app](../app/README.md) | 持续开发的完整项目 | 在 s06 之上继续演进 | 4317 |

课程、Web 工作台、服务 API 与实验命令统一使用这套编号，例如 `/api/agent/s05`、`npm run lesson -- s01-transport`。旧书签里的 `?stage=demoN` 会自动对应到 `s0N`。

## 互动课程与 Web 工作台

在 `../app` 运行 `npm run web`，打开 [五章互动课程](http://127.0.0.1:4320/course/) 或 [版本工作台](http://127.0.0.1:4320/)。课程先看架构、再逐层拆解，共 17 节，每节的源码摘录都直接取自本目录；工作台选择对应阶段，连接它自己的运行服务和数据。使用说明见 [Web 客户端说明](../app/web/README.md)。

## 关键约束

- **单机单 owner 单 Agent 配置、多 Thread**：每服务实例绑定一个 Agent 配置，支持多个会话 Thread，不支持多账户登录、多 Agent 编排或多主机共享。
- **Node >= 24，`@openai/codex` 固定 `0.154.0`**。
- **不自造模型/工具执行 loop**：模型执行循环由 Codex 原生负责。
- **版本变化需新 Thread**：配置、角色、Skill 任一变更后旧 Thread 不自动兼容，需 `/new`；不删除原生历史。

## 演进原因

s00 用 SDK 跑通 Codex；s01/s02 去掉 SDK 封装，直接对接 App Server 协议，验证基础对话机制。s03 引入配置驱动，工具权限、资料边界全由 JSON 管控，但业务状态保留本地 JSON 文件；此前混入的数据升级代码已抽离到 s04。

s04 将此部分独立拆出：业务会话、任务、资源元数据迁移至 PostgreSQL；Redis 提供调度队列唤醒；文件正文保留本地版本对象存储。

s05 在 s04 基础上叠加知识层（KB / Wiki / 可选 RAG）和统一门禁（基于 Thread/Turn 上下文的权限判定），并将工具传输从 MCP 改为 Codex 原生 `dynamicTools`（保留 MCP 供兼容测试）。

s06 把 s05 里写死的知识维护推广成 Workflow：Agent 定义改为 Agent 包，Skill 移出工作区并在启动时同步到 `CODEX_HOME`；Workflow 规定本任务额外的授权、注入的 Skill、可写的位置和验收，多步任务在需要人拍板的地方停下等确认；模型可以用 `propose_task` 提议任务、用 `skill_read` 读取 Skill，但不能批准自己的提议。受限启动同时关闭了原生线程目标和工作区 `AGENTS.md` 的加载。

## 修改阶段快照的规则

阶段是教学材料，默认冻结。缺陷先在 `app/` 修复；只有影响教学正确性的问题才回补到阶段目录，回补后在 `app` 下运行 `npm run course:build` 更新课程源码摘录，并运行下方验证。

## 验证

各阶段自带 `npm test`；集成验证从本目录运行：

```bash
node verify.mjs --docs-only          # 仅文档与结构检查（CI 默认运行）
node verify.mjs --integration        # 集成验证，结果写入 verification.json
node verify.mjs --integration --rag  # 另需 Chroma CLI，包含真实 RAG 验证
```

实际结果见 [`verification.json`](verification.json)，文档不预填数字。该文件是目录重组前生成的记录，其中的 `demoN` 目录名对应现在的 s01–s05；下次运行集成验证时会按新目录名重新生成。

s04 使用 v1 数据结构，s05 使用 v2；同时保留两个版本时，使用同一 PostgreSQL 实例中的不同数据库，避免旧版连接已经升级的库。默认示例分别为 agent_s04 / agent_s05。各 Compose 使用相同宿主端口，不要同时启动两套争抢端口；可共用一组服务并分别创建数据库。
