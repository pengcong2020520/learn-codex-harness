import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonJobs } from '../server/modules/data/index.mjs';
test('任务记录 JSON：重启保留待办，执行中任务隔离为未确认，不自动重发', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'s03-json-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'messages.json'),first=new JsonJobs(file);
  first.create({id:'a',threadId:'t1',text:'one'});first.create({id:'b',threadId:'t2',text:'two'});
  first.patch('a',{status:'running',turnId:'v1'},['queued']);
  const reopened=new JsonJobs(file);reopened.recover('restart');
  assert.equal(reopened.get('a').status,'unconfirmed');assert.equal(reopened.paused('t1'),true);
  assert.equal(reopened.get('b').status,'queued');assert.equal(reopened.paused('t2'),false);
  assert.equal(reopened.patch('a',{status:'running'},['queued']),false);
  assert.equal(new JsonJobs(file).get('a').status,'unconfirmed');
});

test('任务记录：重复 ID 与排队超限是明确的业务错误（409 / 429）', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobs = new JsonJobs(path.join(dir, 'messages.json'));
  const job = id => ({ id, threadId: 't', text: 'x', mode: 'enqueue', targetTurnId: null, createdAt: 0 });
  jobs.create(job('a'));
  assert.throws(() => jobs.create(job('a')), error => error.status === 409 && error.code === 'IDEMPOTENCY_CONFLICT');
  for (let i = 0; i < 99; i++) jobs.create(job(`b${i}`));
  assert.throws(() => jobs.create(job('c')), error => error.status === 429 && error.code === 'QUEUE_FULL');
});
