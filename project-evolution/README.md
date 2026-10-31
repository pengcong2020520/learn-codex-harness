# Project Evolution — 演进路径总览

本仓库包含五个独立演进阶段（Demo1–5）及 `project/` 当前运行副本。每个 Demo 是独立源码快照，`.env`、`.data`、`.runs`、`workspace` 均不共享，不相互复制。

## 互动课程与 Web 工作台

在 `../project` 运行 `npm run web`，打开 [五章互动课程](http://127.0.0.1:4320/course/) 或 [版本工作台](http://127.0.0.1:4320/)。课程先看架构、再逐层拆解；工作台选择对应 Demo，连接它自己的运行服务和数据。使用说明见 [Web 客户端说明](../project/web/README.md)。

## 演进路径

| Demo | 核心能力 | 默认端口 |
|------|---------|---------|
| [Demo 1](demo1/README.md) | 单轮对话基础 | — |
| [Demo 2](demo2/README.md) | 单进程多轮对话 | — |
| [Demo 3](demo3/README.md) | 配置驱动 Agent 核心、MCP 工具、文件服务 | 4313 |
| [Demo 4](demo4/README.md) | 数据层升级：PG 业务存储 + Redis 调度队列 | 4314 |
| [Demo 5](demo5/README.md) | 知识层 + 通用门禁；project 同步升级到此实现 | 4315 |
| project | 当前开发项目（与 Demo 5 实现同步） | 4317 |

## 关键约束

- **单机单 owner 单 Agent 配置、多 Thread**：每服务实例绑定一个 Agent 配置，支持多个会话 Thread，不支持多账户登录、多 Agent 编排或多主机共享。
- **Node >= 24，`@openai/codex` 固定 `0.154.0`**。
- **不自造模型/工具执行 loop**：模型执行循环由 Codex 原生负责。
- **版本变化需新 Thread**：配置、角色、Skill 任一变更后旧 Thread 不自动兼容，需 `/new`；不删除原生历史。

## 演进原因

Demo 1/2 验证了基础对话机制。Demo 3 引入配置驱动，工具权限、资料边界全由 JSON 管控，但业务状态保留本地 JSON 文件；此前混入的数据升级代码已抽离到 Demo 4。

Demo 4 将此部分独立拆出：业务会话、任务、资源元数据迁移至 PostgreSQL；Redis 提供调度队列唤醒；文件正文保留本地版本对象存储。

Demo 5 在 Demo 4 基础上叠加知识层（KB / Wiki / 可选 RAG）和统一门禁（基于 Thread/Turn 上下文的权限判定），并将工具传输从 MCP 改为 Codex 原生 `dynamicTools`（保留 MCP 供兼容测试）。`project/` 同步升级至此实现。

## 验证结果

各 Demo 自带 `npm test`；集成验证从 project-evolution 目录运行：

```bash
node verify.mjs --integration   # 默认集成验证，结果写入 verification.json
node verify.mjs --integration --rag  # 另需 Chroma CLI，包含真实 RAG 验证
node verify.mjs --docs-only     # 仅文档与结构检查
```

实际结果见 [`verification.json`](verification.json)，文档不预填数字。

Demo 4 使用 v1 数据结构，Demo 5 使用 v2；同时保留两个版本时，使用同一 PostgreSQL 实例中的不同数据库，避免旧版连接已经升级的库。默认示例分别为 agent_demo4 / agent_demo5。各 Compose 使用相同宿主端口，不要同时启动两套争抢端口；可共用一组服务并分别创建数据库。
