# Hub 外部验收

这些步骤需要真实 PostgreSQL、Linux uid 或监听端口。离线单元测试不替代这里的验证。使用专用验收数据库与测试账号，不在生产库注入用量或修改归属。

## PostgreSQL

```bash
DATA_TEST_DATABASE_URL='postgresql://agent:TEST_PASSWORD@127.0.0.1:5432/agent_s18' npm run test:hub:pg
```

预期：重复调用迁移及直接重跑 013 都成功，既有 pro 分配不会重置。自授权、禁用账号、重复授权被拒；21 个并发授权仅 20 个成功；最后撤销回 private；approve 才写 Skill 授权；reject 无授权；审计 UPDATE、DELETE、TRUNCATE 全部抛出 `append-only`。测试保留该独立实例的审计证据。

升级兼容验收：在专用空库先用上一阶段执行迁移并准备用户和知识库，再用本阶段连续两次 `npm run data:migrate`。查询 `users.plan_id` 均为 basic，admin role 保持；所有旧库为 private。迁移前后比较 001–012 校验和、用户 ID、运行环境 uid、CODEX_HOME 与原生历史，均应不变。

## Linux uid / docker

保持现有容器能力和目录配置，运行已安装依赖的测试镜像：

```bash
docker compose build agent
docker compose run --rm --no-deps node-a npm run test:hub:uid
docker compose run --rm --no-deps node-a npm run test:runtimes:uid
```

预期：同 uid 辅助安装/读取/移除 Skill；其他 uid 无法读取；移除后同 uid 读取也失败；所有已有隔离用例仍通过。生产服务进程不进入用户 CODEX_HOME 内部。还需运行现有 `test:runtimes:pg`、`test:auth:integration`、`test:runtimes:server` 与 `test:deploy:integration`，其环境要求见相应测试文件。

## 端口与完整服务

```bash
npm run test:ports
npm run test:data
npm run test:rag
npm run test:protocol
```

前两组使用测试端口/数据库，RAG 还需要 Chroma 与 embedding 服务，协议核验需要实际 Codex。模型相关检查可能产生真实用量；沿用现有脚本的显式配置。不得将未执行的集成项计为通过。

## 服务器行为

设置 `APP_DIR=/opt/s18-replication`、`CONTAINER_APP_DIR=/opt/s18-replication`，使用 `example.com`、端口 4336、数据库 agent_s18、项目/systemd 单元 codex-harness-s18。按 README 初始化 admin、bob、carol、dave，各自在自己的终端登录。不同终端需独立 CLI 凭据目录或独立部署副本作为客户端；不要让同一凭据文件互相覆盖。

1. admin 登录，`npm run plan:assign -- bob pro`；bob 的 `/me/plan` 为 pro。carol 为 basic，`GET /hub`、`GET /tools` 和 workbench 不出现 web/media/tasks/skills 工具组；直接工具调用仍拒绝。basic 的原生 web_search 关闭。
2. 专用验收库停服后，将 general 及其已登记原文归 bob，并把对应原文复制到 bob 的工作区、由 bob uid 持有。一个可复现的更简方案是空 general：先创建 bob 运行环境，再停服只修改这个空库的 owner：

   ```sql
   UPDATE agent_data.knowledge_bases k SET owner_id=u.id
   FROM agent_data.users u
   WHERE k.instance_id=u.instance_id AND k.id='general' AND u.username='bob';
   ```

   重新启动后 bob 调用 `POST /knowledge/source` 导入 `{kbId:"general",name:"notes.md",content:"# Notes\n测试资料"}`；不要复制 admin 原生历史。此 SQL 只用于准备验收归属，不属于对外分享接口。对有内容的库不能仅改 owner，应同步迁移其原文和资源登记。
3. bob `npm run hub -- share general carol`。carol `/hub` 显示所有者 bob、scope shared、actions `[use,read]`。carol `GET /knowledge` 可见；`POST /knowledge/index`、`POST /hub/knowledge/general/grants` 返回 403。dave 的 `/hub` 不显示该库，读取、索引、授权接口返回 404。用 bob 的 workflow 生成 Wiki 后，carol Wiki/RAG 可读，引用源也按 bob uid 读取。
4. carol 在已挂载 general 的会话启动一轮，在其未完成时 bob 撤销。执行中该轮工具仍按快照完成；carol 新请求看不到 general；该会话下一轮在 RPC 前拒绝，不再读取共享内容。新建不挂载该库的会话仍可普通对话。
5. bob 上传 `examples/private-skill`。确认仅 bob 的 CODEX_HOME 有安装副本，admin 的目录不会自动安装 bob 私有 Skill。bob 提议分享给 carol，pending 期间 carol 看不到；admin approve 后 carol 立即出现副本。下一轮前检测集合变化，等待活动轮次结束后只重启 carol 进程；按兼容提示新建会话。重复一次改用 reject，carol 不获得权限。bob 撤销后文件立即移除，其他用户进程不受影响。
6. 冷启动 carol 时并发执行 approve/unshare，最后一次返回 unshare 成功后检查文件仍不存在。重启服务再次检查，数据库允许集合与 manifest 一致。尝试 admin 自提议自批准，得到 403。
7. 在专用库为 carol 写入当天 200,000 token 的测试账本，提交新消息，保持 queued；另一用户可派发。当前已执行的一轮仍完成。将测试账本日期移到该预算时区的前一天，等待自动唤醒，或运行 `POST /queue/continue`，应恢复派发。测试账本使用既有 usage 列，不修改生产用量：

   ```sql
   INSERT INTO agent_data.usage(instance_id,owner_id,source,model,input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,currency)
   SELECT instance_id,id,'chat','test/model',200000,0,0,0,200000,'CNY'
   FROM agent_data.users WHERE username='carol';
   ```

8. bob pro 同时启动两轮，再降级 basic；两轮均完成，之后最多 1 轮。carol basic 的两个会话最多 1 轮，全局始终最多 2 轮。bob 原有原生搜索会话不能在降级后继续使用旧搜索配置：活动轮次完成后该用户进程空闲重建。
9. admin 发布 general，其他用户可读；取消发布后新请求不可见，执行中的轮次不中断。查询 permission_events，核对 share/unshare/publish/plan:assign/approve/reject 的 actor、资源、前后值。

## 失败恢复

故意让接收者的辅助进程同步失败：接口报错，但授权以已提交数据库为准；重试撤销应再次清理。下次用户进程启动会按数据库完整同步，核验失败则不派发。原生历史、`.system` 与其他用户目录均不可被删除。
