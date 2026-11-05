# s10 · 可执行机制实验

在本阶段目录使用 Node.js 24+；已安装依赖后运行：

```sh
npm run lesson -- list
npm run lesson -- s10-propose
```

每课先输出学习问题、真实校验命令、预期观察、原因和证据边界，再运行本目录的模块测试。预期观察不是成功宣告；以 Node 测试报告的 pass / fail / skip 为准。参数只接受列出的课时 ID 和该课显式门禁，不接收任意 shell。

| 课时 | 要验证的问题 | 运行方式 |
| --- | --- | --- |
| s10-package | 把 Skill 或角色放进工作区，会发生什么？ | `npm run lesson -- s10-package` |
| s10-declare | Agent 包能不能给自己声明一个越权的 workflow？ | `npm run lesson -- s10-declare` |
| s10-dispatch | workflow 怎样带上授权和 Skill，又不改写用户原文？ | `npm run lesson -- s10-dispatch` |
| s10-steps | 多步 workflow 停在确认点时，普通对话还能继续吗？确认之后发生什么？ | `npm run lesson -- s10-steps` |
| s10-propose | 模型能不能自己批准一个需要更多权限的任务？ | `npm run lesson -- s10-propose` |
| s10-skill-read | 模型能不能借 skill_read 读到 Skill 之外的文件？ | `npm run lesson -- s10-skill-read` |
| s10-codex | 在真实 Codex 里，包内 Skill、任务说明、两步确认和隐式读取都生效吗？ | `npm run lesson -- s10-codex --integration` |
| s10-e2e | 普通对话里模型直接更新知识库会怎样？提议经用户确认后呢？ | `npm run lesson -- s10-e2e --integration` |

离线实验使用临时目录、假 RPC 或夹具，调用真实产品模块并执行 assert；不读取本阶段的 .env、不连接外部模型、不访问生产资料。集成实验默认不运行，需要显式加 `--integration`。
