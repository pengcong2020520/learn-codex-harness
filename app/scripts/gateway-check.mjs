// 统一用 Responses 协议探测网关链路，不直连服务商，也不输出响应正文或密钥。
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadEnvironment } from "../server/modules/config/index.mjs";
import { enabledProviders, gatewayEndpoint, loadModelRegistry, splitModelId } from "../server/modules/gateway/index.mjs";
import { PROJECT_ROOT } from "../shared/paths.mjs";

// 固定 8×8 纯红色 PNG，不依赖外部图片地址。
export const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

async function probe(endpoint, model, search, timeoutMs, image = false, fetcher = fetch) {
  let usage;
  try {
    const response = await fetcher(`${endpoint.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      // 输入写成与 Codex 完全相同的消息格式：网关会把纯字符串改写成简写的 { role, content }，
      // Kimi 收到简写格式时不会触发联网搜索，测出来的就不是 Codex 运行时的真实情况。
      body: JSON.stringify({ model, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: search
        ? `请联网查找今天（${new Date().toISOString().slice(0, 10)}）最新一条国际新闻，简短给出标题和来源链接。`
        : image ? "这张图片是什么颜色" : "只回复 OK" }, ...(image ? [{ type: "input_image", image_url: TEST_IMAGE }] : [])] }], ...(search ? { tools: [{ type: "web_search", external_web_access: true }] } : {}) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const result = await response.json();
    usage = result.usage;
    if (result.error || result.status === "failed") return { ok: false, reason: "上游返回失败状态", usage };
    const output = Array.isArray(result.output) ? result.output : [];
    const ok = image
      ? output.some(item => item.type === "message" && item.content?.some(part => part.type === "output_text" && part.text?.includes("红")))
      : search
      ? output.some(item => item.type === "web_search_call")
      : output.some(item => item.type === "message" && item.content?.some(part => part.type === "output_text" && part.text?.trim()));
    return { ok, reason: ok ? null : image ? "回答中没有红色的红字" : search ? "没有 web_search_call" : "没有文本输出", usage };
  } catch (error) {
    // 不回显上游错误、响应或 fetch 的异常文本，避免服务商把密钥带进终端。
    return { ok: false, reason: error.name === "TimeoutError" ? "请求超时" : "网关连接失败或响应格式错误", usage };
  }
}

export async function checkGateway({ environment, registry, model, search = false, image = false, fetcher = fetch, timeoutMs = 60000 }) {
  if (image && !model) throw new Error("--image 必须同时指定 --model；看图实测会产生费用，请取得负责人允许后运行。");
  const endpoint = gatewayEndpoint(environment);
  if (!endpoint) throw new Error("没有启用模型网关：请先配置服务商密钥，运行 npm run setup，再运行 npm run gateway:check。");
  if (!registry) throw new Error("缺少 config/models.json 模型清单。");
  const enabled = enabledProviders(registry, environment);
  const ids = Object.keys(registry.models).filter(id => registry.models[id].purposes.includes("chat") && enabled.has(splitModelId(id).provider));
  if (model && !ids.includes(model)) throw new Error(`模型 ${model} 必须是清单中服务商已启用的对话模型。`);
  if (!ids.length) throw new Error("没有已启用服务商的对话模型：请配置服务商密钥，再运行 npm run up。");
  const rows = [], messages = [];
  for (const id of model ? [model] : ids) {
    const start = performance.now();
    const chat = await probe(endpoint, id, false, timeoutMs, false, fetcher);
    const web = search ? await probe(endpoint, id, true, timeoutMs, false, fetcher) : null;
    const vision = image ? await probe(endpoint, id, false, timeoutMs, true, fetcher) : null;
    const declared = registry.models[id].nativeTools?.includes("web_search") || false;
    const usages = [chat.usage, web?.usage, vision?.usage].filter(Boolean);
    rows.push({ model: id, fallbacks: (registry.models[id].fallbacks || []).filter(target => enabled.has(splitModelId(target).provider)), chat: chat.ok, image: vision?.ok ?? null, search: web?.ok ?? null, declared, elapsedMs: Math.round(performance.now() - start),
      inputTokens: usages.length ? usages.reduce((sum, usage) => sum + (usage.input_tokens || 0), 0) : null,
      outputTokens: usages.length ? usages.reduce((sum, usage) => sum + (usage.output_tokens || 0), 0) : null });
    if (vision && !vision.ok) messages.push(`${id}：看图失败（${vision.reason}）。`);
    if (vision?.ok) messages.push(`${id}：看图实测通过，可在 config/models.json 标注 inputs: ["text","image"]。`);
    if (!chat.ok) messages.push(`${id}：对话失败（${chat.reason}）。`);
    if (web && !web.ok) messages.push(`${id}：联网搜索失败（${web.reason}）。`);
    if (declared && web && !web.ok) messages.push(`${id}：清单已声明 web_search，但实测失败，请检查网关链路或修正 nativeTools。`);
    if (!declared && web?.ok) messages.push(`${id}：实测支持 web_search，但清单未声明；核实后可添加 nativeTools: ["web_search"]。`);
  }
  return { rows, messages, exitCode: rows.some(row => !row.chat || row.image === false || (row.declared && row.search === false)) ? 1 : 0 };
}

export async function main(args = process.argv.slice(2), { environment, registry, log = console.log, timeoutMs, fetcher } = {}) {
  try {
    let model, search = false, image = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--image") image = true;
      else if (args[index] === "--search") search = true;
      else if (args[index] === "--model" && args[index + 1] && !args[index + 1].startsWith("--")) model = args[++index];
      else throw new Error("用法：npm run gateway:check -- [--model 服务商/模型名] [--search] [--image]（看图实测会产生费用）");
    }
    const report = await checkGateway({ environment: environment ?? loadEnvironment(PROJECT_ROOT),
      registry: registry ?? loadModelRegistry(PROJECT_ROOT), model, search, image, timeoutMs, fetcher });
    log("| 模型 | 备用链 | 对话 | 联网搜索 | 清单声明 | 耗时 | 用量（输入 / 输出 token） |\n|---|---|---|---|---|---|---|");
    for (const row of report.rows) log(`| ${row.model} | ${row.fallbacks.join(" → ") || "无"} | ${row.chat ? "✓" : "✗"} | ${row.search === null ? "未测" : row.search ? "✓" : "✗"} | ${row.declared ? "web_search" : "无"} | ${row.elapsedMs} ms | ${row.inputTokens ?? "未知"} / ${row.outputTokens ?? "未知"} |`);
    if (image) for (const row of report.rows) log(`看图：${row.model} ${row.image ? "✓" : "✗"}（本次实测会产生费用）`);
    for (const message of report.messages) log(`提示：${message}`);
    log("用量为本次对话、搜索与看图请求返回的 usage 合计；失败且未返回 usage 的请求不计入。连接失败时请检查网关并运行 npm run up。");
    return report.exitCode;
  } catch (error) {
    log(error.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
