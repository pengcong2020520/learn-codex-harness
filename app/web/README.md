# 五次进化：教学与 Agent 外部客户端

在 `app` 目录执行 `npm run web`，访问：

- 课程：http://127.0.0.1:4320/course/
- 工作台：http://127.0.0.1:4320/

默认只监听本机。`WORKBENCH_PORT=4322 npm run web` 可更改端口。工作台默认打开「机制课堂」，「运行体验」保留对应版本的真实入口与服务状态。

机制课程源文件位于 `curriculum/demo123.json` 与 `curriculum/demo45.json`；执行 `npm run course:build` 提取真实源码并生成 `public/course/curriculum.json`，`npm run course:check` 检查内容及源码快照是否过期。构建时会校验源码锚点唯一性、课时与实验对应关系。

原先的 30 个长文单元保留在 `/course/handbook.html`，源文件仍在 `public/course/modules/`。在 `public/course` 运行 `bash build.sh` 可同时重建长文、课堂首页及机制课程。

## 版本对应

| 版本 | 学习主题 | 工作台体验 |
|---|---|---|
| Demo 1 | stdio、JSON-RPC、Thread / Turn、事件缓冲 | CLI 命令与协议演示 |
| Demo 2 | 多轮、FIFO、resume、历史与记忆 | CLI 命令与会话演示 |
| Demo 3 | Agent 配置、Skill、Schema / Registry、MCP、文件边界 | 真实会话、任务、工作区文件、运行配置 |
| Demo 4 | PG 事务、outbox、Redis 唤醒、资源版本 | 上述功能 + 资源与版本信息 |
| Demo 5 / app | 通用门禁、Wiki、Chroma + BM25 | 原文导入、维护任务、页面读取、知识搜索、索引任务 |

新版主课程包含 17 节机制课、34 条正常/异常推演路径、17 道判断题，以及每版的 SVG 总架构图。按「问题 → 总图 → 概念 → 状态推演 → 源码与设计 → 实验 → 本节增量」组织。同一份课程数据用于工作台内嵌课堂与完整课程，避免两端解释不一致。Demo 1 的运行体验另保留 7 个协议步骤的详细解读。

在任一 Demo 目录运行 `npm run lesson -- list` 查看实验，运行 `npm run lesson -- <id>` 执行本节。12 个离线入口使用真实模块和本地测试夹具；5 个集成入口默认明确显示 NOT RUN，需显式参数才启动隔离的 PG / Redis 等依赖。具体命令与边界见每个 Demo 的 `lessons/README.md`，或课堂「动手实验」。前端按钮只复制命令，不在浏览器里执行 shell。

## 连接与操作

1. 按对应 Demo 的 README 配置模型和依赖，启动该目录的 `npm run server`；Demo 1 / 2 仍使用 CLI。页面也给出连接说明。
2. 在工作台选择对应版本，点击「重新连接」。桥接层从该目录的 `.data/connection.json` 获取连接，不复制其他版本的状态。
3. 在「运行体验」新建或恢复会话、发送任务，查看 Thread / Turn / Task 和实时事件。
4. Demo 4 起在「资料与版本」读取文件，检查资源 ID、版本、内容哈希及来源引用。
5. Demo 5 先执行 `npm run knowledge:init`，确保已挂载 KB 的目录存在。在「知识库」导入原文，再点击「维护 Wiki」；任务完成后回到知识库刷新、读取或搜索实际页面。
6. RAG 需要单独配置 Chroma 与 embedding。构建索引后，仍需修改 Agent 模式、重启服务并新建 Thread；按钮不会热切换模式。

「教学演示」只使用内置样例，不连接模型、不保存上传。「连接真实服务」使用现有服务；服务离线会显示启动说明，不伪装成功。

## 接入边界

`浏览器 → 本地 Web 接入层 → 既有 Agent HTTP/SSE → Codex / 数据与知识服务`

- 接入层仅代理固定 Demo 和有限路由，凭据留在 Node 端；浏览器使用内存管理的 HttpOnly / SameSite=Strict Cookie，同源检查保护写请求。
- Cookie 是本机浏览器连接状态，不代表已实现多用户认证。不要把端口转发或公开部署作为多用户方案。
- 数据仍使用对应版本的既有存储。工作台不复制 Codex 历史，也不新增一套模型执行循环。
- 原文导入使用服务端 operator 上下文，检查 KB 挂载和 update 权限；只接收 UTF-8 md/txt，单文件 ≤256 KiB，只创建不覆盖，不扩大 Agent 写 inputs 的权限。
- 文件写入与 PG 登记并非跨存储事务。登记失败会报告「未确认」，请读取核对，不应盲目重复上传。
- API 结果和文件正文以文本渲染，未经 HTML 执行。Wiki 列表最多 200 页，读取正文仍验证来源版本。
- Demo 4 / 5 的 Compose 使用相同宿主端口，不能同时启动两套依赖；可以共享一套 PG / Redis，但使用各自数据库。

## 验证

- `npm run test:web`：本地桥接认证、同源、目标与路由白名单、SSE、静态文件隔离。
- `npm test`：项目既有自动测试。
- `npm run test:data`：隔离的真实 PG / Redis / Codex + 本地模拟模型；包含 Web 导入、维护、页面读取闭环及拒绝场景。可选 Chroma 测试在此命令中跳过。
- `node web/tests/ui-fixture.mjs`：在 4321 启动独立浏览器联调服务，上游和模型结果均为测试数据，停止后删除临时状态；不用于产品服务。

上一轮完整工作台验证记录见 `verification.json`，本轮教学改版记录见 `verification-teaching-20261008.json`。测试不代表真实模型内容质量或真实 embedding 语义质量已验收。

## 课程来源

使用 GitHub [zarazhangrui/codebase-to-course](https://github.com/zarazhangrui/codebase-to-course)，快照 `ff8837ecf8e9f6ce9874ffa42e42633394a52a00`。长文阅读器的 `styles.css`、`main.js`、`_footer.html` 保留来源版本；`build.sh` 已调整为同时构建新版入口与长文。中文内容、课程模块、架构素材及 `course.css/js` 为本项目补充。快照未见 LICENSE；若对外再分发，需先确认来源授权。

本轮教学方法参考 [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)，固定快照 `ce8f9f186058939da54c9d6fead78dfb5d0fd6c3`（MIT）。已逐章核对 s01–s17 的讲解和源码，采用“一节一个机制、正常与异常路径、最小实验和增量对照”的组织方法。17 节本地课程围绕现有五版机制重新划分，不表示已实现参考项目的 17 项功能；不会将其 Claude 执行循环搬入 Codex 脚手架。差异记录见 `curriculum/reference-review.md`。
