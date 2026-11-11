import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const app = path.resolve(import.meta.dirname, "..");
const bash = "/bin/bash";

// 假命令整个文件只写一次（macOS 首次执行新写出的脚本要做安全扫描，每个约半秒），各用例用符号链接挑选。
const stubs = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-stubs-"));
after(() => fs.rmSync(stubs, { recursive: true, force: true }));
function stub(name, body) { fs.writeFileSync(path.join(stubs, name), `#!${bash}\n${body}\n`, { mode: 0o755 }); }

// PATH 里只放脚本用到的真实命令和选中的假命令，没放进去的就算"服务器上没装"。
function sandbox(t, names, tools = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const tool of ["grep", "head", "tail", "tr", "cut", "awk", "cat", "dirname", "sed", ...tools]) {
    const real = ["/usr/bin", "/bin"].map(base => path.join(base, tool)).find(file => fs.existsSync(file));
    assert.ok(real, `测试机缺少 ${tool}`);
    fs.symlinkSync(real, path.join(bin, tool));
  }
  for (const name of names) fs.symlinkSync(path.join(stubs, name), path.join(bin, name));
  return { dir, bin };
}
function run(script, args, bin, env = {}) {
  const result = spawnSync(bash, [script, ...args], { encoding: "utf8", env: { PATH: bin, LANG: "C.UTF-8", ...env } });
  return { code: result.status, out: result.stdout + result.stderr };
}

const server = {
  systemctl: "exit 0",
  docker: `case "$1" in
    info) exit "\${DOCKER_DOWN:-0}" ;;
    version) echo 27.3.1 ;;
    compose) [ -n "$NO_COMPOSE" ] && exit 1; echo "Docker Compose version v2.29.7" ;;
    ps) echo "$COMPOSE_PORTS" ;;
  esac`,
  node: `case "$1" in -p) echo "\${NODE_MAJOR:-24}" ;; -v) echo "v\${NODE_MAJOR:-24}.11.0" ;; esac`,
  rsync: "exit 0",
  df: `printf 'Avail\\n  %sG\\n' "\${DISK_GB:-28}"`,
  free: `printf '              total used free shared buff/cache available\\nMem: 3800 600 1200 10 2000 %s\\nSwap: %s 0 %s\\n' "\${MEM_MB:-3200}" "\${SWAP_MB:-0}" "\${SWAP_MB:-0}"`,
  // PORTS="5432=postgres 4317=MainThread"：被占用的端口与进程名；PID 就用端口号。
  ss: `port=\${2##*:}
  for pair in $PORTS; do
    [ "\${pair%%=*}" = "$port" ] && echo "LISTEN 0 4096 127.0.0.1:$port 0.0.0.0:* users:((\\"\${pair#*=}\\",pid=$port,fd=3))"
  done; exit 0`,
  // UNITS="4317=codex-harness.service"：PID 所属的 systemd 单元。
  ps: `for pair in $UNITS; do [ "\${pair%%=*}" = "$4" ] && echo "\${pair#*=}"; done; exit 0`
};
for (const [name, body] of Object.entries(server)) stub(name, body);
const all = Object.keys(server);
// 服务器上已经部署过：全部服务在本项目的容器里，端口都由容器发布（docker-proxy）。
const deployed = {
  PORTS: "4317=docker-proxy 14320=docker-proxy 5432=docker-proxy 6379=docker-proxy 4330=docker-proxy",
  COMPOSE_PORTS: "127.0.0.1:4317->4317/tcp, 127.0.0.1:14320->14320/tcp\n127.0.0.1:5432->5432/tcp\n127.0.0.1:6379->6379/tcp\n127.0.0.1:4330->8080/tcp"
};
const check = path.join(app, "deploy/check.sh");

