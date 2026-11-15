import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  openDatabase,
  migrate,
  identity,
  acquireDatabaseLock,
} from "../server/modules/data/database.mjs";
import { Repository } from "../server/modules/data/repository.mjs";
import { MessageService } from "../server/modules/messages/index.mjs";
import { PostgresJobs } from "../server/modules/data/jobs.mjs";
import { Resources } from "../server/modules/data/resources.mjs";
import { RedisQueue } from "../server/modules/data/queue.mjs";
import { createFileTools } from "../server/modules/data/files.mjs";
import { requestScope, runOwner } from "../server/modules/accounts/context.mjs";
import { createUserFileTools } from "../server/modules/accounts/workspace.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { startAgentServer } from "./authenticated-server.mjs";
import { importLegacy } from "../server/modules/data/legacy.mjs";
import { createHash } from "node:crypto";
import {
  tempRoot,
  cleanup,
  installToolFixture,
  until,
  fixture,
} from "./helpers.mjs";
import {
  responsesFixture,
  answer,
  toolCall,
  toolSpecs,
} from "./responses-fixture.mjs";
const databaseUrl = process.env.DATA_TEST_DATABASE_URL,
  redisUrl = process.env.DATA_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl)
  throw new Error("请通过 npm run test:data 启动隔离服务。");
