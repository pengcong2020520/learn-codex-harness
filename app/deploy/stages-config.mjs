// 仅在 app 的一次性容器内运行；把允许透传的模型参数与服务商 ID 写到共享目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enabledProviders, loadModelRegistry } from '../server/modules/gateway/index.mjs';

export function deploymentConfig(environment, registry) {
  return {
    modelEnvironment: Object.fromEntries(Object.entries(environment)
      .filter(([key, value]) => /^CODEX_MODEL_[A-Z0-9_]+$/.test(key) && typeof value === 'string' && value !== '')),
    providers: [...enabledProviders(registry, environment)],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const expected = path.resolve(root, '..', 'stages');
  if (path.resolve(process.env.CONTAINER_STAGES_DIR || expected) !== expected) {
    throw new Error('CONTAINER_STAGES_DIR 必须等于 CONTAINER_APP_DIR 的同级 stages 目录。');
  }
  const target = path.join(root, '.data/stages/config.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(deploymentConfig(process.env, loadModelRegistry(root))) + '\n', { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
  console.log('已生成阶段模型参数与服务商启用清单（不含服务商密钥）。');
}
