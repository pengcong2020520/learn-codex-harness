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
  free: `printf '              total used free shared buff/cache available\\nMem: 1800 400 200 10 1200 %s\\n' "\${MEM_MB:-1300}"`,
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
// 服务器上已经部署过：Agent 与工作台由 systemd 单元运行（Node 24 进程名是 MainThread），数据库端口由本项目容器发布。
const deployed = {
  PORTS: "4317=MainThread 14320=MainThread 5432=docker-proxy 6379=docker-proxy",
  UNITS: "4317=codex-harness.service 14320=codex-harness-web.service",
  COMPOSE_PORTS: "127.0.0.1:5432->5432/tcp 127.0.0.1:6379->6379/tcp"
};
const check = path.join(app, "deploy/check.sh");

test("部署前检查：条件齐全时通过；本服务自己占着端口（重复部署）不算冲突", t => {
  const { bin } = sandbox(t, all);
  const fresh = run(check, [], bin);
  assert.equal(fresh.code, 0, fresh.out);
  assert.match(fresh.out, /Node\.js v24\.11\.0/);
  assert.match(fresh.out, /服务器满足部署条件/);
  assert.doesNotMatch(fresh.out, /✗/);

  const redeploy = run(check, [], bin, deployed);
  assert.equal(redeploy.code, 0, redeploy.out);
});

test("部署前检查：端口被别的程序或别的项目的容器占着才算冲突", t => {
  const { bin } = sandbox(t, all);
  const other = run(check, [], bin, { ...deployed, UNITS: "14320=codex-harness-web.service", COMPOSE_PORTS: "127.0.0.1:6379->6379/tcp" });
  assert.equal(other.code, 1);
  assert.match(other.out, /端口 4317 被 MainThread（PID 4317）占用/);
  assert.match(other.out, /端口 5432 被 docker-proxy（PID 5432）占用/);
  assert.doesNotMatch(other.out, /端口 (14320|6379)/);
});

test("部署前检查：逐项说明缺什么、怎么处理，而不是部署到一半失败", t => {
  const { bin } = sandbox(t, all.filter(name => !["systemctl", "docker", "rsync"].includes(name)));
  const result = run(check, [], bin, { NODE_MAJOR: "20", DISK_GB: "2", MEM_MB: "300", PORTS: "5432=postgres" });
  assert.equal(result.code, 1);
  for (const expected of [/没有 systemd/, /没有 Docker\n.*docs\.docker\.com\/engine\/install/, /需要 Node\.js 24\+（当前：v20\.11\.0）/,
    /没有 rsync/, /磁盘剩余 2 GB/, /可用内存 300 MB/, /端口 5432 被 postgres（PID 5432）占用/]) {
    assert.match(result.out, expected);
  }
  assert.doesNotMatch(result.out, /满足部署条件/);
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
  "CODEX_API_KEY=sk-local-secret", "CODEX_BASE_URL=https://provider.example/v1", "CODEX_MODEL=unit-model", "CODEX_MODEL_CONTEXT_WINDOW=200000",
  "AGENT_MEMORY_ENABLED=true", "DEMO_TIMEOUT_MS=90000",
  "AGENT_DB_PASSWORD=local-db-password", "DATABASE_URL=postgresql://agent:local-db-password@127.0.0.1:55432/agent",
  "REDIS_URL=redis://127.0.0.1:56379/0", "AGENT_PG_PORT=55432", ""
].join("\n");

test("init-env：只把模型与 Agent 配置发到服务器，本机数据库密码与端口不外传", t => {
  const result = initEnv(t, local);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /已生成服务器/);
  for (const line of ["CODEX_API_KEY=sk-local-secret", "CODEX_MODEL_CONTEXT_WINDOW=200000", "AGENT_MEMORY_ENABLED=true", "DEMO_TIMEOUT_MS=90000"]) {
    assert.ok(result.sent.includes(line), line);
  }
  assert.doesNotMatch(result.sent, /local-db-password|DATABASE_URL|REDIS_URL|AGENT_PG_PORT|55432/);
  assert.doesNotMatch(result.out, /sk-local-secret/);
  assert.match(result.commands, /umask 077/);
  assert.match(result.commands, /\/dev\/urandom/);
});

test("init-env：本机配置不完整时在连服务器之前就停下；服务器已有 .env 时不覆盖", t => {
  const empty = initEnv(t, local.replace("CODEX_API_KEY=sk-local-secret", "CODEX_API_KEY="));
  assert.equal(empty.code, 1);
  assert.match(empty.out, /CODEX_API_KEY 为空/);
  assert.equal(empty.commands, "");

  const quoted = initEnv(t, local.replace("CODEX_MODEL=unit-model", 'CODEX_MODEL=""'));
  assert.equal(quoted.code, 1);
  assert.match(quoted.out, /CODEX_MODEL 为空/);

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

// 假 systemctl / runuser：只记录调用顺序；runuser 里的健康检查（node -e）直接算通过。
stub("systemctl", `echo "systemctl $*" >> "$LOG"`);
stub("runuser", `echo "runuser $*" >> "$LOG"`);
for (const name of ["id", "chown"]) stub(name, "exit 0");

test("server-setup：先停服务再装依赖和迁移（重复部署时迁移不能与运行中的服务同时写状态），最后启动并等健康检查", t => {
  const { dir, bin } = sandbox(t, ["systemctl", "runuser", "id", "chown", "node", "docker"], ["chmod", "paste", "seq", "sleep"]);
  const target = path.join(dir, "app"), units = path.join(dir, "units"), log = path.join(dir, "calls.log");
  fs.cpSync(path.join(app, "deploy"), path.join(target, "deploy"), { recursive: true });
  fs.mkdirSync(units);
  fs.writeFileSync(path.join(target, ".env"), "CODEX_MODEL=unit-model\n");
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
  const stop = at(/^systemctl stop .*codex-harness\.service/);
  assert.ok(at(/^systemctl daemon-reload/) < stop);
  assert.ok(stop < at(/npm ci/));
  assert.ok(at(/npm ci/) < at(/npm run -s agent:init/));
  assert.ok(at(/^systemctl start codex-harness-db\.service/) < at(/npm run -s data:migrate/));
  assert.ok(at(/npm run -s data:migrate/) < at(/^systemctl start codex-harness\.service codex-harness-web\.service/));
  assert.match(calls[at(/npm ci/)], /^runuser -u codex -- env HOME=\/var\/lib\/codex npm ci/);
  assert.equal(fs.statSync(path.join(target, ".env")).mode & 0o777, 0o600);

  // 单元文件装进 UNIT_DIR，node / docker 换成这台机器上 command -v 找到的路径。
  assert.deepEqual(fs.readdirSync(units).sort(), ["codex-harness-db.service", "codex-harness-web.service", "codex-harness.service"]);
  assert.match(fs.readFileSync(path.join(units, "codex-harness.service"), "utf8"), new RegExp(`^ExecStart=${bin}/node server/main\\.mjs$`, "m"));
  assert.match(fs.readFileSync(path.join(units, "codex-harness-db.service"), "utf8"), new RegExp(`^ExecStop=${bin}/docker compose stop`, "m"));
  for (const unit of fs.readdirSync(path.join(app, "deploy/systemd"))) {
    const body = fs.readFileSync(path.join(app, "deploy/systemd", unit), "utf8");
    for (const [, command] of body.matchAll(/^Exec\w+=(\S+)/gm)) assert.match(command, /^\/usr\/bin\/(node|docker)$/, unit);
  }
});
