// 只在一次性 Compose 验收项目里，将已校验夹具写入真实用户的私有工作区。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (!process.env.LAND_E2E_FIXTURE) throw Error('只能在独立验收项目中执行。');
const users = path.resolve('workspace/users');
const owner = fs.readdirSync(users).find(name => /^[\da-f-]{36}$/.test(name));
if (!owner) throw Error('请先经网页或 API 创建测试会话。');
const root = path.join(users, owner), uid = fs.statSync(root).uid;
if (!uid) throw Error('测试用户未分配独立 uid。');
const source = path.resolve('tests/fixtures/studio/package-v1');
const target = path.join(root, 'outputs/design/task-helper/package-v1');
const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import fs from 'node:fs';
  import path from 'node:path';
  process.umask(0o077);
  const [source, target] = process.argv.slice(1);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.cpSync(source, target, {recursive: true, force: false, errorOnExist: true});
  fs.chmodSync(target, 0o700);
  fs.chmodSync(path.join(target, 'manifest.json'), 0o600);
`, source, target], { uid, gid: uid, env: {}, stdio: 'inherit' });
if (result.status !== 0) throw Error('准备私有测试包失败。');
