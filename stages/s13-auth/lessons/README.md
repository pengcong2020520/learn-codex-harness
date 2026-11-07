# 账号与认证：四个离线实验

依赖安装后，在本阶段运行以下命令。实验只调用本地哈希、HTTP handler、查询夹具和事件总线，不监听端口，不连接数据库或模型。

| 命令 | 观察 |
|---|---|
| `npm run lesson -- hash` | 随机盐、正确/错误密码；未知用户仍执行一次 scrypt |
| `npm run lesson -- logout` | 登录后可读身份；登出后原用户全部令牌下一次请求为 401 |
| `npm run lesson -- ownership` | A 读取 B 的会话缓存、任务、知识库、资源统一 404 NOT_FOUND |
| `npm run lesson -- events` | SSE 不接收 B 的事件；缺 ownerId 的事件被丢弃并警告 |

四课都使用 [accounts.test.mjs](../tests/accounts.test.mjs) 中的实际断言。`npm run test:offline` 还覆盖目录、后台归属、限流、迁移清单和初始化；真实 PostgreSQL 语义由 `npm run test:auth:integration` 在外部执行。
