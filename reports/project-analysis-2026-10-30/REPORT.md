# Codex Agent Harness 项目深度分析报告

**报告日期**：2026-10-30
**分析范围**：根目录入门示例、`project/`（主线服务）、`project/web`（课程与工作台）、`project-evolution/`（Demo 1–5 快照）
**分析方式**：通读服务端全部模块；实际运行 `npm test`、`npm run test:web`、`npm run check`、`npm run course:check`、`npm run test:data`；编写两个最小复现脚本（见附录 B）。未调用真实模型，未启动正式服务，未修改任何项目文件。

---

## 1. 执行摘要

**总体判断**：项目的安全边界和执行语义做得很扎实，测试也充分；问题在于整体分量和"本机单用户脚手架"的定位不匹配，运行时性能有明显硬伤，工程化基础设施基本缺位。

最需要优先处理的 5 个问题：

| # | 问题 | 性质 | 证据 |
|---|---|---|---|
| 1 | **没有版本控制**，用 6 份全量目录副本代替历史；`project/` 与 Demo 5 已经分叉，修复没有同步回 Demo 5，文档却写着"同步" | 工程基础 | 全目录无 `.git`；`project/server` 下 18 个文件与 Demo 5 不同 |
| 2 | **流式输出 SSE 推送严重放大**：每个 delta 都推送一次"最近 30 轮"的完整快照 | 性能 | 实测 17.6 KB 新文本 → **162 MiB** 推送（附录 B1） |
| 3 | **追加消息失败会撤销正在运行轮次的工具权限** | 正确性 bug（已复现） | 附录 B2 |
| 4 | **Codex 子进程出错后服务成为"僵尸"**；任何一次 RPC 超时（含只读查询）都会判定整个连接失效，且没有自愈 | 可靠性 | `server/main.mjs:118`、`codex/connection.mjs:83-86` |
| 5 | **本机单用户却强依赖 PostgreSQL + Redis**，其中 Redis 在单实例下基本冗余；当前本地实例正因此无法启动 | 架构/可用性 | `data/index.mjs`、`data/queue.mjs:42` |

---

## 2. 项目现状

### 2.1 组成

| 部分 | 定位 | 规模 |
|---|---|---|
| 根目录 `examples/ lib/ scripts/` | Codex TypeScript SDK 入门教程（hello / fix / resume / json / app-server） | 约 560 行 |
| `project/server` `client` `shared` | 主线：基于 Codex App Server 的配置驱动 Agent 服务（HTTP + SSE + CLI），带 PG/Redis 数据层、权限门禁、Wiki/RAG 知识层 | 5,246 行 / 约 255 KB |
| `project/tests` | 单元测试 + 集成测试（真实 Codex + 模拟 Responses） | 4,528 行 |
| `project/docs` | 设计文档（md + html 双份） | md 2,432 行，html 2,550 行 |
| `project/web` | 互动课程（17 节机制课）+ Agent 工作台（浏览器 → 本地桥接 → Agent HTTP） | 约 1 MB |
| `project-evolution/demo1…5` | 五个演进阶段的完整源码快照，供课程引用 | 每份 277–367 MB（几乎都是 node_modules） |

**主线架构**（`server/main.mjs` 的组装顺序）：

```
文件锁 → PG（执行器 advisory lock）+ Redis → Agent 定义（JSON Schema 校验）
→ 运行目录 / 模型目录 → 受限文件工具 + PermissionGate + 资源版本层 + 知识层
→ ToolManager（dynamicTools）→ Codex app-server 子进程（stdio JSON-RPC）
→ SessionService / MessageService（PG outbox 调度）→ HTTP/SSE（127.0.0.1 + Bearer token）
```

### 2.2 健康度（本次实测）

| 检查 | 结果 |
|---|---|
| `npm test`（单元） | ✅ 148/148 通过，2.3 s |
| `npm run test:web` | ✅ 6/6 通过 |
| `npm run check`（静态） | ✅ 通过；警告"可选 Skill 不存在：knowledge" |
| `npm run course:check` | ✅ 17 节课程源码锚点均为最新 |
| `npm run test:data`（隔离 PG + Redis + 真实 Codex + 模拟模型） | ✅ 14 通过，1 跳过（RAG，需要 Chroma） |
| 真实模型冒烟 `docs/verification/real-model-smoke.json` | 2026-10-08 写作、客服两个示例均通过（本次未重跑） |

