// 复用 s11 生成器；临时根只提供模型清单，输出直接落入课程的持久目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { s11Root, courseRoot } from './s11-paths.mjs';
const { writeGatewayConfig } = await import(pathToFileURL(path.join(s11Root, 'scripts/gateway-config.mjs')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'course-gateway-'));
try {
  const data = path.join(courseRoot, '.data');
  fs.mkdirSync(data, { recursive: true });
  fs.symlinkSync(path.join(s11Root, 'config'), path.join(root, 'config'));
  fs.symlinkSync(data, path.join(root, '.data'));
  writeGatewayConfig(root);
  console.log('已生成课程网关配置。');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
