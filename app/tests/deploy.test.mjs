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
  free: `printf '              total used free shared buff/cache available\\nMem: 3800 600 1200 10 2000 %s\\n' "\${MEM_MB:-3200}"`,
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
  const other = run(check, [], bin, { ...deployed, PORTS: deployed.PORTS.replace("4317=docker-proxy", "4317=MainThread"), UNITS: "14320=codex-harness.service",
    COMPOSE_PORTS: "127.0.0.1:14320->14320/tcp\n127.0.0.1:6379->6379/tcp" });
  assert.equal(other.code, 1);
  assert.match(other.out, /端口 4317 被 MainThread（PID 4317）占用/);
  assert.match(other.out, /端口 5432 被 docker-proxy（PID 5432）占用/);
  assert.match(other.out, /端口 4330 被 docker-proxy（PID 4330）占用/, "模型网关的端口也要检查");
  assert.doesNotMatch(other.out, /端口 (14320|6379)/);
});

test("部署前检查：逐项说明缺什么、怎么处理，而不是部署到一半失败", t => {
  const { dir, bin } = sandbox(t, all.filter(name => !["systemctl", "docker", "rsync"].includes(name)));
  // 服务器 .env 启用了本地向量模型：磁盘至少 12 GB、可用内存至少 1500 MB。
  fs.writeFileSync(path.join(dir, ".env"), "OLLAMA_BASE_URL=http://ollama:11434\n");
  const result = run(check, [], bin, { APP_DIR: dir, DISK_GB: "8", MEM_MB: "1200", PORTS: "5432=postgres" });
  assert.equal(result.code, 1);
  for (const expected of [/没有 systemd/, /没有 Docker\n.*docs\.docker\.com\/engine\/install.*registry-mirrors/,
    /没有 rsync/, /磁盘剩余 8 GB\n.*Ollama 镜像与向量模型约 7 GB/, /可用内存 1200 MB.*\n.*本地向量模型（Ollama）加载时还要约 1\.1 GB/, /端口 5432 被 postgres（PID 5432）占用/]) {
    assert.match(result.out, expected);
  }
  assert.doesNotMatch(result.out, /满足部署条件/);
});

