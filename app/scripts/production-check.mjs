import path from 'node:path';
import { checkProduction } from '../server/modules/deployment/production.mjs';
import { productionFileInputs } from '../server/modules/deployment/production-inputs.mjs';
import { PROJECT_ROOT, isMain } from './quickstart-lib.mjs';

export function checkProductionFiles({ root = PROJECT_ROOT, now = Date.now(), hostAppDir = process.env.HOST_APP_DIR } = {}) {
  return checkProduction(productionFileInputs({ root, now, hostAppDir })).items;
}

export function formatProductionChecks(rows) {
  const symbols = { ok: '✓', error: '✗', warning: '!' };
  return [...rows.map(row => `${symbols[row.level]} ${row.title}：${row.detail}\n  下一步：${row.fix}`),
    '本次仅做静态检查，不探测或启动服务。未检查：服务运行状态、真实登录、真实对话、DNS 与证书、Key 有效性、数据库连接、备份恢复和集群接管。'].join('\n');
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--root' || !args[1]?.trim() || args[1].startsWith('--'))) {
    console.error('用法：npm run production:check -- [--root <目录>]。'); process.exitCode = 1;
  } else {
    const rows = checkProductionFiles({ root: args.length ? path.resolve(args[1]) : PROJECT_ROOT });
    console.log(formatProductionChecks(rows));
    if (rows.some(row => row.level === 'error')) process.exitCode = 1;
  }
}