### 2.3 当前本地实例状态：**无法直接启动**

1. `project/.env` 里没有 `DATABASE_URL`、`REDIS_URL`，`openDatabase()` 会直接报"缺少 DATABASE_URL"。
2. 本机 5432 端口没有 PostgreSQL 在监听（Redis 6379 在运行）。
3. `.data/` 里还留着旧 JSON 状态（`messages.json`、`thread-agents.json`）。就算接上 PG，也会被 `data/index.mjs:24-36` 拒绝启动，必须先跑 `data:import` 预检，再加 `--apply`。
4. 残留 `server.lock`（PID 23885 已经不存在，代码能自动清理）和 `connection.json`（指向已停止的 4317 服务，在新服务覆盖之前，CLI 和工作台都会连接失败）。
5. 工作区里还没有 `.agents/skills/knowledge/SKILL.md`，需要先跑 `knowledge:init`。
6. 磁盘：7 份 `node_modules` 合计约 **2.1 GB**；`.data/codex/.tmp` 已有 88 MB，没有清理策略。

### 2.4 做得好的地方（改造时应保留）

- **安全边界意识强**：路径规范化，拒绝符号链接、硬链接和隐藏目录；只允许新建不覆盖；SSRF 防护会固定已解析的 IP，重定向时重新校验；令牌用 `timingSafeEqual` 比较；多层日志脱敏。本次扫描没有在日志、协议记录或 zip 中发现明文密钥。
- **执行语义严谨**：状态不确定时不自动重发（`unconfirmed`）；`clientMessageId` 保证幂等；`turn/completed` 早于响应到达时，也不会被回填成执行中。
- **配置驱动 + 语义契约版本**：Agent JSON 用严格 Schema 校验；描述符按语义契约计算哈希，不依赖源码全文；旧会话不会被静默放宽权限。
- **测试与验证文化**：单元、集成和真实模型冒烟三层都有，并留存了验证 JSON。
- 文档详尽，并且如实记录了尚未验收的边界。

---

## 3. 主要问题详解（按优先级）

### P0-1 没有版本控制，用目录快照代替演进历史

**现象**
- 整个 `codex-harness` 目录下没有任何 `.git`。
- 同一套代码存在 6 份副本（demo1–5 + project）。`project/` 相对 Demo 5 多出 5 个模块（`agents/contracts.mjs`、`agents/selection.mjs`、`agents/upgrade.mjs`、`codex/compatibility.mjs`、`data/paths.mjs`），另有 18 个服务端文件内容不同。
- Demo 5 缺少 `project/` 里的关键修复，例如 `codex/connection.mjs` 中"工具处理器忽略 signal 时仍按时回包"的竞态修复，以及 `verifyRestrictedFeatures` 受限能力核验。
- 但 `project-evolution/README.md` 写的是"`project/` 同步升级至此实现"，`project/README.md` 写的是"与 Demo 5 实现同步"。
- 课程构建 `web/build-curriculum.mjs` 按 needle 字符串从 `project-evolution/demoN/` 截取源码，课程和快照强耦合。
- 根目录的 `codex-harness-starter.zip` 已经过期（缺 `lib/app-server-config.mjs`、`tests/`）。

**影响**：无法回滚、审计或二分定位；同一个修复要在多处手工同步，很容易漏；占用约 2.1 GB 磁盘；课程讲解的是含已知缺陷的代码，文档却声称一致。

**修复**
1. 立即 `git init`，根目录 `.gitignore` 补上 `node_modules/ .data/ .runs/ workspace/ .env .DS_Store`，做首次提交。
2. 中期改为用 git tag/分支（`demo1`…`demo5`）表示演进阶段；课程构建改为 `git show demoN:<path>` 取源码，或把 Demo 用 npm workspaces 共享依赖。
3. 把 README 的"同步"改为"Demo 5 为冻结教学快照，修复只在 project 进行"，或把关键修复回移到 Demo 5，二选一并写明。
4. 删除过期 zip，需要时用脚本从 git 生成。

