# 模型网关

所有模型调用走同一层：一份模型清单、一个路由、一个网关。Codex（对话）和我们的工具（向量检索，以后的生图、语音等）只连本机的模型网关（[Bifrost](https://github.com/maximhq/bifrost)），网关再转给各家模型。填了哪家的密钥就启用哪家，主模型失败时自动改用备用模型。

```
Codex（对话）────────────┐   模型路由：按用途 / 场景 / 能力挑模型
工具层（知识检索的向量…）──┴──▶ 本机网关 127.0.0.1:4330 ──┬─▶ Kimi / DeepSeek / OpenAI / Grok（原样或转成对话接口）
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
- 用途：`chat`（对话）、`embedding`（向量）、`rerank`（重排序）、`image`（生图）、`video`（生视频）、`tts`（语音合成）、`asr`（语音识别）。看图、长上下文是对话模型的能力（`inputModalities`、`contextWindow`），不单列用途。
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

设置了 `AGENT_GATEWAY_KEY` 就是网关模式：Codex 的地址和密钥自动指向 `http://127.0.0.1:4330/v1`，不能再同时设置 `CODEX_BASE_URL` / `CODEX_API_KEY`。

### 3. 生成配置并启动

```bash
npm run gateway:key      # 只在第一次：生成访问密钥写进 .env（不在终端显示）
npm run gateway:up       # 生成 .data/gateway/ 下的配置与模型参数表，并（重新）启动网关容器
npm run server
```

`.data/gateway/config.json` 里只有 `env.KIMI_API_KEY` 这样的引用，不含密钥本身。密钥由 compose 在启动容器时传入，而且只传 `compose.yaml` 里列出的几个变量，其他 .env 内容不进容器。

改了模型或密钥后，重新运行 `npm run gateway:up`，再重启服务。服务器上运行 `remote.sh gateway`，它会重新生成配置、重建网关并重启服务。

## 模型自带的能力

对话模型可以在 `config/models.json` 中声明 `"nativeTools": ["web_search"]`。这是可选、不重复的字符串数组，目前只允许 `web_search`，仅用于 `purposes` 含 `chat` 的模型。声明以实测为准，不按服务商或协议类型猜测。2026-11-03 经本机网关实测：Kimi K2.7 Code 和 K2.6 会执行原生搜索（输出里有 `web_search_call`）；DeepSeek 快速版（网关转成对话接口）和 GLM-5.3 快速版（转成 Claude 格式）收到搜索工具时不报错，但会忽略它，所以没有声明。也就是说，Kimi 出故障时备用链切到 DeepSeek 不会失败，只是那一轮没有联网搜索。

`AGENT_WEB_SEARCH=auto`（默认）时，网关模式按路由选中的默认对话模型决定开关，`CODEX_MODEL` 覆盖同样生效：声明了搜索就向 Codex 配置 `web_search="live"`，否则为 `"disabled"`。`AGENT_WEB_SEARCH=off` 强制关闭，适合省钱或排查问题；直连模式始终关闭，其他取值启动报错。启动日志会显示联网搜索状态。

Codex 0.154 只通过 Responses API 请求模型；开启搜索后，每个请求的 tools 都会带 `{"type":"web_search","external_web_access":true}`。`thread/start`、`thread/resume` 支持配置覆盖，`turn/start` 不支持，所以只能按会话或整个服务开关，不能在同一会话里按轮切换。本项目在服务启动时统一确定开关；开启后，任何工作流步骤指定的模型（含场景解析出的模型）都必须声明搜索能力，否则启动报错。解决办法是换成支持搜索的模型，或设置 `AGENT_WEB_SEARCH=off`，重启服务并新建会话。

网页读取仍由 `read_webpage` 提供，受 Agent 的 `tools.allow` 控制。失效的 Google 抓取搜索工具已移除；模型原生搜索不在这个工具目录中。搜索不可用时应如实说明并请用户提供链接。

网关启动后，可通过统一协议实测已启用服务商的所有对话模型：

```bash
npm run gateway:check
npm run gateway:check -- --search
npm run gateway:check -- --model kimi/kimi-k2.7-code --search
```

脚本复用项目的 `.env` 读取方式（终端变量优先），地址与密钥取 `gatewayEndpoint()`。请求的输入写成与 Codex 完全相同的消息格式（`type: message` + `input_text`）：网关会把纯字符串输入改写成简写的 `{ role, content }`，而 Kimi 收到简写格式时不会触发搜索，用字符串测会得出错误结论。每个请求限时 60 秒，对话以返回文本为成功；`--search` 另发带 `tools: [{"type":"web_search"}]` 的请求，以 `output` 中出现 `web_search_call` 为成功，不能用“回答声称搜过”代替。表格列出对话、搜索、清单声明、总耗时和两次请求返回的输入/输出 token 合计；不输出密钥或上游正文。

声明了搜索但实测失败会提示并返回非零退出码；实测成功但未声明会提示补充清单。对话失败同样返回非零退出码；未声明的搜索失败仅提示，未加 `--search` 则标为“未测”。自检会产生真实模型用量，`AGENT_WEB_SEARCH=off` 只控制服务启动，不阻止显式的 `--search` 自检。

自检经过当前网关路由和备用链，证明的是该模型 ID 的调用链路；若触发备用，成功可能来自备用模型。修改声明前应结合网关观测确认实际响应模型，必要时暂时移除对应备用链再测。

## 按用途和场景挑模型

模型路由（`server/modules/gateway/router.mjs`）根据三样东西挑模型：用途、场景或具体模型、需要的能力（要看图、要多长的上下文）。挑不到时报错说明每个候选为什么不行，例如“kimi/kimi-k2.7-code：服务商未启用（.env 里缺 KIMI_API_KEY）”。

- **对话**：新会话用默认模型。Codex 的模型目录里放所有可用的对话模型，按轮切换时它有正确的能力信息。
- **工作流步骤**：在 Agent 配置的步骤里写 `model`，可以是场景名或具体模型：

  ```json
  "steps": [
    { "id": "outline", "goal": "确定立意与大纲", "writes": ["drafts"], "confirm": true, "model": "fast" },
    { "id": "final", "goal": "研究、写作、核查并定稿", "writes": ["research", "drafts", "outputs"] }
  ]
  ```

  服务启动时就解析一遍，写错的场景名、没启用的服务商当场报错。**每一轮都会明确带上模型**：Codex 的 `turn/start` 指定的模型会沿用到后面的轮次，没写 `model` 的步骤和普通对话要明确回到默认模型。按步骤切换模型需要网关模式。
- **向量（RAG）**：配了向量库（`CHROMA_URL`）而没有单独配 `EMBEDDING_BASE_URL` 时，知识检索按 `routes.embedding` 挑向量模型、经网关调用，维数取自清单。挑不到可用的向量模型时启动报错，说明缺什么。
- **以后的生图、语音等工具**：同样向路由要“当前的生图模型”，不写死模型。网关已有对应接口（`/v1/images/...`、`/v1/audio/...`、`/v1/videos` 等），支持哪些取决于厂商。

**按复杂度自动选模型暂不做**：中途换模型会让缓存失效、推理衔接不上；Bifrost 的复杂度路由在请求已写明模型时不生效（[#7609](https://github.com/maximhq/bifrost/issues/7609)）。需要时可以参考 LiteLLM 的规则式打分在路由里加，并用 `app/eval/role` 的评估工具量化效果。

## 本地向量模型（Ollama）

```bash
npm run ollama:up        # 启动 compose 里的 ollama 服务（可选服务，db:up 不会带上它）
npm run ollama:pull      # 下载清单里登记的 Ollama 模型（默认 qwen3-embedding:0.6b，约 639 MB）
# .env 里加 OLLAMA_BASE_URL=http://ollama:11434，然后 npm run gateway:up
```

- 网关经容器名访问 Ollama，Ollama 不对宿主开放端口。
- 同时只加载一个模型，空闲 5 分钟卸载以释放内存；上下文默认 2048 词元（`OLLAMA_CONTEXT_LENGTH`），足够切好的文本块。内存上限默认 1.5 GB（`OLLAMA_MEMORY_LIMIT`）。
- **内存实测**（qwen3-embedding:0.6b，CPU）：模型加载后推理进程约 1.1 GB（上下文 4096），上下文 2048、批处理 128 时约 0.9 GB。空闲卸载后约 20 MB。2 GB 内存的服务器放不下，要加内存、加交换空间，或在服务器上改用云端向量模型。
- 官方镜像带显卡加速库，压缩后约 2.7–3.2 GB。没有显卡的机器上也能用，只是镜像偏大。

## 加一家服务商或一个模型

1. 在 `config/models.json` 的 `providers` 和 `models` 里登记，标好 `purposes`；要作为某种用途的默认就加进 `routes`。模型参数（上下文长度、推理档位、向量维数）以官方文档为准。
2. 新的密钥变量要同时加进 `compose.yaml` 网关的 `environment` 和 `deploy/remote.sh` 的 `PROVIDER_KEYS`。`npm test` 会检查三处是否一致。
3. 在 .env 填密钥，运行 `npm run gateway:up`。

## 备用链

- **会触发切换的情况**：主模型失败，包括余额不足（402）、密钥失效（401）、限流（429）、服务端错误（5xx）和超时。网关先按自己的重试规则重试，仍失败就改用备用链里的下一个。备用链里服务商没有密钥的模型会被跳过。
- **不会切换的情况**：已经开始输出之后才出错。
- **中途切换模型**：主模型恢复后，对话历史里会有备用模型留下的推理内容。各家对其他家的推理内容处理不一，可能被忽略。

## 安全

- 网关只监听 `127.0.0.1`。没有访问密钥或密钥不对的请求一律 401（集成测试覆盖）。
- Codex 子进程的环境里去掉所有 `*_API_KEY`，只留 `CODEX_API_KEY`（网关访问密钥）。启动参数、模型目录里也没有密钥。
- 网关不记录请求内容（`disable_content_logging`，日志库关闭）。配置库放在容器的临时目录，重启即清空，每次都以生成的配置文件为准。
- **对外连接**：除了转发给各家模型，Bifrost 每天会从 getbifrost.ai 下载一次公开的模型价格表，用于成本统计；这个同步不能关闭，只能拉长间隔，下载时不发送请求内容。模型参数表改用本地文件，MCP 目录同步已关闭。

## 资源

运行时约 150–180 MB 内存。服务器部署前的检查把可用内存门槛从 600 MB 提到 800 MB，并检查 4330 端口。

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

- `npm test` 里的 `tests/gateway.test.mjs` 检查：
  - 清单与 `nativeTools` 校验；
  - 只启用有密钥的服务商；
  - 配置文件不含密钥；
  - Codex 环境里没有各家密钥；
  - 模型目录取自清单；
  - 三处密钥变量列表一致。
- `tests/native-search.test.mjs` 覆盖默认模型搜索开关、`off` 和工作流步骤的能力校验；`tests/gateway-check.test.mjs` 使用本地假 HTTP 网关覆盖对话、搜索、声明差异、超时和退出码，不访问真实模型。
- `npm run test:gateway` 需要 Docker，用 compose 里锁定的真 Bifrost 镜像、两家模拟模型服务和真 Codex，检查：
  - 没有或错误的访问密钥会被拒绝；
  - 主模型返回 402 时改用备用；
  - 备用服务收到的是它自己的模型名，访问密钥不会转给模型服务；
  - Codex 经网关完成带工具调用的任务，token 用量能回到 Codex。
