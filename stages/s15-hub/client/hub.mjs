import fs from 'node:fs';
import path from 'node:path';
import { AgentClient, loadClientConnection } from './modules/connection/index.mjs';
import { skillFiles } from '../server/modules/agents/index.mjs';
import { validateUpload } from '../server/modules/hub/skills.mjs';
import { pathToFileURL } from 'node:url';
export async function runHub(argv = process.argv.slice(2), api = new AgentClient(loadClientConnection())) {
  const [command = 'hub', id, ...args] = argv;
  const encoded = encodeURIComponent(id || '');
  if (command === 'hub') return api.request('/hub');
  if (command === 'plan') return api.request('/me/plan');
  if (command === 'plan:assign' && args.length === 1) return api.request('/hub/plans/assign', { username: id, plan: args[0] });
  if (command === 'share' && args.length === 1) return api.request(`/hub/knowledge/${encoded}/grants`, { username: args[0] });
  if (command === 'unshare' && args.length === 1) return api.request(`/hub/knowledge/${encoded}/grants/${encodeURIComponent(args[0])}`, undefined, undefined, 'DELETE');
  if (command === 'grants') return api.request(`/hub/knowledge/${encoded}/grants`);
  if (command === 'publish') return api.request(`/hub/knowledge/${encoded}/publish`, {});
  if (command === 'unpublish') return api.request(`/hub/knowledge/${encoded}/publish`, undefined, undefined, 'DELETE');
  if (command === 'skill:upload' && args.length === 1) {
    const directory = fs.realpathSync(args[0]), files = {};
    for (const name of skillFiles(directory)) {
      const fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024) throw new Error('Skill 需要独立普通文本文件。');
        files[name] = fs.readFileSync(fd, 'utf8');
      } finally { fs.closeSync(fd); }
    }
    validateUpload({ name: id, files });
    return api.request('/hub/skills', { name: id, files });
  }
  if (command === 'skill:read') return api.request(`/hub/skills/${encoded}`);
  if (command === 'skill:share' && args.length) return api.request(`/hub/skills/${encoded}/share`, { usernames: args });
  if (command === 'skill:unshare' && args.length === 1) return api.request(`/hub/skills/${encoded}/grants/${encodeURIComponent(args[0])}`, undefined, undefined, 'DELETE');
  if (['skill:approve', 'skill:reject'].includes(command)) return api.request(`/hub/skills/${encoded}/${command.split(':')[1]}`, {});
  throw new Error('用法见 README：hub | plan | share | unshare | grants | publish | unpublish | skill:upload | skill:share | skill:approve | skill:reject | skill:unshare');
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  runHub().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