test("部署前检查：条件齐全时通过；本服务自己占着端口（重复部署）不算冲突", t => {
  const { bin } = sandbox(t, all);
  const fresh = run(check, [], bin);
  assert.equal(fresh.code, 0, fresh.out);
  assert.doesNotMatch(fresh.out, /Node\.js/, "全部服务在容器里，宿主不需要 Node");
  assert.match(fresh.out, /服务器满足部署条件/);
  assert.doesNotMatch(fresh.out, /✗/);

  const redeploy = run(check, [], bin, deployed);
  assert.equal(redeploy.code, 0, redeploy.out);
});

test("部署前检查：端口被别的程序或别的项目的容器占着才算冲突", t => {
  const { bin } = sandbox(t, all);
  const other = run(check, [], bin, { ...deployed, PORTS: deployed.PORTS.replace("14320=docker-proxy", "14320=MainThread"), UNITS: "6379=codex-harness.service",
    COMPOSE_PORTS: "127.0.0.1:6379->6379/tcp" });
  assert.equal(other.code, 1);
  assert.match(other.out, /端口 14320 被 MainThread（PID 14320）占用/);
  assert.match(other.out, /端口 5432 被 docker-proxy（PID 5432）占用/);
  assert.match(other.out, /端口 4330 被 docker-proxy（PID 4330）占用/, "模型网关的端口也要检查");
  assert.doesNotMatch(other.out, /端口 6379/);
});

test("部署前检查：逐项说明缺什么、怎么处理，而不是部署到一半失败", t => {
  const { dir, bin } = sandbox(t, all.filter(name => !["systemctl", "docker", "rsync"].includes(name)));
  // 启用本地向量模型不再抬高磁盘和内存门槛。磁盘仍须 ≥ 8 GB；内存加 swap 不足 2048 MB 才失败。
  fs.writeFileSync(path.join(dir, ".env"), "OLLAMA_BASE_URL=http://ollama:11434\n");
  const result = run(check, [], bin, { COURSE_DIR: dir, DISK_GB: "7", MEM_MB: "1200", PORTS: "5432=postgres" });
  assert.equal(result.code, 1);
  for (const expected of [/没有 systemd/, /没有 Docker\n.*docs\.docker\.com\/engine\/install.*registry-mirrors/,
    /没有 rsync/, /磁盘剩余 7 GB\n.*至少需要 8 GB/, /可用内存 1200 MB.*\n.*2048 MB/, /端口 5432 被 postgres（PID 5432）占用/]) {
    assert.match(result.out, expected);
  }
  assert.doesNotMatch(result.out, /满足部署条件|至少需要 20 GB|至少需要 3200 MB/);
});

test("部署前检查：九阶段磁盘至少 8 GB；可用内存加空闲 swap 至少 2048 MB，低于 3000 MB 只警告", t => {
  const { dir, bin } = sandbox(t, all);
  // 4 GB 机器：可用约 2.7 GB，另有 2 GB swap。合计超过 2048 MB，只警告，不阻止部署。
  const tight = run(check, [], bin, { COURSE_DIR: dir, DISK_GB: "8", MEM_MB: "2700", SWAP_MB: "2048" });
  assert.equal(tight.code, 0, tight.out);
  assert.match(tight.out, /服务器满足部署条件/);
  assert.match(tight.out, /可用内存 2700 MB.*\n.*Ollama 加载向量模型约需 1\.1 GB/);
  assert.match(tight.out, /不用 RAG/);
  assert.match(tight.out, /mem_limit/);
  assert.doesNotMatch(tight.out, /✗/);

  const swapCovers = run(check, [], bin, { COURSE_DIR: dir, DISK_GB: "8", MEM_MB: "1500", SWAP_MB: "548" });
  assert.equal(swapCovers.code, 0, swapCovers.out);
  assert.match(swapCovers.out, /空闲 swap 548 MB/);

  const noSwapButEnough = run(check, [], bin, { COURSE_DIR: dir, DISK_GB: "16", MEM_MB: "2400" });
  assert.equal(noSwapButEnough.code, 0, noSwapButEnough.out);
  assert.match(noSwapButEnough.out, /1\.1 GB/);

  const comfortable = run(check, [], bin, { COURSE_DIR: dir, DISK_GB: "8", MEM_MB: "3000" });
  assert.equal(comfortable.code, 0, comfortable.out);
  assert.doesNotMatch(comfortable.out, /Ollama|1\.1/);

  const tiny = run(check, [], bin, { COURSE_DIR: dir, DISK_GB: "4", MEM_MB: "600" });
  assert.notEqual(tiny.code, 0);
  assert.match(tiny.out, /磁盘剩余 4 GB\n.*至少需要 8 GB/);
  assert.match(tiny.out, /可用内存 600 MB.*\n.*2048 MB/);
  assert.doesNotMatch(tiny.out, /Ollama/);

  const swapShort = run(check, [], bin, { COURSE_DIR: dir, DISK_GB: "8", MEM_MB: "1500", SWAP_MB: "547" });
  assert.notEqual(swapShort.code, 0);
  assert.match(swapShort.out, /空闲 swap 547 MB\n.*2048 MB/);

  fs.writeFileSync(path.join(dir, ".env"), "OLLAMA_BASE_URL=http://ollama:11434\n");
  const ollama = run(check, [], bin, { COURSE_DIR: dir, DISK_GB: "8", MEM_MB: "2700", SWAP_MB: "2048" });
  assert.equal(ollama.code, 0, ollama.out);
  assert.doesNotMatch(ollama.out, /至少需要 20 GB|至少需要 3200 MB/);
});

