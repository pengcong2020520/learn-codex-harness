# 副本与故障接管设计

本章只增加 replication 单元。每用户 uid 与原生运行环境仍由 runtimes 管理；hub、知识库授权、迁移操作单、每节点认证、CT001 和 SH001 的职责不变。

## 复制边界与提交

```mermaid
sequenceDiagram
 participant P as 主节点
 participant PG as PostgreSQL
 participant R as 从节点
 P->>P: 轮次结束，5秒合并
 P->>P: runOwner，关闭派发，pool.withOwner / hub.withUser边界
 P->>PG: 检查用户全部会话无执行中轮次
 P->>P: 关闭空闲进程，计算内容哈希
 P->>PG: SH001 写复制操作单
 P->>R: 每节点认证，epoch+token，复用transfer导出home/workspace
 R->>PG: 核对当前主/从/epoch/操作单并持有归属共享锁
 R->>R: 同级暂存、限大小空间、拒绝链接、恢复数值属主
 R-->>P: 全部目录与不可变正文导入成功
 P->>PG: SH001 事务写位点并删除操作单
 P->>P: 解除本地暂停，queued继续派发
```

目录 hash 忽略 mtime/atime 和 CODEX_HOME 顶层 tmp；包括相对路径、文件内容、数值属主和权限。home hash/export 用用户 uid，workspace 用服务 0:1000。tar 导入安全路径全部复用 transfer；非 tmp 链接、硬链接、设备文件均拒绝，清除特殊权限位。同级暂存避免跨挂载 EXDEV。附属正文按 PG 用户归属清单和摘要验证。导入事务与分片切换互斥；位点之前不认为一对目录已经可接管。失败保留操作单，以 unavailable 取代提升半份文件。

60 秒 sweep 只检查当前主节点的用户。失败不让主服务隔离；/cluster 同时展示操作单、复制错误和每用户落后。落后轮数计未复制 completed 任务，秒数从其中最早完成时间起算；已同步空闲用户为 0。超过 300 秒标记 replica_lagging，/ready 保持正常健康结果并增加 degraded。

## 控制事务与恢复

```mermaid
sequenceDiagram
 participant E as etcd
 participant C as control
 participant PG as PostgreSQL
 participant N as 新主
 participant O as 旧主
 E-->>C: 主成员租约10秒到期，Watch Delete
 C->>PG: CT001事务锁住归属，验证ready/在线/完整位点
 C->>PG: primary=replica，replica=null，epoch+1，publishing/recovering=true
 PG-->>C: COMMIT
 C->>E: guardedPut当前任期分片表
 C->>PG: 发布确认，publishing=false
 E-->>N: Watch刷新归属
 N->>PG: runOwner + SH001 恢复三类任务
 N->>C: 当前新主/epoch恢复确认
 C->>PG: CT001清除recovering
 N->>N: queued按原有会话暂停规则派发
 O->>PG: 旧epoch迟到结果
 PG-->>O: SH001
 O->>E: 刷新路由
 O->>O: 仅停止失去归属的分片用户进程
```

PG 是归属权威，etcd 是可 Watch 的发布面。`publishing` 在 PG 提交之后、etcd 成功之后才解除；etcd 失败由 control 对账重发。不回退 epoch。业务派发同时核对 PG primary/epoch 和缓存，不能只看缓存是否认为自己是主。

恢复以 `replication_positions.epoch = 新epoch-1` 的位点为边界。completed 尾部改 replica_missing，原记录、任务 ID 与 error 提示保留；starting/running/steering 改 unconfirmed 并暂停对应会话；queued 仅补 outbox，不改变状态。相同会话有 unconfirmed 时必须人工核对后继续。恢复可重复执行，不重跑结果不明任务。

原主回归使用 previous_primary，成为 replica，ready=false。当前新主为该分片所有已命名用户建立本 epoch 位点后由 control 验证并设置 ready；新用户尚无基线也会阻止提升。手动 promote 先持久化 paused，等待执行中任务，再完整同步和同样的切换流程；失败保留暂停，重试同一命令。没有自动切回或再平衡。

## 接口与文件

- `POST /cluster/promote {shardId}`：admin，转发后由 control 再鉴权。
- `PUT /internal/replication/tree|content`：每节点密钥 + 当前主/从/epoch + PG 操作单；无用户冒名参数。
- `POST /internal/replication/ready|recovered`：control 核对调用节点和当前 epoch，再在 CT001 事务内确认。
- `POST /internal/replication/sync`：只接受当前 control，PG 分片必须已暂停。
- `replication_positions` 与 `replication_transfers`：SH001 行保护，不使用 control 任期代替用户归属。
- 路由广告地址由 AGENT_NODE_ADDRESS 配置。两机部署只通过 SSH 转发基础服务和节点端口，第二台只拿自身最小凭据。

## 验证与已知边界

离线测试调用生产 worker、control、store、guardedPut 和 RouteCache，不使用总是 JSON.stringify 的假序列化。真实 PG 测试验证触发器拒写、位点和丢失标记。认证 etcd 测试释放续约后等待租约自然过期，验证 ≤15 秒切换和未追平拒绝。Linux uid 测试使用三个完整实例和独立目录，以模拟模型检查真实原生历史中两轮回复。

控制面单点、全量 tar 成本、有限磁盘空间和异步尾部丢失是明确限制。运行中的目录不做在线 SQLite 备份；为一致性在边界关闭空闲用户进程，下一次对话会重新启动。对象存储和增量复制属于生产化方向。
