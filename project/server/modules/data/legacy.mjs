import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJson } from "../storage/index.mjs";
import { transaction } from "./database.mjs";
import { requireId } from "../../../shared/errors.mjs";

// Additive, explicit, all-or-nothing import. Never rewrite source JSON or Codex files.
export async function importLegacy(repository, root, { apply = false } = {}) {
  const read = (relative, fallback) => {
    const file = path.join(root, ".data", relative);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 32 * 1024 * 1024
      )
        throw new Error("旧状态文件类型或体积无效。");
    }
    return readJson(file, fallback);
  };
  const bindings = read("thread-agents.json", {}),
    state = read("messages.json", { version: 1, jobs: [], paused: [] });
  if (
    state.version !== 1 ||
    !Array.isArray(state.jobs) ||
    !Array.isArray(state.paused)
  )
    throw new Error("旧任务格式无效。");
  const descriptors = new Map();
  for (const [id, hash] of Object.entries(bindings)) {
    requireId(id);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("旧 Agent hash 无效。");
    const descriptor = read(`agent-descriptors/${hash}.json`, null);
    if (
      !descriptor ||
      descriptor.hash !== hash ||
      typeof descriptor.workspaceDir !== "string"
    )
      throw new Error("旧 Agent 描述符缺失或不匹配。");
    const { hash: declared, ...body } = descriptor;
    if (
      createHash("sha256").update(JSON.stringify(body)).digest("hex") !==
      declared
    )
      throw new Error("旧 Agent 描述符内容校验失败。");
    descriptors.set(hash, descriptor);
  }
  for (const job of state.jobs) {
    requireId(job.id);
    requireId(job.threadId);
    if (
      !Object.hasOwn(bindings, job.threadId) ||
      !descriptors.has(job.agentHash)
    )
      throw new Error("旧任务缺少可验证的会话/Agent 绑定，拒绝猜测归属。");
    if (
      typeof job.text !== "string" ||
      job.text.length > 100000 ||
      !Number.isSafeInteger(job.createdAt)
    )
      throw new Error("旧任务内容格式无效。");
  }
  const summary = {
    agents: descriptors.size,
    conversations: Object.keys(bindings).length,
    tasks: state.jobs.length,
    applied: apply,
  };
  if (!apply) return summary;
  await transaction(repository.pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,2))", [
      repository.instanceId,
    ]);
    for (const descriptor of descriptors.values())
      await repository.query(
        `INSERT INTO agent_data.agent_versions(instance_id,hash,descriptor)
      SELECT $1,$3,$4 WHERE $2::uuid IS NOT NULL ON CONFLICT DO NOTHING`,
        [descriptor.hash, descriptor],
        client,
      );
    for (const [id, hash] of Object.entries(bindings)) {
      const found = await repository.query(
        `INSERT INTO agent_data.conversations(instance_id,id,owner_id,agent_hash,cwd,paused)
        VALUES($1,$3,$2,$4,$5,true) ON CONFLICT(instance_id,id) DO UPDATE SET id=conversations.id
        WHERE conversations.owner_id=$2 AND conversations.agent_hash=$4 RETURNING id`,
        [id, hash, descriptors.get(hash).workspaceDir],
        client,
      );
      if (!found.rowCount)
        throw new Error("数据库已有不同会话归属或版本，导入已回滚。");
    }
    for (const job of state.jobs) {
      const old = (
        await repository.query(
          "SELECT text,thread_id,mode,target_turn_id,agent_hash FROM agent_data.tasks WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL",
          [job.id],
          client,
        )
      ).rows[0];
      if (old) {
        if (
          old.text !== job.text ||
          old.thread_id !== job.threadId ||
          old.mode !== job.mode ||
          old.target_turn_id !== (job.targetTurnId || null) ||
          old.agent_hash !== job.agentHash
        )
          throw new Error("数据库已有不同消息，导入已回滚。");
        continue;
      }
      const status = ["starting", "running", "steering"].includes(job.status)
        ? "unconfirmed"
        : job.status;
      await repository.query(
        `INSERT INTO agent_data.tasks(instance_id,id,thread_id,text,mode,target_turn_id,turn_id,agent_hash,status,error,created_at)
        SELECT $1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 WHERE $2::uuid IS NOT NULL`,
        [
          job.id,
          job.threadId,
          job.text,
          job.mode,
          job.targetTurnId,
          job.turnId,
          job.agentHash,
          status,
          job.error || null,
          job.createdAt,
        ],
        client,
      );
    }
    await repository.query(
      `INSERT INTO agent_data.imports(instance_id,kind) SELECT $1,'legacy-json' WHERE $2::uuid IS NOT NULL ON CONFLICT DO NOTHING`,
      [],
      client,
    );
  });
  return summary;
}