### P0-2 已确认 bug：追加消息失败会撤销运行中轮次的工具权限

**位置**：`server/modules/messages/index.mjs:213-214`

```js
async executionError(job, error, sent) {
  this.gate?.end(job.threadId);   // 不区分是新任务还是 steer 追加
```

`steer()` 的失败分支（除了"没有活动轮次"那两种 -32600 错误）也会调用 `executionError`。而 `gate.end(threadId)` 不带 turnId，会直接终止并删除该 Thread **当前活动轮次**的 run。之后 `rpc.toolHandler` 里的 `gate.forTurn()` 对这个轮次的每次工具调用都会拒绝。

**触发场景**：一个任务正在执行时，用户 `/append` 了一条追加消息，而这条消息在 `prepareInput` 阶段被拒绝。例如提到了被禁用的 `$skill`（`SKILL_UNAVAILABLE`），或者 Skill 集合变化导致 `beforeTurn` 抛错，或者遇到其他已知 RPC 拒绝。

**复现**：附录 B2，输出为"追加失败后，turn-A 的后续工具调用被拒绝：未授权的资源、动作或执行范围。"

**影响**：原轮次仍在 Codex 中继续执行，但此后所有工具调用都会失败，模型可能据此得出错误结论（例如"文件不存在 / 无权限"）；同时队列被暂停。现有测试里 steer 用例都没有接入 gate，所以没有发现这个问题。

**修复**：`gate.end` 只在 `dispatch()` 自己启动的任务失败时调用；或者让 `gate.end` 接收 `taskId`，仅当 `run.context.taskId === job.id` 时才结束。并补一条"steer 失败不影响活动轮次工具"的回归测试。

### P0-3 SSE 每个 delta 推送完整快照，数据量随历史成倍放大

**位置**
- `sessions/index.mjs:141-158`：每个通知（包括每一个 `item/agentMessage/delta`）都会 `publish(snapshot)`，快照里含最近 30 轮的全部回答、工具和消息。
- `sessions/index.mjs:153`：每个 delta 都对**累计全文**重新做一次 `redact`，复杂度是 O(n²)。
- `http/index.mjs:114`：每次写出前再对整个事件 `JSON.stringify` 并脱敏。
- `http/index.mjs:113`：写缓冲超过 1 MiB 就直接断开连接。
- 前端 `web/public/app/main.js`：每个事件都用 `innerHTML` 重绘整个对话区。

**实测**（附录 B1，用真实 `SessionService` 驱动）：

| 已有历史 | 新回答 | SSE 事件数 | 推送总量 |
|---|---|---|---|
| 5 轮 × 2 KB | 300 个 delta ≈ 5.3 KB | 301 | **4.4 MiB** |
| 30 轮 × 5 KB | 1000 个 delta ≈ 17.6 KB | 1001 | **162.3 MiB** |

**影响**：长会话下 CPU 和带宽消耗剧增；经过工作台代理的浏览器容易因为背压超过 1 MiB 被断开，然后反复重连、重新拉快照；前端卡顿。

**修复**
1. 事件拆分：`delta {turnId,itemId,text}` 只推增量；`snapshot` 只在连接建立和轮次或工具状态变化时推送。
2. 服务端 50–100 ms 合并节流。
3. 脱敏改为增量处理：保留一个长度为"最长密钥 − 1"的尾部窗口，防止密钥跨 delta 拼接后漏网；轮次完成时再对全文做一次最终脱敏。
4. 前端改成增量追加 DOM。
5. 增加 SSE 数据量回归测试，把附录 B1 改造成断言即可。

### P0-4 Codex 连接失败后服务成为"僵尸"，且判死条件过于激进