test("部署前检查：没启用本地向量模型时，2 GiB 内存的小服务器也够用", t => {
  const { dir, bin } = sandbox(t, all);
  const small = run(check, [], bin, { APP_DIR: dir, DISK_GB: "8", MEM_MB: "1200" });
  assert.equal(small.code, 0, small.out);
  const tiny = run(check, [], bin, { APP_DIR: dir, DISK_GB: "4", MEM_MB: "600" });
  assert.match(tiny.out, /磁盘剩余 4 GB\n.*至少需要 6 GB/);
  assert.match(tiny.out, /可用内存 600 MB\n.*至少需要 800 MB/);
  assert.doesNotMatch(tiny.out, /Ollama/);
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
  *) cat > "$SENT" ;;
esac`);
function initEnv(t, envFile, env = {}) {
  const { dir, bin } = sandbox(t, ["ssh"]);
  fs.mkdirSync(path.join(dir, "app/deploy"), { recursive: true });
  fs.copyFileSync(path.join(app, "deploy/remote.sh"), path.join(dir, "app/deploy/remote.sh"));
  if (envFile !== undefined) fs.writeFileSync(path.join(dir, "app/.env"), envFile);
  const log = path.join(dir, "ssh.log"), sent = path.join(dir, "sent");
  const result = run(path.join(dir, "app/deploy/remote.sh"), ["init-env"], bin, { DEPLOY_HOST: "root@203.0.113.9", LOG: log, SENT: sent, ...env });
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
  assert.ok(result.sent.includes("CONTAINER_APP_DIR=/opt/learn-codex-harness/app"));
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

test("init-env：SSH 密钥登录不通时给出 ssh-copy-id 提示", t => {
  const result = initEnv(t, local, { SSH_FAIL: "255" });
  assert.equal(result.code, 1);
  assert.match(result.out, /无法用 SSH 密钥登录 root@203\.0\.113\.9；先运行 ssh-copy-id/);
  assert.equal(result.sent, "");
});

// 假 systemctl / docker / chown：只记录调用顺序。docker 里列出 Ollama 模型时回一个模型名，健康检查直接算通过。
stub("systemctl", `echo "systemctl $*" >> "$LOG"`);
stub("chown", `echo "chown $*" >> "$LOG"`);
stub("docker-setup", `echo "docker $*" >> "$LOG"
case "$*" in *"ollama-pull.mjs --list"*) echo "qwen3-embedding:0.6b" ;; esac; exit 0`);

test("server-setup：全部服务用 Docker 起；先生成网关配置，迁移前停掉智能体与工作台，最后装开机单元并等健康检查", t => {
  const { dir, bin } = sandbox(t, ["systemctl", "chown"], ["chmod", "paste", "seq", "sleep", "mkdir"]);
  fs.symlinkSync(path.join(stubs, "docker-setup"), path.join(bin, "docker"));
  const target = path.join(dir, "app"), units = path.join(dir, "units"), log = path.join(dir, "calls.log");
  fs.cpSync(path.join(app, "deploy"), path.join(target, "deploy"), { recursive: true });
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(target, ".env"), "CODEX_MODEL=kimi/kimi-k2.7-code\nOLLAMA_BASE_URL=http://ollama:11434\n");
  fs.writeFileSync(path.join(target, "REVISION"), "abc1234\n");

  const result = run(path.join(target, "deploy/server-setup.sh"), [], bin, { APP_DIR: target, UNIT_DIR: units, LOG: log });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /就绪：abc1234/);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  const at = pattern => {
    const index = calls.findIndex(call => pattern.test(call));
    assert.notEqual(index, -1, `没有调用 ${pattern}：\n${calls.join("\n")}`);
    return index;
  };
  assert.match(calls[at(/^chown/)], /^chown -R 1000:1000 \.data \.runs workspace$/, "容器里以 node（uid 1000）运行");
  assert.ok(at(/^docker compose build agent$/) < at(/node scripts\/gateway-config\.mjs/));
  assert.match(calls[at(/node scripts\/gateway-config\.mjs/)], /^docker compose run --rm --no-deps -T agent node/, "一次性任务在镜像里跑，宿主不需要 Node");
  assert.ok(at(/node scripts\/gateway-config\.mjs/) < at(/^docker compose up -d --wait --force-recreate gateway$/), "先生成配置，再重建网关");
  assert.ok(at(/^docker compose up -d --wait ollama$/) < at(/ollama pull qwen3-embedding:0\.6b/));
  const stop = at(/^docker compose stop agent web$/);
  assert.ok(stop < at(/npm run -s data:migrate/), "迁移不能与运行中的服务同时写状态");
  assert.ok(at(/npm run -s data:migrate/) < at(/npm run -s agent:init/));
  assert.ok(at(/^docker compose exec -T ollama ollama pull qwen3-embedding:0\.6b$/) < at(/^docker compose up -d --wait --force-recreate agent web$/));
  assert.ok(at(/^docker compose up -d --wait --force-recreate agent web$/) < at(/^systemctl enable -q codex-harness\.service$/));
  assert.ok(at(/^systemctl daemon-reload$/) < at(/^systemctl start codex-harness\.service$/));
  // 健康检查的脚本有多行，日志里跨行，所以从这一行往后找 /health。
  assert.match(calls.slice(at(/^docker compose exec -T agent node -e/)).join("\n"), /\/health/, "在智能体容器里做健康检查");
  const env = fs.readFileSync(path.join(target, ".env"), "utf8");
  assert.match(env, /^COMPOSE_PROFILES=app,embedding$/m, "开机单元靠 COMPOSE_PROFILES 带上智能体与本地向量模型");
  assert.equal(fs.statSync(path.join(target, ".env")).mode & 0o777, 0o600);

  // 只装一个开机单元；docker 与部署目录换成这台服务器上的实际路径。
  assert.deepEqual(fs.readdirSync(units), ["codex-harness.service"]);
  const unit = fs.readFileSync(path.join(units, "codex-harness.service"), "utf8");
  assert.match(unit, new RegExp(`^ExecStart=${bin}/docker compose up -d --wait$`, "m"));
  assert.match(unit, new RegExp(`^ExecStop=${bin}/docker compose stop$`, "m"));
  assert.match(unit, new RegExp(`^WorkingDirectory=${target}$`, "m"));

  // 重复部署不重复追加 COMPOSE_PROFILES；没启用 Ollama 时不起它、也不下载模型。
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(target, ".env"), "CODEX_MODEL=kimi/kimi-k2.7-code\n");
  assert.equal(run(path.join(target, "deploy/server-setup.sh"), [], bin, { APP_DIR: target, UNIT_DIR: units, LOG: log }).code, 0);
  assert.match(fs.readFileSync(path.join(target, ".env"), "utf8"), /^COMPOSE_PROFILES=app$/m);
  assert.doesNotMatch(fs.readFileSync(log, "utf8"), /ollama/);
  assert.equal(run(path.join(target, "deploy/server-setup.sh"), [], bin, { APP_DIR: target, UNIT_DIR: units, LOG: log }).code, 0);
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8").match(/^COMPOSE_PROFILES=/gm).length, 1);
  assert.doesNotMatch(fs.readFileSync(log, "utf8"), /disable/, "已经是容器部署时不碰开机单元的启停状态");
});

test("server-setup：从旧版部署（宿主 Node + 三个单元）升级时先停用并移除旧单元，再用容器启动", t => {
  const { dir, bin } = sandbox(t, ["systemctl", "chown"], ["chmod", "paste", "seq", "sleep", "mkdir", "rm"]);
  fs.symlinkSync(path.join(stubs, "docker-setup"), path.join(bin, "docker"));
  const target = path.join(dir, "app"), units = path.join(dir, "units"), log = path.join(dir, "calls.log");
  fs.cpSync(path.join(app, "deploy"), path.join(target, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(target, "node_modules/x"), { recursive: true });
  fs.mkdirSync(units);
  for (const unit of ["codex-harness.service", "codex-harness-db.service", "codex-harness-web.service"]) fs.writeFileSync(path.join(units, unit), "[Service]\nExecStart=/usr/bin/node server/main.mjs\n");
  fs.writeFileSync(path.join(target, ".env"), "CODEX_MODEL=kimi/kimi-k2.7-code\n");

  const result = run(path.join(target, "deploy/server-setup.sh"), [], bin, { APP_DIR: target, UNIT_DIR: units, LOG: log });
  assert.equal(result.code, 0, result.out);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  const disable = calls.indexOf("systemctl disable -q --now codex-harness-web.service codex-harness.service codex-harness-db.service");
  assert.notEqual(disable, -1, calls.join("\n"));
  assert.ok(disable < calls.indexOf("docker compose up -d --wait postgres redis"), "旧进程占着端口，要先停");
  assert.deepEqual(fs.readdirSync(units), ["codex-harness.service"]);
  assert.match(fs.readFileSync(path.join(units, "codex-harness.service"), "utf8"), /docker compose up -d --wait/, "同名单元换成容器版");
  assert.ok(!fs.existsSync(path.join(target, "node_modules")), "宿主不再需要依赖目录");
});


test("部署脚本登记清单中每家服务商的密钥变量", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(app, "config/models.json"), "utf8"));
  const remote = fs.readFileSync(path.join(app, "deploy/remote.sh"), "utf8");
  const listed = remote.match(/^PROVIDER_KEYS='([^']+)'/m)[1].split("|");
  const keys = Object.values(registry.providers).map(provider => provider.keyEnv).filter(Boolean);
  assert.deepEqual(listed.sort(), keys.sort());
});
