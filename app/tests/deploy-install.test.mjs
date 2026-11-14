import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSetupSummary, writeSetupSummary } from '../scripts/setup-summary.mjs';

const installer = new URL('../deploy/install.sh', import.meta.url);
const source = fs.readFileSync(installer, 'utf8');
const shell = (code, args = [], options = {}) => spawnSync('bash', ['-c', code, 'test', ...args], { encoding: 'utf8', ...options });
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-install-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

test('install：Shell 语法、帮助与未知参数不触发安装', () => {
  for (const file of [installer, new URL('../scripts/e2e-server-install.sh', import.meta.url)]) {
    const result = spawnSync('bash', ['-n', file.pathname], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const flag of ['-h', '--help']) {
    const result = spawnSync('bash', [installer.pathname, flag], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--cn[\s\S]*--upgrade[\s\S]*--install-docker-only/);
  }
  for (const args of [['--unknown'], ['--registry-mirror'], ['--registry-mirror', 'https://name:password@example.com']]) {
    const result = spawnSync('bash', [installer.pathname, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /name:password/);
  }
});

for (const [id, version, arch, expected] of [
  ['ubuntu', '22.04', 'amd64', 'ubuntu jammy amd64'],
  ['ubuntu', '24.04', 'arm64', 'ubuntu noble arm64'],
  ['debian', '12', 'amd64', 'debian bookworm amd64'],
  ['debian', '12', 'arm64', 'debian bookworm arm64'],
  ['ubuntu', '20.04', 'amd64', null], ['debian', '11', 'amd64', null],
  ['linuxmint', '22', 'amd64', null], ['ubuntu', '24.04', 'armhf', null],
]) test(`install：系统检测 ${id} ${version} ${arch}`, t => {
  const file = path.join(temporary(t), 'os-release');
  fs.writeFileSync(file, `ID=${id}\nVERSION_ID="${version}"\nID_LIKE=ubuntu\n`);
  const result = shell('source "$1"; install_detect_system "$2" "$3" || exit $?; printf "%s %s %s" "$install_os" "$install_suite" "$install_arch"', [installer.pathname, file, arch]);
  assert.equal(result.status, expected ? 0 : 1, result.stderr);
  if (expected) assert.equal(result.stdout, expected);
  else assert.match(result.stderr, /请手动准备 Docker Compose/);
});

test('install：仅缺失基础软件包进入 apt，不重装已有包', () => {
  const result = shell(`source "$1"
    dpkg-query() { case "$3" in curl|tar) printf 'install ok installed';; *) return 1;; esac; }
    apt-get() { printf 'apt %s\n' "$*"; }
    install_packages ca-certificates curl gnupg util-linux tar gzip`, [installer.pathname]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'apt update\napt install -y ca-certificates gnupg util-linux gzip\n');
});

test('install：Docker 两项检查都通过才跳过，安装失败不重试', () => {
  const result = shell(`set -e; source "$1"
    docker() { return 0; }
    apt-get() { exit 99; }
    install_docker`, [installer.pathname]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /跳过安装/);
  for (const fail of ['compose version', 'info']) {
    const failed = shell(`set -e; source "$1"; failed_command="$2"
      docker() { [ "$*" != "$failed_command" ]; }
      install_packages() { printf '安装尝试\n'; return 37; }
      install_docker`, [installer.pathname, fail]);
    assert.equal(failed.status, 37);
    assert.equal(failed.stdout, '安装尝试\n');
  }
});

test('install：镜像地址验证及 daemon.json 存在时原样保留', t => {
  const file = path.join(temporary(t), 'docker/daemon.json');
  for (const [value, valid] of [
    ['https://mirror.example.com', true], ['http://mirror.example.com:5000/cache/', true],
    ['https://name:password@example.com', false], ['https://example.com/?token=value', false],
    ['https://example.com/"', false], ['https://example.com/\n', false], ['file:///tmp/docker', false],
  ]) {
    const result = shell('source "$1"; install_validate_mirror "$2"', [installer.pathname, value]);
    assert.equal(result.status, valid ? 0 : 1);
  }
  const run = () => shell(`set -e; source "$1"; install_mirror=https://mirror.example.com
    systemctl() { printf 'systemctl %s\n' "$*"; }
    install_registry_mirror "$2"`, [installer.pathname, file]);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'registry-mirrors': ['https://mirror.example.com'] });
  assert.match(first.stdout, /systemctl restart docker/);
  fs.writeFileSync(file, '{"log-driver":"local"}\n');
  const second = run();
  assert.equal(second.status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"log-driver":"local"}\n');
  assert.match(second.stdout, /请手动合并/);
  assert.doesNotMatch(second.stdout, /systemctl/);
});

