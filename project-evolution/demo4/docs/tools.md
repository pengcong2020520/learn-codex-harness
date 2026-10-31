# Demo 3 工具机制详解

> 本文是 Demo 3 的工具专题文档，只解释当前独立代码副本中已实现的工具机制，不涉及其他 demo 的实现细节。[返回 Demo 3 总览](../README.md)

## 设计原理

Demo 3 的工具系统围绕一个核心问题展开：如何让远端语言模型安全、可控地操作本地文件和网络资源？

Demo 3 把工具作为受版本管控的服务端能力：模型决定何时调用，程序负责检查权限并执行。当前范围是单机单用户、每服务实例一个 Agent 多 Thread，不是多租户安全隔离方案。

数据层升级后，正常服务注入的是 `data/resources.mjs`，再复用 `data/files.mjs` 的底层路径检查。前者增加 PostgreSQL 归属、资料 ID、版本、来源失效检查及正文快照；下文底层文件伪代码不代表完整持久化流程，详见 [数据层说明](data-layer.md)。`read_file` 额外返回 `resourceId` / `versionId`；`write_file` 可选 `source_versions: [{resourceId, versionId}]` 登记引用，不增加自动分类工具。

这意味着以下几点在设计上明确分离：

**自然语言提示词不是工具注册。** 在对话中告诉模型"你可以读取文件"，不会让 `read_file` 工具出现在工具清单里。工具注册发生在服务启动时，由配置文件和代码模块共同决定，提示词只影响模型如何使用已注册的工具。

**注册不等于授权。** 工具被扫描、加载并出现在工具管理器中，不代表当前 Agent 可以调用它。每次工具调用都经过两道门：第一道是 `registry.specs` 只向当前 Agent 暴露 `agent.tools.allow` 与已启用清单的交集；第二道是 `registry.call` 在实际执行前再次核验 Agent 定义是否撤销了该工具、工具是否仍在启用状态以及参数是否符合 schema。

**文件分类规则不是程序强制分类。** 角色文件 [agents/roles/writing-assistant.md](../agents/roles/writing-assistant.md) 里的保存分类规则是给模型读的语义指导，告诉模型在什么情况下把文件放在哪个目录。决定最终路径的是模型在生成 `write_file` 调用时填写的 `path` 参数。`write_file` 本身不做语义分类，也不存在独立的分类模块。

**工具更新不代表旧 Thread 无缝兼容。** 工具版本通过哈希名称和内容生成，Thread 绑定 Agent 描述符，其中记录了当前工具版本。热更新后已有 Thread 在下一轮调用时会遇到版本不匹配，需要用 `/new` 开启新对话。

## 架构改进

本版工具模块有三项主要架构安排：

**配置与实现分离。** 每个工具组有对应的 JSON 清单文件（`config/tools/files.json`、`config/tools/web.json`），声明工具的名称、描述、参数 schema 和 readOnly 注解；具体实现在 `server/modules/tools/` 下的 `.mjs` 模块。两者通过清单中的 `module` 字段关联。修改描述不需要动实现代码，修改实现不需要改其他工具的清单。

**MCP 协议作为调用通道。** 模型通过 Codex 客户端经 MCP（Model Context Protocol）调用工具，而不是直接调用服务端函数。`server/modules/tools/mcp-server.mjs` 在本地 `127.0.0.1` 随机端口启动一个 loopback HTTP 监听，Codex 作为 MCP 客户端连接。这一层将调用协议与实现解耦，但不是操作系统安全沙箱。

两种连接不要混淆：自己的 Node 服务通过 stdio JSON-RPC 控制本机 Codex App Server；Codex 再通过本地 HTTP MCP 调用 Node 服务提供的工具。项目工具服务器不等于 App Server，也不是远端模型服务器，无需暴露到公网。新 Thread 使用 MCP；`server/main.mjs` 中的 `rpc.toolHandler` 只是兼容历史 `dynamicTools` 的入口，旧会话能否继续仍受描述符检查限制。

**工具版本快照与空闲切换。** `ToolManager` 负责维护工具版本快照、每秒扫描变更、管理 MCP 连接配置，以及在空闲边界执行切换与回滚。已授权工具实现的正常更新不会在活动 turn 中途切换，需等待空闲；禁用工具对后续调用的限制另见更新边界。

