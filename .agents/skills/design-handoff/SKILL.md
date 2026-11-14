---
name: design-handoff
description: 用户要把已确认的 Agent 设计生成代码与落地包、部署手册和本地编码助手提示词时使用；不用于跳过设计确认、直接修改运行中的服务端或部署运行环境。
---

先读 [总流程与产物约定](../agent-design-flow/SKILL.md)。产出路径相对于用户自己的工作区；只新建版本，不覆盖历史文件。使用最新且已获用户确认的输入版本；较新的未确认版本不能替代确认记录。「修改」重做当前步，「结束」保存进度并停止。

# 代码与落地包

仅在资料卡、PRD、线框、主题、原型和走查均已明确确认且版本彼此匹配后生成。检查走查待改 / 阻塞项的处理依据，未处理的不能假装完成。一份脚手架就是一个产品，只有管理员能进入工作室，多个管理员共用一个设计项目。工作室直接生成完整 Agent 代码包，先在本机设计和落地，再部署到服务器；运行中的工作室只写管理员工作区，不修改服务端代码。

## 目录与最终产物

新建 `outputs/design/<项目 id>/package-v1/`，修订新建 `outputs/design/<项目 id>/package-v<n>/`，不要在已交付目录内更新文件。项目 id 对应产品 id；Agent id 单独记录。复制确认过的原文件，保留实际版本号；不是强制都选 v1。完整目录包含：

```text
package-v1/
  manifest.json
  agent/
    agent.json
    role.md
    skills/
      <skill-id>/SKILL.md
    ui/
      index.html
      app.js
      styles.css
  design/
    brief-v1.md
    prd-v1.md
    wireframe-v1.html
    themes-r1.html
    theme-v1.json
    prototype-v1.html
    structure-changes-v1.md
    walkthrough-plan-v1.json
    walkthrough-v1.html
    walkthrough-r1.json
    decisions-v1.json
  DEPLOY.md
  PROMPT.md
```

工作流完整写在 `agent/agent.json` 的 `agent.workflows`，引用的角色、Skill 与资源必须随包提供。`agent/ui/` 是按已确认原型实现的前端代码，按需要包含模块和本地资源。`design/` 收录最终确认的各阶段产物、确认记录及必要的反馈历史依赖；所选主题来自其他轮时收录对应 `themes-r<n>.html`，保证相对引用在包内解析。设计 HTML 仍为可离线单文件，不用截图代替；实际前端按下文 CSP 分离脚本和样式。

**代码包不含宿主机脚本**：只包含代码、配置、设计记录和文档；不得附带让用户在宿主机执行的 shell、安装、迁移或落地脚本，也不能把模型生成的命令藏进 manifest 的钩子或文档让用户执行。浏览器运行的 JS 属于前端代码。落地只能调用脚手架自带的固定命令，不让用户运行模型生成的 shell 脚本。

## manifest.json

清单记录包格式版本、产品 id、Agent id、文件路径与 SHA-256、各设计产物的版本和确认记录、目标脚手架最低版本及落地所需信息。下面是字段结构示例，`files` 和 `artifacts` 仅展示一项；实际包必须完整列出，不能照抄占位值。K4 尚未提供清单解析器，字段最终按 K4 约定核对；本节不宣称解析器已经支持这些字段。

```json
{
  "schemaVersion": 1,
  "projectId": "sample-agent",
  "productId": "sample-agent",
  "agentId": "sample-agent",
  "packageVersion": 1,
  "createdAt": "2026-11-14T12:00:00Z",
  "confirmation": {"status":"proposed","confirmedAt":null,"confirmedBy":null},
  "scaffold": {
    "minimumVersion": "<实际包含所需能力的最低脚手架版本或提交>",
    "requiredCapabilities": ["K2", "K4"]
  },
  "files": [
    {"path":"design/brief-v1.md","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}
  ],
  "artifacts": [
    {
      "kind":"brief","path":"design/brief-v1.md","version":1,
      "source":"brief-v1.md","inputs":[],
      "confirmedAt":"2026-11-14T11:00:00Z","confirmedBy":"项目用户"
    }
  ],
  "landing": {
    "agentSource":"agent/",
    "uiSource":"agent/ui/",
    "designSource":"design/",
    "replaceDefaultUi":true,
    "removeStudio":true,
    "checks":["agent:check"],
    "rebuild":true
  }
}
```

