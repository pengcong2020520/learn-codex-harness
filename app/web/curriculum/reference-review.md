# 从 learn-claude-code 到本项目的教学改版

参考仓库：[shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)。核对快照：`ce8f9f186058939da54c9d6fead78dfb5d0fd6c3`，日期 2026-10-08。

## 借鉴的组织方式

它先给一个可观察的问题，再加一项机制，让读者从源码和状态变化理解原因，最后运行实验。关键不是章节数量，而是每次能回答“这一层解决了什么，删掉会怎样”。

本项目保留五个运行版本，将其拆成 17 节机制课。每节有问题、核心概念、总架构、正常与异常推演、真实源码片段、设计取舍、实验与结果边界。工作台与独立课程共用一份构建后的课程数据。原有长文保留为扩展阅读。

## 逐章对应与边界

| 参考章 | 核心机制 | 本项目如何处理 |
|---|---|---|
| s01 Agent loop | 模型与工具往返 | Demo 1 学习与 Codex 的协议和生命周期；循环由 Codex 提供 |
| s02 Tool use | 工具规格与分发 | Demo 3 的 Schema / Registry / handler |
| s03 Permission | 执行前授权 | Demo 3 文件边界、Demo 5 通用门禁；可信身份由服务端注入 |
| s04 Hooks | 生命周期扩展点 | 借鉴前后检查的讲法；当前没有通用 Hook 插件系统 |
| s05 Todo | 当前工作计划 | 不混同于持久任务队列；当前没有新增 Todo 工具 |
| s06 Subagent | 独立上下文委派 | 当前未实现产品级子 Agent；不把 Thread/Turn 说成多 Agent |
| s07 Skill loading | 按需方法加载 | Demo 3 原生 skills/list 与 type:skill；不重写 load_skill |
| s08 Compact | 上下文压缩 | 原生上下文交给 Codex；未实现产品级压缩策略 |
| s09 Memory | 跨会话记忆 | 区分恢复、业务状态、知识与长期记忆；知识库不是原生记忆 |
| s10 Task system | 可恢复任务与依赖 | Demo 4 PG 任务与 outbox；没有把参考 JSON DAG 当成现有功能 |
| s11 Background tasks | 异步执行与通知 | Demo 4 Redis 唤醒 + PG 调度；不宣称独立任务自动唤醒模型 |
| s12 Cron | 定时任务 | 当前没有定时调度器，未加入运行版本 |
| s13 Teams | 多 Agent 协作 | 当前没有团队/信箱/租约式认领；多会话不等于多 Agent |
| s14 MCP | 外部工具协议 | Demo 3/4 使用真实本地 MCP；Demo 5 用原生动态工具绑定可信调用上下文 |
| s15 Integrated harness | 机制装配 | 五版总图先展示分工；产品层装配，Codex 保有原生循环 |
| s16 Workflow runtime | 计划约束与恢复 journal | 借鉴确定性状态与失败路径的教学；当前没有 DAG Workflow runtime |
| s17 Goal loop | 独立判断是否完成目标 | 区分协议终态、工具操作成功、目标质量；当前没有 Goal judge |

因此，两边都为 17 节，并不表示能力一一等同。Wiki、知识挂载、Chroma + BM25 等是本项目自己的教学主线。

## 读代码时校正的地方

参考仓库的课程网页、文章与代码并非处处一致。例如 s01 是否继续循环以实际 `tool_use` 内容为准；s14 是教学用 MCP mock；s17 是独立 Goal 示例，不是从 s16 继续叠加全部机制。实验结论应以所选源码快照和实际断言为依据。

本地课程构建器会按唯一锚点提取真实源码，保存文件哈希与行号。源码改变后 `npm run course:check` 会失败，要求重新构建和审查讲解。机制推演始终标注为内置样例；实验只有实际执行测试才报告通过，缺依赖的集成入口明确为 NOT RUN。

更细的核对记录见 [s01–s08](reference-s01-s08.md) 与 [s09–s17](reference-s09-s17.md)。
