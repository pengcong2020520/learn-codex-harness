# 权限与资源 Hub 设计

## 职责与决策

Hub 负责统一授权与可见列表。资源类型为 Agent、工具组、知识库、Skill；动作固定为 use、read、modify、share、delete。知识库和用户 Skill 可 private/shared/system；工具组、Agent 和随代码交付的 Skill 为 system。工具实现与 Agent 定义仍由部署者提供。

basic：writing；files、knowledge；每日 200,000 token；并发 1；知识库 3；私有 Skill 3。pro：全部系统 Agent 与工具组；每日 1,000,000 token；并发 2；知识库 20；私有 Skill 20。admin 豁免权益限制；全局 2 轮约束仍有效。`plans` 的 `*` 是全系统集合选择器，运行时按可信目录展开，没有第三档权益。

权限内核在 `hub/policy.mjs`。调用时 `user` 来自认证或持久化任务 owner，不接受模型参数中的身份。personal 表示原有会话/文件隔离边界，不进入 Hub 可分享目录。Agent 白名单、workflow 授权、可写目录继续作为执行约束，不能扩大 Hub 给出的权限。

## 数据与一致性

- `users.plan_id` 默认 basic；首次迁移把已有用户接入 basic，admin 由角色豁免。已有知识库统一为 private。
- `resource_grants` 以实例、类型、资源、被授权者唯一。触发器锁定资源行后校验 20 人上限、所有者、自授权、目标状态。禁用保留授权记录，但身份加载失败。
- scope 随授权插入/删除变为 shared/private；scope 校验触发器拒绝与授权不一致的值。system 无授权记录。发布先撤销已有指定授权，取消发布为 private。publish/unpublish 同事务将被清用户 ID 数组写入 publish 事件的 `detail.revokedGrantees`，没有授权时为空数组。
- `hub_skills` 保存服务端文本包和内容版本；`skill_share_requests` 保存 pending/approved/rejected、提议者、审批者和名单。只有所有者提议，另一位 admin 审核。审批时再次验证目标状态和剩余名额；审批、授权与审计同一事务提交。
- `permission_events` 保存 actor、动作、资源、before/after、detail 与时间。UPDATE、DELETE、TRUNCATE 触发器均拒绝；这里防止的是正常数据库写接口篡改，数据库超级管理员仍拥有管理能力。
- 迁移由版本/校验和登记，`013-hub.sql` 本身另有事务内哨兵；重复运行不重置已分配权益或授权。旧迁移文件未修改。`014-user-knowledge.sql` 增加知识库 title、user_created 和审计 detail，仍通过迁移登记升级。

## 用户创建与删除

`POST /knowledge {kbId,title}` 使用当前登录用户作为 owner，visibility 固定 private。ID 统一校验为 `[a-z0-9-]{1,64}`，实例级唯一冲突返回 409。数量检查与登记共用 Hub 实例事务锁（advisory key 15）；取得锁后读取当前权益及 owner 数量，basic 3、pro 20、admin 不限，超额返回 403 `PLAN_LIMIT`，配置注册也计数。目录准备和 `knowledge:create` 审计完成后提交；目录准备失败会回滚数据库登记。

目录固定为所有者工作区下的 `inputs/<kbId>` 和 `research/<kbId>/wiki`。HTTP create 与 `knowledge:init` 共用 `knowledge/directories.mjs`；拒绝接管已有目标目录，每级创建都记录父目录 realpath、dev/ino，并对新目录 fd 做 fstat 后复核父目录。Linux 创建、删除由同 uid 文件辅助执行，保留 s14 的身份、共享组及服务环境隔离。

有效挂载 = Agent 声明的规则 ∩ Hub 可见。显式 kbId 优先；仅 user_created 库可继承第一个 knowledge 项的默认动作与模式，不会使未声明的静态库变得可读。没有 knowledge 项时不挂载。动态库源目录提供受限只读文件入口，静态 dataBinding 较窄也不影响库读取；普通文件工具仍不能改原文或直接写生效 Wiki。update/index 在任务中继续要求针对该 kbId 的 workflow 授权。分享者 actions 仅含 read。新库初始 Wiki，RAG 按既有构建与重启边界切换。

`DELETE /knowledge/:id` 仅所有者或 admin 可用。与任务启动、原文导入共用 ExecutionBoundary；事务内锁定 Hub 与资源写入，核对持久化 starting/running/steering 任务挂载、活动 gate 上下文和 running 索引任务，命中返回 409 `KNOWLEDGE_BUSY`。索引 worker 领取任务也取得 Hub 锁，避免与删除交错。允许删除时清理 Chroma/BM25 与 owner 目录，撤销 grants、标记原文资源 revoked、清除 Wiki、mount、job、index 记录与 KB，写 `knowledge:delete`。配置默认库也不会在重启时自动复活（检查删除审计）；显式 POST 可重新创建。同 owner 重建库后允许原文重新登记到已撤销路径，产生新的不可变版本。保留不可变资源历史与内容 blob 供既有引用核验，不能通过已撤销资源读取正文。

