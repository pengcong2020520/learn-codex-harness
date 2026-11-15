# Agent 自带前端

Agent 包可以声明一个同源前端。节点提供静态文件，Caddy 提供通用登录页与前端模块，数据请求继续经过现有的认证、用户归属和权限检查。未声明 `agent.ui` 时，根路径仍跳到 `/ui/`，`/app/*` 返回 404。

## 声明与入口

在 `agent.json` 的 `agent` 内添加：

```json
"ui": { "entry": "ui/index.html", "title": "页面标题" }
```

`entry` 和 `title` 都是必填字符串；整个 `ui` 字段可省略。`entry` 相对于 `agent.json`，必须在包内 `ui/` 下；禁止绝对路径、`..`、隐藏或点路径段、空路径段、反斜杠、百分号编码、ASCII 空白和控制字符、冒号、`?`、`#`。入口必须存在。`title` 是包的展示元数据，页面的浏览器标题由 HTML 的 `<title>` 设置，服务端不改写 HTML。

`ui/` 必须与用户工作区分离。包目录及其父目录不能经过符号链接，文件不能是硬链接、设备或目录。只提供 html、js、mjs、css、svg、png、jpg、webp、woff2、json，每个文件最多 **2 MiB**。不提供目录列表，也不为子目录自动补 `index.html`。

| 请求 | 行为 |
| --- | --- |
| `GET /` | 已声明前端时 302 到 `/app/`，否则到 `/ui/` |
| `GET /app/` | 返回 `agent.ui.entry` 的正文 |
| `GET /app/app.js` | 返回包内 `ui/app.js` |
| `GET /app/nested/page.html` | 返回包内 `ui/nested/page.html` |
| `/ui/`、`/ui/modules/*` | 通用页面和可复用模块，由 Caddy 托管 |

根入口由节点判断，Caddy 的统一反向代理覆盖 `/` 和 `/app/*`；分片模式在用户鉴权前交给当前节点，无需查找用户所在节点。所有节点须部署同一份 Agent 包。直接访问节点只能验证 `/app/` 与 API；完整页面需要经 Caddy 取得 `/ui/modules/*`。

如果入口放在嵌套目录，`/app/` 的浏览器基准地址仍是 `/app/`。建议所有资源都使用 `/app/...` 绝对路径。`base-uri 'none'` 禁止用 `<base>` 修改基准地址。

`agent.ui` 沿用 `name`、`description` 等字段的描述符规则：参与 `definitionHash`，不提升 `CONTRACTS` 版本。不声明该字段的定义仍得到原有指纹。修改定义后须受控重启；已有会话按现有兼容检查处理。静态资源按请求读取，不提供构建、热更新或跨节点同步机制。

## 登录状态与 401

通用网页把登录响应中的凭据保存在当前标签页的 `sessionStorage`，键为 `agent.web.token`。自带前端通过同源导航复用该存储；不要将凭据放进 URL、日志、静态资源或模型输入。存储中存在凭据不代表登录有效，必须请求 `GET /auth/me`，响应是 `{ user }`。

```javascript
import { createApi } from '/ui/modules/api.mjs';

const tokenKey = 'agent.web.token';
function login() {
  sessionStorage.removeItem(tokenKey);
  const next = location.pathname + location.search + location.hash;
  location.replace(`/ui/?next=${encodeURIComponent(next)}`);
}
const api = createApi({
  getToken: () => sessionStorage.getItem(tokenKey),
  onUnauthorized: login,
});
```

无凭据时直接调用 `login()`；有凭据时调用 `api.request('/auth/me')` 核对用户。`createApi` 遇到 401 会调用 `onUnauthorized`，同时抛出带 `status` 的错误；界面仍须捕获错误。跳转前关闭现有事件订阅。

`/ui/?next=...` 只接受以 `/app/` 开头的同源路径。外站 URL、协议相对 URL、越界点段、反斜杠和重复编码等被忽略。登录成功并核实身份后回跳；已有有效登录的用户也会回跳。无有效 `next` 时进入通用工作台。

## 前端模块与接口

模块通过浏览器原生 ES module 导入，无需安装 SDK 或打包依赖。这些是本仓库的前端模块；升级脚手架时应随页面一起回归。

| 模块 | 导出与用途 |
| --- | --- |
| `/ui/modules/api.mjs` | `createApi`、`apiError`：带 Bearer 认证的 JSON 请求、上传、SSE 订阅与错误提示 |
| `/ui/modules/sse.mjs` | `sseState`、`parseSse`：增量解析 SSE 帧，通常直接用 `api.subscribe` 即可 |
| `/ui/modules/session-events.mjs` | `applySessionEvent`、`isSessionEvent`、`SESSION_EVENT_TYPES`、`SESSION_TURN_LIMIT`：处理协议 v2 会话快照、轮次与文字增量 |
| `/ui/modules/view-model.mjs` | `emptyState`、`reduceEvent`、`messagesView`、`hasLoss`、`lossMessage`、`pauseReason`、`statusLabel`：组合会话与队列状态，生成展示行 |
| `/ui/modules/uploads.mjs` | `uploadInfo`：核对上传扩展名、类型和大小；最终仍由服务端校验 |
| `/ui/modules/login.mjs` | `loginNext`：校验回跳路径，无效值返回 `null` |

