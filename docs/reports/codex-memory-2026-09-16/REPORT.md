# Codex Harness 记忆机制交叉验证报告

**报告日期**：2026-09-16  
**编制与核验**：Gemini CLI 起草，Codex 事实核验  
**核查性质**：记忆路径定向源码与协议审计（未执行端到端模型提炼实测）  
**面向读者**：略懂代码、已有 LangGraph Agent，希望理解和调试 Codex Harness 记忆机制的开发者

**一句话理解**：它像一个后台整理笔记的助手：从合格的旧对话里摘出经验，整理成文件；下次对话先看一小份目录，需要时再翻详细笔记。不是让模型永久改变自己的参数。

阅读建议：先看第 1、3、9、12 节理解结论；需要调试时，再查第 4—8 节及第 11 节的复现步骤。

---

## 1. 执行摘要

本报告回答一个与你的迁移直接相关的问题：把已有 LangGraph Agent 的执行核心换成 Codex Harness 后，哪些记忆能力可以使用，哪些仍要由自己的系统维护。重点是跨会话记忆；上下文压缩和同一会话恢复作为边界对照，不把它们当作同一个模块。

通过对 Codex 官方公开文档、开源 Harness 运行时 Rust 源码（0.154.0 发布标签与主分支跟踪切片）以及本地已安装工具链的定向代码审计与静态交叉核验，本报告得出如下核心事实：

1. **机制本质**：Codex 内置记忆（Memories）采用**主要分离的生成与读取路径**。在本地专用检索实现中，未发现嵌入向量（Embedding）计算或向量数据库检索，而是基于 Markdown 文件组织、本地 SQLite 任务状态追踪以及规范化的字符子串包含（Contains）匹配。
2. **触发与执行路径**：自动记忆生成既不是每轮对话结束后的同步写入，也不是系统后台常驻的固定定时器（如每隔 6 小时自动轮询一次）。其真实触发点位于请求处理流水线（`turn_processor.rs` [s40]）：**仅当客户端提交非空输入并成功开启新一轮交互（Turn）、且主执行环境已完成配置时，系统才尝试拉起后台异步记忆处理任务**。随后，启动检查模块（`start.rs` [s05]）进一步核验非临时会话、特性总开关、根智能体等前置条件。同一会话的后续有效轮次同样可能触发该流程，但单独创建空会话或仅调用 `thread/start` 不会触发。
3. **关键边界与约束**：
   - 特性总开关 `features.memories`（在源码特性表中标识为 `Feature::MemoryTool` [s37]）处于稳定阶段（Stable），但**源码默认值为关闭（`false`）**。
   - 自动提炼候选池具有严格的交互来源白名单（`INTERACTIVE_SESSION_SOURCES` [s09]），明确排除了单次命令式执行来源（`SessionSource::Exec` [s22]）。这意味着通过官方 TypeScript SDK 默认执行方式发起的任务，其会话日志不会被自动选为提炼候选。
   - CLI 终端界面（TUI）的实际行为与官方文档存在实质差异：文档称 `/memories` 仅作会话级选择且不改动全局配置，但 CLI TUI 源码证实该操作会通过批量配置写入（`write_config_batch` [s41]、[s42]）将修改持久化落盘至配置文件，并影响后续创建的会话。
   - 负责全局整合的合并智能体在受管权限（`PermissionProfile::Managed`）下具备工作区写入范围与命令网络限制；但若父级处于外部权限（`PermissionProfile::External`）或禁用权限（`PermissionProfile::Disabled`），将继承父级权限，**不存在无条件的物理沙箱与离线保证** [s07]。
   - 官方配置参考手册与源码之间存在两项关键默认值冲突（每次启动提取批次与候选会话有效年龄）。

---

## 2. 验证范围与证据等级

### 2.1 审查对象与版本基准

本报告所引述的证据严格锚定于以下来源与版本：

- **官方公开文档**：
  - [Memories 使用指南][s01]：聚焦于本地 Codex 运行时的记忆机制（涵盖客户端交互控制）。URL 中的 `surface=app` 仅为前端文档展示入口参数，不能据此推断存在一个 App 专用的独立云端后端。
  - [Config Reference 配置参考手册][s02]：官方配置项定义与说明。
- **本地项目环境与依赖**：
  - 项目依赖定义见 [package.json](../../package.json)，锁定 `@openai/codex=0.154.0` 与 `@openai/codex-sdk=0.154.0`。
  - 本地二进制通过 `node_modules/.bin/codex --version` 查询，确认为 `codex-cli 0.154.0`。
- **源码发布切片（Release Tag）**：
  - Git 标签 `rust-v0.154.0` 对应的实际代码提交为 `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`（提交时间 2026-09-09T14:43:48-07:00）。
- **主线跟踪切片（main HEAD）**：
  - 固定审阅提交为 `4701aa4b4239c70063ab6f2fcb835324f9c109f4`（提交时间 2026-09-16T12:09:50Z）。主线包含了演进中的第二代记忆架构（v2）实现。

### 2.2 实际执行的核验操作与明确边界

本报告明确区分静态检查事实与未执行的运行时测试：

- **已执行核验**：
  1. 对上述两个 Git 提交的 Rust 源码、提示词模板及 SDK 实现进行了只读文本审查与语义比对。
  2. 使用本地 0.154.0 二进制执行了 Schema 导出操作：`codex app-server generate-json-schema --experimental --out <DIR>`，完成了 RPC 协议定义核查（该过程不调用模型）。
  3. 执行了本地静态断言脚本，针对源码常量、状态机逻辑、SQL 查询及 JSON 规范进行了 **50 项无模型静态断言检查，结果为 50/50 全部通过**（该结果代表静态代码符合预期，不代表已运行 Rust 单测或端到端模型测试）。
- **未执行操作（非核验范围）**：
  - 未执行 Rust 单元测试套件或集成测试套件。
  - **未调用真实大模型**进行长期记忆的在线提炼、合并或跨会话召回验证。
  - 未接入第三方模型服务商进行网络通信与 JSON 格式容错实测。
  - 未实际操作桌面 App 界面，不将 CLI TUI 发现的配置落盘行为直接套用于桌面端。
  - 未读取或修改开发机用户根目录（`~/.codex`）下的已有私人记忆文件与认证凭据。

### 2.3 证据等级定义

正文采用自然叙述，并遵循以下五个事实等级：

1. **文档说明**：官方公共文档中陈述的对外规范或参数。
2. **代码确认**：在已审阅版本的 Rust 源码、SQL 语句或模板中明确存在的实现。
3. **本机无模型检查**：通过本地 CLI、Schema 导出工具或 50 项静态断言脚本验证的结构。
4. **工程推断/建议**：基于架构设计、上下文预算和状态机演进得出的工程实践判断。
5. **待运行验证**：逻辑自洽但必须在真实模型推理与隔离环境中经端到端测试方能确认的假设。

---

## 3. 概念边界与总体架构

### 3.1 初学者通俗解释与概念矩阵

对于正在使用 LangGraph 的开发者，容易把“短期交互状态”与“长期经验沉淀”混为一谈。在基于 Harness 构建智能体时，必须将五个层面的概念清晰切分：

- **模型上下文（Context Window）**：大模型当前轮次推理的瞬时工作台。其容量受模型物理窗口限制，达到配置或模型对应的阈值时可触发上下文压缩（Compaction）；并非一定等到窗口溢出。
- **会话持久化（Thread Persistence）**：记录单次会话完整交互过程的原始日志（Rollout Logs，存为 JSONL 格式）。用于支持会话恢复（Resume）与追溯调试。
- **长期记忆（Long-Term Memories）**：从多个历史会话中提炼沉淀的高价值经验、偏好与操作事实。以纯文本 Markdown 组织，供后续新会话按需检索。
- **项目行为规则（如 AGENTS.md）**：开发者显式提交的代码仓库工程规约。作为确定性上下文规则输入给智能体，但其涉及的系统权限仍须由业务代码与沙箱硬性约束。
- **业务主数据库（Business Truth DB）**：存储订单、用户资料、权限等强一致性核心数据的系统。必须由业务系统自行维护，绝不可由具备概率漂移特性的 AI 记忆充当权威数据源。

| 概念层次 | 存储介质 | 存储格式 | 更新驱动力 | 在 Codex 中的定位 |
| :--- | :--- | :--- | :--- | :--- |
| **模型上下文** | 内存 / API 载荷 | JSON 消息数组 | 每轮消息交互追加与压缩 | 单轮模型调用的临时上下文 |
| **会话持久化** | 本地文件（`sessions/`） | JSONL 原始流 | 用户与工具的每次输入输出 | 单个 Thread 的完整追溯历史 |
| **长期记忆** | 本地磁盘 + SQLite | Markdown + 关系表 | 后台提取与合并流水线 | 跨会话沉淀的全局经验库 |
| **项目行为规则** | 代码仓库文件 | Markdown（`AGENTS.md`） | 开发者显式编辑代码仓库 | 显式项目指引（非物理沙箱） |
| **业务事实库** | 外部数据库 | 关系型/文档型存储 | 业务应用代码事务提交 | 企业的业务真相数据底座 |