**位置**
- `server/main.mjs:118`：收到 `fatal` 后只调用 `rpc.close()`。`MessageService.fail()` 设置 failure 后，HTTP 仍在运行，只返回 503 和"请重启服务"。没有自动重启，也没有提供进程守护配置。
- `codex/connection.mjs:83-86`：**任何**请求超时（默认 `DEMO_TIMEOUT_MS=180000`）都会调用 `fail()`，判定整个连接失效。这包括 `thread/list`、`skills/list`、`config/read`、`mcpServerStatus/list` 这类只读、幂等的请求。
- 另外每轮执行前 `beforeTurn` 都会以 `forceReload:true` 调用一次 `skills/list`（`main.mjs:84-87`），增加了触发超时的机会。

**修复**
- **方案 A（最小改动）**：fatal 后有序关闭，然后 `process.exit(1)`，交给 launchd/pm2/systemd 守护重启。启动时的 `recover()` 已经能正确处理 `unconfirmed`。
- **方案 B（完整）**：在 `CodexConnection` 内实现 supervisor，指数退避重启子进程，重新 `initialize`，复核工具、Skill 和记忆配置；期间 HTTP 返回 `503 + Retry-After`。
- 两种方案都应区分请求类型：只读幂等请求超时只拒绝该请求；只有 `turn/start`、`turn/steer`、`thread/start` 这类有副作用的请求保持"不确定即判死"的语义。

### P1-1 架构分量与"本机单用户"定位不匹配

**现象**
- README 自述"单机单用户本地开发"，但 `data/index.mjs` 要求必须有 `DATABASE_URL` 和 `REDIS_URL`，并明确"不会回退"。
- Redis 只存唤醒 ID（`data/queue.mjs` 注释原文："Redis contains only wake-up IDs. PostgreSQL owns ordering…"），而 PG outbox 本身每 200 ms 就会被轮询一次（`queue.mjs:42`）。单实例下，Redis 没有提供 PG 轮询之外的任何能力，反而多了一个故障点：Redis 不健康时 `/health` 直接返回 503。
- 空闲时后台仍持续查询：outbox 每 200 ms 一次，执行器锁心跳每 1 s，知识 worker 每 1 s，工具目录每 1 s 扫描一次文件系统。
- `resources.mjs:24-34`：资源层每次读写都要获取**实例级全局** advisory lock，所有 Thread 的文件读取被串行化。

**影响**：上手门槛高（当前实例无法启动就是例证），资源浪费，并发读取吞吐受限。

**修复**
1. 抽象出 `JobStore`、`WakeSource`、`ResourceStore` 接口。
2. 默认提供单机实现：仅用 PG，唤醒改用 `LISTEN/NOTIFY` 替代 Redis 和 200 ms 轮询；也可以评估嵌入式存储（如 SQLite），把零外部依赖作为默认。Redis 降为可选。
3. advisory lock 细化到 locator 或 resource 粒度。
4. PG + Redis 保留为"生产/多用户"配置档。

### P1-2 热路径上的同步 I/O 与重复校验

| 位置 | 行为 |
|---|---|
| `agents/index.mjs:97-107` `assertCurrent()` | 每次调用都同步重读 Agent JSON、角色 MD 和全部 Skill 文件并计算 SHA-256。它被 `allowsTool`、`gate.current`、`files.*` 等多处调用，单次工具调用路径上会执行多次 |
| `tools/loader.mjs:40-52` `currentNames()` | 每次 `validate` 或访问 `specs` 都会 `readToolSources()`，重读 `config/tools` 和 `server/modules/tools` 下所有文件 |
| `main.mjs:84-87` | 每轮都执行 `skills/list` + `forceReload` |
| `codex/connection.mjs:68-71` | 每条协议消息（包括每个 delta）都 `appendFileSync` 写入 `protocol.jsonl`，内容是完整用户输入和模型输出 |

**修复**：变更检测改为 `fs.watch` 加 (mtime, size, ino) 快速比较，每 N ms 最多真正重新哈希一次；`validate` 复用 ToolManager 每秒轮询已经得到的结果；Skill 复核改为文件变更时触发；协议日志改为异步写流，并支持日志级别配置（默认不落盘 delta 正文）。