文件系统和 PostgreSQL 没有跨系统原子提交：进程崩溃或外部索引清理失败可能留下需要核对的目录/索引。清理失败不提交数据库删除；不会报告成功，已清理部分不能靠 SQL 回滚恢复。路径复核也仍有同 uid 恶意进程 rename/ABA 的残余窗口，不能替代操作系统隔离。

## 运行边界

HTTP 普通请求取得最新的可见资源快照。新会话在 Hub 校验 Agent 后创建，并持久化当时实际可挂载的知识库 ID。每次新轮次在 ExecutionBoundary 内重新取快照，检查 Agent、Skill 和会话已挂载知识库，然后把快照放入 gate 的可信轮次上下文。工具、Wiki、来源引用与 RAG 均使用该快照；正在执行的一轮不因降级或撤销中断。

知识库读取先通过 Hub，再通过 Agent mount 与 workflow 限制，最后验证原文版本、Wiki 或 RAG 索引。RAG 在授权库内查询，以知识库 owner、kbId、indexRevision 过滤向量候选；返回前重新检查来源和权限。后台索引从持久化 KB 读取 owner，经 Hub 和对应用户运行环境执行。普通文件 ID 读取以及上游依赖也走 Hub，不能绕过共享范围。

共享原文按登记 owner 的 workspace 定位，以 `readAsUser` 在原 uid 下读取，检查独立普通文件、路径和大小；不会将请求身份切换成 owner，也不会读取其 CODEX_HOME。共享源正文必须与登记版本哈希一致。导入原文由 Hub 校验 modify，保存到该知识库 owner 的工作区，并登记相同 owner 的版本。原文写入先记录目标父目录 realpath 和 dev/ino；以 `O_EXCL|O_NOFOLLOW` 创建后对 fd 做 fstat，复核父目录仍在所有者源目录内且 inode 未变，写入后再复核。发现变化立即按 inode 校验 unlink 新文件并返回 409，不登记版本。路径式 Node API 无法抵御检查间完整换回的 ABA，也无法保证清理由攻击者移走的 inode；彻底闭合需要 openat2/unlinkat。

## Skill 同步

HTTP 上传使用 JSON 文本文件映射，不解压归档。只接受 SKILL.md 与 references/ 下的 .md/.txt，最多 50 个文件，合计 128 KiB。CLI 同样检查路径、符号链接、硬链接和大小。Codex 负责 frontmatter 解析和原生发现；服务负责允许集合核验。

所有者上传、admin 批准、所有者撤销后均立即对对应用户执行安装集合对账。Linux 生产运行通过已有同 uid 文件辅助进程完成，服务进程不进入用户 CODEX_HOME。每个 owner 的冷启动和同步共享串行边界，避免批准/撤销与进程冷启动交错后写回旧副本。只删除本服务 manifest 管理的 Skill，不触碰 `.system` 或其他目录。

活动轮次保留已批准的内容快照；撤销会立刻移除接收者安装副本。新的轮次若发现集合不同，等待活动轮次结束，在下一次空闲租约关闭旧进程并启动新进程，再核验 Skill 集合。指纹不兼容的旧会话按现有规则要求新建；原历史保留。

```mermaid
sequenceDiagram
    participant O as Skill 所有者
    participant H as Hub / PostgreSQL
    participant A as admin
    participant U as 接收者 uid 辅助
    participant R as 接收者 Codex
    O->>H: 上传文本包（private）
    H-->>O: 仅同步所有者
    O->>H: share 指定用户名
    H->>H: 保存 pending + 审计
    A->>H: approve（不是提议者）
    H->>H: 锁定资源，校验名单，写 grants/shared/审计
    H->>U: 同 uid 安装当前允许集合
    U-->>H: 同步完成
    R->>H: 下一轮前核对集合
    H-->>R: 空闲关闭旧进程，重建并核验
    O->>H: unshare
    H->>H: 撤销授权 + 审计
    H->>U: 立即移除安装副本
```

## 配额与降级

使用 s11 账本的 owner_id 汇总 token，时区沿用 AGENT_BUDGET_TIMEZONE。派发前等待账本写入链，达到上限保留 queued；定时检查直到该时区的次日恢复。进行中轮次和当前轮次的追加继续完成。并发按执行任务与活动会话去重计数，先受全局 2 轮限制，再受用户权益限制。用量写入失败保持 fail-closed。