MCP 入口使用随机 Bearer 令牌，只监听本机临时端口，拒绝带 Origin 的请求，按 `/<version>` 区分工具快照。`PROJECT_MCP_TOKEN` 经子进程环境传入，生成配置只记录变量名；它与模型 API Key、CLI 连接令牌用途不同。请求体上限为 1 MiB，单次 MCP 调用设置 30 秒取消信号。无需逐次批准已允许的工具，不等于开放任意操作。`readOnly` 是协议注解，实际权限仍由代码检查。

## 技术实现流程

### 启动流程

```
server/main.mjs 入口
  → 载入 agents/writing-agent.json（Agent 定义、allow 列表、权限绑定）
  → 准备受限文件服务，注入 Agent 的资料与产物权限
  → tools/loader.mjs 扫描 config/tools/ 内 .json 和 tools/ 内 .mjs
     └─ 校验清单与参数 schema / 计算版本 / 建立快照 / 加载 factory
  → ToolManager 启动本地 MCP HTTP 服务器
  → server/modules/codex/config.mjs 生成 .data/codex/config.toml
     └─ PROJECT_MCP_TOKEN 写入子进程环境变量（不在配置文件明文）
  → codex/connection.mjs 按 launch.mjs 生成的参数启动 Codex stdio App Server
     └─ 内置 shell / apply_patch / web_search 等关闭
  → mcpServerStatus/list 分页核验 project_tools 工具名称完全一致
     └─ 若发现其他带工具的 MCP 服务器，也拒绝就绪
  → agents/index.mjs 生成 Agent 描述符；后续 Thread 绑定此版本
  → 产品 HTTP 就绪，开放客户端连接
```

### 调用流程

```
CLI 发送消息
  → 产品 HTTP 消息队列 → turn/start
  → Codex 请求接入的大模型，模型决定是否调用工具及参数
  → Codex 经 MCP tools/call → mcp-server.mjs 接收
  → registry.call 二次校验（允许？启用？参数合法？）
  → 工具实现（files.mjs / web-tools.mjs）执行
  → 结果返回 Codex → 模型继续推理或结束
  → AppServer 通知 → SessionService → SSE → CLI 显示
```

Node 服务端没有另写 ReAct 推理循环：Codex 原生引擎负责循环调度，接入的大模型（可以是配置的第三方模型）负责决策，项目工具执行具体动作。

MCP SDK 将 `tools/list` 转给 `registry.specs`，将 `tools/call` 转给 `registry.call`；返回的 `success` 取反成为 MCP 的 `isError`，结果以 JSON 文本交回 Codex。App Server 的 `item/started`、`item/completed` 通知携带 `mcpToolCall`，会话模块更新 `turn.tools`；只有成功的 `write_file` 结果包含 `created: true` 和 `artifact` 时，才登记 `turn.artifacts`，不从模型回答中猜测文件存在。

### 更新流程

```
已授权工具的实现或清单变更落盘（未修改 Agent 定义）
  → ToolManager 每 1 秒检查变更
  → 当前有活动 turn 或工具调用 → 标记 pending，等待空闲
  → 空闲边界：build candidate（重新扫描 / 校验 / 构建版本快照）
  → config/value/write 推送新 MCP 配置
  → config/mcpServer/reload 触发 Codex 端重载
  → mcpServerStatus/list 核验工具清单完全一致
  → agent.activate 发布新描述符
  → 成功：候选版本生效；失败：保留或回滚旧版本
     └─ 回滚也失败则 unavailable，阻止新任务
  → 旧 Thread 描述符版本不匹配 → 需 /new 开启新对话
```

## 核心代码

以下伪代码说明三个关键逻辑，**不是可直接复制的完整实现**，仅用于理解结构。

官方接口说明确认，`config/mcpServer/reload` 重读 MCP 配置并为已加载 Thread 排队刷新，`mcpServerStatus/list` 用于查看工具清单；是否允许继续旧会话，由本项目的版本规则另行决定。[Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)

