# s09–s17：从机制教材到本项目的取舍

本记录支持 `demo45.json` 的 8 个课题。参考固定为 [learn-claude-code / ce8f9f1](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3)。已逐节阅读 s09–s17 的完整 `README.zh.md` 与 `code.py`，并对照本地 Demo4/5 的数据、调度、知识库、门禁、Agent 绑定及测试代码。参考代码按 Python AST 识别重复函数，重复部分与已读原函数逐项一致；新增及变化部分单独逐段读取。没有运行参考的模型客户端，也没有复制其循环进入本项目。

当前写作采用宿主基于源码的原创撰写。根任务已尝试 gemini-doc-writer，agy 返回配额 429；本次没有重复调用。课程中的动画均为教学模拟；JSON 状态不是当前服务器实时数据。参考的实现事实、本项目已有实现和可借鉴的未来机制分别说明。

## 先学参考的组织方法

参考每节以一个新的约束推动一个最小机制，再讲调用路径、状态与取舍。适合本项目的重点是：让学习者看见“为什么现有办法不够”，再观察加入机制后哪条状态变化，最后用反例验证边界。

已阅读的网页实现包括 `useSimulator.ts`、`useSteppedVisualization.ts`、`agent-loop-simulator.tsx`、`source-viewer.tsx`、`design-decisions.tsx`、`s10-task-system.tsx`。它们提供三种不同的阅读方式：逐条显示消息、按步重绘状态面板、单独展开设计替代方案。s10 看板把依赖作为卡片上的 blocker，而不只画箭头；这一思路适合转成我们的任务、outbox、当前版本、有效模式状态格。

本次课题因此每节都有：具体问题、最小改动、Codex/产品责任、三个术语、因果机制、一个设计决策及代价、可追溯源码、正常与失败各四步、真实实验命令和迁移测验。不能只把步骤标题逐条亮起；事件必须解释为何改变状态，失败场景必须保留被拒绝前后的事实。本项目没有 Task DAG，所以不能照搬 s10 的并行看板并暗示多 Agent 调度已实现。

## s09 Memory：选择性保留，不是全量注入

参考：[说明与代码](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s09_memory)。关键实现：`should_store_memory`、`select_relevant_memories`、`extract_memories`、`consolidate_memories`。

问题是会话压缩或结束之后仍需保留稳定偏好和项目事实，却不能把本轮临时要求永远写进记忆。参考用 `.memory/MEMORY.md` 作目录，每个 Markdown 文件用 frontmatter 保存类型与描述。召回先让模型看目录与最近三条用户消息选择最多五项，再读取正文；提取从最近对话生成候选，代码继续检查 persistent 范围、类型、临时表达、空值和重复。合并前验证候选并保存原文件，失败回滚。文件路径限制阻止从 memory 目录越界。

可观察状态应是“候选→通过规则→已保存→本次被选中”，不能把“出现一段对话”画成“永久学会”。已存记忆是背景资料，当前明确指令仍优先。单独 s09 在本次 `agent_loop` 开始时召回；s15 通过 `update_context` 每轮更新，不能把两种时机混写。

代码校对发现：`extract_json_array` 在解析不到数组时返回 `[]`，`select_relevant_memories` 只有异常分支才执行 keyword fallback。因此“任何 JSON 解析失败都自动关键词召回”不是当前代码严格保证的行为。合并的文件回滚也不是并发事务系统。

本项目没有自行实现这套 Markdown 自动抽取/合并系统。早期版本调用 Codex 原生 memory 接口；Demo5 挂载 KB 时明确禁止有效原生 memory 开启。KB 的 Wiki/RAG 用受控原文与精确版本，不承担“从每段对话自动学会偏好”的职责。采用其生命周期讲法生成 `d4-versions` 和 `d5-modes`，不把长期记忆、Thread 历史、业务数据库、知识库当作同一存储层。

本地证据：`demo5/server/modules/agents/index.mjs::configure/activate/checkBinding`；`server/modules/memory/index.mjs`；`demo4/server/modules/data/resources.mjs::version/refreshSources`。

## s10 Task System：先有持久卡片，再谈依赖

参考：[说明与代码](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s10_task_system)。关键实现：`TaskStore`、`update_task`、`claim_task`、`complete_task`。

任务 JSON 保存 id、subject、description、status、owner 和 blockedBy。先创建节点取得 ID，再更新依赖；同一轮并列创建调用不能事先知道别的调用会得到什么 ID。更新前验证全部依赖、防自环和环路，避免“部分更新后才报错”。只有 pending、无未完成前置条件的任务能领取；完成要求 in_progress 且 owner 一致，随后下游可就绪。

单独 s10 没有并发锁，保存用 `write_text`；创建使用排他文件创建。`owner` 字段存在不等于多执行器领取已安全，更不等于团队运行时已经出现。s13 才加入线程锁/进程文件锁及原子替换等并发机制。

