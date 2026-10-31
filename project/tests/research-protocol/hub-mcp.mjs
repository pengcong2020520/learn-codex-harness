// 测试用 MCP 服务：每次 tools/list 都从文件读当前工具表，模拟 tool hub 热插拔。
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const file = process.argv[2];
const server = new Server({ name: "hub", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: JSON.parse(fs.readFileSync(file, "utf8")).map(name => ({
  name, description: "hub tool " + name, inputSchema: { type: "object", properties: {} } })) }));
server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
  const now = JSON.parse(fs.readFileSync(file, "utf8"));
  return now.includes(params.name) ? { content: [{ type: "text", text: "ran " + params.name }] }
    : { isError: true, content: [{ type: "text", text: "tool removed: " + params.name }] };
});
await server.connect(new StdioServerTransport());
