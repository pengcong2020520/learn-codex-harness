# 接入模型

从仓库根目录运行配置向导：

```bash
npm run setup:model
```

向导支持多选阶段，只使用 Node 内置模块。先在要运行的阶段安装依赖，例如 `npm --prefix stages/s01-single-turn ci`；也可以在根目录运行 `npm run setup` 安装全部项目依赖。

| 路线 | 适合谁 | 配置范围 |
| --- | --- | --- |
| A：ChatGPT 账号登录 | 已有可用订阅，希望使用订阅额度，不单独填写 API Key；仅使用 OpenAI 模型 | 默认 s01–s10 |
| B：一个 API Key | 已有模型服务商密钥，希望直连一个支持 Responses API 的模型 | 默认 s01–s10 |
| C：多个 API Key | 需要多家模型、协议转换、备用模型和用量管理 | s11、s12、s13 与 app，默认同时配置 |

`s00-sdk-quickstart` 使用 SDK，直接读取本机登录或 `CODEX_API_KEY`。向导只提示，不改 s00；继续按 [s00 说明](s00-sdk-quickstart/README.md) 操作。

## A：ChatGPT 登录一次，各阶段共用凭证

先在本机终端登录：

```bash
npx codex login
npm run setup:model -- --stage s01
```

向导中选 A。可以省略 `--stage s01`，在交互中用逗号多选阶段；回车默认 s01–s10。如果本机尚未登录，向导会询问是否现在登录；同意后使用已安装的阶段 Codex 执行一次 `codex login`，继承终端供浏览器登录交互。

本机凭证通常位于 `~/.codex/auth.json`。设置了终端环境变量 `CODEX_HOME` 时，则使用 `$CODEX_HOME/auth.json`。向导不读取凭证内容，而是在所选阶段创建：

```text
<阶段>/.data/codex/auth.json -> <本机 auth.json 的绝对路径>
```

本机 `auth.json` 本身必须是普通文件，不接受符号链接；也不能与即将替换的阶段 `auth.json` 是同一文件（会比较设备和 inode，包括硬链接、目录别名）。校验失败时保留原文件。阶段状态目录权限为 `0700`。已有普通 `auth.json` 会先改名为 `auth.json.bak-<时间>`，向导会报告备份文件名；已有正确链接会跳过。不会复制凭证，因为刷新令牌轮换后副本可能失效。Windows 无法创建符号链接时会明确报错，可启用开发者模式后重试，或改走 B 路线。

向导会逐阶段用隔离的 `CODEX_HOME` 复核登录状态。链接正确后，把该阶段 `.env` 里有效的 `CODEX_API_KEY`、`CODEX_BASE_URL`、`CODEX_MODEL` 三项注释掉，并把 `CODEX_MODEL_CATALOG_ENABLED` 设为 `false`（没有这一行则追加）。其余行保留。输出会说明：已关闭本地模型目录（ChatGPT 登录使用 Codex 默认模型目录）。

**本地模型目录。** 阶段示例默认 `CODEX_MODEL_CATALOG_ENABLED=true`，目录生成器要求填写模型名。A 路线注释模型名后自动关闭本地目录，改用 Codex 默认模型目录。已有登录模式下，`--check` 若发现该值不是 `false`，会把它列为缺项，并提示设为 `false`。

只需要建立登录链接时：

```bash
npm run link-login                         # 默认 s01–s10，不修改 .env
npm run link-login -- --stage s01,s05
npm run link-login -- --status --stage s01 # 查看链接目标是否正确和登录状态
npm run link-login -- --unlink --stage s01 # 只删符号链接，不删本机文件或备份
```

`link-login` 不会切换认证模式。若阶段已有 API 配置，请用 A 路线完成注释，或手工注释三项。

## B：填写一个 API Key

```bash
npm run setup:model -- --stage s01,s02
```

选 B，再选服务商或“自定义”。内置选项的地址和推荐模型全部取自仓库：

