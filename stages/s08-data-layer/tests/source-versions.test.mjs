import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Resources } from "../server/modules/data/resources.mjs";
import { createFileTools } from "../server/modules/data/files.mjs";
import { createToolService } from "../server/modules/tools/loader.mjs";
import { installToolFixture, tempRoot } from "./helpers.mjs";

// 使用真实文件与权限实现；只替换数据库边界，真实 SQL 另由 test:data 覆盖。
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-versions-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const area of ["inputs", "outputs"]) fs.mkdirSync(path.join(root, "workspace", area), { recursive: true });
  const sources = [{ id: "inputs", locator: "inputs", actions: ["read"] }];
  const outputs = { directory: "outputs", formats: ["md", "txt"] };
  const files = createFileTools(root, { sources, outputs });
  const scope = { instanceId: randomUUID(), ownerId: randomUUID() };
  const resources = new Resources(null, scope, { files, sources, outputs, blobDir: path.join(root, "blobs") });
  const rows = [], versions = new Map(), dependencies = [];
  function source(locator = "inputs/report.md") {
    fs.writeFileSync(path.join(files.workspace, locator), "来源");
    const row = { id: randomUUID(), locator, owner_id: scope.ownerId, state: "ready", current_version: randomUUID() };
    rows.push(row); versions.set(row.current_version, row.id);
    return row;
  }
  resources.locked = operation => operation(null);
  resources.finish = async () => {};
  resources.query = async (sql, values = []) => {
    let result = [];
    if (sql.startsWith("WITH RECURSIVE upstream")) return { rows: [] };
    if (sql.startsWith("SELECT * FROM agent_data.resources")) {
      result = rows.filter(row => sql.includes("locator=$3") ? row.locator === values[0] : row.id === values[0]);
    } else if (sql.startsWith("SELECT resource_id")) {
      assert.match(sql, /instance_id=\$1.*id=\$3 AND resource_id=\$4/);
      if (versions.get(values[0]) === values[1]) result = [{ resource_id: values[1] }];
    } else if (sql.includes("INSERT INTO agent_data.resources")) {
      const row = { id: values[0], locator: values[2], owner_id: scope.ownerId, state: "pending" };
      rows.push(row); result = [row];
    } else if (sql.includes("INSERT INTO agent_data.resource_versions")) versions.set(values[0], values[1]);
    else if (sql.includes("UPDATE agent_data.resources SET current_version")) rows.find(row => row.id === values[0]).current_version = values[1];
    else if (sql.includes("INSERT INTO agent_data.dependencies")) dependencies.push(values);
    else throw new Error(`未模拟的 SQL：${sql}`);
    return { rows: result.map(row => ({ ...row })) };
  };
  const first = source();
  return { resources, files, source, first, versions, dependencies };
}
const ids = row => ({ resourceId: row.id, versionId: row.current_version });

test("来源路径与 ID 可混用，按当前版本保存依赖且重复来源只登记一次", async t => {
  const r = setup(t), second = r.source("inputs/second.md");
  const result = await r.resources.write_file({ path: "outputs/result.md", content: "派生内容", source_versions: [
    { path: r.first.locator }, ids(second), ids(r.first),
  ] });
  assert.equal(result.created, true);
  assert.deepEqual(r.dependencies.map(values => values.slice(1)), [[r.first.id, r.first.current_version], [second.id, second.current_version]]);
  assert.equal(fs.readFileSync(path.join(r.files.workspace, result.path), "utf8"), "派生内容");
});

test("每个来源错误都带序号，区分路径、权限、资源号码、版本归属与过期", async t => {
  const r = setup(t), foreign = r.source("inputs/foreign.md"), stale = r.source("inputs/stale.md"), revoked = r.source("inputs/revoked.md");
  foreign.owner_id = randomUUID(); revoked.state = "revoked";
  const old = randomUUID(); r.versions.set(old, stale.id);
  fs.writeFileSync(path.join(r.files.workspace, "inputs/unregistered.md"), "尚未登记");
  const cases = [
    [{ path: "inputs/missing.md" }, /路径不存在/],
    [{ path: "inputs/unregistered.md" }, /路径尚未登记/],
    [{ path: "outputs/private.md" }, /没有读权限/],
    [{ path: foreign.locator }, /没有读权限/], [ids(foreign), /没有读权限/],
    [{ resourceId: randomUUID(), versionId: randomUUID() }, /resourceId 不存在.*号码抄错/],
    [{ resourceId: "wrong", versionId: randomUUID() }, /resourceId 格式.*号码抄错/],
    [{ resourceId: r.first.id, versionId: "wrong" }, /versionId 格式.*号码抄错/],
    [{ resourceId: r.first.id, versionId: randomUUID() }, /versionId 不属于.*号码抄错/],
    [{ resourceId: r.first.id, versionId: stale.current_version }, /versionId 不属于.*号码抄错/],
    [{ resourceId: stale.id, versionId: old }, /版本已过期.*资料已有更新，请重新读取/],
    [{ path: revoked.locator }, /revoked/], [ids(revoked), /revoked/],
    [null, /请填写/], [[], /请填写/], [{}, /path 必须/], [{ path: 1 }, /path 必须/],
  ];
  for (const [reference, reason] of cases) {
    await assert.rejects(r.resources.write_file({ path: "outputs/fail.md", content: "不能写入", source_versions: [ids(r.first), reference] }), error => {
      assert.match(error.message, /source_versions 第 2 项：/);
      assert.match(error.message, reason);
      assert.ok(!error.message.includes(r.files.workspace));
      return true;
    });
    assert.equal(fs.existsSync(path.join(r.files.workspace, "outputs/fail.md")), false);
    assert.equal(r.dependencies.length, 0);
  }
  r.resources.sources.length = 0;
  await assert.rejects(r.resources.sourceVersion(ids(r.first), 0), /第 1 项：没有读权限/);
});

test("目录别名查询使用规范路径过滤已撤销和其他 owner 的资源", async t => {
  const r = setup(t), foreign = r.source("inputs/foreign.md");
  foreign.owner_id = randomUUID(); r.first.state = "revoked";
  r.source("inputs/visible.md");
  for (const value of ["inputs", "inputs/", "./inputs", "./inputs/"])
    assert.deepEqual((await r.resources.list_files({ path: value })).entries.map(entry => entry.name), ["visible.md"]);
});

test("工具 schema 接受两种引用混用，非法项在工具回包中保留序号", async t => {
  const service = await createToolService(installToolFixture(tempRoot(t)));
  const valid = { path: "outputs/test.md", content: "正文", source_versions: [{ path: "inputs/report.md" }, { resourceId: randomUUID(), versionId: randomUUID() }] };
  assert.doesNotThrow(() => service.validate("write_file", valid));
  for (const reference of [null, {}, { path: 1 }, { resourceId: "wrong", versionId: randomUUID() }, { path: "inputs/report.md", resourceId: randomUUID(), versionId: randomUUID() }]) {
    const response = await service.call({ tool: "write_file", arguments: { ...valid, source_versions: [valid.source_versions[0], reference] } });
    assert.equal(response.success, false);
    assert.match(JSON.parse(response.contentItems[0].text).error, /source_versions 第 2 项/);
  }
});