以下以本 demo 锁定的 `@openai/codex 0.154.0` 和本地实现为准，不把其他版本的新接口当作已经接入。

工具清单使用严格 JSON，不支持注释。加载器递归收集配置和实现，拒绝软链接、越界模块、重名和缺失处理函数；单个扫描文件不超过 1 MiB，最多收集 200 个文件。生成的 `.data/codex/config.toml` 是运行产物，不是手工维护工具清单的入口。

### 1. 注册加载与双重门控

```
// loader.mjs：伪代码，省略错误封装
source = scan(config/tools 中的 JSON, server/modules/tools 中的 MJS)
version = hash(全部扫描文件的路径与内容)
for each enabled manifest:
  validate fields (enabled, module, factory?, tools[])
  validate tool names, duplicates, parameter schemas with Ajv
  ensure module 位于 server/modules/tools 且已被扫描
writeVersionSnapshot(source)  // .runs/app-server-*/tools-*
for each group containing allowed tools:
  module = import(snapshot/group.module)
  handlers = module[group.factory or "createTools"]({files, root, nodeEnv, runWeb})
  verify declared handlers exist
ensure every agent.tools.allow entry is registered

// registry.specs —— 向 Codex 暴露可见工具
specs = currentSnapshot.tools.filter(t =>
  agent.tools.allow.includes(t.name) &&
  currentEnabledNames.has(t.name)
)

// registry.call —— 执行前再次核验
call(toolName, args):
  agent.assertCurrent()  // Agent 定义、角色、Skill 不能已变更
  if not agent.tools.allow.includes(toolName): reject "not authorized"
  if not currentEnabledNames.has(toolName):   reject "tool disabled"
  if not schema.validate(args):         reject "invalid params"
  return handlers[toolName](args)
```

### 2. write_file 调用中的分类逻辑位置

```
// 接入的大模型生成工具调用，本地程序不做语义分类
// 角色规则已作为基础指令注入，模型据此决定 path

model decides:
  path = "outputs/notes/check001.txt"   // 模型生成，非程序分类
  content = "..."

// mcp-server.mjs 接收后转给 registry.call
// files.mjs 实现中的检查（伪代码）
write_file({path, content}):
  data/files.mjs 统一检查:
    拒绝绝对路径 / ".." / 隐藏路径 / 反斜杠
    拒绝不支持扩展名（仅 .md / .txt）
    拒绝超过 256KiB
    拒绝符号链接 / 硬链接
    检查资料创建权限或 agent.outputs 产物目录是否允许写入
  安全解析路径并创建获准父目录（如 outputs/notes/）
  write(resolvedPath, content, flag = "wx")   // 不覆盖已有文件
  检查实际文件，生成内容哈希与扩展名记录
  返回 { path, bytes, created, artifact: { locator, revision, format, checks } }
  // checks 为 file-exists / format，不验证事实或文章质量
```

### 3. 更新候选构建与版本感知

```
// ToolManager 空闲边界
onIdleWindowOpen():
  if not pendingUpdate: return
  candidate = loader.scan()          // 重新扫描 / 校验
  if candidate.error:
    log error, retain current version
    return
  mcpServer.reload(candidate.config) // 推送新配置
  status = codex.mcpServerStatus()
  if status != "ready" or list != candidate.toolNames:
    rollback()
    if rollback fails: set unavailable
    return
  agent.activate(newDescriptor)
  // 旧 Thread 持有旧描述符版本
  // 下一轮调用版本不匹配 → 拒绝继续 → 用户需 /new
```

## 文件权限与自动归类

### 工作区目录结构

配置中的 `bindings.workspaceDir` 是 `"../workspace"`，相对 `agents/writing-agent.json` 所在的 `agents/` 目录解析，因此默认实际位置是 `demo3/workspace/`，不是 `agents/workspace/`，也不是 `.runs/`。操作发生在连接到的服务端工作区；客户端从哪个目录启动不决定落盘位置。默认权限如下：

同一服务的多个 Thread 共用这个工作区，并非每个 Thread 独立一份文件目录。

