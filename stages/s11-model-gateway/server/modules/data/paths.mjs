import path from "node:path";
export const covers = (root, value) =>
  value === root || value.startsWith(root + "/");
export function resourcePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 500 ||
    /[\\\x00-\x1f\x7f:]/.test(value) ||
    path.isAbsolute(value) ||
    value.split("/").length > 12 ||
    value.split("/").some((part) => !part || part.startsWith("."))
  )
    throw new Error(
      "资料/产物必须使用工作区内的相对路径，不能包含上级、隐藏目录或控制字符。",
    );
  return value;
}
export function validateKnowledgeBindings(bindings = {}) {
  const roots = [];
  for (const [id, binding] of Object.entries(bindings)) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw new Error("知识库 ID 无效。");
    for (const field of ["sourceRoot", "wikiRoot"]) {
      const root = resourcePath(binding[field]);
      if (roots.some((other) => covers(root, other) || covers(other, root)))
        throw new Error("知识库原文与 Wiki 路径不能相互重叠。");
      roots.push(root);
    }
  }
  return bindings;
}
