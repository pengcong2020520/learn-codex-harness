import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rig, until, tempRoot } from './helpers.mjs';
import { createFileTools } from '../server/modules/data/files.mjs';
import { defineWorkflows } from '../server/modules/workflows/index.mjs';
import { MessageService } from '../server/modules/messages/index.mjs';
import { TestJobs } from './jobs-fixture.mjs';
import { TEST_IMAGE } from '../scripts/gateway-check.mjs';
import { validateRegistry, loadModelRegistry } from '../server/modules/gateway/index.mjs';
import { createModelRouter } from '../server/modules/gateway/router.mjs';
import { CodexConnection } from '../server/modules/codex/connection.mjs';
import { createLogRedactor } from '../server/modules/config/index.mjs';

const imagePath = 'inputs/uploads/参考.png', textPath = 'inputs/uploads/需求.md';
async function setup(t, vision = true) {
  const r = await rig(t);
  const files = createFileTools(r.root, { workspaceDir: r.runtime.workspaceDir, sources: r.config.agent.sources, outputs: r.config.agent.outputs });
  files.write_upload({ path: imagePath, content: Buffer.from(TEST_IMAGE.split(',')[1], 'base64') });
  files.write_upload({ path: textPath, content: Buffer.from('PRD 正文不应该进入模型输入') });
  r.messages.files = files;
  r.config.registry = { models: { 'unit-model': { ...(vision ? { inputs: ['text', 'image'] } : {}) } } };
  return { ...r, files, submit: (id, attachments, fields = {}) => r.messages.submit({ threadId: r.session.id, clientMessageId: id, text: '请设计页面', attachments, ...fields }) };
}
test('附件：最多四项、类型、范围、存在性和内容校验；错误定位到具体项', async t => {
  const r = await setup(t);
  for (const attachments of [null, {}, 'x', Array(5).fill(imagePath)]) await assert.rejects(r.submit('bad', attachments), { status: 400 });
  for (const item of [42, null, '../x.md', 'outputs/x.md', 'inputs/uploads/.x.md', 'inputs/uploads/x.svg', 'inputs/uploads/missing.png']) {
    await assert.rejects(r.submit('bad', [textPath, item]), error => error.status === 400 && /第 2 项/.test(error.message));
  }
  fs.writeFileSync(path.join(r.files.workspace, imagePath), '不是图片');
  await assert.rejects(r.submit('bad-image', [imagePath]), error => error.status === 400 && /第 1 项/.test(error.message));
  assert.equal(r.rpc.calls.filter(call => call.method === 'turn/start').length, 0);
});
test('附件：图片作为 data URL 图片项，文本只追加说明；幂等包含附件路径', async t => {
  const r = await setup(t);
  await r.submit('one', [textPath, imagePath]);
  await until(() => r.messages.job('one').status === 'running');
  const input = r.rpc.calls.find(call => call.method === 'turn/start').params.input;
  assert.deepEqual(input.filter(item => item.type === 'image'), [{ type: 'image', url: TEST_IMAGE }]);
  const text = input.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.match(text, /请设计页面\n用户上传了文件：inputs\/uploads\/需求.md（可用 read_file 读取）/);
  assert.doesNotMatch(text, /PRD 正文/);
  assert.deepEqual(r.messages.job('one').attachments, [textPath, imagePath]);
  await r.submit('one', [textPath, imagePath]);
  await assert.rejects(r.submit('one', [imagePath]), { status: 409 });
  assert.equal(r.rpc.calls.filter(call => call.method === 'turn/start').length, 1);
});
test('附件：未声明或纯文本模型在调用前拒绝，文本附件正常执行', async t => {
  for (const inputs of [undefined, ['text']]) {
    const r = await setup(t, false); r.config.registry.models['unit-model'].inputs = inputs;
    await r.submit('denied', [imagePath]);
    await until(() => r.messages.job('denied').status === 'failed');
    assert.match(r.messages.job('denied').error, /当前模型不支持看图，请在 config\/models.json.*inputs/);
    assert.equal(r.rpc.calls.filter(call => call.method === 'turn/start').length, 0);
  }
  const r = await setup(t, false); await r.submit('text-only', [textPath]);
  await until(() => r.messages.job('text-only').status === 'running');
});
test('附件：Workflow 第一步带图片，后续步骤不重发；按意见重做第一步仍带附件', async t => {
  const r = await setup(t);
  r.config.agent.workflows = defineWorkflows({ skills: [], workflows: [{ id: 'design', steps: [
    { id: 'first', goal: '设计', confirm: true }, { id: 'second', goal: '交付' },
  ] }] });
  await r.submit('flow', [textPath, imagePath], { workflow: 'design' });
  await until(() => r.messages.job('flow').status === 'running'); r.rpc.finish(r.session.id);
  await until(() => r.messages.job('flow').status === 'waiting');
  await r.messages.revise({ threadId: r.session.id, taskId: 'flow', text: '导航少一些' });
  await until(() => r.messages.job('flow').status === 'running'); r.rpc.finish(r.session.id);
  await until(() => r.messages.job('flow').status === 'waiting');
  await r.messages.confirm({ threadId: r.session.id, taskId: 'flow' });
  await until(() => r.rpc.calls.filter(call => call.method === 'turn/start').length === 3);
  assert.deepEqual(r.rpc.calls.filter(call => call.method === 'turn/start').map(call => call.params.input.some(item => item.type === 'image')), [true, true, false]);
});
test('附件：在途追加沿用原模型，拒绝不支持图片的 turn/steer', async t => {
  for (const vision of [true, false]) {
    const r = await setup(t, vision);
    await r.submit('original', []); await until(() => r.messages.job('original').status === 'running');
    const targetTurnId = r.messages.job('original').turnId;
    await r.submit('append', [imagePath], { mode: 'append', targetTurnId });
    await until(() => ['running', 'failed'].includes(r.messages.job('append').status));
    const calls = r.rpc.calls.filter(call => call.method === 'turn/steer');
    assert.equal(calls.length, vision ? 1 : 0);
    if (vision) assert.deepEqual(calls[0].params.input.filter(item => item.type === 'image'), [{ type: 'image', url: TEST_IMAGE }]);
    else assert.match(r.messages.job('append').error, /不支持看图/);
  }
});
test('附件：排队记录序列化后服务重启仍传图，派发时重新校验文件', async t => {
  for (const changed of [false, true]) {
    const r = await setup(t);
    await r.messages.store.pause(r.session.id, true);
    await r.submit('restart', [imagePath, textPath]);
    const saved = JSON.parse(JSON.stringify(r.messages.store.state)); await r.messages.close();
    if (changed) fs.writeFileSync(path.join(r.files.workspace, imagePath), '已损坏');
    const messages = await new MessageService({ ...r, store: new TestJobs(saved) }).open(); t.after(() => messages.close());
    await messages.continue(r.session.id);
    await until(() => ['running', 'failed'].includes(messages.job('restart').status));
    assert.deepEqual(messages.job('restart').attachments, [imagePath, textPath]);
    const calls = r.rpc.calls.filter(call => call.method === 'turn/start');
    assert.equal(calls.length, changed ? 0 : 1);
    if (!changed) assert.ok(calls[0].params.input.some(item => item.type === 'image'));
  }
});
test('inputs：只允许两种声明，缺省纯文本；不从 inputModalities 推断许可', () => {
  const registry = loadModelRegistry(path.resolve(import.meta.dirname, '..'));
  assert.ok(Object.values(registry.models).every(spec => !spec.inputs?.includes('image')), '真实模型须留待负责人实测');
  const id = 'deepseek/deepseek-flash';
  for (const inputs of [[], ['image'], ['text', 'audio'], ['image', 'text'], ['text', 'image', 'image'], null, 'image']) {
    const copy = structuredClone(registry); copy.models[id].inputs = inputs;
    assert.throws(() => validateRegistry(copy), /inputs/);
  }
  for (const inputs of [undefined, ['text'], ['text', 'image']]) {
    const copy = structuredClone(registry); copy.models[id].inputs = inputs; validateRegistry(copy);
    assert.equal(createModelRouter(copy, { DEEPSEEK_API_KEY: 'fixture' }).catalog().models.chat.find(model => model.id === id).image, inputs?.includes('image') || false);
  }
});
test('图片 RPC：四张 5 MiB 图片完整发送，协议日志省略 data URL，不改变原输入', t => {
  const root = tempRoot(t), url = 'data:image/png;base64,' + Buffer.alloc(5 * 1024 * 1024).toString('base64');
  const message = { method: 'turn/start', params: { input: Array.from({ length: 4 }, () => ({ type: 'image', url })) } };
  const connection = new CodexConnection({ launch: {}, runtime: { runDir: root }, redact: createLogRedactor() });
  let sent; connection.child = { stdin: { write(value) { sent = JSON.parse(value); } } };
  connection.send(message);
  assert.deepEqual(sent, message);
  const log = fs.readFileSync(path.join(root, 'protocol.jsonl'), 'utf8');
  assert.ok(log.length < 1000); assert.match(log, /图片字节已省略/); assert.doesNotMatch(log, /data:image/);
});

