import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportTree, importTree } from '../server/modules/sharding/transfer.mjs';
import { prepareDirectories } from '../server/modules/runtimes/directories.mjs';
// No SSH or new library: exercise the real system tar with s14 uid ownership.
test('真实 Linux uid/tar：用户目录流式搬运，保留 0600 历史与数值 uid/gid，拒绝链接', {
 skip:process.platform!=='linux'||process.getuid?.()!==0,timeout:30000,
},async t=>{
 const roots=['source','target'].map(label=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'s17-transfer-'+label+'-'));fs.chmodSync(root,0o755);return root;});
 t.after(()=>roots.forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
 const id=randomUUID(),uid=10017;
 const records=roots.map(root=>({user_id:id,uid,codex_home:path.join(root,'.data/users',id,'codex')}));
 const dirs=roots.map((root,n)=>prepareDirectories(root,records[n],{isolated:true}));
 for(const [kind,key] of [['home','codexHome'],['workspace','workspaceDir']]){
  const file=path.join(dirs[0][key],'history.txt');fs.writeFileSync(file,'完整历史与记忆',{mode:0o600});fs.chownSync(file,uid,uid);
  const transfer=exportTree(roots[0],records[0],kind);
  try{await importTree(roots[1],records[1],kind,transfer.stream);await transfer.done;}finally{await transfer.stop();}
  const copy=path.join(dirs[1][key],'history.txt');assert.equal(fs.readFileSync(copy,'utf8'),'完整历史与记忆');assert.equal(fs.statSync(copy).uid,uid);assert.equal(fs.statSync(copy).gid,uid);assert.equal(fs.statSync(copy).mode&0o777,0o600);
 }
 fs.symlinkSync('/etc/passwd',path.join(dirs[0].codexHome,'forbidden-link'));
 const transfer=exportTree(roots[0],records[0],'home');transfer.stream.resume();await assert.rejects(transfer.done);await transfer.stop();
});