- `files` 覆盖包内所有普通文件（含 DEPLOY.md、PROMPT.md、前端资源与设计依赖），仅排除 manifest 自身以避免循环哈希。`sha256` 用工具按最终文件字节计算，写成 64 位小写十六进制；不凭模型猜测、不复制示例零值。所有路径相对于包根目录，唯一且无绝对路径、`..`、符号链接或包外引用。
- `artifacts` 列各设计产物的版本、确认人、确认时间、来源与输入依赖；`inputs` 使用包内路径，均应能在 `files` 找到。已有确认信息取自真实阶段记录；候选样册不是单独确认对象时写 null，由 theme 的 inputs 指明选择来源。`version` 是文件族版本或轮次。
- `minimumVersion` 必须依据实际目标源码填写，不能以 Agent schemaVersion 或 app/package.json 的通用版本号代替所需能力验证。K2 / K4 未合并时注明依赖尚未满足，不虚构最低版本，不将候选包标成已可落地。涉及 description / starters 时也核对目标 schema 的支持情况。
- `landing` 只描述来源与固定动作，不存任意执行命令、钩子或任意目标路径。固定落地命令按经过校验的 agentId 推导 `app/agents/<id>/`，按 productId 推导 `app/design/<产品 id>/`，前端替换方式按 K2 约定；不能把模型给出的路径或身份当作权限依据。
- 候选包的确认状态为 proposed；先展示文件清单、自动检查结果和逐屏对照，再请用户继续确认、修改或结束。用户明确确认后新建下一版本包，除包版本与真实确认信息外保留候选内容；变更内容须重新确认。不能覆写旧 manifest，也不能把上游确认当作代码包确认。

## 完整 Agent 与前端

对照 `app/server/modules/agents/schema.mjs`、`app/agents/writing/agent.json`、`app/scripts/agent-check.mjs` 生成完整 Agent 配置，不只交配置草稿或页面计划：

- `agent.instructions` 指向随包提供的 `role.md`；`agent.skills`、`bindings.skills` 与实际 Skill 路径一致。
- description、starters 从资料卡和 PRD 推导；目标 schema 支持后写入相应字段。不支持时记录目标版本依赖与检查失败，不能擅改 schema，也不能删掉已确认的设计要求来宣称通过。
- `agent.workflows` 覆盖核心任务，按目标 schema 编写 steps、goal、writes 和 checks；PRD 要求人工确认的步骤用 `confirm: true`，引用实际存在的 Skill。
- `agent.tools.allow`、数据绑定、工作区、知识库与执行绑定只使用目标脚手架已有能力和授权范围。`agent.outputs` 按产品交付物声明目录、格式与 `writeMode: "create-only"`。不索要密钥，不读取或复制真实 .env。

Agent 自带前端的接入方式**按 K2 约定**。K2 合并之前不猜测 UI 注册字段、静态资源挂载路径或切换 API；可以生成 `ui/` 代码，并明确接入验证尚未完成。不得使用内联脚本和样式，不得引用外部资源：JS / CSS 分文件、只引用随包本地资源，事件用事件监听器绑定，不用内联事件属性、style 属性、CDN 或远程字体。遵守脚手架 CSP，不放宽策略来迁就原型；当前正式页面策略见 `app/deploy/Caddyfile`、`app/deploy/Caddyfile.edge` 和 `app/tests/web-static.test.mjs`。单文件要求仅用于 `design/` 的预览产物，不用于 `agent/ui/`。

