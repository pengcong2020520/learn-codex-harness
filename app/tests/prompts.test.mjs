import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createPrompts } from '../shared/prompts.mjs';

// 仅还原本测试 ASCII 提示涉及的光标与清屏指令，避免把被清掉的原始输出当成可见文字。
function screen(text) {
  const lines = [[]];
  let row = 0, column = 0;
  for (let i = 0; i < text.length;) {
    if (text[i] === '\x1b') {
      const match = /^\x1b\[(\d+)([GJABCD])/.exec(text.slice(i));
      assert.ok(match, '遇到未支持的终端指令');
      const count = Number(match[1]);
      if (match[2] === 'G') column = count - 1;
      else if (match[2] === 'J') {
        assert.equal(count, 0);
        lines[row] = (lines[row] || []).slice(0, column);
        lines.length = row + 1;
      } else if (match[2] === 'A') row = Math.max(0, row - count);
      else if (match[2] === 'B') row += count;
      else if (match[2] === 'C') column += count;
      else if (match[2] === 'D') column = Math.max(0, column - count);
      i += match[0].length;
      continue;
    }
    const char = text[i++];
    if (char === '\r') column = 0;
    else if (char === '\n') { row++; column = 0; lines[row] ??= []; }
    else { lines[row] ??= []; lines[row][column++] = char; }
  }
  return lines.map(line => Array.from(line || [], char => char || ' ').join('')).join('\n');
}
function terminal(t) {
  const input = new PassThrough(); input.isTTY = true;
  let text = '';
  const output = new Writable({ write(chunk, encoding, done) { text += chunk; done(); } });
  const prompts = createPrompts(input, output);
  t.after(() => { prompts.close(); input.destroy(); output.destroy(); });
  return { input, prompts, text: () => text };
}
test('终端问答结束后保留普通提示与回答，隐藏提示可见且输入不回显', async t => {
  const f = terminal(t);
  const questions = [
    ['CODEX_MODEL: ', '1', false],
    ['API Key: ', 'fixture-hidden-key', true],
    ['SETUP_DOMAIN: ', 'example.com', false],
    ['SETUP_ADMIN_USER: ', 'admin', false],
    ['SETUP_ADMIN_PASSWORD: ', 'fixture-hidden-password', true],
    ['CONFIRM: ', 'yes', false],
  ];
  for (const [label, answer, secret] of questions) {
    const pending = f.prompts.ask(label, { secret });
    f.input.write(`${answer}\r`);
    assert.ok(await pending === answer, '应完整返回输入');
  }
  const text = f.text();
  for (const [, answer, secret] of questions) if (secret) assert.equal(text.includes(answer), false, '原始输出不得含隐藏输入');
  assert.equal(screen(text), questions.map(([label, answer, secret]) => label + (secret ? '' : answer)).join('\n') + '\n');
});
for (const secret of [false, true]) {
  test(`终端 ${secret ? '隐藏' : '普通'}输入保留 SIGINT 取消语义`, async t => {
    const f = terminal(t), pending = f.prompts.ask('INPUT: ', { secret });
    const rejected = assert.rejects(pending, /输入已取消/);
    f.input.write('fixture-cancelled-input\x03');
    await rejected;
    if (secret) assert.equal(f.text().includes('fixture-cancelled-input'), false);
  });
}
