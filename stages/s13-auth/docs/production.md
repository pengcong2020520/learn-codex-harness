# 账号服务的外部部署验收

默认继续使用 SSH 隧道：`DEPLOY_HOST=example.com bash deploy/remote.sh tunnel`。在另一个终端设置 `AGENT_SERVER_URL=http://127.0.0.1:4327`，再运行 `npm run login`。用户名和密码从交互 stdin 输入；本地 `.data/credentials.json` 保存该用户的令牌，权限为 0600。不要复制服务器 credentials 文件，也不要把令牌放进命令参数。

可选的 [Caddyfile.example](../deploy/Caddyfile.example) 将 HTTPS 请求转给本机服务，并保留客户端自己的 Authorization。代理不能注入共享身份。请求带 Origin 时后端仍拒绝，本章不提供浏览器登录。

先准备 `.env`、网关、PostgreSQL 和 Redis，执行 `npm run data:migrate`，停服运行 `npm run auth:init`。容器内命令使用 `docker compose run --rm --no-deps agent npm run auth:init`，保留交互终端，不加 `-T`；密码不会回显。账号初始化后才能启动 agent。添加第二个启用账号前，在实际服务配置中设置 `AGENT_MEMORY_ENABLED=false` 并重启，再执行 `npm run user:add -- bob`。只修改管理命令的环境变量不能绕过运行中服务的记忆锁。

登录失败统一为“用户名或密码错误”。用户名+实际 socket 来源累计 5 次失败/15 分钟，来源累计 20 次/15 分钟；超出返回 429 和 Retry-After。代理后登录来源会聚合成代理地址，不读取客户端提供的 X-Forwarded-For。已认证业务请求按 userId 每分钟 120 次，同一用户换令牌或来源也共享额度。`/health`、`/ready` 免认证且不占此额度。

外部验收执行 `npm run test:ports`、`npm run test:auth:integration`（设置专用 `DATA_TEST_DATABASE_URL`）、`npm run test:data`，以及已准备好账号与配置后的 `npm run test:deploy:integration`。当前沙箱没有验证真实监听、数据库、容器或服务器行为。备份包含 users 和 auth_sessions；恢复旧备份也会恢复其令牌状态，恢复后应对账号执行 `user:passwd` 吊销旧令牌，再登录。

所有用户共用一个 Codex 进程、CODEX_HOME 和 workspace。工具只能访问 `workspace/users/<ownerId>/`，这不是操作系统级用户隔离；s14 继续处理底层隔离。备份、恢复、网关和全局并发仍使用本阶段继承的部署机制。
