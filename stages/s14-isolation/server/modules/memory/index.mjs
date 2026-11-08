import { readAsUser } from '../runtimes/user-files.mjs';
import path from "node:path";
import { AppError, requireId } from "../../../shared/errors.mjs";

const SUMMARY_LIMIT = 64 * 1024;
const FILES = ["memory_summary.md", "MEMORY.md", "raw_memories.md"];

// 固定文件白名单；用户目录的校验、打开和读取全部在该 uid 下执行。
async function readArtifact(root, name, content = false, codexHome, uid = process.getuid?.(), isolated) {
  try {
    const { data, metadata } = await readAsUser(uid, path.join(codexHome || path.join(root, '.data/codex'), 'memories', name), {
      maxBytes: SUMMARY_LIMIT, metadata: true, metadataOnly: !content, truncate: true, isolated,
    });
    return { exists: true, bytes: metadata.bytes, updatedAt: metadata.updatedAt,
      ...(content ? { text: data.toString('utf8'), truncated: metadata.truncated } : {}) };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false, bytes: 0, updatedAt: null }; throw error; }
}

export class MemoryService {
  constructor({ rpc, config, sessions, redact }) {
    Object.assign(this, { rpc, config, sessions, redact });
  }

  async verify() {
    const { config: actual } = await this.rpc.request("config/read", { includeLayers: false });
    const memory = actual?.memories;
    const requested = this.config.memory;
    if (actual?.features?.memories !== requested.enabled || memory?.use_memories !== requested.use ||
        memory?.generate_memories !== requested.generate || memory?.extract_model !== (requested.extractModel ?? null) ||
        memory?.consolidation_model !== (requested.consolidationModel ?? null) || memory?.min_rollout_idle_hours !== requested.minIdleHours) {
      throw new Error("Codex 记忆配置与服务端配置不一致，请检查配置覆盖；不会假报开启成功。");
    }
    this.effective = { ...requested };
    // 0.154.0 隔离测试确认：当前禁用原生写工具时，后台合并不能写出最终摘要。
    this.generationBlocked = actual.features.shell_tool === false && actual.features.apply_patch_freeform === false;
  }

  async snapshot() {
    if (!this.effective) throw new AppError("尚未核验 Codex 记忆配置。", 503);
    const artifacts = Object.fromEntries(await Promise.all(FILES.map(async name => [name, this.effective.enabled ? await readArtifact(this.config.root, name, false, this.config.codexHome, this.config.runtimeUid, this.config.runtimeIsolated) : { exists: false, bytes: 0, updatedAt: null }])));
    return {
      configured: this.config.memory, effective: this.effective,
      directory: this.config.codexHome ? path.relative(this.config.root, path.join(this.config.codexHome, "memories")) : ".data/codex/memories", artifacts,
      hasSummary: artifacts["memory_summary.md"].bytes > 0,
      generationCapability: this.generationBlocked ? "blocked" : "unverified",
      generationWarning: this.generationBlocked ? "当前禁用原生写工具，后台合并不能写出最终记忆摘要。" : "模型提炼与合并兼容性仍需真实模型验证。",
      generationProgress: "unknown", modelCompatibility: "unverified",
      note: "已开启不等于已生成；原生后台按条件处理，不是每轮即时保存。配置修改需重启；现有 Thread 可能保留之前注入的内容。"
    };
  }

  async summary() {
    if (!this.effective?.enabled) return { exists: false, bytes: 0, updatedAt: null, text: "", note: "原生记忆已关闭。" };
    const result = await readArtifact(this.config.root, "memory_summary.md", true, this.config.codexHome, this.config.runtimeUid, this.config.runtimeIsolated);
    return { ...result, text: this.redact(result.text || ""), note: "这是生成的记忆摘要，不是全部会话历史；不存在摘要不直接代表错误。" };
  }

  async contribute(threadId, enabled) {
    requireId(threadId, "Thread id");
    if (typeof enabled !== "boolean") throw new AppError("enabled 必须为布尔值。");
    if (enabled && !this.effective?.enabled) throw new AppError("记忆总开关尚未开启，请配置 AGENT_MEMORY_ENABLED 并重启服务。", 409);
    if (enabled && this.config.agent && !this.config.memory.contribute) throw new AppError("当前 Agent 策略禁止会话贡献记忆。", 409);
    await this.sessions.ensure(threadId); // 复用项目会话校验，不能操作其他项目的 Thread。
    return this.sessions.atBoundary(async () => {
      if (this.sessions.sessions.get(threadId)?.activeTurnId) throw new AppError("请在当前 turn 结束后修改记忆参与设置。", 409);
      const mode = enabled ? "enabled" : "disabled";
      await this.rpc.request("thread/memoryMode/set", { threadId, mode });
      return { threadId, mode, note: "设置已提交：只控制此 Thread 后续参与提炼的资格；不停止已运行的后台任务，不立即删除过去贡献的记忆，也不控制读取。" };
    }, { allowBusy: true });
  }
}