本项目的 `agent_data.tasks` 是用户消息队列，不是模型规划出的 DAG。顺序来自数据库 sequence，普通消息逐个启动 Turn，显式 append 另有语义。Demo4 的关键新增是事务内保存 task 和 outbox，以及条件领取和重启隔离未知结果。`d4-persistence` 借鉴“状态移出上下文”；`d5-wiki` 借鉴“转移必须具备可执行前提”，但绝不写成本项目已有 blockedBy。

本地证据：`demo4/server/modules/data/jobs.mjs::create/patch/recover`、`schema.sql::tasks/outbox`；`messages/index.mjs::dispatch`；`demo5/server/modules/knowledge/index.mjs::submit`。

## s11 Background Tasks：占位结果与完成通知是两次不同事件

参考：[说明与代码](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s11_background_tasks)。关键实现：`BackgroundManager`、`should_run_background`、`inject_background_results`、`execute_tool`。

`bash` 必须显式传 `run_in_background: true`，不靠命令关键词推断。宿主先登记任务，再启动 daemon thread，并给本次 tool_use 一个占位 tool_result；命令完成放入 ready 队列，之后用 task_notification 注入，不为原调用伪造第二个 tool_result。exit code 决定 completed/failed。前置权限发生在后台执行前；进程组清理是资源管理，不是安全沙箱。

单独 s11 只会在下一次模型调用前收集结果。模型已经返回并等用户输入时，任务完成并不会主动唤醒它；自动后台事件唤醒是 s15 整合后的行为。进程内字典也不能保证重启后找回运行中的 shell。

我们的 Redis 是 Thread 唤醒集合，没有后台任意 bash。`d4-dispatch` 用相同分层方法区分“通知到了”“PG 领取成功”“Turn 有终态”；Demo5 的索引 worker 是固定功能后台作业，不是具备自有推理上下文的子 Agent。

本地证据：`demo4/server/modules/data/queue.mjs::poll`、`jobs.mjs::recover`、`messages/index.mjs::executionError/bind/continue`；`demo5/server/modules/knowledge/worker.mjs`。

## s12 Cron Scheduler：到点、待投递、已被模型接收

参考：[说明与代码](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s12_cron_scheduler)。关键实现：`cron_matches`、`_enqueue_due_job`、`acknowledge_cron_jobs`、`queue_processor_loop`。

五字段 cron 使用本地时间；日期与星期均受限时采用 OR 语义。到点先保存 pending_delivery 与分钟标记，再放内存队列；持久写失败则撤回状态。空闲队列处理器在 agent_lock 内推动模型调用；失败恢复待投递，模型接收后才 ack。崩溃发生在接收与 ack 之间可能再次投递，所以是至少一次语义，不能声称恰好一次。

持久化的是计划和待投递状态，不是机器关闭期间仍在运行的时钟。离线错过的时间点没有自动补齐；需要进程常驻，跨进程关机唤醒需要 OS 或外部调度。异步线程无法进行终端交互确认，相关工具会拒绝。

本项目没有 cron 表达式调度或定时创建模型输入。RedisQueue 的 200ms poll 检查已有可投递工作，不是用户定时计划；knowledge worker 的 1s tick 同理。`d4-dispatch` 只学习“持久状态与临时投递分开”，不新增定时功能。

## s13 Agent Teams：长期队友需要协议与共享工作状态

参考：[说明与代码](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s13_agent_teams)。关键实现：`TaskStore` 的 locked mutation、`MessageBus`、`TeammateManager`、plan/shutdown 协议与 worktree 管理。

与一次性 s06 子代理不同，队友有自己的持续 messages、WORK/IDLE/终止状态；完成一项工作后等待消息，空闲时可扫描就绪任务。结果消息与 idle 通知含义不同。任务领取在锁内判断 pending、依赖与 owner，消息走文件 mailbox，lead 的单消费者处理协议并在 CLI 空闲时被消息唤醒。

计划批准不能用一句普通聊天替代：request_id、类型、发送者、目标、任务 ID、work_version 与 pending 状态共同限定有效响应，旧任务批准不能授权新分配。计划未批准会拦住特定写工具。可选 worktree 为任务绑定 cwd，损坏时拒绝执行而不是偷偷退回共享目录；释放与清理会检查活动任务、后台占用及脏文件。Git worktree 仍不是执行沙箱。

本项目没有 TeamLead、长期队友邮箱、plan_approval、shutdown handshake 或任务级 worktree 分配。多 Thread 可以各自有 Turn，不等于多 Agent 团队；一个本地执行器也不是队友池。JSON 中只借鉴“身份与具体执行版本绑定”，用于解释门禁旧上下文为何不能复用，不声称已实现团队协议。

