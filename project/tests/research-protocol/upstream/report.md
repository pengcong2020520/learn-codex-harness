# codex-harness 协议实测（Codex App Server 0.154.0）

日期：2026-10-08　执行：研究实验员　需求方：管家（评审追加范围）、AI PM

## 方法
- 全部用本地模拟模型（项目自带 `tests/responses-fixture.mjs` 思路），不需要 API key、不需要 PG。
- 只在我电脑上的项目副本 `/workspace/research-lab/codex-proto/project/` 跑，没碰冲少的 Mac。
- 脚本和原始结果：`/workspace/research-lab/codex-proto/`
  - 一键重跑：`./run-all.sh`；换版本回归：`./run-all.sh --cli <新版 codex.js 路径>`
  - 结果：`results-0.154.0.json`、`results-multi-0.154.0.json`、`results-ext-0.154.0*.json`
- 环境：8 核 / 16GB，Node 24。

## 结论一览

| 问题 | 0.154.0 实测 | 对项目的含义 |
|---|---|---|
| #24808 建会话后能否换工具 | **确认**。resume 时传新 dynamicTools 不报错、被静默忽略；旧 Thread 仍只看到老工具 | 走 dynamicTools 的工具中心做不了热插拔 |
| 换成 MCP 能否热插拔 | **能**。改 config.toml 的 MCP 配置 + `config/mcpServer/reload` 后，**同一个旧 Thread** 下一轮就看到新工具；调已删工具被 Codex 自己拒绝（`unsupported call`） | 工具中心热插拔应走 MCP；代价是 MCP 调用不自带 turnId，归属要靠多用户方案里的“按轮执行授权” |
| #35894 多连接广播 | **确认**。同一 Thread 被两个连接订阅时，`item/tool/call` 用同一个 request id 发给所有连接，**谁先回用谁的**（12/12）；发起方不回则采用另一连接的回复；订阅方断开、发起方又不回时 turn 挂住（见过 1 次） | 一个 Thread 只能有一个连接订阅 |
| 进程模型 | 共用一个 App Server 时**没有用户概念**：另一连接能收到 A 的 Thread 状态事件，能 `thread/list` 列出、`thread/read` 读取、`thread/resume` 订阅 A 的 Thread。每用户一进程：启动约 110–140ms、建 Thread 约 18ms、常驻内存约 192MB（含 node 包装进程） | 维持多用户方案“每用户一个进程、独立 CODEX_HOME”，别共用 |
| hooks 意外加载 | CODEX_HOME 下的 hooks.json 会被发现并列为启用，但信任状态是 `untrusted`，**一个都没执行**，PreToolUse 拒绝也没生效；工作区 `.codex/hooks.json` 连列都没列（项目层未信任）。加 `features.hooks=false` 后列表为空 | 默认不会绕过门禁；建议仍显式关掉，见下 |
| 插件意外加载 | `$HOME/.agents/plugins/marketplace.json` 会被发现，`INSTALLED_BY_DEFAULT` 的插件**没有自动安装、没启用**，插件技能和 MCP 工具都没进模型。加 `features.plugins=false` 后连市场都不列 | 默认不会绕过；建议显式关掉 |
| 技能意外加载 | **会**。`$HOME/.agents/skills`、CODEX_HOME/skills、工作区 `.agents/skills` 全被加载，外加 6 个系统技能（imagegen、openai-docs、plugin-creator、review-agent、skill-creator、skill-installer），名字都进了模型请求。关 hooks/plugins 开关不影响技能。逐个 `skills/config/write enabled=false` 后全部消失 | 项目的 `verifySkills` 每轮都做这件事并在漏网时停机，所以项目里是**已兜住**的；但它依赖每轮校验，裸启动 App Server 时会泄漏 |

## 其他测到的点
- 时序与门禁（20 轮）：0 次工具调用早于 turn/started，门禁 20 放 0 拒，无重复 callId。turn/start 的响应总是先于 turn/started 通知。
- 工具超时：30s 时 signal 准时中止（30001ms），模型收到“工具超时”，turn 正常结束。**但**超时只是中止 signal，不和 handler 竞速；不理会 signal 的工具会一直占着 turn，直到 600s 的 turn 超时才被中断。
- 中断：hung 工具时 interrupt 立即生效，不重发工具调用；晚到的回复被静默丢弃，连接不受影响，下一轮正常。
- 旧 Thread 调已删的 dynamic 工具：调用仍会到达 handler，handler 拒绝后 turn 正常结束，不挂。
- `tools.view_image=false` 在 0.154.0 **不生效**，模型仍看到 view_image；另外原生工具还有 create_goal / get_goal / update_goal / request_user_input。

## 反例、局限与争议
- 模拟模型只按脚本发工具调用，测的是协议行为，不代表真实模型会不会主动用这些技能或工具。
- 192MB 内存包含 node 包装进程，单看 Codex 本体会更低；并发多用户下的总量没测。
- #35894 的“谁先回用谁的”是在两连接都回复的条件下测的；“发起方不回、订阅方断开时挂住”只复现 1 次，算偶发风险。
- hooks“未信任就不执行”依赖信任按内容哈希记录：一旦有人在该 CODEX_HOME 里信任过某个 hook，它就会执行。项目每次启动会重写 config.toml，信任记录大概率被冲掉，但没专门验证。
- 真实项目启动时 `HOME` 继承运行用户的 HOME；我的探针用临时 HOME 隔离，所以“HOME 泄漏技能”在真实部署里取决于运行账号的 HOME 里有什么。

## 建议
1. 启动参数加 `-c features.hooks=false -c features.plugins=false`（一行改动，测过有效），并把 `HOME` 指到每用户隔离目录。
2. 工具中心热插拔走 MCP + reload；dynamicTools 只用于需要原生 turnId 归属的门禁工具。
3. 每用户一进程、单 stdio 连接、一个 Thread 只允许一个订阅者。
4. 工具超时改成和 handler 竞速（超时就直接回错误），别依赖工具自己响应 signal。
5. 每次升级 Codex 先跑 `run-all.sh` 做协议回归（view_image 开关失效就是这种静默变化）。
