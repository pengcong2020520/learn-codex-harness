import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/errors.mjs';
import { MAX_MEDIA_BYTES, mediaFormat } from '../data/files.mjs';

const terminal = status => ['completed', 'failed'].includes(status);
const tokens = (usage = {}) => ({
  inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
  cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
  outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
  reasoningOutputTokens: usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0,
  ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
});

export class MediaService {
  constructor({ router, endpoint, store, files, usage, gate, agent, fetchImpl = fetch,
    now = Date.now, intervalMs = 10_000, timeoutMs = 20 * 60_000, redact = value => value, log = () => {} }) {
    Object.assign(this, { router, endpoint, store, files, usage, gate, agent, fetchImpl, now, intervalMs, timeoutMs, redact, log });
    this.controller = new AbortController();
    this.submitting = new Set();
  }
  available(purpose) {
    if (!this.endpoint || !this.router || !this.store) return false;
    try { this.router.resolve({ purpose }); return true; }
    catch (error) { if (error.code === 'MODEL_UNAVAILABLE') return false; throw error; }
  }
  async budget() {
    const status = await this.usage.budgetStatus();
    if (status.exceeded) throw new AppError(`媒体工具预算已超：${status.reason}；恢复时间 ${status.resetsAt}`, 429, 'BUDGET_EXCEEDED');
  }
  async request(route, { body, signal, binary = false, timeout = 120_000 } = {}) {
    const response = await this.fetchImpl(`${this.endpoint.baseUrl.replace(/\/$/, '')}${route}`, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${this.endpoint.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(Math.max(1, timeout)), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      // 只取错误码，不转出服务商的错误原文（里面可能有账户编号）；模型没开通是最常见的原因，直接说怎么办。
      const code = await response.text().then(text => { try { return JSON.parse(text).error?.code; } catch { return null; } }, () => null);
      const hint = code === 'ModelNotOpen' ? '：模型还没有在服务商控制台开通' : code && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? `：${code}` : '';
      throw new AppError(`媒体网关请求失败（HTTP ${response.status}）${hint}。`, response.status);
    }
    const limit = binary ? MAX_MEDIA_BYTES : MAX_MEDIA_BYTES * 2;
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) throw new Error('媒体网关返回内容过大。');
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    return binary ? content : JSON.parse(content.toString('utf8'));
  }
  target(relative, extension) {
    return relative || `${this.agent.outputs.directory}/media/${this.now()}-${randomUUID()}.${extension}`;
  }
  preflight(locator) {
    this.gate?.check('create', { path: locator });
    if (fs.existsSync(this.files.check_binary(locator))) throw new Error('文件已存在，未覆盖。请使用新版本文件名。');
  }
  async generateImage({ prompt, quality, size = '2048x2048', n = 1, path: relative }, { signal, context } = {}) {
    await this.budget();
    if (quality !== undefined && !['fast', 'strong'].includes(quality)) throw new AppError('quality 只能是 fast 或 strong。', 400);
    const model = this.router.resolve({ purpose: 'image', model: quality }).id;
    const target = this.target(relative, 'png'), ext = path.extname(target);
    if (!['.png', '.jpeg', '.webp'].includes(ext.toLowerCase())) throw new Error('图片路径必须是 png / jpeg / webp。');
    const paths = Array.from({ length: n }, (_, i) => n === 1 ? target : `${target.slice(0, -ext.length)}-${i + 1}${ext}`);
    paths.forEach(locator => this.preflight(locator));
    const response = await this.request('/images/generations', { body: { model, prompt, size, n, response_format: 'b64_json' }, signal });
    if (!Array.isArray(response.data) || !response.data.length || response.data.length > n) throw new Error('生图返回数量无效。');
    // 已生成的图片即使保存失败也记账；不以本地落盘成功掩盖供应商消耗。
    await this.usage.record({ ...context, ...tokens(response.usage), source: 'image', model, units: response.data.length });
    const images = [];
    for (const [index, item] of response.data.entries()) {
      if (typeof item.b64_json !== 'string' || !item.b64_json.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.b64_json)) throw new Error('生图缺少有效 b64_json。');
      const content = Buffer.from(item.b64_json, 'base64'), format = mediaFormat(content);
      if (format === 'mp4') throw new Error('生图返回了视频。');
      // 未指定文件名时按实际格式落盘；显式路径与格式不符则拒绝。
      const locator = relative ? paths[index] : paths[index].replace(/\.png$/, `.${format}`);
      this.preflight(locator);
      images.push(await this.files.write_binary({ path: locator, content }));
    }
    return { paths: images.map(item => item.path), model, size, images };
  }
  async generateVideo({ prompt, quality, seconds = 5, size = '1280x720', path: relative }, { signal, context } = {}) {
    await this.budget();
    if (quality !== undefined && !['fast', 'strong'].includes(quality)) throw new AppError('quality 只能是 fast 或 strong。', 400);
    const model = this.router.resolve({ purpose: 'video', model: quality }).id;
    const locator = this.target(relative, 'mp4');
    if (path.extname(locator).toLowerCase() !== '.mp4') throw new Error('视频路径必须是 mp4。');
    this.preflight(locator);
    const job = { id: randomUUID(), status: 'submitting', model, seconds, size, path: locator,
      createdAt: this.now(), deadline: this.now() + this.timeoutMs,
      agentId: this.agent.definition.agent.id, context: context || {} };
    this.submitting.add(job.id);
    try {
      await this.store.save(job);
      const response = await this.request('/videos', { body: { model, prompt, seconds: String(seconds), size }, signal });
      if (typeof response.id !== 'string' || !response.id || response.id.length > 500) throw new Error('网关没有返回有效视频任务 ID。');
      Object.assign(job, { providerId: response.id, status: 'queued' });
      await this.store.save(job);
    } catch (error) {
      await this.fail(job, `提交结果未确认，不会自动重提：${error.message}`);
      throw error;
    } finally { this.submitting.delete(job.id); }
    return { id: job.id, providerId: job.providerId, status: job.status, model, seconds, size };
  }
  // 查询不产生费用：超预算时也要能看到已经付费的视频做到哪一步了。
  async status({ id }) {
    const job = await this.store.get(id);
    if (!job || job.agentId !== this.agent.definition.agent.id) throw new AppError('媒体任务不存在或无权访问。', 404);
    return { id: job.id, providerId: job.providerId, status: job.status, model: job.model, seconds: job.seconds, size: job.size,
      ...(job.status === 'completed' ? { path: job.path, artifact: job.artifact } : {}), ...(job.error ? { error: job.error } : {}) };
  }
  async fail(job, reason) {
    Object.assign(job, { status: 'failed', error: this.redact(reason).slice(0, 2000) });
    await this.store.save(job);
  }
  async poll(job) {
    if (terminal(job.status) || this.submitting.has(job.id)) return;
    if (!job.providerId) return this.fail(job, '服务在提交期间中断，远端结果未确认；为避免重复收费，不自动重提。');
    if (this.now() >= job.deadline) return this.fail(job, '视频任务超过最长等待时间。');
    const operation = async () => {
      this.gate?.check('tool.call', { name: 'generate_video' });
      this.gate?.check('create', { path: job.path });
      const remaining = () => Math.max(1, job.deadline - this.now());
      const result = await this.request(`/videos/${encodeURIComponent(job.providerId)}`, { timeout: Math.min(30_000, remaining()) });
      if (result.status === 'failed') return this.fail(job, `视频生成失败：${result.error?.message || result.error || '服务商未提供原因'}`);
      if (this.now() >= job.deadline) return this.fail(job, '视频任务超过最长等待时间。');
      if (result.status !== 'completed') {
        job.status = result.status === 'queued' ? 'queued' : 'in_progress';
        await this.store.save(job); return;
      }
      // 使用任务 ID 去重，崩溃后再次查询完成结果不会重复记账。
      await this.usage.record({ ...job.context, ...tokens(result.usage), source: 'video', model: job.model,
        units: job.seconds, eventKey: `video:${job.id}` });
      const content = await this.request(`/videos/${encodeURIComponent(job.providerId)}/content`, { binary: true, timeout: Math.min(120_000, remaining()) });
      if (this.now() >= job.deadline) return this.fail(job, '视频任务超过最长等待时间。');
      const output = await this.files.write_binary({ path: job.path, content, operationId: job.id });
      Object.assign(job, { status: 'completed', artifact: output.artifact });
      delete job.error;
      await this.store.save(job);
    };
    try {
      if (job.agentId !== this.agent.definition.agent.id) throw new Error('Agent 已变化，停止保存视频。');
      if (this.gate) await this.gate.run(this.gate.media(job), operation, this.controller.signal);
      else await operation();
    } catch (error) {
      if (this.controller.signal.aborted) return;
      // 查询或下载的暂时故障保留任务，下次轮询再试；权限和落盘错误直接失败。
      if (error.name === 'TimeoutError' || error.name === 'TypeError' || error.status >= 500 || error.status === 429) {
        job.error = this.redact(error.message).slice(0, 2000); await this.store.save(job);
      } else await this.fail(job, error.message);
    }
  }
  tick() {
    if (this.running || this.controller.signal.aborted) return this.running;
    this.running = (async () => { for (const job of await this.store.pending()) { if (this.controller.signal.aborted) break; await this.poll(job); } })()
      .finally(() => { this.running = null; });
    return this.running;
  }
  open() {
    const run = () => { void this.tick().catch(error => this.log(`媒体后台任务失败：${this.redact(error.message)}`)); };
    this.timer = setInterval(run, this.intervalMs); this.timer.unref(); run();
    return this;
  }
  async close() { clearInterval(this.timer); this.controller.abort(); await this.running; }
}
