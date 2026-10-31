import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonJobs } from '../server/modules/data/index.mjs';
test('Demo 3 JSON 持久队列：重启保留待办，执行中任务隔离为未确认，不自动重发', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'demo3-json-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'messages.json'),first=new JsonJobs(file);
  first.create({id:'a',threadId:'t1',text:'one'});first.create({id:'b',threadId:'t2',text:'two'});
  first.patch('a',{status:'running',turnId:'v1'},['queued']);
  const reopened=new JsonJobs(file);reopened.recover('restart');
  assert.equal(reopened.get('a').status,'unconfirmed');assert.equal(reopened.paused('t1'),true);
  assert.equal(reopened.get('b').status,'queued');assert.equal(reopened.paused('t2'),false);
  assert.equal(reopened.patch('a',{status:'running'},['queued']),false);
  assert.equal(new JsonJobs(file).get('a').status,'unconfirmed');
});
