import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { checkAgent } from '../../../scripts/agent-check.mjs';
import { resourcePath } from '../data/paths.mjs';
import { readLocalFile } from '../runtimes/user-files.mjs';
import { assertRealPath } from '../runtimes/directories.mjs';

const uiTypes = new Set(['html', 'js', 'mjs', 'css', 'svg', 'png', 'jpg', 'webp', 'woff2', 'json']);
const hostScript = /\.(?:sh|bash|zsh|fish|ksh|csh|ps1|psm1|psd1|bat|cmd|com|exe|vbs|py|pl|rb)$/i;
const external = value => {
  const normalized = value.replace(/[\u0000-\u0020]/g, '');
  // 基准域名只用于解析相对路径；任何显式域名或协议都不能借它冒充同源。
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(normalized) || normalized.includes('\\')) return true;
  try { return new URL(normalized, 'https://package.invalid/').origin !== 'https://package.invalid'; }
  catch { return true; }
};

export function checkAgentPackage(directory) {
  const issues = [], entries = new Map();
  const add = (code, file, reason, fix) => issues.push({ severity: 'error', code, file, reason, fix });
  const limit = file => file.startsWith('agent/ui/') ? 2 * 1024 * 1024 : 16 * 1024 * 1024;
  const read = file => readLocalFile(process.getuid(), path.join(directory, file), { maxBytes: limit(file) }).data;
  // 在调用 agent-check 前检查整个包；不沿包内链接读取角色、配置或 Skill。
  const walk = (relative = '') => {
    const target = path.join(directory, relative), stat = fs.lstatSync(target);
    if (!stat.isDirectory() && relative.startsWith('ui/')) add('ui-location', relative, '前端文件放在包根 ui/，落地后不会被 /app/ 提供', '把前端移到 agent/ui/，并在 agent.json 声明 ui.entry 为 ui/index.html');
    if (stat.isSymbolicLink() || stat.uid !== process.getuid()) { add('unsafe-file', relative, '目录或文件属主不匹配，或使用了符号链接。', '使用当前用户拥有的真实目录与独立普通文件。'); return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) {
        const child = relative ? `${relative}/${name}` : name;
        try { resourcePath(child); } catch { add('unsafe-path', child, '包内路径不安全。', '移除隐藏目录、上级路径、控制字符与特殊路径段。'); continue; }
        walk(child);
      }
    } else if (!stat.isFile() || stat.nlink !== 1) add('unsafe-file', relative, '包内含非普通文件或硬链接。', '改为当前用户的独立普通文件。');
    else if (stat.size > limit(relative)) add('file-size', relative, '文件超过读取上限。', '前端单文件不超过 2 MiB；其他文件不超过用户文件辅助进程的 16 MiB 上限。');
    else entries.set(relative, read(relative));
  };
  try { assertRealPath(directory); walk(); } catch { add('package-read', '', '代码包不能完整读取。', '检查目录、文件属主和读取权限。'); }
  const unsafe = issues.length > 0;

  let manifest;
  try { manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8')); if (!Array.isArray(manifest.files)) throw new Error(); }
  catch { manifest = null; add('manifest-format', 'manifest.json', '缺少有效的 files 数组。', '提供 files: [{path, sha256}]，列出除 manifest.json 自身外的全部文件。'); }
  const listed = new Set();
  for (const entry of manifest?.files || []) {
    try {
      resourcePath(entry?.path);
      if (entry.path === 'manifest.json' || listed.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) throw new Error();
    } catch { add('manifest-entry', 'manifest.json', '清单路径、SHA-256 无效或文件重复。', '使用唯一的包内相对路径及实际计算的 64 位小写 SHA-256，不列入 manifest 自身。'); continue; }
    listed.add(entry.path);
    const content = entries.get(entry.path);
    if (!content) add('manifest-missing', entry.path, '清单中的文件不存在或不能安全读取。', '补齐普通文件，或按实际包内容重新生成清单。');
    else if (createHash('sha256').update(content).digest('hex') !== entry.sha256) add('manifest-hash', entry.path, '文件内容与 SHA-256 不一致。', '完成修改后按最终文件字节重新计算 SHA-256。');
  }
  for (const [file, content] of entries) {
    if (file !== 'manifest.json' && !listed.has(file)) add('manifest-unlisted', file, '文件未列入清单。', '把文件路径和实际 SHA-256 加入 manifest.files。');
    if (hostScript.test(file) || /^#!\s*.*(?:\b(?:sh|bash|zsh|python\d*|perl|ruby|pwsh|node)\b)/.test(content.subarray(0, 256).toString())) add('host-script', file, '代码包包含宿主机脚本。', '移除安装、迁移或执行脚本；只使用脚手架自带的固定落地命令。');
    // ui.entry 相对 agent/agent.json，只有 agent/ui/ 的前端会由 /app/ 提供。
    if (!file.startsWith('agent/ui/')) continue;
    const type = path.extname(file).slice(1).toLowerCase();
    if (!uiTypes.has(type)) { add('ui-type', file, '前端文件类型不在 K2 白名单内。', '仅使用 html、js、mjs、css、svg、png、jpg、webp、woff2、json。'); continue; }
    const text = content.toString('utf8');
    if (['html', 'svg'].includes(type)) {
      const stack = [];
      const parser = new Parser({
        onopentag(name, attrs) {
          stack.push(name);
          if (name === 'style' || (name === 'script' && !attrs.src) || name === 'base' || (name === 'meta' && attrs['http-equiv']?.toLowerCase() === 'refresh')) add('ui-inline', file, `存在不允许的 ${name} 元素。`, '把脚本、样式放入包内独立 JS/CSS 文件，移除 base 与自动跳转。');
          for (const [key, value] of Object.entries(attrs)) {
            if (key === 'style' || key === 'srcdoc' || key.startsWith('on')) add('ui-inline', file, `存在内联 ${key} 属性。`, '将样式移入 CSS，将事件绑定移入 JS，移除 srcdoc。');
            if (['src', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'data', 'background', 'cite', 'manifest'].includes(key) && external(value)) add('ui-external', file, 'HTML/SVG 引用了外部或非同源资源。', '改为包内资源的相对路径，SDK 使用同源 /ui/modules/ 路径。');
            if (['srcset', 'imagesrcset', 'ping'].includes(key) && value.split(/[\s,]+/).some(part => external(part))) add('ui-external', file, '资源候选列表包含外部地址。', '所有候选资源均改为包内相对路径。');
          }
        },
        ontext(value) { if (stack.at(-1) === 'script' && value.trim()) add('ui-inline', file, 'script 元素包含内联正文。', '将正文移入包内独立 JS 文件。'); },
        onclosetag() { stack.pop(); },
      }, { decodeEntities: true });
      parser.end(text);
    }
    if (['css', 'js', 'mjs', 'svg'].includes(type) && /(?:\b(?:https?|wss?|ftp):|["'(`\s]\/\/[^\s/])/i.test(text)) add('ui-external', file, '前端源码含外部资源地址。', '将资源放入代码包，使用同源相对路径；不要依赖 CDN 或外部字体。');
    if (type === 'css') {
      for (const match of text.matchAll(/url\(\s*([^)]+)\)|@import\s+(["'][^"']*["'])/gi)) {
        const value = (match[1] || match[2]).trim().replace(/^["']|["']$/g, '');
        if (value.includes('\\') || external(value)) add('ui-external', file, 'CSS 资源地址不安全或含无法静态确认的转义。', '使用未转义的包内相对路径，移除外部 @import、字体和背景资源。');
      }
    }
  }

  if (!unsafe) {
    // 旧版 Skill 可相对 workspace 读取；包检查先收紧到包内，避免静态检查读取包外配置。
    let confined = true;
    try {
      const definition = JSON.parse(entries.get('agent/agent.json')?.toString('utf8'));
      if (definition.agent?.ui === undefined && [...entries.keys()].some(file => file.startsWith('agent/ui/'))) add('ui-undeclared', 'agent/agent.json', '包内有 agent/ui/ 前端文件，但未声明 agent.ui，前端不会被 /app/ 提供。', '在 agent.json 声明 agent.ui，并设置 entry 为 ui/index.html。');
      const workspace = path.resolve(directory, 'agent', definition.bindings.workspaceDir);
      for (const binding of Object.values(definition.bindings.skills || {})) {
        const file = path.resolve(definition.schemaVersion === '1.2' ? path.join(directory, 'agent') : workspace, binding.path);
        if (!file.startsWith(directory + path.sep)) confined = false;
      }
      // 配置中的 workspace 可以指向部署后目录；这里只允许空缺，不探查包外资料。
      if (definition.agent.dataBindings?.length && !(workspace === directory || workspace.startsWith(directory + path.sep))) confined = false;
    } catch { /* agent-check 负责报告定义结构错误。 */ }
    if (!confined) add('agent-path', 'agent/agent.json', 'Agent 静态检查会引用包外资源。', '把校验需要的 Skill 和资料目录放在包内，使用相对于包内工作区的绑定。');
    else {
      for (const row of checkAgent('agent/agent.json', { root: directory }).filter(row => row.level === 'error')) add('agent-check', 'agent/agent.json', `${row.title}：${row.detail}`, row.fix);
    }
  }
  return { ok: issues.length === 0, errors: issues.length, issues };
}
