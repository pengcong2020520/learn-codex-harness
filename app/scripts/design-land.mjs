import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkAgentPackage } from '../server/modules/design/package.mjs';
import { readAsUser, userFileOperation } from '../server/modules/runtimes/user-files.mjs';
import { assertRealPath } from '../server/modules/runtimes/directories.mjs';
import { resourcePath } from '../server/modules/data/paths.mjs';
import { checkAgent } from './agent-check.mjs';
import { updateSelection } from './selection-env.mjs';
import { isMain, waitReady } from './quickstart-lib.mjs';
import { selectAgentFile } from '../server/modules/agents/selection.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const directoryNames = directory => {
  try {
    assertRealPath(directory);
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

export function discover(root) {
  const candidates = [];
  for (const workspace of ['workspace', ...['a', 'b', 'c'].map(node => 'nodes/node-' + node + '/workspace')]) {
    const users = path.join(root, workspace, 'users');
    for (const owner of directoryNames(users)) {
      const designs = path.join(users, owner, 'outputs/design');
      for (const project of directoryNames(designs)) {
        const versions = directoryNames(path.join(designs, project)).filter(name => /^package-v[1-9]\d*$/.test(name));
        versions.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
        if (versions.length) candidates.push(path.join(designs, project, versions[0]));
      }
    }
  }
  if (candidates.length !== 1) throw Error(candidates.length ? '发现多个设计项目，请用 --package 指定要落地的包目录。' : '没有找到工作室代码包。请完成代码交付，或用 --package 指定包目录。');
  return candidates[0];
}

function save(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx' });
}
function atomicJson(file, value) {
  const temp = file + '.' + randomUUID();
  save(temp, json(value));
  fs.renameSync(temp, file);
}
function assertChecks(result) {
  if (!result.ok) throw Error('代码包检查失败：' + result.issues.slice(0, 4).map(i => i.code + ' ' + i.file).join('、'));
}

export async function land(root, requested) {
  root = fs.realpathSync(root);
  const receipt = path.join(root, '.land/receipt.json');
  const prior = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt)) : null;
  const source = path.resolve(root, requested || prior?.source || discover(root));
  if (!source.startsWith(root + path.sep)) throw Error('请把包放入本项目 app/ 下并指定相对目录。');
  assertRealPath(source);
  const uid = fs.lstatSync(source).uid;
  const read = file => readAsUser(uid, path.join(source, file), { maxBytes: 16 * 1024 * 1024 });
  const raw = await read('manifest.json'), digest = sha(raw);
  if (prior && prior.digest !== digest) throw Error('已有其他代码包的落地记录，请核对 .land/receipt.json 和设计目录。');
  if (prior?.done) {
    if (JSON.parse(fs.readFileSync(path.join(root, 'config/runtime/project.json'))).agentDefinition !== prior.selected ||
        !fs.existsSync(path.join(root, prior.selected))) throw Error('已有落地记录，但当前产品选择已变化，请核对项目。');
    return prior;
  }
  const { manifest: valid } = await import('../agents/studio/ui/vendor/validators.mjs');
  const manifest = JSON.parse(raw);
  if (!valid(manifest) || manifest.agentId === 'studio') throw Error('清单格式或 Agent id 无效，请重新检查代码包。');
  assertChecks(process.getuid() === uid ? checkAgentPackage(source) : await userFileOperation(uid, 'check-agent-package', { directory: source }));
  const files = new Map();
  for (const { path: file, sha256 } of manifest.files) {
    resourcePath(file);
    const bytes = await read(file);
    if (sha(bytes) !== sha256) throw Error('读取期间包内容已改变，请核对文件：' + file);
    files.set(file, bytes);
  }
  if (sha(await read('manifest.json')) !== digest) throw Error('读取期间清单已改变。');
  const definition = JSON.parse(files.get('agent/agent.json'));
  if (definition.agent.id !== manifest.agentId || !definition.agent.ui) throw Error('清单与 Agent id 不一致或缺少产品前端。');
  for (const artifact of manifest.artifacts) {
    if (!files.has(artifact.path) || !artifact.confirmedBy || !artifact.confirmedAt || artifact.inputs.some(input => !files.has(input))) throw Error('设计确认记录或输入文件不完整。');
  }
  // 私有文件已经由包属主读取；项目文件始终以检出目录属主的身份安装。
  const owner = fs.statSync(root);
  const differentOwner = process.getuid() === 0 && owner.uid !== 0;
  if (differentOwner) { process.setgroups([]); process.setegid(owner.gid); process.seteuid(owner.uid); }
  // root 安装时 .env 可能属于 root，而检出目录属于普通用户。只在打开配置或恢复属主时切回维护身份。
  const configAccess = action => {
    if (!differentOwner) return action();
    process.seteuid(0);
    try { return action(); } finally { process.seteuid(owner.uid); }
  };
  const state = path.dirname(receipt);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  assertRealPath(state);
  const lock = path.join(state, 'lock');
  try { fs.mkdirSync(lock); } catch { throw Error('已有落地操作。请核对进程和 .land/receipt.json；确认操作已结束后可移除空的 .land/lock。'); }
  try {
    const stage = path.join(state, 'staged'), selected = 'agents/' + manifest.agentId + '/agent.json';
    const agent = path.dirname(path.join(root, selected)), design = path.join(root, 'design', manifest.productId);
    const record = { source: path.relative(root, source), digest, selected, productId: manifest.productId, done: false };
    assertRealPath(path.dirname(agent));
    fs.mkdirSync(path.dirname(design), { recursive: true });
    assertRealPath(path.dirname(design));
    if (!fs.existsSync(receipt)) {
      if (fs.existsSync(agent) || fs.existsSync(design)) throw Error('目标 Agent 或设计目录已存在，请核对后再落地。');
      if (fs.existsSync(stage)) throw Error('发现中断的准备目录，请核对 .land/staged 后再操作。');
      fs.mkdirSync(stage);
      try {
        for (const [file, bytes] of files) {
          if (/^agent\//.test(file)) save(path.join(stage, file), bytes);
          else if (file.startsWith('design/')) save(path.join(stage, file), bytes);
          else save(path.join(stage, 'design', file), bytes);
        }
        save(path.join(stage, 'design/manifest.json'), raw);
        save(path.join(stage, 'design/package-agent.json'), files.get('agent/agent.json'));
        definition.bindings.workspaceDir = '../../workspace';
        fs.writeFileSync(path.join(stage, 'agent/agent.json'), json(definition));
        // 上线后使用部署本身的模型与配置，在发布前用该环境再做静态检查。
        const errors = checkAgent(path.join(stage, 'agent/agent.json'), { root }).filter(row => row.level === 'error');
        if (errors.length) throw Error('安装检查失败：' + errors.map(row => row.title).join('、'));
        atomicJson(receipt, record);
      } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
    } else if (JSON.parse(fs.readFileSync(receipt)).digest !== digest) throw Error('落地记录已变化，请核对目标。');
    for (const [name, destination] of [['agent', agent], ['design', design]]) {
      const pending = path.join(stage, name);
      if (fs.existsSync(pending)) {
        if (fs.existsSync(destination)) throw Error('落地期间出现同名目录，请核对：' + name);
        fs.renameSync(pending, destination);
      } else assertRealPath(destination);
    }
    const errors = checkAgent(selected, { root }).filter(row => row.level === 'error');
    if (errors.length) throw Error('已安装的 Agent 检查失败，请核对 ' + selected);
    for (const [name, mode] of [['.env', 0o600], ['.env.example', 0o644]]) {
      const file = path.join(root, name);
      updateSelection(file, 'AGENT_DEFINITION', selected, mode, configAccess);
      updateSelection(file, 'COMPOSE_PROFILES', value => {
        const profiles = value.split(',').map(p => p.trim()).filter(Boolean);
        if (profiles.includes('*')) throw Error('请展开 COMPOSE_PROFILES 后再落地。');
        return profiles.filter(p => p !== 'studio').join(',');
      }, mode, configAccess);
    }
    atomicJson(path.join(root, 'config/runtime/project.json'), { agentDefinition: selected });
    const studio = path.join(root, 'agents/studio');
    if (fs.existsSync(studio)) fs.renameSync(studio, path.join(state, 'studio'));
    atomicJson(receipt, { ...record, done: true });
    return { ...record, done: true };
  } finally { fs.rmdirSync(lock); }
}