async function setup(t) {
  const root = tempRoot(t),
    pool = await openDatabase(databaseUrl);
  cleanup(root, () => pool.end());
  await migrate(pool);
  const scope = identity(root),
    repo = new Repository(pool, scope);
  await repo.initialize();
  await repo.saveAgent({ hash: "v1" });
  await repo.bind("thread-1", "v1", root);
  const jobs = new PostgresJobs(pool, scope);
  const sources = ["inputs", "research", "drafts", "outputs"].map(
    (locator) => ({
      id: locator,
      locator,
      actions: locator === "inputs" ? ["read"] : ["read", "create"],
    }),
  );
  const outputs = { directory: "outputs", formats: ["md", "txt"] };
  for (const area of ["inputs","research","drafts","outputs"]) fs.mkdirSync(path.join(root,"workspace",area),{recursive:true});
  const files = createFileTools(root, { sources, outputs });
  const resources = new Resources(pool, scope, {
    files,
    sources,
    outputs,
    blobDir: path.join(root, "blobs"),
  });
  return { root, pool, scope, repo, jobs, resources, files, sources, outputs };
}
const job = (id = "a") => ({
  id,
  threadId: "thread-1",
  text: "test",
  mode: "enqueue",
  targetTurnId: null,
  agentHash: "v1",
  createdAt: Date.now(),
});
test("真实 PG：迁移幂等、事务回滚、归属约束、单实例执行器锁", async (t) => {
  const r = await setup(t);
  await migrate(r.pool);
  const unlock = await acquireDatabaseLock(
    r.pool,
    r.scope.instanceId,
    () => {},
  );
  cleanup(r.root, unlock);
  await assert.rejects(
    acquireDatabaseLock(r.pool, r.scope.instanceId, () => {}),
    /已有执行器/,
  );
  const foreign = new Repository(r.pool, { ...r.scope, ownerId: randomUUID() });
  await assert.rejects(foreign.conversation("thread-1"), /未找到/);
  await assert.rejects(
    r.jobs.create({ ...job(), threadId: "unknown" }),
    /会话不存在/,
  );
  assert.equal((await r.jobs.list()).length, 0);
});
test("真实 PG + Redis：提交与 outbox 同事务、重复投递只领取一次、Redis 丢失可补投", async (t) => {
  const r = await setup(t);
  await r.jobs.create(job());
  assert.equal((await r.jobs.deliveries()).length, 1);
  const q = new RedisQueue(redisUrl, r.scope.instanceId, r.jobs);
  await q.open();
  cleanup(r.root, () => q.close());
  const delivered = [];
  q.deliver = (id) => delivered.push(id);
  q.onFatal = (error) => {
    throw error;
  };
  await q.tick();
  assert.deepEqual(delivered, ["thread-1"]);
  await q.client.sAdd(q.key, "thread-1");
  await q.client.sAdd(q.key, "thread-1");
  await q.tick();
  const claims = await Promise.all([
    r.jobs.patch("a", { status: "starting" }, ["queued"]),
    r.jobs.patch("a", { status: "starting" }, ["queued"]),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  await r.jobs.recover("crash");
  assert.equal((await r.jobs.get("a")).status, "unconfirmed");
  assert.equal(await r.jobs.paused("thread-1"), true);
  await r.jobs.create(job("b"));
  await r.jobs.pause("thread-1", false);
  await q.client.del(q.key);
  await q.tick();
  assert.ok(delivered.length >= 3);
  assert.equal((await r.jobs.get("a")).status, "unconfirmed");
});
test("真实文件 + PG：稳定 ID、版本更新、来源失效传播、路径与 ID 撤销一致", async (t) => {
  const r = await setup(t),
    original = path.join(r.files.workspace, "inputs/source.md");
  fs.writeFileSync(original, "v1");
  const first = await r.resources.read_file({ path: "inputs/source.md" });
  const wiki = await r.resources.write_file({
    path: "research/wiki.md",
    content: "derived",
    source_versions: [first],
  });
  const final = await r.resources.write_file({
    path: "outputs/final.md",
    content: "final",
    source_versions: [wiki.artifact],
  });
  fs.writeFileSync(original, "v2");
  const second = await r.resources.read_file({ path: "inputs/source.md" });
  assert.equal(first.resourceId, second.resourceId);
  assert.notEqual(first.versionId, second.versionId);
  await assert.rejects(r.resources.readById(wiki.artifact.resourceId), /stale/);
  await assert.rejects(
    r.resources.read_file({ path: "outputs/final.md" }),
    /stale/,
  );
  assert.equal(
    (await r.resources.get(final.artifact.resourceId)).state,
    "stale",
  );
  await r.resources.revoke(first.resourceId);
  await assert.rejects(r.resources.readById(first.resourceId), /revoked/);
  await assert.rejects(
    r.resources.read_file({ path: "inputs/source.md" }),
    /revoked/,
  );
  assert.equal(
    (await r.resources.list_files({ path: "inputs" })).entries.length,
    0,
  );
});
test("跨 owner / 收窄范围 / 越界 / 旧版本引用均拒绝；移动不改变资料 ID", async (t) => {
  const r = await setup(t);
  const ownerA = r.scope.ownerId, ownerB = randomUUID();
  r.scope = requestScope(r.scope.instanceId);
  await runOwner(ownerB, () => new Repository(r.pool, r.scope).initialize());
  r.files = createUserFileTools(r.root, {
    workspaceDir: path.join(r.root, "workspace"),
    sources: r.sources,
    outputs: r.outputs,
  });
  r.resources = new Resources(r.pool, r.scope, {
    files: r.files,
    sources: r.sources,
    outputs: r.outputs,
    blobDir: path.join(r.root, "blobs"),
  });
  await runOwner(ownerA, async () => {
    const write = await r.resources.write_file({
      path: "outputs/a.txt",
      content: "A",
    });
    const narrow = new Resources(r.pool, r.scope, {
      files: createFileTools(r.root, {
        workspaceDir: r.files.workspace,
        sources: [{ id: "inputs", locator: "inputs", actions: ["read"] }],
        outputs: r.outputs,
      }),
      sources: [{ id: "inputs", locator: "inputs", actions: ["read"] }],
      outputs: r.outputs,
      blobDir: path.join(r.root, "blobs"),
    });
    await assert.rejects(narrow.readById(write.artifact.resourceId), /未授权/);
    await runOwner(ownerB, async () => {
      const foreign = new Resources(r.pool, r.scope, {
        files: r.files,
        sources: r.sources,
        outputs: r.outputs,
        blobDir: path.join(r.root, "blobs"),
      });
      assert.equal(r.files.workspace, path.join(r.root, "workspace", "users", ownerB));
      await assert.rejects(foreign.read_file({ path: "outputs/a.txt" }), {
        status: 404, message: "资源不存在。",
      });
      await assert.rejects(foreign.readById(write.artifact.resourceId), {
        status: 404, code: "NOT_FOUND",
      });
      // readById 只按资源 ID 读取；资源/版本对走实际的引用解析方法。
      await assert.rejects(foreign.sourceVersion(write.artifact, 0, r.pool), {
        status: 404, code: "NOT_FOUND",
      });
    });
    await assert.rejects(r.resources.read_file({ path: "../.env" }), /未授权/);
    await assert.rejects(
      r.resources.write_file({
        path: "drafts/b.txt",
        content: "bad",
        source_versions: [
          { resourceId: write.artifact.resourceId, versionId: randomUUID() },
        ],
      }),
      /第 1 项：versionId 不属于这个资源.*号码抄错/,
    );
    fs.renameSync(
      path.join(r.files.workspace, "outputs/a.txt"),
      path.join(r.files.workspace, "outputs/moved.txt"),
    );
    await r.resources.relocate(write.artifact.resourceId, "outputs/moved.txt");
    assert.equal(
      (await r.resources.readById(write.artifact.resourceId)).content,
      "A",
    );
  });
});
test("写入中断留 pending，核对正确正文恢复，不覆盖现有文件", async (t) => {
  const r = await setup(t),
    finish = r.resources.finish.bind(r.resources);
  r.resources.finish = async () => {
    throw new Error("simulated DB outage");
  };
  await assert.rejects(
    r.resources.write_file({ path: "outputs/crash.txt", content: "safe" }),
    /outage/,
  );
  await assert.rejects(
    r.resources.read_file({ path: "outputs/crash.txt" }),
    /pending/,
  );
  r.resources.finish = finish;
  assert.equal((await r.resources.reconcile())[0].status, "ready");
  await assert.rejects(
    r.resources.write_file({ path: "outputs/crash.txt", content: "overwrite" }),
    /已存在/,
  );
  assert.equal(
    fs.readFileSync(path.join(r.files.workspace, "outputs/crash.txt"), "utf8"),
    "safe",
  );
});
test("对抗：直接读取派生内容也发现外部修改；来源删除后不返回旧正文", async (t) => {
  const r = await setup(t),
    file = path.join(r.files.workspace, "inputs/source.md");
  fs.writeFileSync(file, "first");
  const source = await r.resources.read_file({ path: "inputs/source.md" });
  const wiki = await r.resources.write_file({
    path: "research/wiki.md",
    content: "summary",
    source_versions: [source],
  });
  fs.writeFileSync(file, "changed-outside-agent");
  await assert.rejects(r.resources.readById(wiki.artifact.resourceId), /stale/);
  const changed = await r.resources.read_file({ path: "inputs/source.md" });
  const next = await r.resources.write_file({
    path: "research/wiki-v2.md",
    content: "new",
    source_versions: [changed],
  });
  fs.unlinkSync(file);
  await assert.rejects(
    r.resources.read_file({ path: "research/wiki-v2.md" }),
    /来源文件不可用/,
  );
  assert.equal(
    (await r.resources.get(next.artifact.resourceId)).state,
    "stale",
  );
});
test("对抗：Redis 投递失败保留 outbox，恢复后只执行可领取任务", async (t) => {
  const r = await setup(t);
  await r.jobs.create(job());
  const q = new RedisQueue(redisUrl, r.scope.instanceId, r.jobs);
  await q.open();
  cleanup(r.root, () => q.close());
  const commands = q.commands;
  let delivered = 0;
  q.deliver = () => delivered++;
  q.onFatal = (error) => {
    throw error;
  };
  q.commands = {
    async sAdd() {
      throw new Error("injected disconnect");
    },
  };
  await q.tick();
  assert.equal(q.healthy, false);
  assert.equal((await r.jobs.deliveries()).length, 1);
  q.commands = commands;
  await q.tick();
  assert.equal(delivered, 1);
  assert.equal(q.healthy, true);
});
test("旧 JSON 导入预检无写入，正式导入原子/幂等且不改原文件，冲突整体回滚", async (t) => {
  const r = await setup(t),
    body = {
      schemaVersion: "1.0",
      workspaceDir: r.files.workspace,
      agentId: "old",
    };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  fs.mkdirSync(path.join(r.root, ".data/agent-descriptors"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(r.root, ".data/agent-descriptors", hash + ".json"),
    JSON.stringify({ ...body, hash }),
  );
  fs.writeFileSync(
    path.join(r.root, ".data/thread-agents.json"),
    JSON.stringify({ "legacy-thread": hash }),
  );
  const messages = JSON.stringify({
    version: 1,
    jobs: [
      {
        ...job("legacy"),
        threadId: "legacy-thread",
        agentHash: hash,
        status: "running",
        turnId: "old-turn",
      },
    ],
    paused: [],
  });
  fs.writeFileSync(path.join(r.root, ".data/messages.json"), messages);
  assert.equal((await importLegacy(r.repo, r.root)).applied, false);
  assert.equal(await r.jobs.get("legacy"), undefined);
  await importLegacy(r.repo, r.root, { apply: true });
  await importLegacy(r.repo, r.root, { apply: true });
  assert.equal((await r.jobs.get("legacy")).status, "unconfirmed");
  assert.equal(await r.jobs.paused("legacy-thread"), true);
  assert.equal(
    fs.readFileSync(path.join(r.root, ".data/messages.json"), "utf8"),
    messages,
  );
  const changed = JSON.parse(messages);
  changed.jobs[0].text = "conflict";
  fs.writeFileSync(
    path.join(r.root, ".data/messages.json"),
    JSON.stringify(changed),
  );
  await assert.rejects(importLegacy(r.repo, r.root, { apply: true }), /回滚/);
  assert.equal((await r.jobs.get("legacy")).text, "test");
});
test(
  "生产主流程：真 PG/Redis/Codex/动态工具/文件，模拟模型；任务产物落库、重启续聊",
  { timeout: 60000 },
  async (t) => {
    const root = installToolFixture(tempRoot(t)),
      pool = await openDatabase(databaseUrl);
    await migrate(pool);
    await pool.end();
    let step = 0;
    const provider = await responsesFixture(root, (body) => {
      assert.ok(!JSON.stringify(body).includes(databaseUrl));
      if (step++ === 0)
        return toolCall(
          toolSpecs(body).find((s) => s.name.endsWith("write_file")),
          { path: "outputs/data-check.txt", content: "data-check" },
        );
      return answer("完成。");
    });
    const config = loadServerConfig(root, {
      ...fixture,
      CODEX_BASE_URL: provider.url,
      CODEX_MODEL_CATALOG_ENABLED: "true",
      CODEX_MODEL_CONTEXT_WINDOW: "128000",
      DEMO_TIMEOUT_MS: "15000",
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      AGENT_DB_PASSWORD: "database-password-fixture",
    });
    config.port = 0;
    assert.equal(config.launch.env.DATABASE_URL, undefined);
    assert.equal(config.launch.env.REDIS_URL, undefined);
    assert.equal(config.launch.env.AGENT_DB_PASSWORD, undefined);
    let app = await startAgentServer({ config, log: () => {} });
    cleanup(root, () => app.close());
    const thread = await app.sessions.create();
    const headers = {
      authorization: `Bearer ${app.token}`,
      "content-type": "application/json",
    };
    const accepted = await fetch(app.url + "/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        threadId: thread.id,
        clientMessageId: "persisted",
        text: "write",
      }),
    });
    assert.equal(accepted.status, 202);
    await until(
      async () =>
        ["completed", "failed", "unconfirmed"].includes(
          (await app.messages.job("persisted")).status,
        ),
      20000,
    );
    assert.equal((await app.messages.job("persisted")).status, "completed");
    assert.equal(
      (
        await app.data.repository.query(
          "SELECT * FROM agent_data.artifacts WHERE instance_id=$1 AND $2::uuid IS NOT NULL",
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await app.data.repository.query(
          "SELECT * FROM agent_data.notifications WHERE instance_id=$1 AND $2::uuid IS NOT NULL",
        )
      ).rowCount,
      1,
    );
    assert.equal(fs.existsSync(path.join(root, ".data/messages.json")), false);
    const saved = (
      await app.data.repository.query(
        "SELECT resource_id FROM agent_data.artifacts WHERE instance_id=$1 AND $2::uuid IS NOT NULL",
      )
    ).rows[0];
    assert.equal(
      (await fetch(app.url + "/resources/read?id=" + saved.resource_id)).status,
      401,
    );
    const read = await fetch(
      app.url + "/resources/read?id=" + saved.resource_id,
      { headers },
    );
    assert.equal((await read.json()).content, "data-check");
    const preference = await fetch(app.url + "/preferences", {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "style", value: "PREFERENCE_NOT_INJECTED" }),
    });
    assert.deepEqual(await preference.json(), {
      saved: true,
      injectedIntoContext: false,
    });
    await app.close();
    app = await startAgentServer({ config, log: () => {} });
    assert.ok((await app.sessions.list()).some((s) => s.id === thread.id));
    await app.sessions.ensure(thread.id);
    await app.messages.submit({
      threadId: thread.id,
      clientMessageId: "persisted",
      text: "write",
    });
    assert.equal(step, 2, "同 ID 重发不能再次调用模型");
    await app.messages.submit({
      threadId: thread.id,
      clientMessageId: "next",
      text: "continue",
    });
    await until(
      async () => (await app.messages.job("next")).status === "completed",
      20000,
    );
    assert.equal(step, 3);
    assert.ok(
      !JSON.stringify(provider.requests).includes("PREFERENCE_NOT_INJECTED"),
    );
    assert.deepEqual(provider.errors, []);
  },
);

