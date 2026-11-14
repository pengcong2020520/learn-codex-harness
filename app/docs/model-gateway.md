# 模型网关

所有模型调用走同一层：一份模型清单、一个路由、一个网关。Codex（对话）和我们的工具（向量检索、生图、生视频等）只连容器网络内的模型网关（[Bifrost](https://github.com/maximhq/bifrost)），网关再转给各家模型。填了哪家的密钥就启用哪家，主模型失败时自动改用备用模型。

```
Codex（对话）────────────┐   模型路由：按用途 / 场景 / 能力挑模型
工具层（知识检索的向量…）──┴──▶ 容器内网关 gateway:8080 ──┬─▶ Kimi / DeepSeek / OpenAI / Grok（原样或转成对话接口）
        （只拿网关访问密钥）     （拿着各家密钥）              ├─▶ Claude / Gemini / 智谱 GLM（转换成各自的协议）
                                                          └─▶ 本地 Ollama（向量模型）
```

分工：**“这一步该用哪个模型”由脚手架的模型路由决定**（网关看不到任务语义，Codex 也没法按场景给请求加标签）；**网关负责“选定的模型出错时改用谁”和协议转换**。

## 为什么需要网关

- **Codex 只认 Responses API。** 0.154 已经移除 Chat Completions，配置里写 `wire_api = "chat"` 会直接报错。OpenAI、Kimi、Grok 支持 Responses，Claude 和 Gemini 有各自的协议，不经转换接不上。
- **一家出问题，整个服务就停。** 之前只接 DeepSeek，余额用完后服务停了约一天。网关按备用链自动改用下一家。
- **密钥不该进 Codex。** Codex 子进程只拿网关访问密钥；各家真正的密钥只在网关容器里。

Codex 自己能登记多个服务商、按会话选模型，但每个服务商都必须是 Responses 接口，也不会在服务商之间自动切换。所以协议转换和故障切换交给网关。

## 选型：为什么是 Bifrost

2026-11-02 用同样的请求实测了 LiteLLM v1.106.6 和 Bifrost v2.4.0。测试用 Kimi K2.7，覆盖四条路：原样转发、转成 Chat Completions、转成 Claude 协议（用 Kimi 的 Claude 兼容接口模拟）、DeepSeek 余额为 0 时改用 Kimi。

| | LiteLLM | Bifrost |
|---|---|---|
| 直接请求（四条路，各两轮工具往返） | 全部通过 | 全部通过 |
| 经网关跑完整任务（Codex + 本项目，3 个任务） | 全部完成，硬性检查全过 | 全部完成，硬性检查全过 |
| 内存（空闲 / 运行中峰值） | 558 MB / 661 MB | 181 MB / 168 MB |
| 镜像 | 1.82 GB，Python | 375 MB，Go 单文件 |

两者功能上等价。服务器只有 2 GB 内存，所以选 Bifrost。镜像锁定在 `compose.yaml` 里的版本和摘要。

## 配置

### 1. 模型清单 `config/models.json`

登记服务商和模型，网关配置与 Codex 的模型目录都从这里生成：

- `providers`：服务商名 → `type`（接口类型，同名表示 Bifrost 内置，如 `openai`、`anthropic`、`gemini`、`xai`、`deepseek`；不同名表示自定义，如 `kimi` 走 `openai` 接口）、`keyEnv`（.env 里的密钥变量）、可选 `baseUrl`（只写到域名，网关自己加 `/v1/...`）。
- `providers` 里不需要密钥的服务（如本地 Ollama）用 `baseUrlEnv` 代替 `keyEnv`：.env 里填了这个地址变量才启用。容器名或本机地址可以用 http。
- `models`：`服务商/模型名` → `purposes`（用途，必填）、上下文长度、最大输出（`maxOutputTokens`）、向量维数（`dimensions`，向量模型必填）、输入类型、推理档位、`fallbacks`（备用链，只能指向用途相同的模型）。`verified` 是实测通过的日期；没有这一项的模型，参数来自官方文档，还没有用真实密钥跑过。
- 用途：`chat`（对话）、`embedding`（向量）、`rerank`（重排序）、`image`（生图）、`video`（生视频）、`tts`（语音合成）、`asr`（语音识别）。看图、长上下文是对话模型的能力，不单列用途。`contextWindow` 声明上下文长度；图片输入须显式声明 `inputs: ["text","image"]`，缺省为 `["text"]`，`inputModalities` 不自动赋予看图许可。
- `routes`：每种用途的候选，按优先顺序排，第一个服务商已启用的就是默认。对话的默认可以用 .env 的 `CODEX_MODEL` 覆盖。
- `scenes`：给工作流步骤用的对话模型候选，如 `fast`（快而便宜）、`strong`（更强），同样按顺序取第一个可用的。
- **走 Claude 格式接口的服务商（`type: "anthropic"`，如 Claude、智谱）必须填 `maxOutputTokens`。** Claude 格式要求每次请求带输出上限，Codex 不发；网关翻译时去查模型参数表，查不到就用 4096（[Bifrost #5331](https://github.com/maximhq/bifrost/issues/5331)）。思考型模型先把额度用掉，写长文件时工具参数会被截断成不完整的 JSON，之后每次请求都在网关报 500。现在 `npm run gateway:config` 按清单生成本地参数表 `.data/gateway/model-parameters.json`，网关只认这张表，不再从官网下载那张约 26 MB 的公开表。

### 2. `.env`

```bash
AGENT_GATEWAY_KEY=sk-bf-...        # npm run gateway:key 生成；Bifrost 只认 sk-bf- 开头的访问密钥
KIMI_API_KEY=...                   # 填了哪家就启用哪家
DEEPSEEK_API_KEY=...
CODEX_MODEL=kimi/kimi-k2.7-code    # 写成“服务商/模型名”
```

设置了 `AGENT_GATEWAY_KEY` 就是网关模式，不能再同时设置 `CODEX_BASE_URL` / `CODEX_API_KEY`。Compose 通过 `AGENT_GATEWAY_URL=http://gateway:8080/v1` 指定容器内网关；未设置 `AGENT_GATEWAY_URL` 的宿主进程才使用 `http://127.0.0.1:${AGENT_GATEWAY_PORT:-4330}/v1`，这不是默认 Compose 发布的宿主端口。默认宿主入口只有 `127.0.0.1:4317`。

### 3. 生成配置并启动

```bash
npm run setup -- --no-start  # 首次准备 .env、模型与网关访问密钥
npm run up                  # 生成网关配置、构建、执行迁移并启动服务
```

`.data/gateway/config.json` 里只有 `env.KIMI_API_KEY` 这样的引用，不含密钥本身。密钥由 compose 在启动容器时传入，而且只传 `compose.yaml` 里列出的几个变量，其他 .env 内容不进容器。

改了模型或密钥后，重新运行 `npm run up`。服务器上运行 `npm run deploy -- --host 'root@<服务器地址>'`，它会重新生成配置、重建网关并重启服务。

## 模型自带的能力

对话模型可以在 `config/models.json` 中声明 `"nativeTools": ["web_search"]`。这是可选、不重复的字符串数组，目前只允许 `web_search`，仅用于 `purposes` 含 `chat` 的模型。声明以实测为准，不按服务商或协议类型猜测。2026-11-03 经本机网关实测：Kimi K2.7 Code 和 K2.6 会执行原生搜索（输出里有 `web_search_call`）；DeepSeek 快速版（网关转成对话接口）和 GLM-5.3 快速版（转成 Claude 格式）收到搜索工具时不报错，但会忽略它，所以没有声明。也就是说，Kimi 出故障时备用链切到 DeepSeek 不会失败，只是那一轮没有联网搜索。

`AGENT_WEB_SEARCH=auto`（默认）时，网关模式按路由选中的默认对话模型决定开关，`CODEX_MODEL` 覆盖同样生效：声明了搜索就向 Codex 配置 `web_search="live"`，否则为 `"disabled"`。`AGENT_WEB_SEARCH=off` 强制关闭，适合省钱或排查问题；直连模式始终关闭，其他取值启动报错。启动日志会显示联网搜索状态。

Codex 0.154 只通过 Responses API 请求模型；开启搜索后，每个请求的 tools 都会带 `{"type":"web_search","external_web_access":true}`。`thread/start`、`thread/resume` 支持配置覆盖，`turn/start` 不支持，所以只能按会话或整个服务开关，不能在同一会话里按轮切换。本项目在服务启动时统一确定开关；开启后，所有对话路由自动要求 `nativeTools: ["web_search"]`，场景和路由表会跳过不支持搜索的候选，只有全部候选不满足时才报错；具体模型不支持则直接报错。步骤在 configure 时校验，任务选择在提交时校验，派发和预算降级时也执行相同约束。可换成支持搜索的模型，或设置 `AGENT_WEB_SEARCH=off`，重启服务并新建会话。

网页读取仍由 `read_webpage` 提供，受 Agent 的 `tools.allow` 控制。失效的 Google 抓取搜索工具已移除；模型原生搜索不在这个工具目录中。搜索不可用时应如实说明并请用户提供链接。

网关启动后，可通过统一协议实测已启用服务商的所有对话模型：

```bash
npm run gateway:check
npm run gateway:check -- --search
npm run gateway:check -- --model kimi/kimi-k2.7-code --search
```

脚本复用项目的 `.env` 读取方式（终端变量优先），地址与密钥取 `gatewayEndpoint()`。请求的输入写成与 Codex 完全相同的消息格式（`type: message` + `input_text`）：网关会把纯字符串输入改写成简写的 `{ role, content }`，而 Kimi 收到简写格式时不会触发搜索，用字符串测会得出错误结论。每个请求限时 60 秒，对话以返回文本为成功；`--search` 另发带 `tools: [{"type":"web_search"}]` 的请求，以 `output` 中出现 `web_search_call` 为成功，不能用“回答声称搜过”代替。表格列出每个模型已启用的备用链、对话、搜索、清单声明、总耗时和两次请求返回的输入/输出 token 合计；不输出密钥或上游正文。

声明了搜索但实测失败会提示并返回非零退出码；实测成功但未声明会提示补充清单。对话失败同样返回非零退出码；未声明的搜索失败仅提示，未加 `--search` 则标为“未测”。自检会产生真实模型用量，`AGENT_WEB_SEARCH=off` 只控制服务启动，不阻止显式的 `--search` 自检。

自检经过当前网关路由和备用链，证明的是该模型 ID 的调用链路；若触发备用，成功可能来自备用模型。修改声明前应结合网关观测确认实际响应模型，必要时暂时移除对应备用链再测。

## 按用途和场景挑模型

模型路由（`server/modules/gateway/router.mjs`）按用途、场景或具体模型、能力要求挑选候选。场景可以同时包含对话、生图、生视频等用途；先按用途过滤，再依次检查服务商是否启用和能力是否满足。过滤后为空时报“场景 X 里没有能做 Y 的模型”；候选全部不满足时逐个列出原因。

### 步骤能力与推理档位

工作流步骤支持以下可选字段；`needs` 的字段也都可省略：

```json
{
  "id": "outline",
  "goal": "确定立意与大纲",
  "model": "fast",
  "needs": { "image": true, "contextTokens": 200000 },
  "effort": "high"
}
```

`image` 表示需要看图，`contextTokens` 是正整数，表示需要的上下文长度。configure 和 dispatch 都把 needs 传给路由。路由还接受 `needs.nativeTools` 字符串数组；搜索开启时自动合并 `web_search`，不允许步骤取消这项要求。看图能力以清单的 `inputs` 为准；路由不根据厂商名称或用户文本猜测能力，也不自动估算上下文长度。消息附件中的图片会在派发时按最终选中的模型检查，不支持则在调用模型前拒绝；步骤、任务、默认路由与预算降级的选择规则仍生效，在途追加沿用当前轮次模型。

`effort` 可选 `none / minimal / low / medium / high / xhigh / max / ultra`。configure 时检查选中模型的 `reasoningLevels`；没有声明就报“不支持调推理档位”，未包含所选值也报错。dispatch 在任务选择或预算降级之后再次核验，把 effort 传给 `turn/start`。未指定时使用当前模型声明的默认推理档位或 null，避免继承上一步的参数。上例需选中的模型支持 high；例如搜索开启选到未声明 reasoningLevels 的 Kimi 时，应移除 effort。按步骤选模型、声明 needs 或 effort 都需要网关模式。

写作 Agent 的 `write-article` 用 `fast` 生成大纲、`strong` 写成稿。默认 Kimi 开启搜索时，两个场景均跳过不支持搜索的候选而选 Kimi；默认 DeepSeek 关闭搜索时，分别选 DeepSeek Flash 和 V4 Pro。`examples/writing/agent/agent.json` 是不含写文章步骤的精简示例，未添加这个工作流。

### 任务选择、模型目录与决策记录

`POST /messages` 接受可选 `model`：场景名或“服务商/模型名”。提交时由路由校验，未知、用途不符、未启用或不满足搜索要求均返回 400 和原因；相同消息 ID 更换 model 返回幂等冲突。选择存入 tasks 的 `model` 字段。每轮优先级为：**步骤 model > 任务 model > 默认路由**，默认对话仍支持 `CODEX_MODEL` 覆盖。每次 `turn/start` 都明确传模型，避免沿用上一轮。

认证后的 `GET /models` 返回 `models`（按用途分组的已启用模型）、`scenes`（完整候选顺序）、`defaults`（各用途当前默认模型；没有可用模型为 null）、`webSearch`（live / disabled）。每个模型带 `id`、`contextWindow`、`image`、`nativeTools`、`reasoningLevels` 和 `priced`。目录展示已启用模型，不保证它满足当前搜索或特定步骤要求，最终以提交和派发校验为准。直连模式只返回当前默认模型 ID，不能切换模型。

终端 `/model` 列出模型和场景；`/model strong` 或 `/model 服务商/模型名` 为本客户端当前会话的后续消息设置选择；尚未建会话时应用于下一次创建的会话。`/model default` 恢复默认，`/new` 使用默认，恢复旧会话时恢复该客户端记住的选择。客户端重启后选择不保留，已提交任务不受后续修改影响。

派发决策保存为 `selectedModel` 和 `modelSource`（数据库列为 `selected_model`、`model_source`），多步任务每步更新。来源如“步骤指定：场景 strong”“任务指定：场景 fast”“默认路由”“预算降级：场景 fast”。`GET /state` 的 `queue.jobs` 与队列事件都带这两个字段，终端在开始执行时显示“模型：xxx（来源）”，`/queue` 也可回看。追加到仍在执行的轮次无法换模型，记录为“沿用当前轮次”；追加目标已结束、需要新开一轮时，使用该追加任务的选择。决策记录表示提交给 Codex 的模型，并非网关实际作答模型。

### 预算降级与备用链

设置 `AGENT_BUDGET_DOWNGRADE_AT=0.8`，并至少设置一项日/月 token 或金额上限后，用量达到任一上限的 80% 时启用降级。比例必须大于 0、小于 1，留空关闭；场景由 `AGENT_BUDGET_DOWNGRADE_SCENE` 指定，默认 `fast`。变量格式非法时启动报错；开关实际生效时也在启动校验降级场景可用于对话。没有预算上限时不启用降级，也不要求网关。

先按步骤、任务、默认的优先级确定选择；最终选择是具体模型时不降级，场景或默认选择则替换为降级场景。needs、搜索约束和 effort 不会因降级而放宽，选不到满足要求的模型仍报错。`/usage`、`/health` 和队列预算状态带 `downgraded`、`downgradeScene`；这表示全局预算状态，具体模型任务仍可豁免。额度重置后重新计算；达到完整预算上限时仍停止派发新轮次，不用降级绕过上限。

网关备用链负责请求失败后的切换。服务启动时检查已启用对话模型及其已启用备用：备用缺少主模型的 nativeTools，或主模型能看图而备用不能时，打印中文提醒，不阻止启动。`npm run gateway:check` 的每一行也列出实际启用的备用链。提醒只比较清单能力，不表示已探测服务商运行状态。

### 其他用途

RAG 配了 `CHROMA_URL` 且没有单独配 `EMBEDDING_BASE_URL` 时，按 `routes.embedding` 挑向量模型，经网关调用，维数取自清单。

`generate_image` 和 `generate_video` 支持可选 `quality: "fast" | "strong"`，分别从对应场景里过滤出生图或生视频候选。不写 quality 就使用 `routes.image` 或 `routes.video`。fast 的媒体候选是 Seedream Flash、Seedance Mini；strong 是 Seedream Pro、Seedance Fast。quality 只控制路由，不作为服务商生成参数；媒体仍遵守完整预算上限，当前不应用对话任务的预算降级规则。

**按复杂度自动选模型暂不做**：中途换模型会让缓存失效、推理衔接不上；Bifrost 的复杂度路由在请求已写明模型时不生效（[#7609](https://github.com/maximhq/bifrost/issues/7609)）。需要时可以参考 LiteLLM 的规则式打分在路由里加，并用 `app/eval/role` 的评估工具量化效果。

## 本地向量模型（Ollama）

脚手架不包含 Ollama 服务或模型下载命令。使用外部 Ollama 时，先准备服务与清单中登记的模型，在 `.env` 设置网关容器可访问的 `OLLAMA_BASE_URL`，再运行 `npm run up`。

## 加一家服务商或一个模型

1. 在 `config/models.json` 的 `providers` 和 `models` 里登记，标好 `purposes`；要作为某种用途的默认就加进 `routes`。模型参数（上下文长度、推理档位、向量维数）以官方文档为准。
2. 新的密钥变量要加进 `compose.yaml` 网关的 `environment`。`npm test` 检查模型清单里的 `keyEnv` 在网关环境中登记，且未传给其他服务。
3. 在 .env 填密钥，运行 `npm run up`。

## 备用链

- **会触发切换的情况**：主模型失败，包括余额不足（402）、密钥失效（401）、限流（429）、服务端错误（5xx）和超时。网关先按自己的重试规则重试，仍失败就改用备用链里的下一个。备用链里服务商没有密钥的模型会被跳过。
- **不会切换的情况**：已经开始输出之后才出错。
- **中途切换模型**：主模型恢复后，对话历史里会有备用模型留下的推理内容。各家对其他家的推理内容处理不一，可能被忽略。

## 安全

- 网关不对宿主发布端口，节点通过容器网络内的 `gateway:8080` 访问。没有访问密钥或密钥不对的请求一律 401（集成测试覆盖）。
- Codex 子进程的环境里去掉所有 `*_API_KEY`，只留 `CODEX_API_KEY`（网关访问密钥）。启动参数、模型目录里也没有密钥。
- 网关不记录请求内容（`disable_content_logging`，日志库关闭）。配置库放在容器的临时目录，重启即清空，每次都以生成的配置文件为准。
- **对外连接**：除了转发给各家模型，Bifrost 每天会从 getbifrost.ai 下载一次公开的模型价格表，用于成本统计；这个同步不能关闭，只能拉长间隔，下载时不发送请求内容。模型参数表改用本地文件，MCP 目录同步已关闭。

## 生图与生视频

`routes.image` 默认先选 `byteplus/doubao-seedream-5-0-flash-260915`，再选 `byteplus/doubao-seedream-5-0-pro-260628`；`routes.video` 默认先选 `byteplus/doubao-seedance-2-0-mini-260615`，再选 `byteplus/doubao-seedance-2-0-fast-260128`。路由选第一个服务商已启用的模型，不按账户开通状态探测；请先在火山方舟控制台开通要使用的模型。未启用服务商时，对应生成工具不进入目录；视频不可用时也隐藏 `media_status`。

火山方舟使用 Bifrost 2.4.0 内置服务商，必须登记为 `byteplus`：

```json
"byteplus": {
  "type": "byteplus",
  "baseUrl": "https://ark.cn-beijing.volces.com",
  "keyEnv": "ARK_API_KEY"
}
```

这里不能改名成自定义服务商；`baseUrl` 只写域名，网关自己补 `/api/v3/...`。`.env.example` 提供 `ARK_API_KEY` 占位，compose 和部署脚本同步传入网关。应用只持有 `gatewayEndpoint()` 返回的网关地址和访问密钥，不把方舟密钥传给工具或 Codex。配置后运行 `npm run up`；`npm run up` 会执行迁移并启动服务。

- `generate_image`：prompt 最多 8000 字符，n 为 1–4，默认一张、`2048x2048`。调用网关 `/v1/images/generations`，固定 `response_format: "b64_json"`，直接拿图片正文；默认 URL 响应的链接 24 小时后过期，不适合长期产物。返回工作区路径、模型、请求尺寸和版本信息。默认按时间加随机 ID 命名；多张在文件名后加 `-1`、`-2` 等序号。
- `generate_video`：prompt 最多 8000 字符，seconds 为 2–15 的整数，默认 5 秒、`1280x720`。向 `/v1/videos` 提交后立即返回本地持久化任务 `id` 和远端 `providerId`；无需等待生成。`media_status({id})` 使用本地 ID 查询 `queued / in_progress / completed / failed`，完成返回路径与版本，失败返回原因。
- 后台每 10 秒查询 `/v1/videos/{providerId}`，最长等待 20 分钟；完成后经 `/content` 下载 MP4，保存到工作区。服务商任务保留 7 天、下载链接有效 24 小时，所以后台完成即下载。短暂网络故障继续重试查询；超时、服务商失败、权限撤销或文件冲突记为失败。重启继续数据库里的未完成任务，并沿用原截止时间；任务提交期间崩溃而未拿到远端 ID 时标记“结果未确认”，不自动重提以免重复收费。本地超时不代表远端取消，仍可能产生供应商费用。
- 二进制只允许写到当前 Agent 的 outputs 目录，格式必须在 outputs.formats 声明（png / jpeg / webp / mp4）。默认子目录是 `outputs/media/`；自定义 outputs 时跟随该目录。单个正文最多 128 MiB，检查格式签名、路径和链接，不覆盖已有文件；资源正文按哈希留存不可变版本。普通 `read_file` / `write_file` 仍只对模型开放文本，二进制通过媒体服务保存，资源服务支持读取二进制版本。
- 提交前检查当前轮次的 create 门禁（包括 workflow.writes）。后台授权只保留这一任务的单个输出路径，每次保存重新检查当前 Agent 的目录、格式和工具权限，不借用已结束轮次的授权。任务按实例、owner 隔离，查询还检查 Agent 身份。后台同一任务恢复写入时只接受相同资源 ID 和相同正文哈希。

`generate_image`、`generate_video` 调用前检查 `budgetStatus()`，预算已超则拒绝并说明原因；`media_status` 只是查询、不产生费用，超预算时照常可用；描述明确要求“只在用户明确要求生成时调用，生成会产生费用”。已提交视频仍跟进和落盘，不因之后预算耗尽而丢弃结果。每次生图按响应张数记一条 image 用量，带上响应中的 token；每个完成的视频按请求秒数记一条 video 用量，有 usage 同样记录，使用任务 ID 去重。生成成功但本地保存失败仍记消耗；服务商未报告的失败消耗无法估算。没有价格不等于免费，清单不预填真实价格；请按自己的计费约定填写 pricing。预算不预留未来费用，并发生成可能超额。

`tests/media-http.test.mjs` 使用本地假 HTTP 网关验证图片请求与视频异步链路；`tests/media.test.mjs` 另用注入的 Response 覆盖相同状态机、参数、门禁、预算与无可用模型。`npm run test:data` 验证真实 PostgreSQL 的任务恢复、二进制版本和记账去重；不调用真实生成服务。

## 用量与预算

### 账本和估算口径

`npm run up` 会执行迁移。PostgreSQL 用量账本按 `instance_id`、`owner_id` 隔离，按时间索引；不存提示词、回答或密钥。每条记录包括时间、Thread、Turn、任务 ID（有任务时）、来源 `chat / embedding / image / video`、模型 ID、输入、缓存输入、输出、推理输出、总 token、可空的 `units`、币种和估算花费。

- **对话**：监听 `thread/tokenUsage/updated`。Thread 的 `total.totalTokens` 只用来去重：比上次大才记账，金额和 token 取本次 `last`。相等或更小的通知跳过；服务重启后第一条直接取 `last`，不把 Thread 历史累计量再记一遍。停止服务期间的调用不会补账。
- **模型与任务**：在 `turn/start` 前绑定本轮路由选出的模型和任务 ID，通知早于 RPC 响应也能定位；工作流换步骤时重新选模型，每一步仍归属原任务。直连模型没有服务商前缀时记为 `direct/模型名`；无法识别则为 `direct/unknown`。Codex 的通知不含 Bifrost 最终备用模型，网关内部故障切换只能归属到本轮提交的路由模型，相关花费是估算，不能用来核对供应商账单。
- **向量**：每次成功取得 embedding 响应就按 `usage.prompt_tokens`（缺失时取 `total_tokens`）记输入，总量取 `total_tokens`（缺失时取 `prompt_tokens`）。响应不含 usage 时不猜测；响应已报告用量但向量校验失败，仍记已消耗的用量。检索发生在任务内时带上 Thread、Turn 和任务 ID；后台索引可以为空。
- `inputTokens` 已含缓存输入，`outputTokens` 已含推理输出，**两者都不再重复相加**。总 token 取协议的 `totalTokens`；工具不传总量时默认输入加输出。
- 生图、生视频调用同一个 `usage.record({ source, model, inputTokens, outputTokens, units, threadId, turnId, taskId })`，`units` 可记录张数或秒数。数量的单位由来源约定，不应把跨来源的数量合计当作同一种计费量；价格表同时计算 token 花费与按张、按秒的费用。

生产服务必须连接 PostgreSQL，不会在数据库故障时回退到内存。独立模块或无数据库测试使用内存账本，查询返回 `storage: "memory"`，客户端会提示重启清空；生产返回 `storage: "postgres"`。账本写入失败会停止派发，不能按空账本继续运行。预算查询等待已收到的用量写入后再计算。

### 价格表

清单顶层可写 `"currency": "CNY"` 或 `"USD"`，省略时是 CNY。每个模型可写 `pricing`：`input`、`output`、`cachedInput` 的单位为**每百万 token 的价格**，`cachedInput` 省略时等于 input。非媒体模型的 input、output 必填；纯媒体模型可只填 `perImage`（每张）或 `perVideoSecond`（每秒），也可同时填 token 单价。所有价格必须是有限的非负数字；0 表示已确认免费，未填写表示未定价。

以下仅为格式示例，数字是虚构的，不代表任何真实模型价格；仓库的 `config/models.json` 不预填价格：

```json
{
  "currency": "CNY",
  "models": {
    "example/model": {
      "purposes": ["chat"],
      "contextWindow": 128000,
      "pricing": { "input": 2, "cachedInput": 0.5, "output": 8 }
    }
  }
}
```

估算花费 = `((输入 − 缓存输入) × input + 缓存输入 × cachedInput + 输出 × output) / 1000000`。媒体还要加上 `units × perImage` 或 `units × perVideoSecond`；只填张/秒单价时，token 只统计数量、不另估价；只填 token 单价时，不额外按张/秒估价，两种价格都填则相加。完全没有适用价格的记录标为未计价。推理输出不另收费，缓存写入不另设价格。未定价记录不计入金额，但计入 token 总量，并在查询的 `unpricedRequests` 中标出，客户端显示“未计价”。

金额在记录时按当时的清单计算并落库；以后补价格不会追溯改写历史。更改币种后，旧币种记录仍计入 token，但在当前币种的金额汇总中标为未计价，避免把 CNY 与 USD 直接相加。价格或币种修改后需重启服务。

### 配置和超限行为

```bash
AGENT_BUDGET_DAILY_TOKENS=1000000
AGENT_BUDGET_MONTHLY_TOKENS=20000000
AGENT_BUDGET_DAILY_COST=10
AGENT_BUDGET_MONTHLY_COST=200
AGENT_BUDGET_TIMEZONE=Asia/Shanghai
# 可选，优先指定网关兜底的每日 token 数
AGENT_GATEWAY_DAILY_TOKENS=1500000
```

四个预算变量都可留空，留空不限；token 必须为非负安全整数，金额必须为有限非负数字。0 表示停止派新任务。非法值在启动时报中文错误。时区默认取服务进程的系统时区，决定“今天”“本月”的起止，支持夏令时；修改时区也需重启服务。设了金额上限但默认对话模型未定价时，启动打印一行提醒，不阻止启动。

任一日/月 token 或金额累计量**达到上限**时，`dispatch()` 不把 queued 改为 starting，任务保留排队。正在执行的轮次允许完成，追加到执行中轮次的 `steer` 不拦，`proposed` 提议照常记录；追加到已结束轮次需要新开一轮，因此也检查预算。多个会话已在执行时都可以完成，预算不预估或预留未来消耗，可能超出设定值。

服务每隔最多 3 分钟复查，接近恢复时间时在下一个当地自然日/月开始复查，恢复后自动派发，不需要 `/continue`。同时达到日/月上限时，`resetsAt` 取所有超限项中最晚的恢复时间；0 上限仍会在复查时保持阻塞。手动暂停或故障暂停仍沿用原有恢复规则。

`publish()` 队列快照、`/state` 的 `queue.budget`、`/health` 都包含 `budget: { exceeded, reason, resetsAt, downgraded, downgradeScene, ... }`，reason 是中文；达到预算不会把健康状态改成故障。未超限时 reason、resetsAt 为 null。

### 查看用量

- 终端 `/usage` 看今日，`/usage month` 看本月，中文表格展示合计、模型、来源、日期、估算花费和未计价条数。
- 认证后的 `GET /usage?period=today|month` 默认 today，其他 period 返回 400。返回 `total`、`byModel`、`bySource`、`byDay`、`budget`、`currency`、`timezone`、`storage` 和周期 `start/end`。金额单位由 currency 指定，`estimatedCost` 只含已定价部分；日期按预算时区分组。预算状态始终同时包含当日和当月，不随查询 period 改变。

### 网关兜底及局限

设置 `AGENT_BUDGET_DAILY_TOKENS` 时，`buildGatewayConfig()` 生成 `governance.rate_limits[]`，`token_max_limit` 为每日预算的 **1.5 倍向上取整**，`token_reset_duration: "1d"`、`calendar_aligned: true`，`codex-harness` 虚拟密钥通过 `rate_limit_id` 引用它。`AGENT_GATEWAY_DAILY_TOKENS` 有值时优先使用，即使没有配置服务端每日预算也能单独限流。更新后需重新生成配置并重建网关容器。

这里只用 token 限流，不使用 Bifrost 按美元计价的 budgets。网关计数涵盖共享虚拟密钥的所有请求（包括独立自检等未进入本服务账本的调用），自然日由网关自身的日历计数规则决定，不保证与 `AGENT_BUDGET_TIMEZONE` 相同。配置库位于容器临时目录，重启后计数清零，因此只是兜底，长期预算以 PostgreSQL 账本为准。兜底耗尽时，正在执行轮次的后续模型请求也可能被拒绝；1.5 倍只是预留余量，不能保证任意长轮次完成。

单元测试覆盖记录、去重、工作流换模型、向量 usage、时区边界、预算阻塞与恢复、HTTP 和客户端。`npm run test:data` 额外验证真实 PostgreSQL 持久化和归属隔离；`npm run test:gateway` 的限流用例会启动真实 Bifrost 容器，验证首个请求耗尽额度后第二个请求返回 429。

## 资源

网关容器内存上限由 `GATEWAY_MEMORY_LIMIT` 控制，默认 `256m`。部署检查核对 Docker、systemd、rsync 等工具；实际内存、磁盘和模型连通性需在部署环境核验。

## 已验证与未验证

- **已用真实密钥验证**：
  - Kimi K2.7 原样转发；转成 Claude 协议和 Chat Completions；DeepSeek 返回 402 时改用 Kimi。
  - DeepSeek V4 快速版（`deepseek/deepseek-flash`，网关转成它的对话接口；不填上限时实测可输出 6700 多词元，不会被截断）：“写汇报材料”完整任务 25 秒，8/8 项检查通过。
  - 智谱 GLM-5.3 Flash（转成 Claude 格式）：同一任务 5 分钟，8/8 项检查通过；补上输出上限之前，它在写文件时被截断而失败。
- **只验证了链路**：Hugging Face 推理服务。请求经网关能到达 HF，但账户额度为 0，没有跑完整任务。
- **未用真实密钥验证**：OpenAI、Claude、Gemini、Grok 的真实接口。清单里的模型名和上下文长度来自各家 2026 年 10 月的官方文档，第一次启用时建议先跑一个简单任务。

## 常见问题

- **智谱 GLM**：没有 OpenAI 新接口（`/responses` 返回 404），清单里按 Claude 格式接入（`https://open.bigmodel.cn/api/anthropic`，国际站 Z.ai 用 `https://api.z.ai/api/anthropic`）。
- **Hugging Face 推理服务**（服务商名 `hf`，密钥变量 `HUGGINGFACE_API_KEY`）：一个令牌调用多家算力商托管的开源模型，模型名写成 `hf/组织/模型`，如 `hf/deepseek-ai/DeepSeek-V4.1-Flash`。
  - 按用量从 HF 账户扣费，免费账户额度很少，用完返回“no remaining credits”。
  - 它有 OpenAI 新接口，网关原样转发。新接口出错时返回码仍是 200、错误写在内容里；Codex 用的流式请求会被网关识别为失败（502），备用切换照常触发。
  - 同一模型由 HF 分配给不同算力商，速度和价格可能不同。清单里只登记了各算力商上下文都在 100 万左右的模型。
  - 令牌只需“推理”权限，不要用带仓库写权限的令牌。
- **长文章写到一半断掉、随后网关一直报 500**：走 Claude 格式的模型没填 `maxOutputTokens`，见上文“模型清单”。
- **Kimi 返回 401 Invalid Authentication**：国内站和国际站账号不通用，platform.moonshot.cn 的密钥只能用 `api.moonshot.cn`。国际站密钥要把 `config/models.json` 里 kimi 的 `baseUrl` 改成 `https://api.moonshot.ai`。
- **网关返回 "virtual key is required"**：访问密钥不是 `sk-bf-` 开头。删掉 .env 里的 `AGENT_GATEWAY_KEY` 后重新运行 `npm run gateway:key`。
- **启动服务时报 CODEX_MODEL 不在清单里**：网关模式要写成 `服务商/模型名`，并且在 `config/models.json` 里登记过。

## 测试

`npm run test:gateway` 还包含 `tests/media-gateway.integration.mjs`：验证真实 MediaService 经锁定版本 Bifrost 的内置 byteplus 通道，使用正式清单的模型名完成火山方舟格式转换、图片保存、视频后台轮询与下载，以及按张/秒记账；上游是本机模拟的火山方舟，只返回固定 PNG/MP4，不验证真实模型开通、生成质量或实际计费。

- `npm test` 里的 `tests/gateway.test.mjs` 检查：
  - 清单与 `nativeTools` 校验；
  - 只启用有密钥的服务商；
  - 配置文件不含密钥；
  - Codex 环境里没有各家密钥；
  - 模型目录取自清单；
  - 清单 `keyEnv` 在 Compose 网关 `environment` 中登记，且不传给其他服务。
- `tests/native-search.test.mjs` 覆盖默认模型搜索开关、`off` 和工作流步骤的能力校验；`tests/gateway-check.test.mjs` 使用本地假 HTTP 网关覆盖对话、搜索、声明差异、超时和退出码，不访问真实模型。
- `npm run test:gateway` 需要 Docker，用 compose 里锁定的真 Bifrost 镜像、两家模拟模型服务和真 Codex，检查：
  - 没有或错误的访问密钥会被拒绝；
  - 主模型返回 402 时改用备用；
  - 备用服务收到的是它自己的模型名，访问密钥不会转给模型服务；
  - Codex 经网关完成带工具调用的任务，token 用量能回到 Codex。

已知局限：网关备用链触发后，实际作答的模型无法从 Codex 的用量通知里得知，账本仍记提交的模型。