```mermaid
sequenceDiagram
    participant A as admin
    participant H as Hub
    participant Q as 调度器
    participant C as 用户 Codex
    Q->>H: 读取 pro 与今日用量
    H-->>Q: 允许启动
    Q->>C: 开始轮次（授权快照）
    A->>H: plan:assign basic
    H->>H: 更新 users.plan_id + 只追加审计
    C->>C: 已在执行的一轮完成
    Q->>H: 下一轮重新读取权益和用量
    H-->>Q: files / knowledge；并发 1；每日 200,000
    alt 已超额
      Q->>Q: 保留 queued，次日再检查
    else 可派发
      Q->>C: 按新规则启动；原生搜索配置变化先空闲重启
    end
```

## 验证与边界

离线测试覆盖策略内核、真实业务方法和调度器，通过测试夹具驱动；它不证明 PostgreSQL 触发器或 uid capability。外部 PG 测试真实执行重复迁移、21 个并发授权争夺 20 个名额、审批、scope 以及审计 UPDATE/DELETE/TRUNCATE 拒绝。Linux uid 测试执行真正的文件辅助进程与跨用户读取拒绝；服务器步骤验证 HTTP、运行中轮次与下一轮权限。

授权只针对指定用户，没有组织、小组、支付、Skill 市场或多主机。数据库与文件系统没有分布式事务；失败由报错、可重试对账与下一轮前核验收敛。已经送进模型上下文的资料不会被远程抹除。下一章的主题是 [s16 协调面](../../s16-coordination/README.md)。

`tests/user-knowledge.test.mjs` 覆盖自建目录/所有者、冲突、basic/pro/admin 数量与并发、动态挂载和 workflow、分享只读、执行中删除拒绝及清理、publish 清单、导入和建目录的父路径替换。`npm run test:data` 中的 `hub-share.integration.mjs` 经真实 PG/HTTP 验证普通用户 Bob 自建 → 导入 → 分享 → Carol 读取 → Dave 404，并检查三个并发创建争夺 basic 剩余一个名额及删除结果。测试双的事务锁不代替真实 PG 验证。

## 关键数值与实现细节

章节 README 只讲概念；Hub 的规则、数值与接口集中在这里。

`hub.can(user, action, resource)` 统一处理 `use | read | modify | share | delete`。看不见返回 404；看得见但不能执行动作返回 403。`GET /hub` 返回可见资源的类型、scope、所有者用户名与可执行动作。会话、普通文件仍是个人隔离对象，admin 不能借分享接口进入别人的会话。

| scope | 可用者 | 可修改者 |
| --- | --- | --- |
| private | 所有者、admin | 所有者、admin |
| shared | 所有者、指定被授权者、admin | 所有者、admin |
| system | 所有用户，受权益限制 | admin |

知识库分享无需审批；每个资源最多授权 20 人，不能授权给自己、不存在或已禁用账号。禁用账号的授权记录保留但不生效。有授权时为 shared，最后一条撤销后回 private。发布为 system 会清除指定授权；取消发布回 private。两者的 publish 审计在同一事务写入 `detail.revokedGrantees`，保留被清除的用户 ID 名单。

| 权益 | Agent | 工具组 | 每日 token | 同时轮次 | 知识库 | 私有 Skill |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| basic | writing | files、knowledge | 200,000 | 1 | 3 | 3 |
| pro | 全部系统 Agent | 全部系统工具组 | 1,000,000 | 2 | 20 | 20 |

新用户默认 basic。admin 不受权益限制，但管理操作仍写审计；全局最多 2 轮继续有效。`pro` 在表中以 `['*']` 表示全部系统集合。部署中的 `writing` 对应 `agents/writing/`，Agent ID 为 `writing-assistant`。

有效工具 = Agent 白名单 ∩ 权益工具组 ∩ 工具组可见范围。原生联网搜索也受 web 工具组限制。工具组与 Agent 只允许 system，不接受用户上传工具代码。

Skill 上传后是 private，仅同步到所有者的 CODEX_HOME/skills。所有者提出共享名单形成 pending，另一位 admin approve 后写授权并同步；reject 不授予权限。撤销立即移除被授权者的安装副本。已有轮次保留启动时的权限快照，下一轮核对新规则；Skill 集合变化需要空闲边界重启该用户进程，并按已有兼容规则新建会话。

### 模块职责

