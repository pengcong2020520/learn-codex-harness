# s13 交付与外部验收

本阶段只增加账号与认证单元。仓库改动限于 stages/s13-auth/，没有提交 Git，也未登记全仓课程或修改 stages/verify.mjs。package.json 除 name/scripts 外与 s12 相同；锁文件只改包名。默认端口 4327、Compose 项目 codex-harness-s13、远程目录 /opt/s13-auth。

## 已执行

- `npm run test:offline`：272 项通过，0 失败。HTTP 用内存 request/response 调用真实 handler；数据库用查询夹具，不代表真实 PostgreSQL 验收。
- 四个离线实验：hash 2 项、logout 1 项、ownership 1 项、events 1 项通过。
- 所有 mjs 的语法检查、Shell 语法、依赖与锁文件比较、未声明包导入扫描通过。
- README 教学标题、源码摘录与本章链接检查通过。
- 凭证日志/命令参数扫描未发现新增明文泄露；JSON 日志脱敏增加 password、token 与其哈希字段。测试固定密码仅在测试函数或 HTTP 请求体中使用，不是 shell 参数。

最后对用户根目录按需创建的小改动，单独重跑 accounts.test.mjs：19 项通过。运行测试时临时复用本机已安装的同版本依赖，交付目录不包含 node_modules。

## 外部运行：端口和 PostgreSQL

在本阶段安装依赖后执行：

```bash
npm ci
npm run test:ports
# 在当前终端配置 DATA_TEST_DATABASE_URL，指向专用测试库
npm run test:auth:integration
```

端口测试包含 http-cli、gateway-check、media-http、tool-loading，以及 streaming 中的 SSE/CLI 订阅用例。预期全部通过，认证失效提示重新登录，连接文件仅含 url。

PostgreSQL 测试会在专用库中迁移 schema，创建随机 instance 的验收数据并保留作为证据；不要指向生产数据库。它验证迁移清单重跑、新 SQL 直接重复执行、原 owner 初始化、同名 locator 分用户、真实事务吊销、绝对与闲置过期、实例级后台枚举及运行中记忆锁。预期测试通过，users 角色约束和 auth_sessions 只存令牌哈希。它不启动 HTTP 或调用模型。

```bash
npm run test:data
```

此脚本需要外部安装 initdb、pg_ctl、redis-server 和可执行的 Codex；会启动临时 PostgreSQL/Redis 与本地模拟模型服务。可选 `npm run test:rag` 还需要 Chroma。`npm test` 是包含所有 .test.mjs 的完整回归，也需允许本地监听。

## 外部运行：真实服务器

先复制 .env.example 为 .env，配置模型、PostgreSQL、Redis，并显式设置 AGENT_MEMORY_ENABLED=false。使用宿主机进程时：

```bash
npm run agent:init
npm run data:migrate
npm run auth:init
npm run user:add -- bob
npm run user:list
npm run server
```

auth:init 交互设置 alice 和密码，bob 的密码也交互输入。已有数据须停服备份后运行 data:migrate 和 auth:init；确认原 identity owner 不变，四个目录已移到 workspace/users/ownerId 下。再次 auth:init 必须拒绝。

容器部署先启动 postgres/redis/gateway，执行迁移和初始化，再启动 agent。初始化使用保留交互 TTY 的 `docker compose run --rm --no-deps agent npm run auth:init`；不要把密码写到命令里，也不要用 `-T` 关闭密码隐藏所需的交互终端。运行账号命令的容器与服务使用相同配置和数据挂载。

远程服务器使用 SSH 隧道：

```bash
DEPLOY_HOST=example.com bash deploy/remote.sh tunnel
```

在另一个客户端终端运行：

```bash
export AGENT_SERVER_URL=http://127.0.0.1:4327
npm run accept:auth
```

按提示输入 A、B 的用户名和密码；A 须拥有至少一个知识库。脚本不调用模型，但会创建一个会话；结束时吊销两个账号的所有登录令牌。预期输出：

```text
PASS：两个账号会话与知识库隔离，跨用户 404 NOT_FOUND，登出后 401，登录限流 429 + Retry-After。
```

不要在尚未过期的失败窗口内反复运行该脚本；它会有意触发登录限流。正常 CLI 登录使用 `npm run login`、`npm run chat`、`npm run logout`。两个客户端应使用不同工作副本，各自保存 credentials.json，权限必须为 0600。

在维护窗口验收记忆守卫：两个启用账号存在时，将服务 AGENT_MEMORY_ENABLED 设为 true 或移除该项，启动必须拒绝，提示“启用账号达到 2 个时必须设置 AGENT_MEMORY_ENABLED=false”。恢复 false 后可启动。运行中新增第二个账号时也使用相同提示；真实 PostgreSQL 测试还验证临时给管理命令设置 false 不能绕过旧服务持有的记忆锁。

`npm run user:passwd -- bob` 或 `npm run user:disable -- bob` 后，bob 原客户端下一次请求必须 401；密码修改后的新登录应成功，禁用后的登录统一失败。`/health`、`/ready` 仍免认证；带 Origin 仍拒绝。已经完成账号初始化与部署配置后，再运行 `npm run test:deploy:integration` 验收 Docker 健康检查与故障恢复。

## 边界与未确定项

真实 PostgreSQL、Redis、Codex、HTTP/SSE 监听、Docker 和远程服务器都未在当前沙箱验收；这些测试不能计为通过。最初继承测试中间接启动 MCP 的用例被沙箱拒绝，现已分入 test:ports，不再在离线脚本执行。

实例内知识库 ID 仍唯一，新账号不会自动得到原 admin 的知识库。资源 locator 保持原值，010 迁移只将其唯一约束改为包含 owner_id。自定义工作区目录中，auth:init 只自动迁移设计稿指定的 inputs/research/drafts/outputs；其他自定义目录需管理员在停服时核对并移到相应用户根。

所有用户仍共享一个 Codex 进程、CODEX_HOME 和 workspace；原生记忆守卫、工具分目录和 API 过滤不构成 OS 级隔离。现有 SSE 在建立时认证，不逐帧查库；吊销保证下一次请求失败。登录失败窗口在进程内，重启会清空。数据库与文件移动不是原子事务；目标目录有同名资料时拒绝覆盖，需核对后重试。

文档写作委托 agy 因沙箱禁止其内部监听而启动失败；教学文档由主代理按设计稿编写并核对。没有生成装饰性图片，精确流程采用 Mermaid 泳道图。
