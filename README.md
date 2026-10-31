# Codex Harness 新手集成与调试指南

先跑 `npm run hello`，再跑 `npm run fix`，就能从“发出任务”走到“Codex 修改文件并通过测试”。完整代码已放在本目录，不需要先下载、编译整个 Codex 仓库。

本文使用 JavaScript `.mjs` 文件，可以直接调用官方 TypeScript SDK，不需要先学习 TypeScript。除环境检查外，后面的命令均在项目根目录执行。

## 1. 核心概念与工作流程

* **大语言模型（Model）**：负责推理与决策，没有直接操作操作系统的能力。

* **Harness（宿主执行程序）**：运行在本地的代理程序，负责读取上下文、接收模型指令、调用本地工具（如读写文件、执行终端命令）、将工具输出回传给模型并控制执行权限。开源的 `openai/codex` 仓库包含这套本地 Harness 宿主代码，不包含云端大模型权重，运行 Harness 仍会消耗模型配额。

* **调用流向**：
```text
你的 JS 程序 -> SDK -> 本机 Codex
本机 Codex -> 请求模型 -> 执行模型提出的工具调用 -> 回传结果 -> 继续，直到完成
```

模型提出操作，Harness 负责执行。一个任务可能在内部多次调用模型和工具，具体循环见仓库的 [`run_turn`](https://github.com/openai/codex/blob/7784318b5f7fa35728d41ffa13e2a5821ebb4d75/codex-rs/core/src/session/turn.rs)。

## 2. 三种接入方式对比

| 方式 | 适用场景 | 底层机制 |
| :--- | :--- | :--- |
| CLI exec | 一次性脚本、CI/CD 与 Shell 流程编排 | 独立命令行进程，默认输出最终回答文本，启用 `--json` 后输出 JSONL |
| TypeScript SDK（本项目主线） | 后端业务集成、监听生命周期事件、获取结构化结果 | 原生 ES 模块导入，底层自动以 stdio 子进程启动本地 CLI，任务结束退出 |
| App Server | 桌面/Web 对话应用、流式增量输出、多会话并发管理 | 运行持久服务进程，基于 stdio 双向 JSON-RPC 协议通信 |

CLI 的脚本用法见[非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)。本项目推荐从 SDK 开始，之后需要自建对话界面时再读第 9 节。

官方目前也提供了 [Python SDK](https://github.com/openai/codex/tree/7784318b5f7fa35728d41ffa13e2a5821ebb4d75/sdk/python)，其底层连接 App Server（参见 [Codex SDK 官方文档](https://learn.chatgpt.com/docs/codex-sdk)）。

## 3. 环境准备与账号登录

本项目统一要求 Node.js >= 24（实测 Node v24.17.0，SDK 本身最低要求为 >= 18，>= 24 是本项目选定的版本边界）。

在 Mac 按 `Command + Space`，搜索“终端”并打开。先检查版本：
```bash
node -v
npm -v
```
预期结果：打印 Node 与 npm 的版本号；本机实测分别为 `v24.17.0` 和 `11.13.0`。如果提示找不到命令，到 [Node.js 官网](https://nodejs.org/en/download) 安装 24 或以上版本，重新打开终端。npm 会随 Node 一起安装。

进入已经准备好的项目目录：

```bash
cd <仓库根目录>
```

换一台电脑时，先复制或解压整套示例，再把上面的路径换成你存放项目的文件夹。

安装锁定依赖并登录：
```bash
npm ci
npx codex --version
npx codex login status
```

`npm ci` 按 `package-lock.json` 安装固定版本的 SDK 和 CLI，本项目都锁定为 `0.154.0`，不需要全局安装 CLI。若状态显示未登录，再运行 `npx codex login`，按浏览器提示登录；已经登录可以直接继续。

后续示例会使用账号可用额度。ChatGPT 登录和 API key 是两种使用方式，可用权限与计费以相应账号为准，见[官方认证说明](https://learn.chatgpt.com/docs/auth)。

运行环境自检：
```bash
npm run doctor
```
预期结果：输出 Node 版本、SDK 安装路径、CLI 版本以及保存的登录状态。此检查不调用模型。它检查的是已保存的 CLI 登录；只配置 API key 时，登录检查可能提示未登录，以 `npm run hello` 的实际结果为准。

## 4. 首次调用与核心代码

运行最小连接测试：
```bash
npm run hello
```
预期结果：终端打印“回答：Codex harness 已连接。”、“对话 ID：<UUID>”以及用量（usage）。亦可追加自定义问题：`npm run hello -- "用一句话解释 harness"`。

在项目根目录新建 `quickstart.mjs`，可使用如下最短代码测试（适用于 CLI 已登录状态）：
```javascript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: process.cwd(),
  skipGitRepoCheck: true,
  sandboxMode: "read-only",
  approvalPolicy: "never",
});

const result = await thread.run("只回复：Codex harness 已连接。不要调用工具。", {
  signal: AbortSignal.timeout(180000),
});

console.log(result.finalResponse);
```
运行 `node quickstart.mjs` 即可看到最终回复。

完整示例见 [01-hello.mjs](examples/01-hello.mjs)，它还包含错误提示与可选 API key 配置。

核心语句解析：

* `import`：把 SDK 里的 Codex 功能引入当前文件。

* `await`：等调用完成，再执行下一行。Thread 是一段对话，Turn 是你发出的一次任务及随后的执行过程。

* `new Codex()`：创建客户端实例，自动检测本地 CLI 与已保存的登录凭据。正式的 example 脚本支持通过 `.env` 读取 API Key，而极简调用直接复用 CLI 登录态。

* `codex.startThread(...)`：开启新会话（Thread）。`workingDirectory` 指定工作目录；`skipGitRepoCheck: true` 允许非 Git 仓库运行；`sandboxMode: "read-only"` 设置工具权限为只读，不允许模型工具写文件，但 Codex 自身仍可记录会话与日志；`approvalPolicy: "never"` 表示不请求额外批准，超出当前权限的操作不会通过弹窗获得授权。

* `thread.run(...)`：执行任务轮次（Turn）。通过 `AbortSignal.timeout(180000)` 设置 3 分钟超时；`result.finalResponse` 为多轮工具调用与推理收敛后的最终文本输出。

## 5. 代码修复实战与事件流

运行自动修复流程：
```bash
npm run fix
```
预期结果：输出测试由 3 项失败转为 3 项通过，且二次验收通过，并展示修复后的 `add.mjs` 内容。

执行机制（参见 [examples/02-fix.mjs](examples/02-fix.mjs)）：

1. 隔离目录：每次新建 `.runs/repair-<随机后缀>` 目录，将 [fixture/add.mjs](fixture/add.mjs)（含错误代码 `return a - b`）和 [fixture/add.test.mjs](fixture/add.test.mjs) 复制进去。原始 fixture 错误保留，保证每次独立复现。
2. 确认失败：在隔离目录下运行 `node --test`，确认 3 项加法测试处于失败状态。
3. 授权配置：设置 `sandboxMode: "workspace-write"`，允许模型修改工作区文件。
4. 下发任务并捕获事件：调用 `thread.runStreamed(prompt)` 下发指令，监听 `thread.started`、`item.started`、`item.completed` 与 `turn.completed`，并实时写入 `.runs/repair-*/events.jsonl`。JSONL 就是“每一行都是一条 JSON 数据”，可以直接用编辑器打开。
5. 独立二次验收：Codex 执行完毕后，外部脚本自行重新运行测试，并使用全文字符串比对验证测试文件未被修改，确保 3 项测试全部通过，最后生成 `.runs/latest-repair.json` 保存状态。

## 6. 多轮接续与结构化输出

恢复上一轮会话（需先成功执行过一次 `npm run fix`）：
```bash
npm run resume
```
预期结果：模型结合上一轮上下文，总结出修复了加法实现的 bug。亦可自定义追问：`npm run resume -- "刚才的测试覆盖了什么？"`。

原理解析（参见 [examples/03-resume.mjs](examples/03-resume.mjs)）：
脚本读取 `.runs/latest-repair.json` 中的 `threadId`，通过 `codex.resumeThread(threadId, ...)` 恢复会话。`threadId` 本身只是索引，多轮对话上下文实际依赖本地会话文件（默认保存在 `~/.codex/sessions`）。如果本地记录丢失，单凭 ID 无法恢复对话。

提取结构化 JSON：
```bash
npm run json
```
预期结果：终端输出格式化 JSON，并通过属性类型校验。

原理解析（参见 [examples/04-json.mjs](examples/04-json.mjs)）：
在 `thread.run` 参数中传入 `outputSchema` 约束返回字段。模型返回的 `result.finalResponse` 为合法 JSON 字符串，代码必须经过 `JSON.parse(result.finalResponse)` 反序列化后方可读取属性。JSON Schema 仅用于约束回复文本的排版格式，并非系统权限授权。

## 7. VS Code 断点调试与日志

1. 在 VS Code 选择“文件 → 打开文件夹”，打开整个 `<仓库根目录>` 项目，在 [examples/01-hello.mjs](examples/01-hello.mjs) 的 `const result = await thread.run(...)` 所在行左侧点击添加断点。
2. 在“运行和调试”面板选择配置 `1. 调试最小调用`，按 `F5`（部分 Mac 需 `fn + F5`）启动调试，程序停在断点处。
3. 按 `F10` 单步跳过。此时程序暂停，等待本机 Codex 子进程与云端模型完成计算；完成后可在变量面板查看 `result.finalResponse`、`items` 与 `usage`。
4. 观察事件流：选择配置 `2. 调试自动修复与事件`，在 [lib/common.mjs](lib/common.mjs) 的 `for await (const event of events)` 内打断点，按 `F5` 启动，每次停住时查看 `event` 变量，再按 `F5` 继续到下一个断点。每次重新运行示例都会实际调用模型。
5. 调试边界：JS 调试器仅支持观察本项目的 JS 变量与分发事件，无法在调试器中逐行查看 Rust 二进制执行逻辑或模型内部思考。查看工具执行细节可直接查阅 `.runs/repair-*/events.jsonl` 文件。

## 8. 项目接入与沙箱权限

接入自己的项目时，先改三个地方：任务文字 `prompt`、项目路径 `workingDirectory`、是否允许修改文件 `sandboxMode`。完整可运行的调用代码见 [02-fix.mjs](examples/02-fix.mjs) 与 [common.mjs](lib/common.mjs)。

参数说明：

* 运行环境：代码须在后端 Node.js 服务或本机终端运行，不可打包至浏览器前端运行（前端缺乏启动 CLI 子进程的系统能力）。

* `workingDirectory`：指定任务执行的工作根目录，但并不意味着工具只能读取该目录下的文件。

* `sandboxMode`：工具文件权限。`"read-only"` 禁止修改项目文件，适合只读分析；`"workspace-write"` 允许工具写入工作目录及配置允许的路径（含临时目录）。沙箱使用操作系统的底层沙箱机制，不能视为完全隔离的虚拟机。

* `approvalPolicy`：`"never"` 表示不请求额外批准，超出当前权限的操作不会弹窗获取授权，未授权操作直接受限。

## 9. 进阶：App Server 协议调用

用于构建桌面/Web 对话交互界面或处理增量文本输出。相关示例位于 [examples/05-app-server.mjs](examples/05-app-server.mjs)。此例使用 CLI 已保存的登录，SDK 的 `.env` API key 路线不适用于该例子。

握手测试（不调用模型，零配额消耗）：
```bash
npm run app-server -- --handshake-only
```
预期结果：输出“App Server 握手成功。”与日志路径。

只读问候测试：
```bash
npm run app-server
```
预期结果：以增量文本段（delta，不保证单字推送）流式打印问候语，并提示问候完成。

此例启动 `codex app-server --listen stdio://` 子进程，用标准输入输出传递每行一条 JSON，不需要开放网络端口。完整收发日志保存在 `.runs/app-server-*/protocol.jsonl`。

通信生命周期流程：
```text
initialize（请求） -> 响应 -> initialized（通知） -> thread/start（请求/响应） -> turn/start（请求/响应受理） -> item/agentMessage/delta（增量文本段） -> item/completed -> turn/completed（整轮结束通知）
```
调用 `turn/start` 仅代表请求已被服务器受理，必须持续监听直至收到 `turn/completed` 通知才代表整轮任务结束。官方目前将 App Server 标注为 experimental，完整产品还需自行补齐登录认证、权限审批流与断线恢复逻辑，详见 [App Server 协议文档](https://learn.chatgpt.com/docs/app-server)。

## 10. 故障排查、API Key 与实测记录

### 常见故障排查

| 故障现象 | 常见原因 | 解决方法 |
| :--- | :--- | :--- |
| `node` / `npm` 找不到命令 | Node 未安装或版本不合适 | 按第 3 节安装 Node 24 或以上，然后重新打开终端 |
| 模型不存在或无权限 | 自定义了不可用模型 | 检查 `.env` 的 `CODEX_MODEL`，留空使用 Codex 默认配置，或填写自己账号可用的模型 |
| 长时间无响应、连接失败 | 网络或账号额度问题 | 检查模型服务连接和账户额度；`hello`、`app-server` 固定 3 分钟超时，`fix`、`resume`、`json` 可在 `.env` 设置 `DEMO_TIMEOUT_MS` |
| 行为受个人配置影响 | 已有 provider、模型、MCP 等配置 | SDK 会复用 Codex 环境；先用 `npx codex` 定位，检查 `~/.codex/config.toml`，保留已有配置 |
| 目录不是 Git 仓库 | Codex 的仓库检查 | 示例已设置 `skipGitRepoCheck: true`；它只跳过检查，没有备份文件的作用 |
| `Cannot find package '@openai/codex-sdk'` | 依赖未正确安装 | 在项目根目录执行 `npm ci` |
| `Not logged in` / `401 Unauthorized` | CLI 登录凭据缺失或过期 | 执行 `npx codex login` 重新授权 |
| 写文件失败，提示被沙箱拦截 | 当前处于只读模式 | 将 `sandboxMode` 由 `"read-only"` 改为 `"workspace-write"` |
| `npm run resume` 报错找不到上一轮状态 | 未先生成修复记录 | 先完整执行一次 `npm run fix` 建立 `.runs/latest-repair.json` |
| 终端提示 `.env not found. Continuing without it.` | Node.js 原生加载提示 | 正常系统提示，使用已登录的 CLI 时无需配置 `.env`，忽略即可 |

### 可选：API Key 配置路线

若希望使用独立 API Key 替代 ChatGPT 账号登录（项目正式示例脚本支持读取 `.env`）：

1. 复制配置文件（仅在本地不存在 `.env` 时执行）：`cp .env.example .env`
2. 打开 `.env` 配置密钥：`CODEX_API_KEY=sk-你的真实APIKey`
3. 验证连通性：`npm run hello`（预期打印“回答：Codex harness 已连接。”与用量）。

密钥只填在自己电脑，不要发到聊天或提交到 Git；本项目的 `.gitignore` 已排除 `.env`。正式 SDK 示例通过 `new Codex({ apiKey: process.env.CODEX_API_KEY || undefined })` 传入密钥。需要自选模型时，在 `.env` 填 `CODEX_MODEL`；保持注释则使用已有 Codex 配置。

### 核心源码导读

读取的是 2026-09-15 的 main 快照 `7784318b5f7fa35728d41ffa13e2a5821ebb4d75`。源码快照和 npm 发布版本可能有差异，上面的运行验证使用固定的 npm `0.154.0`。

* 客户端入口：[`sdk/typescript/src/codex.ts`](https://github.com/openai/codex/blob/7784318b5f7fa35728d41ffa13e2a5821ebb4d75/sdk/typescript/src/codex.ts)

* 会话与事件聚合：[`sdk/typescript/src/thread.ts`](https://github.com/openai/codex/blob/7784318b5f7fa35728d41ffa13e2a5821ebb4d75/sdk/typescript/src/thread.ts)

* 子进程启动与通信：[`sdk/typescript/src/exec.ts`](https://github.com/openai/codex/blob/7784318b5f7fa35728d41ffa13e2a5821ebb4d75/sdk/typescript/src/exec.ts)

* 核心轮次执行循环：[`codex-rs/core/src/session/turn.rs`](https://github.com/openai/codex/blob/7784318b5f7fa35728d41ffa13e2a5821ebb4d75/codex-rs/core/src/session/turn.rs)

### 实测记录

`usage` 是 CLI 返回的原始用量统计。此版本续聊时可能包含会话累计值，不能直接当作本次新增用量；[统计实现](https://github.com/openai/codex/blob/7784318b5f7fa35728d41ffa13e2a5821ebb4d75/codex-rs/exec/src/event_processor_with_jsonl_output.rs)读取的是 `usage.total`。

实测记录：2026-09-15，macOS arm64，Node 24.17.0、SDK 与 CLI 0.154.0、ChatGPT 已登录方式，npm run doctor / hello / fix / resume / json / app-server 握手与真实问候全部实际通过。fix 中 3 项失败 -> 3 项通过，测试文件内容保持一致，resume 跨 Node 进程保留了修复上下文。API key 路线、Windows/Linux 和 VS Code 图形断点操作未在本次自动化测试中覆盖，VS Code launch 配置已预置。
