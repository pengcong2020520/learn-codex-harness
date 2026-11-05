import Ajv from "ajv";
import { CHECKS, GRANT_TYPES } from "../workflows/index.mjs";

const text = { type: "string", minLength: 1, maxLength: 500 };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const array = items => ({ type: "array", items, uniqueItems: true });
const choices = values => ({ type: "string", enum: values });
const dictionary = value => ({ type: "object", additionalProperties: value });
const slug = { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" };
// 参数只允许扁平的字符串字段：足够表达"维护哪个知识库"之类的选择，也便于 CLI 用 key=value 传入。
const workflowParams = object({
  type: { const: "object" }, additionalProperties: { const: false }, required: array(text),
  properties: dictionary(object({ type: { const: "string" }, description: text, pattern: text, enum: array(text), maxLength: { type: "integer", minimum: 1, maximum: 10000 } }, ["type"]))
}, ["type", "additionalProperties", "properties"]);
// 步骤只在权限要变或需要人拍板的地方切：writes 收窄本步可新建文件的位置，confirm 表示本步完成后等用户确认。
const step = object({ id: slug, goal: text, writes: array(text), confirm: { type: "boolean" }, checks: array(choices(CHECKS)) }, ["id", "goal"]);
const workflow = object({
  id: slug, label: text, skill: text, params: workflowParams,
  grants: array(object({ type: choices(GRANT_TYPES), kbId: { anyOf: [slug, object({ param: text })] } })),
  checks: array(choices(CHECKS)),
  steps: { type: "array", items: step, minItems: 2, maxItems: 5 }
}, ["id"]);
const schema = object({
  schemaVersion: { enum: ["1.0", "1.1", "1.2"] },
  agent: object({
    id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" }, version: text, instructions: text,
    skills: array(object({ id: text, required: { type: "boolean" } })),
    tools: object({ allow: array({ type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,47}$" }) }),
    dataBindings: array(object({ sourceRef: text, actions: array(choices(["read", "create"])), methods: array(choices(["files"])), required: { type: "boolean" } })),
    knowledge: array(object({ kbId: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" }, mode: choices(["wiki", "rag"]), actions: array(choices(["read", "update", "index"])) })),
    executionRef: text,
    memory: object({ use: { type: "boolean" }, contribute: { type: "boolean" } }),
    outputs: object({ directory: text, formats: array(choices(["md", "txt"])), writeMode: { const: "create-only" }, requiredChecks: array(choices(["file-exists", "format"])) }),
    workflows: { type: "array", items: workflow, maxItems: 20 }
  }, ["id", "version", "instructions", "skills", "tools", "dataBindings", "executionRef", "memory", "outputs"]),
  bindings: object({
    workspaceDir: text,
    knowledgeBases: dictionary(object({ sourceRoot: text, wikiRoot: text })),
    sources: dictionary(object({ type: { const: "files" }, root: text, revision: text, readOnly: { type: "boolean" } }, ["type", "root"])),
    skills: dictionary(object({ path: text, requires: array(choices(["shell", "fileWrite", "assets"])) }, ["path"])),
    executions: dictionary(object({ sandbox: { const: "read-only" }, approvalPolicy: { const: "never" }, nativeShell: { const: false }, nativeFileWrite: { const: false } }))
  }, ["workspaceDir", "sources", "executions"])
});
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
export function validateDefinition(value) {
  if (!validate(value)) throw new Error(`Agent 定义无效：${validate.errors.map(error => `${error.instancePath || "/"} ${error.message}`).join("；")}`);
  return value;
}
