# 部署到服务器

把 `app/` 和 `stages/s03–s11` 作为常驻服务部署到一台 Linux 服务器。**全部服务都在 Docker 里**（[compose.yaml](../compose.yaml)），宿主只需要 Docker；端口**只发布到服务器的 127.0.0.1**，不对公网开放，在本机用 SSH 隧道访问。

| 服务（compose） | 作用 | 宿主端口 | 何时启动 |
|---|---|---|---|
| `postgres` / `redis` | 数据库与队列 | `127.0.0.1:5432` / `6379` | 总是 |
| `gateway` | 模型网关（Bifrost），各家模型密钥只交给它 | `127.0.0.1:4330` | 总是 |
| `ollama` | 本地向量模型（RAG 用） | 不发布，网关经容器名访问 | 服务器 `.env` 填了 `OLLAMA_BASE_URL` |
| `agent` | Agent 服务（含 Codex） | `127.0.0.1:4317` | 总是 |
| `stages` | s03–s11 的九个 Agent（与 `agent` 共用网络） | 不发布额外端口 | `app` profile，默认全部 |
| `web` | Web 工作台与互动课程（与 `agent` 共用网络） | `127.0.0.1:14320` | 总是 |

`agent` 与 `web` 共用一个镜像，在服务器上构建（`Dockerfile`），容器里以 `node`（uid 1000）运行。`.data/`、`.runs/`、`workspace/` 挂载到宿主的部署目录，便于备份和迁移；PostgreSQL、Redis 与 Ollama 的数据在 Docker 数据卷里。九阶段使用独立的 `stages.Dockerfile`，同样以 uid 1000 运行；每阶段的 `.data/`、`.runs/`、`workspace/` 挂载到 `app/../stages-data/<阶段目录>/`。代码同步只覆盖 `app/` 和 `stages/`，不会触碰 `stages-data/`。

开机自启靠一个 systemd 单元 `codex-harness.service`：开机时 `docker compose up -d --wait`，关机时 `docker compose stop`。要启动哪些可选服务写在服务器 `.env` 的 `COMPOSE_PROFILES` 里（部署时自动写入）。网关、Ollama、智能体、阶段容器与工作台异常退出后由 Docker 自动重启。阶段容器内的单个服务退出后由入口脚本以 1、2、4、8、16、30 秒退避重启；运行满一分钟后重新计数。

## 准备

服务器需要：

| 要求 | 说明 |
|---|---|
| 使用 systemd 的 Linux | Debian / Ubuntu / RHEL 系均可 |
| Docker Engine + compose v2 | 国内服务器可用云厂商的 Docker 软件源，并在 `/etc/docker/daemon.json` 配置 `registry-mirrors` 加速拉取镜像 |
| rsync | 同步代码 |
| 资源 | 九阶段：磁盘剩余 ≥ 8 GB（硬性；依赖与镜像约 3–5 GB）。可用内存 + 空闲 swap ≥ 2048 MB（硬性；九阶段空闲约 1.5–2 GB）。可用内存 < 3000 MB 只警告、不阻止部署：Ollama 加载向量模型约需 1.1 GB，内存紧张时建议不用 RAG，或用 `STAGES_MEMORY_LIMIT` 降低 stages 的 `mem_limit`（默认 `1800m`） |
| 端口 | 4317、14320、5432、6379、4330 没有被其他程序占用（都只绑定 127.0.0.1） |
| SSH | 本机能用密钥以 root 登录：`ssh-copy-id root@<服务器地址>` |

宿主不需要装 Node：一次性任务（生成网关配置、迁移数据库、准备工作区）都用 `docker compose run` 在应用镜像里跑。原有单 Agent 部署曾测得空闲内存：agent 约 150 MB、网关约 125 MB、PostgreSQL 约 30 MB、Redis 与工作台各十几 MB；Ollama 加载向量模型时约 1.1 GB，空闲 5 分钟后卸载。以上不是九阶段部署的实测结果；新组合的估算与测量方法见下文。

本机需要：已克隆的仓库、`app/.env` 里填好至少一家模型的密钥（如 `KIMI_API_KEY`）和 `CODEX_MODEL`（写成“服务商/模型名”，见 [模型网关](../docs/model-gateway.md)），以及 ssh、rsync、git、tar、Node.js 24+（用于过滤部署包）；`chat` 还要 nc。

