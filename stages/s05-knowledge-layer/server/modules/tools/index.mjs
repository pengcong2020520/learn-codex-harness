import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createToolService, readToolSources } from "./loader.mjs";
import { createMcpToolServer } from "./mcp-server.mjs";
import { codexPaths } from "../codex/config.mjs";
import { ExecutionBoundary } from "../agents/boundary.mjs";

export { createToolService, readToolSources } from "./loader.mjs";
export { runWebCommand } from "./web-tools.mjs";

const MCP_NAME = "project_tools";

// 刷新会影响多个 Thread；全项目共用一个更新边界，不在任务中途换工具。
export class ToolManager {
  constructor({ config, runtime, log, redact, files, agent, gate, knowledge, boundary = new ExecutionBoundary() }) {
    Object.assign(this, { config, runtime, log, redact, files, agent, gate, knowledge, boundary });
    this.configFile = codexPaths(config.root).configFile;
    this.token = randomBytes(32).toString("hex");
    this.status = "loading"; this.error = null;
    Object.assign(boundary, { pending: () => Boolean(this.pending), unavailable: () => this.closed || this.broken,
      refresh: async () => { try { this.scan(); } catch (error) { this.pending = null; this.report(error); } }, apply: () => this.apply() });
  }
  async open() {
    this.registry = await this.build(readToolSources(this.config.root));
    if (!this.gate) {
      this.server = await createMcpToolServer({ token: this.token, redact: this.redact });
      this.server.registries.set(this.registry.version, this.registry);
      this.config.launch.env = { ...this.config.launch.env, PROJECT_MCP_TOKEN: this.token };
    }
    this.status = "ready";
    return this;
  }
  configuration() { return this.gate ? {} : { [MCP_NAME]: this.connection(this.registry) }; }
  dynamicTools() { return this.gate ? this.registry.specs.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })) : undefined; }
  async build(source) {
    const snapshotDir = fs.mkdtempSync(path.join(this.runtime.runDir, "tools-"));
    return createToolService(this.config.root, { source, snapshotDir, files: this.files, agent: this.agent, gate: this.gate, knowledge: this.knowledge,
      workspaceDir: this.runtime.workspaceDir, nodeEnv: this.config.launch.env.NODE_ENV || "development" });
  }
  connection(registry) {
    return { url: `${this.server.url}/${registry.version}`, bearer_token_env_var: "PROJECT_MCP_TOKEN",
      required: true, enabled: true, startup_timeout_sec: 15, tool_timeout_sec: 30, default_tools_approval_mode: "approve" };
  }
  attach({ rpc, isBusy = () => false, hub }) {
    Object.assign(this, { rpc, hub });
    this.boundary.isBusy = () => (this.server?.activeCalls || 0) > 0 || isBusy();
    this.timer = setInterval(() => { void this.poll().catch(error => this.report(error)); }, 1000);
    this.timer.unref();
  }
  busy() { return this.boundary.isBusy(); }
  serial(operation) {
    return this.boundary.serial(operation);
  }
  snapshot() {
    let specs = [];
    try { specs = this.registry?.specs || []; } catch { /* 配置撤销后不展示旧能力；report 仍须可用。 */ }
    return { status: this.status, version: this.registry?.version, pending: Boolean(this.pending), error: this.error,
      tools: specs.map(tool => ({ name: tool.name, label: tool.title })) };
  }
  publish() {
    const value = this.snapshot(), serialized = JSON.stringify(value);
    if (serialized === this.lastPublished) return;
    this.lastPublished = serialized;
    this.hub?.publish("tools", value);
  }
  report(error) {
    const message = this.redact(error.message);
    if (this.error !== message) this.log(`工具更新失败，保留上一版：${message}`);
    this.error = message; this.status = this.broken ? "unavailable" : "degraded"; this.publish();
  }
  scan() {
    this.agent?.assertCurrent();
    const source = readToolSources(this.config.root);
    if (source.version === this.registry.version) {
      this.pending = null; this.rejected = null;
      if (!this.broken) { this.error = null; this.status = "ready"; }
    } else if (source.version !== this.rejected) { this.pending = source; this.status = "pending"; }
    else this.pending = null;
  }
  async poll() {
    if (this.closed) return;
    return this.serial(async () => {
      if (this.closed) return;
      try { this.scan(); } catch (error) { this.pending = null; this.report(error); return; }
      if (this.pending && !this.busy()) await this.apply();
      this.publish();
    });
  }
  // turn/start 和目录刷新共用短锁，避免检查空闲后另一个窗口启动新轮。
  atBoundary(operation, options) { return this.boundary.run(operation, options); }
  async configure(registry) {
    if (this.gate) return;
    await this.rpc.request("config/value/write", { keyPath: `mcp_servers.${MCP_NAME}`, value: this.connection(registry),
      mergeStrategy: "replace", filePath: this.configFile });
    await this.rpc.request("config/mcpServer/reload");
  }
  async verify(registry = this.registry, threadId) {
    // 全局 inventory 证明发现成功，不冒充正在运行的 turn 的工具快照。
    const data = [], seen = new Set();
    let cursor;
    do {
      const page = await this.rpc.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}) });
      data.push(...page.data); cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("工具状态分页游标重复。");
      seen.add(cursor);
    } while (cursor);
    if (data.some(item => item.name !== MCP_NAME && Object.keys(item.tools || {}).length)) throw new Error("检测到项目之外的 MCP 工具，已拒绝继续。");
    if (this.gate) {
      if (data.some(item => Object.keys(item.tools || {}).length)) throw new Error('门禁模式不能同时暴露无任务身份的 MCP 工具。');
      return;
    }
    const found = data.find(item => item.name === MCP_NAME);
    const names = Object.values(found?.tools || {}).map(tool => tool.name).sort();
    if (!found || found.toolsError || JSON.stringify(names) !== JSON.stringify(registry.specs.map(tool => tool.name).sort())) throw new Error("Codex 工具发现尚未成功或工具目录不一致。");
    return found;
  }
  async apply() {
    const source = this.pending, previous = this.registry;
    if (!source) return;
    this.status = "loading"; this.publish();
    let candidate, changed = false;
    try {
      candidate = await this.build(source);
      this.server?.registries.set(candidate.version, candidate);
      changed = true;
      await this.configure(candidate);
      await this.verify(candidate);
      await this.agent?.activate(candidate.version);
      this.registry = candidate;
      this.pending = null; this.rejected = null; this.error = null; this.status = "ready";
      this.server?.registries.delete(previous.version);
      this.log(`工具目录已更新：${candidate.specs.map(tool => tool.name).join("、")}；后续轮次使用新版本。`);
      this.publish();
    } catch (error) {
      this.rejected = source.version; this.pending = null;
      if (changed) {
        try { await this.configure(previous); await this.verify(previous); }
        catch { this.broken = true; }
      }
      if (candidate) this.server?.registries.delete(candidate.version);
      this.report(error);
    }
  }
  label(name) { return this.registry.label(name); }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await this.boundary.chain.catch(() => {});
    await this.server?.close();
  }
}
