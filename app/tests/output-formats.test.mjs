import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileTools } from '../server/modules/data/files.mjs';

const contents = { json: '{"标题":"测试"}', js: 'export const title = "测试";', css: 'body { color: red; }' };
function fixture(t, formats = ['json', 'js', 'css']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-formats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = ['inputs', 'outputs', 'outputs-other', 'research'].map(locator => ({ id: locator, locator, actions: ['read', 'create'] }));
  for (const source of sources) fs.mkdirSync(path.join(root, 'workspace', source.locator), { recursive: true });
  const outputs = { directory: 'outputs/design', formats };
  const files = createFileTools(root, { sources, outputs });
  return { root, sources, outputs, files };
}

for (const [format, content] of Object.entries(contents)) {
  test(`${format} 产物：声明后可新建并读回，禁止覆盖，文本上限为 256 KiB`, t => {
    const { files } = fixture(t);
    const relative = `outputs/design/package-v1/file.${format}`;
    const saved = files.write_file({ path: relative, content });
    assert.equal(saved.artifact.format, format);
    assert.equal(saved.bytes, Buffer.byteLength(content));
    const read = files.read_file({ path: relative });
    assert.equal(read.content, content); assert.equal(read.sourceId, 'outputs');
    assert.equal(read.revision, saved.artifact.revision);
    assert.equal(files.check(relative, 'read'), path.join(files.workspace, relative));
    assert.throws(() => files.write_file({ path: relative, content }), error => error.status === 409 && /未覆盖/.test(error.message));
    assert.equal(files.read_file({ path: relative }).content, content);
    const limit = format === 'json' ? '"' + 'x'.repeat(256 * 1024 - 2) + '"' : 'x'.repeat(256 * 1024);
    const boundary = `outputs/design/limit.${format}`;
    files.write_file({ path: boundary, content: limit });
    assert.equal(files.read_file({ path: boundary, max_chars: limit.length }).content, limit);
    assert.throws(() => files.write_file({ path: `outputs/design/large.${format}`, content: limit + ' ' }), /256 KiB/);
    assert.throws(() => files.write_file({ path: `outputs/design/multibyte.${format}`, content: '字'.repeat(90000) }), /256 KiB/);
    fs.writeFileSync(path.join(files.workspace, boundary), limit + ' ');
    assert.throws(() => files.read_file({ path: boundary }), /256 KiB/);
  });

  test(`${format} 产物：声明与读取授权各自生效，其他目录仍拒绝`, t => {
    const { root, sources, outputs, files } = fixture(t);
    const relative = `outputs/design/file.${format}`;
    files.write_file({ path: relative, content });
    const undeclared = createFileTools(root, { sources, outputs: { ...outputs, formats: ['md'] } });
    assert.throws(() => undeclared.write_file({ path: relative, content }), /格式不在允许列表/);
    assert.throws(() => undeclared.read_file({ path: relative }), /格式|只支持/);
    const noOutputs = createFileTools(root, { sources });
    assert.throws(() => noOutputs.write_file({ path: relative, content }), /格式|只支持/);
    assert.throws(() => noOutputs.read_file({ path: relative }), /格式|只支持/);
    const writeOnly = createFileTools(root, { sources: sources.filter(source => source.id !== 'outputs'), outputs });
    writeOnly.write_file({ path: `outputs/design/write-only.${format}`, content });
    assert.throws(() => writeOnly.read_file({ path: relative }), /写入权限不自动包含读取权限/);
    for (const directory of ['inputs', 'inputs/uploads', 'research', 'outputs', 'outputs/design-other', 'outputs-other']) {
      const outside = `${directory}/file.${format}`;
      assert.throws(() => files.write_file({ path: outside, content }), /格式|只支持/);
      fs.mkdirSync(path.join(files.workspace, directory), { recursive: true });
      fs.writeFileSync(path.join(files.workspace, outside), content);
      assert.throws(() => files.read_file({ path: outside }), /格式|只支持/);
      assert.throws(() => files.check(outside, 'read'), /格式|只支持/);
    }
    assert.throws(() => files.read_preview({ path: relative }), /只支持/);
    assert.throws(() => files.write_upload({ path: `inputs/uploads/file.${format}`, content: Buffer.from(content) }));
    assert.throws(() => files.write_file({ path: `inputs/drafts/file.${format}`, content }), /未授权/);
  });
}

test('JSON 产物：非法正文返回 400 且不落盘，不依赖 requiredChecks', t => {
  const { files } = fixture(t);
  for (const [index, content] of ['', '{', '{"a":1,}', 'undefined', '{}{}'].entries()) {
    const relative = `outputs/design/invalid-${index}.json`;
    assert.throws(() => files.write_file({ path: relative, content }), error => error.status === 400 && error.message === '产物 JSON 格式不正确。');
    assert.equal(fs.existsSync(path.join(files.workspace, relative)), false);
  }
  for (const [index, content] of ['null', '[]', '1', 'true', '"字符串"'].entries()) {
    const relative = `outputs/design/value-${index}.JSON`;
    files.write_file({ path: relative, content });
    assert.equal(files.read_file({ path: relative }).content, content);
  }
});