| 服务商 | Base URL | 推荐模型 | 仓库来源 |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-6.1-terra` | 地址：[s00 .env.example](s00-sdk-quickstart/.env.example)；模型：[模型清单](../app/config/models.json) |
| Kimi | `https://api.moonshot.cn` | `kimi-k2.7-code` | [模型清单](../app/config/models.json) |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` | [s01 .env.example](s01-single-turn/.env.example)，[模型清单](../app/config/models.json)亦有对应模型 |

这里列的是仓库当前配置，不代表已验证你的账号权限或服务商当前可用性。Kimi 表中是国内站地址；账号与密钥需匹配站点。需要其他地址或模型时选“自定义”，接口必须支持 Responses API。

Key 和自定义 Base URL 均隐藏输入；地址校验失败只提示原因，不回显输入地址。Base URL 必须使用 HTTPS（仅 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP），不能含用户名、密码、查询参数或片段，末尾不能是 `/responses` 或 `/chat/completions`。向导写入 `CODEX_API_KEY`、`CODEX_BASE_URL`、`CODEX_MODEL`，并把 `CODEX_MODEL_CATALOG_ENABLED` 恢复为该阶段 `.env.example` 中的值；示例里没有这项则保持原行不动。`.env` 不存在时先以 `.env.example` 为模板，其余行和注释保留，写入后权限为 `0600`。不要把密钥放在命令行参数中，也不要提交 `.env`。

更换模型后，`CODEX_MODEL_*` 中的上下文长度、输入类型、推理档位等可能不再适用。向导会提醒核对，不会自行修改模型能力声明。同名终端环境变量优先于 `.env`，如终端已设置旧值，应先清除，再启动阶段。

## C：通过模型网关使用多个 Key

```bash
npm run setup:model -- --stage s11,app
```

选 C，按提示填写 `KIMI_API_KEY`、`DEEPSEEK_API_KEY` 等服务商变量。各项均隐藏输入，回车跳过；已有值会保留。`AGENT_GATEWAY_KEY` 也隐藏输入，回车保留现值；原值为空时生成 `sk-bf-` 开头的随机值，不在终端显示。

Codex 只连接网关，用 `AGENT_GATEWAY_KEY` 认证；各家密钥交给网关。向导注释直连的 `CODEX_API_KEY` / `CODEX_BASE_URL`，切换到网关时采用示例中的网关模型名。已使用网关的阶段会保留既有模型选择。其他配置不变。

例如启动 s11：

```bash
npm --prefix stages/s11-model-gateway run db:up
npm --prefix stages/s11-model-gateway run data:migrate
npm --prefix stages/s11-model-gateway run gateway:up
npm --prefix stages/s11-model-gateway run server
# 另开终端
npm --prefix stages/s11-model-gateway start
```

app 使用相同脚本，把上述前缀目录换成 `app`。s11 与 app 同时运行时，需另行安排数据库和网关端口，向导不会分配端口。备用链、模型能力和路由见 [模型网关说明](s11-model-gateway/docs/model-gateway.md) 与 [app/config/models.json](../app/config/models.json)。

## 检查配置与启动

```bash
npm run setup:model -- --check            # 只读，默认 s00–s13 与 app
npm run setup:model -- --check --stage s05
npm run doctor                            # 默认全部，不调用模型
npm run doctor -- --stage s01 --handshake
```

`--check` 列出阶段、模式、缺项和登录状态，并校验直连 Base URL。对 s01–s10，`.env` 不存在且没有模型环境变量时显示“未配置”；有部分 API 配置（包括空的配置行）时显示 API Key 模式及缺项；三项都未设置时检查已有登录。已有登录（A）下，若 `CODEX_MODEL_CATALOG_ENABLED` 不是 `false`，缺项为“设 CODEX_MODEL_CATALOG_ENABLED=false”。s11、s12、s13 与 app 始终标为“API Key（模型网关）”，缺少 `AGENT_GATEWAY_KEY` 时提示选择路线 C，不检查登录链接。未通过检查时退出码为 1。检查不改写 `.env`。

s00 是上述“未配置”规则的例外：按本机登录或 `CODEX_API_KEY` 判断；没有 Key 时显示“已有登录”，`--check` 检查本机登录，不要求 `.env`，也不要求阶段登录链接或本地模型目录开关。

