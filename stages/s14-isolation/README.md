# s14: 用户运行环境

> **对应六个问题**：③ 之前聊过什么 ⑥ 谁说了算

## 要回答的问题

API 核对 owner 只能管住业务接口。原生历史、索引、记忆与 Skill 副本放在哪里，哪个进程有权读取它们，也需要明确的用户边界。

本章的答案是一个用户运行环境：独立的 Codex App Server、CODEX_HOME、系统 uid/gid 和工作目录。请求先确定 owner，再取得这个用户的连接。

## 核心概念

| 概念 | 本章约定 |
| --- | --- |
| 身份映射 | `user_runtimes` 保存 user_id、uid、codex_home、created_at；以 instance_id 区分数据实例 |
| 系统用户 | uid 从 10001 顺序分配，gid 与 uid 同号；不依赖 `/etc/passwd` |
| 原生状态 | 新用户 `.data/users/<id>/codex`；第一个 admin 保留 `.data/codex` 的绝对路径 |
| 工作区与日志 | `workspace/users/<id>`、`.runs/users/<id>/app-server-*` |
| 文件边界 | 用户目录为该用户 uid 所有，服务共享组 gid 1000，模式 2770；用户子进程不加入共享组 |
| 池容量 | 最多 4 个进程，启动中的进程也占名额 |
| 空闲 | 没有执行中轮次、没有排队任务，且 10 分钟无请求；处理中请求持有租约 |
| 容量不足 | 回收最久未用且空闲的进程；全部忙则 503 `RUNTIME_BUSY`，`Retry-After: 10` |
| 启动与失败 | 同一用户 single-flight，启动超时 30 秒；失败不成为可用连接 |
| 故障处理 | 崩溃或禁用只关闭该用户进程，其执行中任务待核对；不自动重发 |

`2770` 中的 setgid 使新文件继承服务共享组。容器服务以 `0:1000` 运行，删除全部 capability 后只加回 SETUID、SETGID、CHOWN、FOWNER，并设置 no-new-privileges。没有 DAC_OVERRIDE，服务读写仍须满足权限位。系统父目录只开放穿越，用户边界目录不开放其他用户访问。

## 分工：Codex 做什么，我们做什么

Codex 管理原生会话、模型轮次、历史、Skill 发现和记忆处理。服务管理登录身份、owner 路由、系统用户映射、运行环境池、队列与工具权限。

HTTP 使用认证后的 owner；后台派发使用任务记录的 owner；通知携带连接的 owner；工具回调同时核对连接、会话及任务记录。参数里自称的用户身份不能参与授权。全局仍最多执行 2 轮。

每个运行环境启动时同步 Agent 包 Skill 并向它自己的 Codex 核验；输入中的 Skill 路径也属于该用户。记忆总开关、读取与贡献语义仍由服务端配置控制，账号数量不改变开关。

## 跑起来看看

需要 Node.js 24。离线实验不需要 PostgreSQL、Docker、监听端口、模型或 root：

```bash
npm ci
npm test
npm run lesson -- routing
npm run lesson -- pool
npm run lesson -- crash
```

在可运行 PostgreSQL、Redis 的本机准备 `.env` 后，执行：

```bash
npm run data:migrate
npm run agent:init
npm run auth:init
npm run user:add -- bob
npm run server
```

另开终端运行 `npm run login` 和 `npm run chat`。默认端口为 `4328`。非 root 本机运行会打印“本机开发模式：未启用系统用户隔离”：仍有各用户的进程和目录，但所有子进程使用当前系统用户。容器内无法切换 uid 会拒绝启动。

容器、PG 与真实模型验收见 [用户运行环境验收](docs/isolation-acceptance.md)。部署示例域名为 `example.com`，默认目录为 `/opt/s14-isolation`，compose 项目及 systemd 单元均为 `codex-harness-s14`，数据库为 `agent_s14`。运行环境按需启动，因此 `/ready` 不代表每个用户已经完成 Codex 核验；首次请求会实际启动并核验。

## 关键代码

### 1. 固定容量与时间边界

摘自 [runtimes/pool.mjs](server/modules/runtimes/pool.mjs)：

```javascript
export const RUNTIME_LIMIT = 4;
export const IDLE_MS = 10 * 60 * 1000;
export const START_TIMEOUT_MS = 30 * 1000;
export const busyError = () => Object.assign(new AppError('用户运行环境繁忙，请稍后重试。', 503, 'RUNTIME_BUSY'), { retryAfter: 10 });
```

启动占位先进入池，并发请求等待同一个 promise；请求结束释放租约。容量判断同时检查租约、轮次与持久化队列，回收结束才释放名额。

### 2. 工具回调验证两个身份来源

摘自 [runtimes/router.mjs](server/modules/runtimes/router.mjs)：

```javascript
export function assertToolOwner(connectionOwner, task, session) {
  if (!task || task.userId !== connectionOwner || session?.ownerId !== connectionOwner)
    throw new AppError('工具回调的连接用户与任务 owner 不一致。', 403, 'RUNTIME_OWNER_MISMATCH');
}
```

连接 owner 在进程启动时绑定，任务 owner 来自数据库。核对通过后仍须满足执行中轮次与 PermissionGate 的范围检查。

### 3. 最终 spawn 使用固定 umask

摘自 [codex/launch.mjs](server/modules/codex/launch.mjs)：

```javascript
export function userSpawn(executable, args, { uid, gid, isolated }) {
  return {
    command: '/bin/sh',
    args: ['-c', 'umask 0007 && exec "$0" "$@"', executable, ...args],
    options: isolated ? { uid, gid } : {},
  };
}
```

可执行文件与参数逐项传递，不拼进 shell 脚本。环境仅保留网关地址和访问密钥、CODEX_HOME、CODEX_SQLITE_HOME、PATH、HOME=CODEX_HOME、LANG，不继承数据库、Redis、服务商凭据或 Node 注入变量。

## 限制

所有用户进程仍在同一个容器、同一个内核下运行。每用户独立 uid 提供文件级隔离，但不隔离 CPU、内存和网络；按用户容器或虚拟机属于生产加固，不在本章范围。

全局并发与模型预算仍由所有用户共享；s15 处理配额与权益。系统仍是单机，s16 处理多主机。文件的 API 归属校验和工具权限仍然必需，独立 uid 不替代这些检查。本机开发模式没有系统用户隔离。

记忆已物理分开，但开启不代表生成成功：固定版本下禁用原生写工具时，后台合并仍不能写出最终摘要。知识库挂载策略对记忆的限制继续生效。进程崩溃只意味着结果不确定，必须核对原生历史与任务状态。

## 小结

用户运行环境把 owner 从业务记录延伸到原生进程、状态目录与系统身份。池控制机器资源，租约防止误回收，按 owner 恢复避免一个用户的故障停止所有人的工作。

## 下一章

s15 权限与资源 Hub：在用户运行环境之上明确资源共享、配额与权益。
