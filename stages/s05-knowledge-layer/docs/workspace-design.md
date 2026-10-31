# 工作目录体系设计

**状态：** 工作区设计基线，文中的现状表记录升级前实现。稳定工作区与运行目录分离已实施；旧会话兼容限制和实测结果以[项目说明](../README.md)为准，本文目标表不作为已通过的验收记录。
**日期：** 2026-09-29
**锁定版本：** Codex 0.154.0

总体设计入口：[基于 Codex App Server 的 Agent 脚手架设计方案](agent-core-design.md)。本文继续作为工作目录体系的详细规范。

---

## 1 设计原则

**P1 项目工作区为主。** 服务运行根（serviceRoot）与被操作项目目录（workspaceDir）显式分离。服务源码不必是所操作的项目。工作区为可配置的绝对真实路径，默认 `serviceRoot/workspace` 仅为约定起点，允许指向已有外部代码库或文档目录。

**P2 任务隔离按需。** 多数场景线程共享同一工作区。仅当并行写入存在冲突或需要实验性隔离时，才启用独立任务目录。隔离是扩展点，非一期必需功能。

**P3 目录含义单一。** Codex 的 `cwd` 是工作位置语义，不是访问边界，也不是会话持久化边界。目录设计不自动扩展已有的工具权限、文件格式支持或访问策略；这些限制独立维护，不随本设计联动变更。

**P4 配置授权，客户端不可任意重定向。** 工作区由产品侧配置，客户端与模型无权在运行时任意重定义宿主路径。文件系统沙箱与 MCP 服务限制独立执行，不依赖目录命名约定来保障安全。

**P5 一期范围。** 每服务实例对应一个配置的项目工作区；不含多项目管理 UI、多账户、多用户或多主机管理。

---

## 2 目录职责

| 目录 | 路径约定 | 生命周期 | 内容 |
|------|----------|----------|------|
| `serviceRoot` | 脚手架部署根目录 | 跨服务重启保留 | 服务代码、配置 |
| `workspaceDir` | 可配置，默认 `serviceRoot/workspace` | 持久 | 项目文件、原生项目指令与技能 |
| `codexHome` | `serviceRoot/.data/codex`，使用原生 `CODEX_HOME` | 持久 | Codex 原生配置、历史、记忆，不直接编辑 SQLite/JSONL |
| `runDir` | `serviceRoot/.runs/app-server-*` | 服务启动周期 | 日志、临时文件、工具快照；非任务 Run ID |
| 任务目录（可选） | 显式管理 | 任务周期，需手动回收 | 独立检出或实验性写入，不自动合并或删除 |

`workspaceDir` 下的典型布局（下方 `projectRoot` 指该工作区，非服务源码根；文件按需配置）：

```
projectRoot/
├── AGENTS.md                  # Codex 原生项目指令（可选）
├── .agents/skills/            # Codex 原生技能发现（可选）
├── .codex/config.toml         # 项目级 Codex 配置（可选，受信任时原生发现）
└── [项目材料自由布局]
```

`serviceRoot` 下的服务运行目录：

```
serviceRoot/
├── server/                    # 服务源码
├── .data/codex/               # CODEX_HOME，Codex 原生状态
└── .runs/app-server-*/        # runDir，服务启动生命周期
```

`inputs/research/drafts/outputs` 仅属于写作助手模板，不是通用工作区的强制布局。首步调整目录映射时保留已有文件工具限制，通用文件能力另行设计。

---

## 3 会话与任务目录

**多线程共享工作区。** 同一 `workspaceDir` 下的多个原生 Thread 各自拥有独立对话状态。重启服务或开启新会话不自动创建新工作区；`codexHome` 为共享运行时状态，非每会话独立的项目记忆隔离机制，记忆设计另行决策。

**cwd 语义。** `thread/start` 传入显式绝对 `cwd`；`thread/resume` 保留前次有效 `cwd`，不静默重定向至当前随机 `runDir`。`cwd` 变更须同步工具上下文与策略；不通过 `process.chdir` 全局变更来应对多线程场景。

**路径缺失处理。** 配置路径不存在时，给出可操作的错误与恢复路径，不静默降级至其他项目目录。

**可选任务隔离。** Git 项目使用 Git worktree；非 Git 项目使用独立任务目录，需显式声明输入与输出。任务目录不是操作系统沙箱。产出须显式晋升与人工审查后才进入主工作区，不自动合并或删除。活跃任务或尚未收集产物的任务目录不得被维护逻辑当作缓存清除。隔离历史与 worktree 管理的实现边界需实测验证，不预设 app-server 自动创建。

---

## 4 Codex 接入约定

**CODEX_HOME。** `config.mjs` 已将 `CODEX_HOME` 与 `CODEX_SQLITE_HOME` 指向 `serviceRoot/.data/codex`，保留原生状态语义，通过原生接口管理状态，不以直接改写 SQLite/JSONL 实现会话管理。