test("部署前检查：没有 free 命令时改读 /proc/meminfo，读不到就跳过内存一项，不报出“? MB”", t => {
  const { bin } = sandbox(t, all.filter(name => name !== "free"));
  const result = run(check, [], bin);
  assert.doesNotMatch(result.out, /可用内存 \?/);
  if (fs.existsSync("/proc/meminfo")) assert.match(result.out, /可用内存 \d+ MB/);
  else assert.doesNotMatch(result.out, /可用内存/);
});

test("部署前检查：Docker 装了但守护进程没运行、缺 compose v2", t => {
  const { bin } = sandbox(t, all);
  const result = run(check, [], bin, { DOCKER_DOWN: "1", NO_COMPOSE: "1" });
  assert.equal(result.code, 1);
  assert.match(result.out, /Docker 守护进程没有运行\n.*systemctl enable --now docker/);
  assert.match(result.out, /缺少 docker compose v2/);
});

// 假 ssh：记录每条远程命令；init-env 写 .env 时把管道内容存下来，检查到底发了什么到服务器。
stub("ssh", `cmd="\${@: -1}"; echo "$cmd" >> "$LOG"
case "$cmd" in
  true) exit "\${SSH_FAIL:-0}" ;;
  "test -e"*) exit "\${ENV_EXISTS:-1}" ;;
  "test -f"*) exit "\${OLD_ENV_EXISTS:-1}" ;;
  *) cat > "$SENT" ;;
esac`);
function initEnv(t, envFile, env = {}) {
  const { dir, bin } = sandbox(t, ["ssh"]);
  fs.mkdirSync(path.join(dir, "course/deploy"), { recursive: true });
  fs.copyFileSync(path.join(app, "deploy/remote.sh"), path.join(dir, "course/deploy/remote.sh"));
  if (envFile !== undefined) fs.writeFileSync(path.join(dir, "course/.env"), envFile);
  const log = path.join(dir, "ssh.log"), sent = path.join(dir, "sent");
  const result = run(path.join(dir, "course/deploy/remote.sh"), ["init-env"], bin, { DEPLOY_HOST: "root@example.com", LOG: log, SENT: sent, ...env });
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { ...result, commands: read(log), sent: read(sent) };
}
const local = [
  "KIMI_API_KEY=sk-local-kimi", "DEEPSEEK_API_KEY=sk-local-deepseek", "CODEX_MODEL=kimi/kimi-k2.7-code", "CODEX_MODEL_CONTEXT_WINDOW=200000",
  "AGENT_GATEWAY_KEY=sk-bf-local-gateway", "CODEX_API_KEY=sk-old-direct", "EMBEDDING_API_KEY=sk-embedding", "OLLAMA_BASE_URL=http://ollama:11434",
  "AGENT_MEMORY_ENABLED=true", "DEMO_TIMEOUT_MS=90000",
  "AGENT_DB_PASSWORD=local-db-password", "DATABASE_URL=postgresql://agent:local-db-password@127.0.0.1:55432/agent",
  "REDIS_URL=redis://127.0.0.1:56379/0", "AGENT_PG_PORT=55432", ""
].join("\n");

