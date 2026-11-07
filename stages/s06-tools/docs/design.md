# s06 设计说明：工具、资料边界与 MCP 回调

> 本文是设计说明，供深入阅读。章节入门（要回答的问题 → 核心概念 → 分工 → 跑起来看看 → 关键代码）见 [README](../README.md)；工具逐项说明见 [工具机制详解](tools.md)。

本阶段是独立源码快照。服务监听 `127.0.0.1:4324`，本机开发，单用户，不做公网授权。

## 设计原理

s05 的 Agent 有了角色和工作方法，但碰不到任何资料。本阶段只加一个单元：**由配置装配工具，经 MCP 交给 Codex 调用，每次调用都核对白名单、参数和资料权限**。

三个设计约束：

- **工具来自配置**：工具的名字、参数 schema 和实现写在 `config/tools/`，启动时装配成注册表；新增工具不改主程序。
- **执行前先核对**：Agent 定义里的 `tools.allow` 决定能用哪些；名单外的名字、不合法的参数在执行前就被拒绝，实现不会被调用。
- **资料按用途授权**：读取由 `dataBindings` 授权；新建来自 `dataBindings` 的 `create` 或 `outputs` 产物规则；新建文件不覆盖，原始资料只读。Codex 原生的 shell 与写文件仍然关闭，资料只能经由这些工具访问。

## 架构改进

### 1. 本阶段的模块

| 模块 | 文件 | 职责 |
|------|------|------|
| 工具注册表 | [`server/modules/tools/loader.mjs`](../server/modules/tools/loader.mjs) | 读取 `config/tools/*.json`，配对实现、编译参数 schema，生成工具代码快照；核对名单与参数后执行 |
| 工具管理 | [`server/modules/tools/index.mjs`](../server/modules/tools/index.mjs) | 启动 MCP 入口、写入 Codex 配置、核验 Codex 发现的工具；工具目录变化时在空闲边界更新 |
| MCP 入口 | [`server/modules/tools/mcp-server.mjs`](../server/modules/tools/mcp-server.mjs) | 只监听回环地址、带随机令牌、拒绝跨源请求；把 `tools/list`、`tools/call` 转给注册表 |
| 工具实现 | [`server/modules/tools/files.mjs`](../server/modules/tools/files.mjs)、[`web.mjs`](../server/modules/tools/web.mjs) 等 | 文件读写、公开网页读取 |
| 资料边界 | [`server/modules/data/files.mjs`](../server/modules/data/files.mjs) | 四个资料目录的路径解析、读/新建授权、格式与大小检查、不覆盖写入 |
| 执行边界 | [`server/modules/agents/boundary.mjs`](../server/modules/agents/boundary.mjs) | 新建/恢复会话、开始新一轮与工具更新共用一把锁，不在任务中途换工具 |
| 工具配置 | [`config/tools/`](../config/tools/) | `files.json`（`list_files`、`read_file`、`write_file`）、`web.json`（`read_webpage`） |

其他模块配合工具的部分：

- Agent 定义的 schema 增加 `agent.tools.allow`、`agent.dataBindings`、`agent.outputs`、`bindings.sources`；描述符增加工具版本、允许名单、资料绑定和产物规则；角色后面附加一段"有效资源规则"，告诉模型各目录的实际权限。
- 会话模块记录每一轮的工具调用（`turn.tools`）和可信的新建产物（`turn.artifacts`），产物只来自 `write_file` 的成功结果，不从模型回答里猜。
- HTTP 增加 `GET /tools`、`GET /workspace`、`GET /workspace/read`；客户端增加 `/tools` 命令和工具状态显示。
- 运行目录清理认得本次运行的工具代码快照（`.runs/app-server-*/tools-*`）。

### 2. 定义里新增的字段

`agent.skills[].scope` 可选且仅允许 `system`，缺省补为 `system`；装配后的 Skill 与描述符记录有效 scope，不参与授权。

`config/tools/*.json` 的工具组 `scope` 可选且仅允许 `system`，缺省为 `system`；`GET /tools` 保留 `tools` 并新增 `groups`（配置相对路径 `id`、`scope`、已获准工具名 `tools`），授权仍由原白名单与门禁决定。

