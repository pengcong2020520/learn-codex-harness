# s11 · 可执行机制实验

在本阶段目录使用 Node.js 24+；安装依赖后运行：

```sh
npm ci
npm run lesson -- list
npm run lesson -- s11-registry
```

沿用 s10 的运行器。每课先打印学习问题、精确的测试命令、预期观察和证据边界，再执行本阶段的真实测试；只有测试报告中的 pass 才代表验证通过，skip 不计为通过。测试名使用完整名称的锚定匹配，参数仅接受课时 ID 和对应的集成门禁。

| 课时 | 测试文件 | 主要断言 |
| --- | --- | --- |
| s11-registry | gateway、native-search、usage、media | 用途、能力、价格校验，服务商密钥隔离 |
| s11-routing | model-router、workflows、gateway、routing-policy | needs/搜索筛选、任务模型与来源、模型目录与 CLI、预算降级、媒体 quality、步骤 effort、备用链提醒和 RAG |
| s11-native-search | native-search | 默认模型开关、禁止按轮覆盖、内存假网关自检 |
| s11-budget | usage | 去重、时区、预算停派与恢复、token 兜底配置 |
| s11-media | media（复用 media-fixture） | 任务 ID、后台保存、重启恢复、收费前校验 |
| s11-gateway | gateway.integration、media-gateway.integration | 真 Bifrost 鉴权、备用切换、协议转换、token 限流；byteplus 生图/视频保存与记账 |

表中离线测试文件均位于 `tests/`，后缀为 `.test.mjs`。运行方式为 `npm run lesson -- <课时 ID>`。前五课不监听端口，不读取项目 `.env`，不调用真实模型；临时目录、假 RPC、内存 fetch 和任务仓储夹具只替代外部设施，断言仍调用真实模块。

集成课默认只说明前置条件并报告 `NOT RUN`。准备好 Docker、锁定的 Bifrost 镜像和本机临时端口权限后运行：

```sh
npm run lesson -- s11-gateway --integration
```

集成课也不读取项目 `.env`；使用临时生成的测试密钥与假模型服务。新增媒体测试使用正式模型清单，验证 MediaService 经真实网关的内置 byteplus 通道送达火山方舟格式的服务，图片和视频都保存进工作区并按张/秒记账；视频提交先返回任务 ID，轮次结束后由后台轮询完成。媒体上游是本机模拟的火山方舟，返回固定 PNG/MP4，不验证真实生成质量、模型开通或实际计费。没有 Docker 导致的全跳过不能算成功，运行器会返回失败。

`npm test` 仍包含原有本机 HTTP/SSE 测试。禁止监听端口的沙箱不能运行 `tests/http-cli.test.mjs`、`tests/media-http.test.mjs`、`tests/gateway-check.test.mjs` 中的 HTTP 用例，以及 `tests/streaming.test.mjs` 中的 SSE 与 CLI 订阅用例；这些用例需在允许监听本机端口的环境复跑。五节离线课不受此限制。

## 本次沙箱验证（2026-11-03）

- `npm run lesson -- list` 列出六课；`node stages/verify.mjs --docs-only` 当前被本章 README 的旧路由代码摘录阻挡。README 与 docs/design.md 按任务约束保留，待同步 README 摘录后复验。
- 五节离线课分别通过 7、21、5、11、7 项断言，共执行 51 项（课间存在复用）。
- 使用工作目录已有依赖验证，未安装新依赖，未改锁文件。
- 全量测试 251 项中 226 项通过，25 项端口用例遇到 `listen EPERM`。离线复跑排除媒体 HTTP 文件，并按完整名称跳过其余端口用例，保留同名的内存媒体测试。
- 真 Bifrost 集成课未运行；需要 Docker 和本机端口。未执行其他需要 PostgreSQL、Redis、Chroma 或真实 Codex 的集成脚本；新增任务模型及选择来源的真实 PostgreSQL 持久化测试已写入 `tests/data.integration.mjs`，待在允许的环境运行 `npm run test:data`。

以下 25 项需在允许本机端口的环境运行 `npm test` 复验，未因沙箱限制从快照删除：

| 文件 | 未验证用例 |
| --- | --- |
| `tests/gateway-check.test.mjs` | 全部模型自检；`--model` / `--search`；口头声称搜索；HTTP/JSON/超时错误；CLI 退出码（5 项） |
| `tests/http-cli.test.mjs` | 文件中的全部 8 项 HTTP/CLI 用例 |
| `tests/media-http.test.mjs` | 生图；视频立即返回及后台保存；失败/超时及重启；预算与门禁（4 项） |
| `tests/streaming.test.mjs` | 三项 `SSE：` 用例及 `CLI 订阅：` 用例（4 项） |
| `tests/tool-loading.test.mjs` | 全部 Thread 空闲后更新；目录自动检查；RPC 刷新失败回滚；MCP 入口鉴权（4 项） |

在本阶段目录复验：

```sh
npm ci
npm test
npm run lesson -- s11-gateway --integration
```