### 3.2 生成与读取流程

Codex 记忆系统通过生成与读取两条主要分离的流程实现闭环：

```text
【生成流程】
用户在交互客户端提交非空输入 
  ──> turn_processor: start_or_steer_turn 启动新轮次
  ──> turn_has_input && started 且主环境就绪
  ──> 触发 start_memories_startup_task (后台异步)
  ──> start.rs 校验前置条件 (非临时、特性开、根智能体、DB正常)
  ──> 扫描并认领历史会话 (过滤 Exec、过滤归档、过滤污染、核验闲置时间)
  ──> Phase 1: 单会话提取 (严格 JSON Schema 输出摘要)
  ──> 存入 SQLite stage1_outputs 表
  ──> Phase 2: 全局合并 (DB 租约防并发、Git 基线比对改动)
  ──> 合并智能体产出 Markdown 产物 (v1: memory_summary.md / MEMORY.md)

【读取流程】
新会话启动且 features.memories=true、use_memories=true
  ──> 读取当前记忆版本目录下的 memory_summary.md
  ──> 施加约 2500 tokens 估算预算截断
  ──> 作为 developer 角色提示词片段注入上下文
  ──> 模型根据任务需要决定是否进一步检索详细文件 (Agentic File Retrieval)
  ──> 回复中输出引用标签 (<oai-mem-citation>)
  ──> 运行时解析标签并递增 SQLite 中的引用计数与使用时间
  ──> 反馈影响后续 Phase 2 的保留与淘汰筛选
```

---

## 4. 生成机制深入解析

### 4.1 真实触发点与前置检查链

在代码实现中，“启动根会话”并不等同于“立刻无条件触发后台提炼”。真正的调用发起点位于请求处理模块 `codex-rs/app-server/src/request_processors/turn_processor.rs` [s40]：

1. 客户端发起请求进入 `turn_processor`，执行 `start_or_steer_turn`。
2. 仅当满足三项核心判定时，系统才会调用 `start_memories_startup_task`：
   - `turn_has_input == true`：即 `params.input` 包含非空内容；
   - `started == true`：必须为全新开始的轮次（若会话处于被转向引导的 `Steered` 状态，不计为 `started`）；
   - `config_snapshot.is_primary_environment_configured()`：主执行环境已正确配置就绪。
3. 进入 `memories/write/src/start.rs` 中的具体实现 [s05]：
   - 会话非临时（`config.ephemeral == false`）；
   - 特性总开关已开启（`features.memories == true`）；
   - 当前会话发起者非子智能体或衍生任务（必须为根智能体）；
   - 状态数据库连接正常。

因此，**主触发路径是“收到有效输入、成功开始新一轮交互、且主环境已配置”**。同一会话内的后续交互轮次若满足条件同样可能触发后台检查；单独创建一个空会话或仅调用 `thread/start` 并不足以触发记忆处理。该任务以异步后台方式运行，不阻塞当前轮次向用户返回响应。

这也意味着：触发后台任务的当前会话，不保证马上读到这一次刚整理出的记忆。调试时应先确认文件生成完成，再用新的会话检查召回。

### 4.2 配置项分层与作用范围

系统将“功能发布标记”与“用户功能配置”分层管理：

- 在 `features/src/lib.rs` 中，`Feature::MemoryTool` 处于稳定阶段（Stable），但其硬编码默认值为 `false` [s37]。
- 在配置结构体 `MemoriesConfig` 中，`generate_memories` 与 `use_memories` 的结构体反序列化默认值均为 `true` [s03]、[s04]。

其生效逻辑为：**只有生效配置中的 `features.memories = true` 时，下层的生成与使用逻辑才可能生效；可由配置文件或支持的配置覆盖入口设置，不限于全局文件**。当总开关关闭时，后台处理流水线根本不会启动。

此外，各细分开关具有精确的作用范围：

- `generate_memories = false`：仅控制新创建的会话在初始化时将其自身的元数据标记为 `memory_mode = 'disabled'`。它不会直接取消当前正在执行中的后台提取任务，也不会使现存的记忆文件失效。在历史遗留的已启用会话中，后台仍可能继续处理旧数据。
- `use_memories = false`：控制在新会话初始化时，不向 developer 提示词片段注入记忆摘要，且不暴露专用记忆工具。这属于消费端组装控制，并不构成文件系统的权限隔离，也不会物理删除磁盘上的任何文件。

### 4.3 候选会话白名单与认领条件

能够触发后台任务的会话，与能够作为提炼素材的候选会话，属于两个不同的筛选逻辑。

当后台任务启动后，系统在状态数据库中扫描历史会话。候选来源必须严格匹配 `codex-rs/rollout/src/lib.rs` 中通过 `LazyLock` 声明的交互来源白名单 `INTERACTIVE_SESSION_SOURCES` [s09]：

```rust
// 来源：codex-rs/rollout/src/lib.rs；依赖该文件已有的 import
pub static INTERACTIVE_SESSION_SOURCES: LazyLock<Vec<SessionSource>> = LazyLock::new(|| {
    vec![
        SessionSource::Cli,
        SessionSource::VSCode,
        SessionSource::Custom("atlas".to_string()),
        SessionSource::Custom("chatgpt".to_string()),
    ]
});
```

该白名单**明确排除了命令式单次调用来源 `SessionSource::Exec`** [s22]。

候选会话还必须同时满足以下条件 [s08]：

1. 非当前正在交互的会话 ID；
2. 处于未归档状态（`archived_only = false`），且满足非空会话预览等共享查询条件；
3. 会话的记忆模式严格为启用状态（`memory_mode == 'enabled'`）；
4. 会话最后活跃时间（`updated_at`，非创建时间）在配置的最大有效天数之内（默认 10 天）；
5. 会话处于闲置状态的时间达到冷却阈值（`min_rollout_idle_hours`，默认 6 小时，代码强制钳制在 1 至 48 小时区间）；
6. 满足更新水位与作业租约条件：尚未提炼，或源会话在上次提炼后更新；失败重试另受退避限制。

**关键隔离边界**：会话认领逻辑**没有按当前工作目录（`cwd`）或代码项目进行限定**。若在同一宿主机用户目录下运行不同项目的交互会话，只要满足上述时间与模式条件，都会被纳入同一个记忆池中进行统一提炼。

### 4.4 外部上下文污染判定机制

为了防止不可信的第三方数据混入长期记忆，系统提供了配置项 `disable_on_external_context`（旧版别名 `no_memories_if_mcp_or_web_search`，默认值 `false`）[s03]、[s04]。

当该开关开启时，若检测到会话中执行了网络搜索或产生了受判定的外部工具输出，系统会把当前会话标记为受污染状态：

```sql
-- 来源：codex-rs/state/src/runtime/memories.rs
UPDATE threads SET memory_mode = 'polluted' WHERE id = ?;
```

由于 Phase 1 提取严格限定 `memory_mode = 'enabled'`，被标记为 `polluted` 的会话将失去后续提炼资格。

*注：并非所有 MCP 工具调用都会被无差别标记为污染。在 MCP 扩展实现中，包含 `prepared_call.server_pollutes_memory()` 的服务端配置核验，允许存在不引发污染标记的例外通道 [s44]。*

### 4.5 Phase 1：单会话提炼与结构化输出

Phase 1 负责对单个候选会话的原始记录（Rollout）进行提炼 [s06]：

- **输入装载与清洗**：解析会话日志时，系统在 `rollout_input.rs` [s24] 与 `phase1.rs` [s06] 中执行了输入净化：**明确过滤掉 `developer` 角色消息，并过滤完全包裹的 `AGENTS.md` 规则与技能上下文片段**。这样能有效避免提炼模型将系统设定的工程规范误当成用户的个人习惯或技术偏好。
- **敏感信息脱敏**：输入给模型的内容以及模型生成的输出，均经过 `redact_secrets` 脱敏逻辑处理 [s06]、[s24]。该脱敏属于规则模式替换，在工程上不能视为绝对无泄漏的安全凭据保护。
- **Token 预算**：默认按提炼模型有效输入窗口的 70% 规划提炼内容；在模型元数据缺失时，代码预设了 150,000 tokens 的兜底值（并不保证适配每个第三方模型）（Fallback）[s06]。
- **并发与批次控制**：Phase 1 内部最大并发任务数为 8，单次扫描深度最高 5,000 条，作业租约过期保护为 1 小时；配置项 `max_rollouts_per_startup`（默认值为 2）定义了单次后台触发实际认领的最大批次上限。
- **结构化输出约束**：调用提炼模型时，强制采用严格结构化输出模式（Strict JSON Schema）[s23]。模型根据指令 [s38] 提炼高价值偏好、显式纠正与经过验证的操作事实；若判定该会话无长期复用价值，允许返回空内容。