先检查服务器，缺什么会逐项说明怎么装：

```bash
export DEPLOY_HOST=root@<服务器地址>
app/deploy/remote.sh check
```

已经部署过、端口由本项目的容器占着时不算冲突，可以放心重复检查和部署。

## 首次部署

```bash
app/deploy/remote.sh init-env   # 用本机的模型配置生成服务器 .env；数据库密码和网关访问密钥在服务器上新生成
DEPLOY_SOURCE=worktree app/deploy/remote.sh deploy  # 本次改动未提交：过滤并同步工作区 app/ 与 s03–s11，然后构建、迁移、启动
```

`init-env` 只把模型与 Agent 相关的配置（`CODEX_MODEL`、各家模型密钥、`OLLAMA_BASE_URL`、`AGENT_MEMORY_*` 等）发到服务器，本机的数据库密码、端口和网关访问密钥不会带过去；服务器上已有 `.env` 时不覆盖。国内服务器构建镜像时可以换成国内源：

```bash
NPM_REGISTRY=https://registry.npmmirror.com APT_MIRROR=http://mirrors.tencentyun.com app/deploy/remote.sh init-env
```

`init-env` 还会写入 `CONTAINER_APP_DIR`（与部署路径相同）及其同级的 `CONTAINER_STAGES_DIR`：容器里的项目路径和宿主一致，从旧服务器迁移过来的 Codex 会话记录（里面存的是绝对路径）才能接着用。

`deploy` 默认部署 **HEAD**，通过 Git 归档选定的代码文件；本次不提交代码，用 `DEPLOY_SOURCE=worktree` 部署已跟踪文件及未被 Git 忽略的新文件，版本标记带 `-worktree`。两个模式都会排除 `.env`（保留 `.env.example`）、依赖、运行数据、workspace 和常见凭据文件；只包含 app 与 s03–s11。工作区模式请在同步期间停止编辑，避免文件来自不同时间点。过滤器按路径工作，不能识别误写进普通源码的真实密钥。

可以重复部署；每次先检查服务器，再构建两个镜像，生成网关配置及阶段的模型参数清单，启动基础服务，停止 web、stages、agent，迁移 app，最后一起重建 agent、stages、web。阶段入口自动创建缺失的数据库，运行迁移，首次准备知识目录，启动九阶段并等待健康检查。`compose up --wait` 最多等 300 秒，启动失败会返回非零；看 `docker compose logs --tail 100 stages` 定位。工作台和 stages 共用 agent 的网络命名空间，重建 agent 时必须把它们一起重建。

服务器已有 `.env` 时不会被覆盖；setup 会为缺少 `CONTAINER_APP_DIR` 的旧部署补入宿主部署路径。可选 `CONTAINER_STAGES_DIR` 必须解析为 `<CONTAINER_APP_DIR>/../stages`，不一致会停止部署，避免工作台读错位置。

从旧版部署（宿主上直接跑 Node、三个 systemd 单元）升级时，`deploy` 会停用并移除旧单元、删掉宿主上的 `node_modules/`，数据卷与 `.data/` 不动；旧的运行用户 `codex` 不再使用，可以自行删除。

## 日常使用

```bash
app/deploy/remote.sh check    # 部署条件
app/deploy/remote.sh status   # 版本、各容器状态、健康检查与内存
app/deploy/remote.sh logs     # 跟随查看容器日志
app/deploy/remote.sh tunnel   # 前台隧道：浏览器打开 http://127.0.0.1:14320/
app/deploy/remote.sh chat     # 临时建隧道，用本机 CLI 连接服务器上的 Agent
app/deploy/remote.sh gateway  # 改了服务器 .env 里的模型或密钥后：重新生成网关配置、重建网关并重启智能体
```

本机隧道端口是 14317 / 14320，不占用本机运行的 4317 / 4320。工作台会校验 Host，所以服务器上的工作台端口与本机隧道端口相同（14320）。

## 注意

- 模型密钥在服务器的 `/opt/learn-codex-harness/app/.env`（权限 600）。网关容器只收到各家密钥；智能体容器读整个 `.env`，但启动 Codex 前会去掉各家密钥，Codex 只拿到网关访问密钥。更换密钥或模型后运行 `remote.sh gateway`。
- app 数据在 Docker 数据卷 `codex-harness-app_postgres-data` / `codex-harness-app_redis-data` / `codex-harness-app_ollama-data` 与部署目录的 `.data/` 里；阶段文件在同级 `stages-data/`，四个阶段数据库在同一个 PostgreSQL 卷里；不要运行 `docker compose down -v`。
- 镜像里设置了 `NODE_ENV=production`，网页工具按严格的公网地址检查运行。
- 需要从浏览器直接访问域名时，要另外配 HTTPS 与登录认证，不能直接把这些端口暴露到公网。

