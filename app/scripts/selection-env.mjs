import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';

export function updateSelection(file, key, value, mode = 0o600) {
  if (!['AGENT_DEFINITION', 'COMPOSE_PROFILES'].includes(key)) throw new Error('仅允许更新 Agent 与服务组合。');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error();
    const before = fs.readFileSync(fd), text = before.toString('utf8');
    if (!Buffer.from(text).equals(before)) throw new Error();
    const values = parseEnv(text), selected = typeof value === 'function' ? value(values[key] || '') : value;
    if (/['\r\n\0]/.test(selected)) throw new Error();
    const replacement = `${key}='${selected}'`;
    if (/[\r\n]/.test(values[key] || '')) throw new Error();
    // 用 Node 自带解析器判断候选行是否在多行字符串内；不自行实现 dotenv 语法。
    const candidates = [...text.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[^\\r\\n]*`, 'gm'))].filter(match => {
      const probe = randomUUID();
      const changed = parseEnv(text.slice(0, match.index) + `${key}='${probe}'` + text.slice(match.index + match[0].length));
      return changed[key] === probe && Object.keys(values).filter(k => k !== key).every(k => values[k] === changed[k]);
    });
    // 重复项会被 parseEnv 的最后一项覆盖，单独移除命中行后再核验是否还存在定义。
    const match = candidates[0];
    if (candidates.length > 1 || (match && Object.hasOwn(parseEnv(text.slice(0, match.index) + text.slice(match.index + match[0].length)), key))) {
      throw new Error('重复');
    }
    if (!match && Object.hasOwn(values, key)) throw new Error();
    const ending = text.includes('\r\n') ? '\r\n' : '\n';
    const after = match ? text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length)
      : text + (text && !text.endsWith('\n') ? ending : '') + replacement + ending;
    const parsed = parseEnv(after);
    if (parsed[key] !== selected || Object.keys(values).some(k => k !== key && parsed[k] !== values[k])
      || Object.keys(parsed).some(k => k !== key && !Object.hasOwn(values, k))) throw new Error();
    const out = fs.openSync(temporary, 'wx', 0o600);
    try {
      const owner = fs.fstatSync(out);
      if (owner.uid !== stat.uid || owner.gid !== stat.gid) fs.fchownSync(out, stat.uid, stat.gid);
      fs.fchmodSync(out, mode);
      fs.writeFileSync(out, after); fs.fsyncSync(out);
    } finally { fs.closeSync(out); }
    const current = fs.lstatSync(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw new Error();
    fs.renameSync(temporary, file);
  } catch (error) {
    if (error.message === '重复') throw new Error(`.env 中 ${key} 重复；请在终端保留一个定义后再运行。未写入文件。`);
    throw new Error(`切换失败，请确认配置是可读写的独立普通文件、配置为有效 UTF-8，且 ${key} 为单行；配置未显示，结果待核对。`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}
