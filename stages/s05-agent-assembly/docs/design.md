# s05 设计说明：Agent 定义、角色与 Skills

> 本文是设计说明，供深入阅读。章节入门（要回答的问题 → 核心概念 → 分工 → 跑起来看看 → 关键代码）见 [README](../README.md)。

本阶段是独立源码快照。服务监听 `127.0.0.1:4323`，本机开发，单用户，不做公网授权。

## 设计原理

s04 的服务能可靠排队、推送状态，但"这个 Agent 是谁"仍写死在代码里。本阶段只加一个单元：**用一份 JSON 定义装配 Agent 的角色、Skill 和执行策略，并给装配结果一个可核对的版本**。

三个设计约束：

- **定义是唯一入口**：角色、Skill、执行策略、工作区都从定义来；未知字段直接拒绝，不读环境变量里的角色。
- **不能借配置放权**：schema 只允许只读沙箱、不审批、不开原生 shell 与写文件；角色描述不改变执行策略。
- **变更可检测**：定义、角色、Skill 任一文件内容变化，当前版本立即作废，必须受控重启；会话与排队消息按版本核对。

## 架构改进

### 1. 新增模块

| 模块 | 文件 | 职责 |
|------|------|------|
| Agent 定义 | [`server/modules/agents/index.mjs`](../server/modules/agents/index.mjs)、[`schema.mjs`](../server/modules/agents/schema.mjs) | 读取与 schema 校验、装配角色与执行策略、内容哈希与作废、描述符、会话版本绑定、生成带 Skill 的输入 |
| 角色与 Skills | [`server/modules/role/index.mjs`](../server/modules/role/index.mjs)、[`server/modules/codex/skills.mjs`](../server/modules/codex/skills.mjs) | 读取角色文件；向 Codex 核验 Skill 发现清单，只启用声明的 Skill |
| Agent 定义目录 | [`agents/writing-agent.json`](../agents/writing-agent.json)、[`agents/roles/`](../agents/roles/writing-assistant.md) | 本阶段默认的写作助手定义与角色正文 |

已有模块的变化：会话模块的沙箱、审批策略和 `baseInstructions` 改从 Agent 定义取；新建会话时绑定版本，恢复会话和每轮发出前核对版本与 Skill。任务记录多存一个 `agentHash`，调度器发出前按它核对。

### 2. 定义字段

`agent.skills[].scope` 可选且仅允许 `system`，缺省补为 `system`；装配后的 Skill 与描述符记录有效 scope，不参与授权。

```text
schemaVersion: "1.0"
agent:
  id, version          标识
  instructions         角色文件路径（相对定义目录，不能越出）
  skills[]             { id, required, scope? }
  executionRef         执行策略名
bindings:
  workspaceDir         工作区（相对定义目录）
  skills{}             { path, requires[] }；requires 非空的 Skill 本版不支持
  executions{}         { sandbox: "read-only", approvalPolicy: "never", nativeShell: false, nativeFileWrite: false }
```

### 3. 状态放在哪

| 位置 | 内容 |
|------|------|
| `.data/agent-descriptors/<哈希>.json` | 每个 Agent 版本的描述符（不含角色正文和密钥） |
| `.data/thread-agents.json` | 每个 Thread 绑定的 Agent 版本 |
| `.data/messages.json` | 任务记录，每条带提交时的 `agentHash` |

## 技术实现流程

### 启动

```text
new AgentDefinition()      读定义（≤1 MiB，不跟随链接）→ schema 校验 → 角色 → 执行策略 → Skill 绑定 → 内容哈希
prepareRun()               工作区取自定义；模型目录带上角色正文
agent.configure()          config.agent = agent
CodexConnection.open()
verifySkills()             skills/list → 不在定义里的关掉、在的打开 → 再列一次核对
agent.activate(skills)     生成描述符，写入 .data/agent-descriptors/
SessionService / MessageService …（同 s04）
```

### 每一轮发出前

```text
sessions.prepareInput(threadId, text, jobHash)
  agent.assertCompatible()   内容哈希未变；Thread 绑定的版本 = 当前版本；消息的 agentHash = Thread 的版本
  beforeTurn()               重新 verifySkills，有效集合必须与启动时一致
  agent.input(text)          文本 + 显式 $引用 的已启用 Skill
任一检查失败：这条消息 failed，队列暂停，不发给 Codex
```

## 核心代码

以下为伪代码，说明结构，不是逐行源码。

```js
// server/modules/agents/index.mjs（伪代码）
class AgentDefinition {
  constructor(file) {
    const definition = validateDefinition(JSON.parse(read(file)));   // 未知字段、放宽沙箱 → 抛错，服务不启动
    this.role = loadRole(resolveInside(definitionDir, definition.agent.instructions));
    this.execution = definition.bindings.executions[definition.agent.executionRef];
    this.skills = checkSkills(definition);                            // 必需缺失 → 抛错；可选缺失 → 警告
    this.expected = hash(definitionFile, roleFile, ...skillFiles);
  }
  assertCurrent() { if (hash(...) !== this.expected) this.revoked = true; if (this.revoked) throw AGENT_CHANGED; }
  activate(skills) { this.descriptor = { ..., skills, execution, hash: hash(descriptor) }; save(this.descriptor); }
  bind(threadId) { bindings[threadId] = this.descriptor.hash; }
  assertCompatible(threadId, jobHash) { this.assertCurrent(); require(bindings[threadId] === this.descriptor.hash && (!jobHash || jobHash === bindings[threadId])); }
}
```

## 验证

```bash
npm test          # 本机假 Codex，不调用模型
npm run check     # 校验配置与 Agent 定义，不启动 Codex
npm run check:server   # 启动 Codex、核验 Skill 并握手，不生成回答；需先停止本阶段的服务
npm run smoke     # 需先 npm run server；会调用真实模型
```

## 限制说明

| 限制项 | 说明 |
|--------|------|
| 一个服务一个 Agent | 每个服务实例只装配一份定义，支持多个会话 |
| Skill 依赖 | 只支持原生文本 Skill。定义里 `bindings.skills.<id>.requires` 非空（需要 shell、写文件或附件）时：必需 Skill 拒绝启动，可选 Skill 降级并记一条警告。Codex 发现清单里声明了额外工具依赖（`dependencies.tools`）的 Skill，不论必需还是可选，核验时都报错 |
| 不自动迁移 | 版本变化后旧会话不能继续，需新建会话；历史保留在 Codex 原生记录里 |
| 还没有工具 | 本阶段 Agent 不能读写资料或访问网页；角色正文也明确写了这一点，保存文件的规则留到下一章 |

## 机制实验

在本目录运行 `npm run lesson -- list` 查看课时，运行 `npm run lesson -- <id>` 读取问题、执行验证并观察断言结果。依赖与验证边界见 [实验说明](../lessons/README.md)。
