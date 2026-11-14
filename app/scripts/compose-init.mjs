import fs from 'node:fs';
import path from 'node:path';
import { loadEnvironment } from '../server/modules/config/index.mjs';
import { clusterNodes, validateClusterSecrets } from '../server/modules/config/cluster.mjs';
import { writeGatewayConfig } from './gateway-config.mjs';
import { isMain } from './quickstart-lib.mjs';

export function validatePrepareEnvironment(env) {
  const required = ['AGENT_DB_PASSWORD', 'REDIS_PASSWORD', 'AGENT_GATEWAY_KEY', 'ETCD_ROOT_PASSWORD', 'ETCD_HEALTH_PASSWORD', 'ETCD_NODE_A_PASSWORD', 'CONTAINER_APP_DIR', 'AGENT_PREVIEW_SECRET', 'AGENT_NODE_KEY_A', 'AGENT_NODE_KEY_A_HASH', 'AGENT_NODE_A_DB_PASSWORD'];
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`缺少必填变量：${missing.join('、')}；先运行配置向导或 npm run setup。`);
  if (!path.posix.isAbsolute(env.CONTAINER_APP_DIR)) throw new Error('CONTAINER_APP_DIR 必须是绝对路径；先运行配置向导或 npm run setup。');
  const nodes = clusterNodes(env);
  validateClusterSecrets(env, nodes);
  return nodes;
}

function realDirectory(root, relative, create = false) {
  let target = root;
  // 逐段检查，避免只检查末级目录时穿过 nodes 等父路径的符号链接。
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    if (create) {
      try { fs.mkdirSync(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const info = fs.lstatSync(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('数据目录不能是文件或符号链接。');
  }
  return target;
}

export function prepareDirectories(root, nodes, { chown = fs.chownSync, chmod = fs.chmodSync } = {}) {
  const directories = ['.data', '.runs', 'workspace', 'backups', '.data/gateway',
    ...nodes.flatMap(node => [`.data`, '.runs', 'workspace'].map(name => `nodes/${node}/${name}`).concat(`backups/${node}`))];
  for (const directory of directories) {
    const target = realDirectory(root, directory, true);
    // 不递归接管用户 uid；只调整服务自己的父目录。
    chown(target, 0, 1000);
    chmod(target, 0o2770);
  }
}

export function copyNodeIdentities(root, nodes) {
  const identityFile = node => path.join(realDirectory(root, `${node}/.data`), 'identity.json');
  const read = file => {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('节点部署身份文件不能是链接。');
    return fs.readFileSync(file);
  };
  const source = read(identityFile('node-a'));
  for (const node of nodes.slice(1)) {
    const target = identityFile(node);
    try {
      if (!source.equals(read(target))) throw new Error('节点部署身份不一致。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // 独占创建，已有身份永不覆盖；中断留下的不完整文件下次会报不一致。
      fs.writeFileSync(target, source, { flag: 'wx', mode: 0o600 });
      fs.chmodSync(target, 0o600);
    }
  }
}

export function prepare(root = '/prepare', inherited = process.env) {
  const env = inherited;
  const nodes = validatePrepareEnvironment(env);
  prepareDirectories(root, nodes);
  // 一次性容器可写宿主目录，配置文件不得借链接指向其他数据。
  for (const name of ['config.json', 'model-parameters.json', 'enabled-providers.json']) {
    let info;
    try { info = fs.lstatSync(path.join(root, '.data/gateway', name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('网关配置必须是普通文件，不能是链接。');
  }
  // Compose 提供有效环境值，不读取宿主 .env；生成器只写 env.XXX 引用。
  try { writeGatewayConfig(root, env, { readEnv: false }); }
  catch { throw new Error('网关配置生成失败，请检查模型配置与服务商环境变量；内容未显示。'); }
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv[2] === 'prepare') {
      prepare();
      console.log('必填配置、数据目录与网关配置已准备。');
    } else if (process.argv[2] === 'copy-identities') {
      copyNodeIdentities('/prepare-nodes', clusterNodes(loadEnvironment()));
      console.log('配置节点的部署身份已核对。');
    } else throw new Error('用法：node scripts/compose-init.mjs prepare|copy-identities。');
  } catch (error) {
    console.error(error.code ? '初始化失败，请核对数据目录与文件权限；内容未显示。' : error.message);
    process.exitCode = 1;
  }
}
