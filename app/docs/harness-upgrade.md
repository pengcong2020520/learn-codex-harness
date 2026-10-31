# 脚手架升级与验收

当前服务是单机单用户的通用 Agent 脚手架，写作只是默认配置。账号登录、多用户数据库作用域和运行环境隔离尚未实现；本次提供可扩展的身份接口，不能据此宣称已经支持多用户。

## 1. 从配置装配 Agent

```text
config/runtime/project.json 或 AGENT_DEFINITION
  → AgentDefinition（角色、工具、Skills、资料范围、知识挂载、执行策略）
  → Workspace + PermissionGate + Resources / Knowledge
  → Tool Registry（Schema + 校验器 + 执行函数）
  → Codex App Server（原生 Thread / Turn / Skills / 上下文）
  → HTTP / SSE → Web、CLI 等客户端
```

默认定义由 `config/runtime/project.json` 的 `agentDefinition` 指定，环境变量 `AGENT_DEFINITION` 优先。工作区相对 Agent JSON 所在目录解析；资源路径相对工作区解析。必需资料目录不存在会报错，可以先运行 `npm run agent:init` 创建配置声明的空目录，不覆盖已有文件。

两份可复制示例位于 `examples/writing` 和 `examples/customer-support`。客服示例使用 `handbook/policies`、`work/replies`、`knowledge/wiki`，没有 inputs/research/drafts/outputs 依赖。新增同类场景只需修改定义和角色；新增工具实现仍需编写执行函数。

```bash
AGENT_DEFINITION=examples/customer-support/agent.json npm run agent:init
AGENT_DEFINITION=examples/customer-support/agent.json npm run check
# DATABASE_URL / REDIS_URL 已配置并完成 data:migrate 后：
AGENT_DEFINITION=examples/customer-support/agent.json npm run server
```

同一个服务根目录一次运行一个 Agent，切换示例前停止原服务。切换到不同 Agent 不会继承原 Agent 的会话权限；原会话仍保留。

`bindings.sources.<id>.readOnly=true` 是显式只读策略；目录名字不决定权限。文件工具仍限定 Markdown/TXT、create-only、相对路径、禁止链接与目录穿越。Wiki 路径不能用普通文件工具绕过知识门禁，KB 原文不能由 Agent 的 write_file 改写。知识库原文/Wiki 根不能彼此重叠，服务启动还检查已登记但未挂载的知识库。

静态检查拒绝未知配置字段、缺失引用、只读/输出重叠、重复或缺失 KB 挂载、缺失工具执行函数等。动态原生 Skill 发现、数据库状态和模型调用属于后续验收，`check` 成功不等于真实模型可用。

## 2. 会话兼容与 Codex 升级

现在区分两个版本：

| 版本 | 用途 | 何时变化 |
|---|---|---|
| 工具实现 hash | 热更新缓存、运行快照、诊断 | 工具代码或配置文本变化 |
| Agent 兼容描述符 v2 | 决定原会话/排队任务能否继续 | 角色、工具 Schema/权限、资源范围、Skill 正文、工作区、知识绑定/生效模式、记忆和执行策略变化 |

内核代码注释、工具实现注释、Schema 展示注释、JSON 排版、Agent 展示版本标签不再改变兼容描述符。实现行为发生不兼容变化时，开发者必须提升工具组 JSON 的正整数 `contractVersion`；核心资源/权限/协议语义变化应提升 `server/modules/agents/contracts.mjs` 对应契约。系统不能从代码自动证明两段实现语义等价。

权限缩小也不自动复用旧上下文：旧上下文可能包含现在不应可见的资料。因此真正策略不兼容时拒绝续聊，保留原历史。运行中的角色/配置修改仍会触发撤销，受控重启后再判断兼容性。

本版只验收 **Codex 0.154.0**，npm 包与实际二进制版本必须一致。未知版本拒绝启动，不尝试修改原会话。版本白名单独立于会话契约；以后通过协议验收且语义兼容的版本可加入白名单，无需仅因版本号变化作废会话。

0.154.0 禁用看图应使用 `features.view_image=false`。旧 `tools.view_image=false` 不再作为限制依据。启动后通过 `experimentalFeature/list` 读取实际开关；shell、view_image、image_generation、multi_agent、apps、hooks、plugins 任一缺失、已移除或仍启用都阻止就绪。协议测试还检查模型真正收到的工具清单，不能只证明配置字符串写入了文件。0.154.0 的已记录原生辅助工具为 request_user_input、get_goal、create_goal、update_goal；业务工具在此基础上按白名单装配。

升级流程：停止服务并备份 PostgreSQL、`.data`、配置和工作区 → 更新并锁定 Codex → 在候选版本分支调整兼容名单并运行 `test:protocol`、工具/记忆集成、数据层与真实冒烟 → 审查协议及工具清单变化 → 确认是否需提升契约 → 部署。候选白名单修改必须随验收结果一起审查，不能仅改版本号便发布。

### 旧全文指纹的一次性迁移

旧描述符 v1 曾把实现源码 hash 当成会话权限版本，无法只凭“工具名称一样”证明兼容。停服后先运行 `npm run check:server` 生成并输出当前 NEW_HASH：此模式校验原生能力并登记描述符，不启动 HTTP、不消费消息/索引队列、不恢复或改写任务状态，避免旧任务在迁移前被调度。然后使用可审查的迁移命令，默认只预检：

