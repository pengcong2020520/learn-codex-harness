# 升级到生产环境

教学主线仍用 SSH 隧道。需要域名对外提供 API 时，可在宿主部署 Caddy，使用 [Caddyfile.example](../deploy/Caddyfile.example)。本阶段不安装 Caddy，也不增加第五个 Compose 服务。

将 example.com 指向服务器，允许必要的 HTTPS 与证书签发流量。Caddy 自动申请和续期证书；生产前由运维核对 DNS、证书签发方式与防火墙。国内服务器使用域名向公众提供服务，需要按要求完成 ICP 备案。数据库、Redis、网关不发布端口；agent 仍只绑定宿主 127.0.0.1。

示例用 `basic_auth` 设置共享访问口令。通过 `caddy hash-password` 的交互输入生成哈希，避免明文口令出现在进程参数里；将 BASIC_AUTH_USER、BASIC_AUTH_HASH 放进仅管理员可读的 Caddy 环境文件。不要把口令、哈希、连接令牌提交进仓库或记录到访问日志。

HTTP 的 Authorization 只能携带一种认证。示例由 Caddy 验证 Basic，再用 AGENT_CONNECTION_TOKEN 注入后端 Bearer。此令牌来自当前 `.data/connection.json`，不是网关密钥。agent 重启会换令牌：管理员需从文件读取、更新 Caddy 私有环境文件并重启 Caddy，再验收访问；普通 reload 不保证取得新的进程环境。教学 CLI 使用 Bearer，继续走 SSH 隧道；Basic 客户端通过此代理访问。这里没有实现账号体系。

代理保留 Host 头，并为 SSE 禁止响应缓冲。白名单只开放确切的 GET/POST 路径，其他路径返回 404；不转发网关管理面、工具调试入口、备份或任意文件路径。需要更多接口时逐项评审后添加。

应用按连接令牌与实际 socket 来源计数，不信任客户端提供的 X-Forwarded-For。在单一反向代理后，同一令牌的流量共享一个桶。可在代理或前置负载均衡层再增加连接数限制，尤其是长连接；不要假设 Caddy 标准发行版内置了所有限流模块。本示例未引入插件。

验收：未带 Basic 凭据返回 401；正确凭据请求 /ready 返回 200；/backups 与未允许路径返回 404；SSE 连续收到事件；修改 Host 后后端仍收到原始 Host；agent 重启并刷新代理令牌后业务请求恢复。备份仍只通过 SSH + rsync 下载。
