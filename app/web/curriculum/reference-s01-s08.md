# s01–s08 参考研究与 Demo1–3 教学取舍

本轮逐章完整阅读了 `shareAI-lab/learn-claude-code` 顶层 s01–s08 的 `README.zh.md` 与 `code.py`，固定版本为 `ce8f9f186058939da54c9d6fead78dfb5d0fd6c3`。本地副本位于 `/tmp/learn-claude-code-20261008-reference`。下表是对实际机制的原创归纳，不将参考的 Python 执行循环移植到本项目。

编号以顶层 `sNN_*` 目录为准。仓库同时保留的 `agents/` 与 `docs/zh/` 使用另一组旧编号，不能仅按数字混用。原文、代码和网站动画存在局部不一致；涉及行为时以该提交的可执行代码为准。没有执行参考中的真实模型调用。

| 章节与固定版本来源 | 实际机制与教学增量 | 示例的简化或需要纠正的地方 | 本项目采用的教法与边界 |
| --- | --- | --- | --- |
| [s01 Agent Loop](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s01_agent_loop) | 先将模型响应写入消息，再从响应内容筛选实际 `tool_use` 块；没有调用块就结束，有则顺序执行并回传对应结果。用最少状态说明“回答”和“继续行动”的区别。 | 只有 bash 工具；执行串行。危险命令子串检查、120 秒超时、50,000 字符输出截断只是演示限制，不能当完整系统隔离。网站动画仍用 `stop_reason` 分支，还展示 read/edit 工具，和当前本章代码不一致。 | d1-transport 与 d1-lifecycle 先教本机连接，再教受理与完成两个等待点。模型内部循环属于 Codex；Node 只处理子进程、请求与事件、状态归属和清理。不能把 `turn/completed` 的事件名直接等同于成功状态。 |
| [s02 Tool Use](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s02_tool_use) | 扩展为 bash、read_file、write_file、edit_file、glob 五个工具，名称映射到 handler；工具清单描述输入，文件路径先 resolve 再检查是否位于工作目录。工具批次仍按响应顺序执行。 | 这里没有通用 JSON Schema 调用验证器；handler 的 Python 参数接收不能概括成完整参数授权。write_file 可以覆盖。README 中“s02 仍会执行 rm -rf /”的叙述与本章 bash 子串 denylist 不符。网站只画四个工具，bash 参数写 `cmd`，代码实际用 `command`。 | d3-tool-registry 将名称、规格、实现、列表授权、调用授权分开，展示参数失败时 handler 调用数仍为零。d3-mcp 再说明一个传输入口承载多个工具，工具清单不等于权限检查。 |
| [s03 Permission](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s03_permission) | 执行前依次经过硬拒绝、规则、交互询问；拒绝形成工具结果，模型可据此继续推理。为支持批准后的目录外访问，本章文件工具移除了 s02 内置的 safe_path 限制。 | 正则或字符串识别破坏性命令是解释检查位置的样例，并非完整 shell 安全分析。规则与用户批准有明确责任，不能将“不在工作区”一概解释为该例绝对禁止。 | d3-agent-config 教装配合同与版本撤销；d3-workspace 教来源 read 与产物 create 的独立判断。本项目采用受限工具与文件服务，不照搬询问审批、危险字符串名单或开放 shell。 |
| [s04 Hooks](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s04_hooks) | 将干预放到 UserPromptSubmit、PreToolUse、PostToolUse、Stop 四处。trigger 遇到非 None 返回就停止调用后续 hook；上层如何使用返回值才决定阻止、重试或继续。PreToolUse 拒绝时跳过执行与 PostToolUse。 | UserPromptSubmit 示例只打印 cwd，并没有把上下文注入 messages；它的返回值也未被调用者用于改写输入。Stop 默认摘要 hook 返回 None，不会永远阻止结束。Hook 名称本身不产生行为。 | 每节都标明 actor、event、后继状态和执行前后的区别，避免只列节点名称。本项目没有因此新增通用 hook 插件系统；变更撤销、工具校验、文件授权分别对应现有代码入口。 |
| [s05 Todo Write](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s05_todo_write) | TodoManager 验证整批计划后替换内存状态：至多 20 项、内容非空、固定状态、最多一项 in_progress。连续三轮工具往返未调用 todo 后插入提醒并重置计数。字符串输入使用 JSON 或 ast.literal_eval。 | 这是内存计划显示，不是持久任务队列，也不代表每个步骤已执行；提醒有规则并不保证模型计划质量。不能从 todo 状态推导后台执行顺序或可靠投递。 | d2-fifo 刻意区分用户输入排队与模型内部计划。持续接收 line、question 取队首和外层 await runTurn 共同构成串行推进；连接致命失败时内存输入清空，不自动重发。 |
| [s06 Subagent](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s06_subagent) | 父模型调用任务工具后，同步进入一个最多 30 次循环的新 messages 列表；子执行保留五个基础工具，不再暴露递归委派工具，只把最终文本交回父上下文。 | 上下文独立不等于进程、文件系统或权限独立：父子处于同一进程与 WORKDIR，复用权限/hook。本例不是并行 worker，也不是产品级多 Agent 管理。 | 用作责任边界的反例：Demo3 是单套 Agent 配置服务多个 Thread，不宣称实现 subagent。Agent、Thread、Turn 分别表示装配角色、会话与任务轮次，不能看到多会话就称多 Agent。 |
| [s07 Skill Loading](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s07_skill_loading) | 启动扫描一层 `skills/*/SKILL.md`，用 yaml.safe_load 读 frontmatter，将名称和描述列入系统提示，完整正文保存在注册表；模型调用 load_skill 后得到正文 tool_result。按需给正文降低起始上下文负担。 | 正文是在启动时读入注册表，并非每次调用都重新读取磁盘；name 是注册键，不是任意文件路径。越界符号链接被跳过。读到流程说明不代表实现了其中的工具、依赖或权限。 | d3-skills 教原生 skills/list、skills/config/write 的发现与启用集合核验，再教显式 type:skill 输入。默认 skills=[]；正常场景明确来自测试夹具。Codex 负责解析与注入，不另造 load_skill，也不把 $HOME 一概视为非法 Skill。 |
| [s08 Context Compact](https://github.com/shareAI-lab/learn-claude-code/tree/ce8f9f186058939da54c9d6fead78dfb5d0fd6c3/s08_context_compact) | 先存档和确定性缩减，再决定是否调用模型摘要：大结果写文件并保留预览，老结果替换为引用，删减旧消息时维护 tool_use/tool_result 配对；摘要与当前 active_request 分开。发生上下文过长时还可执行一次反应式恢复。 | 阈值按序列化字符估计，不是精确 token 计量；归档可回查不等于模型一定重读。摘要仍可能遗漏细节。工具消息配对优先于固定消息数，不能把保留条数当绝对大小上限。 | d2-resume 强调恢复原生 Thread，而非 Node 自行拼接、删减或压缩历史。excludeTurns=true 控制响应载荷，不清空原生历史。这里借用状态与信息归属的解释方法，不宣称本项目实现了参考的压缩算法。 |

## 数字与原文对齐

s08 的代码常量为：上下文估算阈值 50,000 字符，单批工具结果阈值 200,000 字符，单结果大文本阈值 30,000 字符，摘要输入上限 80,000 字符；常规落盘预览 2,000 字符，进一步缩减尚未消费的大结果时预览 1,000 字符。老工具结果保留最近 3 个；更早结果超过 120 字符才替换。上下文超阈值先以 80% 为缩减目标；反应式恢复保留最近 5 条消息并修复配对，最多重试一次。消息裁剪的名义上限 50 条按头 3、尾 46 加标记组织，必要时为完整配对扩展。以上均是参考示例的策略常量，未加入我们的 Demo。

本项目课内引用的大小限制另由本地源码核验：Demo3 文件服务的读写上限是 256 KiB；write_file 同时存在 Schema 字符长度限制与运行时 UTF-8 字节检查，不能将字符和字节混为一谈。默认 Skill 为空、原生 shell/原生写文件关闭、memory 关闭，都属于目前 Agent 定义的事实，不是对 Codex 通用能力的判断。

## 从参考网站采用什么

阅读了共享 step-controls、source-viewer、design-decisions，并检查 mechanism-flow、agent-loop-simulator 及 s01/s02/s07 可视化的相关实现。其有价值的组合是：步骤标题与解释同时呈现；图中当前节点与数据状态联动；源码带行号；设计决定说明理由与替代方案；上一/下一步、重置和播放让读者控制节奏。

原课程的问题是点击以后主要出现步骤名称，读者仍不知道“为什么需要这一步、哪些状态改变、失败会留下什么”。这次九节课的数据结构因此固定包含：具体问题、最小新增机制、职责归属、少量术语、因果机制、设计理由与代价、真实源码、正常与失败轨迹、可执行实验和迁移测验。两种轨迹每节保持同一组状态字段；所有事件明确标为教学模拟，T-A/V-A 等标识只是示意，不冒充在线协议记录。

源码窗口只摘本项目代码。每个 needle 已在对应文件中检查为唯一命中，解释明确区分窗口内能直接读到的内容和同文件其他函数负责的行为。状态步骤的 lines 保持空数组，避免给尚未映射的事件捏造精确高亮行号。动画可以解释多个配合函数，但不能暗示单段源码已包含全部逻辑。

## 交付与验证

`demo123.json` 提供九节原创课：d1-transport、d1-lifecycle、d2-fifo、d2-resume、d3-agent-config、d3-skills、d3-tool-registry、d3-mcp、d3-workspace。每节两种场景、每场景 3–5 步、一道带原因的测验，并包含实际源码定位和实验边界。没有新增后端能力，UI 与演示驱动由主任务统一实现。

已运行现有本地测试 17 项并全部通过：Demo1 的 success/early/failed/hang 四项，Demo2 的输入、双轮聊天、恢复成功与取消/失败四项，Demo3 的 Agent Schema、版本描述符、工具撤销、Skill 核验、来源边界、参数合同与 MCP 入口九项。它们使用假 App Server、临时文件或本机 HTTP；未发送真实模型请求，也没有据此声称回答质量、原生 Skill 遵循效果或完整线上链路已经验收。d1-transport 的手动握手命令只是明确的实验入口，本轮没有用用户真实配置执行；页面采用 early/success 夹具时，应说明其验证真实入口的握手与请求/事件分流。

本轮 agy 已由主任务尝试并得到配额 429，随后采用已向用户说明的源码核验写作方式；本子任务未重试。研究与课程仅修改分配的两个文件，不覆盖共享界面或运行代码。