### 4.6 Phase 2：全局合并与沙箱边界

Phase 1 产出写入 SQLite `stage1_outputs` 表后，Phase 2 启动全局整合流程 [s07]：

1. **获取全局租约**：依靠 SQLite 数据库支持的全局作业租约（Lease）协调同一记忆库的合并作业 [s08]。
2. **多维选拔与资格复核**：函数 `get_phase2_input_selection` 默认选取最多 256 个有效条目（配置上限可达 4,096）[s08]。排序规则为：
   - 优先依据引用计数（`usage_count DESC`）；
   - 其次按 `COALESCE(last_usage, source_updated_at) DESC`：使用过则取使用时间，否则取源会话更新时间；
   - 再以 `source_updated_at DESC`、`thread_id DESC` 作为后续排序条件。候选还须处于 `max_unused_days` 保留窗口内。
   - **资格核验**：除时间与频次外，系统调用 `enabled_thread_metadata` 复核源会话的当前状态，**要求源会话当前的 `memory_mode` 仍必须为 `enabled`**。这意味着一旦某会话后续被标记为 `disabled` 或 `polluted`，它在下一次 Phase 2 将失去输入资格，进而通过文件同步与合并完成淘汰。
3. **工作区同步与 Git 基线比对**：将选中的会话摘要同步写入磁盘，物理移除不再入选的摘要；随后利用记忆目录内置的 `.git` 本地仓库执行增量比对（Diff）[s16]。若比对无实质变化且产物完整，**直接跳过模型推理**以节约成本。
4. **运行合并智能体**：若存在实质变更或产物无效，派生内部智能体执行合并；通过产物检查后更新成功基线与消费状态。格式检查不等于内容正确性检查。即使本轮 Phase 1 没有新结果，也可能因便笺或扩展变更进入 Phase 2 [s07]、[s39]。

#### 合并智能体的权限继承与例外

合并智能体由父级配置克隆而来，关闭了 MCP、外部应用、递归多智能体及自身记忆循环，交互确认设为 `AskForApproval::Never`。

其权限隔离边界取决于父级环境配置 [s07]：

- **仅当**父级环境处于受管权限（`PermissionProfile::Managed`）时，合并智能体的工作区写入权限才会被硬性限制在记忆根目录下，并将命令行工具网络访问设为禁用（`network = false`）；
- **如果**父级环境被显式配置为禁用权限（`PermissionProfile::Disabled`）或外部权限（`PermissionProfile::External`），代码将**完整保留其权限模式**。

因此，工程上**不能断言合并任务“始终运行于封闭沙箱且绝不联网”**。同时需注意，`network = false` 仅限制智能体执行命令行工具时的外部网络访问，并不阻断智能体向大模型供应商发送推理请求的 API 流量。

---

## 5. 存储与读取机制

### 5.1 存储分层与目录组织

Codex 记忆系统采用“文本文件承载语义内容，SQLite 管理状态与索引”的双轨持久化机制。在 v1 架构中，物理存储默认位于 `~/.codex/memories/`，其典型布局如下：

```text
~/.codex/memories/
├── memory_summary.md                    # 知识索引与全局摘要（新会话注入此文件）
├── MEMORY.md                            # 详细全局知识手册（供智能体后续定向查阅）
├── raw_memories.md                      # Phase 1 各会话提炼事实的合并汇总文件
├── rollout_summaries/                   # 单会话提炼摘要存档目录（纯 Markdown 文本，非原始 JSONL）
│   ├── 2026-09-10-auth-setup.md         # 示意文件：记录特定会话的提炼摘要
│   └── 2026-09-12-test-fixtures.md
├── skills/                              # 合并智能体可选产出的程序化辅助脚本（非正式安装技能）
├── extensions/
│   └── ad_hoc/
│       └── notes/                       # 存放显式纠错或偏好便笺文件
│           └── 2026-09-16T12-00-00-preference.md
├── .git/                                # 本地 Git 仓库（仅作为增量比对基线，非远端同步）
└── phase2_workspace_diff.md             # 合并过程产生的临时增量补丁（成功后清理）
```

在系统运转中需明确以下几点：

- `rollout_summaries/` 存放的是由提炼流程生成的纯 Markdown 摘要文件，而原始交互日志完整保存在 `sessions/` 目录下。摘要文件中通过 `rollout_path` 字段指向原始日志。
- 记忆运行同时依赖通常位于配置主目录下、实际位置由 SQLite 配置决定的数据库（如 `state_5.sqlite`（会话元数据）与 `memories_1.sqlite`（提炼结果、作业与使用统计）[s08]、[s32]）。单纯迁移 Markdown 文件而丢失数据库，会导致会话模式判定与引用统计失效。
- `.git` 用于对比上一次成功合并的基线，不应当作永久审计历史或已经启用的远程备份；它不会自动把记忆推送到 GitHub。

### 5.2 读取扩展与提示词注入

当开启记忆特性且 `use_memories = true` 时，新会话启动时将挂载记忆读取扩展 [s10]：

1. **摘要加载**：尝试读取当前生效版本目录下的 `memory_summary.md`。若文件不存在或内容为空，则不注入任何内容。
2. **Token 预算截断**：为限制额外的上下文占用，系统对读取的内容施加了**约 2,500 tokens 的近似估算上限截断** [s11]、[s34]。
3. **注入位置与角色**：截断后的文本被封装在带有结构化标记的文本中，作为 **`developer` 角色提示词片段**注入至系统上下文中 [s11]、[s12]。

**架构提示**：尽管 `memory_summary.md` 作为 `developer` 角色片段注入，但这纯属代码实现的上下文组织形式，并不意味着其中的内容具备不受质疑的安全权威性。其内容终究源自历史模型归纳，系统对高风险业务操作依然应交由业务代码与沙箱强制校验。

### 5.3 智能体驱动的文件检索

依据读取路径规范（`read_path.md` [s12]），初始化注入路径不会自动加载全量历史或整个 `MEMORY.md`；读取提示词要求按需查阅。智能体采用**自主文件检索（Agentic File Retrieval）策略：先阅读 `memory_summary.md`，遇到特定历史问题时再按需查询 `MEMORY.md` 或读取 `rollout_summaries/`。

工具暴露由配置项 `dedicated_tools`（默认 `false`）决定 [s03]、[s04]：

- **通用工具模式（`dedicated_tools = false`）**：
  不注册专用记忆工具。提示词引导智能体使用标准的文件与目录命令（如查看文件、列表、正则匹配等），直接查阅记忆目录下的文件。
- **专用工具模式（`dedicated_tools = true`）**：
  向运行时注册 `memories` 专用工具集 [s33]、[s34]：
  - `list`：列出记忆目录中的文件（支持分页）；
  - `read`：读取指定记忆文件（默认输出预算 20,000 tokens，可由参数调整，不是不可变硬上限）；
  - `search`：针对文件内容执行关键词与滑动窗口的子串包含匹配（Contains，默认最多返回 200 条匹配）[s13]；
  - `add_ad_hoc_note`：写入用户显式便笺。

专用工具在解析文件路径时强制限制在记忆根目录内部，并拒绝符号链接（Symlink），以防止路径遍历逃逸。这种文件系统层面的边界防护，不应与分布式系统的多租户身份鉴权混为一谈。

### 5.4 引用提取与使用反馈

系统设计了基于引用的正反馈机制，用于评估记忆的有效性 [s12]、[s28]：

- 读路径提示词指引模型：若在生成回答时参考了记忆内容，应在回答中输出如下格式的引用标签：
  `<oai-mem-citation><citation_entries>相对文件:行范围|note=[说明]</citation_entries><rollout_ids>UUID</rollout_ids></oai-mem-citation>`
- 运行时在处理模型事件流时，拦截并解析该标签中的 `rollout_ids` [s28]；
- 随后调用 `record_stage1_output_usage`，在 SQLite 中递增对应会话提炼记录的 `usage_count`，并刷新其 `last_usage` 时间戳 [s08]。

这一数据将直接作为后续 Phase 2 选拔留存排序的第一优先级依据。需注意的是，摘要被注入到上下文并不自动计入使用次数；仅当模型切实生成了有效引用标签并被系统解析后，计数才会增长。同时，引用次数仅反映调用的相对活跃度，不能等同于记忆内容的客观准确率。

