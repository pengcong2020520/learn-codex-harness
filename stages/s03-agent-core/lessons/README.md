# s03 · 可执行机制实验

在本阶段目录使用 Node.js 24+；已安装依赖后运行：

```sh
npm run lesson -- list
npm run lesson -- s03-agent-config
```

每课先输出学习问题、真实校验命令、预期观察、原因和证据边界，再运行本目录的模块测试。预期观察不是成功宣告；以 Node 测试报告的 pass / fail / skip 为准。参数只接受列出的课时 ID 和该课显式门禁，不接收任意 shell。

| 课时 | 要验证的问题 | 运行方式 |
| --- | --- | --- |
| s03-agent-config | 角色说“可以执行 shell”，是否就获得了 shell 权限？ | `npm run lesson -- s03-agent-config` |
| s03-skills | 工作区出现一个新 Skill，能否自动让当前 Agent 使用？ | `npm run lesson -- s03-skills` |
| s03-tool-registry | 新增工具为何不需要在主程序再加一个 if 分支？ | `npm run lesson -- s03-tool-registry` |
| s03-mcp | 工具正在运行时切换 MCP 注册表，会留下什么不一致？ | `npm run lesson -- s03-mcp` |
| s03-workspace | 把每次 runDir 当工作区，为什么会丢失上次产物？ | `npm run lesson -- s03-workspace` |

离线实验使用临时目录、假 RPC 或本地协议进程，调用真实产品模块并执行 assert；不读取本阶段的 .env、不连接外部模型、不访问生产资料。子测试只继承系统路径与临时目录环境，不继承提供商凭据。测试结束清理自己创建的临时文件。

## s03-agent-config · 把 Agent 定义变成有效约束

装配定义同时决定工具、来源和版本；自然语言不能扩大代码授权。

观察：未知字段、缺失引用、权限提升被 schema 拒绝；Agent 改动立即撤销旧工具权限；恢复旧文件也不能免重启；不兼容 Thread 版本被拒绝。

边界：离线临时工作区与真实产品模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 与生产数据不会被读取。

## s03-skills · 发现 Skill 不等于授权 Skill

发现接口与产品允许清单分别负责“存在”和“可使用”。

观察：范围外发现结果被禁用；授权 Skill 生成显式 skill 输入；未授权名称被拒绝；必需缺失会报错，可选缺失明确降级。

边界：离线临时工作区与真实产品模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 与生产数据不会被读取。 skills/list 与 skills/config/write 是接口模拟，不验证原生 Skill 解析器。

## s03-tool-registry · 从配置装配可调用工具

注册表将 schema 与实现配对；版本快照使旧调用和新实现分开。

观察：echo_note 真正经 registry.call 返回输入；重复名、缺实现、坏 schema、越界模块被拒绝；两份代码快照分别返回 v1 / v2。

边界：离线临时工作区与真实产品模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 与生产数据不会被读取。

## s03-mcp · 工具通道也要有刷新边界

空闲边界将工具切换与新轮开始串行化；HTTP 入口继续执行认证。

观察：活动 Thread 存在时不发布新 registry；刷新失败回滚旧配置；真实回环 HTTP 入口拒绝无令牌和跨源请求。

边界：离线临时工作区与真实产品模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 与生产数据不会被读取。 MCP HTTP 服务是真实本地监听；Codex config RPC 是模拟。

## s03-workspace · 稳定工作区与受限文件入口

工作资料需要稳定位置；允许写 outputs 不代表所有路径都能读写。

观察：两次运行共用 workspaceDir，但 runDir 不同；来源过滤同时约束 list/read；产物不能覆盖；父路径、遍历和符号链接绕过被拒绝。

边界：离线临时工作区与真实产品模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 与生产数据不会被读取。
