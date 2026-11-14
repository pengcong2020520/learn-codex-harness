import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { checkAgent } from './agent-check.mjs';
import { PROJECT_ROOT, isMain } from './quickstart-lib.mjs';

export function useAgent(requested, { root = PROJECT_ROOT, log = console.log } = {}) {
  if (!requested) throw new Error('用法：npm run agent:use -- <id 或 agent.json 路径>。');
  const relative = /^[a-z0-9-]{2,32}$/.test(requested) ? `agents/${requested}/agent.json` : requested;
  const selected = path.relative(root, path.resolve(root, relative));
  if (!selected || /['\r\n\0]/.test(selected)) throw new Error('Agent 路径含不支持的字符。');
  if (checkAgent(selected, { root }).some(row => row.level === 'error')) throw new Error('Agent 校验失败，未修改配置。请运行 npm run agent:check -- <agent.json 路径> 查看定位和改法。');
  const file = path.join(root, '.env'), temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error();
    const before = fs.readFileSync(fd), text = before.toString('utf8');
    if (!Buffer.from(text).equals(before)) throw new Error();
    const values = parseEnv(text), replacement = `AGENT_DEFINITION='${selected}'`;
    if (/[\r\n]/.test(values.AGENT_DEFINITION || '')) throw new Error();
    // 用 Node 自带解析器判断候选行是否在多行字符串内；不自行实现 dotenv 语法。
    const candidates = [...text.matchAll(/^[ \t]*(?:export[ \t]+)?AGENT_DEFINITION[ \t]*=[^\r\n]*/gm)].filter(match => {
      const probe = randomUUID();
      const changed = parseEnv(text.slice(0, match.index) + `AGENT_DEFINITION='${probe}'` + text.slice(match.index + match[0].length));
      return changed.AGENT_DEFINITION === probe && Object.keys(values).filter(key => key !== 'AGENT_DEFINITION').every(key => values[key] === changed[key]);
    });
    // 重复项会被 parseEnv 的最后一项覆盖，单独移除命中行后再核验是否还存在定义。
    const match = candidates[0];
    if (candidates.length > 1 || (match && Object.hasOwn(parseEnv(text.slice(0, match.index) + text.slice(match.index + match[0].length)), 'AGENT_DEFINITION'))) {
      throw new Error('重复');
    }
    if (!match && Object.hasOwn(values, 'AGENT_DEFINITION')) throw new Error();
    const ending = text.includes('\r\n') ? '\r\n' : '\n';
    const after = match ? text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length)
      : text + (text && !text.endsWith('\n') ? ending : '') + replacement + ending;
    const parsed = parseEnv(after);
    if (parsed.AGENT_DEFINITION !== selected || Object.keys(values).some(key => key !== 'AGENT_DEFINITION' && parsed[key] !== values[key])
      || Object.keys(parsed).some(key => key !== 'AGENT_DEFINITION' && !Object.hasOwn(values, key))) throw new Error();
    const out = fs.openSync(temporary, 'wx', 0o600);
    try {
      const owner = fs.fstatSync(out);
      if (owner.uid !== stat.uid || owner.gid !== stat.gid) fs.fchownSync(out, stat.uid, stat.gid);
      fs.fchmodSync(out, 0o600);
      fs.writeFileSync(out, after); fs.fsyncSync(out);
    } finally { fs.closeSync(out); }
    const current = fs.lstatSync(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw new Error();
    fs.renameSync(temporary, file);
  } catch (error) {
    if (error.message === '重复') throw new Error('.env 中 AGENT_DEFINITION 重复；请在终端保留一个定义后再运行。未写入文件。');
    throw new Error('切换失败，请确认 .env 是可读写的独立普通文件、配置为有效 UTF-8，且 AGENT_DEFINITION 为单行；配置未显示，结果待核对。');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
  log('Agent 已切换；下一步运行 npm run up，并新建会话验证。');
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：npm run agent:use -- <id 或 agent.json 路径>。');
    useAgent(process.argv[2]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
