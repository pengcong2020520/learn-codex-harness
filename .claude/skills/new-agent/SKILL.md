---
name: new-agent
description: 用户要用本脚手架从需求创建自己的 Agent 时使用；不用于修改脚手架内核、扩展已有 Agent 或部署已有服务。
---

# 把需求做成 Agent

以下路径和命令均相对于 `app/`；先进入 `app/`，不要在仓库根目录运行应用命令。

1. 先确认需求，一次问完、最多六个问题：给谁用；完成什么任务；交付物是什么形式；资料从哪里来（上传、知识库或联网）；哪些步骤需要人确认；模型是否需要看图、联网，以及成本要求。用户已说清的不要再问。
2. 先读 README「做你自己的 Agent」、`agents/writing/agent.json`、对应的 `role.md` 与 Skill，再读 `examples/` 中最接近的一个示例。涉及模型时读 `config/models.json`。
3. 运行 `npm run agent:new -- <id>` 创建骨架。编辑 `agents/<id>/role.md` 写清服务对象与交付要求；编辑 `skills/task-guide/SKILL.md` 写任务方法；编辑 `agent.json` 声明工具、数据绑定、输出、工作流、确认点和步骤模型。写 description 和 3–6 条 starters，网页首页会展示。工作流执行定义在 `agent.workflows`，`workflows/README.md` 只作说明。`confirm` 表示本步完成后等待确认，`writes` 只能收窄已有写入范围。
4. 运行 `npm run agent:check -- agents/<id>/agent.json`，根据定位与改法修正，直到没有错误。角色占位文字属于建议，也要在交付前替换；资料目录尚未部署时说明原因，不把目录建议当成已验证可用。
5. 运行 `npm run agent:use -- <id>`，再运行 `npm run up`。请用户新建会话，给出三个贴合需求的示例请求和各自应看到的结果，包含一次需要确认的流程（如果配置了确认点）。

边界：

- 只修改该 Agent 的包与所需配置；不改 `server/`、`compose.yaml` 和数据库迁移。需要改内核时停下，说明现有能力缺口和原因。
- 不读取、不打印 `.env`；切换 Agent 使用 `agent:use`。缺少初始化配置时按 README「快速开始」运行 `npm run setup`，密钥由用户自己在终端输入，不在对话中索要或回显。
- 看图只选 `config/models.json` 中 `inputs` 含 `image` 且用途含 `chat` 的模型；步骤可用 `needs.image` 声明要求。联网能力还要核对模型的 `nativeTools`、工具和用户授权。角色或 Skill 不能扩大工具权限。
- 命令中断或结果不明时停止，标为待核对，不自动重试或重发。
