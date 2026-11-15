# 工作室设计校验

`design-check` 为工作室生成的单文件 HTML 提供 Chromium 布局检查。低保真、主题样页和高保真原型都应先检查，再展示；错误未修复、服务不可用或检查超时时，不能声称已通过校验。检查复用 `scripts/layout-check.mjs`，包括文字重叠、截断、视口溢出、整页滚动、字号、页面状态、大纲及外部请求。

## 服务与运行边界

Compose 的 `studio` profile 才启动此服务，容器内地址为 `http://design-check:8091`，没有宿主端口。服务内存上限为 512 MiB，只执行一个检查，其他请求排队。每次请求从进入检查队列起最多 60 秒，包含排队时间；超时返回“检查超时”，不自动重试。超时或调用断开后终止工作进程及 Chromium 进程组，清理完成后才执行下一项。

镜像沿用应用的固定 Node slim 基础镜像，经 `APT_MIRROR` 安装 Chromium 和中文字体，不安装 npm 依赖。容器以非 root 用户运行，`cap_drop: [ALL]`，根文件系统只读，只在 `/tmp` 写临时页面和浏览器配置，不挂载用户工作区。Chromium 的 `--no-sandbox` 由这些容器限制及专用内部网络提供边界；DNS、代理限制和 CDP 离线拦截共同阻止页面访问网络。此边界需通过 Docker 验收确认。

服务只连接 `internal: true` 的专用网络，节点同时连接此网络和应用网络。`GET /health` 返回健康状态；`POST /check` 要求现有节点认证头 `x-node-id`、`x-node-key`，复用节点密钥哈希校验。服务只接收 `AGENT_NODE_KEY_A_HASH` 等哈希，不接收节点明文密钥。请求结构为 `{ "html": "…", "viewports": [{ "width": 1440, "height": 900 }] }`；HTML 按 UTF-8 字节计最多 2 MiB，视口可省略。响应为布局检查器的完整 JSON 报告。

节点使用 `DESIGN_CHECK_URL` 指定服务地址；Compose 固定使用内部地址。本机单独启动服务时默认监听 `127.0.0.1`；`DESIGN_CHECK_LISTEN_HOST=0.0.0.0` 仅用于容器。默认视口和 App 页面视口沿用布局检查器。单文件原型应内嵌资源；服务不会复制相邻文件。

服务仅在工作室设计阶段需要。落地后的 Agent 不依赖它；随工作室移除的自动处理由 K4 落地流程负责，本功能不执行移除或部署。

## 运行时工具

在 Agent 的 `tools.allow` 中分别声明 `check_design`、`check_agent_package` 才会暴露工具。声明工具不授予文件读取权：对应目录还必须有 `read` 资料绑定，报告写入须在 Agent 和当前工作流的允许写入范围内。工具使用当前可信用户工作区，拒绝越界、链接和跨用户文件；容器内通过属主辅助进程读取私有产物。

| 工具 | 参数与结果 |
|---|---|
| `check_design` | `{ "path": "outputs/design/demo/prototype-v1.html" }`。只接受 `inputs/` 或 `outputs/` 下的 HTML。返回错误数、警告数和最多 30 条带屏幕、状态、视口、元素、原因、修改建议的问题。完整报告写入 `outputs/design/<项目>/qa/<文件名>-<时间>-<唯一标识>.json`，不覆盖。 |
| `check_agent_package` | `{ "path": "outputs/design/demo/package-v1/" }`。返回 `ok`、`errors` 和含中文修改建议的 `issues`。只做静态检查，不执行包内代码。 |

`check_design` 对 `inputs/design/<项目>/` 和 `outputs/design/<项目>/` 使用路径中的项目名；其他位置使用 HTML 文件名作为报告项目目录。服务连接失败、认证失败或报告格式错误均明确返回“布局校验服务不可用”。动态工具与 MCP 的布局调用期限为 60 秒；其他工具的执行期限保持原值。

代码包校验包含：

- 以包根为 `root` 调用 `agent-check` 检查 `agent/agent.json`，只把错误级规则计入失败。包内需提供有效的 `config/models.json`；缺少模型目录不会借用宿主配置而误报成功。
- `manifest.json` 的 `files` 使用 `{path, sha256}` 数组，覆盖除 manifest 自身外的全部普通文件；路径唯一且位于包内，SHA-256 为最终字节的 64 位小写十六进制。
- 前端只认 `agent/ui/`：`ui.entry` 相对于 `agent/agent.json`，包根 `ui/` 下的文件不会被 `/app/` 提供，报错 `ui-location`。有 `agent/ui/` 文件但未声明 `agent.ui` 时，报错 `ui-undeclared`；应在 `agent.json` 声明 `agent.ui: { entry: "ui/index.html", title: "页面标题" }`。已声明但入口文件缺失由 `agent-check` 报告。
- `agent/ui/` 的静态文件白名单为 html、js、mjs、css、svg、png、jpg、webp、woff2、json，前端单文件最多 2 MiB。其他文件沿用用户文件辅助进程的 16 MiB 读取上限。
- HTML/SVG 用 htmlparser2 解析，拒绝内联 script、style、事件属性、srcdoc 和外部资源地址。CSS、JS 检查静态外链；CSS 资源地址使用未转义的包内相对路径。允许同源 `/ui/modules/` SDK 引用。静态检查不证明运行时拼接的网络请求安全，实际前端仍须通过 K2 的 CSP 与真实浏览器验收。
- 包内拒绝宿主机脚本扩展名及常见脚本 shebang；拒绝符号链接、硬链接、特殊文件和不安全路径。静态 Agent 检查不得引用包外 Skill 或资料目录。

`agent.ui` 的结构和入口文件由 `agent-check` 按 K2 schema 校验。报告通过也不代表 K4 已接受该包、用户已确认、业务流程已验收或已经部署。

## 验证命令

离线用例随 `npm --prefix app test` 执行。真实 HTTP 用例随 `npm --prefix app run test:ports` 执行。浏览器及 Docker 验收必须在允许监听端口的环境运行。

在干净的独立检出目录运行 `bash app/scripts/e2e-compose.sh`，会启用 studio profile 并检查故意重叠和整页滚动的页面、零错误页面、节点认证、真实 uid 私有文件和报告属主，再独立运行 Chromium 验证域名、直接 IP 与内部节点请求失败。该脚本只用于独立验收项目，会创建临时部署配置并清理验收数据卷；不能对真实部署执行。

已启动的独立验收项目可单独执行：

```sh
cd app
docker compose exec -T node-a node scripts/design-check-e2e.mjs
docker compose exec -T node-a node --test tests/design-check-uid.integration.mjs
docker compose exec -T design-check node server/design-check/network-check.mjs
docker compose exec -T design-check node server/design-check/lifecycle-check.mjs
```

未运行上述真实环境检查时，只能记录“需外部验证”，不能把离线替身结果当作 Chromium、网络隔离或 Linux 权限验证通过。