| 目录 | 读 | 新建 | 说明 |
|------|-----|------|------|
| `inputs/` | ✓ | ✗ | 只读素材，不能写入 |
| `research/` | ✓ | ✓ | 研究过程中的证据和笔记 |
| `drafts/` | ✓ | ✓ | 中间稿件 |
| `outputs/` | ✓ | ✓（由 agent.outputs 授权）| 最终交付物 |

`articles` 数据源通过独立 binding 授予读取权限；去掉该 binding 不会自动影响 `outputs` 的写入权限，读取来自 `agent.dataBindings` 中的 `articles` 绑定，创建来自 `agent.outputs`。`articles` 是指向 `outputs/` 的来源 ID，不是另一个目录。

### 路径检查层次

权限检查统一由 `server/modules/data/files.mjs` 执行，按操作类型检查以下边界；列目录不会被当成读写文本文件：

1. 路径格式合法：不含绝对路径、`..`、隐藏路径（`.`开头）、反斜杠
2. 读写文件仅允许 `.md` 和 `.txt`；读取要求普通 UTF-8 文本文件
3. 读写文件大小 ≤ 256 KiB；读取的 `max_chars` 还可能进一步截断返回文本
4. 不通过符号链接访问；读写拒绝硬链接文件，目录列表中的链接不能据此读取
5. 列出和读取受资料读取范围约束；新建受资料创建范围或产物目录约束

`files.mjs` 工具工厂复用注入的文件服务，不为每个工具单独维护路径逻辑。Codex 的原生 shell、apply_patch 被关闭，原生只读沙箱不替自定义 MCP 文件工具检查写入权限，`cwd` 也不是访问控制。工具模块属于部署者信任的代码，不能从网页或模型输出自动安装任意实现。

### 分类规则的真实位置

保存分类规则的文字写在 `agents/roles/writing-assistant.md` 里，作为角色基础指令的一部分注入模型。当前规则要点：

- 用户指定了合法目录或路径的，优先遵从
- 未指定目录（包括只给文件名）时，按用途判断：research（研究证据）/ drafts（中间稿）/ outputs（用户明确要求的最终交付）/ outputs/notes（普通记录、测试、难归类的文件）
- 按上下文任务阶段判断，不按关键词匹配
- 普通原文保存不多余追问、保持原文、不额外搜索；确实影响最终交付阶段的歧义才简短确认
- 失败时不假装已保存
- 文件名重复时使用新版本，不覆盖

`write_file` 工具不执行语义分类，也不调用额外模型。分类只发生在模型决定 `path` 参数的阶段。模型生成的路径不能保证每次都正确分类；已有文件不会因规则更新而自动迁移。

修改角色文件后，`agents/index.mjs` 检测到 `sourceHash` 变更，拒绝后续调用。需要受控重启服务并在客户端执行 `/new`，旧 Thread 历史留存但不能继续。

## 网络工具边界

### 工具清单

| 工具 | 作用 | 限制 |
|------|------|------|
| `search_web` | 抓取 Google 公开结果 HTML | 非官方付费 API；Google 布局变化可能失效 |
| `read_webpage` | 读取公开静态 HTML / 纯文本 | 不执行 JS，不登录，不解析 PDF/Word |

### 固定子进程调用

网络工具通过固定子进程调用实现，核心在 `server/modules/tools/web-tools.mjs`：

```
execFile(process.execPath, [固定 web-cli 路径, action, ...参数], {
  shell: false,          // 不走 shell，输入不被解释为命令
  env: { NODE_ENV },     // 不继承 API 密钥等环境变量
  timeout: 25000,
  maxBuffer: 512KiB
})
```

`shell: false` 使搜索词作为参数传入，不会作为 Shell 命令执行；子进程 `env` 只传 `NODE_ENV`，不会继承模型 API Key。这不是操作系统级进程隔离，也不代表整个宿主环境已完成安全验收。

### 速率限制与并发

- 搜索结果缓存 10 分钟，最多 50 项（按参数，单工具实例内）
- 非缓存搜索之间间隔 3 秒
- 搜索失败后暂停搜索重试 60 秒
- 每实例最多 2 个并发网络任务，超出返回错误，不排队等待

这是进程内限速，不是持久化缓存或分布式限流。

### HTTP 访问规则