经 HTTPS 反向代理公开工作台时，在服务器 `.env` 设置 `WORKBENCH_PUBLIC_ORIGIN`（例如 `https://codexharness.example.com`）。代理需保留 Host 头，并应在代理层加口令。


## 九阶段配置与连接路径

在服务器 `app/.env` 配置；密钥沿用已有 `AGENT_GATEWAY_KEY` 和 `AGENT_DB_PASSWORD`，无需新增服务商密钥：

```dotenv
CODEX_MODEL=kimi/kimi-k2.7-code
# 留空启动全部；例如只启动两个阶段：STAGES=s03,s05
STAGES=
# 阶段容器内存上限，默认 1800m；内存紧张时可再调低
STAGES_MEMORY_LIMIT=1800m
```

| 阶段目录 | 回环端口 | PostgreSQL 数据库 | Redis DB |
|---|---:|---|---:|
| s03-service | 4313 | 无 | 无 |
| s04-events-messages | 4319 | 无 | 无 |
| s05-agent-assembly | 4323 | 无 | 无 |
| s06-tools | 4324 | 无 | 无 |
| s07-memory | 4325 | 无 | 无 |
| s08-data-layer | 4314 | agent_s08 | 1 |
| s09-knowledge-layer | 4315 | agent_s09 | 2 |
| s10-skill-workflow | 4316 | agent_s10 | 3 |
| s11-model-gateway | 4318 | agent_s11 | 4 |

s12、s13 使用各自独立 Compose 与数据卷，不在上面的共享 stages 容器清单中。s13 的部署与登录见 [账号与认证 README](../../stages/s13-auth/README.md)。

app 继续使用 `agent` 库与 Redis DB 0。四个阶段复用 PostgreSQL 用户 `agent`，数据库和 Redis 库提供数据分隔，不是安全租户隔离。缺失库通过阶段自己的 `pg` 依赖连接 `agent` 管理库创建；已有库不重建。每次阶段服务重启前重新运行 `data:migrate`。s10 与 s11 还会在启动服务前执行 `npm run agent:init`：该脚本只创建配置声明的缺失资料目录，不覆盖已有文件，因此每次启动都执行，失败则不启动该阶段。s09–s11 的 `knowledge:init` 成功后在各自 `workspace/.stages-knowledge-initialized` 写标记，避免重复覆盖 s09 的知识 Skill；删除 workspace 或恢复不带该标记的 workspace 会使首次初始化重新执行。升级知识模板需先停 stages，人工核对并合并已有 Skill，再删除相应标记并重启。`agent:init` 不使用该标记。

代码已确认：阶段的 `shared/paths.mjs` 从自身文件位置推导根目录，生命周期模块写 `<阶段根>/.data/connection.json`，与进程 cwd 无关。默认绑定的工作区也在 `<阶段根>/workspace`。例如 s03 的路径对应关系为：

- 宿主持久文件：`<部署根>/stages-data/s03-service/.data/connection.json`。
- stages 容器写入：`<CONTAINER_STAGES_DIR>/s03-service/.data/connection.json`。
- web 容器只读：`<CONTAINER_APP_DIR>/../stages/s03-service/.data/connection.json`。

三者指向同一宿主文件；容器均以 uid 1000 运行，因此能读取阶段写出的 0600 令牌文件。阶段只监听 127.0.0.1，stages、agent、web 共用网络，工作台可直接使用连接文件里的回环 URL。web 不需要阶段源码，只需要这九个只读 `.data` 挂载。`STAGES` 未选中的目标仍会出现在工作台中，但不在线；健康检查只检查选中的阶段。

部署入口 `app/deploy/run-stages.mjs` 使用 Node 内置 `net` 启动 TCP 转发器，固定监听 `127.0.0.1:4331`，逐连接原样转发到 `gateway:8080`。双向 `pipe` 保留背压、半关闭及流式响应，不解析或改写 HTTP；连接错误记录方向与错误码并关闭两端，不输出请求或密钥。s03–s10 传入 `CODEX_BASE_URL=http://127.0.0.1:4331/v1`、`CODEX_API_KEY=<网关访问密钥>`，使用教学代码原有的回环地址校验。`stages/` 的教学源码、README 与课程摘录均不修改。

