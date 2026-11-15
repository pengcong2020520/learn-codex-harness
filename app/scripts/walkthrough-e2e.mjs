// 由独立 Compose 验收项目在落地后调用，以真实 Caddy、认证和已安装的产品页面验收截图。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const dir = 'design/task-helper/walkthrough', planFile = path.join(dir, 'plan-v1.json');
if (!process.env.WALKTHROUGH_INPUT_PASSWORD || !process.env.COMPOSE_PROJECT_NAME?.includes('e2e')) throw Error('请从一次性 Compose 端到端测试运行。');
fs.mkdirSync(dir, { recursive: true });
const login = [{ open: '/ui/?next=%2Fapp%2F' }, { fill: { selector: '#username', value: 'admin' } },
  { fill: { selector: '#password', fromEnv: 'WALKTHROUGH_INPUT_PASSWORD' } }, { click: '#login-form button[type="submit"]' }];
const plan = { schemaVersion: 1, projectId: 'task-helper', mode: 'product', round: 1, previousRound: null,
  prd: 'prd-v1.md', source: { artifact: 'agent/agent.json', version: 1 }, confirmation: { status: 'confirmed', confirmedAt: new Date().toISOString(), confirmedBy: '自动验收' },
  groups: [{ id: 'access', title: '访问产品', order: 1, screens: [{ id: 'product', title: '产品页面', position: 1, states: ['login', 'list', 'edit'],
    reproduce: { login: ['打开登录页'], list: ['登录测试管理员，进入事项列表'], edit: ['从事项列表打开输入页'] },
    capture: { login: { steps: [{ open: '/ui/?next=%2Fapp%2F' }], ready: '#username' }, list: { steps: login, ready: '#screens button' },
      edit: { steps: [{ open: '/app/' }, { click: '#screens button' }], ready: '#screens textarea' } } }] }] };
fs.writeFileSync(planFile, JSON.stringify(plan), { flag: 'wx' });
const result = spawnSync('bash', ['deploy/walkthrough.sh', planFile], { stdio: 'inherit' });
assert.equal(result.status, 0);
const record = JSON.parse(fs.readFileSync(path.join(dir, 'r1/walkthrough-r1.json')));
const states = record.groups[0].screens[0].states;
for (const state of states) {
  assert.match(state.screenshot, /^data:image\/png;base64,iVBOR/);
  assert.ok(fs.existsSync(path.join(dir, 'r1', state.screenshotPath)));
  assert.equal(state.unavailableReason, null);
}
console.log('真实产品巡查通过：登录、登录回跳、目标产品、输入页与三张 PNG。');