### P1-3 知识检索不具备可扩展性

**Wiki 模式**（`knowledge/index.mjs:166-183`）：
- 最多对 200 页逐页调用 `read()`。每页会对每个来源执行 `refresh()` → `readById()` → **完整的 `read_file` 流程**（多次 SQL、同步读文件、写 blob、加全局锁事务），再执行一次 `sourceVersions()`。
- 按代码估算，每页约需 2 + 18×S 次 SQL（S 为来源数）。200 页、每页 3 个来源就是**上万次查询**，并且全部在全局锁下串行执行，而工具调用超时只有 30 s。
- 匹配方式是"整个查询串的子串包含"，多关键词或换个说法的查询基本召回不到。

**RAG 模式**（`knowledge/rag.mjs`）：
- 每次查询都要读入并 `JSON.parse` 整个 BM25 文件（上限 128 MiB）。
- `bm25()` 对每个词做全量线性扫描。
- 分块按 800 字符硬切，不考虑 Markdown 结构。

**修复**
1. 来源新鲜度改为一次批量 SQL，直接比较 `current_version`；检索阶段只负责标记 stale，不逐个来源重读文件，严格校验留到读取全文时再做。
2. Wiki 检索复用 `rag.mjs` 里已有的 `tokenize` + `bm25`，或者使用 PG 的 `pg_trgm` / 全文检索。
3. BM25 索引常驻内存并建立倒排表。
4. 分块按 Markdown 标题和段落切分。
5. 增加 1k 页规模的检索性能测试。

### P1-4 数据生命周期与运维缺口

- **未确认记录永久占用路径**：`resources.mjs:255-259` 中，只要路径上有任何记录（包括 pending/unconfirmed）就拒绝写入。`reconcile` 只会把 pending 转成 ready 或 unconfirmed，而 **unconfirmed 没有任何释放或清理命令**；`reconcile` 也不会在启动时自动执行。
- **正文 blob 只增不删**：`.data/files/objects` 每次读到被外部修改过的文件，都会新增 blob 和 `resource_versions` 记录。
- **Codex 原生目录**：`.data/codex/.tmp` 已有 88 MB，`logs_2.sqlite` 加 WAL 约 6 MB，没有清理策略。
- **`.runs` 清理依赖 `lsof`**（`maintenance/index.mjs:16`），没有 `lsof` 的环境永远不会清理。
- **协议日志含隐私**：`protocol.jsonl` 存有完整对话，保留 7 天。

**修复**：启动时自动执行 `reconcile`；新增 `data:release <id>`，人工核对后作废 unconfirmed 记录并释放路径；实现 blob 引用计数 GC，删除未被 `resource_versions` 和 `wiki_versions` 引用的 blob；为 `.data/codex/.tmp` 制定清理策略；给协议日志加脱敏级别和保留期配置。

### P2-1 代码可维护性

- **风格混杂且没有工具约束**：Prettier 风格、单行压缩风格和手写压缩前端并存（`web/public/app/styles.css` 一行 13,107 字符，`main.js` 一行 3,537 字符）；服务端单行最长 474 字符；单双引号混用。没有 ESLint/Prettier/Biome，没有类型检查，没有 CI。
- **重复实现**：
  - `covers()` 在 `permissions`、`resources`、`files`、`data/paths` 中定义了 4 次。
  - 256 KiB 上限散落在 6 处以上。
  - 子进程环境变量的剥离正则有两处，而且不一致（`config/index.mjs:55` 和 `codex/launch.mjs:101`）。
  - 根目录 `lib/app-server-config.mjs` 与 `project/.../codex/launch.mjs` 的逻辑重复。
- **SQL 写法**：`Repository.query` 强制注入 `$1`/`$2`，导致大量 `AND $2::uuid IS NOT NULL` 这种只为"用掉参数"的占位写法。
- **遗留和测试代码混入生产路径**：
  - `messages/index.mjs:106` 标有 "Test-only" 的分支。
  - `AgentDefinition.bind/assertCompatible`、`SessionService.list/load` 里保留的 JSON 文件模式分支。
  - `sessions/history.mjs` 中的旧 rollout 迁移和协议日志扫描。
  - 维护任务删除目录前仍会调用 `rememberRunHistory`。

  在正式 PG 模式下，这些代码都执行不到或没有用。