test('升级预检登记描述符但不消费队列、不恢复执行状态、不发布 HTTP、不请求模型', {timeout:30000}, async t=>{
 const root=installToolFixture(tempRoot(t)),pool=await openDatabase(databaseUrl);
 await migrate(pool);await pool.end();
 const provider=await responsesFixture(root,()=>answer('unexpected model request'));
 const config=loadServerConfig(root,{...fixture,CODEX_BASE_URL:provider.url,CODEX_MODEL_CATALOG_ENABLED:'true',CODEX_MODEL_CONTEXT_WINDOW:'128000',DATABASE_URL:databaseUrl,REDIS_URL:redisUrl,DEMO_TIMEOUT_MS:'15000'});config.port=0;
 let app=await startAgentServer({config,validationOnly:true,log:()=>{}});cleanup(root,()=>app.close());
 const thread=await app.sessions.create();
 for(const id of ['queued-preflight','running-preflight'])await app.data.jobs.create({id,threadId:thread.id,text:'do not execute',mode:'enqueue',targetTurnId:null,createdAt:Date.now(),agentHash:app.agent.descriptor.hash});
 await app.data.jobs.patch('running-preflight',{status:'running'},['queued']);
 await app.close();app=await startAgentServer({config,validationOnly:true,log:()=>{}});
 assert.equal(app.url,undefined);assert.equal(app.messages,undefined);assert.ok(app.agent.descriptor.hash);
 assert.equal((await app.data.jobs.get('queued-preflight')).status,'queued');
 assert.equal((await app.data.jobs.get('running-preflight')).status,'running');
 assert.equal(provider.requests.length,0);
});

