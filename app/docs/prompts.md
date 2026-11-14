# 给 AI 助手的可复制提示词

把仓库提供给助手后，复制对应提示词并填写方括号。以下文件路径和命令均相对于 `app/`，先让助手进入该目录。支持 Skill 时，Codex 可用 `$new-agent`、`$extend-agent`、`$go-production`，Claude Code 可用对应的 `/new-agent`、`/extend-agent`、`/go-production`。

## 从需求创建 Agent

```text
请用这个脚手架为我创建 Agent：[需求]，id 为 [id]。

先读仓库根目录 AGENTS.md，再进入 app/。读 README「做你自己的 Agent」、agents/writing/agent.json、对应 role.md 与 Skill，以及 examples/ 里最接近的示例；模型以 config/models.json 为准。

先一次问清最多六个问题：给谁用、完成什么任务、交付物形式、资料来源（上传/知识库/联网）、哪些步骤要人确认、对模型看图/联网/成本的要求。已经说清的不要再问。
运行 npm run agent:new -- <id>，然后把服务对象与交付要求写入 role.md，把任务方法写入 Skill，把工具、数据绑定、输出、工作流、确认点和步骤模型写入 agent.json。写 description 和 3–6 条 starters，网页首页会展示。工作流放 agent.workflows，confirm 是本步完成后等待确认，writes 只能收窄已有范围。
运行 npm run agent:check -- agents/<id>/agent.json，按定位与改法修正，直到没有错误。占位角色虽属建议，也应在交付前改掉；说明资料未部署产生的建议。
运行 npm run agent:use -- <id>，再运行 npm run up。给我三个示例请求和各自应该看到的结果，并说明需要新建会话。

边界：不改 server/、compose.yaml 和数据库迁移，需要内核支持时停下说明原因。不读取、不打印 .env；未初始化时按 README「快速开始」运行 npm run setup，密钥由我自己在终端输入，不在对话里索要或回显。看图只用 config/models.json 中 inputs 含 image、用途含 chat 的模型，联网还要核对模型能力、工具和用户授权。结果不明时停止核对，不自动重试。
```

## 扩展已有 Agent

```text
请扩展 agents/[id]/ 下的 Agent，增加：[能力]。

先读仓库根目录 AGENTS.md，再进入 app/。读 README「做你自己的 Agent」、目标 agent.json、role.md、Skill，以及 agents/writing 和 examples/ 中最接近的示例；涉及模型时读 config/models.json，知识库按 README「知识库：绑定原始资料与 Wiki」。不要读取 .env 来确认当前 Agent。

先运行 npm run agent:check -- agents/<id>/agent.json，区分现有问题和本次变更。只做满足需求的最小修改：工作流明确确认点、验收 checks 和 writes 范围；知识库声明绑定及读/更新/索引权限；工具通过 agent.tools.allow 增加或收窄，并核对 dataBindings 与 bindings.sources；步骤模型核对 chat 用途、needs 和 effort，看图要求 inputs 含 image。confirm 是本步完成后确认，writes 不能扩大已有权限。挂知识库时需关闭共享原生记忆，配置由我在终端修改。
每次改完运行 npm run agent:check -- agents/<id>/agent.json，修正错误，解释建议。要切换目标时用 npm run agent:use -- <id>，再运行 npm run up。给出新建会话后的验证请求、预期结果、确认点和越界请求应有的拒绝行为；不承诺旧会话继续兼容。

边界：不改 server/、compose.yaml 和数据库迁移，现有内核不支持时停下说明。不读取、不打印 .env，不索要或回显密钥和密码，不用角色文字扩大权限。结果不明时停止核对，不自动重试。
```

## 准备生产部署

```text
请把我的本地 Agent [id] 准备好部署到 [域名或部署目标]。

先读仓库根目录 AGENTS.md，再进入 app/。读 README「部署到服务器」「域名与 HTTPS」「备份与恢复」「配置项参考」「打开集群」和目标 Agent 配置。

先运行 npm run production:check，逐项解释 ✗ 必须处理、! 建议处理的原因，说明 ✓ 的静态验证边界。确认我有没有服务器、有没有域名、是否希望用自己的数据库。当前只支持脚手架自带数据库，外部数据库是计划中的功能，不要假装支持。只有服务器且接受自带数据库时，按 README「部署到服务器」操作，先确认远端具备该节要求的工具，脚本不会代装。
动线上服务器前，列出具体命令、影响和回滚方法，等我确认；说明 rollback 只回滚代码和镜像，不回滚数据库。
逐项处理：域名、DNS、HTTPS 证书、允许来源和宿主反向代理；在目标部署目录用 npm run user:add -- <用户名> 创建用户；用 npm run backup 备份并安排定时执行，在独立环境按 README 用 npm run restore -- <备份目录名> 演练恢复；按我确认的数值设置预算；核对 config/models.json 的 fallbacks 并配置备用服务商；需要故障接管时按 README「打开集群」运行 npm run cluster:enable。同机多容器不代表能承受宿主故障，恢复会覆盖目标数据，不拿线上数据演练。
部署后在实际部署目录再运行 npm run production:check，并通过真实入口验证一次登录和对话。认证由我在终端完成，真实对话先确认模型调用范围。分别报告已通过、待处理和未验证项。

边界：不读取、不打印 .env，不在对话里索要或回显密钥和密码，需要时让我自己在终端输入。检查命令不会启动服务，也不代表证书、Key、数据库连接、真实对话、备份恢复或接管已经验证。不改内核或迁移来绕过部署限制，不删除线上数据卷。部署中断或状态不明时停止核对，不自动重试或重发。
```

## 两个填空示例

- **做一个客服 Agent：** 给 `[客户类型]` 用，回答 `[产品/售后范围]`，交付 `[对话回复/Markdown 工单摘要]`；资料来自 `[上传文件/知识库]`，遇到 `[退款/赔偿/无资料的问题]` 必须请人确认；模型需要 `[看图/联网]`，成本要求为 `[要求]`。请按“从需求创建 Agent”的提示词执行。
- **把我本地的写作助手部署到 example.com：** Agent 在 `agents/[id]/`，已有 `[服务器及工具准备情况]`，域名 `[解析状态]`，数据库选择 `[接受脚手架自带数据库/希望用现有数据库，先说明支持边界]`；预计 `[用户规模]`，预算 `[我确认的数值]`，故障接管要求 `[要求]`。请按“准备生产部署”的提示词执行，线上操作先给出命令和回滚方法等我确认，密钥与密码由我在终端输入。
