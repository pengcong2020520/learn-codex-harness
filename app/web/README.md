# 十二个阶段：教学与 Agent 外部客户端

在 `app` 目录执行 `npm run web`，访问：

- 课程：http://127.0.0.1:4320/course/
- 工作台：http://127.0.0.1:4320/

默认只监听本机。`WORKBENCH_PORT=4322 npm run web` 可更改端口。工作台默认打开「机制课堂」，「运行体验」保留对应版本的真实入口与服务状态。

机制课程源文件位于 `curriculum/lessons/sNN.json`（每个阶段一个数组文件）；执行 `npm run course:build` 提取真实源码并生成 `public/course/curriculum.json`，`npm run course:check` 检查内容及源码快照是否过期。构建时会校验文件名与阶段归属、真实阶段目录、源码路径与锚点唯一性、课时 ID 唯一性及课时与实验清单的一一对应关系。章节索引由 `chapters` 提供，只列有课时的阶段；新增阶段需补充 `build-curriculum.mjs` 中的名称与重点映射。

原先的 30 个长文单元保留在 `/course/handbook.html`，源文件仍在 `public/course/modules/`。运行 `npm run course:build` 会同时重建课程首页、机制课程数据和长文（模板 `_handbook.html` + `modules/*.html`）；`npm run course:check` 检查三者是否最新。长文的交互（测验、对话与流程推演、架构图、术语释义）都在 `handbook.js`，章节里不写内联脚本。

## 版本对应

| 版本 | 学习主题 | 工作台体验 |
|---|---|---|
| s00 | SDK 初体验 | SDK 脚本说明与教学模拟，无 HTTP |
| s01 | stdio、JSON-RPC、Thread / Turn | CLI 命令与单轮协议演示，无 HTTP |
| s02 | 多轮、顺序执行、resume 与原生历史 | CLI 命令与会话演示，无 HTTP |
| s03 | 常驻服务、忙时拒绝、状态轮询 | sessions / resume、POST /turns、GET /state；内存快照 + Codex 原生历史，本地索引辅助恢复 |
| s04 | 持久任务队列与 SSE | POST /messages、实时事件、暂停后核对继续；本地 JSON 保存任务 |
| s05 | Agent 定义、角色与 Skills | 独立 s05 服务与课程入口，复用队列与 SSE |
| s06 | 工具白名单、Schema / Registry、MCP、文件边界 | 独立 s06 服务；读取 /tools 实际状态与工作区文件 |
| s07 | 原生记忆与服务端控制 | 读取 /memory 的生效开关、摘要与生成限制；支持记忆不代表当前已启用 |
| s08 | PG 事务、outbox、Redis 唤醒、资源版本 | 首次读取 /workbench；资料页展示资源与版本信息 |
| s09 | 通用门禁、Wiki、Chroma + BM25 | 原文导入、维护任务、页面读取、知识搜索、索引任务 |
| s10 | Skill 与 Workflow | 目录来自 /workbench.agent.workflows；任务参数、确认与取消，Wiki 维护按任务授权 |
| s11 | 模型网关与路由 | 继承 s10 体验，网关仅静态说明；尚无 /models、/usage 的模型选择和用量查看界面 |
| project（app） | 当前开发项目，s11 内核 | 独立服务，Workflow 目录读取 /workflows |

新版主课程包含 s01–s09 共 24 节机制课、49 条正常/异常推演路径、24 道判断题，以及已发布课程阶段的 SVG 总架构图。按「问题 → 总图 → 概念 → 状态推演 → 源码与设计 → 实验 → 本节增量」组织。同一份课程数据用于工作台内嵌课堂与完整课程，避免两端解释不一致。s01 的运行体验另保留 7 个协议步骤的详细解读。

在有机制课的阶段目录运行 `npm run lesson -- list` 查看实验，运行 `npm run lesson -- <id>` 执行本节。离线入口使用真实模块和本地测试夹具；集成入口默认明确显示 NOT RUN，需显式参数才启动隔离的 PG / Redis 等依赖。具体命令与边界见每个阶段的 `lessons/README.md`，或课堂「动手实验」。前端按钮只复制命令，不在浏览器里执行 shell。

## 连接与操作

