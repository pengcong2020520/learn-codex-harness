import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createUserFileTools } from '../server/modules/accounts/workspace.mjs';
import { prepareDirectories } from '../server/modules/runtimes/directories.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
import { createDesignTools } from '../server/modules/design/index.mjs';
import { readAsUser } from '../server/modules/runtimes/user-files.mjs';

test('设计产物：真实 uid 读取 0700/0600 HTML 和包，报告属主正确，跨用户与链接失败', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0 ? '需 Linux 容器与 SETUID/SETGID 能力' : false,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-uid-')); fs.chmodSync(root, 0o755);
  const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  const users = [owner, other].map((user, index) => prepareDirectories(root, { user_id: user, uid: 10001 + index, codex_home: path.join(root, '.data/users', user, 'codex') }, { isolated: true }));
  t.after(() => {
    for (const [index, user] of users.entries()) {
      // 边界父目录归 root；用户进程只清理内部内容。
      const inner = spawnSync(process.execPath, ['-e', "const fs=require('node:fs'),p=require('node:path');for(const n of fs.readdirSync(process.argv[1]))fs.rmSync(p.join(process.argv[1],n),{recursive:true,force:true})", user.workspaceDir], { uid: 10001 + index, gid: 10001 + index });
      assert.equal(inner.status, 0);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fileService = createUserFileTools(root, { workspaceDir: path.join(root, 'workspace'), sources: [{ locator: 'outputs', actions: ['read'] }], outputs: { directory: 'outputs' } });
  // 先准备边界目录，内部目录与文件只由用户进程创建。
  for (const user of [owner, other]) runOwner(user, () => fileService.workspace);
  const create = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
    process.umask(0o077);
    const base = path.join(process.argv[1], 'outputs/design/demo');
    fs.mkdirSync(path.join(base,'package-v1/agent'), {recursive:true});
    fs.writeFileSync(path.join(base,'page.html'), '<html>用户页面</html>', {mode:0o600});
    fs.writeFileSync(path.join(base,'package-v1/agent/agent.json'), '{}', {mode:0o600});
    fs.writeFileSync(path.join(base,'package-v1/manifest.json'), JSON.stringify({files:[{path:'agent/agent.json',sha256:createHash('sha256').update('{}').digest('hex')}]}), {mode:0o600});
    fs.symlinkSync('page.html',path.join(base,'link.html'));
  `, users[0].workspaceDir], { uid: 10001, gid: 10001 });
  assert.equal(create.status, 0, create.stderr?.toString());
  const tools = createDesignTools({ files: fileService, env: { AGENT_NODE_ID: 'node-a', AGENT_NODE_KEY: 'fixture-node-key-not-real' }, fetcher: async () => new Response(JSON.stringify({ status: 'completed', errors: 0, warnings: 0, issues: [] })) });
  await runOwner(owner, async () => {
    const listing = await fileService.list_files({ path: 'outputs/design' });
    assert.deepEqual(listing.entries.map(entry => entry.name), ['demo']);
    assert.equal(fs.statSync(path.join(users[0].workspaceDir, 'outputs/design')).mode & 0o777, 0o700);
    const result = await tools.check_design({ path: 'outputs/design/demo/page.html' });
    const report = path.join(users[0].workspaceDir, result.reportPath);
    const saved = await readAsUser(10001, report, { maxBytes: 4096, metadata: true });
    assert.match(saved.data.toString(), /completed/);
    await assert.rejects(readAsUser(10002, report, { maxBytes: 4096 }));
    await assert.rejects(tools.check_design({ path: 'outputs/design/demo/link.html' }));
    const pkg = await tools.check_agent_package({ path: 'outputs/design/demo/package-v1' });
    assert.ok(pkg.issues.some(i => i.code === 'agent-check'));
    assert.ok(!pkg.issues.some(i => i.code.startsWith('manifest') || i.code === 'package-read'));
  });
  await runOwner(other, () => assert.rejects(tools.check_design({ path: 'outputs/design/demo/page.html' })));
});
