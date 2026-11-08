# s15：权限与资源 Hub

对应六个问题：⑤ 能用什么 ⑥ 谁说了算

## 要回答的问题

多个用户共用 Agent 服务时，谁能看到、使用、修改、分享和删除资源？授权撤销后什么时候生效？一个用户用完今天的 token，其他用户还能继续吗？

本章只引入权限与资源 Hub。每用户进程、uid、CODEX_HOME、同 uid 辅助读写、全局队列继续承担各自职责。

## 核心概念

`hub.can(user, action, resource)` 统一处理 `use | read | modify | share | delete`。看不见返回 404；看得见但不能执行动作返回 403。`GET /hub` 返回可见资源的类型、scope、所有者用户名与可执行动作。会话、普通文件仍是个人隔离对象，admin 不能借分享接口进入别人的会话。

| scope | 可用者 | 可修改者 |
| --- | --- | --- |
| private | 所有者、admin | 所有者、admin |
| shared | 所有者、指定被授权者、admin | 所有者、admin |
| system | 所有用户，受权益限制 | admin |

知识库分享无需审批；每个资源最多授权 20 人，不能授权给自己、不存在或已禁用账号。禁用账号的授权记录保留但不生效。有授权时为 shared，最后一条撤销后回 private。发布为 system 会清除指定授权；取消发布回 private。

| 权益 | Agent | 工具组 | 每日 token | 同时轮次 | 知识库 | 私有 Skill |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| basic | writing | files、knowledge | 200,000 | 1 | 3 | 3 |
| pro | 全部系统 Agent | 全部系统工具组 | 1,000,000 | 2 | 20 | 20 |

新用户默认 basic。admin 不受权益限制，但管理操作仍写审计；全局最多 2 轮继续有效。`pro` 在表中以 `['*']` 表示全部系统集合。部署中的 `writing` 对应 `agents/writing/`，Agent ID 为 `writing-assistant`。

有效工具 = Agent 白名单 ∩ 权益工具组 ∩ 工具组可见范围。原生联网搜索也受 web 工具组限制。工具组与 Agent 只允许 system，不接受用户上传工具代码。

Skill 上传后是 private，仅同步到所有者的 CODEX_HOME/skills。所有者提出共享名单形成 pending，另一位 admin approve 后写授权并同步；reject 不授予权限。撤销立即移除被授权者的安装副本。已有轮次保留启动时的权限快照，下一轮核对新规则；Skill 集合变化需要空闲边界重启该用户进程，并按已有兼容规则新建会话。

## 分工

| 单元 | 职责 |
| --- | --- |
| Hub | 资源可见性、动作、权益、授权审批、配额判定、审计 |
| PermissionGate | 可信轮次上下文、Agent 挂载、workflow 临时授权、输出范围 |
| sessions / messages | 会话绑定、下一轮重验共享知识库、保留超额排队任务、全局与用户并发 |
| knowledge / resources / RAG | 先经 Hub 授权，再查版本、来源与索引；共享原文按原 owner 的 uid 读取 |
| runtimes / Codex | 每用户进程和目录、同 uid Skill 同步、发现核验、空闲受控重启 |
| PostgreSQL | plans、授权唯一与数量约束、scope 联动、只追加 permission_events |

## 跑起来看看

需要 Node.js ≥24；依赖与上一阶段完全一致。复制 `.env.example` 为 `.env`，配置数据库、Redis 和模型，再执行：

```bash
npm ci
npm run db:up
npm run data:migrate
npm run agent:init
npm run auth:init
npm run user:add -- bob
npm run user:add -- carol
npm run user:add -- dave
npm run server
```

另开终端 `npm run login`，使用自己的账号。默认端口 `4329`，数据库 `agent_s15`，compose 项目和 systemd 单元 `codex-harness-s15`，部署目录 `APP_DIR=/opt/s15-hub`，示例域名 `example.com`。

```bash
npm run hub -- hub
npm run hub -- plan
# 使用已登录的 admin 身份，经 HTTP 分配；CLI 不直接改数据库
npm run plan:assign -- bob pro
npm run hub -- share general carol
npm run hub -- grants general
npm run hub -- unshare general carol
# admin 发布与取消发布
npm run hub -- publish general
npm run hub -- unpublish general
```

