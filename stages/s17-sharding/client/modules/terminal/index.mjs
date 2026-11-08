import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

export function safeText(value) { return stripVTControlCharacters(String(value ?? "")).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""); }

export function createTerminal(input = process.stdin, output = process.stdout) {
  const tty = Boolean(input.isTTY && output.isTTY && process.env.TERM !== "dumb");
  const rl = createInterface({ input, output, terminal: tty });
  const prompt = "你 > ";
  let tail = "";
  let openLine = false;
  rl.setPrompt(prompt);

  // 已完成的行写入终端历史；还在增长的末行与输入框一起重绘。
  // 让 readline 计算中文、自动折行和光标位置，不把新 token 当成新日志。
  function redraw(committed = "", showPrompt = true) {
    if (!tty || rl.closed) { output.write(committed); return; }
    const { line, cursor } = rl;
    rl.line = "";
    rl.cursor = 0;
    rl.setPrompt("");
    rl.prompt(true);
    output.write(committed);
    rl.line = line;
    rl.cursor = cursor;
    rl.setPrompt((tail ? tail + "\n" : "") + prompt);
    if (showPrompt) rl.prompt(true);
  }

  function endStream() {
    if (tty && !rl.closed) {
      const remaining = tail;
      tail = "";
      if (remaining) redraw(remaining + "\n");
    } else if (openLine) output.write("\n");
    openLine = false;
  }

  rl.on("line", () => {
    // Enter 已把当前屏幕（包括回复末行和用户输入）提交到终端历史。
    if (tty) { tail = ""; openLine = false; rl.setPrompt(prompt); }
  });

  return {
    rl,
    prompt() { if (tty && !rl.closed) rl.prompt(true); },
    write(value) {
      if (!tty || rl.closed) endStream();
      redraw(safeText(value) + "\n");
    },
    stream(value) {
      const text = safeText(value);
      if (!text) return;
      openLine = !text.endsWith("\n");
      if (!tty || rl.closed) { output.write(text); return; }
      tail += text;
      const lastNewline = tail.lastIndexOf("\n");
      const complete = tail.slice(0, lastNewline + 1);
      tail = tail.slice(lastNewline + 1);
      redraw(complete);
    },
    endStream,
    close() { endStream(); redraw("", false); rl.close(); }
  };
}
