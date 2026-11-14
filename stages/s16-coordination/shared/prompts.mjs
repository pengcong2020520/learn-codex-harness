import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

// 一个 reader 保留管道中后续行；密码不出现在 argv、环境变量或回显中。
export function createPrompts(input = process.stdin, output = process.stderr) {
  let muted = false;
  const sink = new Writable({ write(chunk, encoding, done) { if (!muted) output.write(chunk, encoding); done(); } });
  const terminal = Boolean(input.isTTY);
  const rl = createInterface({ input, output: sink, terminal });
  const iterator = terminal ? null : rl[Symbol.asyncIterator]();
  return {
    async ask(label, { secret = false } = {}) {
      if (!terminal) {
        const next = await iterator.next();
        if (next.done) throw new Error('stdin 缺少输入行。');
        return next.value;
      }
      try { return await new Promise((resolve, reject) => {
        const cancel = () => { rl.close(); reject(new Error('输入已取消。')); };
        rl.once('SIGINT', cancel);
        // 提示交给 readline 刷新；提示写出后才静音，避免一起隐藏提示。
        rl.question(label, answer => { rl.off('SIGINT', cancel); resolve(answer); });
        muted = secret;
      }); }
      finally { muted = false; if (secret) output.write('\n'); }
    },
    close() { rl.close(); },
  };
}