`server/modules/tools/public-web.mjs` 对每个 URL 执行：

- 只允许公开 HTTP/HTTPS 网站的标准端口，拒绝本机、内网及保留地址
- 不内嵌账号、不持有 Cookie
- DNS 结果校验，连接固定解析 IP
- 重定向最多 3 次，每次重新校验
- 响应体 ≤ 2 MiB，抓取超时约 20 秒
- 支持未压缩 HTML 和 plain text，不支持压缩编码

默认本机调试环境允许 HTTPS 域名经代理 Fake-IP 映射，`NODE_ENV=production` 时关闭此例外。这不是生产级 SSRF 隔离，不适合用于多租户安全评估。

### search_web 参数说明

`query` 最大 1000 字符，`limit` 范围 1–10，默认 5。`site:`、引号、`filetype:`、`after:` 等 Google 搜索语法可作为普通查询词原样传入 URL，但能否生效取决于 Google 当前的响应。

搜索返回的是摘要（title / url / snippet / 时间），不等于读取了原文。`filetype:pdf` 能搜到 PDF 链接，但 `read_webpage` 不解析 PDF。这些是本项目网络工具的实现限制，不是 Codex 内置 `web_search` 的能力说明。

## 工具扩展与更新

### 当前五个工具一览

| 工具名 | 作用 | 关键参数 | 真实限制 |
|--------|------|----------|----------|
| `list_files` | 列出工作区目录内容 | `path?`（默认根目录） | 单层不递归，最多 200 项；read 权限过滤，不是全盘查找 |
| `read_file` | 读取文件文本内容 | `path`, `max_chars?`（默认 20000，最大 40000） | 仅 .md/.txt，≤ 256 KiB；截断不等于全文已读；返回 sourceId、locator、revision 哈希及 updatedAt |
| `write_file` | 新建文件 | `path`, `content` | 仅 .md/.txt，≤ 256 KiB；不覆盖已有文件（wx 模式）；无 category 参数 |
| `search_web` | 抓取 Google 结果 | `query`, `limit?`（1–10，默认 5） | 非官方 API；可能失效；摘要非原文 |
| `read_webpage` | 读取网页正文 | `url`, `max_chars?`（默认 16000，最大 40000） | 纯静态 HTML/text；不执行 JS；不解析 PDF/Word |

### 添加新工具的步骤

> 以下为步骤说明，本次不实际添加新工具。

**第一步：实现模块**

在 `server/modules/tools/` 下新建 `.mjs` 文件，导出 `createTools` 函数（默认函数名），返回 `{ toolName: handlerFunction }` 的映射。涉及文件操作时，通过 `createTools({ files })` 复用已注入的受限文件服务，不在版本快照模块中重新实现或绕过权限检查。无需修改 `main.mjs` 或增加主分发 switch。

**第二步：编写清单**

在 `config/tools/` 下新建或更新 `.json` 文件，声明 `enabled`（组开关）、`module`（指向上一步的实现文件）、可选的 `factory`（默认 `createTools`）和 `tools` 数组，每项包含 `name`、`label`、`description`、`readOnly`、`inputSchema`（Ajv 兼容的 JSON Schema）。字段必须严格合法，未知字段会被拒绝。

**第三步：授权**

在 `agents/writing-agent.json` 的 `agent.tools.allow` 数组中加入新工具名。

**第四步：验证与启动**

先用单元测试验证实现（`npm test`）。因为新增工具修改了 Agent 的 `allow`，必须受控重启服务，再在客户端执行 `/new`；用 `/tools` 核对清单，最后验证一次实际调用。不能把“新增工具”当成仅修改已有实现的空闲更新。

注意：如果新工具出现在 `allow` 中但未成功注册，候选构建会失败，服务不会静默就绪。

### 禁用已有工具

停止服务后，从清单的 `tools` 数组中移除对应条目；若要停用整组，可将该清单的 `enabled` 设为 `false`。同时从 `agent.tools.allow` 移除对应名称，重启并 `/new`。`enabled` 是组级字段，不是单个工具项的字段。如果只禁用清单而不同步修改 `allow`，由于 `allow` 引用了未注册工具，候选构建会失败。

### 热更新的版本边界