- **入口文件承担业务逻辑**：`main.mjs:59-70` 在组装入口里内联了文件工具的门禁包装。

**修复**：引入 Biome（或 ESLint + Prettier），做一次全量格式化；加 `// @ts-check` + JSDoc，或渐进迁移到 TypeScript；抽出 `shared/limits.mjs`、`shared/path-policy.mjs`；`Repository` 拆分为 scoped 查询和普通查询两类接口；遗留模式迁到 `scripts/migrate-legacy`；测试改为注入 `InProcessQueue`；门禁包装下沉到 permissions 或 resources 模块；建立 CI（运行 `npm test`、`test:web`、`course:check`、`test:data`）。

### P2-2 功能完成度（README 自认"尚未验收"的部分）

| 功能 | 现状 |
|---|---|
| 联网搜索 `search_web` | 直接抓取 Google 结果页 HTML（`tools/web.mjs:52-58`）：容易遇到验证码或同意页，页面结构一变就失效，还有服务条款风险；尚未验收 |
| 原生记忆 | 禁用原生写工具导致合并环节被阻塞（`memory/index.mjs:49`）。挂载知识库时又必须关闭记忆（`agents/index.mjs:114`），而默认的写作 Agent 就挂载了知识库，所以**默认配置下记忆不可用** |
| 偏好 `/preferences` | 只存储，不会注入上下文（`injectedIntoContext:false`） |
| Skill | 只支持纯文本指令型；声明了 `requires` 的一律禁用 |
| RAG | 语义质量未验收（`verification.json` 中 `semanticQualityVerified:false`） |
| 多用户 / 认证 / 配额 | 已后置（`docs/multi-user-upgrade-plan.md`） |
| Codex 版本 | 锁定 0.154.0；App Server 官方仍标注为 experimental |

### P2-3 配置与文档漂移

- `project/.env` 与 `.env.example` 不一致：缺 `DATABASE_URL`、`REDIS_URL` 和 RAG 相关变量；还残留着过时注释"角色统一定义在 server/modules/role/index.mjs"。
- `AGENT_TURN_TIMEOUT_MS`（`config/index.mjs:47`，默认 600000）在 README、`.env.example` 和 docs 中都没有出现。`DEMO_TIMEOUT_MS` 在正式服务里实际表示"单个 RPC 的超时"，名字却沿用 demo 时期。
- 角色文件 `agents/roles/writing-assistant.md:23` 写的是"工具……通过 MCP 提供"，但当前门禁模式实际使用的是 `dynamicTools`。
- `codex/launch.mjs:112`：只要存在 `CODEX_API_KEY` 这个键（哪怕值为空）就进入 API Key 模式，所以从 `.env.example` 复制出来后，无法使用"已登录"模式。
- 三份设计文档同时维护 md 和 html 两个版本。
- 根目录 `.env` 的权限是 644，里面有真实 key（`project/.env` 是 600）。
- 课程素材来源 `codebase-to-course` 没有 LICENSE（`web/README.md` 已提示），对外分发前需要确认授权。

### P3 安全细节（风险较低，属于加固建议）

- `tools/public-web.mjs:48`：`allowProxyFakeIp` 默认值为 `NODE_ENV !== 'production'`，即默认信任 198.18/15 网段的 Fake-IP。代码已限定只对 HTTPS 和域名生效，风险较低，但默认值应改为严格，调试时再显式开启。
- Codex 子进程的环境变量是"全量继承 `process.env`，再减去黑名单"。建议改为白名单（`PATH`、`HOME`、`LANG`、`CODEX_*`、`NODE_ENV` 等）。

---

## 4. 修复与改进路线图

> 工期为单人粗估，仅供排期参考。

### 阶段 0：止血（约 1 天）

