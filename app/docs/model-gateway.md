# 模型网关

Codex 只连本机的模型网关（[Bifrost](https://github.com/maximhq/bifrost)），网关再把请求转给各家模型。填了哪家的密钥就启用哪家，主模型失败时自动改用备用模型。

```
Codex ──Responses API──▶ 本机网关 127.0.0.1:4330 ──┬─▶ Kimi（原样转发）
       （只拿网关访问密钥）  （拿着各家密钥）          ├─▶ DeepSeek
                                                  ├─▶ OpenAI / Grok（原样转发）
                                                  └─▶ Claude / Gemini / 智谱 GLM（转换成各自的协议）
```

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
- `models`：`服务商/模型名` → 上下文长度、最大输出（`maxOutputTokens`）、输入类型、推理档位、`fallbacks`（备用链）。`verified` 是实测通过的日期；没有这一项的模型，参数来自官方文档，还没有用真实密钥跑过。
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

## 加一家服务商或一个模型

1. 在 `config/models.json` 的 `providers` 和 `models` 里登记。模型参数（上下文长度、推理档位）以官方文档为准。
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
  - 清单校验；
  - 只启用有密钥的服务商；
  - 配置文件不含密钥；
  - Codex 环境里没有各家密钥；
  - 模型目录取自清单；
  - 三处密钥变量列表一致。
- `npm run test:gateway` 需要 Docker，用 compose 里锁定的真 Bifrost 镜像、两家模拟模型服务和真 Codex，检查：
  - 没有或错误的访问密钥会被拒绝；
  - 主模型返回 402 时改用备用；
  - 备用服务收到的是它自己的模型名，访问密钥不会转给模型服务；
  - Codex 经网关完成带工具调用的任务，token 用量能回到 Codex。
