// 选读的 Python 示例：只检查语法与依赖版本，不安装 SDK、不调用模型；没有 python3 时跳过。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const example = new URL("../examples/python/app_server_hello.py", import.meta.url);
const requirements = new URL("../examples/python/requirements.txt", import.meta.url);
const python = spawnSync("python3", ["--version"]).status === 0;

test("Python 选读示例语法正确，依赖固定在实测过的版本", { skip: !python && "没有 python3" }, () => {
  // 用 ast.parse 只做语法检查，不像 py_compile 那样写出 __pycache__。
  const result = spawnSync("python3", ["-c", "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", example.pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(requirements, "utf8"), /^openai-codex==\d+\.\d+\.\d+$/m);
  // 示例要表明它驱动的是 App Server：流式事件按 JSON-RPC 通知名判断。
  assert.match(fs.readFileSync(example, "utf8"), /item\/agentMessage\/delta/);
});