从最终原型的 `design-outline` 逐屏实现并在 PROMPT.md 附对照表：屏幕 id / 状态、PRD FR / 故事、工作流步骤、真实接口、权限与确认点、复现方法、实现与验证结果。原型里的示例数据不能写死在前端里；业务数据来自实际接口，无数据时显示空态，失败时显示真实错误。模型内容用 `textContent` 呈现；HTML 产物使用签名预览与 sandbox iframe，不加 allow-same-origin。

### 前端现有接口（生成时仍须核对目标源码）

下表路径均为服务端实际路径，不加臆造的 `/api` 前缀。路由依据 `app/server/modules/http/index.mjs`；消息字段依据 `app/server/modules/messages/index.mjs`；浏览器调用参考 `app/web/app.js`、`app/web/modules/api.mjs` 和 `app/web/modules/artifacts.mjs`。

| 能力 | 方法与路径 | 调用要点 |
|---|---|---|
| 登录与身份 | `POST /auth/login`、`GET /auth/me`、`POST /auth/logout` | 沿用现有认证；业务请求带 Authorization，身份与权限由服务端认定 |
| 工作台 | `GET /workbench` | 读取 Agent、工作流与可用能力，不自行猜测配置 |
| 会话 | `GET /sessions?q=<检索词>`、`POST /sessions`、`POST /sessions/resume` | 创建使用 JSON 对象；恢复传 threadId；会话列表来自服务端 |
| 会话状态 | `GET /state?threadId=<id>` | 读取 session 与 queue 快照 |
| 消息 | `POST /messages` | threadId、clientMessageId、text、mode；可带 workflow、params、attachments。结果不明先核对，不能自动重发或换消息 id |
| SSE | `GET /events?threadId=<id>` | 用带认证的 fetch 读取事件流；沿用 api.mjs 的重连与 snapshot 恢复，勿用无法携带现有认证头的裸 EventSource |
| 工作流确认 | `POST /tasks/confirm`、`POST /tasks/revise`、`POST /tasks/cancel` | 传 threadId、taskId；修改另带 text；工作流提交仍走 /messages |
| 队列继续 | `POST /queue/continue` | 传 threadId，按用户明确操作继续 |
| 产物列表与内容 | `GET /workspace?path=<目录>`、`GET /workspace/read?path=<文件>` | 参数编码；使用现有工作区归属与只读接口 |
| 创建预览 | `POST /previews` | JSON 仅传 path；返回签名 url 和 expiresAt |
| 显示预览 | `GET /preview/<签名值>` | 使用返回的 url，不自行构造；服务端以签名验证身份、路径与内容哈希，配合 sandbox iframe |
| 上传 | `PUT /workspace/files?path=inputs%2Fuploads%2F<文件名>` | 原始文件体与匹配的 Content-Type，非 multipart；服务端校验扩展名与文件头，规则见 app/shared/uploads.mjs；上传成功后路径放入消息 attachments |

原型有而脚手架没有接口的能力，逐条写进 PROMPT.md 的**需要开发**清单，包含对应屏幕、缺失能力、预期输入输出、权限和验收场景。前端清楚显示该能力未接通，不能用模拟成功、写死数据或虚构接口假装实现；未完成项影响核心验收时，不宣称产品已完整可用。

## DEPLOY.md：本机落地 → 本机验证 → 部署到服务器

手册必须按以下顺序写，并区分已经验证和仍待验证：

