# 升级到生产环境

教学集群的 PG、Redis、模型网关和 etcd 都是单实例，三个业务节点也在同一宿主机。失去宿主机或任一关键依赖，主备切换不能恢复服务。不要把共享卷实验称为多机容灾。

## etcd

生产 etcd 使用三个独立故障域的成员，各自持久化数据目录；配置成员间 TLS、客户端 TLS、身份认证与只允许访问 `/codex/` 的最小权限。etcd 节点加入、快照备份、恢复和压缩应按官方运维流程执行，不能通过复制正在写入的数据目录扩容。客户端配置三个 endpoints；数据面仍不写入 etcd。本章 Compose 保持单节点，不增加生产拓扑服务。

本章客户端使用 etcd3 的 Lease、Watch、Election 和事务；`etcd.mjs` 是生产证书、用户名与密码配置的接入位置。当前 Compose 通过不发布 etcd 端口限制到内部网络；它没有 TLS，不能直接暴露到公网。

## 凭据与隔离

常驻 node-a/b/c 分别只取得自己的 `agent_node_a/b/c` 数据库登录密码及网关访问密钥；不是 PG superuser，不能创建角色、数据库或修改迁移表。迁移时用一次性容器只读挂载 `.env`，通过 `cluster-migrate.mjs` 使用维护账号建立 schema 与权限，迁移完成后容器退出。维护密码和服务商密钥不进入常驻节点环境。三个节点数据库角色有同样的业务表读写权限，因为它们是同一个业务实例的主备。

本章没有节点互调接口，因此不生成或分发闲置的节点互调密钥；后续引入互调时再按最小权限给每个节点独立身份。网关单独接收服务商密钥，用户 Codex 子进程只得到受限环境。容器保留 `cap_drop: ALL` 与 `SETUID/SETGID/CHOWN/FOWNER`；备份与恢复的一次性进程能力不扩展到常驻服务。

默认 SSH 隧道连接服务器回环 Caddy：`DEPLOY_HOST=example.com bash deploy/remote.sh tunnel`；本机 `export AGENT_SERVER_URL=http://127.0.0.1:4334` 后登录。可由外层 HTTPS 入口按 `Caddyfile.example` 配置 example.com，不向代理注入共享用户令牌。账号密码从交互 stdin 输入，令牌保存在当前 CLI 的 0600 凭据文件，不能复制给其他用户。

## 升级、备份与验收

`remote.sh deploy` 在固定 `APP_DIR=/opt/s16-coordination` 内更新代码和 REVISION，停三个业务节点、迁移、重建后通过 Caddy `/ready` 验证。rollback、backup、restore 同样覆盖所有节点。数据库备份不携带角色授权，restore 在恢复 SQL 后重新授予三个节点业务权限，再启动服务。绝对挂载路径不能随 release 改变。备份包含登录会话；恢复旧备份后按账号轮换密码吊销旧令牌。

三节点容器内存上限合计约 3.1 GiB，服务器还应留系统和构建余量。实际进程峰值、磁盘吞吐、etcd 延迟与故障接管时间需要在目标机器测量。容器内存约束不能当成业务容量承诺。

外部执行 `npm run test:ports`、`npm run test:data`、`npm run test:runtimes:uid`、`npm run test:hub:uid`，以及独立空 etcd 上的 `ETCD_TEST_ENDPOINT=... npm run test:coordination`。实际 Compose 上运行 `npm run test:deploy:integration`；故障验收见 README 的 kill、pause/unpause、stop 与 network disconnect/connect。检查旧任期拒写、新主恢复 queued、执行中待核对、用户 uid 与 Hub 授权始终生效。

跨机器的数据不共享。本章不实现多机卷、分片、复制、数据库 epoch，也不承诺进程在暂停恢复后一条机器指令都不会执行；协调隔离、应用本地门禁、进程关闭和工具副作用的证据需分开核对。
