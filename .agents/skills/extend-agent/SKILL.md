---
name: extend-agent
description: 用户要给已有 Agent 加工作流、知识库、工具或调整步骤模型时使用；不用于从零创建 Agent、修改脚手架内核或生产部署。
---

# 扩展已有 Agent

以下路径和命令均相对于 `app/`；先进入 `app/`。

1. 确认目标 Agent 和新增能力；用户已明确的内容不重复询问。先读 README「做你自己的 Agent」、目标包的 `agent.json`、`role.md` 与 Skill。参考 `agents/writing`、`examples/` 中最接近的示例；分配模型前读 `config/models.json`。不要通过读取 `.env` 查找当前 Agent。
2. 先运行 `npm run agent:check -- agents/<id>/agent.json` 了解现有问题，再做本次所需的最小改动：
   - 工作流放在 `agent.workflows`。明确确认点、验收检查与写入范围；`confirm` 是本步结束后等人确认，`checks` 选现有检查，`writes` 只收窄可写范围，不扩大权限。
   - 知识库按 README「知识库：绑定原始资料与 Wiki」设置 `agent.knowledge` 与 `bindings.knowledgeBases`，区分读、更新、索引权限；需要用户初始化或导入资料时给出具体步骤。挂载知识库时共享原生记忆必须关闭，需要配置时请用户在终端操作。
   - 工具在 `agent.tools.allow` 中按任务增加或收窄；资料权限同时核对 `dataBindings` 和 `bindings.sources`。不要靠角色文字授权。
   - 给工作流步骤指定模型或场景，核对用途含 `chat`、推理档位及所需能力。看图只选 `inputs` 含 `image` 的模型；联网要核对模型能力和工具授权。
3. 每次改完都运行 `npm run agent:check -- agents/<id>/agent.json`，修正错误并说明仍存在的建议。切换目标时运行 `npm run agent:use -- <id>`，再运行 `npm run up`。
4. 告诉用户如何新建会话验证新增能力：给出请求、预期产物、何时确认，以及越界请求应如何被拒绝。配置变化后的旧会话可能不兼容，不承诺旧会话继续执行。

边界：不改 `server/`、`compose.yaml` 或数据库迁移；能力需要内核支持时停下说明。不得读取、打印 `.env`，不得索要或回显密钥和密码。命令中断或结果不明时停止核对，不自动重试。