```bash
npm run sessions:upgrade -- --from OLD_HASH --to NEW_HASH \
  --legacy-definition /backup/old-agent.json \
  --legacy-tools /backup/old-tools-snapshot
# 预检通过且停止服务后，使用同样参数再加 --apply
```

旧配置备份必须逐字匹配旧 definitionHash；工具快照根须含 `config/tools` 和 `server/modules/tools`，并匹配旧 toolVersion。可在旧 `.runs/app-server-*/tools-*` 中寻找完整快照，注意运行目录会被清理，应提前备份。迁移只读取历史代码，不执行它。

命令比较配置、角色、Skill、路径、知识模式、Schema、读写规则；仅登记精确的 OLD_HASH → NEW_HASH 映射。映射保存在部署者控制的 `.data/session-compatibility.json`，属于本机兼容策略，需一并备份。不批量放行未知版本，不改 PostgreSQL 会话、任务或 Codex SQLite/JSONL。缺少历史证据时拒绝迁移，原历史保留；新建会话仍可使用当前 Agent。本次未擅自迁移已有业务会话。

## 3. 工具身份接口

工具工厂不变，执行函数增加受信上下文：

```js
export function createTools() {
  return {
    async lookup(args, { signal, context }) {
      // context 冻结，只能由服务端创建；args 是不可信的模型参数。
      const { userId, threadId, turnId, taskId, agentId } = context;
      // 用 userId + 资源归属查权限，用 threadId/turnId 关联审计。
      signal?.throwIfAborted();
      return { /* 业务结果 */ };
    }
  };
}
```

| 字段 | 权威来源 | 含义 |
|---|---|---|
| userId | 当前本机认证身份对应的服务端 ownerId | 用户主体；将来替换为登录认证结果 |
| threadId | 服务端归属校验过的任务 + Codex Thread | 原生会话 ID |
| turnId | Codex turn/started 与工具回调的匹配结果 | 原生轮次 ID，不是第几轮数字 |
| taskId | 持久任务记录 | 业务执行任务；与 turnId 区分 |
| agentId | 加载的 Agent 定义 | 正在执行的能力配置 |

HTTP 先认证，再进入 user 范围，默认请求不再进入 operator。客户端不能提交 userId 冒充身份；消息接口拒绝额外字段，模型参数即便包含同名字段也不会替代 context。普通问答不能维护 Wiki；维护任务还需显式 knowledge 范围和已配置 update 权限。轮次结束会撤销上下文，并发 Thread 使用 AsyncLocalStorage 分隔。

生产路径使用带身份的 Codex dynamicTools；不再额外开放无任务身份的 MCP 旁路。历史无门禁测试/MCP 适配路径的 context 为 null，不能直接作为多用户 Tool Hub。插件是部署者信任的本机代码，仍需主动使用受限资源接口；context 不是恶意插件的沙箱。

## 4. 冒烟测试模板

按层验收，不把模拟模型结果当成生成能力证据：

1. `npm run agent:init`、`npm run check`：配置和目录可装配。
2. `npm run test:protocol`：真实 Codex + 本地模拟 Responses；Schema、开关、工具清单、失败回包、身份与恢复契约。
3. `npm run test:data`：隔离的真实 PostgreSQL/Redis，存储和门禁闭环；`test:rag` 额外启动真实 Chroma。
4. `npm run smoke:real`：读取当前模型配置，调用真实模型；在临时数据库、临时工作区分别验收写作与客服定义。

`smoke:real` 要求 PATH 中有 initdb、pg_ctl、redis-server，模型端点支持 Responses API。它会产生模型调用费用；只使用复制的示例和生成的验收资料，不导入当前业务数据库。失败返回非零，保留临时目录，成功清理；报告写入 `docs/verification/real-model-smoke.json`，不写 API Key。

为自定义场景复用 `scripts/real-smoke.mjs` 的用例结构：读取一份含随机验证码的资料 → 实际创建产物并核对正文/溯源 → 重启服务续用同一 Thread、确认新 Turn → 如启用知识库则维护并读回 Wiki → 验证身份伪造被拒绝。不要只判断模型说“成功”，必须断言实际文件/业务记录和 ID。

本次真实验收使用 deepseek-flash + Codex 0.154.0，两个示例各通过六项检查；共六个真实 Turn、十三次工具调用。最新完整记录见 [真实模型报告](verification/real-model-smoke.json)。联网搜索、真实模型完整记忆生成和多用户并发不在本次真实验收结论内。研究实验员提供的脚本已接入，使用 `npm run test:protocol:research` 在隔离环境重跑；原件、适配方式和观测边界见 [协议探针说明](../tests/research-protocol/README.md)。其中多连接共享进程的风险属于复现结果，不代表产品已支持多用户。

自动回归：148 项单元/服务测试、15 项真实存储/RAG 集成、5 项原生 Codex 协议/工具/记忆集成通过，共 168 项。汇总见 [回归记录](verification/harness-upgrade.json)。


研究探针另有 12 组断言通过，见 [本机探针结果](verification/research-protocol/summary.json)。工具超时现在会独立于 handler 返回错误，轮次结束后抑制迟到回复；不合作插件的底层副作用仍不能靠 Promise 取消强制终止，执行函数必须遵守 signal 并通过受限资源接口访问数据。该修复由真实 Codex + 本地模拟模型验证；上方真实模型报告保留其原执行时间，没有冒称本轮再次调用真实模型。