`doctor` 检查依赖、`.env`、模式、缺项、Base URL、登录链接和 Codex 版本，并给出修复命令。`--handshake` 额外启动该阶段的 Codex App Server，完成 `initialize/initialized` 后终止整棵进程树并确认退出，不发起对话。握手成功只说明 CLI 协议可以连接，不证明 Key 有效或模型可用；也不检查数据库、网关连通性。

根工具统一使用 `stages/<阶段>/node_modules/.bin/codex`；检查 app 时借用 s11 的 CLI，但仍使用 app 的状态目录，所以也需安装 s11 依赖。Windows 使用同一安装包的 JS 入口启动 CLI。握手结束（含超时）及登录超时均清理整棵进程树：Unix 使用独立进程组，先 `SIGTERM`、必要时 `SIGKILL`；Windows 等待 `taskkill /pid <pid> /t /f` 完成。包装进程先退出不会提前结算；无法确认清理完成时报告失败。

向导结束时打印所选阶段的启动命令，并询问是否做一次会产生模型用量的验证，默认否。当前自动单轮验证限已选择的 s01/s02，只验证一个阶段，60 秒超时；其他阶段的 smoke 有多轮或服务依赖，不在这个单轮验证中自动运行。模型原始输出隐藏，只显示完成或失败。真实调用另由你在本机终端确认执行。

s08 起还需要 PostgreSQL、Redis 和数据库迁移。s08–s10 按各章说明使用 `docker compose up -d postgres redis`，再运行 `npm run data:migrate`；s11/app 可使用 `npm run db:up`。根目录 `doctor` 只查配置是否存在，不替代数据库准备。

## 常见报错

| 现象 | 检查与解决 |
| --- | --- |
| 模型请求返回 401 | Key 无效、已撤销或站点不匹配；核对服务商账号，重新运行 B/C 写入。不要把 Key 贴进错误报告。 |
| 地址带了 `/responses` 或 `/chat/completions`，请求 404 或路径重复 | Base URL 填接口基础地址，移除这两种末尾路径；具体请求路径由 Codex 追加。 |
| 模型不支持 Responses | 换支持 Responses 的模型/服务商；需要协议转换时使用 s11/app 网关。仅提供 Chat Completions 的地址不能直接用于 B。 |
| ChatGPT 未登录、过期，或本机登录方式是 API Key | 重新执行 `npx codex login` 完成 ChatGPT 登录；凭证更新后，链接它的各阶段自动生效，无需复制文件。 |
| 本机已登录，阶段仍提示未登录 | 阶段把 `CODEX_HOME` 隔离到自身 `.data/codex`，看不到本机登录；运行 `npm run link-login -- --stage s05`。 |
| 链接失效或目标不符 | 检查终端 `CODEX_HOME` 是否变化；在当前本机目录重新登录，再运行 `npm run link-login`。 |
| 已有登录仍提示生成模型目录缺少 `CODEX_MODEL`，或 `--check` 把目录开关列为缺项 | 重新运行向导并选 A，或把 `CODEX_MODEL_CATALOG_ENABLED` 设为 `false`；三项保持注释，随后重跑 `--check` 或 `doctor`。 |
| 改了 `.env` 却仍使用旧配置 | 同名终端环境变量优先；清除旧的模型变量并重启阶段服务。 |
| Windows 无法创建符号链接 | 启用开发者模式或改用 B；工具不会用凭证副本兜底。 |
| s08 起启动时数据库或 Redis 连接失败 | 启动 PostgreSQL/Redis，核对连接变量和端口，并完成 `data:migrate`。 |
| 网关已配置但没有可用模型 | 至少填写一个对应云模型的服务商 Key，启动网关，并按模型网关说明检查路由。 |

配置工具不会打印 Key，也不会转发可能含敏感值的原始子进程错误。真实登录步骤继承 Codex 自身终端交互；它使用的是清除了 API Key 等变量的环境。

s12 使用模型网关配置，不建立 link-login 链接；部署步骤见 [s12 README](s12-deploy/README.md)。它自带 Compose，与 app 的共享 stages 容器独立。

s13 同样使用模型网关，不进入 link-login 默认列表；独立部署与登录步骤见 [s13 README](s13-auth/README.md)。