转发器监听就绪后才启动阶段子进程（包括建库、迁移、s10/s11 的资料目录初始化与知识初始化）。监听失败（包括端口占用）直接使入口以状态 1 退出；运行中监听器报错或意外关闭时，入口禁止阶段重启、关闭全部阶段与转发连接，再以状态 1 退出，由 Compose 的 `restart: unless-stopped` 重启容器。单条上游连接失败只关闭该连接，后续连接仍会重新连接网关。SIGTERM/SIGINT 正常关闭时不算故障。

端口核对：agent 固定使用 4317，九阶段使用表中 4313–4325 范围内的独立端口，web 使用 14320；4331 均不与之重叠。4330 是 gateway 发布在宿主的端口，其容器内监听 8080，使用独立网络命名空间。4331 只存在于 agent/stages/web 共享的网络命名空间，不增加宿主映射；无需新增 SSH 隧道。MCP 使用系统分配端口，阶段启动前先占住 4331；若共享网络中已有其他进程占用 4331，启动会报 `EADDRINUSE`，不会静默换端口。

s11 使用其原有网关模式：仅设置 `AGENT_GATEWAY_URL=http://127.0.0.1:4331/v1` 与 `AGENT_GATEWAY_KEY`，不同时传 `CODEX_BASE_URL / CODEX_API_KEY`，否则它会拒绝启动。其启动模块随后自动为 Codex 转换出这两项。预算变量均不传，使用默认不限额、不降级。

s11 的路由还要求服务商 `keyEnv / baseUrlEnv` 非空。`stages-config.mjs` 在 app 一次性容器中，根据真实部署配置生成 `.data/stages/config.json`：仅存 `CODEX_MODEL_*` 参数与已启用服务商 ID。stages 只读挂载这个目录；s11 子进程根据自身模型清单生成 `managed-by-existing-gateway` 等非密钥标记。真实服务商密钥不会进入阶段容器，阶段内不运行 `gateway:config`，不启动第二个网关。若 app 与 s11 模型清单不一致、模型未登记或服务商未启用，s11 可能无法选模型，需核对两份清单及现有网关配置。

## 服务器命令与验收

日常代码发布仍从仓库根运行：

```bash
# 第一次验收这批未提交的文件
DEPLOY_SOURCE=worktree app/deploy/remote.sh deploy
app/deploy/remote.sh status
app/deploy/remote.sh tunnel

# 日后代码进入 HEAD 后，默认只部署 HEAD
app/deploy/remote.sh deploy
```

如已通过其他方式把过滤后的 `app/` 与九阶段 `stages/` 放到服务器，首次或升级时在服务器执行以下命令。部署路径可换成自己的位置；已有 `.env` 必须保留，不用阶段的 `.env.example` 覆盖它：

```bash
export APP_DIR=/opt/learn-codex-harness/app
cd "$APP_DIR"
# 先检查 .env 中 CODEX_MODEL、AGENT_GATEWAY_KEY、AGENT_DB_PASSWORD 已配置。
# 阶段参数只在 app/.env 配置，不在 stages/ 中放 .env。
bash deploy/check.sh
docker compose --profile app config --quiet
bash deploy/server-setup.sh
```

`server-setup.sh` 以 root 执行，准备所有持久目录并赋给 uid 1000，构建镜像、执行初始化、安装 systemd。数据库 `agent` 用户必须有 CREATEDB 权限（当前 postgres 镜像的初始化用户满足；外部恢复的数据库请核实）。首次部署阶段不会自动导入其他机器的历史数据。

服务器侧验收：

```bash
cd "$APP_DIR"
docker compose ps
docker compose exec -T stages node /opt/stages-deploy/run-stages.mjs --health
docker compose logs --tail 100 stages
docker stats --no-stream
# 以下只输出文件是否存在及连接地址，不输出令牌。
docker compose exec -T web node --input-type=module -e '
  import fs from "node:fs";
  import { defaultTargets } from "./web/server.mjs";
  for (const t of defaultTargets.filter(t => /^s(0[3-9]|1[01])$/.test(t.id))) {
    try { const c = JSON.parse(fs.readFileSync(t.root + "/.data/connection.json")); console.log(t.id, c.url); }
    catch { console.log(t.id, "连接文件尚未生成"); }
  }'
# 重启后仍应全部 ready；工作区、会话和数据库保留。
docker compose restart stages
docker compose up -d --wait --wait-timeout 300 stages
```

