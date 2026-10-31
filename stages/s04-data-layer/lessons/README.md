# s04 · 可执行机制实验

在本阶段目录使用 Node.js 24+；已安装依赖后运行：

```sh
npm run lesson -- list
npm run lesson -- s04-persistence
```

每课先输出学习问题、真实校验命令、预期观察、原因和证据边界，再运行本目录的模块测试。预期观察不是成功宣告；以 Node 测试报告的 pass / fail / skip 为准。参数只接受列出的课时 ID 和该课显式门禁，不接收任意 shell。

| 课时 | 要验证的问题 | 运行方式 |
| --- | --- | --- |
| s04-persistence | 服务重启后，凭什么确定排队项和会话归属仍然可信？ | `npm run lesson -- s04-persistence --integration` |
| s04-dispatch | Redis 丢失一次唤醒，会不会连任务本身也丢失？ | `npm run lesson -- s04-dispatch --integration` |
| s04-versions | 资料正文变了，旧引用为何不能继续当有效证据？ | `npm run lesson -- s04-versions --integration` |

离线实验使用临时目录、假 RPC 或本地协议进程，调用真实产品模块并执行 assert；不读取本阶段的 .env、不连接外部模型、不访问生产资料。子测试只继承系统路径与临时目录环境，不继承提供商凭据。测试结束清理自己创建的临时文件。

## s04-persistence · 把产品状态落进事务

PostgreSQL 保存产品元数据和任务原文；它不替代 Codex 的完整 Thread 历史。

观察：迁移重复执行保持幂等，事务失败回滚；归属约束与单实例执行器锁受到真实 PG 断言；真实服务链路重启后仍能检查持久任务状态。

边界：集成门禁：默认未运行。显式开启后运行本阶段现有完整 test:data 小组，包含真实临时 PostgreSQL / Redis、文件断言及真实本地 Codex + 假 Responses 服务；无外部模型。s04 三课共用该组，运行一次即可覆盖，不需逐课重复。

## s04-dispatch · 提交与唤醒分开负责

PG 是任务事实来源，Redis Set 中的 Thread ID 负责唤醒；测试不宣称端到端 exactly-once。

观察：任务提交与 outbox 同事务；重复投递只成功领取一次；Redis 失败后 outbox 可补投。

边界：集成门禁：默认未运行。显式开启后运行本阶段现有完整 test:data 小组，包含真实临时 PostgreSQL / Redis、文件断言及真实本地 Codex + 假 Responses 服务；无外部模型。s04 三课共用该组，运行一次即可覆盖，不需逐课重复。

## s04-versions · 稳定资料 ID 与变化的版本

路径、资料身份和内容版本分别解决定位、追踪与证据有效性。

观察：更新版本保留稳定资源 ID；移动不改变资料 ID，旧版本引用被拒绝；外部改写或删除来源会使派生内容失效。

边界：集成门禁：默认未运行。显式开启后运行本阶段现有完整 test:data 小组，包含真实临时 PostgreSQL / Redis、文件断言及真实本地 Codex + 假 Responses 服务；无外部模型。s04 三课共用该组，运行一次即可覆盖，不需逐课重复。

## 集成实验前置条件

不带标志只打印 NOT RUN，不启动数据库、不宣告通过。`--integration` 运行现有 `scripts/test-data.mjs`；需要 PATH 中可用的 `initdb`、`pg_ctl`、`redis-server` 和已安装的本地 Codex npm 包。脚本创建专属临时服务与动态端口，结束后停止它们；失败保留临时日志供诊断。不要用已有数据库 URL 替换该隔离流程。

多课如果共用同一集成小组，只需选一课显式运行一次，核对测试报告中对应断言。完整小组覆盖比单课更宽，耗时也更长；默认离线课不会隐式调用它。