工具实现或清单变更落盘后，`ToolManager` 每 1 秒安排一次扫描，实际处理可能等待边界锁，不保证一秒内完成更新。如果当前没有活动的 turn 或工具调用，更新立即进入候选构建流程；否则标记 pending，等待空闲窗口。

候选版本先通过 `config/value/write` 更新配置，再通过 `config/mcpServer/reload` 重载，`mcpServerStatus/list` 核验通过后新描述符发布。此时已有的旧 Thread 持有旧版本描述符，下次调用时版本不匹配会被拒绝，用户需执行 `/new` 开启新对话。这不是旧会话的无缝热加载，而是有版本校验的更新。

`turn/start` 与刷新共用短边界锁，避免多个窗口在“检查空闲”之后抢先启动下一轮。清单删除或禁用工具会在每次 `list` / `call` 时收紧旧快照的后续访问，不等空闲切换，但不能据此声称已开始的调用会被撤回。若 `allow` 仍引用被删工具，候选构建仍会失败；需同步配置并重启。修改 Agent 定义、角色或 Skill 则走变更拒绝机制，不属于普通工具实现热更新。

## 验证与排错

### 启动验证

```bash
# 从 repo 根目录进入 demo3
cd project-evolution/demo3

# 首次安装依赖
npm ci

# 准备环境变量（.env 已存在则跳过，不要覆盖）
test -f .env || cp .env.example .env
# 编辑 .env，填写 CODEX_API_KEY / CODEX_BASE_URL / CODEX_MODEL
# 按 .env.example 配置时，demo3 端口为 4313，与 project 的 4317 区分
# 不要使用 OPENAI_API_KEY

# 启动服务（终端 1）
npm run server

# 启动客户端（终端 2，同目录）
npm start
```

服务就绪后，在客户端输入 `/tools` 查看工具管理状态和名称列表。这是 CLI 命令，不是 shell 命令。`/tools` 只验证已注册的工具名称；实际调用结果和文件系统状态才能验证工具是否正确执行。

如果已运行的服务修改过角色或 Agent 配置，先重启服务再 `/new` 开启新对话，再测试。

### 功能验证用例

以下用例给出预期，实际结果以服务响应为准，非事先实测结论。测试只使用验证文件；重复执行时换新文件名，避免与防覆盖规则冲突。

**正常路径：**

> 列出 inputs 目录的文件

预期：`list_files` 调用，返回 `inputs/` 下文件列表，仅 read 权限范围内的条目。

> 请把“这是一个验证文件，验证代码check001”原样保存下来，文件名叫 check001.txt，不指定目录。

预期：模型按角色规则判断为普通记录，生成 `write_file({path: "outputs/notes/check001.txt", content: "这是一个验证文件，验证代码check001"})`，首次写入时自动创建 `outputs/notes/` 子目录，返回含 `created: true` 和 `artifact` 的结果。

> 用工具读一下刚才保存的 check001 文件

预期：`read_file` 调用，返回文件内容、`revision` 哈希和 `updatedAt`。工具读取结果是事实依据，不能用模型回忆替代。

> 请实际搜索 site:developer.mozilla.org Promise，找两条结果，再调用网页读取工具读取第一条实际链接，把来源和研究记录保存下来。搜索或读取失败就如实说明，不要编造。

预期：先出现 `search_web`，再出现 `read_webpage`；在成功取得资料时，研究记录应保存到 `research/`。结果数量和内容取决于网站当时响应；摘要不能冒充正文。

> 基于刚才成功读取的研究资料写一份初稿，并保存为新文件；还没有资料时请先说明。

预期：模型生成内容，`write_file` 写入 `drafts/` 目录。

> 把这份稿件作为最终版本保存

预期：模型识别为"用户明确要求的最终交付"，写入 `outputs/` 目录。

> 把测试内容保存到 drafts/test.txt

预期：用户显式指定路径，模型优先遵从，写入 `drafts/test.txt`。

**越界拒绝：**

> 覆盖已有的 outputs/notes/check001.txt

预期：原文件不被覆盖；如果模型确实调用原路径，工具会返回“文件已存在，未覆盖”。模型也可能先拒绝，或建议新版本文件名，不能把模型的口头拒绝当作已触发服务端拦截。