```text
agent:
  tools.allow[]        能用的工具名
  dataBindings[]       { sourceRef, actions: read | create, methods: files, required }
  outputs              { directory, formats: md | txt, writeMode: create-only, requiredChecks }
bindings:
  sources{}            { type: files, root }：originals → inputs、research、drafts、articles → outputs
```

### 3. 状态放在哪

| 位置 | 内容 |
|------|------|
| `workspace/inputs`、`research`、`drafts`、`outputs` | 资料与产物（工作区由 `bindings.workspaceDir` 决定） |
| `.runs/app-server-*/tools-*/` | 本次运行使用的工具配置与实现快照 |
| `.data/codex/config.toml` | 写入 MCP 入口地址；令牌只经环境变量传给 Codex，不写进配置 |

## 技术实现流程

### 启动

```text
new AgentDefinition()      同 s05，另校验工具名单、资料绑定与产物规则
createFileTools()          按 dataBindings 建立资料边界
ToolManager.open()         读 config/tools → 快照 → 注册表（必需工具未注册即失败）→ 启动 MCP 入口
prepareCodexConfig()       把 MCP 入口写进 Codex 配置
CodexConnection.open()
tools.verify()             本项目入口发现成功、工具名与注册表一致，且没有其他提供工具的 MCP 入口，否则拒绝运行
agent.activate(version)    描述符带上工具版本
```

### 一次工具调用

```text
模型决定调用 read_file
  → Codex 经 MCP 发 tools/call（带令牌）
  → 注册表 validate：名字在名单里？参数符合 schema？
  → 资料边界：路径在四个目录内？这个目录允许读 / 新建？格式、大小、链接检查
  → 执行实现，结果以 JSON 文本交回 Codex
  → 会话记录 turn.tools；write_file 成功时登记 turn.artifacts
名单或参数校验失败：不调用实现，直接返回错误结果
实现内部的检查（路径、权限、格式、大小）失败：返回错误结果；写入后的产物检查发生在文件创建之后
```

## 核心代码

以下为伪代码，说明结构，不是逐行源码。

```js
// server/modules/tools/loader.mjs（伪代码）
registry.call({ tool, arguments: args }) {
  if (!allowed(tool)) return error("未授权的工具。");          // 名单外：不执行
  if (!schema[tool](args)) return error("工具参数不合法");      // 参数不对：不执行
  return ok(await implementation[tool](args));
}

// server/modules/data/files.mjs（伪代码）
write_file({ path, content }) {
  require(writable(path));                 // dataBindings 里允许 create，或在 outputs 目录
  require(format ∈ outputs.formats && size ≤ 256 KiB);
  writeFile(resolveInsideAreas(path), content, { flag: "wx" });   // 已存在就失败，不覆盖
}
```

## 验证

```bash
npm test                 # 本机假 Codex，不调用模型
npm run test:codex-tools # 真实 Codex + 本地模拟模型：MCP 文件闭环、重启恢复与清理、Skill 核验
npm run check            # 校验配置、Agent 定义与工具配置，不启动 Codex
npm run tools -- read "https://文章地址"   # 单独试网页读取工具（不经模型）
npm run smoke            # 需先 npm run server；会调用真实模型
```

## 限制说明

| 限制项 | 说明 |
|--------|------|
| 文件格式 | 只支持 `.md` / `.txt`，单个文件最大 256 KiB |
| 不覆盖 | 新建文件已存在时失败，需另存新版本；本阶段不做文件的版本登记（见 s08） |
| 网页读取 | 只读静态正文，不执行 JavaScript，不访问本机和内网地址，不读 PDF；网页内容是不可信资料 |
| 工具更新 | 删除、禁用工具立即限制后续调用；新实现等活动轮次和工具调用结束后再切换；版本变化后旧会话需新建 |
| 还没有记忆 | Codex 原生记忆保持关闭，见下一章 |

## 机制实验

在本目录运行 `npm run lesson -- list` 查看课时，运行 `npm run lesson -- <id>` 读取问题、执行验证并观察断言结果。依赖与验证边界见 [实验说明](../lessons/README.md)。
