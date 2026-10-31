# Demo1：单轮会话问答

在阅读与运行本阶段代码前，请先查阅[总览](../README.md)完成基础环境安装与配置文件准备。

## 设计原理

本阶段的核心目标是以最小代价打通宿主环境对底层模型的单轮调度。Node.js 运行时并不直接对接大语言模型的 HTTP 接口，而是作为编排客户端，通过标准输入输出（stdio）启动并管理本机 Codex App Server 子进程，使用 JSON-RPC 2.0 协议进行双向通信。

Codex 内部统一采用 Responses API 规范调用远端模型服务，因此仅具备基础 chat/completions 兼容性的接口无法直接适配。系统将交互生命周期划分为会话（Thread）与轮次（Turn）：Thread 代表持续会话上下文，Turn 则代表单次用户任务的处理过程。一个 Turn 内可能包含模型推理与多次工具调用的往返，其标识符由服务端生成且非递增编号。本阶段在运行时隔离状态存储目录，关闭长期记忆与原生通用工具，建立可验证的最小执行流程。

## 架构改进

作为演化序列的起点，Demo 1 建立了主控程序与执行引擎的解耦结构，规范了外部驱动的通信生命周期：

- 进程分层：[main.mjs](main.mjs) 仅作为执行入口，负责参数解析并调用 [05-app-server.mjs](05-app-server.mjs) 的启动逻辑，避免将流程管理与协议编排混杂。
- 目录与配置隔离：[runtime.mjs](server/modules/codex/runtime.mjs) 负责准备 `.runs` 运行目录并写入当次 `models.json`；`05-app-server.mjs` 设置独立的 `.data/codex` 原生状态目录，避免与个人 Codex 状态混用。
- 异步消息对齐机制：通过唯一的 JSON-RPC 请求 `id` 关联命令响应，同时建立事件监听机制处理服务端的单向通知。

调用链路关系如下：

Node 主进程 -> stdio JSON-RPC -> Codex 子进程 -> 远端模型服务

## 技术实现流程

整个单轮交互流程严格遵循顺序控制与状态收敛逻辑：

1. 配置就绪与生成：读取环境参数并由配置模块构建模型目录，`runtime.mjs` 将它写入 `.runs`；`05-app-server.mjs` 创建并设置本 demo 的 `.data/codex` 状态目录。
2. 进程挂载与握手：在 [05-app-server.mjs](05-app-server.mjs) 中通过 `child_process.spawn` 启动 Codex App Server，发送 `initialize` 方法并确认 `initialized` 通知，建立协议连接。
3. 会话开启：调用 `thread/start` 建立新 Thread，并注入系统预设的基础 `baseInstructions`。
4. 任务提交与监听：调用 `turn/start` 派发当前用户输入。由于由 `turn/start` 触发的事件通知可能在 RPC 调用结果返回前先一步到达 stdio，程序先暂存通知事件，待取得确认的 `turnId` 后再行匹配。
5. 结果收集与释放：等待 `turn/completed` 通知，提取模型回复文本，若遇到超时或未预期的中断状态则判定为失败。最终在 `finally` 块中关闭子进程，结束程序。

数据流向如下：

读取配置 -> 初始化目录 -> spawn 启动进程 -> initialize / initialized -> thread/start -> turn/start -> 匹配 turn/completed -> 输出完整文本 -> 关闭子进程退出

## 核心代码

以下代码为流程编排的核心逻辑展示，**不能直接执行**，完整实现请查阅源码文件。

```javascript
// 伪代码：省略参数与错误清理细节，不能直接执行
const launch = 读取配置并生成模型目录();
const rpc = 启动本机Codex并建立stdio连接(launch);
try {
  await rpc.request("initialize", 客户端信息);
  rpc.notify("initialized");
  const { thread } = await rpc.request("thread/start", {
    baseInstructions: 基础问答约束
  });
  // 先监听再请求：通知可能早于响应到达
  const tracker = 监听并暂存本Thread通知(thread.id);
  const { turn } = await rpc.request("turn/start", {
    threadId: thread.id, input: [{ type: "text", text: 用户问题 }]
  });
  tracker.绑定Turn并重放匹配通知(turn.id);
  const completed = await tracker.等待本轮完成();
  if (completed.status !== "completed") throw 本轮错误;
  输出整段回答();
} finally {
  await 关闭子进程();
}
```

## 运行与验证

在运行前，请按照以下步骤配置依赖与环境变量：

1. 进入目录并安装依赖：

   ```bash
   cd stages/s01-single-turn
   npm ci
   ```

2. 配置文件就绪：若当前目录下不存在 `.env`，从模板复制创建：

   ```bash
   cp .env.example .env
   ```

   编辑 `.env` 文件，填入 `CODEX_API_KEY`、`CODEX_BASE_URL` 以及 `CODEX_MODEL`，并核对模型能力配置项。

3. 配置本地校验：

   ```bash
   npm run check
   ```

   该命令仅校验本地配置格式与字段完整度，不会向模型服务商发起网络请求验证密钥可用性。

4. 启动单轮问答：

   默认运行（提示词为“只回复：App Server 已连接。不要调用工具。”）：

   ```bash
   npm start
   ```

   指定自定义输入：

   ```bash
   npm start -- "请用一句话介绍你自己"
   ```

   程序将在控制台一次性输出服务端返回的整段回答，并在完成任务后正常退出子进程（退出码为 0）。

5. 执行离线测试：

   ```bash
   npm test
   ```

   该命令运行测试用例以验证本地通信与解析逻辑。需要说明的是，离线模拟测试仅能断言状态转换与协议编排逻辑，不能视作真实远程模型生成质量与服务可用性的保证。当前系列未针对 DeepSeek 或 Google 端到端服务进行验证，示例参数不承诺适配所有服务提供商。

## 当前边界

- 单轮即停：程序未实现交互式输入循环，不包含 `/resume` 会话恢复机制，也不提供独立 HTTP 接口，单次执行完毕即终止。
- 输出机制：采用整段聚合后统一输出，不支持在终端进行逐 token 的流式打印。
- 记忆与工具能力受限：运行时明确设置 `features.memories=false`，未启用跨会话记忆提炼，但原生会话记录仍可持久化；内置搜索和通用执行工具关闭，调用远程模型仍需要网络可达。
- 工作目录检查：仅在应用层做基础路径安全性过滤，不构成操作系统级别的强隔离沙箱。

## 机制课程与逐课实验

本版配套机制课位于 [互动课堂](http://127.0.0.1:4320/course/#module-1)。在本目录运行 `npm run lesson -- list` 查看课时，运行 `npm run lesson -- <id>` 读取问题、执行验证并观察断言结果。依赖与验证边界见 [实验说明](lessons/README.md)。页面推演与终端运行结果分开展示。
