# Demo 5 · 可执行机制实验

在本 Demo 目录使用 Node.js 24+；已安装依赖后运行：

```sh
npm run lesson -- list
npm run lesson -- d5-gate
```

每课先输出学习问题、真实校验命令、预期观察、原因和证据边界，再运行本目录的模块测试。预期观察不是成功宣告；以 Node 测试报告的 pass / fail / skip 为准。参数只接受列出的课时 ID 和该课显式门禁，不接收任意 shell。

| 课时 | 要验证的问题 | 运行方式 |
| --- | --- | --- |
| d5-gate | 模型自己补一个 ownerId，能否获得维护权限？ | `npm run lesson -- d5-gate` |
| d5-mounts | Agent 没有挂载的 KB，能否通过宽泛 inputs 路径绕过？ | `npm run lesson -- d5-mounts` |
| d5-wiki | 两次维护同时提交，为什么只能有一个新版本生效？ | `npm run lesson -- d5-wiki --integration` |
| d5-rag | 向量索引完成，为什么还不能证明知识回答准确？ | `npm run lesson -- d5-rag --rag` |
| d5-modes | 首次选择 RAG 但索引未就绪，与已启用 RAG 后故障，应当同样回退吗？ | `npm run lesson -- d5-modes` |

离线实验使用临时目录、假 RPC 或本地协议进程，调用真实产品模块并执行 assert；不读取本 Demo 的 .env、不连接外部模型、不访问生产资料。子测试只继承系统路径与临时目录环境，不继承提供商凭据。测试结束清理自己创建的临时文件。

## d5-gate · 让工具只接受可信任务身份

PermissionGate 使用服务端建立的任务上下文与活动轮次，参数不能制造身份。

观察：伪造上下文与外部 owner 被拒绝；普通任务不能更新 Wiki；合法维护任务可以；旧 turn 结束后上下文失效。

边界：离线真实 PermissionGate；Agent / task 为夹具，无 PG，无模型，不等于完整用户登录认证。

## d5-mounts · 知识库存在不等于挂载

门禁同时识别 KB 身份与其底层目录，避免读文件成为知识库隔离旁路。

观察：当前 KB 的读取通过；另一 KB 的直接路径读取被拒绝；未挂载 KB 与错误 owner 被拒绝；Wiki 路径不能通过普通 write_file 创建。

边界：离线真实 PermissionGate，已注册 KB 列表和 Agent 为夹具；不证明数据库注册过程。

## d5-wiki · 知识页由证据和版本约束

Wiki 正文在文件/blob，PG 保存版本和依赖；维护是受限的普通 Agent 任务。

观察：Wiki 提交后可读取，两个并发 expectedVersion 只成功一个；来源改写后不能继续返回旧正文；真实本地 Codex 维护任务带服务端知识权限并调用知识工具。

边界：集成门禁：默认未运行。显式开启后运行现有 test:data 小组（data.integration + knowledge.integration）；真实临时 PG/Redis、本地 Codex 与假 Responses 服务。RAG 用例无 Chroma 时明确跳过；不代表 RAG 已通过。

## d5-rag · 来源分块进入混合召回

RRF 合并两路排名，来源版本限制证据有效性；fixture 向量只验证管线，不能证明语义质量。

观察：真实 Chroma 与 BM25 双索引提交；中文查询经混合召回返回对应来源；失败保留旧索引，源版本变化拒绝陈旧结果。

边界：RAG 集成门禁：仅 --rag 显式执行现有完整 test:rag 小组。真实临时 Chroma/PG/Redis，embedding 为本地确定性假服务，无外部 embedding 或模型。

## d5-modes · 期望模式与实际模式分开

启动时固化有效模式让 Thread 版本保持一致；上线后的失效要显式暴露。

观察：首次期望 RAG、未就绪时实际仍 Wiki；索引就绪后当前实例不自行切换；重新 open 才选择 RAG；已是 RAG 后不可用则报 RAG_NOT_READY，不静默回退。

边界：离线调用真实 KnowledgeService.open；数据库响应与 rag.ready 为固定夹具，不验证 SQL、Chroma、embedding 或检索质量。

## 集成实验前置条件

不带标志只打印 NOT RUN，不启动数据库、不宣告通过。`--integration` 运行现有 `scripts/test-data.mjs`；需要 PATH 中可用的 `initdb`、`pg_ctl`、`redis-server` 和已安装的本地 Codex npm 包。脚本创建专属临时服务与动态端口，结束后停止它们；失败保留临时日志供诊断。不要用已有数据库 URL 替换该隔离流程。

多课如果共用同一集成小组，只需选一课显式运行一次，核对测试报告中对应断言。完整小组覆盖比单课更宽，耗时也更长；默认离线课不会隐式调用它。

RAG 只有 `npm run lesson -- d5-rag --rag` 才运行，需要 `chroma` CLI 与 `chromadb` npm 包。该命令执行 data + knowledge 完整集成小组并启用 Chroma；普通 `--integration` 会跳过真实 RAG 用例。向量由本地确定性 embedding 夹具产生，不能据此评价语义检索质量。模式离线课仅验证模式选择分支，真实索引重建与切换由显式 RAG 小组验证。