test("init-env：只把模型、各家密钥与 Agent 配置发到服务器；本机数据库配置与网关访问密钥不外传，服务器上新生成", t => {
  const result = initEnv(t, local);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /已生成服务器/);
  for (const line of ["KIMI_API_KEY=sk-local-kimi", "DEEPSEEK_API_KEY=sk-local-deepseek", "CODEX_MODEL=kimi/kimi-k2.7-code", "CODEX_MODEL_CONTEXT_WINDOW=200000", "AGENT_MEMORY_ENABLED=true", "DEMO_TIMEOUT_MS=90000"]) {
    assert.ok(result.sent.includes(line), line);
  }
  assert.doesNotMatch(result.sent, /local-db-password|DATABASE_URL|REDIS_URL|AGENT_PG_PORT|55432/);
  assert.doesNotMatch(result.sent, /sk-bf-local-gateway|CODEX_API_KEY|sk-embedding/, "网关访问密钥在服务器上新生成；直连密钥与网关模式冲突，不带过去");
  assert.doesNotMatch(result.out, /sk-local-kimi/);
  assert.match(result.commands, /umask 077/);
  assert.match(result.commands, /\/dev\/urandom/);
  assert.match(result.commands, /AGENT_GATEWAY_KEY=sk-bf-%s/);
  // 容器里的项目路径与部署路径相同（迁移来的 Codex 历史记录路径不变）；本机启用了本地向量模型就一并带上；没指定镜像源就不写。
  assert.ok(result.sent.includes("CONTAINER_STAGES_DIR=/opt/learn-codex-harness/stages"));
  assert.ok(result.sent.includes("OLLAMA_BASE_URL=http://ollama:11434"));
  assert.doesNotMatch(result.sent, /NPM_REGISTRY|APT_MIRROR/);
  const mirrored = initEnv(t, local, { NPM_REGISTRY: "https://registry.npmmirror.com", APT_MIRROR: "http://mirrors.tencentyun.com" });
  assert.ok(mirrored.sent.includes("NPM_REGISTRY=https://registry.npmmirror.com") && mirrored.sent.includes("APT_MIRROR=http://mirrors.tencentyun.com"), "国内服务器可以指定镜像源");
});

test("init-env：本机配置不完整时在连服务器之前就停下；服务器已有 .env 时不覆盖", t => {
  const noKeys = initEnv(t, local.replace("KIMI_API_KEY=sk-local-kimi", "KIMI_API_KEY=").replace("DEEPSEEK_API_KEY=sk-local-deepseek", 'DEEPSEEK_API_KEY=""'));
  assert.equal(noKeys.code, 1);
  assert.match(noKeys.out, /没有任何模型服务商的密钥/);
  assert.equal(noKeys.commands, "");

  for (const model of ['CODEX_MODEL=""', "CODEX_MODEL=kimi-k2.7-code"]) {
    const bad = initEnv(t, local.replace("CODEX_MODEL=kimi/kimi-k2.7-code", model));
    assert.equal(bad.code, 1, model);
    assert.match(bad.out, /服务商\/模型名/);
    assert.equal(bad.commands, "");
  }

  const missing = initEnv(t, undefined);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /本机没有 .*\.env/);

  const exists = initEnv(t, local, { ENV_EXISTS: "0" });
  assert.equal(exists.code, 0);
  assert.match(exists.out, /未覆盖/);
  assert.equal(exists.sent, "");
});

