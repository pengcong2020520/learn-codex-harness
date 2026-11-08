import fs from 'node:fs';
import { declaredKnowledgeMounts, effectiveKnowledgeMounts } from './mounts.mjs';
import { prepareKnowledgeDirectories, removeKnowledgeDirectories, createSourceFile } from './directories.mjs';
import { userFileOperation } from '../runtimes/user-files.mjs';
import { resourcePath, validateKnowledgeBindings } from '../data/paths.mjs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Repository } from '../data/repository.mjs';
import { AppError } from '../../../shared/errors.mjs';

const fail = (text, code = 'KNOWLEDGE_INVALID') => { throw new AppError(text, 409, code); };
const slugPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
export class KnowledgeService extends Repository {
  constructor(pool, scope, { agent, gate, resources, rag, redact = value => String(value) }) {
    super(pool, scope); Object.assign(this, { agent, gate, resources, rag, redact });
  }
  async open() {
    const bindings = validateKnowledgeBindings(this.agent.definition.bindings.knowledgeBases || {});
    const existing = (await this.query('SELECT id,source_root,wiki_root,user_created FROM agent_data.knowledge_bases WHERE instance_id=$1 AND $2::uuid IS NOT NULL')).rows;
    validateKnowledgeBindings({ ...Object.fromEntries(existing.map(row => [row.id, { sourceRoot: row.source_root, wikiRoot: row.wiki_root }])), ...bindings });
    for (const [id, binding] of Object.entries(bindings)) {
      if (this.gate.permissionHub) { await this.gate.permissionHub.registerKnowledge(this.ownerId, id, binding); continue; }
      const result = await this.query(`INSERT INTO agent_data.knowledge_bases(instance_id,id,owner_id,source_root,wiki_root)
        VALUES($1,$3,$2,$4,$5) ON CONFLICT(instance_id,id) DO UPDATE SET source_root=EXCLUDED.source_root
        WHERE knowledge_bases.owner_id=$2 AND knowledge_bases.source_root=EXCLUDED.source_root AND knowledge_bases.wiki_root=EXCLUDED.wiki_root RETURNING id`,
      [id, binding.sourceRoot, binding.wikiRoot]);
      if (!result.rowCount) fail('知识库归属或路径冲突。');
    }
    // Registry covers every persisted KB, including KBs omitted from this Agent's configuration.
    // Otherwise a broad source binding could bypass an absent Agent mount via read_file.
    const registered = (await this.query('SELECT id,source_root,wiki_root,user_created FROM agent_data.knowledge_bases WHERE instance_id=$1 AND $2::uuid IS NOT NULL')).rows;
    validateKnowledgeBindings(Object.fromEntries(registered.map(row => [row.id, { sourceRoot: row.source_root, wikiRoot: row.wiki_root }])));
    this.gate.knowledgeBases = Object.freeze(Object.fromEntries(registered.map(row => [row.id,
      Object.freeze({ sourceRoot: row.source_root, wikiRoot: row.wiki_root })])));
    const ids = new Set();
    this.modes = {};
    const modeBindings = { ...Object.fromEntries(registered.map(r => [r.id, { sourceRoot: r.source_root, wikiRoot: r.wiki_root }])), ...bindings };
    for (const mount of declaredKnowledgeMounts(this.agent, registered.map(r => ({ ...r, type: 'knowledge' })))) {
      if (!modeBindings[mount.kbId] || ids.has(mount.kbId) || !mount.actions.includes('read')) fail('知识库绑定缺失、重复或没有 read 权限。');
      ids.add(mount.kbId);
      const kb = (await this.query('SELECT * FROM agent_data.knowledge_bases WHERE instance_id=$1 AND $2::uuid IS NOT NULL AND id=$3', [mount.kbId])).rows[0];
      if (!kb) continue; // Explicitly deleted configured defaults stay deleted until POST /knowledge.
      // Effective mode changes only at service startup; queued tasks/Threads bind the resulting descriptor.
      const prepared = mount.mode === 'rag' && kb.index_revision && this.rag && await this.rag.ready(this, kb);
      const previous = (await this.query('SELECT effective_mode FROM agent_data.knowledge_mounts WHERE instance_id=$1 AND agent_id=$3 AND kb_id=$4 AND $2::uuid IS NOT NULL', [this.agent.definition.agent.id, mount.kbId])).rows[0];
      if (mount.mode === 'rag' && previous?.effective_mode === 'rag' && !prepared) fail('已启用的 RAG 当前不可用；恢复配置或显式切回 Wiki 后重建索引。', 'RAG_NOT_READY');
      const effective = prepared ? 'rag' : 'wiki';
      this.modes[mount.kbId] = effective;
      await this.query(`INSERT INTO agent_data.knowledge_mounts(instance_id,agent_id,kb_id,desired_mode,effective_mode)
        SELECT $1,$3,$4,$5,$6 WHERE $2::uuid IS NOT NULL ON CONFLICT(instance_id,agent_id,kb_id)
        DO UPDATE SET desired_mode=EXCLUDED.desired_mode,effective_mode=EXCLUDED.effective_mode`,
      [this.agent.definition.agent.id, mount.kbId, mount.mode, effective]);
    }
    return this;
  }
  async kb(id, action = 'read', client = this.pool) {
    const row = (await this.query(`SELECT * FROM agent_data.knowledge_bases WHERE instance_id=$1 AND ${this.gate.permissionHub ? '$2::uuid IS NOT NULL' : 'owner_id=$2'} AND id=$3`, [id], client)).rows[0];
    if (!row) throw new AppError('知识库不存在或无权访问。', 404);
    if (this.gate.permissionHub) this.gate.permissionHub.checkResource('knowledge', id, action === 'read' ? 'read' : 'modify');
    this.gate.check(action, { kbId: id, ...(this.gate.permissionHub ? {} : { ownerId: row.owner_id }) });
    return row;
  }
  async list() {
    this.gate.current();
    const mounts = effectiveKnowledgeMounts(this.agent, this.gate.permissionHub);
    const owned = this.gate.permissionHub ? new Set(this.gate.permissionHub.visible().filter(r => r.type === 'knowledge').map(r => r.id)) : new Set((await this.query('SELECT id FROM agent_data.knowledge_bases WHERE instance_id=$1 AND owner_id=$2')).rows.map(row => row.id));
    return Promise.all(mounts.filter(m => owned.has(m.kbId)).map(async m => { const kb = await this.kb(m.kbId); return {
      kbId: kb.id, title: kb.title || kb.id, visibility: kb.visibility, desiredMode: m.mode, effectiveMode: this.modes[kb.id] || 'wiki', indexRevision: kb.index_revision,
      pending: m.mode !== (this.modes[kb.id] || 'wiki'), actions: m.actions
    }; }));
  }
  async ownerFiles(owner, client) {
    const record = (await this.query('SELECT uid FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$3 AND $2::uuid IS NOT NULL', [owner], client)).rows[0];
    if (!record) throw new AppError('所有者运行环境尚未初始化。', 409);
    return { uid: record.uid, workspace: path.join(path.dirname(this.resources.files.workspace), owner) };
  }
  async create(body) {
    this.gate.current();
    if (!this.gate.permissionHub) throw new AppError('需要 Hub。', 409);
    return this.gate.permissionHub.createKnowledge(body, async (owner, binding, client) => {
      const { uid, workspace } = await this.ownerFiles(owner, client), bindings = { [body.kbId]: binding };
      if (process.getuid?.() === 0) await userFileOperation(uid, 'knowledge-create', { workspace, bindings });
      else prepareKnowledgeDirectories(workspace, bindings, { exclusive: true });
    });
  }
  async delete(id) {
    this.gate.current();
    if (!this.gate.permissionHub) throw new AppError('需要 Hub。', 409);
    const remove = () => this.gate.permissionHub.deleteKnowledge(id, async (row, indexes, client) => {
      // Active in-memory contexts supplement durable starting/running task records.
      if ([...this.gate.runs.values()].some(run => run.context.policy?.resources.has(`knowledge:${id}`) &&
          this.gate.permissionHub.run(run.context.policy, () => effectiveKnowledgeMounts(this.agent, this.gate.permissionHub).some(m => m.kbId === id))))
        throw new AppError('知识库仍被执行中任务挂载。', 409, 'KNOWLEDGE_BUSY');
      if (indexes.some(i => i.manifest) && !this.rag) throw new AppError('需要恢复 RAG 配置后清理索引。', 409);
      for (const index of indexes) if (index.manifest) await this.rag.discard(index.manifest);
      const { uid, workspace } = await this.ownerFiles(row.owner_id, client);
      const binding = { sourceRoot: row.source_root, wikiRoot: row.wiki_root };
      if (process.getuid?.() === 0) await userFileOperation(uid, 'knowledge-delete', { workspace, binding });
      else removeKnowledgeDirectories(workspace, binding);
    });
    const result = await (this.boundary ? this.boundary.run(remove) : remove());
    delete this.modes[id];
    return result;
  }
  async pages(kbId) {
    await this.kb(kbId);
    const rows = (await this.query(`SELECT p.slug,p.current_version AS "versionId",v.revision,v.created_at AS "createdAt"
      FROM agent_data.wiki_pages p JOIN agent_data.wiki_versions v ON v.instance_id=p.instance_id AND v.id=p.current_version
      JOIN agent_data.knowledge_bases k ON k.instance_id=p.instance_id AND k.id=p.kb_id
      WHERE p.instance_id=$1 AND ${this.gate.permissionHub ? '$2::uuid IS NOT NULL' : 'k.owner_id=$2'} AND p.kb_id=$3 ORDER BY p.slug LIMIT 201`, [kbId])).rows;
    this.gate.check('read', { kbId });
    // Listing grants no content validity; read() rechecks every source before returning the body.
    return { kbId, pages: rows.slice(0, 200), truncated: rows.length > 200 };
  }
  async importSource(body) {
    const operation = () => this.importSourceAtBoundary(body);
    return this.boundary ? this.boundary.run(operation) : operation();
  }
  async importSourceAtBoundary({ kbId, name, content, ...unknown }) {
    if (Object.keys(unknown).length || !['operator', 'user'].includes(this.gate.current().kind))
      throw new AppError('原文导入只允许本地操作者。', 403, 'FORBIDDEN');
    const kb = await this.kb(kbId, 'update');
    if (typeof name !== 'string' || !/^[^./\\\x00-\x1f][^/\\\x00-\x1f]{0,119}\.(md|txt)$/i.test(name) ||
        typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 256 * 1024)
      throw new AppError('请选择非空 .md/.txt 文本，文件名不能含路径，大小不超过 256 KiB。', 400);
    resourcePath(kb.source_root);
    const base = this.gate.permissionHub
      ? path.join(path.dirname(this.resources.files.workspace), kb.owner_id)
      : this.resources.files.workspace;
    const ownerRuntime = this.gate.permissionHub ? (await this.query('SELECT uid FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$3 AND $2::uuid IS NOT NULL', [kb.owner_id])).rows[0] : null;
    if (this.gate.permissionHub && !ownerRuntime) throw new AppError('所有者运行环境尚未初始化。', 409);
    const relative = `${kb.source_root}/${name}`;
    this.gate.check('read', { path: relative });
    // Human ingestion remains separate from agent write_file (sources are read-only).
    this.gate.current();
    createSourceFile(base, kb.source_root, name, content, ownerRuntime?.uid);
    try {
      const saved = this.gate.permissionHub
        ? await this.resources.registerImported(kb, relative, content)
        : await this.resources.read_file({ path: relative, max_chars: 1 });
      return { kbId, path: relative, resourceId: saved.resourceId, versionId: saved.versionId, bytes: Buffer.byteLength(content) };
    } catch {
      throw new AppError('原文已保存但版本登记未完成；请在资料浏览中读取核对，不要重复上传。', 409, 'IMPORT_UNCONFIRMED');
    }
  }
  wikiPath(locator) {
    return Object.entries(this.gate.bindings()).find(([, b]) => locator === b.wikiRoot || locator.startsWith(b.wikiRoot + '/'));
  }
  async sourceVersions(kb, references, client) {
    if (!Array.isArray(references) || !references.length || references.length > 200) fail('必须引用 1–200 个当前原始资料版本。');
    const keys = new Set();
    for (const ref of references) {
      if (!ref || Object.keys(ref).sort().join(',') !== 'resourceId,versionId' || keys.has(ref.resourceId)) fail('来源引用格式无效或重复。');
      keys.add(ref.resourceId);
      const row = await this.resources.get(ref.resourceId, client);
      await this.resources.readable(row, client);
      if (row.owner_id !== kb.owner_id || !row.locator.startsWith(kb.source_root + '/') || row.kind !== 'original') fail('只接受本知识库的原始资料。');
      if (row.current_version !== ref.versionId) fail('来源版本已变化，需要重新读取。', 'SOURCE_STALE');
    }
  }
  async refresh(references) {
    for (const ref of references) {
      const current = await this.resources.readById(ref.resourceId, { max_chars: 1 });
      if (current.versionId !== ref.versionId) fail('引用来源已变化，需要重新编写或重建索引。', 'SOURCE_STALE');
    }
  }
  readBlob(blob, revision) {
    if (!/^[a-f0-9]{64}\.txt$/.test(blob || '')) fail('知识正文路径无效。');
    const file = path.join(this.resources.blobDir, blob), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 262144) fail('知识正文无效。');
    const content = fs.readFileSync(file, 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== revision) fail('知识正文校验失败。');
    return content;
  }
  async read({ kbId, slug }) {
    const kb = await this.kb(kbId);
    if (!slugPattern.test(slug || '')) fail('Wiki 页面名称无效。');
    const row = (await this.query(`SELECT v.* FROM agent_data.wiki_pages p JOIN agent_data.wiki_versions v
      ON v.instance_id=p.instance_id AND v.id=p.current_version JOIN agent_data.knowledge_bases k
      ON k.instance_id=p.instance_id AND k.id=p.kb_id WHERE p.instance_id=$1 AND ${this.gate.permissionHub ? '$2::uuid IS NOT NULL' : 'k.owner_id=$2'} AND p.kb_id=$3 AND p.slug=$4`, [kbId, slug])).rows[0];
    if (!row) throw new AppError('没有生效的 Wiki 页面。', 404);
    await this.refresh(row.sources); await this.sourceVersions(kb, row.sources);
    const content = this.readBlob(row.blob, row.revision);
    this.gate.check('read', { kbId });
    return { kbId, slug, versionId: row.id, revision: row.revision, content, source_versions: row.sources };
  }
  async submit({ kbId, slug, content, expectedVersion, source_versions }) {
    const kb = await this.kb(kbId, 'update');
    if (!slugPattern.test(slug || '') || typeof content !== 'string' || !content.trim() || !/^#\s+\S/m.test(content)) fail('Wiki 正文需要 Markdown 标题和有效页面名称。');
    if (expectedVersion !== null && !/^[a-f0-9-]{36}$/.test(expectedVersion || '')) fail('必须提供 expectedVersion，新建使用 null。');
    // Validate authority before touching a foreign resource or disclosing its metadata.
    if (!Array.isArray(source_versions) || source_versions.length > 50) fail("Wiki 最多引用 50 个来源。");
    await this.sourceVersions(kb, source_versions);
    await this.refresh(source_versions);
    const body = this.resources.blob(content), id = randomUUID();
    return this.resources.locked(async client => {
      await this.kb(kbId, 'update', client);
      await this.sourceVersions(kb, source_versions, client);
      await this.query(`INSERT INTO agent_data.wiki_pages(instance_id,kb_id,slug) SELECT $1,$3,$4 WHERE $2::uuid IS NOT NULL ON CONFLICT DO NOTHING`, [kbId, slug], client);
      const page = (await this.query('SELECT * FROM agent_data.wiki_pages WHERE instance_id=$1 AND kb_id=$3 AND slug=$4 AND $2::uuid IS NOT NULL FOR UPDATE', [kbId, slug], client)).rows[0];
      if (page.current_version !== expectedVersion) fail('Wiki 已被其他更新修改，请读取最新版本。', 'VERSION_CONFLICT');
      await this.query(`INSERT INTO agent_data.wiki_versions(instance_id,id,kb_id,slug,revision,blob,sources)
        SELECT $1,$3,$4,$5,$6,$7,$8 WHERE $2::uuid IS NOT NULL`, [id, kbId, slug, body.revision, body.blob, JSON.stringify(source_versions)], client);
      this.gate.check('update', { kbId });
      await this.query('UPDATE agent_data.wiki_pages SET current_version=$5 WHERE instance_id=$1 AND kb_id=$3 AND slug=$4 AND $2::uuid IS NOT NULL', [kbId, slug, id], client);
      return { kbId, slug, versionId: id, effective: true, source_versions };
    });
  }
  async search({ kbId, query, limit = 5 }) {
    const kb = await this.kb(kbId);
    if (typeof query !== 'string' || !query.trim() || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20) fail('查询或 limit 无效。');
    if (this.modes[kbId] === 'rag') return this.rag.search(this, kb, query, limit);
    const pages = (await this.query(`SELECT p.slug FROM agent_data.wiki_pages p JOIN agent_data.knowledge_bases k ON k.instance_id=p.instance_id AND k.id=p.kb_id
      WHERE p.instance_id=$1 AND ${this.gate.permissionHub ? '$2::uuid IS NOT NULL' : 'k.owner_id=$2'} AND p.kb_id=$3 AND p.current_version IS NOT NULL ORDER BY p.slug LIMIT 201`, [kbId])).rows;
    const hits = [];
    for (const { slug } of pages.slice(0, 200)) {
      let page;
      try { page = await this.read({ kbId, slug }); }
      catch (error) { if (['SOURCE_STALE'].includes(error.code) || [404,409].includes(error.status)) continue; throw error; }
      const offset = page.content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (offset >= 0) hits.push({ ...page, content: page.content.slice(Math.max(0, offset - 100), offset + 800) });
      if (hits.length === limit) break;
    }
    this.gate.check('read', { kbId });
    return { mode: 'wiki', hits, scanLimit: 200, truncated: pages.length > 200 };
  }
  async sources(kbId) {
    const kb = await this.kb(kbId), found = [], pending = [kb.source_root];
    let visited = 0;
    while (pending.length) {
      if (++visited > 200) fail('知识库目录超过首版扫描上限。');
      const directory = pending.shift();
      const result = await this.resources.list_files({ path: directory });
      if (result.truncated) fail("目录条目超过扫描上限，拒绝构建不完整索引。");
      for (const entry of result.entries) {
        const locator = directory + '/' + entry.name;
        if (entry.type === 'directory') pending.push(locator);
        else if (entry.type === 'file' && /\.(md|txt)$/i.test(entry.name)) {
          if (found.length >= 200) fail('知识库超过首版 200 个来源上限。');
          found.push(await this.resources.read_file({ path: locator, max_chars: 262144 }));
        }
      }
    }
    return found;
  }
  async enqueueIndex(kbId) {
    await this.kb(kbId, 'index');
    if (!this.rag) fail('未配置 RAG 的 Chroma 与 embedding 服务。', 'RAG_UNAVAILABLE');
    const id = randomUUID();
    await this.query(`INSERT INTO agent_data.knowledge_jobs(instance_id,id,kb_id) SELECT $1,$3,$4 WHERE $2::uuid IS NOT NULL`, [id, kbId]);
    await this.worker?.wake(id);
    return { jobId: id, status: 'queued' };
  }
  async job(id) {
    const row = (await this.query(`SELECT j.* FROM agent_data.knowledge_jobs j JOIN agent_data.knowledge_bases k ON j.instance_id=k.instance_id AND j.kb_id=k.id
      WHERE j.instance_id=$1 AND ${this.gate.permissionHub ? '$2::uuid IS NOT NULL' : 'k.owner_id=$2'} AND j.id=$3`, [id])).rows[0];
    if (!row) throw new AppError('索引任务不存在。', 404);
    await this.kb(row.kb_id); return row;
  }
}
