# s07 设计说明：原生记忆与服务端管控

> 本文是设计说明，供深入阅读。章节入门（要回答的问题 → 核心概念 → 分工 → 跑起来看看 → 关键代码）见 [README](../README.md)；工具相关的细节见 [s06 工具机制详解](../../s06-tools/docs/tools.md)。

本阶段是独立源码快照。服务监听 `127.0.0.1:4325`，本机开发，单用户，不做公网授权。

## 设计原理

s06 的 Agent 能读资料、写文章，但每个会话都从零开始。本阶段只加一个单元：**打开 Codex 的原生记忆，由 Codex 提炼和使用，由服务端决定开不开、读不读、哪些会话参与**。

三个设计约束：

- **默认关闭**：总开关 `AGENT_MEMORY_ENABLED` 默认 `false`；开了也只是"允许提炼"，不等于已经生成。
- **服务端说了算**：读不读、参不参与由环境变量与 Agent 定义共同决定；客户端只能查看状态、对单个会话提出参与设置，不能传路径、不能清空。
- **不假报**：启动时向 Codex 读回实际生效的配置，和服务端写入的逐项比对，不一致就拒绝启动。

## 架构改进

### 1. 新增模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 记忆服务 | [`server/modules/memory/index.mjs`](../server/modules/memory/index.mjs) | 启动时核对 Codex 实际配置；只读三个固定产物文件；处理单个会话的参与设置 |

其他模块配合记忆的部分：

- 配置模块解析 `AGENT_MEMORY_*`（总开关、读取、后台生成、提炼与合并模型、最小空闲小时数），非法值拒绝启动。
- Codex 配置的 `features.memories` 改为按总开关写入，并增加 `[memories]` 表；通用 shell 关闭时，召回细节使用 Codex 自带的受限记忆工具（`dedicated_tools`）。
- Agent 定义增加 `agent.memory`（`use`、`contribute`），描述符里记下生效的记忆配置。
- 会话模块在新建会话时调用 `thread/memoryMode/set`，按策略决定这个会话是否参与提炼。
- HTTP 增加 `GET /memory`、`GET /memory/summary`、`POST /memory/contribution`；客户端增加 `/memory`、`/memory show`、`/memory contribute on|off`。

### 2. 开关怎么叠加

README 里的"三道开关"（总开关、Agent 策略、会话参与）落到配置上是这几项：

| 项 | 来源 | 生效条件 |
|------|------|---------|
| 总开关 | `AGENT_MEMORY_ENABLED` | 默认 `false`；下面各项都要它开着才生效 |
| 读记忆 | `AGENT_MEMORY_USE` 与 `agent.memory.use` | 两者都为 true，且总开关开启 |
| 新会话默认贡献 | `AGENT_MEMORY_ENABLED` 与 `agent.memory.contribute` | 两者都为 true；`contribute: false` 不禁止读取，也不删除旧记忆 |
| 单个会话参与 | `POST /memory/contribution`（`/memory contribute on|off`） | 只改这个 Thread 之后是否参与提炼 |
| 后台生成 | `AGENT_MEMORY_GENERATE` | 受总开关约束 |

### 3. 状态放在哪

`agent.skills[].scope` 可选且仅允许 `system`，缺省补为 `system`；装配后的 Skill 与描述符记录有效 scope，不参与授权。

`config/tools/*.json` 的工具组 `scope` 可选且仅允许 `system`，缺省为 `system`；`GET /tools` 保留 `tools` 并新增 `groups`（配置相对路径 `id`、`scope`、已获准工具名 `tools`），授权仍由原白名单与门禁决定。

| 位置 | 内容 |
|------|------|
| `.data/codex/memories/` | Codex 生成的记忆产物；服务端只读 `memory_summary.md`、`MEMORY.md`、`raw_memories.md` |
| `.data/codex/config.toml` | 服务端写入的记忆配置 |

## 技术实现流程

### 启动

```text
loadServerConfig()      解析 AGENT_MEMORY_*；非法值拒绝启动
agent.configure()       与 agent.memory 取交集，得到生效的 use / contribute
prepareCodexConfig()    写入 features.memories 与 [memories]
CodexConnection.open()
memory.verify()         config/read 读回实际配置，逐项比对，不一致就拒绝启动
                        通用 shell 与写文件关闭时，标记"后台合并写不出最终摘要"
```

### 会话参与设置

```text
新建会话                 thread/memoryMode/set：按生效的 contribute 设为 enabled / disabled
POST /memory/contribution { threadId, enabled }
  1. 只接受这两个字段，threadId 格式合法、enabled 是布尔值      否则 400
  2. 要开启时：总开关已开                                      否则 409
  3. 要开启时：Agent 策略允许贡献                              否则 409
  4. sessions.ensure()：会话属于本项目、Agent 版本兼容          否则拒绝
  5. 在会话边界内：这个会话没有正在执行的一轮                  否则 409
  6. 调用 thread/memoryMode/set
```

## 核心代码

以下为伪代码，说明结构，不是逐行源码。

```js
// server/modules/memory/index.mjs（伪代码）
class MemoryService {
  async verify() {
    const actual = await rpc.request("config/read");
    if (!matches(actual, written)) throw Error("Codex 记忆配置与服务端配置不一致");   // 逐项比对，含 dedicated_tools；不假报开启
    this.generationBlocked = shellOff(actual) && applyPatchOff(actual);
  }
  snapshot() { return { effective, artifacts: readFixedFiles(), generationWarning }; }   // 只读三个固定文件
  async contribute(threadId, enabled) {
    require(validId(threadId) && typeof enabled === "boolean");
    if (enabled) require(memory.enabled && agentAllowsContribute);          // 409
    await sessions.ensure(threadId);                                        // 属于本项目、版本兼容
    atTurnBoundary(() => { require(!activeTurn(threadId));                  // 409
      rpc.request("thread/memoryMode/set", { threadId, mode }); });
  }
}
```

## 验证

```bash
npm test                  # 本机假 Codex，不调用模型
npm run test:codex-tools  # 真实 Codex + 本地模拟模型：工具闭环
npm run test:codex-memory # 真实 Codex + 本地模拟模型：原生提炼、参与设置持久化、摘要注入与读取开关
npm run check             # 校验配置与 Agent 定义，不启动 Codex
npm run smoke             # 需先 npm run server；会调用真实模型
```

## 限制说明

| 限制项 | 说明 |
|--------|------|
| 不是即时保存 | 原生后台按空闲时间等条件提炼，不是每轮结束就生成 |
| 合并摘要受限 | 本阶段关闭了原生 shell 和写文件工具，Codex 0.154.0 的后台合并写不出最终摘要，`/memory` 会如实报告 |
| 不能清空 | 不提供清空或任意路径读取接口 |
| 单机单用户 | 记忆存在本服务的状态目录，不区分用户；多用户见后续阶段 |

## 机制实验

在本目录运行 `npm run lesson -- list` 查看课时，运行 `npm run lesson -- <id>` 读取问题、执行验证并观察断言结果。依赖与验证边界见 [实验说明](../lessons/README.md)。
