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
import { PostgresJobs } from "../server/modules/data/jobs.mjs";
import { Resources } from "../server/modules/data/resources.mjs";
import { RedisQueue } from "../server/modules/data/queue.mjs";
import { createFileTools } from "../server/modules/data/files.mjs";
import { loadServerConfig } from "../server/modules/config/index.mjs";
import { startAgentServer } from "../server/main.mjs";
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
  const write = await r.resources.write_file({
    path: "outputs/a.txt",
    content: "A",
  });
  const narrow = new Resources(r.pool, r.scope, {
    files: createFileTools(r.root, {
      sources: [{ id: "inputs", locator: "inputs", actions: ["read"] }],
      outputs: r.outputs,
    }),
    sources: [{ id: "inputs", locator: "inputs", actions: ["read"] }],
    outputs: r.outputs,
    blobDir: path.join(r.root, "blobs"),
  });
  await assert.rejects(narrow.readById(write.artifact.resourceId), /未授权/);
  const foreign = new Resources(
    r.pool,
    { ...r.scope, ownerId: randomUUID() },
    {
      files: r.files,
      sources: r.sources,
      outputs: r.outputs,
      blobDir: path.join(r.root, "blobs"),
    },
  );
  await assert.rejects(foreign.read_file({ path: "outputs/a.txt" }), /无权/);
  await assert.rejects(r.resources.read_file({ path: "../.env" }), /未授权/);
  await assert.rejects(
    r.resources.write_file({
      path: "drafts/b.txt",
      content: "bad",
      source_versions: [
        { resourceId: write.artifact.resourceId, versionId: randomUUID() },
      ],
    }),
    /过期/,
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