test("init-env：服务器上有旧结构的 app/.env 时直接沿用，不重新生成数据库密码与网关密钥", t => {
  const upgraded = initEnv(t, local, { OLD_ENV_EXISTS: "0" });
  assert.equal(upgraded.code, 0, upgraded.out);
  assert.match(upgraded.out, /已从旧部署复制/);
  assert.match(upgraded.commands, /cp '\/opt\/learn-codex-harness\/app\/\.env' '\/opt\/learn-codex-harness\/course\/\.env'/);
  assert.doesNotMatch(upgraded.commands, /\/dev\/urandom/, "不生成新密码");
  assert.doesNotMatch(upgraded.sent, /sk-local-kimi/, "本机密钥不发往服务器");
});

test("init-env：SSH 密钥登录不通时给出 ssh-copy-id 提示", t => {
  const result = initEnv(t, local, { SSH_FAIL: "255" });
  assert.equal(result.code, 1);
  assert.match(result.out, /无法用 SSH 密钥登录 root@example\.com；先运行 ssh-copy-id/);
  assert.equal(result.sent, "");
});

// 假 systemctl / docker / chown：只记录调用顺序。docker 里列出 Ollama 模型时回一个模型名，健康检查直接算通过。
stub("systemctl", `echo "systemctl $*" >> "$LOG"`);
stub("chown", `echo "chown $*" >> "$LOG"`);
stub("docker-setup", `echo "docker $*" >> "$LOG"
case "$*" in *"ollama-pull.mjs --list"*) echo "qwen3-embedding:0.6b" ;; esac
case "$*" in "ps -aq "*"com.docker.compose.service=agent"*) [ -n "$OLD_AGENT" ] && echo "$OLD_AGENT" ;; esac; exit 0`);

