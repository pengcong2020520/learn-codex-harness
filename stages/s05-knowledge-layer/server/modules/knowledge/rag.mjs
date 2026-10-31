import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AppError } from '../../../shared/errors.mjs';

// Pin the tokenizer/chunker with every manifest, including the ICU version supplying Chinese word boundaries.
export const pipeline = `text-v1-800-120/intl-zh-${process.versions.icu}/bm25-k1=1.2-b=0.75/rrf60`;
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export const tokenize = text => [...segmenter.segment(text.normalize('NFKC').toLocaleLowerCase())].filter(s => s.isWordLike).map(s => s.segment);
export function chunks(sources) {
  const result = [];
  for (const source of sources) {
    const text = source.content.normalize('NFKC');
    for (let start = 0; start < text.length; start += 680) {
      const content = text.slice(start, start + 800);
      if (!content.trim()) continue;
      result.push({ id: createHash('sha256').update(`${source.resourceId}:${source.versionId}:${start}:${pipeline}`).digest('hex'),
        content, resourceId: source.resourceId, versionId: source.versionId, start, tokens: tokenize(content) });
      if (result.length > 20000) throw new Error('RAG 超过 20000 个分块上限。');
    }
  }
  return result;
}
export function bm25(documents, query, limit = 40) {
  const terms = [...new Set(tokenize(query))], n = documents.length;
  if (!n) return [];
  const average = documents.reduce((s, d) => s + d.tokens.length, 0) / n || 1;
  const frequencies = terms.map(term => documents.filter(d => d.tokens.includes(term)).length);
  return documents.map(d => ({ id: d.id, score: terms.reduce((sum, term, i) => {
    const tf = d.tokens.filter(t => t === term).length;
    return sum + Math.log(1 + (n - frequencies[i] + .5) / (frequencies[i] + .5)) *
      tf * 2.2 / (tf + 1.2 * (.25 + .75 * d.tokens.length / average));
  }, 0) })).filter(d => d.score > 0).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit).map(d => d.id);
}
export function fuse(...lists) {
  const scores = new Map();
  for (const list of lists) [...new Set(list)].forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 1 / (61 + i)));
  return [...scores].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, score]) => ({ id, score }));
}
export class Embeddings {
  constructor(config) {
    Object.assign(this, config);
    const endpoint = new URL(config.url);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname)))) throw new Error('Embedding 地址必须使用 HTTPS 或本机 HTTP。');
    if (!this.model || !Number.isInteger(this.dimensions) || this.dimensions < 1 || this.dimensions > 65536) throw new Error('必须配置 embedding 模型和向量维数。');
  }
  async generate(input) {
    const response = await fetch(this.url.replace(/\/$/, '') + '/embeddings', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, input })
    });
    if (!response.ok) throw new Error(`Embedding 服务失败（HTTP ${response.status}）。`);
    const blocks = []; let bytes = 0;
    for await (const block of response.body) {
      bytes += block.length;
      if (bytes > 16 * 1024 * 1024) throw new Error('Embedding 响应过大。');
      blocks.push(block);
    }
    const text = Buffer.concat(blocks).toString('utf8');
    const data = JSON.parse(text).data;
    if (!Array.isArray(data) || data.length !== input.length) throw new Error('Embedding 条目数量无效。');
    const vectors = data.sort((a,b) => a.index - b.index).map((item, i) => {
      if (item.index !== i || !Array.isArray(item.embedding) || item.embedding.length !== this.dimensions || item.embedding.some(n => !Number.isFinite(n))) throw new Error('Embedding 维数、顺序或数值无效。');
      return item.embedding;
    });
    return vectors;
  }
}
export async function createRag(config, directory) {
  if (!config?.chromaUrl && !config?.url) return null;
  if (!config.chromaUrl || !config.url) throw new Error('RAG 必须同时配置 CHROMA_URL 和 EMBEDDING_BASE_URL。');
  const { ChromaClient } = await import('chromadb');
  const endpoint = new URL(config.chromaUrl);
  if (!['127.0.0.1','localhost'].includes(endpoint.hostname) || endpoint.protocol !== 'http:' || endpoint.username || endpoint.password) throw new Error('首版 Chroma 仅允许本机 HTTP 服务。');
  // Each operation gets a fresh deadline; a long-lived client's initial AbortSignal would expire permanently.
  const connect = () => new ChromaClient({ host: endpoint.hostname, port: Number(endpoint.port || 80), ssl: false,
    fetchOptions: { signal: AbortSignal.timeout(30000) } });
  const collection = name => Object.fromEntries(['add','count','query'].map(method => [method, async args => {
    const selected = await connect().getCollection({ name, embeddingFunction: null });
    return selected[method](args);
  }]));
  const client = {
    async createCollection(options) { await connect().createCollection(options); return collection(options.name); },
    async getCollection(options) { return collection(options.name); },
    async deleteCollection(options) { return connect().deleteCollection(options); }
  };
  return new RagIndex({ client, embeddings: new Embeddings(config), directory });
}
export class RagIndex {
  constructor({ client, embeddings, directory }) {
    Object.assign(this, { client, embeddings, directory });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('BM25 存储不能是链接。');
  }
  filename(revision) {
    if (!/^[a-f0-9-]{36}$/.test(revision || '')) throw new Error('索引版本无效。');
    return path.join(this.directory, `${revision}.json`);
  }
  async ready(service, kb) {
    const row = (await service.query("SELECT manifest FROM agent_data.knowledge_indexes WHERE instance_id=$1 AND kb_id=$3 AND revision=$4 AND state='ready' AND $2::uuid IS NOT NULL", [kb.id, kb.index_revision])).rows[0];
    const m = row?.manifest;
    if (!m || m.pipeline !== pipeline || m.model !== this.embeddings.model || m.dimensions !== this.embeddings.dimensions) return false;
    try {
      const file = this.filename(m.revision), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024) return false;
      return createHash('sha256').update(fs.readFileSync(file)).digest('hex') === m.bm25Hash;
    } catch { return false; }
  }
  async build(service, kbId) {
    const kb = await service.kb(kbId, 'index'), revision = randomUUID();
    const manifest = { pipeline, model: this.embeddings.model, dimensions: this.embeddings.dimensions,
      collection: `kb-${service.instanceId}-${revision}`, revision, sources: [] };
    await service.query(`INSERT INTO agent_data.knowledge_indexes(instance_id,kb_id,revision,state,manifest)
      SELECT $1,$3,$4,'building',$5 WHERE $2::uuid IS NOT NULL`, [kbId, revision, manifest]);
    try {
      const sources = await service.sources(kbId), documents = chunks(sources);
      if (!documents.length) throw new Error('知识库没有可索引的正文。');
      manifest.sources = sources.map(s => ({ resourceId: s.resourceId, versionId: s.versionId }));
      const collection = await this.client.createCollection({ name: manifest.collection, embeddingFunction: null });
      for (let offset = 0; offset < documents.length; offset += 32) {
        await service.kb(kbId, 'index');
        const batch = documents.slice(offset, offset + 32);
        const vectors = await this.embeddings.generate(batch.map(d => d.content));
        await service.kb(kbId, 'index');
        await collection.add({ ids: batch.map(d => d.id), embeddings: vectors,
          metadatas: batch.map(d => ({ kbId, ownerId: service.ownerId, resourceId: d.resourceId, versionId: d.versionId, indexRevision: revision })) });
      }
      const body = JSON.stringify({ manifest, documents });
      manifest.bm25Hash = createHash('sha256').update(body).digest('hex');
      fs.writeFileSync(this.filename(revision), body, { flag: 'wx', mode: 0o600, flush: true });
      if (await collection.count() !== documents.length) throw new Error('Chroma 分块数量不完整。');
      await service.refresh(manifest.sources);
      await service.resources.locked(async db => {
        await service.kb(kbId, 'index', db);
        await service.sourceVersions(kb, manifest.sources, db);
        await service.query(`UPDATE agent_data.knowledge_indexes SET state='ready',manifest=$5 WHERE instance_id=$1 AND kb_id=$3 AND revision=$4 AND $2::uuid IS NOT NULL`, [kbId, revision, manifest], db);
        await service.query('UPDATE agent_data.knowledge_bases SET index_revision=$4 WHERE instance_id=$1 AND owner_id=$2 AND id=$3', [kbId, revision], db);
      });
      return { revision, chunks: documents.length };
    } catch (error) {
      await this.discard(manifest).catch(() => {});
      await service.query(`UPDATE agent_data.knowledge_indexes SET state='failed',error=$5 WHERE instance_id=$1 AND kb_id=$3 AND revision=$4 AND $2::uuid IS NOT NULL`, [kbId, revision, service.redact(error.message).slice(0, 1000)]);
      throw error;
    }
  }
  async discard(manifest) {
    if (manifest?.collection) await this.client.deleteCollection({ name: manifest.collection });
    if (manifest?.revision) fs.rmSync(this.filename(manifest.revision), { force: true });
  }
  async search(service, kb, query, limit) {
    const row = (await service.query(`SELECT * FROM agent_data.knowledge_indexes WHERE instance_id=$1 AND kb_id=$3 AND revision=$4 AND state='ready' AND $2::uuid IS NOT NULL`, [kb.id, kb.index_revision])).rows[0];
    if (!row) throw new AppError('RAG 尚未就绪，请先构建索引。', 409, 'RAG_NOT_READY');
    const manifest = row.manifest;
    if (manifest.pipeline !== pipeline || manifest.model !== this.embeddings.model || manifest.dimensions !== this.embeddings.dimensions) throw new AppError('索引模型或处理版本不兼容，请重建。', 409, 'INDEX_INCOMPATIBLE');
    await service.refresh(manifest.sources);
    await service.sourceVersions(kb, manifest.sources);
    const filename = this.filename(manifest.revision), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024) throw new Error('BM25 索引文件无效。');
    const raw = fs.readFileSync(filename, 'utf8');
    if (createHash('sha256').update(raw).digest('hex') !== manifest.bm25Hash) throw new Error('BM25 索引校验失败。');
    const { documents } = JSON.parse(raw);
    const [vector] = await this.embeddings.generate([query]);
    const collection = await this.client.getCollection({ name: manifest.collection, embeddingFunction: null });
    const result = await collection.query({ queryEmbeddings: [vector], nResults: Math.min(40, documents.length),
      where: { $and: [{ kbId: kb.id }, { ownerId: service.ownerId }, { indexRevision: manifest.revision }] }, include: [] });
    const byId = new Map(documents.map(d => [d.id, d]));
    const hits = fuse(result.ids[0], bm25(documents, query)).filter(hit => byId.has(hit.id)).slice(0, limit)
      .map(hit => { const { tokens, ...document } = byId.get(hit.id); return { ...document, score: hit.score }; });
    await service.refresh(manifest.sources); await service.kb(kb.id);
    return { mode: 'rag', indexRevision: manifest.revision, hits };
  }
}