function mainFixture(t, extra = '') {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'deploy'));
  fs.copyFileSync(installer, path.join(root, 'deploy/install.sh'));
  const trace = path.join(root, 'trace');
  const code = `source "$1/deploy/install.sh"
    trace="$1/trace"
    id() { echo 0; }
    uname() { echo Linux; }
    dpkg() { echo amd64; }
    install_detect_system() { install_os=ubuntu; install_suite=noble; install_arch=amd64; }
    awk() { if [ "$#" = 2 ]; then echo 1048576; else cat >/dev/null; echo 5242880; fi; }
    install_packages() { echo packages >> "$trace"; }
    install_docker() { echo docker-ready >> "$trace"; }
    bash() { echo "$*" >> "$trace"; }
    ufw() { echo "ufw $*" >> "$trace"; if [ "$1" = status ]; then echo 'Status: active'; fi; }
    docker() {
      printf '%s\n' "$*" >> "$trace"
      case "$*" in
        'compose config --services') printf 'node-a\ncaddy\nedge\n';;
        'compose exec -T edge printenv AGENT_DOMAIN') echo agent.example.com;;
        *'scripts/setup-summary.mjs'*) echo '管理员用户名（向导记录）：admin';;
        *'setup --non-interactive') touch .env;;
      esac
    }
    ${extra}
    shift
    install_main "$@"`;
  return { root, trace, run: args => shell(code, [root, ...args]) };
}

test('install：完整编排、低资源告警和重复执行跳过向导', t => {
  const f = mainFixture(t);
  for (const pass of [1, 2]) {
    const result = f.run(['--non-interactive', '--cn']);
    assert.equal(result.status, 0, result.stderr);
    for (let step = 1; step <= 9; step++) assert.match(result.stdout, new RegExp(`第 ${step} 步：`));
    assert.match(result.stdout, /内存低于 2 GB/);
    assert.match(result.stdout, /可用磁盘低于 10 GB/);
    assert.match(result.stdout, /入口：https:\/\/agent.example.com/);
    assert.match(result.stdout, /管理员用户名（向导记录）：admin/);
    assert.match(result.stdout, /04:00[\s\S]*backups\//);
    assert.match(result.stdout, pass === 1 ? /向导完成/ : /已有 .env，跳过向导/);
  }
  const trace = fs.readFileSync(f.trace, 'utf8');
  assert.equal(trace.match(/setup --non-interactive/g).length, 1);
  assert.equal(trace.match(/compose up -d --build --wait/g).length, 2);
  assert.match(trace, /ufw allow 80\/tcp\nufw allow 443\/tcp/);
  assert.match(trace, /deploy\/enable-service.sh\ndeploy\/enable-backup-timer.sh/);
  assert.match(trace, /-e SETUP_ADMIN_PASSWORD/);
});

test('install：无 HTTPS 时不改 ufw，汇总给出 SSH 隧道', t => {
  const f = mainFixture(t, `docker() {
    echo "$*" >> "$trace"
    case "$*" in 'compose config --services') echo caddy;; esac
  }`);
  fs.writeFileSync(path.join(f.root, '.env'), '测试配置不能被读取\n');
  const result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ssh -L 4317:127.0.0.1:4317 root@<服务器地址>/);
  assert.doesNotMatch(fs.readFileSync(f.trace, 'utf8'), /ufw/);
});

for (const [status, count] of [[0, 0], [1, 1], [1, 2], [2, 0]]) {
  test(`install：生产检查退出码 ${status}、${count} 项待处理时区分部署完成与检查异常`, t => {
    const rows = ['✓ 服务配置', '! 提示中的 ✗ 不计数', ...Array.from({ length: count }, (_, i) => `✗ 检查项${i + 1}`)].join('\n');
    const f = mainFixture(t, `docker() {
      echo "$*" >> "$trace"
      case "$*" in
        'compose config --services') echo caddy;;
        'compose run --rm -T check') printf '%s\\n' '${rows}'; return ${status};;
      esac
    }`);
    fs.writeFileSync(path.join(f.root, '.env'), '测试配置不能被读取\n');
    const result = f.run([]);
    assert.equal(result.status, status === 2 ? 2 : 0, result.stderr);
    assert.ok(result.stdout.includes(rows));
    if (status === 2) {
      assert.match(result.stderr, /第 9 步失败（退出码 2）/);
      assert.doesNotMatch(result.stdout, /部署已完成|ssh -L|日志：/);
      assert.doesNotMatch(fs.readFileSync(f.trace, 'utf8'), /setup-summary/);
    } else {
      assert.doesNotMatch(result.stdout + result.stderr, /失败/);
      assert.match(result.stdout, /日志：docker compose logs -f/);
      if (count) {
        assert.ok(result.stdout.includes(`部署已完成；生产检查有 ${count} 项需要在正式上线前处理（见上方 ✗），处理后运行 docker compose run --rm check 复查`));
        assert.doesNotMatch(result.stdout, /生产静态检查通过/);
      } else {
        assert.match(result.stdout, /生产静态检查通过/);
        assert.doesNotMatch(result.stdout, /生产检查有/);
      }
    }
  });
}

