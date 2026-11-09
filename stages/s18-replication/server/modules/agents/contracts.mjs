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

// Knowledge reads use Wiki unless an effective RAG mode is present. Registration
// on another shard can turn an absent entry into explicit 'wiki' after startup;
// that is inventory timing, not a policy change. Retain every non-default mode.
export const knowledgeModeContract = (modes = {}) =>
  Object.fromEntries(Object.entries(modes).filter(([, mode]) => mode !== 'wiki'));

// Allowlist semantic launch settings. Never hash args/env: those contain gateway
// addresses, credentials and generated model_catalog_json paths under .runs/.
export function modelContract(launch) {
  return {
    model: launch.model || null, authMode: launch.authMode || null,
    gateway: Boolean(launch.gateway), webSearch: launch.webSearch || 'disabled',
    routing: launch.router?.contract() || null,
    catalog: launch.catalog ? { models: launch.catalog.models.map(({ display_name, description, model_messages, ...model }) => model) } : null,
  };
}

// Pre-fix v2 descriptors recorded no model routing policy. Compare all policy
// evidence they DID record; never turn an arbitrary old hash into an alias.
// This bridge is intentionally limited to installed packaged Skills whose id
// can be recovered from the old path. Unrecognised/legacy Skill paths fail closed.
export function compatibleRecordedV2(previous, current) {
  if (!previous || previous.schemaVersion !== '2.0' || Object.hasOwn(previous, 'modelPolicy')) return false;
  const { hash, ...payload } = previous;
  if (digest(payload) !== hash || typeof payload.workspaceDir !== 'string' || !Array.isArray(payload.skills)) return false;
  const skills = [];
  for (const skill of payload.skills) {
    const id = skill.path?.match(/(?:^|\/)skills\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/)?.[1];
    if (!id) return false;
    const { path, ...policy } = skill;
    skills.push({ ...policy, id });
  }
  const { hash: _hash, modelPolicy: _newPolicy, ...target } = current;
  return digest({ ...payload, workspaceDir: 'workspace',
    skills: skills.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    knowledgeModes: knowledgeModeContract(payload.knowledgeModes),
  }) === digest(target);
}

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
