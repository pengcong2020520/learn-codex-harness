const HELP = `普通文字：交给服务端执行一轮；上一轮结束后才发送下一条。
/resume [关键词]    搜索历史会话，再输入完整 Thread id 恢复
/new                切换到新会话
/help               查看帮助
/exit               仅退出客户端，服务端正在执行的一轮继续运行`;

export async function runChat(api, terminal) {
  let current = null;
  let choices = null;
  let chain = Promise.resolve();
  let exiting = false;
  let eof = false;
  let displayed = new Map();
  let renderingTurnId = null;
  const stopped = new AbortController();
  const finished = Promise.withResolvers();

  function renderSession(session) {
    if (current?.id !== session.id) return;
    current = session;
    for (const turn of session.turns) {
      const answer = Object.values(turn.answers).join("\n");
      const before = displayed.get(turn.id);
      if (!before || (answer !== before.answer && renderingTurnId !== turn.id)) {
        terminal.endStream();
        terminal.write(`turn id: ${turn.id}`);
        renderingTurnId = turn.id;
      }
      if (answer && before?.answer !== answer) {
        if (before?.answer && !answer.startsWith(before.answer)) {
          // 最终快照偶尔会修订文本，不能把修订后的全文当作新 token 追加。
          terminal.endStream();
          terminal.write("回复已更新：");
          terminal.stream(`Agent：${answer}`);
        } else {
          const addition = answer.slice(before?.answer.length || 0);
          terminal.stream(`${before?.answer ? "" : "Agent："}${addition}`);
        }
      }
      if (turn.status !== "inProgress") {
        if (renderingTurnId === turn.id) terminal.endStream();
        if (before?.status !== turn.status && turn.status !== "completed") {
          terminal.write(`状态：${turn.status}${turn.error ? `；${turn.error}` : ""}`);
        }
      }
      displayed.set(turn.id, { answer, status: turn.status });
    }
  }

  function select(session) {
    terminal.endStream();
    current = session;
    displayed = new Map();
    renderingTurnId = null;
    terminal.write(`Thread id: ${session.id}\n模型：${session.model || "服务端配置"}`);
    renderSession(session);
  }

  async function handle(line) {
    const text = line.trim();
    if (!text || exiting) return;
    if (text === "/exit") { exiting = true; terminal.close(); return; }
    if (text === "/help") return terminal.write(HELP);
    if (choices) {
      if (text === "/cancel") { choices = null; return terminal.write("已取消选择，当前会话不变。"); }
      const selected = choices.find(session => session.id === text);
      if (!selected) return terminal.write("请输入列表中的完整 Thread id，或 /cancel 返回。");
      const session = await api.request("/sessions/resume", { threadId: selected.id });
      choices = null;
      return select(session);
    }
    if (/^\/resume(?:\s|$)/.test(text)) {
      const result = await api.request(`/sessions?q=${encodeURIComponent(text.slice(7).trim())}`);
      if (!result.sessions.length) return terminal.write("未找到匹配会话，当前会话不变。");
      choices = result.sessions;
      choices.forEach(session => terminal.write(`${session.name || session.preview || "未命名"}\nThread id: ${session.id}`));
      return terminal.write("输入完整 Thread id 恢复；/cancel 返回；/exit 退出。");
    }
    if (text === "/new") { terminal.endStream(); current = null; displayed.clear(); renderingTurnId = null; return terminal.write("下一条普通消息将创建新会话。"); }
    if (text.startsWith("/")) return terminal.write("未知命令，请使用 /help。");
    if (!current) select(await api.request("/sessions", {}));
    const { turnId } = await api.request("/turns", { threadId: current.id, text });
    // 服务端已接手这一轮；客户端只负责查看进度，直到它结束。
    await api.follow(current.id, turnId, renderSession, { signal: stopped.signal });
  }

  terminal.write("已连接你的 Agent 服务。输入 /help 查看操作；/exit 仅关闭当前客户端。");
  terminal.rl.on("line", line => {
    chain = chain.then(() => handle(line)).catch(error => terminal.write(`操作失败：${error.message}`));
    terminal.prompt();
  });
  terminal.rl.on("SIGINT", () => { exiting = true; stopped.abort(); terminal.close(); });
  terminal.rl.on("close", () => {
    eof = true;
    // 管道输入结束时，先把已经输入的消息逐条交给服务端；Ctrl+C 则立即停止查看。
    chain.finally(() => finished.resolve());
  });
  await finished.promise;
  exiting = true;
  stopped.abort();
  terminal.endStream();
  if (eof) terminal.write("已退出客户端。已交给服务端的一轮会继续执行，下次用 /resume 查看结果。");
}