## s14 MCP Plugin：工具发现和授权必须分开

参考：[说明与代码](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s14_mcp_plugin)。关键实现：`MCPClient`、工具名规范化、`assemble_tool_pool`、`MCP_HOST_POLICY`。

这一节从 s04 分支增加 MCP，并非线性继承 s13。代码的 MCPClient 是进程内 mock 注册表，以 docs/deploy 示例演示 tools/list、tools/call 的语义，没有真实网络传输。每轮动态组装工具及 handler；前一轮新连接的工具到下一轮才可见。名称加 namespace 并校验长度/冲突，绑定 lambda 时固定 server/tool，避免闭包引用最后一项。

外部 readOnlyHint 只是元数据。真正允许、拒绝或确认由宿主 policy 决定；未知工具不能因名字像只读就默认允许。该边界适合 `d5-mounts`：工具可见不等于所有资源可读。

本项目 Demo4 使用真实 MCP 传输和受限文件工具；Demo5 的代码路径 `ToolManager.configuration/dynamicTools` 在存在 gate 时提供 dynamicTools，RPC 回调按 Thread/Turn 找到可信上下文再调用同一 registry。审查时发现一条“新 Thread 只注册 MCP”的过时注释；根任务已同步修正 Demo5 与 project 的注释，课程以执行分支及集成测试为准。这里没有照搬参考的 mock 客户端。

## s15 Integrated Harness：整合会改变机制的组合边界

参考：[说明与代码](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s15_integrated_harness)。关键实现：`prepare_context`、`update_context`、`assemble_tool_pool`、`agent_loop`、`async_event_loop`、`run_subagent`、共享 `HOOKS`。

整合版围绕循环边界安放机制：接收用户输入，注入 cron/background/team 事件，准备上下文并召回记忆，组装工具，调用模型，执行权限及工具前后 hook，最后 Stop 与记忆提取。后台事件线程通过 agent_lock 推动对话，因此此时后台完成可自动唤醒。一次性 subagent 有独立 messages 和轮数限制并返回摘要；team 则持续运行。两者不能只因为都叫 agent 就合并解释。

上下文管理不是简单截字符串：工具大输出可落盘并保留预览；清理旧结果与自动摘要维护 tool_use/result 配对，用户真实请求独立保留；429/529、输出上限和 prompt-too-long 有不同恢复分支。摘要与记忆仍是不可信背景，不能覆盖当前请求。所有 shell 命令在主线程走交互确认，异步 shell 因无交互环境拒绝；这不能作为本项目需要向用户新加确认的依据。

整合不代表前节所有增强逐字保留：独立 s12 持久 last_fired，而 s15 `_last_fired` 是内存表；其 durable pending 逻辑也不同，不能把 s12 的细节无条件投射到 s15。s15 内置 TOOLS 实际为 26 项，说明中某汇总表写 25；应按代码核对数量，课程不依赖该数字。

本项目已有固定权限与事件处理，但没有暴露通用 UserPromptSubmit/PreToolUse/PostToolUse/Stop hooks 插件系统，没有自行实现 Todo、subagent/team 或上下文压缩循环；这些属于参考宿主机制，而当前 Codex 的推理和上下文循环仍由 Codex 承担。`d5-gate` 只采用统一边界检查的设计原则。

## s16 Workflow Runtime：计划变成受信代码，结果可按语义键复用

参考：[说明与代码](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s16_workflow_runtime)。关键实现：`WorkflowJournal`、`ExecutionState.agent/parallel/pipeline/workflow`、`WorkflowTool`、`run_workflow`、`install_workflow_tool`。

模型调用 Workflow 只传注册名称、args 与可选 run_id，不传可执行脚本；宿主从可信 WORKFLOWS 注册表选函数。`parallel` 是 gather 屏障，`pipeline` 则每个 item 内阶段串行、不同 item 并发，不要求全体完成阶段一才进阶段二。默认并发信号量为 8，run-wide agent 调用上限 1000，嵌套最多一层。schema 输出校验失败重试一次；真实 runner 无 shell/file 工具，只读给定输入。

run_id 用排他创建预留；跨线程与 POSIX 文件锁覆盖执行和持久化。恢复先验证 snapshot 的 workflowName、args 与 journal 记录，再执行脚本。journal key 来源于 kind、label、prompt、schema 的稳定哈希，不用并发完成序号；命中则复用结果并报告 cached。输入 prompt 改变应产生新键。journal flush 不是数据库事务，缓存也没有给外部任意副作用提供 exactly-once 保证。