test("真实 PG：迁移 003 把旧的知识维护任务转换为 knowledge-maintain，并接受 needs-review", async (t) => {
  const admin = await openDatabase(databaseUrl);
  const name = `migration_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const pool = await openDatabase(url.toString());
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); });
  // 只执行到 002，模拟升级前的数据库。
  for (const [version, file] of [[1, "schema.sql"], [2, "migrations/002-knowledge.sql"]]) {
    const sql = fs.readFileSync(new URL(`../server/modules/data/${file}`, import.meta.url), "utf8");
    await pool.query(sql);
    await pool.query("INSERT INTO agent_data.migrations VALUES($1,$2)", [version, createHash("sha256").update(sql).digest("hex")]);
  }
  const instance = randomUUID(), owner = randomUUID();
  await pool.query("INSERT INTO agent_data.users VALUES($1,$2,'owner')", [instance, owner]);
  await pool.query("INSERT INTO agent_data.conversations(instance_id,id,owner_id,cwd) VALUES($1,'t',$2,'/w')", [instance, owner]);
  const insert = (id, knowledge) => pool.query(
    `INSERT INTO agent_data.tasks(instance_id,id,thread_id,text,mode,status,created_at,knowledge) VALUES($1,$2,'t','x','enqueue','completed',1,$3)`,
    [instance, id, knowledge]);
  await insert("legacy-maintain", { kbId: "general", operation: "update" });
  await insert("legacy-chat", null);
  await migrate(pool);
  const rows = (await pool.query("SELECT id,workflow,params FROM agent_data.tasks ORDER BY id")).rows;
  assert.deepEqual(rows, [
    { id: "legacy-chat", workflow: "chat", params: null },
    { id: "legacy-maintain", workflow: "knowledge-maintain", params: { kbId: "general" } },
  ]);
  await pool.query("UPDATE agent_data.tasks SET status='needs-review',checks=$2 WHERE id=$1", ["legacy-chat", JSON.stringify([{ id: "format", passed: false }])]);
  assert.deepEqual((await pool.query("SELECT step,note FROM agent_data.tasks WHERE id='legacy-maintain'")).rows[0], { step: 0, note: null }, "迁移 004：旧任务停在第 0 步");
  await pool.query("UPDATE agent_data.tasks SET status='waiting' WHERE id='legacy-maintain'");
  await pool.query("UPDATE agent_data.tasks SET status='cancelled' WHERE id='legacy-maintain'");
  await assert.rejects(pool.query("UPDATE agent_data.tasks SET status='unknown' WHERE id='legacy-chat'"), /tasks_status_check/);
});

test("真实 PG：多步任务的 step、note、checks 读写；等待确认的任务不被恢复逻辑改写", async (t) => {
  const r = await setup(t);
  await r.jobs.create({ ...job("steps"), workflow: "article", params: null, step: 0 });
  assert.equal((await r.jobs.get("steps")).step, 0);
  assert.equal(await r.jobs.patch("steps", { status: "running" }, ["queued"]), true);
  const checks = [{ id: "file-exists", passed: true }];
  assert.equal(await r.jobs.patch("steps", { status: "waiting", checks }, ["running"]), true);
  await r.jobs.recover("重启");
  assert.equal((await r.jobs.get("steps")).status, "waiting", "等待确认不是执行中，重启后保持原样");
  assert.equal(await r.jobs.patch("steps", { status: "queued", step: 1, note: "按第二版写" }, ["waiting"]), true);
  const row = await r.jobs.get("steps");
  assert.deepEqual([row.status, row.step, row.note, row.workflow, row.checks], ["queued", 1, "按第二版写", "article", checks]);
  assert.equal(await r.jobs.patch("steps", { status: "queued", step: 2 }, ["waiting"]), false, "只有等待确认的任务能被确认");
});


test("真实 PG：迁移 006 用量持久化、按时区汇总与实例/owner 隔离", async t => {
  const { UsageService } = await import("../server/modules/usage/index.mjs");
  const { budgetConfig } = await import("../server/modules/usage/config.mjs");
  const r = await setup(t), now = Date.parse("2026-11-03T12:00:00Z");
  const registry = { currency: "CNY", models: { "example/model": { pricing: { input: 2, output: 4 } } } };
  const options = { pool: r.pool, scope: r.scope, registry, now: () => now, budget: budgetConfig({ AGENT_BUDGET_TIMEZONE: "Asia/Shanghai", AGENT_BUDGET_DAILY_TOKENS: "10" }) };
  const usage = new UsageService(options);
  await usage.record({ source: "chat", model: "example/model", inputTokens: 8, outputTokens: 2, cachedInputTokens: 4, reasoningOutputTokens: 1,
    taskId: "usage-task", threadId: "thread-1", turnId: "turn-1" });
  await usage.record({ source: "image", model: "example/image", units: 2 });
  await usage.record({ source: "embedding", model: "example/embed", inputTokens: 100, createdAt: Date.parse("2026-11-02T15:59:59Z") });
  const restarted = new UsageService(options), today = await restarted.summary(), month = await restarted.summary("month");
  assert.equal(today.storage, "postgres"); assert.equal(today.total.totalTokens, 10); assert.equal(month.total.totalTokens, 110);
  assert.equal(today.total.estimatedCost, 0.000024); assert.equal(today.total.unpricedRequests, 1);
  assert.equal(today.budget.exceeded, true); assert.equal(today.bySource.find(row => row.source === "image").units, 2);
  assert.deepEqual(month.byDay.map(row => row.day), ["2026-11-02", "2026-11-03"]);
  const stored = (await r.pool.query("SELECT thread_id,turn_id,task_id FROM agent_data.usage WHERE instance_id=$1 AND source='chat'", [r.scope.instanceId])).rows[0];
  assert.deepEqual(stored, { thread_id: "thread-1", turn_id: "turn-1", task_id: "usage-task" });
  for (const scope of [{ ...r.scope, ownerId: randomUUID() }, { ...r.scope, instanceId: randomUUID() }])
    assert.equal((await new UsageService({ ...options, scope }).summary()).total.requests, 0);
});

// 媒体集成测试只使用本地假网关，不访问真实生成服务。
test('真实 PG：二进制不可变版本、create-only、格式/目录/门禁与中断恢复', async t => {
  const { png, mp4 } = await import('./media-fixture.mjs');
  const { PermissionGate } = await import('../server/modules/permissions/index.mjs');
  const r = await setup(t);
  r.outputs.formats.push('png','mp4');
  const agent = { definition: { agent: { id: 'media-test' }, bindings: {} }, outputs: r.outputs, sources: r.sources, assertCurrent() {}, allowsTool: () => true };
  const gate = new PermissionGate({ scope: r.scope, agent }); r.resources.gate = gate;
  const run = fn => gate.run(gate.operator(), fn);
  const result = await run(() => r.resources.write_binary({ path: 'outputs/media/test.png', content: png }));
  const read = await run(() => r.resources.readById(result.artifact.resourceId));
  assert.deepEqual(read.content, png); assert.equal(read.versionId, result.artifact.versionId);
  const version = (await r.repo.query('SELECT * FROM agent_data.resource_versions WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL', [read.versionId])).rows[0];
  assert.equal(version.bytes, png.length); assert.match(version.blob, /\.bin$/);
  await assert.rejects(run(() => r.resources.write_binary({ path: result.path, content: png })), /已存在/);
  await assert.rejects(run(() => r.resources.write_binary({ path: 'research/test.png', content: png })), /outputs/);
  await assert.rejects(run(() => r.resources.write_binary({ path: 'outputs/test.webp', content: png })), /格式/);
  await assert.rejects(r.resources.write_binary({ path: 'outputs/denied.png', content: png }), /未授权/);
  const operationId = randomUUID(), args = { path: 'outputs/media/resume.mp4', content: mp4, operationId };
  const original = r.resources.finish.bind(r.resources);
  r.resources.finish = () => { throw new Error('模拟写完文件后崩溃'); };
  await assert.rejects(run(() => r.resources.write_binary(args)), /模拟/);
  r.resources.finish = original;
  const resumed = await run(() => r.resources.write_binary(args));
  assert.equal(resumed.artifact.resourceId, operationId);
  const again = await run(() => r.resources.write_binary(args));
  assert.deepEqual(again, resumed);
  const versions = await r.repo.query('SELECT * FROM agent_data.resource_versions WHERE instance_id=$1 AND resource_id=$3 AND $2::uuid IS NOT NULL', [operationId]);
  assert.equal(versions.rowCount, 1);
  await assert.rejects(run(() => r.resources.write_binary({ ...args, content: Buffer.concat([mp4, Buffer.from('changed')]) })), /预留版本不同/);
});

test('真实 PG + 假 HTTP：重启继续视频任务、产物落盘后恢复、记账去重与归属隔离', async t => {
  const http = await import('node:http');
  const { MediaService } = await import('../server/modules/media/index.mjs');
  const { MediaJobs } = await import('../server/modules/media/store.mjs');
  const { UsageService } = await import('../server/modules/usage/index.mjs');
  const { PermissionGate } = await import('../server/modules/permissions/index.mjs');
  const { createModelRouter } = await import('../server/modules/gateway/router.mjs');
  const { registry, mp4 } = await import('./media-fixture.mjs');
  const r = await setup(t); r.outputs.formats.push('mp4');
  let posts = 0, completed = false;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* 消费请求体。 */ }
    if (req.method === 'POST') { posts++; res.end(JSON.stringify({ id: 'remote-persisted' })); }
    else if (req.url.endsWith('/content')) res.end(mp4);
    else res.end(JSON.stringify({ status: completed ? 'completed' : 'queued' }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup(r.root, () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const agent = { definition: { agent: { id: 'media-test' }, bindings: {} }, sources: r.sources, outputs: r.outputs, assertCurrent() {}, allowsTool: () => true };
  const gate = new PermissionGate({ scope: r.scope, agent }); r.resources.gate = gate;
  const options = { endpoint: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-bf-test-only' },
    router: createModelRouter(registry, { ARK_API_KEY: 'test-only' }), store: new MediaJobs(r.pool,r.scope), files: r.resources, gate, agent,
    usage: new UsageService({ pool: r.pool, scope: r.scope, registry }) };
  const first = new MediaService(options);
  const job = await gate.run(gate.operator(), () => first.generateVideo({ prompt: 'test' }, { context: { threadId: 'thread-1', turnId: 'turn-1', taskId: 'task' } }));
  await first.close(); completed = true;
  const store = new MediaJobs(r.pool, r.scope), persisted = await store.get(job.id);
  assert.equal(persisted.providerId, 'remote-persisted');
  const ownerB = randomUUID(), scope = requestScope(r.scope.instanceId);
  await runOwner(ownerB, () => new Repository(r.pool, scope).initialize());
  const userStore = new MediaJobs(r.pool, scope);
  const userMedia = new MediaService({ ...options, store: userStore });
  cleanup(r.root, () => userMedia.close());
  assert.equal((await runOwner(r.scope.ownerId, () => userMedia.status(job))).id, job.id);
  await runOwner(ownerB, async () => {
    // pending() 是实例级后台枚举，非用户接口；恢复循环随后逐个 runOwner(job.ownerId)。
    // rg -n '\.pending\s*\(' app/server 仅匹配 media/index.mjs 的恢复循环。
    assert.deepEqual(await userStore.pending(), [{ ...persisted, ownerId: r.scope.ownerId }]);
    assert.equal(await userStore.get(job.id), undefined);
    // tools/media.mjs 的 media_status 调用 MediaService.status()，后者通过 get() 按 owner 查询。
    await assert.rejects(userMedia.status(job), {
      status: 404, message: '媒体任务不存在或无权访问。',
    });
    const otherInstance = new MediaJobs(r.pool, requestScope(randomUUID()));
    assert.equal(await otherInstance.get(job.id), undefined);
    assert.deepEqual(await otherInstance.pending(), []);
  });
  // 模拟进程在文件版本已确认、任务完成状态尚未写入时退出。
  await gate.run(gate.media(persisted), () => r.resources.write_binary({ path: persisted.path, content: mp4, operationId: job.id }));
  await options.usage.record({ source: 'video', model: persisted.model, units: 5, eventKey: `video:${job.id}` });
  const usage = new UsageService({ pool: r.pool, scope: r.scope, registry });
  const resumed = new MediaService({ ...options, store, usage }); cleanup(r.root, () => resumed.close());
  await resumed.tick();
  assert.equal((await resumed.status(job)).status, 'completed'); assert.equal(posts, 1);
  assert.deepEqual(fs.readFileSync(path.join(r.files.workspace, persisted.path)), mp4);
  assert.equal((await usage.summary()).total.requests, 1); assert.equal((await usage.summary()).total.estimatedCost, 0.5);
});

test("真实 PG：路径与 ID 混合引用保存当前版本，逐项区分错误并回滚", async t => {
  const r = await setup(t);
  fs.writeFileSync(path.join(r.files.workspace, "inputs/path-source.md"), "v1");
  fs.writeFileSync(path.join(r.files.workspace, "inputs/other-source.md"), "other");
  const first = await r.resources.read_file({ path: "inputs/path-source.md" });
  const other = await r.resources.read_file({ path: "inputs/other-source.md" });
  const output = await r.resources.write_file({ path: "outputs/mixed.md", content: "mixed", source_versions: [
    { path: first.path }, { resourceId: other.resourceId, versionId: other.versionId }, { path: first.path },
  ] });
  const deps = (await r.repo.query("SELECT source_id,source_version FROM agent_data.dependencies WHERE instance_id=$1 AND derived_id=$3 AND $2::uuid IS NOT NULL", [output.artifact.resourceId])).rows;
  assert.equal(deps.length, 2);
  assert.ok(deps.some(dep => dep.source_id === first.resourceId && dep.source_version === first.versionId));
  fs.writeFileSync(path.join(r.files.workspace, first.path), "v2");
  const current = await r.resources.read_file({ path: first.path });
  const updated = await r.resources.write_file({ path: "outputs/current.md", content: "current", source_versions: [{ path: first.path }] });
  const latest = (await r.repo.query("SELECT source_version FROM agent_data.dependencies WHERE instance_id=$1 AND derived_id=$3 AND $2::uuid IS NOT NULL", [updated.artifact.resourceId])).rows[0];
  assert.equal(latest.source_version, current.versionId);
  for (const [reference, reason] of [
    [{ path: "inputs/missing.md" }, /路径不存在/],
    [{ path: "private/source.md" }, /没有读权限/],
    [{ resourceId: randomUUID(), versionId: randomUUID() }, /resourceId 不存在.*号码抄错/],
    [{ resourceId: first.resourceId, versionId: randomUUID() }, /versionId 不属于.*号码抄错/],
    [{ resourceId: first.resourceId, versionId: other.versionId }, /versionId 不属于.*号码抄错/],
    [{ resourceId: first.resourceId, versionId: first.versionId }, /版本已过期.*重新读取/],
  ]) {
    await assert.rejects(r.resources.write_file({ path: "outputs/rejected.md", content: "rejected", source_versions: [{ path: other.path }, reference] }), error => {
      assert.match(error.message, /source_versions 第 2 项：/); assert.match(error.message, reason); return true;
    });
    assert.equal(await r.resources.row("outputs/rejected.md"), undefined);
    assert.equal(fs.existsSync(path.join(r.files.workspace, "outputs/rejected.md")), false);
  }
  await r.resources.revoke(other.resourceId);
  for (const directory of ["inputs", "inputs/", "./inputs", "./inputs/"])
    assert.deepEqual((await r.resources.list_files({ path: directory })).entries.map(entry => entry.name), ["path-source.md"]);
});

test("真实 PG：任务模型选择与路由决策持久化，旧任务默认留空", async t => {
  const r = await setup(t);
  await r.jobs.create({ ...job('routing'), model: 'strong' });
  await r.jobs.patch('routing', { status: 'starting', selectedModel: 'kimi/kimi-k2.7-code', modelSource: '预算降级：场景 fast' }, ['queued']);
  const reopened = new PostgresJobs(r.pool, r.scope);
  const stored = await reopened.get('routing');
  assert.equal(stored.model, 'strong');
  assert.equal(stored.selectedModel, 'kimi/kimi-k2.7-code');
  assert.equal(stored.modelSource, '预算降级：场景 fast');
  assert.equal((await reopened.list('thread-1'))[0].selectedModel, stored.selectedModel);
  await reopened.create(job('default-model'));
  const plain = await reopened.get('default-model');
  assert.equal(plain.model, null); assert.equal(plain.selectedModel, null); assert.equal(plain.modelSource, null);
});


test("真实 PG：修改当前步持久化、重启保留计数、十次上限、跨用户和跨会话隔离", async t => {
  const r = await setup(t);
  await r.jobs.create({ ...job("revise"), workflow: "article" });
  await r.repo.bind("thread-2", "v1", r.root);
  const service = (store, repository) => Object.assign(Object.create(MessageService.prototype), {
    config: {}, store, locks: new Map(), sessions: { ensure: id => repository.conversation(id) },
    resolve: () => ({ steps: [{ id: "outline" }, { id: "final" }] }),
    publish: async () => {}, wake: async () => {},
  });
  let messages = service(r.jobs, r.repo);
  const args = { threadId: "thread-1", taskId: "revise", text: "调整层级" };
  const asOwner = operation => runOwner(r.scope.ownerId, operation);
  await assert.rejects(asOwner(() => messages.revise(args)), { status: 409 });
  await r.jobs.patch("revise", { status: "waiting" });
  await assert.rejects(asOwner(() => messages.revise({ ...args, threadId: "thread-2" })), { status: 404 });
  const foreignScope = { ...r.scope, ownerId: randomUUID() };
  // 固定属主仓储仍能读到任务时，服务层也必须拒绝非属主身份。
  await assert.rejects(runOwner(foreignScope.ownerId, () => messages.revise(args)), { status: 404 });
  const foreignRepo = new Repository(r.pool, foreignScope), foreignJobs = new PostgresJobs(r.pool, foreignScope);
  await foreignRepo.initialize(); await foreignRepo.bind("foreign-thread", "v1", r.root);
  const foreign = service(foreignJobs, foreignRepo);
  await assert.rejects(runOwner(foreignScope.ownerId, () => foreign.revise(args)), { status: 404 });
  await assert.rejects(runOwner(foreignScope.ownerId, () => foreign.revise({ ...args, threadId: "foreign-thread" })), { status: 404 });
  r.jobs.maxQueued = 0;
  await assert.rejects(asOwner(() => messages.revise(args)), { status: 429 });
  assert.equal((await r.jobs.get("revise")).reviseCount, 0, "排队失败时计数与意见不提交");
  r.jobs.maxQueued = 200;
  for (let n = 1; n <= 10; n++) {
    const row = await asOwner(() => messages.revise(args));
    assert.deepEqual([row.status, row.step, row.reviseCount, row.note], ["queued", 0, n, "调整层级"]);
    assert.ok((await r.jobs.deliveries()).some(row => row.thread_id === "thread-1"), "重做与 outbox 同事务唤醒");
    const restarted = new PostgresJobs(r.pool, r.scope);
    assert.equal((await restarted.get("revise")).reviseCount, n);
    await restarted.patch("revise", { status: "waiting" }, ["queued"]);
    await restarted.recover("重启");
    assert.equal((await restarted.get("revise")).status, "waiting");
    messages = service(restarted, r.repo);
  }
  await assert.rejects(asOwner(() => messages.revise(args)), { status: 409, message: "本步已重做 10 次，请确认继续或结束任务" });
  const row = await asOwner(() => messages.confirm({ threadId: "thread-1", taskId: "revise", text: "继续" }));
  assert.deepEqual([row.step, row.reviseCount, row.note], [1, 0, "继续"]);
  await assert.rejects(r.jobs.patch("revise", { reviseCount: 11 }));
});

test('真实 PG：附件迁移、落库、重新连接和任务恢复均保留路径', async t => {
  const r = await setup(t), attachments = ['inputs/uploads/需求.md', 'inputs/uploads/参考.png'];
  await r.jobs.create({ ...job('attachments'), attachments });
  assert.deepEqual((await r.jobs.get('attachments')).attachments, attachments);
  const pool = await openDatabase(databaseUrl); cleanup(r.root, () => pool.end());
  const restored = new PostgresJobs(pool, r.scope);
  await restored.recover('重启核对');
  assert.deepEqual((await restored.get('attachments')).attachments, attachments);
  assert.equal((await restored.get('attachments')).status, 'queued');
  await restored.create(job('without-attachments'));
  assert.deepEqual((await restored.get('without-attachments')).attachments, []);
  const foreign = new PostgresJobs(pool, { ...r.scope, ownerId: randomUUID() });
  assert.equal(await foreign.get('attachments'), undefined);
});

test('真实 PG：single 两个连接并发跨用户提交仅一个成功，只有完成或结束释放', async t => {
  const r = await setup(t), otherPool = await openDatabase(databaseUrl);
  t.after(() => otherPool.end());
  const scope = { ...r.scope, ownerId: randomUUID() }, repo = new Repository(otherPool, scope);
  await repo.initialize(); await repo.bind('thread-2', 'v1', r.root);
  await r.repo.query("UPDATE agent_data.users SET username=$3,role='admin' WHERE instance_id=$1 AND id=$2", ['designer-a']);
  await repo.query("UPDATE agent_data.users SET username=$3,role='admin' WHERE instance_id=$1 AND id=$2", ['designer-b']);
  const second = new PostgresJobs(otherPool, scope);
  const results = await Promise.allSettled([
    r.jobs.create({ ...job('single-a'), workflow: 'design', single: true }),
    second.create({ ...job('single-b'), threadId: 'thread-2', workflow: 'design', single: true }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const error = results.find(result => result.status === 'rejected').reason;
  assert.equal(error.status, 409); assert.equal(error.code, 'WORKFLOW_OCCUPIED');
  assert.deepEqual(Object.keys(error.occupant).sort(), ['startedAt', 'username']);
  const firstWon = results[0].status === 'fulfilled', winner = firstWon ? r.jobs : second, loser = firstWon ? second : r.jobs;
  const id = firstWon ? 'single-a' : 'single-b';
  assert.equal(error.occupant.username, firstWon ? 'designer-a' : 'designer-b');
  assert.ok(Number.isFinite(error.occupant.startedAt));
  assert.equal((await loser.workflowOccupancy('design')).taskId, null);
  assert.equal((await winner.workflowOccupancy('design')).taskId, id);
  const next = { ...job('single-next'), threadId: firstWon ? 'thread-2' : 'thread-1', workflow: 'design', single: true };
  for (const status of ['running', 'waiting', 'failed', 'unconfirmed', 'needs-review']) {
    await winner.patch(id, { status });
    await assert.rejects(loser.create(next), { status: 409 });
  }
  await winner.patch(id, { status: 'cancelled' }); await loser.create(next);
  await loser.patch(next.id, { status: 'completed' });
  await winner.create({ ...job('single-after'), threadId: firstWon ? 'thread-1' : 'thread-2', workflow: 'design', single: true });
});

test('真实 PG：反馈原子追加、重做上限、领取后拒绝；草稿跨用户隔离', async t => {
  const r = await setup(t);
  await r.jobs.create(job('feedback'));
  assert.deepEqual(await Promise.all([r.jobs.feedback('feedback', '一', []), r.jobs.feedback('feedback', '二', [])]), ['queued', 'queued']);
  assert.equal((await r.jobs.get('feedback')).feedback.length, 2);
  await r.jobs.patch('feedback', { status: 'starting' }, ['queued']);
  await assert.rejects(r.jobs.feedback('feedback', '迟到', []), { status: 409 });
  await r.jobs.patch('feedback', { status: 'waiting', reviseCount: 10 });
  await assert.rejects(r.jobs.feedback('feedback', '超限', []), { status: 409 });
  const foreign = { ...r.scope, ownerId: randomUUID() }, repo = new Repository(r.pool, foreign);
  await repo.initialize();
  await assert.rejects(new PostgresJobs(r.pool, foreign).feedback('feedback', '越权', []), { status: 404 });
  const files = createUserFileTools(r.root, { workspaceDir: path.join(r.root, 'workspace'), sources: r.sources, outputs: r.outputs });
  await runOwner(r.scope.ownerId, () => files.write_draft({ name: 'brief.json', content: Buffer.from('{"value":"a"}') }));
  await runOwner(foreign.ownerId, () => {
    assert.throws(() => files.read_draft({ name: 'brief.json' }), { status: 404 });
    files.write_draft({ name: 'brief.json', content: Buffer.from('{"value":"b"}') });
    assert.equal(files.read_draft({ name: 'brief.json' }).content, '{"value":"b"}');
  });
  await runOwner(r.scope.ownerId, () => assert.equal(files.read_draft({ name: 'brief.json' }).content, '{"value":"a"}'));
});


test('真实 PG：管理员并发接管仅一次成功，审计通知与锁释放同事务', async t => {
  const r = await setup(t), otherPool = await openDatabase(databaseUrl);
  t.after(() => otherPool.end());
  const actors = [];
  for (const [index, pool] of [r.pool, otherPool].entries()) {
    const scope = { ...r.scope, ownerId: randomUUID() }, repo = new Repository(pool, scope);
    await repo.initialize(); await repo.bind(`admin-thread-${index}`, 'v1', r.root);
    await repo.query("UPDATE agent_data.users SET username=$3,role='admin' WHERE instance_id=$1 AND id=$2", [`operator-${index}`]);
    actors.push(new PostgresJobs(pool, scope));
  }
  await r.repo.query("UPDATE agent_data.users SET username='owner',role='admin' WHERE instance_id=$1 AND id=$2");
  await r.jobs.create({ ...job('held'), workflow: 'design', single: true, text: '不得写入审计的正文' });
  for (const status of ['starting', 'running', 'steering']) {
    await r.jobs.patch('held', { status });
    await assert.rejects(actors[0].cancelTakeover('thread-1', 'held', ['design']), { status: 409 });
  }
  await r.jobs.patch('held', { status: 'unconfirmed' });
  await r.repo.query("UPDATE agent_data.users SET disabled_at=now() WHERE instance_id=$1 AND id=$2");
  assert.equal(await actors[0].takeoverOwner('thread-1', 'held', ['design']), r.scope.ownerId);
  assert.equal(await actors[0].takeoverOwner('thread-1', 'held', []), undefined);
  await assert.rejects(actors[0].cancelTakeover('wrong', 'held', ['design']), { status: 404 });
  await assert.rejects(actors[0].cancelTakeover('thread-1', 'held', []), { status: 404 });
  await actors[0].query("UPDATE agent_data.users SET role='user' WHERE instance_id=$1 AND id=$2");
  await assert.rejects(actors[0].cancelTakeover('thread-1', 'held', ['design']), { status: 403 });
  await actors[0].query("UPDATE agent_data.users SET role='admin' WHERE instance_id=$1 AND id=$2");
  // 审计写入失败必须回滚状态和通知，不能留下没有审计的解锁。
  const query = actors[0].query.bind(actors[0]);
  actors[0].query = (sql, ...args) => {
    if (sql.startsWith('INSERT INTO agent_data.permission_events')) throw new Error('模拟审计不可写');
    return query(sql, ...args);
  };
  await assert.rejects(actors[0].cancelTakeover('thread-1', 'held', ['design']), /模拟审计不可写/);
  actors[0].query = query;
  assert.equal((await r.jobs.get('held')).status, 'unconfirmed');
  assert.ok(await r.jobs.workflowOccupancy('design'));
  const results = await Promise.allSettled(actors.map(store => store.cancelTakeover('thread-1', 'held', ['design'])));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  const cancelled = await r.jobs.get('held');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error, `已被管理员 operator-${winner} 结束`);
  assert.equal(await r.jobs.workflowOccupancy('design'), null);
  const audit = (await r.pool.query("SELECT * FROM agent_data.permission_events WHERE instance_id=$1 AND action='task:cancel-takeover'", [r.scope.instanceId])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, actors[winner].ownerId);
  assert.equal(audit[0].resource_type, 'task'); assert.equal(audit[0].resource_id, 'held');
  assert.deepEqual(audit[0].before_state, { owner_id: r.scope.ownerId });
  assert.equal(audit[0].after_state, null); assert.equal(audit[0].detail, null);
  assert.ok(audit[0].created_at instanceof Date); assert.ok(!JSON.stringify(audit).includes('不得写入审计的正文'));
  assert.equal((await r.pool.query("SELECT * FROM agent_data.notifications WHERE instance_id=$1 AND task_id='held' AND status='cancelled'", [r.scope.instanceId])).rowCount, 1);
  await actors[winner].create({ ...job('released'), threadId: `admin-thread-${winner}`, workflow: 'design', single: true });
});


test('真实 PG：按工作流接管校验属主角色、占用时间、运行态，并发只提交一次', async t => {
  const r = await setup(t), pool = await openDatabase(databaseUrl); t.after(() => pool.end());
  await r.repo.query("UPDATE agent_data.users SET role='admin' WHERE instance_id=$1 AND id=$2");
  const actors = [];
  for (const [index, connection] of [r.pool, pool].entries()) {
    const scope = { ...r.scope, ownerId: randomUUID() }, repo = new Repository(connection, scope);
    await repo.initialize(); await repo.bind(`operator-${index}`, 'v1', r.root);
    await repo.query("UPDATE agent_data.users SET username=$3,role='admin' WHERE instance_id=$1 AND id=$2", [`operator-${index}`]);
    actors.push(new PostgresJobs(connection, scope));
  }
  await r.jobs.create({ ...job('workflow-held'), workflow: 'design', single: true });
  const { startedAt } = await r.jobs.workflowOccupancy('design');
  const cancel = (store = actors[0], time = startedAt, workflows = ['design']) => store.cancelTakeoverWorkflow('design', time, workflows);
  assert.equal(await actors[0].takeoverWorkflowOwner('design', ['design']), r.scope.ownerId);
  assert.equal(await actors[0].takeoverWorkflowOwner('design', []), undefined);
  await assert.rejects(cancel(actors[0], startedAt, []), { status: 404 });
  await assert.rejects(cancel(actors[0], startedAt - 1), { status: 409, message: '占用已变化，请刷新后核对' });
  await assert.rejects(cancel(r.jobs), { status: 404 });
  await actors[0].query("UPDATE agent_data.users SET role='user' WHERE instance_id=$1 AND id=$2");
  await assert.rejects(cancel(), { status: 403 });
  await actors[0].query("UPDATE agent_data.users SET role='admin' WHERE instance_id=$1 AND id=$2");
  await r.repo.query("UPDATE agent_data.users SET role='user' WHERE instance_id=$1 AND id=$2");
  await assert.rejects(cancel(), { status: 404 });
  await r.repo.query("UPDATE agent_data.users SET role='admin' WHERE instance_id=$1 AND id=$2");
  for (const status of ['starting', 'running', 'steering']) {
    await r.jobs.patch('workflow-held', { status }); await assert.rejects(cancel(), { status: 409 });
  }
  await r.jobs.patch('workflow-held', { status: 'failed' });
  const results = await Promise.allSettled(actors.map(store => cancel(store)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(results.find(result => result.status === 'fulfilled').value, { id: 'workflow-held', threadId: 'thread-1', userId: r.scope.ownerId, status: 'cancelled' });
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 404);
  assert.equal(await r.jobs.workflowOccupancy('design'), null);
  assert.equal((await r.pool.query("SELECT * FROM agent_data.permission_events WHERE instance_id=$1 AND resource_id='workflow-held'", [r.scope.instanceId])).rowCount, 1);
  assert.equal((await r.pool.query("SELECT * FROM agent_data.notifications WHERE instance_id=$1 AND task_id='workflow-held' AND status='cancelled'", [r.scope.instanceId])).rowCount, 1);
});

test('真实 PG：失败步骤 patch 重排清理旧结果，解除暂停后可投递且并发只增加一次计数', async t => {
  const r = await setup(t), allowed = ['failed', 'interrupted', 'needs-review', 'unconfirmed'];
  for (const status of allowed) {
    const id = `retry-${status}`;
    await r.jobs.create({ ...job(id), workflow: 'design' });
    await r.jobs.patch(id, { status, error: '失败', checks: [{ id: 'format', passed: false }], turnId: 'old', reviseCount: 2 });
    await r.jobs.pause('thread-1');
    const fields = { status: 'queued', note: '核对后重新生成', reviseCount: 3, error: null, checks: null, turnId: null };
    const results = await Promise.all([r.jobs.patch(id, fields, allowed), r.jobs.patch(id, fields, allowed)]);
    assert.deepEqual(results.sort(), [false, true]);
    await r.jobs.pause('thread-1', false);
    const row = await r.jobs.get(id);
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(row[key], value);
    assert.equal(row.step, 0); assert.equal(await r.jobs.paused('thread-1'), false);
    assert.ok((await r.jobs.deliveries()).some(row => row.thread_id === 'thread-1'));
    await r.jobs.patch(id, { status: 'completed' });
    assert.equal(await r.jobs.patch(id, fields, allowed), false);
  }
});
