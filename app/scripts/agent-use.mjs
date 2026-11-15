import path from 'node:path';
import { updateSelection } from './selection-env.mjs';
import { selectAgentFile } from '../server/modules/agents/selection.mjs';
import { checkAgent } from './agent-check.mjs';
import { PROJECT_ROOT, isMain } from './quickstart-lib.mjs';

export function useAgent(requested, { root = PROJECT_ROOT, log = console.log } = {}) {
  if (!requested) throw new Error('用法：npm run agent:use -- <id 或 agent.json 路径>。');
  const relative = /^[a-z0-9-]{2,32}$/.test(requested) ? `agents/${requested}/agent.json` : requested;
  const selected = path.relative(root, selectAgentFile(root, relative));
  if (!selected || /['\r\n\0]/.test(selected)) throw new Error('Agent 路径含不支持的字符。');
  if (checkAgent(selected, { root }).some(row => row.level === 'error')) throw new Error('Agent 校验失败，未修改配置。请运行 npm run agent:check -- <agent.json 路径> 查看定位和改法。');
  updateSelection(path.join(root, '.env'), 'AGENT_DEFINITION', selected);
  log('Agent 已切换；下一步运行 npm run up，并新建会话验证。');
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：npm run agent:use -- <id 或 agent.json 路径>。');
    useAgent(process.argv[2]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
