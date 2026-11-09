# s13: 账号与认证

[导论](../introduction.md) → [s00](../s00-sdk-quickstart/) → [s01](../s01-single-turn/) → [s02](../s02-multi-turn/) → [s03](../s03-service/) → [s04](../s04-events-messages/) → [s05](../s05-agent-assembly/) → [s06](../s06-tools/) → [s07](../s07-memory/) → [s08](../s08-data-layer/) → [s09](../s09-knowledge-layer/) → [s10](../s10-skill-workflow/) → [s11](../s11-model-gateway/) → [s12](../s12-deploy/) → `s13` → [s14](../s14-isolation/README.md) → [s15](../s15-hub/README.md) → [s16](../s16-coordination/README.md) → [s17](../s17-sharding/README.md) → [s18](../s18-replication/README.md) → [app](../../app/)

全仓入口：[机制课堂](../../app/web/public/course/index.html#s13) · [阶段演示](../../app/web/public/course/changes.html#s13) · [章节长文](../../app/web/public/course/handbook.html#module-s13) · [总架构图](../../app/web/public/course/assets/s13-architecture.svg)

> **对应六个问题**：① 我是谁 ⑥ 谁说了算

## 要回答的问题

谁在使用 Agent？会话、任务、知识库和用量归谁？用户 A 知道 B 的会话 ID，是否就能读取它？

登录只解决身份识别。身份还要传到数据查询、会话缓存、文件工具、后台任务和事件订阅，才能让“这是我的数据”成为可执行的规则。本章增加 accounts 单元，把 owner 绑定到每次请求，并让后台执行延续任务记录上的归属。

## 核心概念

**账号与角色。** 管理员通过本机命令创建账号，没有注册、邮箱、找回密码或 Web 登录页。用户名规范化为小写，技术角色只有 `admin` / `user`。admin 也不能读取其他用户的资源；资源范围与权益留到 s15。

**密码与令牌分开。** 密码使用 Node 内置 scrypt：`N=2^15, r=8, p=1`，每次生成 16 字节盐，验证使用恒定时间比较。未知用户名也执行一次 scrypt，登录失败统一返回“用户名或密码错误”。不添加依赖，不实现 JWT。

登录成功后返回 `randomBytes(32)` 生成的 base64url 不透明令牌，数据库只存它的 SHA-256。令牌绝对有效期为 **7 天**，闲置 **12 小时**失效；每次请求最多每 **1 分钟**更新一次 last_seen_at。没有 refresh。登出、改密码、禁用账号都会吊销该用户的**全部令牌**，下一次请求查库时立即生效。

**身份随执行传递。** HTTP 验证令牌后，AsyncLocalStorage 携带 `{ userId, role, authSessionId }`。数据库查询按当前 owner 过滤，缓存命中也要核对归属。后台 outbox、worker 和工具回调从任务或会话记录取得 owner，不从触发调度的请求猜身份。资源不存在与不属于当前用户统一返回 **404 NOT_FOUND**。

**事件与文件也要有归属。** SSE 订阅绑定用户，事件必须带 ownerId；缺少 ownerId 就丢弃并警告。实时推送和断线补发都过滤 owner。文件工具的物理根是 `workspace/users/<ownerId>/`，目录按需创建、权限 0700；数据库 locator 仍是相对路径，同名路径可以分别属于不同用户。Codex 进程 cwd 不变。

**限流。** 登录接口按“用户名+实际来源”限制 **5 次失败/15 分钟**，按来源限制 **20 次/15 分钟**；超出返回 429 和 Retry-After。已登录业务请求按 userId 限制 **120 次/分钟**，未认证请求按来源。`/health`、`/ready` 免认证；带 Origin 的请求仍拒绝。认证响应使用 `Cache-Control: no-store`。

## 分工：Codex 做什么，我们做什么

Codex 继续处理原生 Thread、Turn、模型调用和上下文。本章不改变它的 Agent 循环，也不让模型决定请求身份。

我们负责账号命令、密码校验、令牌生命周期、请求上下文，以及数据、文件、任务和 SSE 的归属检查。人负责保管服务端配置、交互设置密码、准备 PostgreSQL 与 Redis，并在实际服务器上验收两个账号互相不可见。

## 跑起来看看

先进入本阶段目录，在本机安装相同依赖并准备服务端配置。默认 `AGENT_PORT=4327`，Compose 项目名为 `codex-harness-s13`，远程目录为 `/opt/s13-auth`。

```bash
cd stages/s13-auth  # 从仓库根进入
npm ci
cp .env.example .env
# 编辑 .env，明确设置 AGENT_MEMORY_ENABLED=false，并填写模型服务密钥
export DEPLOY_HOST=example.com  # 替换为服务器 SSH 地址或别名
bash deploy/remote.sh check
bash deploy/remote.sh init-env
bash deploy/remote.sh deploy
# 首次部署成功退出并提示：账号尚未初始化：运行 DEPLOY_HOST=example.com bash deploy/remote.sh auth-init
bash deploy/remote.sh auth-init
# 交互输入首个用户名（例如 alice）与密码；密码隐藏，随后启动 agent 并输出 /ready JSON
bash deploy/remote.sh user -- add bob
bash deploy/remote.sh user -- list
bash deploy/remote.sh tunnel
```

首次 `deploy` 只启动 PostgreSQL、Redis 和 gateway，用 agent 镜像的一次性容器迁移数据库、准备目录并查询账号状态。没有启用账号时不启动 agent，以 0 退出并清除 `.deploy-pending`，此时尚无 `/ready`。`auth-init` 成功后才启动 agent 并注册开机启动，输出包含 `"status":"ready"` 的 JSON。后续 `deploy` 检测到启用账号后会正常启动 agent 并检查 `/ready`。

`auth-init` 通过 SSH TTY 在一次性容器里运行 `npm run auth:init`，把 identity.json 中原 owner 设为第一个 admin。旧会话与知识库归属不变，顶层 inputs/research/drafts/outputs 移入该 admin 的用户目录。已初始化时拒绝重入，远程命令仍确保 agent 已启动并输出 `/ready`；其他错误不会忽略。已有数据升级时，先停服、备份，再执行迁移与初始化；不要先在目标用户目录填入同名资料。

密码只在交互提示中输入，不写成参数。维护远程账号使用（名称只接受 1–64 位小写字母、数字、下划线、点、连字符）：

```bash
bash deploy/remote.sh user -- passwd bob
bash deploy/remote.sh user -- disable bob
```

隧道终端保持打开，另开一个本机终端进入本阶段目录后登录：

```bash
export AGENT_SERVER_URL=http://127.0.0.1:4327
npm run login
npm run chat
```

客户端 `.data/credentials.json` 权限为 0600；`.data/connection.json` 只保存服务地址。用两个独立客户端工作副本分别登录 alice 和 bob，避免共用同一个 credentials.json。令牌失效时客户端提示运行 `npm run login`。

在 alice 客户端创建会话并记下 ID。在 bob 客户端列出会话，应看不到它；尝试恢复 alice 的 ID，应得到 404 NOT_FOUND。alice 拥有的知识库不会出现在 bob 的列表中，按 kbId 读取也返回 404。本章沿用实例内唯一的知识库 ID，不为新账号复制别人的知识库。两个用户可以分别生成同名产物，它们落在不同用户目录。

执行 `npm run logout` 后，该账号的其他已登录客户端下一次请求也应为 401。外部自动验收用 `npm run test:auth:integration`，其专用数据库地址从 `DATA_TEST_DATABASE_URL` 读取。

离线先运行四个实验，无需端口、数据库或模型：

```bash
npm run lesson -- hash
npm run lesson -- logout
npm run lesson -- ownership
npm run lesson -- events
npm run test:offline
```

完整 `npm test` 包含端口测试，应在沙箱外运行；端口部分可单独运行 `npm run test:ports`。真实数据库与服务器步骤见 [交付验收](docs/design.md#验证)，部署配置见 [production.md](docs/production.md)。

## 关键代码

[password.mjs](server/modules/accounts/password.mjs) 中，盐随机生成，成本固定，数据库保存派生结果而不是密码：

```javascript
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
```

[accounts/index.mjs](server/modules/accounts/index.mjs) 对未知账号使用哑哈希，仍执行同一个密码验证函数；失败分支不透露账号是否存在：

```javascript
      const user = await this.store.byUsername(normalizeUsername(username));
      const valid = await this.verify(password, user?.password_hash || DUMMY_HASH);
      if (!valid || !user || user.disabled_at) throw new AppError('用户名或密码错误。', 401, 'LOGIN_FAILED');
```

[events/index.mjs](server/modules/events/index.mjs) 在事件进入缓冲区之前拒绝缺少 ownerId 的事件。不能把没有归属误当成所有人都可见：

```javascript
  publish(type, data, threadId = null, ownerId) {
    if (!ownerId) { this.warn("丢弃缺少 ownerId 的事件。"); return null; }
    const event = { sequence: ++this.sequence, type, threadId, ownerId, data };
```

## 限制

所有用户仍共用**一个 Codex 进程、一个 CODEX_HOME、一个 workspace**。API 层看不到别人的数据，但原生记忆和 workspace 文件在底层仍共享；s14 处理用户运行隔离。

启用账号数达到 **2 个**时，必须显式设置 `AGENT_MEMORY_ENABLED=false`，否则拒绝启动。运行中添加第二个启用账号也会被同样的守卫拒绝；原生记忆可能把 A 的内容提炼给 B。关闭后 API 不返回先前保留的共享摘要，底层旧文件仍保留。

文件工具按用户分目录，原生文件能力保持关闭，文件通过我们的工具层访问。目录与门禁不是 OS 沙箱，不能抵御同机管理员或恶意插件。原生 Thread 内已有的上下文也不会因为关闭记忆而被清空。

全局并发 **2 轮**由所有用户共享，没有按用户的配额，留到 s15。登录失败窗口保存在当前进程，重启会清空；单服务的每请求查库令牌机制不等于分布式认证系统。

本章不包含注册、邮件、OAuth/SSO、JWT、refresh、按用户的 Codex 进程、资源权益、配额计费或 Web 登录页。离线夹具不证明实际 PostgreSQL、网络或服务器已验收。

## 小结

身份由登录确定，归属贯穿请求、缓存、任务、文件与推送。检查是否完成不能只看“能登录”，还要用另一个用户的 ID、失效令牌和缺少 owner 的事件验证拒绝路径。

## 下一章

[s14 用户隔离](../s14-isolation/README.md)：让运行环境与持久状态的隔离边界跟上账号边界，处理共享 Codex 进程、CODEX_HOME 和 workspace 留下的问题。
