# 研究实验员协议回归

来源：用户提供的 `~/Downloads/codex-harness-协议回归.tar.gz`。`upstream/` 原样保留三份探针、MCP 夹具、启动脚本与研究报告；`manifest.json` 记录压缩包和脚本 SHA256。这里不把 Linux 上的历史结果冒充本机验收结果。

```bash
npm run test:protocol:research
# 在隔离环境观察候选版本，不会将它自动加入生产兼容白名单：
npm run test:protocol:research -- --cli /absolute/path/to/codex.js
```

脚本需要 Node.js 24+，当前覆盖 macOS / Linux。通常约一分钟，S3a 会真实等待 30 秒。使用本机模拟 Responses、合成 API key、临时 HOME/CODEX_HOME/工作区，无需真实模型密钥、PostgreSQL 或 Redis。

本地适配包括：改为当前项目模块路径；适配 Agent 配置选择器；隔离报告目录；删除研究机固定 PATH；限制各阶段最长两分钟；结束时清理本阶段的进程组和临时目录；在原始观测之上增加 12 组断言。新增 S3c 验证无视 signal 的 handler 仍会超时返回，迟到拒绝不污染连接。`upstream/run-all.sh` 仅作原件存档，日常使用上面的 npm 命令。

| 探针 | 验证内容 | 解释边界 |
|---|---|---|
| S1/S5 | 模型实际工具清单 | 当前受限配置不得出现 shell、patch、view_image 等旁路 |
| S2 | 连续 20 轮时序、门禁、重复 callId | 记录原生通知顺序；不能依赖它替代产品端身份校验 |
| S3a/b/c | 超时、中断、迟到结果、同连接续用 | 有界 RPC 回包不等于强制终止插件副作用 |
| S4 | 恢复旧 Thread 时 dynamicTools 不更新 | 0.154.0 的已知限制；改变工具契约应阻止旧 Thread 续用 |
| S6 | 多连接广播、先回者结果、跨连接读取 | **复现风险即探针通过**，不表示共享进程具有用户隔离 |
| S7 | 四个进程的启动与 RSS | 硬件相关观察，不设通用性能门槛 |
| S8 | MCP 配置修改后 reload，删除工具调用 | 证明工具发现行为，不证明 MCP 拥有可信 user/thread/turn 身份 |
| 扩展 | hooks/plugins 关闭、三个目录的 Skill 发现与禁用 | 当前默认已关闭 hooks/plugins；与原研究机旧启动参数不同 |

本机结果在 `docs/verification/research-protocol/`，`summary.json` 只在所有阶段和断言通过后标记成功。失败返回非零并保留诊断目录。当前单 stdio 连接与 dynamicTools 门禁路径保持不变，没有为了热插拔开放原生 WebSocket/MCP 给产品用户。

本轮修复：生产工具 RPC 与超时/取消信号竞速，结束轮次后不再发送迟到回包；显式关闭 `features.hooks`、`features.plugins`，并纳入启动后的有效开关校验。实际 HOME 尚未改为每用户目录，现有 `verifySkills` 仍负责发现并关闭未授权 Skill；多用户进程与 HOME 隔离留在后续架构范围。
