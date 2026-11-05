import fs from 'node:fs';
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
    const bindings = this.agent.definition.bindings.knowledgeBases || {};
    for (const [id, binding] of Object.entries(bindings)) {
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || binding.sourceRoot !== `inputs/${id}` || binding.wikiRoot !== `research/${id}/wiki`)
        fail('知识库路径必须为 inputs/<kbId> 和 research/<kbId>/wiki。');
      const result = await this.query(`INSERT INTO agent_data.knowledge_bases(instance_id,id,owner_id,source_root,wiki_root)
        VALUES($1,$3,$2,$4,$5) ON CONFLICT(instance_id,id) DO UPDATE SET source_root=EXCLUDED.source_root
        WHERE knowledge_bases.owner_id=$2 AND knowledge_bases.source_root=EXCLUDED.source_root AND knowledge_bases.wiki_root=EXCLUDED.wiki_root RETURNING id`,
      [id, binding.sourceRoot, binding.wikiRoot]);
      if (!result.rowCount) fail('知识库归属或路径冲突。');
    }
    // Registry covers every persisted KB, including KBs omitted from this Agent's configuration.
    // Otherwise a broad legacy 'inputs' binding could bypass an absent Agent mount via read_file.
    const registered = (await this.query('SELECT id,source_root,wiki_root FROM agent_data.knowledge_bases WHERE instance_id=$1 AND $2::uuid IS NOT NULL')).rows;
    this.gate.knowledgeBases = Object.freeze(Object.fromEntries(registered.map(row => [row.id,
      Object.freeze({ sourceRoot: row.source_root, wikiRoot: row.wiki_root })])));
    const ids = new Set();
    this.modes = {};
    for (const mount of this.agent.definition.agent.knowledge || []) {
      if (!bindings[mount.kbId] || ids.has(mount.kbId) || !mount.actions.includes('read')) fail('知识库绑定缺失、重复或没有 read 权限。');
      ids.add(mount.kbId);
      const kb = (await this.query('SELECT * FROM agent_data.knowledge_bases WHERE instance_id=$1 AND owner_id=$2 AND id=$3', [mount.kbId])).rows[0];
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
    this.gate.check(action, { kbId: id });
    const row = (await this.query('SELECT * FROM agent_data.knowledge_bases WHERE instance_id=$1 AND owner_id=$2 AND id=$3', [id], client)).rows[0];
    if (!row) throw new AppError('知识库不存在或无权访问。', 404);
    this.gate.check(action, { kbId: id, ownerId: row.owner_id });
    return row;
  }
  async list() {
    this.gate.current();
    const mounts = this.agent.definition.agent.knowledge || [];
    return Promise.all(mounts.map(async m => { const kb = await this.kb(m.kbId); return {
      kbId: kb.id, desiredMode: m.mode, effectiveMode: this.modes[kb.id], indexRevision: kb.index_revision,
      pending: m.mode !== this.modes[kb.id], actions: m.actions
    }; }));
  }
  async pages(kbId) {
    await this.kb(kbId);
    const rows = (await this.query(`SELECT p.slug,p.current_version AS "versionId",v.revision,v.created_at AS "createdAt"
      FROM agent_data.wiki_pages p JOIN agent_data.wiki_versions v ON v.instance_id=p.instance_id AND v.id=p.current_version
      JOIN agent_data.knowledge_bases k ON k.instance_id=p.instance_id AND k.id=p.kb_id
      WHERE p.instance_id=$1 AND k.owner_id=$2 AND p.kb_id=$3 ORDER BY p.slug LIMIT 201`, [kbId])).rows;
    this.gate.check('read', { kbId });
    // Listing grants no content validity; read() rechecks every source before returning the body.
    return { kbId, pages: rows.slice(0, 200), truncated: rows.length > 200 };
  }
  async importSource({ kbId, name, content, ...unknown }) {
    if (Object.keys(unknown).length || this.gate.current().kind !== 'operator')
      throw new AppError('原文导入只允许本地操作者。', 403, 'FORBIDDEN');
    const kb = await this.kb(kbId, 'update');
    if (typeof name !== 'string' || !/^[^./\\\x00-\x1f][^/\\\x00-\x1f]{0,119}\.(md|txt)$/i.test(name) ||
        typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 256 * 1024)
      throw new AppError('请选择非空 .md/.txt 文本，文件名不能含路径，大小不超过 256 KiB。', 400);
    if (kb.source_root !== `inputs/${kbId}` || !/^[a-z][a-z0-9-]{0,47}$/.test(kbId)) throw new AppError('知识库原文目录无效。', 409);
    const base = this.resources.files.workspace;
    const relative = `${kb.source_root}/${name}`;
    this.gate.check('read', { path: relative });
    // Human ingestion is separate from agent write_file: inputs stay read-only to the agent.
    let directory = base;
    for (const part of ['', ...kb.source_root.split('/')]) {
      if (part) directory = path.join(directory, part);
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('原文目录必须是真实目录。', 409);
    }
    this.gate.current();
    try { fs.writeFileSync(path.join(directory, name), content, { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { if (error.code === 'EEXIST') throw new AppError('同名原文已存在，请更换文件名；未覆盖。', 409); throw error; }
    try {
      const saved = await this.resources.read_file({ path: relative, max_chars: 1 });
      return { kbId, path: relative, resourceId: saved.resourceId, versionId: saved.versionId, bytes: Buffer.byteLength(content) };
    } catch {
      throw new AppError('原文已保存但版本登记未完成；请在资料浏览中读取核对，不要重复上传。', 409, 'IMPORT_UNCONFIRMED');
    }
  }
  wikiPath(locator) {
    return Object.entries(this.agent.definition.bindings.knowledgeBases || {}).find(([, b]) => locator === b.wikiRoot || locator.startsWith(b.wikiRoot + '/'));
  }
  async sourceVersions(kb, references, client) {
    if (!Array.isArray(references) || !references.length || references.length > 200) fail('必须引用 1–200 个当前原始资料版本。');
    const keys = new Set();
    for (const ref of references) {
      if (!ref || Object.keys(ref).sort().join(',') !== 'resourceId,versionId' || keys.has(ref.resourceId)) fail('来源引用格式无效或重复。');
      keys.add(ref.resourceId);
      const row = await this.resources.get(ref.resourceId, client);
      await this.resources.readable(row, client);
      if (!row.locator.startsWith(kb.source_root + '/') || row.kind !== 'original') fail('只接受本知识库的原始资料。');
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
      ON k.instance_id=p.instance_id AND k.id=p.kb_id WHERE p.instance_id=$1 AND k.owner_id=$2 AND p.kb_id=$3 AND p.slug=$4`, [kbId, slug])).rows[0];
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
      WHERE p.instance_id=$1 AND k.owner_id=$2 AND p.kb_id=$3 AND p.current_version IS NOT NULL ORDER BY p.slug LIMIT 201`, [kbId])).rows;
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
      WHERE j.instance_id=$1 AND k.owner_id=$2 AND j.id=$3`, [id])).rows[0];
    if (!row) throw new AppError('索引任务不存在。', 404);
    await this.kb(row.kb_id); return row;
  }
}
