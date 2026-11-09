import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { AgentClient, loadServerAddress, loadClientConnection } from './modules/connection/index.mjs';
import { saveCredentials, removeCredentials } from './modules/connection/credentials.mjs';
import { createPrompts } from '../shared/prompts.mjs';
import { PROJECT_ROOT } from '../shared/paths.mjs';

export async function authCommand(command, { root = PROJECT_ROOT, environment = process.env, prompts = createPrompts() } = {}) {
  try {
    if (command === 'login') {
      const url = loadServerAddress(environment, root);
      const username = await prompts.ask('用户名：');
      const password = await prompts.ask('密码：', { secret: true });
      const response = await fetch(url + '/auth/login', { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(response.status === 429 ? '登录过于频繁，请稍后重试。' : '登录失败，请检查用户名与密码。');
      saveCredentials(root, { url, token: result.token, expiresAt: result.expiresAt, user: result.user });
      return '已登录。';
    }
    if (command === 'logout') {
      await new AgentClient(loadClientConnection(environment, root)).request('/auth/logout', {});
      removeCredentials(root);
      return '已登出，该用户全部令牌已吊销。';
    }
    throw new Error('只接受 login 或 logout；用户名与密码从 stdin 输入。');
  } finally { prompts.close(); }
}
// Compare real paths: the entry may be reached through a symlinked directory.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.length !== 3) { console.error('不接受额外参数；密码只能从 stdin 输入。'); process.exitCode = 1; }
  else authCommand(process.argv[2]).then(result => console.log(result)).catch(() => { console.error('认证操作失败，请检查服务地址和输入；令牌失效请运行 npm run login 重新登录。'); process.exitCode = 1; });
}
