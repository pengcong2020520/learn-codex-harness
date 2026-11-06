# s05 · 可执行机制实验

在本阶段目录使用 Node.js 24+；已安装依赖后运行：

```sh
npm run lesson -- list
npm run lesson -- s05-agent-config
```

每课先输出学习问题、真实校验命令、预期观察、原因和证据边界，再运行本目录的模块测试。预期观察不是成功宣告；以 Node 测试报告的 pass / fail / skip 为准。参数只接受列出的课时 ID，不接收任意 shell。

| 课时 | 要验证的问题 | 运行方式 |
| --- | --- | --- |
| s05-agent-config | 角色说“可以执行 shell”，是否就获得了 shell 权限？ | `npm run lesson -- s05-agent-config` |
| s05-skills | 工作区出现一个新 Skill，能否自动让当前 Agent 使用？ | `npm run lesson -- s05-skills` |

离线实验使用临时目录、假 RPC 或本地协议进程，调用真实服务模块并执行 assert；不读取本阶段的 .env、不连接外部模型。子测试只继承系统路径与临时目录环境，不继承提供商凭据。测试结束清理自己创建的临时文件。

## s05-agent-config · 把 Agent 定义变成有效约束

一份定义同时决定角色、Skill、执行策略和版本；自然语言写的角色不能扩大代码授权。

观察：未知字段、缺失引用、原生权限提升被 schema 拒绝；定义或角色文件一改，旧版本立即作废；恢复旧文件也不能免重启；没有版本绑定或版本不兼容的会话被拒绝。

边界：离线临时目录与真实 Agent 装配模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 不会被读取。

## s05-skills · 发现 Skill 不等于授权 Skill

发现接口与产品允许清单分别负责“存在”和“可使用”。

观察：范围外发现结果被禁用；授权 Skill 生成显式 skill 输入；未授权名称被拒绝；必需缺失会报错，可选缺失明确降级。

边界：离线临时目录与真实 Agent 装配模块；RPC 为 fixture，不启动真实 Codex 或外部模型。配置只使用测试输入，真实项目 .env 不会被读取。 skills/list 与 skills/config/write 是接口模拟，不验证原生 Skill 解析器。
