// 模型路由：按用途、场景和需要的能力，从模型清单里挑一个服务商已启用的模型。
// 网关只管“选定的模型出错时改用谁”；“这一步该用哪个模型”由这里决定（网关看不到任务语义）。
import { AppError } from "../../../shared/errors.mjs";
import { PURPOSES, enabledProviders, splitModelId } from "./index.mjs";

const LABELS = { chat: "对话", embedding: "向量", rerank: "重排序", image: "生图", video: "生视频", tts: "语音合成", asr: "语音识别" };

export function createModelRouter(registry, environment = {}) {
  const enabled = enabledProviders(registry, environment);
  const override = environment.CODEX_MODEL?.trim() || null;

  // needs：image 需要能看图；contextTokens 需要的上下文长度。
  const unmet = (id, purpose, needs) => {
    const spec = registry.models[id];
    if (!spec?.purposes.includes(purpose)) return `不能做${LABELS[purpose]}`;
    const provider = registry.providers[splitModelId(id).provider];
    if (!enabled.has(splitModelId(id).provider)) return `服务商未启用（.env 里缺 ${[provider.keyEnv, provider.baseUrlEnv].filter(Boolean).join("、")}）`;
    if (needs.image && !(spec.inputModalities || ["text"]).includes("image")) return "不能看图";
    if (needs.contextTokens && (spec.contextWindow || 0) < needs.contextTokens) return `上下文只有 ${spec.contextWindow || 0}`;
    return null;
  };

  const pick = (candidates, purpose, needs, source) => {
    const reasons = [];
    for (const id of candidates) {
      const reason = unmet(id, purpose, needs);
      if (!reason) return { id, ...splitModelId(id), purpose, spec: registry.models[id], source };
      reasons.push(`${id}：${reason}`);
    }
    throw new AppError(`没有可用的${LABELS[purpose]}模型（${source}）。${reasons.length ? `候选：${reasons.join("；")}` : "没有登记候选。"}`, 503, "MODEL_UNAVAILABLE");
  };

  // model：具体模型（含 “/”）或场景名；都不写就用这个用途的默认模型。
  function resolve({ purpose = "chat", model = null, needs = {} } = {}) {
    if (!PURPOSES.includes(purpose)) throw new AppError(`未知的模型用途：${purpose}`, 400);
    if (model?.includes("/")) {
      if (!registry.models[model]) throw new AppError(`模型 ${model} 不在 config/models.json 里。`, 400, "MODEL_UNKNOWN");
      return pick([model], purpose, needs, `指定模型 ${model}`);
    }
    if (model) {
      if (purpose !== "chat" || !registry.scenes?.[model]) throw new AppError(`没有名为 ${model} 的场景（config/models.json 的 scenes）。`, 400, "MODEL_UNKNOWN");
      return pick(registry.scenes[model], purpose, needs, `场景 ${model}`);
    }
    // 对话的默认模型可以用 .env 的 CODEX_MODEL 覆盖（本机测试和服务器可以各用各的）。
    if (purpose === "chat" && override) return pick([override], purpose, needs, "CODEX_MODEL");
    return pick(registry.routes?.[purpose] || [], purpose, needs, `routes.${purpose}`);
  }

  return {
    resolve,
    // 可用的对话模型（默认的排第一）：写进 Codex 的模型目录，按轮切换模型时 Codex 才有正确的能力信息。
    chatModels() {
      const first = resolve().id;
      return [first, ...Object.keys(registry.models).filter(id => id !== first && !unmet(id, "chat", {}))];
    },
  };
}
