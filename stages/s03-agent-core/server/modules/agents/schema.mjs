import Ajv from "ajv";

const text = { type: "string", minLength: 1, maxLength: 500 };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const array = items => ({ type: "array", items, uniqueItems: true });
const choices = values => ({ type: "string", enum: values });
const dictionary = value => ({ type: "object", additionalProperties: value });
const schema = object({
  schemaVersion: { const: "1.0" },
  agent: object({
    id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" }, version: text, instructions: text,
    skills: array(object({ id: text, required: { type: "boolean" } })),
    tools: object({ allow: array({ type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,47}$" }) }),
    dataBindings: array(object({ sourceRef: text, actions: array(choices(["read", "create"])), methods: array(choices(["files"])), required: { type: "boolean" } })),
    executionRef: text,
    memory: object({ use: { type: "boolean" }, contribute: { type: "boolean" } }),
    outputs: object({ directory: text, formats: array(choices(["md", "txt"])), writeMode: { const: "create-only" }, requiredChecks: array(choices(["file-exists", "format"])) })
  }),
  bindings: object({
    workspaceDir: text,
    sources: dictionary(object({ type: { const: "files" }, root: text, revision: text }, ["type", "root"])),
    skills: dictionary(object({ path: text, requires: array(choices(["shell", "fileWrite", "assets"])) }, ["path"])),
    executions: dictionary(object({ sandbox: { const: "read-only" }, approvalPolicy: { const: "never" }, nativeShell: { const: false }, nativeFileWrite: { const: false } }))
  }, ["workspaceDir", "sources", "executions"])
});
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
export function validateDefinition(value) {
  if (!validate(value)) throw new Error(`Agent 定义无效：${validate.errors.map(error => `${error.instancePath || "/"} ${error.message}`).join("；")}`);
  return value;
}