知识库由可信 Agent 配置注册，默认归部署初始 owner；分享命令须由该知识库所有者或 admin 执行。专用服务器验收中准备 bob 所有的知识库，方法见 [验收步骤](docs/hub-acceptance.md)。知识库创建数量由 Hub 注册入口检查，修改绑定路径不会覆盖既有库。降级不删除已有资料；超过数量上限时拒绝新建。

准备仅含 `SKILL.md` 与 `references/` 下 `.md/.txt` 的目录。正文及附件合计最多 128 KiB，不接受代码、链接、路径穿越。`SKILL.md` 的 frontmatter 使用 Codex 原生格式；发现与解析继续由 Codex 完成。

```bash
npm run hub -- skill:upload notes ./examples/private-skill
# 返回 id 后，所有者提交申请
npm run hub -- skill:share <id> carol
# 另一位 admin 登录后先审阅正文，再审批；不能自己提议自己批准
npm run hub -- skill:read <id>
npm run hub -- skill:approve <id>
npm run hub -- skill:reject <id>
# 所有者撤销，无需审批
npm run hub -- skill:unshare <id> carol
```

接口与命令对应如下：

| CLI 子命令 | 接口 |
| --- | --- |
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

```bash
npm test
npm run lesson -- list
npm run lesson -- intersection
npm run lesson -- scope
npm run lesson -- skill-approval
npm run lesson -- quota
npm run lesson -- revocation
```

离线实验不需要端口、PostgreSQL、docker 或 uid 切换。真实约束、端口和容器验收见 [hub-acceptance.md](docs/hub-acceptance.md)；未执行的集成测试不能计为通过。

## 关键代码

第一段：工具权限由三个集合共同决定，工具回调仍在可信轮次上下文内重新执行同一判定。

```javascript
export function effectiveTools(user, agent, groups) {
  return [...new Set(groups.filter(group => decision(user, 'use', { ...group, type: 'tool_group' }) === 200)
    .flatMap(group => group.tools).filter(name => agent.tools.allow.includes(name)))];
}
```

第二段：新轮次在执行边界获取最新快照；`gate.start` 把它绑定到轮次，之后的撤销不改变这份快照。

```javascript
  atBoundary(operation, options) {
    const fresh = () => this.permissionHub ? this.permissionHub.withUser(currentIdentity().userId, operation) : operation();
    const run = () => this.boundary ? this.boundary.run(fresh, options) : fresh();
    return this.rpc.pool ? this.rpc.pool.withOwner(currentIdentity().userId, run) : run();
  }
```

第三段：超额只停派新轮次，任务保持 queued，已有轮次仍继续完成；定时唤醒按预算时区再次检查。

```javascript
    const entitlement = await this.permissionHub?.plan(job.userId, ownedRunning.size);
    if (entitlement?.concurrencyBlocked) return;
    const legacyBudget = await this.usage?.budgetStatus();
    const budget = entitlement?.exceeded ? entitlement : legacyBudget;
    if (budget?.exceeded) {
      this.retryBudget(threadId, budget);
      await this.publish(threadId);
      return;
    }
```

完整实现见 [Hub](server/modules/hub/index.mjs)、[门禁](server/modules/permissions/index.mjs)、[调度](server/modules/messages/index.mjs)。

## 限制

只支持指定用户名，没有小组、组织、计费、支付或 Skill 市场。权益由 admin 手动分配。用户 Skill 只能提供指令文本，执行能力仍来自服务端可信工具。授权与审批按实例事务串行，当前服务仍是单主机单执行器。

数据库授权与文件同步不能组成同一事务。同步失败时权限已按数据库提交，接口报错；重试撤销会再次清理副本。下一次用户进程启动会完整对账，在核验完成前不会执行新轮次。共享原文若已变化但所有者尚未登记新版本，返回 `SOURCE_STALE`，不返回旧内容。

本机非 root 模式不具备系统 uid 隔离；容器内不能切 uid 则拒绝启动。生产服务进程不进入用户 CODEX_HOME 内部；安装、移除和读取均交给同 uid 辅助进程。已经提供给模型的正文不会因撤销而从当前轮次记忆中消失；下一轮重新检查挂载权限。

## 小结

Hub 统一回答资源能否看、用、改和分享，运行环境继续隔离用户的进程与原生状态。权限变化在下一轮执行前落实，用量按 owner 归集，审计保存每次管理决定。

下一章：s16 多主机调度。