import { httpFixture, fixedAccounts, request, OWNER_A, OWNER_B } from './accounts-fixture.mjs';
import { createUserFileTools } from '../server/modules/accounts/workspace.mjs';
import { runOwner } from '../server/modules/accounts/context.mjs';
test('附件 HTTP：非法项返回 400 与序号；当前用户无法引用另一用户的上传', async t => {
  const r = await setup(t), http = httpFixture(fixedAccounts(), r); t.after(() => http.close());
  const body = { threadId: r.session.id, clientMessageId: 'http', text: '设计', attachments: [textPath, 'outputs/private.png'] };
  const result = await request(http, '/messages', { token: 'unit-token', body });
  assert.equal(result.statusCode, 400); assert.match(result.body.error.message, /第 2 项/);
  const files = createUserFileTools(r.root, { workspaceDir: path.join(r.root, 'isolated'), sources: [{ id: 'input', locator: 'inputs', actions: ['read'], readOnly: true }] });
  runOwner(OWNER_A, () => files.write_upload({ path: imagePath, content: Buffer.from(TEST_IMAGE.split(',')[1], 'base64') }));
  r.messages.files = files;
  await runOwner(OWNER_B, () => assert.rejects(r.submit('foreign', [imagePath]), error => error.status === 400 && /第 1 项/.test(error.message)));
  assert.equal(r.rpc.calls.filter(call => call.method === 'turn/start').length, 0);
});
test('附件：按本轮最终模型检查，步骤覆盖任务选择时不能静默放弃图片', async t => {
  const r = await setup(t);
  const registry = { providers: { sample: { type: 'openai', keyEnv: 'SAMPLE_API_KEY' } }, models: {
    'sample/vision': { purposes: ['chat'], inputs: ['text', 'image'] }, 'sample/text': { purposes: ['chat'], inputs: ['text'] },
  }, routes: { chat: ['sample/vision'] } };
  r.config.registry = registry; r.config.launch.router = createModelRouter(registry, { SAMPLE_API_KEY: 'fixture' });
  r.config.agent.workflows = defineWorkflows({ skills: [], workflows: [{ id: 'text-step', steps: [{ id: 'first', goal: '设计', model: 'sample/text' }] }] });
  await r.submit('step-overrides', [imagePath], { model: 'sample/vision', workflow: 'text-step' });
  await until(() => r.messages.job('step-overrides').status === 'failed');
  assert.match(r.messages.job('step-overrides').error, /不支持看图/);
  assert.equal(r.rpc.calls.filter(call => call.method === 'turn/start').length, 0);
});