> 写入 inputs/test.txt

预期：`inputs/` 目录 binding 只有 read 权限，写入被 `data/files.mjs` 拒绝，返回权限错误。

> 写入 ../outside-check.txt（工作区外）

预期：工作区外不会生成文件；工具的授权范围检查或路径校验会拒绝该路径。

> 写入 outputs/test.json

预期：`.json` 不在允许扩展名列表内，被拒绝。

> 读取 http://127.0.0.1/

预期：`public-web.mjs` 校验 IP，loopback 地址被拒绝，返回错误。生产环境下 SSRF 规则更严格。

> 执行 Bash pwd 命令

预期：没有 `bash` / `shell` 工具在 `allow` 列表中，`registry.specs` 不会暴露该工具，模型调用会被拒绝或模型自行不发起调用。模型自述拒绝不等于服务端校验证据，服务端覆盖由单元测试验证。

### 网络工具直连诊断

以下命令直接调用本地网络 CLI，绕过模型、MCP 和 ToolManager 的缓存限速，仅用于诊断网络层是否可用，不是端到端测试或权限验证：

```bash
# 搜索（3 条结果）
npm run tools -- search 'site:developer.mozilla.org Promise' 3

# 读取网页（最多 2000 字符）
npm run tools -- read 'https://example.com' 2000
```

执行需要网络连通。Google 结果可访问性无保障，空结果可能是确实无匹配；报错需区分连通性、限流、验证码、HTML 布局变化和响应格式。直连诊断成功也不能证明 Agent 授权与 MCP 接入正常。

### 测试套件

```bash
# 运行项目测试套件（含 role / agent-core / tools 等模块测试）
npm test

# 运行真实本地 Codex + 模拟 Responses 集成测试，不读取真实 .env / API Key
# 含文件读写 / 重启 / artifact / 角色版本等场景
npm run test:codex-tools
```

集成测试使用本地 fake 响应，不调用真实 DeepSeek/Google，不验证语义分类正确性。`npm test` 包含 fixtures，测试通过不等于模型在实际对话中的分类行为完全正确。

文档验证：在 demo3 目录运行 `node ../verify.mjs --docs-only`，检查演进 README 的结构和链接；这个脚本不会递归检查本工具专题，本文的链接需另行检查。`--docs-only` 不更新 `verification.json`，单独运行 `npm test` 和集成测试也不更新该汇总记录。

协议日志位于 `.runs/app-server-*/protocol.jsonl`；当前任务输入存 PostgreSQL，旧 `.data/messages.json` 原件也可能含用户文本。脱敏不等于没有隐私内容，排错只分享必要片段，不公开完整日志或真实密钥。

### 排错速查

| 现象 | 可能原因 | 排查方向 |
|------|----------|----------|
| `/tools` 里工具缺失 | manifest 未启用 / 未加入 allow / 实现未注册 / 未重启 | 检查 config/tools JSON、agent.tools.allow、重启后 /tools |
| `/tools` 显示 pending | 有活动 turn 或工具调用未完成 | 等待所有活动 turn 和工具调用结束；`/new` 不会取消旧任务，也不能强制解除 pending |
| `/tools` 显示 degraded / unavailable | 候选构建失败 / reload 失败 / 回滚失败 | 查看服务日志，确认实现文件和 manifest 一致 |
| write_file 返回权限错误 | 路径越界 / 不支持扩展名 / inputs 只读 | 检查路径是否在 bindings 范围内 |
| write_file 返回“文件已存在，未覆盖” | 尝试覆盖已有文件 | 使用不同文件名，工具不支持覆盖 |
| 文件保存到了非预期目录 | 模型生成路径受旧角色规则影响 / 规则更新前旧 Thread | 核对实际工具路径和角色规则；修改过规则需重启并 `/new`，最新规则也不保证模型必然分类正确 |
| search_web 返回空或失败 | 确无匹配 / Google 暂时不可访问 / 布局变化 | 用 `npm run tools -- search ...` 直连诊断 |
| 模型只声称保存但无工具调用记录 | 可能未调用工具或提供商工具协议不兼容 | 检查 turn.artifacts 和会话事件，不以模型自述为准；检查模型/提供商的 Responses 工具调用兼容性 |
| 旧 Thread 下一轮调用被拒 | 工具版本更新后描述符不匹配 | 执行 /new 开启新对话 |

