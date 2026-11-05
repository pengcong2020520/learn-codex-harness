import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentClient, loadClientConnection } from '../client/modules/connection/index.mjs';
import { validateDefinition } from '../server/modules/agents/schema.mjs';
import { loadEnvironment } from '../server/modules/config/index.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const [command, kbId, ...rest] = process.argv.slice(2);
function directory(target) {
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('初始化目录不能是链接或普通文件。');
  } else { directory(path.dirname(target)); fs.mkdirSync(target, { mode: 0o700 }); }
}
try {
  if (command === 'init') {
    const env = loadEnvironment(root), file = path.resolve(root, env.AGENT_DEFINITION || 'agents/writing-agent.json');
    const definition = validateDefinition(JSON.parse(fs.readFileSync(file)));
    const workspace = path.resolve(path.dirname(file), definition.bindings.workspaceDir);
    directory(workspace);
    for (const [id, binding] of Object.entries(definition.bindings.knowledgeBases || {})) {
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || binding.sourceRoot !== `inputs/${id}` || binding.wikiRoot !== `research/${id}/wiki`) throw new Error('知识库路径无效。');
      directory(path.join(workspace, binding.sourceRoot)); directory(path.join(workspace, binding.wikiRoot));
    }
    const target = path.join(workspace,'.agents/skills/knowledge/SKILL.md'), source = fs.readFileSync(path.join(root,'skills/knowledge/SKILL.md'));
    directory(path.dirname(target));
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !fs.readFileSync(target).equals(source)) throw new Error('已有不同的 knowledge Skill，请核对后手工合并；未覆盖。');
    } else fs.writeFileSync(target, source, { flag:'wx',mode:0o600 });
    console.log('知识目录与原生 Skill 已准备。把原始 .md/.txt 放入 inputs/<kbId>/，然后启动服务。');
  } else {
    const client = new AgentClient(loadClientConnection());
    let result;
    if (command === 'list') result = await client.request('/knowledge');
    else if (command === 'read') result = await client.request(`/knowledge/read?kbId=${encodeURIComponent(kbId)}&slug=${encodeURIComponent(rest[0] || '')}`);
    else if (command === 'search') result = await client.request('/knowledge/search',{ kbId,query:rest.join(' ') });
    else if (command === 'index') result = await client.request('/knowledge/index',{ kbId });
    else if (command === 'job') result = await client.request(`/knowledge/job?id=${encodeURIComponent(kbId)}`);
    else if (command === 'maintain' && kbId && rest.join(' ').trim()) {
      const session = await client.request('/sessions',{});
      result = await client.request('/messages',{ threadId:session.id,clientMessageId:randomUUID(),text:rest.join(' '),knowledge:{kbId,operation:'update'} });
    } else throw new Error('用法：npm run knowledge -- list | read <kbId> <slug> | search <kbId> <问题> | maintain <kbId> <要求> | index <kbId> | job <jobId>');
    console.log(JSON.stringify(result,null,2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