两处教学边界：事件叫 async_launched，但 `WorkflowTool.call` 自身等待 script 完成，`run_workflow_sync` 通过 asyncio.run 阻塞到结果；不能根据事件名宣称主 agent 已自由继续。预算在调用返回、知道 token 数以后累计并判断，不是保证 API 在花费前绝不越预算的配额闸。schema validator 也是教学子集，integer 与 number 都接收数值，不应当作完整 JSON Schema 校验器。

本项目没有 Workflow 注册执行器、并行 agent 编排、journal resume 或语义结果缓存。RAG 构建只是固定管线，`d5-rag` 借鉴其“阶段、状态、提交、失败可观察”方法；暂存索引失败要重建，不宣称可从任意中间分块透明续跑。knowledge_jobs 运行中断会标 failed。

## s17 Goal Loop：一轮想停止，不等于目标证据齐全

参考：[说明与代码](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s17_goal_loop)。关键实现：`PromptGoalEvaluator`、`GoalController.evaluate_after_turn/restore`、`AgentSession._run_query`。

这是独立 AgentSession 分支，不继承 s16 的整合宿主。`/goal <condition>` 设置会话目标并立即开始工作；工作模型本轮没有 tool_use 时，独立、无工具的 evaluator 读取目标和对话中的工具证据，返回 ok/reason/impossible。未满足时把缺失证据作为新 user 消息送回同一上下文继续；无活跃 goal 直接放行。若后台尚未完成则 defer，收到背景结果后可恢复目标工作。

全局 max_turns 与连续 Stop 阻断上限是安全出口，不是目标自动完成条件；达到出口或评估器出错时仍保持 goal active。明确 impossible 则失败结束，ok 才成功结束。restore 能从 goal_status 事件重建活跃目标，但 CLI 没有实现持久 session 仓库，恢复计数与时间也会重新开始。评估器看的是经过字符预算保留的最近完整消息；它的判断不是确定性测试 oracle，模型声称通过且没有命令证据不该被当作可信测试通过。

本项目的 completed 只代表 Turn/任务流程终态，未实现独立 goal evaluator，也没有在无工具响应时自动继续追求用户目标。课程测验是确定性选项评分，不是运行时完成门禁。若未来增加 goal，应先定义证据、停止条件、预算与失败状态，不能只加“再想一遍”的循环。

## 必须区分的对象

| 对象 | 参考中的含义 | 本项目当前边界 |
|---|---|---|
| Todo | 短期计划/注意力清单，s15 含提醒逻辑 | 未实现产品 Todo 工具；tasks 不是 Todo |
| 持久任务 DAG | s10/s13 的依赖卡片与领取 | 未实现 blockedBy；PG tasks 是用户消息与执行状态 |
| hooks | 循环边界的可注册回调 | 有固定门禁/事件代码，无通用 hooks 插件平台 |
| subagent | 独立上下文、一次性执行并返回摘要 | 本项目没有自行实现此运行时；不把索引 worker 叫子 Agent |
| team | 长期队友、邮箱、任务协议与分配 | 未实现；多 Thread 隔离不等于团队 |
| cron | 到点形成输入并驱动模型轮次 | 未实现；Redis poll 是投递已有任务 |
| Workflow | 受信注册脚本、并发原语、journal | 未实现；RAG 是固定构建代码 |
| goal | 无工具时独立评估证据并阻止退出 | 未实现；任务 completed 不证明业务目标一定正确达成 |
| 普通 task | — | tasks：用户输入，进入 turn/start/steer |
| Wiki 维护 task | — | 同一 tasks 多一个已校验 knowledge 范围，仍由 Codex 撰写 |
| 索引 job | — | knowledge_jobs：独立 Redis key 与固定 worker 构建，不新开模型 Turn |

## 本项目落地与验证

`demo45.json` 包含 `d4-persistence`、`d4-dispatch`、`d4-versions`、`d5-gate`、`d5-mounts`、`d5-wiki`、`d5-rag`、`d5-modes`。每个 source.needle 在对应 Demo 源文件中唯一匹配，前后上下文由构建器从真实文件提取，课程没有手工伪造代码片段。64 个教学步骤使用同课一致状态键；所有 event 明示“教学模拟”。

本次局部实际执行：

- Demo4：`node --test tests/scheduling.test.mjs`，11/11 通过。
- Demo5：`node --test tests/agent-core.test.mjs tests/knowledge.test.mjs`，13/13 通过。
- JSON 的 8 个 ID、16 个四步场景、24 个概念、8 个测验答案范围、8 个唯一源码锚点均已检查。

这些局部测试是夹具与真实业务函数验证，不代表真实模型回答质量。JSON 中的 `npm run test:data`、`npm run test:rag` 命令已核对脚本：创建隔离临时 PG/Redis（RAG 另有 Chroma），使用本机模型/embedding 夹具，不读取 `.env`，不操作既有数据服务。本局部任务未重复运行整套基础设施验收，由根任务统筹；没有把未执行命令报告成已通过。