| 单元 | 职责 |
| --- | --- |
| Hub | 资源可见性、动作、权益、授权审批、配额判定、审计 |
| PermissionGate | 可信轮次上下文、Agent 挂载、workflow 临时授权、输出范围 |
| sessions / messages | 会话绑定、下一轮重验共享知识库、保留超额排队任务、全局与用户并发 |
| knowledge / resources / RAG | 先经 Hub 授权，再查版本、来源与索引；共享原文按原 owner 的 uid 读取 |
| runtimes / Codex | 每用户进程和目录、同 uid Skill 同步、发现核验、空闲受控重启 |
| PostgreSQL | plans、授权唯一与数量约束、scope 联动、只追加 permission_events |

### 用户自建知识库

普通用户可以自行创建知识库：`npm run knowledge -- create my-notes "我的资料"`，对应 `POST /knowledge {kbId,title}`。所有者由登录身份确定，初始为 private；kbId 是 1–64 位小写字母、数字或连字符，在实例内全局唯一，重复返回 409。标题为 1–200 字。原文与 Wiki 分别放在 `workspace/users/<owner>/inputs/<kbId>` 和 `workspace/users/<owner>/research/<kbId>/wiki`，与 `knowledge:init` 共用目录准备实现。

basic 最多拥有 3 个知识库、pro 最多 20 个，admin 不限；配置注册的库也计入所有者数量。Hub 在同一事务取得实例锁后计数并创建，并发也不会超额，超出返回 403 `PLAN_LIMIT`。降级保留已有资料，超额时拒绝新增。可信 Agent 配置仍可注册默认归部署初始 owner 的库，修改绑定路径不会覆盖既有库。

用户自建库采用 Agent **第一个 knowledge 挂载项**的默认模式和动作，再与 Hub 可见权限取交集；没有 knowledge 项的 Agent 不挂载。静态库仍按显式 kbId 匹配，不能借此访问未声明的静态库。原文只读；任务 update/index 仍需 `knowledge.update` workflow 授权，受分享者只有 read。新建库立即支持 Wiki；默认 rag 时先以 Wiki 工作，构建索引后按原有重启边界启用 RAG。

所有者或 admin 可调用 `DELETE /knowledge/:id`：撤销全部授权，删除 Wiki/索引登记、Chroma/BM25 索引及两处目录，原文资源记录标为 revoked。有执行中任务挂载或索引正在执行时返回 409 `KNOWLEDGE_BUSY`。目录操作遵守 s14：Linux 隔离模式使用所有者 uid 的辅助进程；本机模式使用服务端受限工具路径。创建、删除分别记录 `knowledge:create`、`knowledge:delete` 审计。

### 用户上传 Skill 的格式

准备仅含 `SKILL.md` 与 `references/` 下 `.md/.txt` 的目录。正文及附件合计最多 128 KiB，不接受代码、链接、路径穿越。`SKILL.md` 的 frontmatter 使用 Codex 原生格式；发现与解析继续由 Codex 完成。

### 命令与接口对照

接口与命令对应如下：

| CLI 子命令 | 接口 |
| --- | --- |
| knowledge -- create `<kbId> <title>` | POST /knowledge `{kbId,title}` |
| 删除知识库（HTTP） | DELETE /knowledge/:id |
| hub / plan | GET /hub、GET /me/plan |
| share / grants / unshare | POST、GET /hub/knowledge/:id/grants；DELETE /hub/knowledge/:id/grants/:username |
| publish / unpublish | POST、DELETE /hub/knowledge/:id/publish |
| skill:upload | POST /hub/skills `{name,files:{"SKILL.md":"...","references/a.md":"..."}}` |
| skill:read | GET /hub/skills/:id，审批前读取文本与申请；不会安装到 admin 目录 |
| skill:share | POST /hub/skills/:id/share `{usernames:[]}` |
| skill:approve / skill:reject | POST /hub/skills/:id/approve、reject `{}` |
| skill:unshare | DELETE /hub/skills/:id/grants/:username |
| plan:assign | POST /hub/plans/assign `{username,plan}`，admin |

`POST /sessions` 可带 `{agent:"writing-assistant"}`，只能选择当前部署的已授权 Agent；其他 Agent 使用各自部署配置。本章不引入动态 Agent 上传。

### 集成测试说明

离线验证在本阶段目录执行 `npm test`。`npm run test:data` 启动临时 PostgreSQL、Redis，运行 data、knowledge 与 hub-share 集成测试；需要本机可监听端口、`initdb`、`pg_ctl`、`redis-server` 和既有 Codex CLI。hub-share 使用普通用户 Bob 经 HTTP 自建库、导入并生成 Wiki、分享给 Carol，核对 Carol 读取成功、写入 403、Dave 404、撤权后下一轮拒绝，以及并发额度和删除清理。模型响应由本地 fixture 提供，不调用真实模型；`npm run test:rag` 另需 Chroma。
