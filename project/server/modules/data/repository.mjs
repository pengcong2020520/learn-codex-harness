import { AppError } from "../../../shared/errors.mjs";
import { transaction } from "./database.mjs";

export class Repository {
  constructor(pool, scope) {
    Object.assign(this, { pool, ...scope });
  }
  query(sql, values = [], client = this.pool) {
    return client.query(sql, [this.instanceId, this.ownerId, ...values]);
  }
  async initialize() {
    await this.query(
      "INSERT INTO agent_data.users(instance_id,id,name) VALUES($1,$2,'local-owner') ON CONFLICT DO NOTHING",
    );
  }
  async saveAgent(descriptor) {
    await this.query(
      "INSERT INTO agent_data.agent_versions(instance_id,hash,descriptor) SELECT $1,$3,$4 WHERE $2::uuid IS NOT NULL ON CONFLICT DO NOTHING",
      [descriptor.hash, descriptor],
    );
  }
  async bind(threadId, hash, cwd, name = "") {
    const result = await this.query(
      `INSERT INTO agent_data.conversations(instance_id,id,owner_id,agent_hash,cwd,name)
      VALUES($1,$3,$2,$4,$5,$6) ON CONFLICT(instance_id,id) DO UPDATE SET updated_at=now()
      WHERE conversations.owner_id=$2 AND conversations.agent_hash IS NOT DISTINCT FROM $4 RETURNING id`,
      [threadId, hash, cwd, name],
    );
    if (!result.rowCount)
      throw new AppError("会话归属或 Agent 版本冲突。", 409);
  }
  async conversation(id) {
    const row = (
      await this.query(
        "SELECT * FROM agent_data.conversations WHERE instance_id=$1 AND owner_id=$2 AND id=$3",
        [id],
      )
    ).rows[0];
    if (!row)
      throw new AppError("未找到本项目的这个会话。", 404, "THREAD_NOT_FOUND");
    return row;
  }
  async listConversations(keyword = "") {
    return (
      await this.query(
        `SELECT id,name,cwd,updated_at AS "updatedAt" FROM agent_data.conversations
      WHERE instance_id=$1 AND owner_id=$2 AND (strpos(lower(name),lower($3))>0 OR strpos(lower(id),lower($3))>0)
      ORDER BY updated_at DESC LIMIT 200`,
        [keyword],
      )
    ).rows;
  }
  async preferences() {
    return (
      await this.query(
        "SELECT key,value,updated_at FROM agent_data.preferences WHERE instance_id=$1 AND owner_id=$2 ORDER BY key",
      )
    ).rows;
  }
  async setPreference(key, value) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(key) ||
      typeof value !== "string" ||
      value.length > 4000
    )
      throw new AppError("偏好 key 或 value 无效。");
    await this.query(
      `INSERT INTO agent_data.preferences(instance_id,owner_id,key,value) VALUES($1,$2,$3,$4)
      ON CONFLICT(instance_id,owner_id,key) DO UPDATE SET value=$4,updated_at=now()`,
      [key, value],
    );
  }
  async recordArtifacts(threadId, turn) {
    await this.conversation(threadId);
    await transaction(this.pool, async (client) => {
      for (const [itemId, artifact] of Object.entries(turn.artifacts || {})) {
        if (!artifact.resourceId || !artifact.versionId) continue;
        const result = await this.query(
          `INSERT INTO agent_data.artifacts(instance_id,thread_id,turn_id,item_id,resource_id,version_id)
          SELECT $1,$3,$4,$5,r.id,v.id FROM agent_data.resources r JOIN agent_data.resource_versions v
          ON v.instance_id=r.instance_id AND v.resource_id=r.id
          WHERE r.instance_id=$1 AND r.owner_id=$2 AND r.id=$6 AND v.id=$7
          ON CONFLICT DO NOTHING`,
          [threadId, turn.id, itemId, artifact.resourceId, artifact.versionId],
          client,
        );
        if (!result.rowCount) {
          const known = await this.query(
            "SELECT 1 FROM agent_data.artifacts WHERE instance_id=$1 AND thread_id=$3 AND turn_id=$4 AND item_id=$5 AND $2::uuid IS NOT NULL",
            [threadId, turn.id, itemId],
            client,
          );
          if (!known.rowCount) throw new Error("产物版本不属于当前数据范围。");
        }
      }
    });
  }
}