test('install：构建或生产检查无法运行时立即停止并保留退出码', t => {
  for (const failure of ['compose up -d --build --wait', 'compose run --rm -T check']) {
    const f = mainFixture(t, `docker() {
      echo "$*" >> "$trace"
      if [ "$*" = '${failure}' ]; then return 42; fi
      if [ "$*" = 'compose config --services' ]; then echo caddy; fi
    }`);
    fs.writeFileSync(path.join(f.root, '.env'), '测试配置不能被读取\n');
    const result = f.run([]);
    assert.equal(result.status, 42, result.stderr);
    assert.match(result.stderr, /失败（退出码 42）/);
    if (failure.includes('up -d')) {
      assert.doesNotMatch(fs.readFileSync(f.trace, 'utf8'), /enable-service|run --rm -T check/);
    } else {
      assert.doesNotMatch(result.stdout, /日志：docker compose logs -f/);
      assert.doesNotMatch(fs.readFileSync(f.trace, 'utf8'), /setup-summary/);
    }
  }
});

test('install：非 root、脏工作区拒绝，升级只快进且重新加载脚本', t => {
  const nonroot = mainFixture(t, 'id() { echo 1000; }');
  assert.match(nonroot.run([]).stderr, /请用 root 或 sudo/);
  const dirty = mainFixture(t, `git() { echo "$*" >> "$trace"; echo ' M tracked-file'; }`);
  const rejected = dirty.run(['--upgrade']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /工作区有本地改动/);
  assert.equal(fs.readFileSync(dirty.trace, 'utf8'), 'status --porcelain\n');
  const clean = mainFixture(t, `git() { echo "$*" >> "$trace"; }
    exec() { echo "$*" >> "$trace"; exit 0; }`);
  assert.equal(clean.run(['--upgrade', '--cn', '--non-interactive']).status, 0);
  assert.equal(fs.readFileSync(clean.trace, 'utf8'), 'status --porcelain\npull --ff-only --quiet\nbash deploy/install.sh --cn --non-interactive\n');
});

test('install：仅安装模式不执行向导、systemd 或其他部署步骤', t => {
  const f = mainFixture(t);
  const result = f.run(['--install-docker-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /第 3 步/);
  assert.equal(fs.readFileSync(f.trace, 'utf8'), 'docker-ready\n');
});

test('install：不解析密钥文件，交互向导使用终端，Docker apt 来源与包固定', () => {
  assert.doesNotMatch(source, /get\.docker\.com|curl[^\n]*\|\s*(?:ba)?sh/);
  assert.doesNotMatch(source, /(?:source|cat|sed|awk|grep|read)[^\n]*["' /]\.env\b/);
  assert.match(source, /setup < \/dev\/tty/);
  assert.match(source, /docker compose config --services/);
  assert.match(source, /git pull --ff-only/);
  assert.match(source, /https:\/\/download.docker.com\/linux/);
  assert.match(source, /https:\/\/mirrors.aliyun.com\/docker-ce\/linux/);
  assert.match(source, /curl -fsSL "\$base\/\$install_os\/gpg" -o \/etc\/apt\/keyrings\/docker.asc/);
  assert.match(source, /Signed-By: \/etc\/apt\/keyrings\/docker.asc/);
  assert.match(source, /apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin/);
  assert.match(source, /if \[ "\$install_only" = 0 \]; then\n    systemctl enable --now docker/);
});

test('安装 CI：独立项目、两遍安装、HTTPS 登录、单账号和 systemd，干净容器覆盖三个源组合', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const e2e = fs.readFileSync(new URL('../scripts/e2e-server-install.sh', import.meta.url), 'utf8');
  assert.match(workflow, /server-install:/);
  assert.match(workflow, /ubuntu:24.04 debian:12 ubuntu:24.04-cn/);
  assert.match(workflow, /--install-docker-only/);
  assert.match(workflow, /policy-rc.d/);
  for (const text of ['COMPOSE_PROJECT_NAME=codex-agent-e2e-server-install', 'for pass in 1 2', 'bash deploy/install.sh --non-interactive', 'systemctl is-enabled', 'docker compose down -v', 'systemctl disable --now', 'E2E_BASE_URL=https://agent.localhost', 'node scripts/e2e-check.mjs --login-only', '[ "$count" = 1 ]', 'AGENT_TLS=internal']) assert.ok(e2e.includes(text), text);
  assert.doesNotMatch(e2e, /sudo env[^\n]*(?:PASSWORD|API_KEY)=/);
});

test('向导汇总：只存用户名、重建可替换、缺失给提示，损坏与链接不回显', t => {
  const root = temporary(t), file = path.join(root, '.data/setup-summary.json');
  assert.match(readSetupSummary(root), /未保存向导汇总/);
  writeSetupSummary(root, 'admin');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { username: 'admin' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeSetupSummary(root, 'operator');
  assert.equal(readSetupSummary(root), '管理员用户名（向导记录）：operator');
  for (const content of ['invalid secret marker', '{"username":"invalid user secret"}', '{}']) {
    fs.writeFileSync(file, content);
    assert.throws(() => readSetupSummary(root), error => /内容未显示/.test(error.message) && !error.message.includes(content));
  }
  fs.rmSync(file);
  fs.symlinkSync(path.join(root, 'missing'), file);
  assert.throws(() => readSetupSummary(root), /内容未显示/);
});
