# s12 离线机制实验

运行 `npm run lesson -- list` 查看清单。实验使用 Node 内置 test runner；需要已有 npm 依赖，不需要 Docker、网络或监听端口。测试夹具仅存在于 tests，不是运行库替代品。

| 命令 | 实验问题 | 预期 |
| --- | --- | --- |
| `npm run lesson -- s12-health` | 网关故障时进程是否仍存活？ | /ready=503、/health=200，带版本；关闭先停派发并限时 30 秒 |
| `npm run lesson -- s12-queue` | 全局能同时执行与排队多少？ | 并发 2；全局排队 200、单会话 100；满时 QUEUE_FULL |
| `npm run lesson -- s12-protection` | 请求和 SSE 如何限量？ | 第 121 次请求 429 + Retry-After；第 21 个 SSE 拒绝；关闭释放 |
| `npm run lesson -- s12-backup` | 备份是否完整、何时删除旧份？ | 摘要/大小可核验；仅保留最近 7 份；恢复失败保持停服 |

队列实验运行真实 MessageService 和 PostgresJobs 门禁，仓储查询与 Codex RPC 使用测试夹具；不声称验证了数据库锁的跨连接行为。备份实验真实读写临时文件与计算 SHA-256，并核对备份命令为 docker compose exec postgres pg_dump；未真正运行 pg_dump。HTTP 测试直接调用 handler，没有创建监听端口。

另外 `npm run test:deploy` 检查 Compose、Dockerfile、变量分配与文档约束。Linux 可运行 `node --test tests/deploy-lock.integration.mjs`：真实 flock 持有期间第二个下载立即被拒绝，rsync 用阻塞程序代替，不发生传输；缺少 flock 会明确 skip。

Docker、真实数据库并发事务、SIGTERM、SSH 下载、恢复与回滚必须按 [交付验收](../delivery.md) 在外部执行，离线通过不代表这些项已经通过。