test("server-setup：全部服务用 Docker 起；先生成网关配置，重建前停掉阶段与工作台，最后装开机单元并等健康检查", t => {
  const { dir, bin } = sandbox(t, ["systemctl", "chown"], ["chmod", "paste", "seq", "sleep", "mkdir"]);
  fs.symlinkSync(path.join(stubs, "docker-setup"), path.join(bin, "docker"));
  const target = path.join(dir, "course"), units = path.join(dir, "units"), log = path.join(dir, "calls.log");
  fs.cpSync(path.join(app, "deploy"), path.join(target, "deploy"), { recursive: true });
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(target, ".env"), "CODEX_MODEL=kimi/kimi-k2.7-code\nOLLAMA_BASE_URL=http://ollama:11434\n");
  fs.writeFileSync(path.join(target, "REVISION"), "abc1234\n");

  const result = run(path.join(target, "deploy/server-setup.sh"), [], bin, { COURSE_DIR: target, UNIT_DIR: units, LOG: log });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /就绪：abc1234/);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  const at = pattern => {
    const index = calls.findIndex(call => pattern.test(call));
    assert.notEqual(index, -1, `没有调用 ${pattern}：\n${calls.join("\n")}`);
    return index;
  };
  assert.match(calls[at(/^chown/)], /^chown -R 1000:1000 \.data$/, "容器里以 node（uid 1000）运行");
  assert.ok(at(/^docker compose build web stages$/) < at(/node \/opt\/stages-deploy\/gateway-config\.mjs/));
  assert.match(calls[at(/node \/opt\/stages-deploy\/gateway-config\.mjs/)], /^docker compose -f compose.yaml -f deploy\/tasks.compose.yaml run --rm --no-deps -T tasks node/, "一次性任务在镜像里跑，宿主不需要 Node");
  assert.ok(at(/node \/opt\/stages-deploy\/gateway-config\.mjs/) < at(/^docker compose up -d --wait --force-recreate gateway$/), "先生成配置，再重建网关");
  assert.ok(at(/^docker compose up -d --wait ollama$/) < at(/ollama pull qwen3-embedding:0\.6b/));
  const stop = at(/^docker compose stop stages web$/);
  assert.ok(stop < at(/^docker compose up -d --wait --wait-timeout 300 --force-recreate web stages$/), "阶段入口在停服后运行迁移与初始化");
  assert.ok(at(/^docker compose exec -T ollama ollama pull qwen3-embedding:0\.6b$/) < at(/^docker compose up -d --wait --wait-timeout 300 --force-recreate web stages$/));
  assert.ok(at(/^docker compose up -d --wait --wait-timeout 300 --force-recreate web stages$/) < at(/^systemctl enable -q codex-harness\.service$/));
  assert.ok(at(/^systemctl daemon-reload$/) < at(/^systemctl start codex-harness\.service$/));
  // 健康检查的脚本有多行，日志里跨行，所以从这一行往后找 /health。
  assert.match(calls.slice(at(/^docker compose exec -T web node -e/)).join("\n"), /\/api\/bootstrap/, "在工作台容器里做健康检查");
  const env = fs.readFileSync(path.join(target, ".env"), "utf8");
  assert.match(env, /^COMPOSE_PROFILES=app,embedding$/m, "开机单元靠 COMPOSE_PROFILES 带上智能体与本地向量模型");
  assert.equal(fs.statSync(path.join(target, ".env")).mode & 0o777, 0o600);

  // 只装一个开机单元；docker 与部署目录换成这台服务器上的实际路径。
  assert.deepEqual(fs.readdirSync(units), ["codex-harness.service"]);
  const unit = fs.readFileSync(path.join(units, "codex-harness.service"), "utf8");
  assert.match(unit, new RegExp(`^ExecStart=${bin}/docker compose -f ${target}/compose.yaml up -d --wait$`, "m"));
  assert.match(unit, new RegExp(`^ExecStop=${bin}/docker compose -f ${target}/compose.yaml stop$`, "m"));
  assert.match(unit, new RegExp(`^WorkingDirectory=${target}$`, "m"));

  // 重复部署不重复追加 COMPOSE_PROFILES；没启用 Ollama 时不起它、也不下载模型。
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(target, ".env"), "CODEX_MODEL=kimi/kimi-k2.7-code\n");
  assert.equal(run(path.join(target, "deploy/server-setup.sh"), [], bin, { COURSE_DIR: target, UNIT_DIR: units, LOG: log }).code, 0);
  assert.match(fs.readFileSync(path.join(target, ".env"), "utf8"), /^COMPOSE_PROFILES=app$/m);
  assert.doesNotMatch(fs.readFileSync(log, "utf8"), /ollama/);
  assert.equal(run(path.join(target, "deploy/server-setup.sh"), [], bin, { COURSE_DIR: target, UNIT_DIR: units, LOG: log }).code, 0);
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8").match(/^COMPOSE_PROFILES=/gm).length, 1);
  assert.doesNotMatch(fs.readFileSync(log, "utf8"), /disable/, "已经是容器部署时不碰开机单元的启停状态");
});

