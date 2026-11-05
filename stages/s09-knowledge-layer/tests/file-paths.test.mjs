import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileTools } from "../server/modules/data/files.mjs";

export function fileFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-paths-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const area of ["inputs", "outputs"]) fs.mkdirSync(path.join(root, "workspace", area), { recursive: true });
  fs.writeFileSync(path.join(root, "workspace/inputs/report.md"), "原始资料");
  const sources = [{ id: "inputs", locator: "inputs", actions: ["read"] }];
  const outputs = { directory: "outputs", formats: ["md", "txt"] };
  const files = createFileTools(root, { sources, outputs });
  return { root, sources, outputs, files };
}

test("目录允许末尾 / 和开头 ./，返回规范路径且不改变可见范围", t => {
  const { files } = fileFixture(t);
  const expected = files.list_files({ path: "inputs" });
  for (const value of ["inputs/", "./inputs", "./inputs/", "././inputs//"])
    assert.deepEqual(files.list_files({ path: value }), expected);
  assert.deepEqual(files.list_files({ path: "./" }), files.list_files({}));
  for (const value of ["outputs/", "./outputs"])
    assert.throws(() => files.list_files({ path: value }), /outputs 不在可浏览的范围内.*可浏览的有：inputs/);
});

test("危险目录写法逐项说明原因，规范化不折叠越界、隐藏或内部空段", t => {
  const { files } = fileFixture(t);
  for (const [value, reason] of [
    ["../x", /上级目录 \.\./], ["./inputs/../x/", /上级目录 \.\./],
    [".hidden", /隐藏目录/], ["./inputs/.hidden/", /隐藏目录/],
    ["/inputs", /绝对路径/], ["C:/inputs", /绝对路径/],
    ["inputs\\x", /反斜杠/], ["inputs//x/", /空路径段/],
    ["inputs/./x", /点路径段/], ["inputs/\0", /控制字符/],
    ["inputs/a:b", /冒号/], [1, /字符串/], ["x".repeat(501), /500/],
    [Array(14).fill("x").join("/"), /12 层/],
  ]) assert.throws(() => files.list_files({ path: value }), reason, String(value));
  fs.symlinkSync(path.join(files.workspace, "outputs"), path.join(files.workspace, "inputs/link"));
  assert.throws(() => files.list_files({ path: "./inputs/link/" }), /符号链接/);
});