## 源码索引

| 模块 | 职责 |
|------|------|
| [../server/main.mjs](../server/main.mjs) | 组装 Agent / ToolManager / CodexConnection，产品 HTTP 入口 |
| [../agents/writing-agent.json](../agents/writing-agent.json) | Agent 工具 allow 列表、dataBindings、outputs 规则 |
| [../agents/roles/writing-assistant.md](../agents/roles/writing-assistant.md) | 角色指令正文，含保存分类语义规则 |
| [../server/modules/agents/index.mjs](../server/modules/agents/index.mjs) | 载入指令 / 权限、sourceHash 校验、Thread 描述符版本绑定 |
| [../config/tools/files.json](../config/tools/files.json) | 文件工具组清单（名称 / schema / readOnly 注解） |
| [../config/tools/web.json](../config/tools/web.json) | 网络工具组清单 |
| [../server/modules/tools/loader.mjs](../server/modules/tools/loader.mjs) | 扫描 / 校验 / hash / factory 调用 / handler 核验 |
| [../server/modules/tools/index.mjs](../server/modules/tools/index.mjs) | ToolManager：版本快照 / 1 秒扫描 / MCP 配置 / 空闲切换 / 回滚 |
| [../server/modules/tools/mcp-server.mjs](../server/modules/tools/mcp-server.mjs) | MCP loopback HTTP 服务，tools/list 与 tools/call 入口 |
| [../server/modules/tools/files.mjs](../server/modules/tools/files.mjs) | 三个文件工具的工厂适配，直接返回注入的受限文件服务 |
| [../server/modules/data/files.mjs](../server/modules/data/files.mjs) | 统一磁盘读写权限：扩展名 / 大小 / 路径 / 链接检查 |
| [../server/modules/tools/web-tools.mjs](../server/modules/tools/web-tools.mjs) | 网络工具：固定子进程调用 / 缓存 / 限速 |
| [../server/modules/tools/web-cli.mjs](../server/modules/tools/web-cli.mjs) | 固定 search / read 入口（子进程调用目标） |
| [../server/modules/tools/web.mjs](../server/modules/tools/web.mjs) | Google 结果与静态正文解析 |
| [../server/modules/tools/public-web.mjs](../server/modules/tools/public-web.mjs) | URL / DNS 校验与受限 HTTP 抓取 |
| [../server/modules/codex/config.mjs](../server/modules/codex/config.mjs) | 生成项目独立 Codex 配置与 CODEX_HOME，配置引用 MCP 令牌变量名 |
| [../server/modules/codex/connection.mjs](../server/modules/codex/connection.mjs) | 启动本机 Codex 子进程，维护 stdio 请求、响应与通知 |
| [../server/modules/codex/launch.mjs](../server/modules/codex/launch.mjs) | 生成 Codex stdio 启动参数，关闭内置 shell 等工具 |
| [../server/modules/sessions/index.mjs](../server/modules/sessions/index.mjs) | 跟踪 turn.tools / turn.artifacts，以工具真实结果为准 |
| [../client/modules/chat/index.mjs](../client/modules/chat/index.mjs) | CLI 侧 /tools 与工具状态显示，消费会话事件 |
| [../tests/role.test.mjs](../tests/role.test.mjs) | 角色加载、基础指令注入和多轮复用测试 |
| [../tests/agent-core.test.mjs](../tests/agent-core.test.mjs) | Agent 核心逻辑测试 |
| [../tests/tool-loading.test.mjs](../tests/tool-loading.test.mjs) | 工具清单、版本快照、刷新、回滚与 MCP 入口测试 |
| [../tests/tools.test.mjs](../tests/tools.test.mjs) | 工具实现单元测试 |
| [../tests/codex-tools.integration.mjs](../tests/codex-tools.integration.mjs) | 真实 Codex + 模拟 Responses，含文件读写 / 重启 / 角色版本 / Skill |