test("server-setup：旧结构的 agent 容器占着工作台端口，启动新服务前只删除这一个容器，不动数据卷；不存在时跳过", t => {
  const { dir, bin } = sandbox(t, ["systemctl", "chown"], ["chmod", "paste", "seq", "sleep", "mkdir"]);
  fs.symlinkSync(path.join(stubs, "docker-setup"), path.join(bin, "docker"));
  const target = path.join(dir, "course"), units = path.join(dir, "units"), log = path.join(dir, "calls.log");
  fs.cpSync(path.join(app, "deploy"), path.join(target, "deploy"), { recursive: true });
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(target, ".env"), "CODEX_MODEL=kimi/kimi-k2.7-code\n");
  fs.writeFileSync(path.join(target, "REVISION"), "abc1234\n");
  assert.equal(run(path.join(target, "deploy/server-setup.sh"), [], bin, { COURSE_DIR: target, UNIT_DIR: units, LOG: log, OLD_AGENT: "0ldagent1d" }).code, 0);
  let calls = fs.readFileSync(log, "utf8").trim().split("\n");
  const query = calls.findIndex(c => /^docker ps -aq --filter label=com\.docker\.compose\.project=codex-harness-app --filter label=com\.docker\.compose\.service=agent$/.test(c));
  const detach = calls.indexOf("docker compose rm -f stages web");
  const stopOld = calls.indexOf("docker compose stop stages web");
  const remove = calls.indexOf("docker rm -f 0ldagent1d");
  assert.ok(stopOld !== -1 && detach > stopOld && remove > detach, `先停并移除依附 agent 网络的旧 stages/web，再删 agent：\n${calls.join("\n")}`);
  const start = calls.indexOf("docker compose up -d --wait --wait-timeout 300 --force-recreate web stages");
  assert.ok(query !== -1 && remove > query && start > remove, `先查询、再删除旧 agent、最后启动新服务：\n${calls.join("\n")}`);
  assert.doesNotMatch(calls.join("\n"), /\brm -f -v\b|\bvolume\b|down -v/, "不删除任何数据卷");
  fs.writeFileSync(log, "");
  assert.equal(run(path.join(target, "deploy/server-setup.sh"), [], bin, { COURSE_DIR: target, UNIT_DIR: units, LOG: log }).code, 0);
  calls = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.ok(!calls.some(c => /^docker rm |^docker compose rm /.test(c)), "没有旧容器时不执行删除");
});

test("server-setup：从旧版部署（宿主 Node + 三个单元）升级时先停用并移除旧单元，再用容器启动", t => {
  const { dir, bin } = sandbox(t, ["systemctl", "chown"], ["chmod", "paste", "seq", "sleep", "mkdir", "rm"]);
  fs.symlinkSync(path.join(stubs, "docker-setup"), path.join(bin, "docker"));
  const target = path.join(dir, "course"), units = path.join(dir, "units"), log = path.join(dir, "calls.log");
  fs.cpSync(path.join(app, "deploy"), path.join(target, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(target, "node_modules/x"), { recursive: true });
  fs.mkdirSync(units);
  for (const unit of ["codex-harness.service", "codex-harness-db.service", "codex-harness-web.service"]) fs.writeFileSync(path.join(units, unit), "[Service]\nExecStart=/usr/bin/node server/main.mjs\n");
  fs.writeFileSync(path.join(target, ".env"), "CODEX_MODEL=kimi/kimi-k2.7-code\n");

  const result = run(path.join(target, "deploy/server-setup.sh"), [], bin, { COURSE_DIR: target, UNIT_DIR: units, LOG: log });
  assert.equal(result.code, 0, result.out);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  const disable = calls.indexOf("systemctl disable -q --now codex-harness-web.service codex-harness.service codex-harness-db.service");
  assert.notEqual(disable, -1, calls.join("\n"));
  assert.ok(disable < calls.indexOf("docker compose up -d --wait postgres redis"), "旧进程占着端口，要先停");
  assert.deepEqual(fs.readdirSync(units), ["codex-harness.service"]);
  assert.match(fs.readFileSync(path.join(units, "codex-harness.service"), "utf8"), /docker compose -f .* up -d --wait/, "同名单元换成容器版");
  assert.ok(fs.existsSync(path.join(target, "node_modules")), "旧目录原样保留");
});


test("部署脚本登记清单中每家服务商的密钥变量", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(app, "../stages/s11-model-gateway/config/models.json"), "utf8"));
  const remote = fs.readFileSync(path.join(app, "deploy/remote.sh"), "utf8");
  const listed = remote.match(/^PROVIDER_KEYS='([^']+)'/m)[1].split("|");
  const keys = Object.values(registry.providers).map(provider => provider.keyEnv).filter(Boolean);
  assert.deepEqual(listed.sort(), keys.sort());
});

