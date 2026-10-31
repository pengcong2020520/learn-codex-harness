import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Repository } from "./repository.mjs";
import { transaction } from "./database.mjs";
import { AppError } from "../../../shared/errors.mjs";

const hash = (content) => createHash("sha256").update(content).digest("hex");
const covers = (root, file) => file === root || file.startsWith(root + "/");
const safeId = (id) => {
  if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new AppError("资料 ID 无效。");
  return id;
};

// One access boundary for path reads, ID reads, lineage and future search consumers.
export class Resources extends Repository {
  constructor(pool, scope, { files, sources, outputs, blobDir, gate }) {
    super(pool, scope);
    Object.assign(this, { files, sources, outputs, blobDir, gate });
    fs.mkdirSync(blobDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(blobDir).isSymbolicLink())
      throw new Error("正文存储目录不能是链接。");
  }
  async locked(operation) {
    return transaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,1))",
        [this.instanceId],
      );
      const result = await operation(client);
      this.gate?.current();
      return result;
    });
  }
  source(locator, action) {
    this.gate?.check(action, { path: locator });
    const found = this.sources
      .filter((s) => s.actions.includes(action) && covers(s.locator, locator))
      .sort((a, b) => b.locator.length - a.locator.length)[0];
    if (found) return found.id;
    if (action === "create" && covers(this.outputs.directory, locator))
      return "agent-output";
    throw new AppError("未授权访问这个资料范围。", 403);
  }
  async row(locator, client = this.pool) {
    // Deliberately not filtered by owner: a foreign row must block auto-registration.
    return (
      await this.query(
        "SELECT * FROM agent_data.resources WHERE instance_id=$1 AND locator=$3 AND $2::uuid IS NOT NULL",
        [locator],
        client,
      )
    ).rows[0];
  }
  async readable(row, client = this.pool) {
    if (row) this.gate?.check("read", { path: row.locator, ownerId: row.owner_id });
    if (!row || row.owner_id !== this.ownerId)
      throw new AppError("资料不存在或无权访问。", 404);
    this.source(row.locator, "read");
    if (row.state !== "ready")
      throw new AppError(
        `资料当前为 ${row.state}，不可读取；请先核对来源或重新生成。`,
        409,
      );
    const dependencies = (
      await this.query(
        `WITH RECURSIVE upstream(id) AS (
      SELECT source_id FROM agent_data.dependencies WHERE instance_id=$1 AND derived_id=$3
      UNION SELECT d.source_id FROM agent_data.dependencies d JOIN upstream u ON d.derived_id=u.id WHERE d.instance_id=$1)
      SELECT r.* FROM agent_data.resources r JOIN upstream u ON u.id=r.id WHERE r.instance_id=$1 AND $2::uuid IS NOT NULL`,
        [row.id],
        client,
      )
    ).rows;
    for (const dependency of dependencies) {
      if (dependency.owner_id !== this.ownerId || dependency.state !== "ready")
        throw new AppError("引用资料已失效或撤销，停止读取派生内容。", 403);
      this.source(dependency.locator, "read");
    }
    return row;
  }
  async invalidate(id, client) {
    await this.query(
      `WITH RECURSIVE downstream(id) AS (
      SELECT derived_id FROM agent_data.dependencies WHERE instance_id=$1 AND source_id=$3
      UNION SELECT d.derived_id FROM agent_data.dependencies d JOIN downstream x ON d.source_id=x.id WHERE d.instance_id=$1)
      UPDATE agent_data.resources SET state='stale',updated_at=now() WHERE instance_id=$1 AND owner_id=$2
      AND id IN(SELECT id FROM downstream) AND state='ready'`,
      [id],
      client,
    );
  }
  blob(content) {
    if (typeof content !== "string" || Buffer.byteLength(content) > 256 * 1024)
      throw new AppError("正文必须是不超过 256 KiB 的文本。");
    const revision = hash(content),
      file = path.join(this.blobDir, revision + ".txt");
    try {
      fs.writeFileSync(file, content, { flag: "wx", mode: 0o600, flush: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 256 * 1024 ||
      hash(fs.readFileSync(file)) !== revision
    )
      throw new Error("正文版本校验失败。");
    return {
      revision,
      blob: revision + ".txt",
      bytes: Buffer.byteLength(content),
    };
  }
  async version(row, body, client, humanEdited = false) {
    const versionId = randomUUID();
    await this.query(
      `INSERT INTO agent_data.resource_versions(instance_id,id,resource_id,revision,blob,bytes)
      SELECT $1,$3,$4,$5,$6,$7 WHERE $2::uuid IS NOT NULL`,
      [versionId, row.id, body.revision, body.blob, body.bytes],
      client,
    );
    await this.query(
      `UPDATE agent_data.resources SET current_version=$4,state='ready',human_edited=human_edited OR $5,updated_at=now()
      WHERE instance_id=$1 AND owner_id=$2 AND id=$3`,
      [row.id, versionId, humanEdited],
      client,
    );
    if (row.current_version) await this.invalidate(row.id, client);
    return { resourceId: row.id, versionId, revision: body.revision };
  }
  async read_file(args) {
    const locator = args.path;
    this.source(locator, "read");
    const before = await this.row(locator);
    if (before) {
      await this.refreshSources(before);
      await this.readable(await this.row(locator));
    }
    // Existing bounded reader also enforces links, path, file type, size and Agent revision.
    const output = this.files.read_file({ ...args, max_chars: 256 * 1024 });
    const body = this.blob(output.content);
    const metadata = await this.locked(async (client) => {
      let row = await this.row(locator, client);
      if (row) await this.readable(row, client);
      else {
        row = (
          await this.query(
            `INSERT INTO agent_data.resources(instance_id,id,owner_id,source_id,locator,kind,state)
          VALUES($1,$3,$2,$4,$5,$6,'pending') RETURNING *`,
            [
              randomUUID(),
              this.source(locator, "read"),
              locator,
              this.sources.some(source => (source.readOnly || !source.actions.includes("create")) && covers(source.locator, locator)) || Object.values(this.gate?.knowledgeBases || {}).some(kb => covers(kb.sourceRoot, locator)) ? "original" : "knowledge",
            ],
            client,
          )
        ).rows[0];
      }
      const old = (
        await this.query(
          "SELECT revision FROM agent_data.resource_versions WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL",
          [row.current_version],
          client,
        )
      ).rows[0];
      if (old?.revision === body.revision)
        return {
          resourceId: row.id,
          versionId: row.current_version,
          revision: body.revision,
        };
      return this.version(row, body, client, Boolean(old));
    });
    // Recheck after awaits: revoked data is never served from a stale cache.
    await this.readable(await this.row(locator));
    this.files.check(locator, "read");
    return {
      ...output,
      ...metadata,
      content: output.content.slice(0, args.max_chars || 20000),
      truncated: output.content.length > (args.max_chars || 20000),
    };
  }
  async refreshSources(row) {
    await this.readable(row);
    const upstream = (
      await this.query(
        `WITH RECURSIVE refs(id) AS (
      SELECT source_id FROM agent_data.dependencies WHERE instance_id=$1 AND derived_id=$3
      UNION SELECT d.source_id FROM agent_data.dependencies d JOIN refs x ON d.derived_id=x.id WHERE d.instance_id=$1)
      SELECT r.*,v.revision FROM refs JOIN agent_data.resources r ON r.id=refs.id
      JOIN agent_data.resource_versions v ON v.instance_id=r.instance_id AND v.id=r.current_version
      WHERE r.instance_id=$1 AND r.owner_id=$2`,
        [row.id],
      )
    ).rows;
    // Source freshness is checked on read, not only when a model chooses to reopen the source.
    for (const source of upstream) {
      let output;
      try {
        output = this.files.read_file({
          path: source.locator,
          max_chars: 256 * 1024,
        });
      } catch {
        await this.locked(async (client) => {
          await this.query(
            "UPDATE agent_data.resources SET state='stale',updated_at=now() WHERE instance_id=$1 AND owner_id=$2 AND id=$3 AND state='ready'",
            [source.id],
            client,
          );
          await this.invalidate(source.id, client);
        });
        throw new AppError("来源文件不可用，相关派生内容已失效。", 409);
      }
      if (hash(output.content) !== source.revision) {
        const body = this.blob(output.content);
        await this.locked(async (client) => {
          const current = await this.get(source.id, client);
          await this.readable(current, client);
          await this.version(current, body, client, true);
        });
      }
    }
  }
  async list_files(args) {
    const result = this.files.list_files(args);
    const entries = [];
    for (const entry of result.entries) {
      const locator = args.path ? `${args.path}/${entry.name}` : entry.name;
      const row = await this.row(locator);
      if (row) {
        try {
          await this.readable(row);
        } catch {
          continue;
        }
      }
      entries.push(entry);
    }
    return { ...result, entries };
  }
  async write_file({ path: locator, content, source_versions = [] }) {
    if (fs.existsSync(this.files.check(locator, "create")))
      throw new AppError("文件已存在，未覆盖。请使用新版本文件名。", 409);
    if (!Array.isArray(source_versions) || source_versions.length > 50)
      throw new AppError("最多引用 50 个资料版本。");
    const body = this.blob(content);
    let row;
    await this.locked(async (client) => {
      if (await this.row(locator, client))
        throw new AppError(
          "路径已有资料或未确认的写入记录；不会覆盖或盲目重试。",
          409,
        );
      for (const reference of source_versions) {
        const source = await this.get(reference.resourceId, client);
        await this.readable(source, client);
        if (source.current_version !== reference.versionId)
          throw new AppError("引用的资料版本已过期。", 409);
      }
      row = (
        await this.query(
          `INSERT INTO agent_data.resources(instance_id,id,owner_id,source_id,locator,kind,state)
        VALUES($1,$3,$2,$4,$5,$6,'pending') RETURNING *`,
          [
            randomUUID(),
            this.source(locator, "create"),
            locator,
            covers(this.outputs.directory, locator) ? "artifact" : "knowledge",
          ],
          client,
        )
      ).rows[0];
      // Reserve an immutable expected body before writing. Crash recovery never invents a body.
      const versionId = randomUUID();
      await this.query(
        `INSERT INTO agent_data.resource_versions(instance_id,id,resource_id,revision,blob,bytes)
        SELECT $1,$3,$4,$5,$6,$7 WHERE $2::uuid IS NOT NULL`,
        [versionId, row.id, body.revision, body.blob, body.bytes],
        client,
      );
      await this.query(
        "UPDATE agent_data.resources SET current_version=$4 WHERE instance_id=$1 AND owner_id=$2 AND id=$3",
        [row.id, versionId],
        client,
      );
      row.current_version = versionId;
      for (const reference of source_versions)
        await this.query(
          `INSERT INTO agent_data.dependencies(instance_id,derived_id,source_id,source_version)
        SELECT $1,$3,$4,$5 WHERE $2::uuid IS NOT NULL`,
          [row.id, reference.resourceId, reference.versionId],
          client,
        );
    });
    this.gate?.check("create", { path: locator });
    const output = this.files.write_file({ path: locator, content });
    await this.finish(row.id, body.revision);
    return {
      ...output,
      artifact: {
        ...output.artifact,
        resourceId: row.id,
        versionId: row.current_version,
      },
    };
  }
  async get(id, client = this.pool) {
    const row = (
      await this.query(
        "SELECT * FROM agent_data.resources WHERE instance_id=$1 AND owner_id=$2 AND id=$3",
        [safeId(id)],
        client,
      )
    ).rows[0];
    if (!row) throw new AppError("资料不存在或无权访问。", 404);
    return row;
  }
  async readById(id, args = {}) {
    const row = await this.get(id);
    await this.readable(row);
    return this.read_file({ ...args, path: row.locator });
  }
  async finish(id, revision) {
    return this.locked(async (client) => {
      const row = await this.get(id, client);
      if (row.state !== "pending")
        throw new Error("写入状态已变化，停止确认。");
      const expected = (
        await this.query(
          "SELECT revision FROM agent_data.resource_versions WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL",
          [row.current_version],
          client,
        )
      ).rows[0];
      if (expected?.revision !== revision)
        throw new Error("写入内容与预留版本不同。");
      const deps = (
        await this.query(
          `SELECT r.*,d.source_version FROM agent_data.dependencies d JOIN agent_data.resources r
        ON r.instance_id=d.instance_id AND r.id=d.source_id WHERE d.instance_id=$1 AND d.derived_id=$3 AND r.owner_id=$2`,
          [id],
          client,
        )
      ).rows;
      const state = deps.some(
        (dep) =>
          dep.state !== "ready" || dep.source_version !== dep.current_version,
      )
        ? "stale"
        : "ready";
      await this.query(
        "UPDATE agent_data.resources SET state=$4,updated_at=now() WHERE instance_id=$1 AND owner_id=$2 AND id=$3",
        [id, state],
        client,
      );
      if (state !== "ready")
        throw new Error("写入期间来源失效；正文已保留，等待核对。");
    });
  }
  async revoke(id) {
    return this.locked(async (client) => {
      const row = await this.get(id, client);
      this.source(row.locator, "read");
      await this.query(
        "UPDATE agent_data.resources SET state='revoked',updated_at=now() WHERE instance_id=$1 AND owner_id=$2 AND id=$3",
        [id],
        client,
      );
      await this.invalidate(id, client);
    });
  }
  async relocate(id, locator) {
    // Operator first moves the file; this controlled rebinding retains identity and version.
    const row = await this.get(id);
    await this.readable(row);
    this.source(locator, "read");
    const output = this.files.read_file({
      path: locator,
      max_chars: 256 * 1024,
    });
    return this.locked(async (client) => {
      const current = await this.get(id, client);
      await this.readable(current, client);
      const version = (
        await this.query(
          "SELECT revision FROM agent_data.resource_versions WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL",
          [current.current_version],
          client,
        )
      ).rows[0];
      if (hash(output.content) !== version?.revision)
        throw new AppError("新位置的内容与当前版本不一致。", 409);
      await this.query(
        "UPDATE agent_data.resources SET locator=$4,source_id=$5,updated_at=now() WHERE instance_id=$1 AND owner_id=$2 AND id=$3",
        [id, locator, this.source(locator, "read")],
        client,
      );
      return {
        resourceId: id,
        versionId: current.current_version,
        path: locator,
      };
    });
  }
  async reconcile() {
    const rows = (
      await this.query(
        "SELECT * FROM agent_data.resources WHERE instance_id=$1 AND owner_id=$2 AND state='pending'",
      )
    ).rows;
    const result = [];
    for (const row of rows) {
      try {
        const content = this.files.read_file({
          path: row.locator,
          max_chars: 256 * 1024,
        }).content;
        await this.finish(row.id, hash(content));
        result.push({ id: row.id, status: "ready" });
      } catch {
        await this.query(
          "UPDATE agent_data.resources SET state='unconfirmed' WHERE instance_id=$1 AND owner_id=$2 AND id=$3 AND state='pending'",
          [row.id],
        );
        result.push({ id: row.id, status: "unconfirmed" });
      }
    }
    return result;
  }
}
