import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { userFileOperation, readAsUser } from '../server/modules/runtimes/user-files.mjs';
import { prepareDirectories } from '../server/modules/runtimes/directories.mjs';
if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('在 Linux uid 隔离验收容器运行，不在沙箱跳过后声称通过。');
test('Hub uid：同 uid 写入/读取/撤销 Skill，跨用户不能读取', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-replication-uid-'));fs.chmodSync(root,0o755);
  const owner=randomUUID(), grantee=randomUUID(), uid=10031, other=10032;
  const paths=prepareDirectories(root,{user_id:owner,uid,codex_home:path.join(root,'.data/users',owner,'codex')},{isolated:true});
  prepareDirectories(root,{user_id:grantee,uid:other,codex_home:path.join(root,'.data/users',grantee,'codex')},{isolated:true});
  const skill={id:'notes',source:'hub',files:['SKILL.md'],contents:{'SKILL.md':Buffer.from('# Notes').toString('base64')}};
  await userFileOperation(uid,'skills',{skills:[skill],codexHome:paths.codexHome});
  t.after(() => {
    // 服务 uid 没有 DAC_OVERRIDE；清理用户 0700 子目录也交给相同 uid。
    const child=spawnSync(process.execPath,['-e',"require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})",path.join(paths.codexHome,'skills')],{uid,gid:uid,cwd:'/',env:{PATH:'/usr/bin:/bin'}});
    assert.equal(child.status,0);fs.rmSync(root,{recursive:true,force:true});
  });
  const target=path.join(paths.codexHome,'skills/notes/SKILL.md');
  assert.throws(()=>fs.readFileSync(target),e=>e.code==='EACCES','生产服务 uid 不进入用户私有 Skill 目录');
  assert.equal((await readAsUser(uid,target,{isolated:true,maxBytes:128*1024})).toString(),'# Notes');
  await assert.rejects(readAsUser(other,target,{isolated:true,maxBytes:128*1024}));
  // Production does this in the owner helper even when the recipient runtime is not resident.
  await userFileOperation(uid,'skills',{skills:[],codexHome:paths.codexHome});
  await assert.rejects(readAsUser(uid,target,{isolated:true,maxBytes:128*1024}));
});