---

## 6. 更新、遗忘与清理机制

### 6.1 自动沉淀与主动纠偏的控制面划分

在知识生命周期管理中，存在两条性质不同的控制路径：

- **后台自动提炼路径**：不必逐条说“请记住”，但必须先由有效新轮次触发检查；系统再按历史会话的闲置时间与年龄等条件抽取和合并。它不是独立常驻定时器。
- **主动干预纠偏路径**：当用户在日常对话中显式给出“记住某习惯”或“以后不要做某事”的指令时，智能体通过 `add_ad_hoc_note` 工具或文件写入操作，在 `extensions/ad_hoc/notes/` 下创建新的时间戳便笺（如 `2026-09-16T12-00-00-preference.md`），其中专用工具采用 `create_new` 模式避免覆盖 [s14]。

在后续 Phase 2 整合时，系统提示词指示合并智能体优先采纳便笺中的最新规则 [s30]、[s39]。便笺文件保留了可检查的纠错输入，但在工程上必须通过后续实际生成结果进行检验，不能保证大模型在语义合并时百分之百实现确定性消除。

“只在用户明确要求时写便笺”主要是工具说明和提示词约束，不是后端可以独立证明的人类授权。涉及敏感写入时，外层应用仍应校验权限。合并模板也要求将记忆和便笺视为待处理的数据，而不是任意命令。

同时，开发者**不应直接手动修改由系统自动生成的 `memory_summary.md` 或 `MEMORY.md`**，因为任何未经 SQLite 状态与便笺机制支撑的手工编辑，在下次 Phase 2 触发时都有被合并智能体重写覆盖的风险。

### 6.2 遗忘、淘汰与保留算法

Codex 底层维护着多层淘汰与修剪逻辑：

1. **未用条目过期窗口（`max_unused_days`，默认 30 天）**：
   在流水线清理阶段，系统会对未被 Phase 2 选中的历史记录（`selected_for_phase2 = 0`）进行扫描与修剪；已被选中的基线条目将予以保留，作为下次比对的依据。
2. **Phase 2 候选容量挤出**：
   合并候选容量默认限制为 256 条。当历史累积超出时，引用计数低且久未被使用的冷门会话摘要将被排除在合并池之外。
3. **输入对齐与级联修剪**：
   在 Phase 2 开始前，文件同步模块将比对本次选拔结果，从磁盘中删除未入选的 `rollout_summaries/*.md`。失去底层会话支撑的事实将在后续合并中被逐步移除。
4. **源会话状态变更引发的资格剥夺**：
   Phase 2 在选拔输入时调用 `enabled_thread_metadata` 复核会话状态 [s08]。若将某个历史会话的 `memory_mode` 改为 `disabled` 或 `polluted`，它将立即失去进入 Phase 2 的资格。
5. **归档与删除的区别**：
   Phase 1 在扫描新会话时明确过滤已归档记录（`archived_only = false`）；但在 Phase 2 中，`enabled_thread_metadata` 仅校验 ID 与 `memory_mode`，并未附加归档校验。因此，**在当前代码实现下，单纯在前端将某个会话归档，并不等同于将其派生的记忆从现有知识库中彻底删除**。
6. **临时扩展资源清理**：
   在 `extensions/<name>/resources/` 目录下带有合规时间戳前缀的文件，存在按 7 天保留阈值执行的流水线修剪逻辑（不是固定七天一次的定时任务） [s29]。该规则仅适用于具备对应清理说明的扩展，**绝不包含 `extensions/ad_hoc/notes/` 目录**（便笺维护规范明确要求不得删除已有便笺 [s30]）。

### 6.3 危险维护接口：`memory/reset`

在 `app-server` 模块中，提供了一个名为 `memory/reset` 的管理接口 [s18]、[s36]：

- **实际执行行为**：清空关联记忆库的中间记录与作业状态，并清理记忆目录的内容，保留根目录，不删除整个 SQLite 数据库文件。0.154.0 清理 `memories/` 与 `memories_extensions/`；main 还清理 `memories_v2/` 并覆盖两个版本的记忆状态。实际根路径取自当前生效配置，不固定是示例中的 `~/.codex` [s08]、[s17]、[s18]、[s45]。
- **非作用范围**：
  1. 它**不删除** `sessions/` 目录下的原始会话日志（Rollout Logs）；
  2. 它**不改变**已有会话在数据库中的 `memory_mode` 标记（原本为 `disabled` 的仍为 `disabled`，`enabled` 的仍为 `enabled`）；
  3. 该清理路径**没有撤回**已加载至活动会话上下文的记忆摘要，不能把重置当作当前上下文即时清空。

**风险提示**：在执行 `memory/reset` 后，若宿主机上仍保留着大量满足年龄与闲置条件的原始会话，且后续运行仍满足后台流水线的开启条件，那么当下一次有效会话交互发生时，后台 Worker **很可能会重新扫描这批旧日志，重新执行 Phase 1 提炼并重新构建记忆库**。因此该操作属于高风险维护接口，不能视为会话历史的彻底物理销毁。

### 6.4 控制操作对各层状态的影响对比

| 控制操作 / 接口调用 | 后台进程开销 | 记忆文件存储状态 | 历史会话状态（state_5） | 新会话读取表现 | 影响范围与可逆性 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **关闭总开关**<br>`features.memories=false` | 对采用新配置的运行，不再启动该流水线；不承诺取消其他已运行进程 | 不主动删除文件，其他已启用进程仍可能更新 | 原样保留，无状态变迁 | 新会话不注入摘要和专用工具 | 可重新开启；不撤回已注入内容 |
| **关闭生成配置**<br>`generate_memories=false` | 后台已运行任务不自动取消，但新会话标记禁用 | 现有文件保持，但旧会话后台仍可能触发更新 | 新创建会话的 `memory_mode` 默认为 `disabled` | 仍正常注入现有记忆摘要 | 仅影响新会话作为提炼源的默认资格 |
| **关闭读取配置**<br>`use_memories=false` | 后台提炼与合并流水线不受其单独限制 | 文件继续在后台提炼与合并更新 | 原样保留，无状态变迁 | 上下文不再注入摘要，隐藏专用工具 | 不影响文件沉淀，仅关闭前台消费端；不清除已注入上下文 |
| **写入便笺纠错**<br>`add_ad_hoc_note` | 下次 Phase 2 消耗模型推理 Token | 在 `notes/` 新增便笺文本文件 | 原样保留，无状态变迁 | 下次合并后生效，引导模型修正事实 | 可审计纠偏，依赖模型语义合并结果 |
| **调用重置接口**<br>`memory/reset` | 瞬时 IO 清理，后续交互可能重新触发提炼 | 清空记忆目录内容与中间关系表 | 不改动会话原始日志，不改动会话记忆模式 | 摘要文件缺失，无记忆注入 | 高危操作，中间状态重置；若保留原始日志可能被重新提炼 |
| **禁用指定源会话**<br>`thread/memoryMode/set` | 不停止处理其他合格历史会话 | 后续 Phase 2 不再选取该源，但不是即时物理清除 | 指定会话 `memory_mode=disabled` | 现有已生成摘要可能暂时仍含旧内容 | 需等待合并并检查结果；不等同于关闭该会话读取 |

---

## 7. 配置与默认值

### 7.1 核心配置项比对与源码冲突

下表展示了官方公开配置参考文档、0.154.0 发布版源码与主分支 main 源码之间的详细比对：

