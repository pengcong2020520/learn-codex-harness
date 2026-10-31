# s01 · 可执行机制实验

在本阶段目录使用 Node.js 24+；已安装依赖后运行：

```sh
npm run lesson -- list
npm run lesson -- s01-transport
```

每课先输出学习问题、真实校验命令、预期观察、原因和证据边界，再运行本目录的模块测试。预期观察不是成功宣告；以 Node 测试报告的 pass / fail / skip 为准。参数只接受列出的课时 ID 和该课显式门禁，不接收任意 shell。

| 课时 | 要验证的问题 | 运行方式 |
| --- | --- | --- |
| s01-transport | 为何 stdout 中的一个 JSON 消息不一定是这次调用的答案？ | `npm run lesson -- s01-transport` |
| s01-lifecycle | 有文字输出却没有 turn/completed，可以显示成功吗？ | `npm run lesson -- s01-lifecycle` |

离线实验使用临时目录、假 RPC 或本地协议进程，调用真实产品模块并执行 assert；不读取本阶段的 .env、不连接外部模型、不访问生产资料。子测试只继承系统路径与临时目录环境，不继承提供商凭据。测试结束清理自己创建的临时文件。

## s01-transport · 用消息 ID 连接请求与事件

请求回包与 turn 通知可以乱序；真实入口必须按协议关联它们。

观察：success 与 early 两种顺序均执行断言；仅一次 thread/start 和一次 turn/start；输入和最终答案正确。

边界：离线协议夹具：执行本阶段的真实入口，使用本地假 App Server；不调用模型，不证明模型回答质量。临时文件结束后删除。

## s01-lifecycle · 结束状态决定成功与失败

文字增量不是完成凭据；只有明确终态才允许交付成功。

观察：failed 被拒绝并保留错误；hang 触发测试设置的 150ms 超时。

边界：离线协议夹具：执行本阶段的真实入口，使用本地假 App Server；不调用模型，不证明模型回答质量。临时文件结束后删除。
