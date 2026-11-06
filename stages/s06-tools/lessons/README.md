# s06 · 可执行机制实验

在本阶段目录使用 Node.js 24+；已安装依赖后运行：

```sh
npm run lesson -- list
npm run lesson -- s06-tool-registry
```

每课先输出学习问题、真实校验命令、预期观察、原因和证据边界，再运行本目录的模块测试。预期观察不是成功宣告；以 Node 测试报告的 pass / fail / skip 为准。参数只接受列出的课时 ID，不接收任意 shell。

| 课时 | 要验证的问题 | 运行方式 |
| --- | --- | --- |
| s06-tool-registry | 新增工具为何不需要在主程序再加一个 if 分支？ | `npm run lesson -- s06-tool-registry` |
| s06-mcp | 工具正在运行时切换 MCP 注册表，会留下什么不一致？ | `npm run lesson -- s06-mcp` |
| s06-workspace | 把每次 runDir 当工作区，为什么会丢失上次产物？ | `npm run lesson -- s06-workspace` |

离线实验使用临时目录、假 RPC 或本地协议进程，调用真实服务模块并执行 assert；不读取本阶段的 .env、不连接外部模型。子测试只继承系统路径与临时目录环境，不继承提供商凭据。测试结束清理自己创建的临时文件。

## s06-tool-registry · 从配置装配可调用工具

注册表将 schema 与实现配对；版本快照使旧调用和新实现分开。

观察：echo_note 真正经 registry.call 返回输入；重复名、缺实现、坏 schema、越界模块被拒绝；两份代码快照分别返回 v1 / v2。

边界：离线临时工作区与真实产品模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 与生产数据不会被读取。

## s06-mcp · 工具通道也要有刷新边界

空闲边界将工具切换与新轮开始串行化；HTTP 入口继续执行认证。

观察：活动 Thread 存在时不发布新 registry；刷新失败回滚旧配置；真实回环 HTTP 入口拒绝无令牌和跨源请求。

边界：离线临时工作区与真实产品模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 与生产数据不会被读取。 MCP HTTP 服务是真实本地监听；Codex config RPC 是模拟。

## s06-workspace · 稳定工作区与受限文件入口

工作资料需要稳定位置；允许写 outputs 不代表所有路径都能读写。

观察：两次运行共用 workspaceDir，但 runDir 不同；来源过滤同时约束 list/read；产物不能覆盖；父路径、遍历和符号链接绕过被拒绝。

边界：离线临时工作区与真实产品模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 与生产数据不会被读取。