| 配置项（TOML 路径） | 官方配置参考文档 [s02] | 0.154.0 源码 [s03] | main 分支源码 [s04] | 判定结论与工程建议 |
| :--- | :--- | :--- | :--- | :--- |
| `features.memories` | 标明默认关闭（未在该条目标 Stable） | `false` | `false` | **一致（默认关闭）**。生效配置须启用该特性；源码另外标记为 Stable。 |
| `memories.generate_memories` | `true` | `true` | `true` | **一致**。控制新会话默认是否开启记忆生成资格。 |
| `memories.use_memories` | `true` | `true` | `true` | **一致**。控制新会话启动时是否尝试挂载与注入记忆。 |
| `memories.dedicated_tools` | 公开配置参考未收录 | `false` | `false` | **文档未列出**。代码默认使用通用文件工具，不加载专用工具。 |
| `memories.disable_on_external_context`| `false` | `false` | `false` | **一致**。默认不因外部工具调用而阻断记忆提炼。 |
| `memories.max_rollouts_per_startup` | **16** | **2** | **2** | **默认值不一致**。文档记为 16，两份源码实装均为 2。此为单次触发处理的批次上限。 |
| `memories.max_rollout_age_days` | **30** | **10** | **10** | **默认值不一致**。文档记为 30，两份源码实装均为 10 天。此为自动提炼的候选年龄上限。 |
| `memories.min_rollout_idle_hours` | 6 | 6（范围 1..48） | 6（范围 1..48） | **一致**。代码注释建议生产环境大于 12h，默认均为 6h；传入 0 会被强制重置为 1h。 |
| `memories.max_raw_memories_for_consolidation`| 256（上限 4096） | 256（上限 4096） | 256（上限 4096） | **一致**。Phase 2 合并候选池的默认容量与配置上限。 |
| `memories.max_unused_days` | 30 | 30 | 30 | **一致**。合并候选的未用保留窗口；从未引用的条目回退到源会话更新时间，修剪另受是否为已选基线限制。 |
| `memories.min_rate_limit_remaining_percent` | 25 | 25 | 25 | **一致**。适用于取得有效 Codex 后端配额信息的路径；非该后端和查询失败有放行分支，见 9.5。 |
| `memories.extract_model` | 可选提炼模型名 | 未填则遵循供应商默认 | 未填则遵循供应商默认 | 缺省时回退至代码内置默认模型映射 [s19]。 |
| `memories.consolidation_model` | 可选合并模型名 | 未填则遵循供应商默认 | 未填则遵循供应商默认 | 缺省时回退至代码内置默认模型映射 [s19]。 |

**判定依据**：在系统实际运行时，程序的具体表现受编译期代码支配。因此对这两个固定源码版本，应以 2 与 10 天作为未覆盖配置时的默认值基准；实际运行仍需核对用户配置、托管配置及启动覆盖值。文档与源码不一致不代表我们已经测得本机最终生效配置。

### 7.2 CLI TUI 与官方文档关于 `/memories` 的实质差异

在交互界面层级，存在一处必须澄清的实现差异：

- **官方文档表述**：[Memories 指南][s01] 指出，在客户端界面中使用 `/memories` 命令仅用于会话级（chat-level）的选择，不会改变用户的全局配置（Global Settings）。
- **CLI TUI 源码实现**：在已审阅版本的 CLI 终端界面源码中，`update_memory_settings` 函数会调用 `build_memory_settings_edits`，随后调用 `write_config_batch`，**直接将 `memories.use_memories` 与 `memories.generate_memories` 的变更持久化写入 `config.toml` 配置文件** [s41]、[s42]。
- **面板交互提示**：界面视图快照（`memories_settings_view.rs` [s43]）明确标注：
  - `"Changes are saved to config.toml"`
  - `"Use ... Applied at next thread"`
  - `"Generate ... Current thread included"`
  若在界面中修改了 `generate` 开关，系统除了持久化落盘外，还会额外调用 `thread/memoryMode/set` 将当前显示会话的状态同步变更。

因此，不能照搬官方文字，误以为 CLI 中的 `/memories` 命令完全不写配置文件。该操作确实会**写入持久配置并影响后续创建的会话**；同时 `generate` 开关的改动还会立即更新当前会话。需要说明的是，本次核验并未操作桌面端桌面 App，无法将 CLI 的这一实现断言为桌面端 App 的行为。

### 7.3 安全参考配置示例

若在 0.154.0 环境下进行功能验证，可采用如下标准的 TOML 配置语法（仅作格式参考，请勿盲目复制至生产环境）：

```toml
# 独立测试环境的 config.toml（不要直接覆盖日常配置）

[features]
# 显式开启记忆特性总开关（默认值为 false）
memories = true

[memories]
# 允许新会话默认作为提炼候选
generate_memories = true

# 允许在新会话启动时挂载记忆摘要
use_memories = true

# 按代码默认使用通用文件工具；true 才注册专用记忆工具
dedicated_tools = false

# 与源码默认实现保持对齐的参数配置
max_rollouts_per_startup = 2
max_rollout_age_days = 10
min_rollout_idle_hours = 6
```

*注：在 0.154.0 版本中切勿配置 `version` 或 `dual_write`，相关字段仅存在于主分支试验代码中。*

---

## 8. 版本演进与接口：v1 与 v2

### 8.1 架构演进全景比对

在主分支（main HEAD）中，Codex 引入了第二代记忆架构（v2），但默认架构仍保持为 v1。下表展现了两代实现的演进差异：

| 机制与特性维度 | v1 架构（0.154.0 发布版 & main 默认） | v2 架构（仅存在于 main 分支） |
| :--- | :--- | :--- |
| **版本配置字段** | 0.154.0 无这两个字段；main 的 v1 可由 `version` 选择，且为默认值 | main 支持 `version = "v2"`；`dual_write` 默认 false，可并行生成两版 |
| **文件存储目录** | `~/.codex/memories/` | `~/.codex/memories_v2/` |
| **数据库存储** | `memories_1.sqlite` | `memories_v2_1.sqlite` |
| **Phase 1 产物定义** | 输出 `raw_memory`、`rollout_summary`、`rollout_slug` [s23] | **仅输出 `rollout_summary` 与 `rollout_slug`**（移除了 `raw_memory`） |
| **提炼字节上限** | 依赖模型提示词估算控制 | 摘要内容施加 **9,000 UTF-8 字节**硬性上限（`phase1_output.rs` [s23]） |
| **输入清洗分层** | 已有消息过滤、脱敏和输入预算，并非不加筛选 | 按证据来源分层选取（用户输入优先）后恢复时间顺序，省略媒体载荷并裁剪工具输出 [s24] |
| **Phase 2 整合目标** | 维护详细手册 `MEMORY.md` 和摘要 [s39] | 不再要求产出 `MEMORY.md`，也不重建 `raw_memories.md`，核心目标为 `memory_summary.md` [s07]、[s25] |
| **生成文件校验 / 注入预算** | 产物需满足 v1 对应结构；读取注入时截断到约 2,500 tokens，不能把它当生成文件硬上限 | 生成文件校验要求小于 **10,000 UTF-8 字节**；读取注入时仍受约 2,500 tokens 预算约束 [s16]、[s34] |
| **摘要内部结构要求** | 模板已有 `v1` 首行及用户画像、偏好、提示、记忆索引等结构，不是任意自由格式 [s39] | 校验要求 `v1` 首行及 User Profile、User preferences、General Tips、What's in Memory 四个标题 [s16]、[s25] |
| **检索交互策略** | 先查索引，再搜 `MEMORY.md`，再追溯摘要 | 依赖摘要内精准指针直接定位具体的 `rollout_summary` |

### 8.2 双写模式（Dual-Write）机制解析

在 main 分支中，当配置 `dual_write = true` 时，后台调度逻辑会同时拉起 v1 与 v2 两套独立的流水线：

- 两套流程分别向 `memories/` 与 `memories_v2/` 写入独立的文件树，并操作各自独立的 SQLite 数据库文件；
- **无论是否开启双写，前台新会话在初始化时，仅会读取由 `version` 配置项指定的那一个版本的目录进行注入**；
- 源码单元测试的断言覆盖：开启双写会在两个目录分别构建工作区，但**不会将旧目录下的历史便笺自动导入到新目录中** [s35]；
- 双写可能增加模型调用和 Token 开销；实际增量取决于候选、空输出及跳过合并情况，不保证每次恰好翻倍。

### 8.3 格式标记与流水线版本的辨析

在 v2 的 `consolidation_v2.md` 提示词模板中 [s25]，生成的 `memory_summary.md` 文件的第一行被强制要求输出为字符串 `v1`。

源码的格式校验逻辑表明：此处的 `v1` 是**产物排版格式的规范标记（Artifact Format Marker）**，与后台流水线采用 v1 还是 v2（Pipeline Version）属于完全不同的概念。切勿因此误判系统未能正确进入 v2 流程。

### 8.4 状态查询接口：`memory/status`

main 分支在 `app-server` 中增加了 `memory/status` 实验接口 [s26]、[s27]：

- 该接口用于上层调用方核验 v2 记忆库是否达到可用状态；
- 接口判定条件为：已合并会话数达到门槛（`count >= minConsolidatedThreads`，参数默认值为 20，允许配置范围 1 至 4,096），且 `memory_summary.md` 存在且格式合法；
- 统计所引用的字段是 `v2_consolidated_threads`，代表历史合并数量的高水位记录（`max_thread_count`），并不代表当前文件内容精确切分为 20 个会话。该接口在 0.154.0 二进制中不存在。

---

## 9. 当前项目、SDK 边界与第三方 API

### 9.1 本地示例项目配置现状

审查本地项目代码可知：