| 项 | 动作 | 验收 |
|---|---|---|
| 版本控制 | `git init`，补全 `.gitignore`，首次提交 | `git status` 干净，不含 `.env`、`.data`、`node_modules` |
| 修复 P0-2 | `executionError` 不再结束 steer 失败对应的 gate；补回归测试 | 附录 B2 输出"仍有效"；`npm test` 全部通过 |
| 恢复本地可启动 | 启动 PG（`AGENT_DB_PASSWORD=… docker compose up -d postgres`，或用 brew），按 `.env.example` 补全 `.env`，然后依次执行 `data:migrate` → `data:import` 预检 → `data:import -- --apply` → `knowledge:init` → `check:server` | `npm run server` 就绪，`/health` 返回 200 |
| 文件权限 | `chmod 600 .env` | — |
| 文档漂移 | 同步 `.env` 与模板；补充 `AGENT_TURN_TIMEOUT_MS` 说明；修正角色文件里的 MCP 表述；修正"同步"说法 | — |

### 阶段 1：性能与可靠性（1–2 周）

1. SSE 改为增量事件 + 节流 + 增量脱敏，前端改为增量渲染（P0-3）。
2. Codex 进程守护：至少实现方案 A；只读 RPC 超时不再判死连接（P0-4）。
3. `SessionService` 的 turns 只在内存中保留最近 N 轮，长时间不活跃的会话自动卸载（当前 `session.turns` 无上限）。
4. 热路径缓存：`assertCurrent`、`currentNames` 和 Skill 复核都改为基于文件变更触发（P1-2）。
5. 协议日志改为异步写入，并支持分级配置。
6. 资源生命周期：启动时自动 `reconcile`、新增 `data:release`、实现 blob GC（P1-4）。
7. Wiki 检索：批量做新鲜度校验，用 BM25 替代子串匹配（P1-3）。

### 阶段 2：架构减负与工程化（2–4 周）

1. 存储接口抽象，默认改为仅 PG + `LISTEN/NOTIFY`（或嵌入式存储），Redis 变为可选；advisory lock 细化到资源粒度（P1-1）。
2. 清理遗留的 JSON 模式和 legacy history 路径，测试专用分支改为依赖注入（P2-1）。
3. 引入 Biome 或 ESLint + Prettier、`@ts-check`、CI；抽取公共常量和路径策略。
4. 演进管理：Demo 改用 git tag 管理，共享依赖，课程从 git 取源码（P0-1）。
5. 前端拆分出源码目录并加构建步骤，不再手写压缩代码。

### 阶段 3：功能完善（按需）

1. **联网搜索**：接入正规搜索 API（Brave、Bing、Tavily、SerpAPI 等，做成可配置的 provider），Google 抓取降为后备；补充验收用例。
2. **记忆**：明确取舍。要么等 Codex 上游支持受限合并，要么基于现有 preferences 自建轻量记忆层，在 `baseInstructions` 或轮次输入中注入。
3. **Skill**：支持带只读 assets 的 Skill；脚本类 Skill 继续禁止。
4. **RAG**：按结构分块，建立语义质量评测集，支持增量索引。
5. **Codex 升级流程**：把 `test:protocol` 和 `test:protocol:research` 作为升级闸门，维护版本矩阵。
6. **可观测性**：结构化日志（如 pino），`/metrics` 暴露轮次耗时、工具耗时、队列深度等指标。
7. **多用户**（如需要）：按 `docs/multi-user-upgrade-plan.md` 实施，前提是阶段 1、2 的进程守护和存储抽象已经完成。

---

## 5. 待补齐的测试与文档清单

**测试**
- [ ] steer 失败不影响活动轮次的工具上下文（P0-2 回归）
- [ ] SSE 单轮推送字节数上限（P0-3 回归）
- [ ] Codex 子进程崩溃 → 自动恢复或进程退出 → 重启后状态正确（P0-4）
- [ ] 只读 RPC 超时不判死连接
- [ ] 1k 页 Wiki、10k 分块 RAG 的检索耗时基准
- [ ] unconfirmed 资源释放流程、blob GC 不误删
- [ ] HTTP 路由错误分支（405、413、未知路由、未认证）的系统化测试

