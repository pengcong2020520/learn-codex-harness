import { createHash } from "node:crypto";
// Bump only when the corresponding execution/authorization semantics become incompatible.
// Implementation hashes belong to release diagnostics, never to session compatibility.
export const CONTRACTS = Object.freeze({
  agent: 2,
  tools: 1,
  resources: 1,
  knowledge: 1,
  permissions: 1,
  codex: "app-server-v2-restricted-1",
});
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(canonical(value)),
    )
    .digest("hex");

// Schema annotations describe the UI/prompt; they do not change validation permissions.
// Preserve property names and literal values, even if they are named "description".
export function schemaContract(schema) {
  if (Array.isArray(schema)) return schema.map(schemaContract);
  if (!schema || typeof schema !== "object") return schema;
  const annotations = new Set(["description", "title", "$comment", "examples"]);
  const maps = new Set([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
  ]);
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !annotations.has(key))
      .map(([key, value]) => [
        key,
        ["enum", "const", "default"].includes(key)
          ? value
          : maps.has(key)
            ? Object.fromEntries(
                Object.entries(value).map(([name, child]) => [
                  name,
                  schemaContract(child),
                ]),
              )
            : schemaContract(value),
      ]),
  );
}
export function toolContract(groups, allowed) {
  return digest(
    groups
      .map((group) => ({
        contractVersion: group.contractVersion || 1,
        tools: group.tools
          .filter((tool) => !allowed || allowed.includes(tool.name))
          .map(({ name, inputSchema, readOnly }) => ({
            name,
            inputSchema: schemaContract(inputSchema),
            readOnly,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .filter((group) => group.tools.length)
      .sort((a, b) => a.tools[0].name.localeCompare(b.tools[0].name)),
  );
}