- 项目依赖在 [package.json](../../package.json) 中声明为 `@openai/codex=0.154.0` 与 `@openai/codex-sdk=0.154.0`；
- 在通用初始化文件 [lib/common.mjs](../../lib/common.mjs) 中，实例创建代码如下：
  ```javascript
  // 来源：lib/common.mjs
  const codex = new Codex({
    apiKey: process.env.CODEX_API_KEY || undefined,
  });
  ```
- 项目中未传递显式的 `features.memories` 参数，亦未指定专用的独立存储目录。
- **配置继承边界**：未传递显式配置并不等于运行时记忆必然处于关闭状态。因为未配置时，进程将继承宿主机当前环境生效的配置文件。本次核验未读取宿主环境的用户全局配置，故不基于该代码片断推断用户机器的最终开关状态。

### 9.2 TypeScript SDK 的交互路径与候选排斥

在基于 SDK 进行自动化集成时，必须理解其底层通信协议与候选筛选规则：

- **底层调用方式**：在 `@openai/codex-sdk` 0.154.0 的实现中，底层通过子进程调用 `codex exec --experimental-json` [s21]；在公开 API 层，调用方式为 `codex.startThread()` 随后执行 `thread.run()` 或 `thread.runStreamed()`。
- **来源标记排斥**：在 `codex-rs/exec/src/lib.rs` 中，该命令启动的会话来源被显式硬编码为 `SessionSource::Exec` [s22]。
- **提炼白名单阻断**：第 4.3 节所述的候选会话白名单 `INTERACTIVE_SESSION_SOURCES` 仅接纳 `Cli`、`VSCode` 及特定定制来源，不包含 `Exec` [s09]。

**核心结论**：**通过官方 TypeScript SDK 默认发起的会话，由于被标记为 `SessionSource::Exec`，即使系统总开关开启，其日志本身也绝不会被自动选为 Phase 1 提炼的输入候选。**

但这不代表 SDK 完全无法与记忆系统交互：

1. **记忆读取可行**：若宿主机上已通过交互式客户端生成了有效的记忆文件，SDK 启动的新会话在 `use_memories = true` 时，依然能正常在其上下文注入已有记忆摘要；
2. **触发机制可行**：SDK 启动的根会话如果满足有效输入等条件，同样可以拉起后台任务去扫描和提炼其他符合条件的交互式会话；
3. **显式便笺可行**：通过 SDK 引导智能体调用便笺工具写入修正意见，依然可以走通主动纠偏路径；
4. **会话恢复例外**：若 SDK 是在既有交互式会话遗留的 Thread ID 上执行恢复（Resume），其来源属性取决于原始元数据，不应一概等同于全新的 `Exec` 调用。

### 9.3 本地 App Server 示例的局限

项目提供的示例 [examples/05-app-server.mjs](../../examples/05-app-server.mjs) 尝试与本地 `app-server` 建立连接。

- 在 `app-server` 请求处理中，普通 app-server 入口默认使用 `SessionSource::VSCode` [s36]，该来源虽处于候选白名单内；
- 但该示例脚本的逻辑仅为发起一次简短连接、发送 "hello"、随后立即终止子进程退出；
- 提炼流水线依赖会话闲置达标（默认 6 小时）及被触发后的后台任务有足够时间执行，这种瞬时退出的测试脚本根本无法形成端到端的记忆提取闭环。

### 9.4 实验性 API Schema 导出核验

通过在本地执行 `node_modules/.bin/codex app-server generate-json-schema --experimental --out <DIR>`，成功导出了当前 0.154.0 二进制支持的 RPC 协议结构：

- `thread/memoryMode/set` 接口存在：参数格式为 `{ threadId: string, mode: "enabled" | "disabled" }`，用于动态调整特定会话是否具备作为提炼输入的资格；
- `memory/reset` 接口存在：用于清空当前记忆库的中间数据与物理产物；
- `memory/status` 接口在 0.154.0 中**明确不存在**，仅在主分支源码中出现。

这里核验的是 app-server 的实验协议，不是 TS SDK 已封装的稳定方法。客户端还需按所用版本的初始化协议启用实验能力；本项目的简短示例尚未完成这些管理操作的集成。

### 9.5 第三方模型服务商接入边界

Codex 记忆流水线并没有在账号层级设置“仅限官方 ChatGPT 订阅”的排他拦截。请求由通用的 `ModelProvider` 调度发出 [s19]。然而，团队若尝试完全接入第三方模型服务商，需面对以下工程现实：

1. **协议与格式容错**：Phase 1 依赖所配置 provider 对 Responses 请求、流式事件和严格结构化输出（Strict JSON Schema）的支持 [s06]、[s23]；Phase 2 则依赖长文本处理与工具调用能力。仅声称“OpenAI 兼容”，尤其仅兼容 Chat Completions，并不足以保证可用；本次未连接第三方服务实测。
2. **默认模型回退名称**：在 `provider.rs` 中，代码内置的默认模型映射为：提取模型指向 `gpt-5.6-luna`，合并模型指向 `gpt-5.6-terra` [s19]（此为代码内置代号，非服务商商业承诺）。**只设置主任务的模型名，不能据此推断这两个记忆阶段也使用同一模型**。供应商实现可覆盖其默认值；接入第三方前，应确认最终模型名可用，必要时显式设置 `memories.extract_model` 与 `memories.consolidation_model`。
3. **配额守卫（Quota Guard）对第三方的放行**：
   在 `guard.rs` 的配额保护逻辑中，代码通过 `auth.uses_codex_backend()` 判定后端类型 [s20]：
   - 针对官方后端，系统核验配额余量；
   - **对于 `uses_codex_backend()` 为 false 的认证路径，配额检测函数直接返回 `None`，并在外层通过 `unwrap_or(true)` 判定为允许继续执行**。
   因此，系统对第三方模型不存在统一的内置配额阻断保护，不能把这个守卫当成第三方通用费用上限。开发者仍应设置服务商限额、外部预算及并发控制；查询配额失败时也存在放行分支。
4. **隐私与网络边界**：数据存储在本地磁盘，并不代表推理过程完全离线。当符合条件的提炼任务实际运行时，会把筛选后的历史内容发送给配置的模型服务商。尽管代码中包含敏感信息脱敏逻辑，但其不具备全能的数据防泄漏保证。

---

## 10. 风险与工程边界

### 10.1 多租户环境下的数据混淆风险

在多用户或企业级智能体架构中，最严重的工程隐患是误以为工作目录具备天然的记忆隔离：

- **目录非隔离域**：如第 4.3 节所述，Codex 的会话状态库与提炼认领逻辑以单台主机的配置根目录（`~/.codex`）为全局维度，并没有按操作系统的当前工作目录（`cwd`）或代码项目进行分区。
- **环境伪隔离**：在同一操作系统用户下，即使临时通过环境变量指定不同的 `CODEX_HOME`，也仅是切换了存储命名空间，并非进程级或容器级的安全隔离。
- **风险推断**：若在单台服务器上为多个真实业务租户运行共享存储环境的 Codex 实例，不同租户的会话历史存在被后台合并进同一个 `memory_summary.md` 的跨租户泄露风险。**多租户隔离必须由外层的容器沙箱、操作系统权限以及业务鉴权逻辑负责，严禁将租户 ID 作为提示词文本交由智能体自行识别**。

### 10.2 间接提示词注入（Prompt Injection）风险

记忆注入机制客观上存在间接提示词注入的工程风险：

1. 若智能体在历史交互中处理了包含特定诱导指令的不可信外部文本；
2. 该会话结束并在后台被 Phase 1 提炼为高优先级偏好；
3. Phase 2 将该偏好整理并写入 `memory_summary.md`；
4. 后续所有新会话在启动时，该内容均会被打包在 **`developer` 角色提示词片段**中率先加载给模型。

这是一条需要防范的风险传播路径，而非本次已复现的漏洞或必然发生的结果。由于这些内容会进入后续提示词，这类恶意注入可能对智能体的后续判断产生长期的潜在干扰。因此，关键业务权限与操作限制必须由硬性的代码逻辑和沙箱执行控制，不能把记忆内容当成天然可信的指令来源。

### 10.3 业务权威状态的依赖边界

开发初学者容易产生的另一误区，是将动态的业务核心数据托付给智能体记忆：

- **错误假设**：“智能体通过长期记忆记住了用户的最新账户余额或未审批订单”。
- **工程现实**：记忆提取是异步延迟的，提炼存在概率丢失，且模型回答存在语义幻觉。
- **设计红线**：诸如订单、账户余额、权限策略等强一致性核心业务数据，**必须存放在业务系统自身的关系型或事务数据库中，并通过标准化工具实时查询**。AI 记忆仅能且仅应承载辅助性的经验与协作偏好（如排版格式喜好、常用命令选项等）。

---

## 11. 复现与验收方案