// 检查真实入口返回的字节，避免只凭容器存活就宣告产品已经切换。
export async function verifyLanding(root, env, fetchImpl = fetch) {
  const file = selectAgentFile(root);
  if (selectAgentFile(root, env.AGENT_DEFINITION) !== file) throw Error('节点的 Agent 选择与已安装的项目不一致。');
  const { agent } = JSON.parse(fs.readFileSync(file));
  if (!agent.ui || agent.id === 'studio') throw Error('当前节点尚未装配产品前端。');
  const baseUrl = 'http://caddy';
  await waitReady(env, { baseUrl, fetchImpl });
  const options = { redirect: 'manual', signal: AbortSignal.timeout(8000) };
  const entry = await fetchImpl(baseUrl + '/', options);
  if (entry.status !== 302 || entry.headers.get('location') !== '/app/') throw Error('Caddy 首页没有指向产品。');
  const response = await fetchImpl(baseUrl + '/app/', options);
  if (response.status !== 200 || !Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(path.join(path.dirname(file), agent.ui.entry)))) throw Error('产品首页与安装包入口不一致，请核对构建和节点配置。');
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--verify-live') {
      await verifyLanding(process.cwd(), process.env);
    } else {
      if (args.length && (args.length !== 2 || args[0] !== '--package')) throw Error('用法：land [--package app 下的包目录]');
      const result = await land(process.env.LAND_PROJECT_ROOT || process.cwd(), args[1]);
      console.log('代码包已落地：' + result.selected + '。设计记录：design/' + result.productId + '/。');
    }
  } catch (error) { console.error('落地停止：' + error.message); process.exitCode = 1; }
}
