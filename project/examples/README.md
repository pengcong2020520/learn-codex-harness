# 两个场景，同一个内核

- `writing/agent.json`：写作示例，保留 inputs/research/drafts/outputs 习惯。
- `customer-support/agent.json`：客服示例，使用 handbook/policies、work/replies 与 knowledge/wiki。

配置和角色均可直接复制修改，工作区相对各自 agent.json 定位。提供的资料是合成示例。空目录可能在分发时丢失，先执行：

```bash
AGENT_DEFINITION=examples/customer-support/agent.json npm run agent:init
AGENT_DEFINITION=examples/customer-support/agent.json npm run check
```

准备 PostgreSQL、Redis 和模型配置后，用同一 AGENT_DEFINITION 启动 `npm run server`。默认示例由 config/runtime/project.json 选择；更换场景无需改内核。两个示例均使用 Wiki，且关闭原生记忆，避免越过知识范围。

场景选择、版本迁移、工具上下文和真实冒烟见 [脚手架升级说明](../docs/harness-upgrade.md)。