### 11.1 已完成的无模型静态核验规程（基线证据）

以下命令在仓库根目录执行，要求 Git、Node.js 及项目已安装的 0.154.0 依赖可用。请在同一个终端依次运行，以保留 `research_dir` 变量。它们不调用模型，但克隆代码需要联网和磁盘空间。

附件：[只读核验脚本](verify-evidence.mjs) · [本次 50/50 核验结果](verification-results.json)。

1. **环境准备与源码检出**：
   为避免覆写开发者现有的系统目录，严禁使用现有主目录作为临时空间。采用专属临时目录进行安全检出：
   ```bash
   # 进入本项目，确认使用项目安装的版本
   cd <仓库根目录>
   node_modules/.bin/codex --version

   # 创建任务专属临时目录
   research_dir="$(mktemp -d /tmp/codex-memory-check.XXXXXX)"

   # 克隆 release 0.154.0 标签代码（浅克隆）
   git clone --depth 1 --branch rust-v0.154.0 https://github.com/openai/codex.git "$research_dir/release"
   git -C "$research_dir/release" rev-parse HEAD
   # 上一步应为 6b9826e3aa83b1a5947db50f4332cb9c65f1b340

   # 克隆后检出固定主线提交（实际下载量受仓库大小影响）
   git clone --no-checkout --filter=blob:none https://github.com/openai/codex.git "$research_dir/current"
   git -C "$research_dir/current" checkout --detach 4701aa4b4239c70063ab6f2fcb835324f9c109f4
   ```
2. **导出 Schema 定义**：
   ```bash
   mkdir -p "$research_dir/schema"
   node_modules/.bin/codex app-server generate-json-schema --experimental --out "$research_dir/schema"
   ```
3. **运行 50 项静态断言脚本**：
   使用本报告工作区旁提供的静态核验脚本，传入四个对应路径参数执行：
   ```bash
   node reports/codex-memory-2026-09-16/verify-evidence.mjs \
     "$research_dir/release" \
     "$research_dir/current" \
     "$research_dir/schema" \
     .
   ```
   *预期产物*：输出 50 项断言检查明细，确认 **50/50 项断言全部通过**（输出至标准输出；旁置的 `verification-results.json` 为保存的历史核验快照）。该过程仅为代码模式比对，不执行模型调用与代码编译构建。

### 11.2 待执行的隔离环境真实运行时测试设计

若团队具备资源对长期记忆链路进行端到端实测，应使用独立测试存储与适当的进程权限隔离。**再次声明：本次核查未执行以下涉及真实模型的测试用例，以下内容仅为标准试验规程设计。**

#### 隔离前置要求

- 准备全新的独立测试存储目录（在测试进程启动配置中选择），严禁直接使用或覆盖日常开发的主目录；
- 配置独立的测试用模型 API Key；
- 开启 `features.memories`、生成和读取，并确认所选提炼/合并模型可用。涉及专用工具的 TEST-04、TEST-06 还应先设置 `dedicated_tools = true`，不能用默认未注册工具来证明读取开关有效；
- 在配置中显式配置 `min_rollout_idle_hours = 1`（利用代码允许的最小值，传入 0 会被代码强制重置为 1h，无法实现秒级触发）；
- **核心触发操作**：在会话结束并满足闲置时间后，**必须在另一个会话中切实提交非空输入并开启新轮次，保持宿主进程存活**，才能拉起后台提炼流水线；单纯启动空进程或仅调用 `thread/start` 无法触发。

#### 测试矩阵规程

| 测试用例编号与目标 | 操作规程设计 | 预期验证证据（需检查物理介质） |
| :--- | :--- | :--- |
| **TEST-01: 基础提炼正例**<br>验证交互会话沉淀为记忆 | 1. 启动 CLI 交互会话，录入独特项目代号偏好，例如：“代号 ALPHA_PROJECT 必须使用 pnpm 启动”。<br>2. 结束会话并等待闲置超过 1 小时。<br>3. 启动另一个会话并提交非空输入开启新轮次，保持进程存活。 | 1. `memories_1.sqlite` 的 `stage1_outputs` 表出现对应会话的提炼行；<br>2. 磁盘生成 `rollout_summaries/*.md`；<br>3. `memory_summary.md` 包含该偏好。 |
| **TEST-02: 跨会话召回与引用**<br>验证新会话能召回历史 | 1. 在 TEST-01 产物就绪的新环境中启动全新交互会话；<br>2. 提交问题：“如何启动项目 ALPHA_PROJECT？”；<br>3. 观察模型输出流及数据库变动。 | 1. 模型能主动建议使用 pnpm；<br>2. 拦截到 `<oai-mem-citation>` 引用标签；<br>3. `stage1_outputs` 中对应会话的 `usage_count` 相对之前产生净增长。 |
| **TEST-03: SDK Exec 负例排除**<br>证实 SDK 调用不被提炼 | 1. 使用 `@openai/codex-sdk` 启动新会话并执行任务，注入独特的随机标识；<br>2. 进程退出并等待闲置超 1 小时；<br>3. 启动 CLI 会话并交互以触发扫描。 | 1. `state_5.sqlite` 中记录该会话来源为字符串 `exec`；<br>2. `stage1_outputs` 中不存在针对该会话的提炼输出。 |
| **TEST-04: 关闭读取负例**<br>验证关闭 use 时的屏蔽表现 | 1. 在已有记忆库的环境下配置 `use_memories = false`；<br>2. 启动全新会话进行交互。 | 1. 上下文检查确认不包含带有记忆标记的 `developer` 提示词片段；<br>2. 运行时工具列表中不存在 `memories` 命名空间下的专用工具。 |
| **TEST-05: 外部上下文污染隔离**<br>验证外部工具调用引发熔断 | 1. 配置 `disable_on_external_context = true`；<br>2. 交互中触发一次判定为外部污染的网络检索或 MCP 调用；<br>3. 结束会话并等待闲置达标后触发扫描。 | 1. 该会话在 `state_5.sqlite` 中的 `memory_mode` 被更新为 `'polluted'`；<br>2. 该会话被排除在 Phase 1 提炼候选池之外。 |
| **TEST-06: 显式便笺纠偏覆盖**<br>验证便笺更新历史事实 | 1. 引导智能体调用 `add_ad_hoc_note` 写入更新偏好：“ALPHA_PROJECT 现已全面迁移至 yarn”；<br>2. 触发一次有效的 Phase 2 合并；<br>3. 开启全新会话查询启动方式。 | 1. `notes/` 目录新增带有时间戳前缀的便笺；<br>2. 合并后的 `memory_summary.md` 中建议被更新为 yarn；<br>3. 模型优先遵循新便笺规则。 |
| **TEST-07: 多租户隔离验证**<br>验证不同配置目录的独立性 | 1. 在两个完全独立的配置目录分别建立不同偏好；<br>2. 分别触发提炼与合并流程；<br>3. 交叉查询两个环境。 | 1. 两个目录下的 `memory_summary.md` 互不包含对方的偏好记录；<br>2. 本轮探针未发生交叉召回；另外核查进程权限，不能凭一次负例宣称彻底不存在泄露风险。 |
| **TEST-08: 第三方模型输出容错**<br>验证非官方模型的格式兼容 | 1. 配置第三方 provider，并把 `memories.extract_model`、`memories.consolidation_model` 设为其支持的模型名；<br>2. 触发会话提炼流程。 | 1. 检查提炼是否能够正确产出符合 Strict Schema 的 JSON 结果；<br>2. 若格式不兼容，系统能够记录错误并安全退避。 |

**验收警示**：在执行上述验证时，判定通过与否必须依据 SQLite 表记录与物理磁盘文件的实际变更，**切勿把大模型在对话中口头声称“我已经记住了”当成功能成功的依据**。

这些正例是验收目标，不是模型必然保存每一条偏好的保证。若空提炼、合并失败或未召回，应记录日志并逐阶段定位；也不能把 `memory/status` 默认门槛 20 误解为 v1 必须积累 20 次对话才能生成记忆。

---

## 12. 交叉验证结论与迁移建议

### 12.1 既往认知修正汇总

基于上述多维度审查，针对常见的认知偏差整理修正如下：

