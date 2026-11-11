import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, identity } from '../server/modules/data/database.mjs';
import { Repository } from '../server/modules/data/repository.mjs';
import { Resources } from '../server/modules/data/resources.mjs';
import { createFileTools } from '../server/modules/data/files.mjs';
import { PermissionGate } from '../server/modules/permissions/index.mjs';
import { KnowledgeService } from '../server/modules/knowledge/index.mjs';
import { tempRoot, cleanup, until } from './helpers.mjs';

const databaseUrl = process.env.DATA_TEST_DATABASE_URL, redisUrl = process.env.DATA_TEST_REDIS_URL;
async function setup(t) {
  const root = tempRoot(t), pool = await openDatabase(databaseUrl); cleanup(root, () => pool.end()); await migrate(pool);
  const scope = identity(root); await new Repository(pool, scope).initialize();
  const agent = { definition: { agent: { id: 'fixture', knowledge: [{ kbId: 'a', mode: 'wiki', actions: ['read','update','index'] }] }, bindings: {
    knowledgeBases: { a: { sourceRoot: 'inputs/a', wikiRoot: 'research/a/wiki' }, b: { sourceRoot: 'inputs/b', wikiRoot: 'research/b/wiki' } }
  } }, assertCurrent() {}, sources: ['inputs','research','drafts','outputs'].map(locator => ({id:locator,locator,actions: locator==='inputs'?['read']:['read','create']})), outputs: { directory:'outputs',formats:['md','txt'] } };
  for (const area of ["inputs","research","drafts","outputs"]) fs.mkdirSync(path.join(root,"workspace",area),{recursive:true});
  const gate = new PermissionGate({ scope, agent }), files = createFileTools(root,{sources:agent.sources,outputs:agent.outputs});
  const resources = new Resources(pool,scope,{files,sources:agent.sources,outputs:agent.outputs,blobDir:path.join(root,'blobs'),gate});
  const knowledge = await new KnowledgeService(pool,scope,{agent,gate,resources}).open();
  for (const kb of ['a','b']) {fs.mkdirSync(path.join(files.workspace,'inputs',kb));fs.writeFileSync(path.join(files.workspace,'inputs',kb,'source.md'),`# ${kb}\n来源事实`);}
  const run = fn => gate.run(gate.operator(),fn);
  const source = await run(() => resources.read_file({path:'inputs/a/source.md'}));
  const refs=[{resourceId:source.resourceId,versionId:source.versionId}];
  return {root,pool,scope,agent,gate,resources,knowledge,run,refs,files};
}
test('真实 PG：Wiki 自动生效、并发版本冲突、隔离、来源失效与普通文件绕过拒绝', async t => {
  const r=await setup(t);
  delete r.agent.definition.bindings.knowledgeBases.b; // A different Agent need not even declare KB b.
  await r.knowledge.open();
  await r.run(async()=>{
    await assert.rejects(r.knowledge.read({kbId:'b',slug:'secret'}),/未授权/);
    await assert.rejects(r.resources.read_file({path:'inputs/b/source.md'}),/未授权/);
    const first=await r.knowledge.submit({kbId:'a',slug:'topic',content:'# 主题\n事实摘要',expectedVersion:null,source_versions:r.refs});
    assert.equal(first.effective,true);
    assert.equal((await r.knowledge.search({kbId:'a',query:'事实'})).hits.length,1);
    const outcomes=await Promise.allSettled(['一','二'].map(v=>r.knowledge.submit({kbId:'a',slug:'topic',content:'# 更新\n'+v,expectedVersion:first.versionId,source_versions:r.refs})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'VERSION_CONFLICT');
    await assert.rejects(r.resources.write_file({path:'research/a/wiki/fake.md',content:'# 假知识'}),/未授权/);
    fs.writeFileSync(path.join(r.files.workspace,'inputs/a/source.md'),'# 来源已变化');
    await assert.rejects(r.knowledge.read({kbId:'a',slug:'topic'}),/来源已变化/);
  });
  const otherGate=new PermissionGate({scope:{...r.scope,ownerId:randomUUID()},agent:r.agent});
  const other = new KnowledgeService(r.pool,{...r.scope,ownerId:randomUUID()},{agent:r.agent,gate:otherGate,resources:r.resources});
  await assert.rejects(otherGate.run(otherGate.operator(),()=>other.kb('a')),/不存在/);
});

test('知识 Web 接口底层：原文导入、不可覆盖、目录隔离、任务身份与 Wiki 列表', async t=>{
  const r=await setup(t);
  const imported=await r.run(()=>r.knowledge.importSource({kbId:'a',name:'new-notes.md',content:'# 新资料\n新增事实'}));
  assert.ok(imported.resourceId && imported.versionId);
  assert.equal(imported.path,'inputs/a/new-notes.md');
  await assert.rejects(r.run(()=>r.knowledge.importSource({kbId:'a',name:'new-notes.md',content:'替换'})),/已存在/);
  assert.match(fs.readFileSync(path.join(r.files.workspace,imported.path),'utf8'),/新增事实/);
  for(const name of ['../escape.md','/escape.md','bad.js','.hidden.md'])
    await assert.rejects(r.run(()=>r.knowledge.importSource({kbId:'a',name,content:'test'})),/文件名/);
  await assert.rejects(r.run(()=>r.knowledge.importSource({kbId:'b',name:'secret.md',content:'test'})),/未授权/);
  await assert.rejects(r.run(()=>r.knowledge.importSource({kbId:'a',name:'big.md',content:'x'.repeat(262145)})),/大小/);
  r.gate.start({id:'task',threadId:'thread'},[{type:'knowledge.update',kbId:'a'}]);r.gate.started('thread','turn');
  await assert.rejects(r.gate.run(r.gate.forTurn('thread','turn'),()=>r.knowledge.importSource({kbId:'a',name:'agent.md',content:'test'})),/只允许本地操作者/);
  r.gate.end('thread','turn');
  const page=await r.run(()=>r.knowledge.submit({kbId:'a',slug:'new-page',content:'# 页面\n事实',expectedVersion:null,source_versions:[{resourceId:imported.resourceId,versionId:imported.versionId}]}));
  const listed=await r.run(()=>r.knowledge.pages('a'));
  assert.equal(listed.pages[0].versionId,page.versionId);assert.equal(listed.truncated,false);
  await assert.rejects(r.run(()=>r.knowledge.pages('b')),/未授权/);
  const dir=path.join(r.files.workspace,'inputs/a');fs.renameSync(dir,dir+'-real');fs.symlinkSync(dir+'-real',dir);
  await assert.rejects(r.run(()=>r.knowledge.importSource({kbId:'a',name:'link.md',content:'test'})),/真实目录/);
});

test('真实 Chroma + PG + Redis：双索引提交、中文混合召回、切换需重启、失败保留旧索引', {timeout:60000,skip:!process.env.CHROMA_TEST_URL}, async t=>{
  const { createServer }=await import('node:http');
  const { createRag }=await import('../server/modules/knowledge/rag.mjs');
  const { KnowledgeWorker }=await import('../server/modules/knowledge/worker.mjs');
  const { createClient }=await import('redis');
  const r=await setup(t);
  const vectors=text=>text.includes('火星')?[0,1,0]:[1,0,0];
  const embeddingServer=createServer(async(req,res)=>{
    const blocks=[];for await (const chunk of req) blocks.push(chunk);
    const body=JSON.parse(Buffer.concat(blocks));
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({data:body.input.map((text,index)=>({index,embedding:vectors(text)}))}));
  });
  await new Promise(resolve=>embeddingServer.listen(0,'127.0.0.1',resolve));
  cleanup(r.root,()=>new Promise(resolve=>{embeddingServer.close(resolve);embeddingServer.closeAllConnections();}));
  const rag=await createRag({chromaUrl:process.env.CHROMA_TEST_URL,url:`http://127.0.0.1:${embeddingServer.address().port}`,model:'fixture-3d',dimensions:3},path.join(r.root,'bm25'));
  r.knowledge.rag=rag;r.agent.definition.agent.knowledge[0].mode='rag';await r.knowledge.open();
  fs.writeFileSync(path.join(r.files.workspace,'inputs/a/mars.md'),'# 火星\n火星探测和航天技术。');
  const redis=createClient({url:redisUrl});redis.on('error',()=>{});await redis.connect();cleanup(r.root,()=>redis.destroy());
  const worker=await new KnowledgeWorker(r.knowledge,redis).open();r.knowledge.worker=worker;cleanup(r.root,()=>worker.close());
  const queued=await r.run(()=>r.knowledge.enqueueIndex('a'));
  await until(async()=>['completed','failed'].includes((await r.run(()=>r.knowledge.job(queued.jobId))).state),30000);
  assert.equal((await r.run(()=>r.knowledge.job(queued.jobId))).state,'completed');
  assert.equal(r.knowledge.modes.a,'wiki','索引完成不能热切换正在运行的Agent');
  const reopened=await new KnowledgeService(r.pool,r.scope,{agent:r.agent,gate:r.gate,resources:r.resources,rag}).open();
  assert.equal(reopened.modes.a,'rag');
  const result=await r.run(()=>reopened.search({kbId:'a',query:'火星探测'}));
  assert.equal(result.mode,'rag');assert.match(result.hits[0].content,/火星/);
  const previous=result.indexRevision, original=rag.embeddings.generate;
  rag.embeddings.generate=()=>{throw new Error('simulated unavailable')};
  await assert.rejects(r.run(()=>rag.build(reopened,'a')),/unavailable/);
  assert.equal((await r.run(()=>reopened.kb('a'))).index_revision,previous);
  await assert.rejects(r.run(()=>reopened.search({kbId:'a',query:'火星'})),/unavailable/,'不能回退Wiki');
  rag.embeddings.generate=original;
  fs.writeFileSync(path.join(r.files.workspace,'inputs/a/mars.md'),'# 火星\n来源已修改');
  await assert.rejects(r.run(()=>reopened.search({kbId:'a',query:'火星'})),/来源已变化/);
});