`api.request(route)` 发 GET，`api.request(route, body)` 发 POST；第三个参数可传 `AbortSignal`。`api.upload(path, file, contentType)` 发 PUT。现有模块不提供通用 DELETE 方法。`artifacts.mjs` 依赖通用页面的固定 DOM，不作为独立页面的通用组件。

| 接口 | 输入及主要结果 |
| --- | --- |
| `GET /auth/me` | 当前登录用户 `{ user }` |
| `POST /auth/logout` | `{}`，注销当前登录；前端清理本地凭据 |
| `GET /sessions?q=...` | `{ sessions }`，当前用户可见会话 |
| `POST /sessions` | `{}`，返回新会话，含 `id` |
| `POST /sessions/resume` | `{ threadId }`，恢复会话并返回其状态 |
| `GET /state?threadId=...` | `{ session, queue }` |
| `POST /messages` | `{ threadId, clientMessageId, text }`，返回 202 接收结果；回复通过事件流获取 |
| `GET /events?threadId=...` | 认证 SSE，包含快照、会话、轮次、增量和队列事件 |
| `GET /workbench`、`GET /models` | 当前 Agent 能力、可用工作流和模型目录 |
| `POST /tasks/confirm`、`/tasks/cancel` | `{ threadId, taskId }`，继续或结束任务 |
| `POST /tasks/revise` | `{ threadId, taskId, text }`，提交修改意见 |
| `GET /workspace`、`GET /workspace/read?path=...` | 在已授权范围内列目录或读取文本 |
| `PUT /workspace/files?path=...` | 上传正文，扩展名与文件头必须匹配 |
| `POST /previews` | `{ path }`，取得签名预览 URL，用于沙箱 iframe |

`api.subscribe(threadId, onEvent, onStatus)` 返回 `{ close, resync, done }`。订阅以快照建立状态；连接中断后会重新订阅，以服务端快照恢复。把事件传给 `reduceEvent`，若返回 `null`，调用 `resync()` 请求完整状态。切换会话和离开页面时调用 `close()`，并用选择序号忽略旧订阅的迟到事件。

每次发送生成一个 `clientMessageId`。发送结果不明时保留输入、提示“待核对”，恢复会话核查，不能自动重发。SSE 的读连接恢复不代表消息发送重试。`messagesView` 返回的文本应以 `textContent` 显示，不能用 `innerHTML` 执行模型内容。

## CSP 与公开静态文件

`/app/*` 的 CSP 与 Caddy `/ui/*` 完全相同：

```text
default-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
```

脚本、CSS 和字体须使用同源外部文件；禁止内联脚本、事件属性、`<style>`、`style` 属性、`eval`、外部 CDN 和跨源 API 请求。图片允许同源或 data URL。页面不能被嵌入其他页面。响应包含正确 Content-Type、`nosniff`、`Referrer-Policy: no-referrer` 和 `Cache-Control: no-store`。

`ui/` 中允许类型的文件无需登录即可读取。只部署经过检查的受信页面，不放账号资料、私有 JSON、口令或模型未经审核生成的 HTML。数据必须从已鉴权接口获取。模型生成的预览应走 `/previews`，在 `sandbox` iframe 中打开且不加 `allow-same-origin`；不能把工作区作为 `/app/` 静态目录。

## 最小示例与检查

示例位于 [`examples/custom-ui/`](../examples/custom-ui/agent.json)，含 Agent 定义、必需的角色文件和三个前端文件。它检查登录、列出及恢复会话、发送消息并显示流式回复。以下命令在 `app/` 执行：

```sh
npm run agent:check -- examples/custom-ui/agent.json
```

部署时通过现有 `AGENT_DEFINITION` 选择 `examples/custom-ui/agent.json`，确保绑定的工作区存在，再受控重启所有节点并经 Caddy 访问 `/`。示例不自行写入部署配置。

离线覆盖位于 `tests/agent-ui.test.mjs`；`npm run test:ports` 覆盖真实 HTTP，`npm run test:web` 使用假 Codex 覆盖登录回跳与流式回复，并用 CSP 事件及 CDP `Log.entryAdded.source` 判断违规。`scripts/e2e-compose.sh` 在独立 Compose 项目中验证默认 Agent 的 `/app/` 为 404、根路径回到通用页面。测试命令存在不表示已在当前环境通过，请以执行报告为准。