1. 按对应阶段的 README 配置模型和依赖，启动该目录的 `npm run server`；s00 使用 SDK 脚本，s01–s02 使用 CLI。页面也给出连接说明。
2. 在工作台选择对应版本，点击「重新连接」。桥接层从该目录的 `.data/connection.json` 获取连接，不复制其他版本的状态。
3. s03 起在「运行体验」新建或恢复会话、发送任务；s03 轮询状态，s04 起查看持久任务与 SSE 事件。s03 提交成功但刷新失败时只重读状态；提交结果未知时先刷新核对，再显式解除提交锁定。
4. s06 起在「资料与版本」读取文件，在「能力边界」查看实际工具名单与状态；s07 起查看实际记忆状态（默认关闭，后台合并可能受限）。s08 起检查资源 ID、版本、内容哈希及来源引用。
5. s09 起先执行 `npm run knowledge:init`，确保已挂载 KB 的目录存在。在「知识库」导入原文，再点击「维护 Wiki」；任务完成后回到知识库刷新、读取或搜索实际页面。s09 使用携带 knowledge 范围的普通任务；s10 起使用 knowledge-maintain Workflow，按 kbId 授权更新，任务结束授权失效并验收 Wiki 修订。
6. RAG 需要单独配置 Chroma 与 embedding。构建索引后，仍需修改 Agent 模式、重启服务并新建 Thread；按钮不会热切换模式。

「教学演示」只使用内置样例，不连接模型、不保存上传。「连接真实服务」使用现有服务；服务离线会显示启动说明，不伪装成功。

## 接入边界

`浏览器 → 本地 Web 接入层 → 既有 Agent HTTP/SSE → Codex / 数据与知识服务`

- 接入层仅代理固定阶段 / project 目标和有限路由，凭据留在 Node 端；浏览器使用内存管理的 HttpOnly / SameSite=Strict Cookie，同源检查保护写请求。
- Cookie 是本机浏览器连接状态，不代表已实现多用户认证。不要把端口转发或公开部署作为多用户方案。
- 数据仍使用对应版本的既有存储。工作台不复制 Codex 历史，也不新增一套模型执行循环。
- 原文导入使用服务端 operator 上下文，检查 KB 挂载和 update 权限；只接收 UTF-8 md/txt，单文件 ≤256 KiB，只创建不覆盖，不扩大 Agent 写 inputs 的权限。
- 文件写入与 PG 登记并非跨存储事务。登记失败会报告「未确认」，请读取核对，不应盲目重复上传。
- API 结果和文件正文以文本渲染，未经 HTML 执行。Wiki 列表最多 200 页，读取正文仍验证来源版本。
- s08 及以后阶段的 Compose 使用相同宿主端口，不能同时启动两套依赖；可以共享一套 PG / Redis，但使用各自数据库。

## 验证

- `npm run test:web`：本地桥接认证、同源、目标与路由白名单、SSE、静态文件隔离。
- `npm test`：项目既有自动测试。
- `npm run test:data`：隔离的真实 PG / Redis / Codex + 本地模拟模型；包含 Web 导入、维护、页面读取闭环及拒绝场景。可选 Chroma 测试在此命令中跳过。
- `node web/tests/ui-fixture.mjs`：在 4321 启动独立浏览器联调服务，上游和模型结果均为测试数据，停止后删除临时状态；不用于产品服务。

上一轮完整工作台验证记录见 `verification.json`，本轮教学改版记录见 `verification-teaching-20261008.json`。测试不代表真实模型内容质量或真实 embedding 语义质量已验收。

## 课程来源

长文的五章最初用 [zarazhangrui/codebase-to-course](https://github.com/zarazhangrui/codebase-to-course) 这个 Skill 生成。该仓库没有开源协议，所以长文阅读器的样式、脚本与页面模板（`handbook.css`、`handbook.js`、`_handbook.html`）已由本项目重新编写，不含来源代码；章节正文与课程模块均为本项目内容。

本轮教学方法参考 [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)，固定快照 `ce8f9f186058939da54c9d6fead78dfb5d0fd6c3`（MIT）。已逐章核对 s01–s17 的讲解和源码，采用“一节一个机制、正常与异常路径、最小实验和增量对照”的组织方法。24 节本地课程按 s01–s09 九个源码阶段组织，不表示已实现参考项目的 17 项功能；不会将其 Claude 执行循环搬入 Codex 脚手架。差异记录见 `curriculum/reference-review.md`。

课程链接支持 `/course/#sNN`；旧的 `#module-1` 至 `#module-5` 依次映射到 s01、s02、s05、s08、s09。工作台使用真实阶段 ID；s05 / s06 实验入口分别打开 s05 / s06。s00、s10、s11 尚无机制课，完整阅读器保留请求阶段并显示空态，project 对应 s11。旧工作台 demo1–5 依次映射到 s01、s02、s07、s08、s09；未知或缺省目标回落 s09。桌面 1280×900 下无需滚动即可看到十二个阶段和当前开发项目，窄屏导航支持横向滚动。
