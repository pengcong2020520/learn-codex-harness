# Hub 离线实验

运行 `npm run lesson -- list` 查看问题、命令与预期。

| 实验 | 入口 | 观察 |
| --- | --- | --- |
| 三方交集 | `npm run lesson -- intersection` | 白名单、权益、scope 任一收窄都会减少工具 |
| 可见与动作 | `npm run lesson -- scope` | private 404，shared 非所有者 modify/share/delete 403 |
| Skill 审批 | `npm run lesson -- skill-approval` | pending 无授权，approve 同步，reject 不同步，撤销即移除 |
| 配额与并发 | `npm run lesson -- quota` | 超额 queued 保留，次日恢复，basic 1/pro 2 |
| 轮次边界 | `npm run lesson -- revocation` | 运行中快照保留，下一轮读最新权限，空闲重启 |

这些实验运行真实 Node 断言，不需要端口、PostgreSQL、docker 或 uid 切换。测试夹具不代替生产数据库。数据库约束、uid 隔离与完整服务步骤见 [外部验收](../docs/hub-acceptance.md)。
