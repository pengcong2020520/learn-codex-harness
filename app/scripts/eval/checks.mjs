// 角色评估的硬性检查：只看产出文件与最终回复，不调用模型。检查项写在各场景的 scenario.json 里。

// 交付物：指定目录下最后写入的 .md / .txt 文件（模型常先写一版、再另存精简后的 _v2 作为定稿）；
// 不知道写入顺序时取正文最长的那份（模型偶尔会顺手存一份笔记）。
export function mainDocument(files, dir, written = []) {
  const candidates = files.filter(file => file.path.startsWith(`${dir}/`) && /\.(md|txt)$/i.test(file.path));
  const last = written.filter(item => candidates.some(file => file.path === item)).at(-1);
  return candidates.find(file => file.path === last) || candidates.sort((a, b) => b.content.length - a.content.length)[0] || null;
}

// 运行记录里按顺序写入过的文件路径。
export const writtenPaths = run => (run.tools || []).filter(tool => tool.tool === "write_file" && tool.args?.path).map(tool => tool.args.path);

// 字数：去掉空白与 Markdown 标记后的字符数，中英文混排时与“多少字”的直觉接近。
export function textLength(text) {
  return text.replace(/[\s#*_>`|\-=]/g, "").length;
}

export function headingCount(text) {
  return (text.match(/^#{1,6}\s+\S/gm) || []).length;
}

const regex = pattern => new RegExp(pattern, "i");
// 链接只取 ASCII 合法字符（不含括号），再去掉句末标点：中文正文里链接后面常直接跟着文字或全角标点。
const urls = text => [...new Set((text.match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%]+/g) || []).map(url => url.replace(/[.,;:!?\]]+$/, "")))];

export function runChecks(scenario, { files, reply = "", inputsText = "", written = [] }) {
  const deliverableDir = scenario.checks.find(check => check.type === "deliverable")?.dir || "outputs";
  const doc = mainDocument(files, deliverableDir, written);
  const body = doc?.content || "";
  return scenario.checks.map(check => {
    const text = check.where === "doc+reply" ? `${body}\n${reply}` : body;
    let pass = false, detail = "";
    switch (check.type) {
      case "deliverable": pass = Boolean(doc); detail = doc ? doc.path : "没有找到交付物"; break;
      case "length": { const n = textLength(body); pass = Boolean(doc) && n >= check.min && n <= check.max; detail = `${n} 字`; break; }
      case "headings": { const n = headingCount(body); pass = n >= check.min; detail = `${n} 个标题`; break; }
      case "includes": pass = check.any.some(p => regex(p).test(text)); break;
      case "includes-all": { const missing = check.all.filter(p => !regex(p).test(text)); pass = !missing.length; detail = missing.length ? `缺少：${missing.join("、")}` : ""; break; }
      case "excludes": { const hit = check.patterns.filter(p => regex(p).test(text)); pass = Boolean(doc) && !hit.length; detail = hit.length ? `出现：${hit.join("、")}` : ""; break; }
      case "ending-question": pass = /[？?]/.test(body.trim().slice(-check.within)); break;
      case "opening-includes": pass = check.any.some(p => regex(p).test(body.slice(0, check.within))); break;
      case "urls-from-inputs": {
        const unknown = urls(body).filter(url => !inputsText.includes(url));
        pass = Boolean(doc) && !unknown.length; detail = unknown.length ? `资料以外的链接：${unknown.join("、")}` : ""; break;
      }
      default: throw new Error(`未知的检查类型：${check.type}`);
    }
    return { id: check.id, label: check.label, pass, ...(detail ? { detail } : {}) };
  });
}

export function stats(values) {
  const list = values.filter(Number.isFinite);
  if (!list.length) return null;
  const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
  return { mean: Math.round(mean), min: Math.min(...list), max: Math.max(...list), n: list.length };
}
