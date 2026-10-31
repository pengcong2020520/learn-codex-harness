# s02：多轮会话问答

[总览](../README.md)（开始前请先查阅总览完成环境安装与基础配置）

## 设计原理

s02 的核心目标是从单次问答扩展到多轮持续对话。在交互模式下，系统需要处理长期会话与单次任务执行的层级关系，以及用户连续输入的节奏控制。

在设计上，Node 端不维护也无需向模型重发历史消息数组。多轮上下文由本地 Codex AppServer 原生持久化并管理。架构将交互清晰划分为 Thread 与 Turn：Thread 代表一个持续的会话，Turn 代表该会话中的一轮任务执行（包含用户输入与模型可能的多次内部工具调用）。同一 Thread 内的不同 Turn 分配独立的唯一标识，而不是简单的递增编号。

为了避免并发交互导致状态混淆，系统引入了先进先出（FIFO）输入缓冲队列，仅在当前 Turn 执行完毕后才提取下一条输入。该输入队列属于交互缓冲，并非重写底层 ReAct 机制。

## 架构改进

相比于 s01 单次执行即退出的模式，s02 增加了以下架构设计：

- 会话状态解耦：首条普通文本调用 `thread/start` 建立 Thread，后续输入调用 `turn/start` 复用已有会话；支持退出后通过 `thread/resume` 恢复交互。
- 本地状态索引：由本地存储维护会话元数据（ID、标题、预览摘要）的索引，用于快速检索会话，但具体的会话正文持久化仍由 Codex 原生完成，Node 客户端不自行压缩上下文。
- 异步通知隔离：为解决网络或进程事件早到的问题，通知缓存按 Thread 和 Turn ID 进行独立匹配，避免旧轮次的事件污染新轮次。

数据流向如下：

用户输入 -> FIFO 队列 -> thread/start 或 turn/start -> Codex AppServer（原生持久化上下文） -> 返回整段回答 -> 提取下一条输入

## 技术实现流程

1. 启动与建连：运行 [main.mjs](./main.mjs) 默认进入 `--chat` 交互模式，由 [05-app-server.mjs](./05-app-server.mjs) 启动本机 Codex 并通过 stdio 与它通信；[runtime.mjs](server/modules/codex/runtime.mjs) 准备运行目录与 catalog。
2. 会话初始化：用户首次输入普通消息时，系统发起 `thread/start` 请求创建 Thread，随后发起 `turn/start` 启动该轮任务。
3. 轮次等待与输出：客户端等待当前 Turn 结束并接收整段回答。此阶段不进行客户端流式打字拼接。
4. 会话恢复机制：输入 `/resume [关键词]` 检索历史会话的名称或开场预览；界面以数字列表展示匹配结果（最多每页 10 项，支持 `n`/`p` 翻页或 `/cancel` 取消），选定数字后调用 `thread/resume` 继续该会话。

## 核心代码

```javascript
// 伪代码：input.question 内部保留提前输入的 FIFO 队列
let threadId = null;
try {
  while (true) {
    const text = await input.question("你 > ");
    if (text === null || text === "/exit") break;
    if (text.startsWith("/resume")) {
      const selected = await 按关键词搜索并按数字选择();
      if (selected) {
        const { thread } = await rpc.request("thread/resume", {
          threadId: selected.id, baseInstructions: 基础问答约束
        });
        threadId = thread.id;
      }
      continue;
    }
    if (!text.trim()) continue;
    if (!threadId) threadId = (await 创建Thread()).id;
    // 内部先缓存通知、绑定 turn id，再等待本轮 completed
    await 提交一轮并输出回答(threadId, text);
  } // 上轮结束后才取下一条；不自行拼接历史
} finally {
  await 关闭输入和Codex连接();
}
```

## 运行与验证

进入目录并安装依赖：

```bash
cd stages/s02-multi-turn
npm ci
```

仅当 `.env` 文件不存在时从模板复制，并填入模型参数：

```bash
cp .env.example .env
```

在 `.env` 中配置 `CODEX_API_KEY`、`CODEX_BASE_URL` 与 `CODEX_MODEL`，并核实模型能力声明。随后执行静态检查：

```bash
npm run check
```

说明：`npm run check` 仅核验本地环境与配置项，不连接远端验证密钥有效性。

启动与上下文验证：

执行 `npm start` 进入命令行对话：

1. 输入：`记住本次会话的代号是蓝鲸`
2. 收到完整回答后，继续输入：`刚才的代号是什么`
3. 检查模型是否正确识别代号；这是实际模型的验收目标，不是预先保证的结果。此时日志显示两次交互对应同一个 Thread ID 与两个不同的 Turn ID。

此测试验证的是同一会话内的上下文连贯性，并非跨会话长期记忆。测试完毕后输入 `/exit` 退出。随后可通过再次启动并输入 `/resume` 按数字选择恢复会话。亦可执行 `npm test` 运行本地测试（模拟测试用于检查基础逻辑，不代表远端模型真实生成质量）。

## 当前边界

- 无独立 HTTP 服务：仅提供本地终端命令行交互界面。
- 无客户端流式拼接：回答在当前 Turn 完成后一次性输出完整文本。
- 未接入 MCP 协议：不支持通过 Model Context Protocol 发现与调用外部工具。
- 无特定业务角色：仅包含基础通用 role，未引入知识整理等业务角色配置。
- 无跨会话原生记忆沉淀：会话之间彼此独立，不具备跨会话自动提取与注入长期记忆的能力。
- 检索能力限制：`/resume` 仅基于名称、开场预览和 ID 进行基础匹配，不提供会话历史全文检索。

## 机制课程与逐课实验

本版配套机制课位于 [互动课堂](http://127.0.0.1:4320/course/#module-2)。在本目录运行 `npm run lesson -- list` 查看课时，运行 `npm run lesson -- <id>` 读取问题、执行验证并观察断言结果。依赖与验证边界见 [实验说明](lessons/README.md)。页面推演与终端运行结果分开展示。