test('迁移 v1 → v2 保留原数据，重复执行幂等，拒绝被改写的历史 migration', async t=>{
  const root=tempRoot(t), pool=await openDatabase(databaseUrl); cleanup(root,()=>pool.end());
  const schema=`upgrade_${randomUUID().replaceAll('-','')}`;
  // Run both revisions under an isolated schema in the disposable test database.
  const client=await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    const v1=fs.readFileSync(new URL('../server/modules/data/schema.sql',import.meta.url),'utf8').replaceAll('agent_data',schema);
    const v2=fs.readFileSync(new URL('../server/modules/data/migrations/002-knowledge.sql',import.meta.url),'utf8').replaceAll('agent_data',schema);
    await client.query(v1);
    const instance=randomUUID(),owner=randomUUID();
    await client.query(`INSERT INTO ${schema}.users(instance_id,id,name) VALUES($1,$2,'preserved-owner')`,[instance,owner]);
    await client.query(v2);
    assert.equal((await client.query(`SELECT name FROM ${schema}.users WHERE instance_id=$1 AND id=$2`,[instance,owner])).rows[0].name,'preserved-owner');
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='knowledge'`,[schema])).rows[0].n,1);
  } finally { await client.query(`DROP SCHEMA ${schema} CASCADE`);client.release(); }
  await migrate(pool);await migrate(pool);
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("UPDATE agent_data.migrations SET checksum='tampered' WHERE version=1");
    // Scoped pool adapter keeps verification inside this rollback-only transaction.
    const { verifySchema }=await import('../server/modules/data/database.mjs');
    await assert.rejects(verifySchema(db),/版本不匹配/);
  } finally {await db.query('ROLLBACK');db.release();}
});

test('真实 PG：visibility 迁移保留已有库、默认 private、拒绝非法值且可重复执行', async t => {
  const root = tempRoot(t), pool = await openDatabase(databaseUrl); cleanup(root, () => pool.end());
  const schema = `visibility_${randomUUID().replaceAll('-', '')}`, db = await pool.connect();
  const sql = name => fs.readFileSync(new URL(`../server/modules/data/${name}`, import.meta.url), 'utf8').replaceAll('agent_data', schema);
  try {
    await db.query(sql('schema.sql')); await db.query(sql('migrations/002-knowledge.sql'));
    const instance = randomUUID(), owner = randomUUID();
    await db.query(`INSERT INTO ${schema}.users(instance_id,id,name) VALUES($1,$2,'fixture')`, [instance, owner]);
    const insert = id => db.query(`INSERT INTO ${schema}.knowledge_bases(instance_id,id,owner_id,source_root,wiki_root) VALUES($1,$2,$3,'inputs/a','research/a/wiki') RETURNING visibility`, [instance, id, owner]);
    await db.query(`INSERT INTO ${schema}.knowledge_bases(instance_id,id,owner_id,source_root,wiki_root) VALUES($1,'existing',$2,'inputs/a','research/a/wiki')`, [instance, owner]);
    const migration = sql('migrations/009-knowledge-visibility.sql');
    await db.query(migration); await db.query(migration);
    assert.equal((await db.query(`SELECT visibility FROM ${schema}.knowledge_bases WHERE id='existing'`)).rows[0].visibility, 'private');
    assert.equal((await insert('created')).rows[0].visibility, 'private');
    for (const visibility of ['shared', '', 'SYSTEM'])
      await assert.rejects(db.query(`UPDATE ${schema}.knowledge_bases SET visibility=$1`, [visibility]), { code: '23514' });
    await assert.rejects(db.query(`UPDATE ${schema}.knowledge_bases SET visibility=NULL`), { code: '23502' });
    await db.query(`UPDATE ${schema}.knowledge_bases SET visibility='system'`);
    await db.query(migration);
    assert.equal((await db.query(`SELECT visibility FROM ${schema}.knowledge_bases WHERE id='existing'`)).rows[0].visibility, 'system');
  } finally { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); db.release(); }
  await migrate(pool); await migrate(pool);
  const r = await setup(t);
  assert.equal((await r.run(() => r.knowledge.list()))[0].visibility, 'private');
  for (const visibility of ['private', 'system']) {
    await r.pool.query('UPDATE agent_data.knowledge_bases SET visibility=$1 WHERE instance_id=$2', [visibility, r.scope.instanceId]);
    assert.equal((await r.run(() => r.knowledge.list()))[0].visibility, visibility);
    const otherScope = { ...r.scope, ownerId: randomUUID() }, otherGate = new PermissionGate({ scope: otherScope, agent: r.agent });
    const other = new KnowledgeService(r.pool, otherScope, { agent: r.agent, gate: otherGate, resources: r.resources });
    await assert.rejects(otherGate.run(otherGate.operator(), () => other.kb('a')), /不存在/);
  }
});
