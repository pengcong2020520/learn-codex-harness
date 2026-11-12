import { can, owns } from '../hub/policy.mjs';
import { readAsUser } from '../runtimes/user-files.mjs';
import fs from 'node:fs';
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Repository } from "./repository.mjs";
import { transaction } from "./database.mjs";
import { MAX_MEDIA_BYTES, mediaFormat, createFileTools } from "./files.mjs";
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
  ownerWorkspace(owner) { return this.files.workspaceFor?.(owner) || path.join(path.dirname(this.files.workspace), owner); }
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
  dynamicSource(locator) {
    return this.gate?.permissionHub && [...this.gate.permissionHub.current().resources.values()]
      .find(kb => kb.type === 'knowledge' && kb.user_created && covers(kb.source_root, locator));
  }
  sourceFiles(locator) {
    const kb = this.dynamicSource(locator);
    if (!kb || kb.owner_id !== this.ownerId) return this.files;
    this.gate.check('read', { kbId: kb.id });
    return createFileTools(this.files.workspace, { workspaceDir: this.files.workspace,
      sources: [{ id: `knowledge:${kb.id}`, locator: kb.source_root, actions: ['read'], readOnly: true }],
      assertCurrent: () => this.gate.current() });
  }
  source(locator, action) {
    this.gate?.check(action, { path: locator });
    const found = this.sources
      .filter((s) => s.actions.includes(action) && covers(s.locator, locator))
      .sort((a, b) => b.locator.length - a.locator.length)[0];
    if (found) return found.id;
    const kb = action === 'read' && this.dynamicSource(locator);
    if (kb) return `knowledge:${kb.id}`;
    if (action === "create" && covers(this.outputs.directory, locator))
      return "agent-output";
    throw new AppError("未授权访问这个资料范围。", 403);
  }
  async row(locator, client = this.pool) {
    // locator 在各自用户目录中解释，登记与查询都按 owner。
    return (
      await this.query(
        "SELECT * FROM agent_data.resources WHERE instance_id=$1 AND locator=$3 AND owner_id=$2",
        [locator],
        client,
      )
    ).rows[0];
  }
  authorize(row, action = 'read') {
    if (this.gate?.permissionHub) return this.gate.permissionHub.checkFile(row, action);
    return can({ id: this.ownerId }, action, row && { ...row, type: 'personal' });
  }
  async readable(row, client = this.pool) {
    this.authorize(row);
    this.gate?.check("read", { path: row.locator });
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
      this.authorize(dependency);
      if (dependency.state !== "ready")
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
    const binary = Buffer.isBuffer(content), limit = binary ? MAX_MEDIA_BYTES : 256 * 1024;
    if ((!binary && typeof content !== "string") || Buffer.byteLength(content) > limit)
      throw new AppError(binary ? "二进制正文不能超过 128 MiB。" : "正文必须是不超过 256 KiB 的文本。");
    const revision = hash(content),
      extension = binary ? ".bin" : ".txt",
      file = path.join(this.blobDir, revision + extension);
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
      stat.size > limit ||
      hash(fs.readFileSync(file)) !== revision
    )
      throw new Error("正文版本校验失败。");
    return {
      revision,
      blob: revision + extension,
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
    const output = this.sourceFiles(locator).read_file({ ...args, max_chars: 256 * 1024 });
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
              this.sources.some(source => (source.readOnly || !source.actions.includes("create")) && covers(source.locator, locator)) || Object.values(this.gate?.bindings?.() || this.gate?.knowledgeBases || {}).some(kb => covers(kb.sourceRoot, locator)) ? "original" : "knowledge",
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
    this.sourceFiles(locator).check(locator, "read");
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
      WHERE r.instance_id=$1 AND ${this.gate?.permissionHub ? '$2::uuid IS NOT NULL' : 'r.owner_id=$2'}`,
        [row.id],
      )
    ).rows;
    // Source freshness is checked on read, not only when a model chooses to reopen the source.
    for (const source of upstream) {
      let output;
      try {
        if (!owns({ id: this.ownerId }, source)) { await this.readShared(source, { max_chars: 256 * 1024 }); continue; }
        output = this.sourceFiles(source.locator)[/\.(png|jpeg|webp|mp4)$/i.test(source.locator) ? "read_binary" : "read_file"]({
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
    const result = this.sourceFiles(args.path || "").list_files(args);
    const entries = [];
    for (const entry of result.entries) {
      const locator = result.path === "." ? entry.name : `${result.path}/${entry.name}`;
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
  check_binary(locator) {
    this.source(locator, 'create');
    return this.files.check_binary(locator);
  }
  async read_binary({ path: locator }) {
    const row = await this.row(locator);
    await this.readable(row);
    const output = this.files.read_binary({ path: locator });
    const version = (await this.query('SELECT revision FROM agent_data.resource_versions WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL', [row.current_version])).rows[0];
    if (hash(output.content) !== version?.revision) throw new Error('媒体版本正文已变化。');
    await this.readable(await this.row(locator));
    this.files.check_binary(locator, 'read');
    return { ...output, resourceId: row.id, versionId: row.current_version, revision: version.revision };
  }
  async write_binary(args) {
    this.check_binary(args.path);
    if (!Buffer.isBuffer(args.content) || !args.content.length || args.content.length > MAX_MEDIA_BYTES || mediaFormat(args.content) !== path.extname(args.path).slice(1).toLowerCase())
      throw new Error('媒体正文大小或格式与文件扩展名不符。');
    return this.write_file(args);
  }
  async sourceVersion(reference, index, client) {
    try {
      if (!reference || typeof reference !== "object" || Array.isArray(reference))
        throw new AppError("请填写 {path} 或 {resourceId, versionId}。");
      let source, versionId;
      // 保留直接传入 read_file 元数据的旧用法；有 ID 时仍按指定版本校验。
      if ("resourceId" in reference || "versionId" in reference) {
        for (const field of ["resourceId", "versionId"]) {
          if (typeof reference[field] !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reference[field]))
            throw new AppError(`${field} 格式不正确，可能是号码抄错了。`);
        }
        source = (await this.query(
          `SELECT * FROM agent_data.resources WHERE instance_id=$1 AND id=$3 AND ${this.gate?.permissionHub ? '$2::uuid IS NOT NULL' : 'owner_id=$2'}`,
          [reference.resourceId], client,
        )).rows[0];
        if (!source) throw new AppError("resourceId 不存在，可能是号码抄错了。", 404);
        versionId = reference.versionId;
      } else {
        if (typeof reference.path !== "string" || !reference.path)
          throw new AppError("path 必须是非空字符串，或填写 resourceId 和 versionId。");
        this.source(reference.path, "read");
        this.sourceFiles(reference.path).check(reference.path, "read");
        source = await this.row(reference.path, client);
        if (!source) throw new AppError("路径尚未登记，请先通过 read_file 读取该路径。", 404);
        versionId = source.current_version;
      }
      this.authorize(source);
      await this.readable(source, client);
      const version = (await this.query(
        "SELECT resource_id FROM agent_data.resource_versions WHERE instance_id=$1 AND id=$3 AND resource_id=$4 AND $2::uuid IS NOT NULL",
        [versionId, source.id], client,
      )).rows[0];
      if (!version) throw new AppError("versionId 不属于这个资源，可能是号码抄错了。", 404);
      if (source.current_version !== versionId)
        throw new AppError("版本已过期：资料已有更新，请重新读取。", 409);
      return { resourceId: source.id, versionId };
    } catch (error) {
      const reason = error.status === 404 ? error.message : error.code === "ENOENT" ? "路径不存在。"
        : error.code === "ENOTDIR" ? "路径中有非目录项。"
        : error.code === "EACCES" || error.status === 403 || /未授权|无权/.test(error.message) ? "没有读权限。"
        : /^E[A-Z]+$/.test(error.code || "") ? `来源文件检查失败（${error.code}）。` : error.message;
      throw new AppError(`source_versions 第 ${index + 1} 项：${reason}`, error.status || 400);
    }
  }
  async write_file({ path: locator, content, source_versions = [], operationId = null }) {
    const binary = Buffer.isBuffer(content);
    this.source(locator, 'create');
    const target = binary ? this.check_binary(locator) : this.files.check(locator, 'create');
    // 仅后台任务的同一个资源 ID 可以恢复已预留的二进制版本；普通调用仍是 create-only。
    if (binary && operationId) {
      const previous = await this.row(locator);
      if (previous) {
        this.authorize(previous, 'modify');
        if (previous.id !== operationId || !['pending', 'ready'].includes(previous.state)) throw new Error('媒体路径已有其他资源，未覆盖。');
        const version = (await this.query('SELECT revision FROM agent_data.resource_versions WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL', [previous.current_version])).rows[0];
        if (version?.revision !== hash(content)) throw new Error('恢复正文与预留版本不同。');
        this.check_binary(locator);
        if (fs.existsSync(target)) {
          const stat = fs.lstatSync(target);
          if (stat.size !== content.length || hash(fs.readFileSync(target)) !== version.revision) throw new Error('已保存的媒体内容不匹配，未覆盖。');
        } else this.files.write_binary({ path: locator, content });
        this.gate?.check('create', { path: locator });
        if (previous.state === 'pending') await this.finish(previous.id, version.revision);
        return { path: locator, artifact: { resourceId: previous.id, versionId: previous.current_version, revision: version.revision } };
      }
    }
    if (fs.existsSync(target))
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
      const references = [];
      for (const [index, reference] of source_versions.entries()) {
        const resolved = await this.sourceVersion(reference, index, client);
        if (!references.some(item => item.resourceId === resolved.resourceId)) references.push(resolved);
      }
      row = (
        await this.query(
          `INSERT INTO agent_data.resources(instance_id,id,owner_id,source_id,locator,kind,state)
        VALUES($1,$3,$2,$4,$5,$6,'pending') RETURNING *`,
          [
            operationId || randomUUID(),
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
      for (const reference of references)
        await this.query(
          `INSERT INTO agent_data.dependencies(instance_id,derived_id,source_id,source_version)
        SELECT $1,$3,$4,$5 WHERE $2::uuid IS NOT NULL`,
          [row.id, reference.resourceId, reference.versionId],
          client,
        );
    });
    this.gate?.check("create", { path: locator });
    const output = this.files[binary ? "write_binary" : "write_file"]({ path: locator, content });
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
        `SELECT * FROM agent_data.resources WHERE instance_id=$1 AND ${this.gate?.permissionHub ? '$2::uuid IS NOT NULL' : 'owner_id=$2'} AND id=$3`,
        [safeId(id)],
        client,
      )
    ).rows[0];
    this.authorize(row);
    return row;
  }
  async readById(id, args = {}) {
    const row = await this.get(id);
    await this.readable(row);
    if (!owns({ id: this.ownerId }, row)) return this.readShared(row, args);
    return /\.(png|jpeg|webp|mp4)$/i.test(row.locator) ? this.read_binary({ path: row.locator }) : this.read_file({ ...args, path: row.locator });
  }
  async registerImported(kb, locator, content) {
    this.gate.permissionHub.checkResource('knowledge', kb.id, 'modify');
    const body = this.blob(content), versionId = randomUUID();
    return this.locked(async client => {
      // 显式保存授权资源的 owner；不切换请求身份，admin 导入也不会写入自己的工作区。
      const row = (await this.query(`INSERT INTO agent_data.resources(instance_id,id,owner_id,source_id,locator,kind,state)
        SELECT $1,$3,$4,$5,$6,'original','pending' WHERE $2::uuid IS NOT NULL
        ON CONFLICT(instance_id,owner_id,locator) DO UPDATE SET source_id=EXCLUDED.source_id,kind='original',state='pending'
        WHERE resources.state='revoked' RETURNING id,current_version`, [randomUUID(), kb.owner_id, this.source(locator, 'read'), locator], client)).rows[0];
      if (!row) throw new AppError('该路径仍有有效资料登记。', 409);
      const id = row.id;
      // Recreating a deleted KB can reuse a revoked path; old immutable versions remain history.
      if (row.current_version) await this.invalidate(id, client);
      await this.query(`INSERT INTO agent_data.resource_versions(instance_id,id,resource_id,revision,blob,bytes)
        SELECT $1,$3,$4,$5,$6,$7 WHERE $2::uuid IS NOT NULL`, [versionId,id,body.revision,body.blob,body.bytes], client);
      await this.query(`UPDATE agent_data.resources SET current_version=$4,state='ready' WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL`, [id,versionId], client);
      return { resourceId: id, versionId, revision: body.revision };
    });
  }
  async readShared(row, args = {}) {
    // Hub 已授权知识库原文。只读取登记 owner 的 workspace，不借身份切换访问 CODEX_HOME。
    this.authorize(row);
    const record = (await this.query('SELECT uid FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$3 AND $2::uuid IS NOT NULL', [row.owner_id])).rows[0];
    if (!record) throw new AppError('来源运行环境尚未初始化。', 409);
    const base = this.ownerWorkspace(row.owner_id);
    const target = path.join(base, row.locator);
    if (!target.startsWith(base + path.sep)) throw new AppError('来源路径无效。', 404);
    const data = await readAsUser(record.uid, target, { maxBytes: 256 * 1024, isolated: process.getuid?.() === 0 });
    const version = (await this.query('SELECT revision FROM agent_data.resource_versions WHERE instance_id=$1 AND id=$3 AND $2::uuid IS NOT NULL', [row.current_version])).rows[0];
    if (!version || hash(data) !== version.revision) throw new AppError('共享来源已变化，请所有者重新登记版本。', 409, 'SOURCE_STALE');
    this.authorize(row);
    const content = data.toString('utf8'), limit = args.max_chars || 20000;
    return { path: row.locator, resourceId: row.id, versionId: row.current_version, revision: version.revision, content: content.slice(0, limit), truncated: content.length > limit };
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
      this.gate?.check("read", { path: row.locator, ownerId: row.owner_id });
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
    const output = this.files[/\.(png|jpeg|webp|mp4)$/i.test(locator) ? "read_binary" : "read_file"]({
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
        const content = this.files[/\.(png|jpeg|webp|mp4)$/i.test(row.locator) ? "read_binary" : "read_file"]({
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