验收标准：默认九行 `/health` 均为 `ready`，web 能读到九个预期端口；通过 SSH 隧道打开工作台，逐个选择 s03–s11，读取状态并发送一个简单问题，确认真实 Responses 请求能完成。s08–s11 查看数据与队列状态，s09–s11 再验证知识目录。然后重启 stages，确认历史与 workspace 保留、初始化不重复写入。健康检查只证明服务自身就绪，不证明供应商额度、外网访问或实际模型响应成功。

日常更改模型、服务商密钥或 `CODEX_MODEL_*` 后，在本机运行 `remote.sh gateway`；它会重新生成两份配置并重建 gateway、agent、stages、web，不能仅 `restart` 来更新容器环境。只更改 `STAGES` 或 `STAGES_MEMORY_LIMIT` 时，可在服务器执行：

```bash
docker compose up -d --wait --wait-timeout 300 --force-recreate stages
```

重建 agent 时必须一起重建共享网络的容器：

```bash
docker compose stop web stages agent
docker compose up -d --wait --wait-timeout 300 --force-recreate agent stages web
```

## 资源、恢复与验证边界

九阶段依赖与镜像约 3–5 GB，部署前硬性要求磁盘剩余 ≥ 8 GB。九阶段空闲内存约 1.5–2 GB；硬性要求可用内存 + 空闲 swap ≥ 2048 MB。可用内存 < 3000 MB 时只打印警告、不阻止部署：Ollama 加载向量模型约需 1.1 GB，内存紧张时建议不用 RAG，或把 `STAGES_MEMORY_LIMIT` 调低。stages 的 `mem_limit` 默认 `1800m`（可用 `STAGES_MEMORY_LIMIT` 覆盖），这是容器总上限，不是内存预留。以上是容量规划估算，尚未在服务器测量；并发、历史与工具进程可能使上限不足，应在真实任务中用 `docker stats` 记录峰值后再调。

默认资源检查按九阶段计算，即使只启用部分阶段也不自动降低门槛。Docker 不会仅因 `unhealthy` 自动重启容器；正常子进程退出由 supervisor 重试，卡住但未退出的服务可能需要 `docker compose restart stages`。SIGTERM 先禁止所有阶段重启，再按 s11→s03 顺序关闭，每阶段最多等 10 秒后清理进程组，compose 总宽限 120 秒。正在执行的任务会被中断。

持久锁包含旧容器 PID。入口在任何阶段子进程启动前按 Linux `/proc/<pid>/cwd` 检查：不存在或已被其他阶段复用则清理旧锁，同一阶段仍有活进程或权限不足则停止。只运行一个 stages 容器，不要扩容或让其他部署挂载同一组 `stages-data`。备份时应一并备份 `stages-data` 和 PostgreSQL/Redis 数据；数据库迁移没有自动回滚，回退镜像前要核对 schema 兼容性。

部署测试命令（只使用假上游，不调用真实模型；TCP 测试需要允许本机监听端口）：

```bash
npm --prefix app run test:deploy
bash -n app/deploy/remote.sh app/deploy/server-setup.sh app/deploy/check.sh
```

新增测试也由现有 `npm test` 的 `tests/*.test.mjs` 自动收集。本次沙箱禁止监听端口：TCP 测试已保留在默认入口中，执行时返回 `listen EPERM`，需在沙箱外运行上述完整命令。可在沙箱内用 `node --test --test-skip-pattern='^TCP' app/tests/deploy.test.mjs app/tests/stages-deploy.test.mjs` 验证其余用例（从仓库根运行）。没有运行 Docker 或完整 `npm test`。Compose 挂载关系、固定端口及配置文本由单元测试检查；实际 Compose 展开、镜像拉取/构建、DNS、UID 权限、数据库迁移和真实模型调用须在服务器按上文验收。

[s12 部署单元](../../stages/s12-deploy/README.md) 自带完整 Compose，通过 SSH 隧道连接，不加入本说明的共享 stages 容器。