**文档**
- [ ] 一页式"从零启动"指南：PG/Redis 准备 → 迁移 → 导入 → 初始化 → 启动 → 冒烟，附常见失败排查
- [ ] 环境变量全表（含 `AGENT_TURN_TIMEOUT_MS`、RAG 变量），并说明 `DEMO_TIMEOUT_MS` 的真实含义
- [ ] 运维手册：备份范围（PG、`.data/files`、`.data/codex`、`identity.json`），各类清理命令，unconfirmed 的处置方法
- [ ] Demo 5 与 project 的差异说明（或改用 git tag 后删除这部分）
- [ ] 设计文档只保留一种格式（md 为源，html 由构建生成）

---

## 附录 A：本次执行的命令

```bash
cd project
npm test                # 148 pass
npm run test:web        # 6 pass
npm run check           # pass（警告：可选 Skill knowledge 不存在）
npm run course:check    # pass
npm run test:data       # 14 pass, 1 skip（RAG）
```

## 附录 B：复现脚本

两个脚本都位于 `reports/project-analysis-2026-10-30/repro/`，只导入项目模块，不写项目文件，不调用模型。

**B1 SSE 放大**：`node reports/project-analysis-2026-10-30/repro/sse-amplification.mjs "$PWD/project"`

```
历史 5 轮 × 2KB 回答，新回答 300 个 delta（约 5.3 KB 正文）→ SSE 事件 301 个，共 4.4 MiB，CPU 7 ms
历史 30 轮 × 5KB 回答，新回答 1000 个 delta（约 17.6 KB 正文）→ SSE 事件 1001 个，共 162.3 MiB，CPU 98 ms
```

**B2 steer 失败撤销活动轮次权限**：`node reports/project-analysis-2026-10-30/repro/steer-gate.mjs "$PWD/project"`

```
追加前，turn-A 工具上下文: job-A
追加失败后，turn-A 的后续工具调用被拒绝: 未授权的资源、动作或执行范围。
```

## 附录 C：关键代码位置索引

| 问题 | 位置 |
|---|---|
| steer 失败结束 gate | `project/server/modules/messages/index.mjs:213-214` |
| 每个通知都发布全量快照 | `project/server/modules/sessions/index.mjs:141-158`、`:170` |
| SSE 写出与 1 MiB 断开 | `project/server/modules/http/index.mjs:111-115` |
| fatal 后不自愈 | `project/server/main.mjs:118` |
| 任一 RPC 超时即判死连接 | `project/server/modules/codex/connection.mjs:79-91` |
| 协议日志同步写入 | `project/server/modules/codex/connection.mjs:68-71` |
| 每轮 Skill 强制重载 | `project/server/main.mjs:84-87` |
| PG 200 ms 轮询 + Redis 唤醒 | `project/server/modules/data/queue.mjs:39-78` |
| 全局资源锁 | `project/server/modules/data/resources.mjs:24-34` |
| 路径被未确认记录占用 | `project/server/modules/data/resources.mjs:255-259`、`:412-436` |
| Wiki 逐页逐源校验 + 子串匹配 | `project/server/modules/knowledge/index.mjs:166-183` |
| BM25 每次全量加载 | `project/server/modules/knowledge/rag.mjs:152-173` |
| Agent 定义重复哈希 | `project/server/modules/agents/index.mjs:97-107` |
| 工具目录重复读取 | `project/server/modules/tools/loader.mjs:40-52`、`:101-107` |
| Google HTML 抓取 | `project/server/modules/tools/web.mjs:52-58` |
| Fake-IP 默认信任 | `project/server/modules/tools/public-web.mjs:48` |
| 空 `CODEX_API_KEY` 强制 API Key 模式 | `project/server/modules/codex/launch.mjs:112` |
| 未文档化的轮次超时 | `project/server/modules/config/index.mjs:47` |
| 记忆与知识库互斥 | `project/server/modules/agents/index.mjs:114` |
| lsof 依赖 | `project/server/modules/maintenance/index.mjs:14-28` |