1. **触发时机修正**：记忆生成并非会话创建即触发，亦非固定定时器。核心触发路径是交互轮次收到非空输入、成功启动且主环境已就绪后，由后台异步拉起。
2. **SDK 能力修正**：不能从“系统具备记忆能力”推论出“SDK 发起的自动化任务能自动沉淀记忆”。SDK 底层默认的 `SessionSource::Exec` 来源直接被候选提炼白名单排除。
3. **参数基准修正**：对本报告审查的两个版本，文档默认值 16 / 30 与源码 2 / 10 不一致；调试应核对对应版本源码与最终生效配置，不把不一致原因武断归为某一方过时。
4. **版本边界修正**：v2 架构目前仅存在于主分支代码中，当前 0.154.0 发布版并不支持 `version` 与 `dual_write` 配置。
5. **消费控制修正**：`use_memories = false` 仅为会话层面的上下文组装开关，不会自动清除已注入的当前上下文，亦非物理删除记忆库的手段。
6. **沙箱边界修正**：合并智能体并非绝对封闭离线，在父级处于外部权限或禁用权限时，它将保留父级权限。
7. **客户端行为修正**：CLI 终端中的 `/memories` 命令并非仅作用于当前对话，它会批量将配置持久化落盘至配置文件，并影响后续创建的会话。

### 12.2 面向 LangGraph 架构的迁移与设计建议

对于已经在 LangGraph 或类似框架中建立了状态流转与持久化存储的团队，若考虑在技术架构中引入或迁移至 Codex Harness 记忆体系，建议遵循以下四个阶段：

- **第一阶段：保留业务外置存储，切忌激进替代**
  切勿尝试使用本地的 Markdown 与 SQLite 记忆机制替代生产级外部数据库（如 PostgreSQL、pgvector 或专门的企业知识库）。业务真相必须留在强一致性存储中。
- **第二阶段：将 Harness 记忆定位为“开发经验辅助层”**
  在本地开发交互场景中，可开启 Codex 记忆作为辅助层。利用其自动沉淀机制，让智能体逐渐掌握开发者的本地环境习惯、命令行参数组合以及调试技巧。
- **第三阶段：通过标准化 MCP 桥接业务知识**
  若希望智能体在执行任务时参考大规模业务文档或外部系统状态，一种可选接入方式是**把已有业务查询与记忆读写封装成 MCP 工具**。让智能体在运行时按需调用工具查询企业知识库，而非将大量外部文档直接写入本地记忆目录。
- **第四阶段：完整重构的工程评估清单**
  若评估后确实需要将自主智能体完整基于 Codex Harness 落地，必须在系统设计中涵盖以下五项关键考量：
  1. **审计会话来源（Session Source）**：评估自动化任务的发起方式，避免因来源标记被排除而导致关键交互无法沉淀为经验；
  2. **确立租户隔离红线**：为不同业务租户设计独立存储命名空间和可强制执行的访问隔离；容器或独立系统身份是可选实现，不能只靠提示词区分租户；
  3. **评估模型能力与 Token 预算**：确认所接入的模型服务商能稳定支持 Strict JSON Schema 输出，并为后台提取与合并流水线预留充足的 Token 财务预算；
  4. **严格配置执行权限**：优先采用受管权限（`Managed`）并核查实际写入/网络边界；如使用外部隔离，需自行证明其约束有效；
  5. **建立显式纠偏机制**：制定通过 `ad_hoc/notes` 机制进行人工纠错的运维规程，当出现错误的记忆沉淀时，通过标准化便笺实施可追溯的纠偏覆盖。

---

## 源码阅读索引与权威来源

正文的 `[s编号]` 可点击跳转至证据。网页核查日为 2026-09-16；源码链接固定到提交，不随 main 漂移。便于入门的阅读顺序是：

| 目标 | 入口 |
| :--- | :--- |
| 文档与默认值 | [Memories 指南][s01]、[配置参考][s02]、[发布版配置源码][s03] |
| 触发及两阶段生成 | [轮次触发][s40] → [启动门控][s05] → [单会话提炼][s06] → [跨会话合并][s07] |
| 保存与读取 | [数据库选拔和统计][s08]、[摘要组装][s11]、[本地检索][s13] |
| 用户控制 | [便笺工具][s14]、[CLI 配置持久化][s41]、[管理接口][s18] |
| SDK 与当前项目 | [SDK 子进程调用][s21]、[Exec 来源][s22]、[本地创建入口](../../lib/common.mjs) |

仓库自带的 [Memories README][s31] 可辅助理解，但其中的启动描述、目录位置和部分排序说明不能代替上述实际调用链与 SQL；本报告据代码处理这些差异。

[s01]: https://learn.chatgpt.com/docs/customization/memories?surface=app "官方公开文档：Memories 使用指南"
[s02]: https://learn.chatgpt.com/docs/config-file/config-reference "官方公开文档：Config Reference 配置参考手册"
[s03]: https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/config/src/types.rs "0.154.0 发布版配置类型定义"
[s04]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/config/src/types.rs "main 主分支配置类型定义"
[s05]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/start.rs "后台记忆提炼启动逻辑与前置条件校验"
[s06]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/phase1.rs "Phase 1 单会话提炼控制流与预算管理"
[s07]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/phase2.rs "Phase 2 全局知识合并与智能体权限配置"
[s08]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/state/src/runtime/memories.rs "状态数据库候选查询、模式复核与统计更新"
[s09]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/rollout/src/lib.rs "Rollout 日志定义与交互来源白名单"
[s10]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/ext/memories/src/extension.rs "记忆读取扩展挂载与引用事件拦截"
[s11]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/ext/memories/src/prompts.rs "记忆提示词片段组装逻辑"
[s12]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/ext/memories/templates/memories/read_path.md "读取路径提示词模板与引用标签格式规范"
[s13]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/ext/memories/src/local/search.rs "专用记忆搜索实现（子串包含匹配）"
[s14]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/ext/memories/src/local/ad_hoc_note.rs "显式纠错便笺创建工具实现"
[s15]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/storage.rs "存储抽象与 Markdown 文件落盘写入"
[s16]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/workspace.rs "工作区同步、增量比对与文件修剪"
[s17]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/control.rs "记忆目录内容重置实现"
[s18]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/app-server/src/request_processors/thread_processor.rs "App Server 会话创建处理与模式配置"
[s19]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/model-provider/src/provider.rs "模型供应商适配层与默认模型代号回退"
[s20]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/guard.rs "配额守卫逻辑与非官方后端放行分支"
[s21]: https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/sdk/typescript/src/exec.ts "TypeScript SDK 底层 CLI 调用实现"
[s22]: https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/exec/src/lib.rs "CLI Exec 命令对应的 SessionSource::Exec 标记"
[s23]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/phase1_output.rs "Phase 1 严格结构化输出模式与字节限制定义"
[s24]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/rollout_input.rs "Rollout 输入清洗、规则过滤与脱敏处理"
[s25]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/templates/memories/consolidation_v2.md "v2 知识合并提示词与格式排版规范"
[s26]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/app-server/src/request_processors/memory_status.rs "v2 记忆就绪状态核验接口实现"
[s27]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/app-server-protocol/src/protocol/common.rs "App Server RPC 协议公共结构与状态常量"
[s28]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/core/src/stream_events_utils.rs "事件流中的引用提取与外部工具污染捕获"
[s29]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/extensions/prune.rs "扩展资源生命周期与时间戳修剪逻辑"
[s30]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/templates/extensions/ad_hoc/instructions.md "Ad-Hoc 便笺维护指南与防删除规范"
[s31]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/README.md "记忆模块历史文档与过时路径对比"
[s32]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/state/src/sqlite.rs "底层 SQLite 数据库管理与连接池驱动"
[s33]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/ext/memories/src/tools/mod.rs "专用记忆工具集定义与命名空间暴露"
[s34]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/ext/memories/src/lib.rs "扩展初始化入口与专用工具挂载门控"
[s35]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/src/startup_tests.rs "双写模式与工作区隔离单元测试实现"
[s36]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/app-server/src/lib.rs "App Server 请求路由分发与重置服务注册"
[s37]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/features/src/lib.rs "Features 发布标记定义与默认关闭状态"
[s38]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/templates/memories/stage_one_system.md "Phase 1 单会话系统提炼提示词模板规范"
[s39]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/memories/write/templates/memories/consolidation.md "Phase 2 v1 知识合并系统提示词模板规范"
[s40]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/app-server/src/request_processors/turn_processor.rs "交互轮次处理与后台任务调用核心判断逻辑"
[s41]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/tui/src/app/config_persistence.rs "CLI TUI 配置持久化与批量落盘写入实现"
[s42]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/tui/src/config_update.rs "CLI TUI 记忆配置编辑项构建逻辑"
[s43]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/tui/src/bottom_pane/memories_settings_view.rs "CLI TUI 记忆设置界面视图与持久化提示"

[s44]: https://github.com/openai/codex/blob/4701aa4b4239c70063ab6f2fcb835324f9c109f4/codex-rs/core/src/mcp_tool_call.rs "MCP 服务的污染判定门控"
[s45]: https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/memories/write/src/control.rs "0.154.0 重置清理目录范围"