**原生指令与技能发现。** `AGENTS.md` 与 `.agents/skills/` 遵循 Codex 原生发现机制，不重新实现。父 Git 根的指令可能生效；目录边界不等同于独立项目边界。技能发现与加载须在锁定版本下验证，并遵守已有 Shell 限制。Codex 不自动将项目文件全量注入模型上下文。

**执行目录一致。** app-server 进程可从稳定的项目工作区启动；每个 Thread 仍显式传入有效 `cwd`，工具使用同一工作位置。`turn/start.cwd` 会影响当前及后续轮次，不作为普通消息的可任意覆盖字段。

**日志路径独立。** 服务日志路径使用独立绝对路径，不依赖 `process.cwd()` 拼接。

**状态延续。** Codex 通过 `thread/list`、`thread/read`、`thread/resume` 等原生接口延续状态；`cwd` 作为过滤辅助，不作为授权依据；项目关联校验保留。

---

## 5 现有代码调整

| 模块 | 现状 | 待调整方向 |
|------|------|------------|
| `codex/runtime.mjs` | `prepareRun` 以 `runDir` 作为 `runtime.workspace` | 分离 `serviceRoot`、`workspaceDir`、`runDir` |
| `codex/connection.mjs` | 子进程 `cwd` 和 `protocol.jsonl` 使用 `runtime.workspace` | 传入有效 `workspaceDir`，日志路径用 `runDir` |
| `sessions/index.mjs` | `create` 发送 `thread/start cwd: runtime.workspace`；恢复时用 `selected.cwd` | 使用稳定 `workspaceDir`；恢复时保留原有效 `cwd`，路径缺失报错 |
| `sessions/history.mjs` | 枚举 `.runs` 目录确定 Thread；`ensureThreadDirectory` 仅允许 `.runs` 子目录 | 改用稳定 `cwd` 查找；兼容旧会话查找；不删除或重写已有历史 |
| `tools/files.mjs` & `loader.mjs` | 工具根硬编码 `root/workspace`，约束 `inputs/research/drafts/outputs`；格式限 `.md/.txt` | 绑定配置的 `workspaceDir`，保留现有路径与格式策略，不因本设计扩展权限 |
| `maintenance` 模块 | 清理前保存历史索引，按会话 cwd 保护运行目录，与旧目录语义耦合 | 解耦 Thread 查找与 `runDir`；清理逻辑不涉及活跃工作区 |
| README / 示例配置 | 未区分 workspace 与 runDir | 实现完成后更新文档与示例 |

角色指令中写死的 `app/workspace` 路径说明也须同步调整，避免提示与实际目录不一致。

**旧会话迁移。** 保留受控旧会话查找与恢复路径；迁移前校验协议兼容性；不预先重写 SQLite/JSONL 或删除旧目录；不声明迁移已完成。

---

## 6 验收条件

以下场景均为**待实施验证**；本次仅确认设计，未执行这些验收。

| # | 场景 | 期望可观测结果 |
|---|------|----------------|
| V1 | 两个线程共享同一 `cwd` | 对话历史各自独立，项目文件共享，`workspaceDir` 指向相同绝对路径 |
| V2 | 服务重启后恢复同一线程 | `workspaceDir` 与 `codexHome` 不变，前次有效 `cwd` 保留 |
| V3 | 外部已有目录作为工作区 | 文件工具根与 Codex `cwd` 一致，均指向配置目录 |
| V4 | 配置路径不存在 | 启动或操作时抛出明确错误，提示恢复步骤，不静默降级 |
| V5 | 日志清理操作 | 不丢失活跃会话状态或工作区产出文件 |
| V6 | 可选任务隔离写入（扩展点） | 变更不进入主工作区，直至显式晋升，任务目录不被自动删除 |
| V7 | 原生规则与技能发现 | 发现范围与锁定版本行为一致，Shell 限制不因本设计放开 |
| V8 | 旧会话恢复 | ID 与历史保留，不重写原始存储，协议兼容性先行验证 |
| V9 | `cwd` 变更不扩展权限 | 工具访问策略、文件格式限制不随目录切换而改变 |

---

**参考来源**

- [`server/modules/codex/runtime.mjs`](../server/modules/codex/runtime.mjs)
- [`server/modules/sessions/index.mjs`](../server/modules/sessions/index.mjs)
- [`server/modules/tools/files.mjs`](../server/modules/tools/files.mjs)
- Codex App Server 官方文档：<https://learn.chatgpt.com/docs/app-server>
- Git Worktree 原生桌面行为参考：<https://learn.chatgpt.com/docs/environments/git-worktrees>（原生桌面实现参考，不作为 app-server 自动管理 worktree 生命周期的依据）
