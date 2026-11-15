// 维护时同步契约；生成文件随源码交付，浏览器与部署不需要构建或动态编译。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import standalone from 'ajv/dist/standalone/index.js';
import ucs2length from 'ajv/dist/runtime/ucs2length.js';
import equal from 'ajv/dist/runtime/equal.js';

export function validatorSource() {
  const directory = new URL('../agents/studio/skills/studio-contract/schemas/', import.meta.url);
  const ajv = new Ajv({ strict: true, allErrors: true, code: { source: true, esm: true } });
  const schemas = fs.readdirSync(directory).sort().map(file => JSON.parse(fs.readFileSync(new URL(file, directory), 'utf8')));
  for (const schema of schemas) ajv.addSchema(schema);
  const names = Object.fromEntries(schemas.map(schema => [path.basename(schema.$id, '.schema.json').replaceAll('-', '_'), schema.$id]));
  let code = standalone(ajv, names);
  // Ajv 的 standalone 运行时只有这两个纯函数，直接使用安装包源码，避免浏览器 require 或 eval。
  code = code.replaceAll('require("ajv/dist/runtime/ucs2length").default', 'ucs2length')
    .replaceAll('require("ajv/dist/runtime/equal").default', 'equal');
  if (/require\(/.test(code)) throw Error('新增了未打包的 Ajv 运行时依赖，请核对生成器。');
  return `// 由 scripts/studio-validators.mjs 根据 studio-contract 生成，请勿手工修改。\n${ucs2length.default.toString()}\nconst equal = ${equal.default.toString()};\n${code}\n`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(new URL('../agents/studio/ui/vendor/validators.mjs', import.meta.url), validatorSource());
}
