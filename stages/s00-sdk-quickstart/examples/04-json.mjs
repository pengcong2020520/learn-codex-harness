import { newRun, createCodex, threadOptions, withTimeout, reportError } from "../lib/common.mjs";

try {
  const workspace = await newRun("json");
  const thread = createCodex().startThread(threadOptions(workspace));
  const outputSchema = {
    type: "object",
    properties: {
      topic: { type: "string" },
      summary: { type: "string" },
      next_steps: { type: "array", items: { type: "string" } },
    },
    required: ["topic", "summary", "next_steps"],
    additionalProperties: false,
  };
  const result = await withTimeout((signal) => thread.run(
    "给代码新手一份学习 JavaScript 加法函数的建议，包含主题、简短概述、两条后续步骤。使用中文，不要调用工具。",
    { outputSchema, signal },
  ));
  // finalResponse 仍然是字符串，需要 JSON.parse 才能按字段读取。
  const data = JSON.parse(result.finalResponse);
  if (typeof data.topic !== "string" || typeof data.summary !== "string" ||
      !Array.isArray(data.next_steps) || data.next_steps.some((step) => typeof step !== "string")) {
    throw new Error("返回字段不符合本示例约定。");
  }
  console.log(JSON.stringify(data, null, 2));
  console.log("单独读取 summary 字段：", data.summary);
} catch (error) {
  reportError(error);
}