test('remote deploy 迁移：两次执行只补缺失文件，旧数据与卷保留；旧 Agent 留给 server-setup 处理', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'app'), target = path.join(root, 'course');
  fs.mkdirSync(path.join(old, '.data/gateway'), { recursive: true });
  fs.writeFileSync(path.join(old, '.env'), 'AGENT_GATEWAY_KEY=fixture-preserved\n', { mode: 0o644 });
  fs.writeFileSync(path.join(old, '.data/gateway/config.json'), '{"fixture":"old"}');
  fs.writeFileSync(path.join(old, '.data/keep'), 'old data');
  const remote = fs.readFileSync(path.join(app, 'deploy/remote.sh'), 'utf8');
  const blocks = [...remote.matchAll(/remote "(set -eu\n[\s\S]*?)"/g)].map(match => match[1]
    .replaceAll('$COURSE_DIR', target).replaceAll('$DEPLOY_DIR', root));
  assert.equal(blocks.length, 1);
  const execute = (code, env = {}) => {
    const result = spawnSync(bash, ['-c', code], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  execute(blocks[0]);
  assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), fs.readFileSync(path.join(old, '.env'), 'utf8'));
  assert.equal(fs.statSync(path.join(target, '.env')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(target, '.data/gateway/config.json'), 'utf8'), '{"fixture":"old"}');
  fs.writeFileSync(path.join(target, '.env'), 'new configuration');
  fs.writeFileSync(path.join(target, '.data/gateway/config.json'), 'new gateway');
  execute(blocks[0]);
  assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'new configuration');
  assert.equal(fs.readFileSync(path.join(target, '.data/gateway/config.json'), 'utf8'), 'new gateway');
  assert.equal(fs.readFileSync(path.join(old, '.data/keep'), 'utf8'), 'old data');
  assert.equal(fs.readFileSync(path.join(old, '.data/gateway/config.json'), 'utf8'), '{"fixture":"old"}');
  assert.doesNotMatch(remote, /docker container (stop|rm)/, "旧 agent 不在 remote.sh 里提前删除，交给 server-setup 按顺序处理");
});

test('s11 网关生成器写入 course 数据挂载；阶段参数使用同一清单且不泄露服务商密钥', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, COURSE_ROOT: root, CONTAINER_STAGES_DIR: path.resolve(app, '../stages'),
    AGENT_GATEWAY_KEY: 'sk-bf-test-only', CODEX_MODEL: 'kimi/kimi-k2.7-code', KIMI_API_KEY: 'fixture-provider-secret', CODEX_MODEL_CONTEXT_WINDOW: '200000' };
  for (const script of ['gateway-config.mjs', 'stages-config.mjs']) {
    const result = spawnSync(process.execPath, [path.join(app, 'deploy', script)], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  for (const file of ['gateway/config.json', 'gateway/model-parameters.json', 'stages/config.json']) {
    const text = fs.readFileSync(path.join(root, '.data', file), 'utf8');
    assert.doesNotMatch(text, /fixture-provider-secret|sk-bf-test-only/);
    assert.ok(JSON.parse(text));
  }
  const config = JSON.parse(fs.readFileSync(path.join(root, '.data/stages/config.json')));
  assert.ok(config.providers.includes('kimi'));
  assert.equal(config.modelEnvironment.CODEX_MODEL_CONTEXT_WINDOW, '200000');
});

test('一次性任务由 Compose 读取 .env，使用 stages 镜像且不共享 web 网络', () => {
  const tasks = fs.readFileSync(path.join(app, 'deploy/tasks.compose.yaml'), 'utf8');
  const shell = fs.readFileSync(path.join(app, 'deploy/tasks.sh'), 'utf8');
  assert.match(tasks, /image: codex-harness-stages:local/);
  assert.match(tasks, /env_file: \.env/);
  assert.match(tasks, /"\.\/.data:\/course\/.data"/);
  assert.doesNotMatch(tasks, /network_mode:|depends_on:/);
  assert.match(shell, /-f compose.yaml -f deploy\/tasks.compose.yaml run --rm --no-deps -T tasks/);
  assert.doesNotMatch(shell, /docker run|source .*\.env/);
});