1. **本机落地**：定位工作区中的 `outputs/design/<项目 id>/package-v<n>/`，核对清单与目标版本。在脚手架 `app/` 目录使用 K4 提供的固定命令，暂定 `docker compose run --rm land`，或 `npm run design:land`。包的选择 / 传参方式以 K4 实际命令帮助为准，不编造选项。K4 未提供时说明命令尚不可用，只停下落地步骤，不生成替代脚本。
2. **落地命令的职责**：校验代码包 → 放入 `app/agents/<id>/` → 用 `ui/` 替换默认前端（按 K2 约定）→ 保存设计记录到 `app/design/<产品 id>/` → 删除工作室 → 运行 agent:check → 重建并切换。全部由脚手架固定命令在本机完成，工作室不执行这些修改。中途失败要停下，说明失败步骤与人工核对方法，不自动重试；K4 负责已完成步骤的安全重入。
3. **本机验证**：在 app/ 执行 `npm run agent:check -- agents/<id>/agent.json`；确认真实登录、会话、消息、SSE、确认 / 修改 / 结束、产物、预览与上传流程符合 PRD，页面与已确认原型逐屏对照。确认工作室已删除、设计记录保留、新 Agent 页面已切换。静态检查通过不代表真实流程已通过，逐条列未执行项目。
4. **部署方式一——从本机远程部署**：在本机 app/ 执行 `npm run deploy -- --host root@<服务器地址>`（即 `npm run deploy` 入口，需配置 SSH 目标）。依据 `app/scripts/deploy.mjs` 与 `app/deploy/remote.sh`，它通过 SSH / rsync 部署当前本机 app/ 工作树，不要求先推 Git；说明所需本机 Node、Docker、SSH / rsync 与服务器条件，以仓库部署文档为准。
5. **部署方式二——用户自己的 Git 仓库**：先把本机已落地、验证过的产品代码及设计记录推到用户自己的 Git 仓库，不提交密钥。服务器检出该版本后进入 app/，以 root 或 sudo 运行脚手架现有的 `bash deploy/install.sh`。该脚本部署所在检出，不会替用户选择仓库或获取尚未推送的本机产物；系统要求和选项以 `app/deploy/install.sh` 为准。

设计记录保存在仓库的 `app/design/<产品 id>/`，落地后删除工作室；今后更深入的开发与改版由本地 Codex 或 Claude Code 结合这些记录继续。交付确认不是服务器部署授权，手册不能声称已经替用户部署。

## PROMPT.md：给本地 Codex 或 Claude Code

提示词写明包的实际位置、已确认版本、目标版本依赖、检查结果、逐屏对照，以及「需要开发」清单（没有缺口也明确写无）。提供可复制的任务说明：

> 先读 AGENTS.md，再读取这个代码包的 manifest.json、DEPLOY.md 和 design/ 中已确认的资料卡、PRD、原型及走查记录。核对文件清单、SHA-256、确认记录、目标脚手架版本，以及 K2 / K4 的实际支持情况。在本机 app/ 按 K4 帮助选择此包并运行脚手架自带的落地命令 docker compose run --rm land 或 npm run design:land。失败或结果不明先停下核对，不自动重试，不执行包内生成的宿主机脚本。核对 npm run agent:check -- agents/<id>/agent.json 的结果与真实产品流程。根据下方「需要开发」清单继续实现缺失能力，使用既有认证、归属与权限门禁；涉及已确认页面结构的变化先提出并等待确认。完成后使用 flow-walkthrough 的真实产品模式：先给走查计划，确认后实际运行、截图并收集反馈，修复后重新核对。设计记录位于 app/design/<产品 id>/，保留这些记录供后续迭代。

`build-from-design` 由 K5 提供，尚未提供时**不依赖**它完成以上步骤：本地编码助手直接读本包、核对固定落地命令、运行 agent:check，依据 PRD 验收场景完成需要开发项和测试，再读取 [flow-walkthrough](../flow-walkthrough/SKILL.md) 执行真实产品走查。K5 缺失不阻止这些已有步骤；K2 / K4 等实际接口或命令缺失则停止依赖它的操作并报告，不能伪称落地成功。生成 PROMPT.md 时按目标仓库给出 Skill 路径，不复制本文件的相对链接。

打包后校验完整文件清单与哈希、配置和资源引用、输入版本与确认记录、CSP 约束、逐屏实现情况，并展示实际自动检查结果。能运行 agent:check 时记录命令、退出码和检查项；不能运行时注明原因，不能把未验证标成通过。用户确认的是代码包内容、缺口、落地步骤及部署手册；生成结束不自动落地或发布。
