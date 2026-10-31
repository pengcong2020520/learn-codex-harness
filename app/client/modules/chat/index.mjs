import { randomUUID } from "node:crypto";
import { applySessionEvent, isSessionEvent } from "../../../shared/session-events.mjs";

const HELP = `普通文字：提交普通队列；可连续输入，不必等待模型回复。
/append 内容        显式追加当前或刚结束的任务（等价于追加按钮）
/append-to ID 内容  指定目标 turn，避免多窗口时目标含糊
/workflow           列出当前 Agent 启用的 Workflow
/workflow ID [键=值 ...] 内容  按 Workflow 提交新任务，如 /workflow knowledge-maintain kbId=general 整理新资料
/queue              查看队列
/tools              查看已加载工具和更新状态
/memory             查看记忆配置和产物状态（不触发模型）
/memory show        查看已有记忆摘要
/memory contribute on|off  控制当前 Thread 是否参与后续记忆提炼
/continue           明确继续暂停的待执行队列，不重发未确认消息
/resume [关键词]    搜索历史会话，再输入完整 Thread id 恢复
/new                切换到新会话；不会取消旧会话任务
/help               查看帮助
/exit               仅退出客户端，服务端任务继续运行`;

const toolStatus = state => `工具目录：${({ ready: "已就绪", pending: "等待当前任务结束后更新", loading: "更新中", degraded: "更新失败，沿用上一版", unavailable: "不可用" })[state.status] || state.status}${state.error ? `；${state.error}` : ""}`;

export async function runChat(api, terminal) {
  let current = null;
  let subscription = null;
  let choices = null;
  let chain = Promise.resolve();
  let exiting = false;
  let eof = false;
  let displayed = new Map();
  let queuePaused = false;
  let renderingTurnId = null;
  let reported = new Set();
  const finished = Promise.withResolvers();
  const failedChecks = job => (job.checks || []).filter(check => !check.passed).map(check => `${check.label}（${check.detail}）`).join("；");

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
      const toolStates = {};
      for (const [id, tool] of Object.entries(turn.tools || {})) {
        toolStates[id] = tool.status;
        if (before?.tools?.[id] === tool.status) continue;
        const status = tool.status === "inProgress" ? "执行中" : tool.status === "completed" ? "完成" : "失败";
        terminal.write(`工具：${tool.label || tool.name} · ${status}${tool.error ? `；${tool.error}` : ""}`);
      }
      if (turn.status !== "inProgress") {
        if (renderingTurnId === turn.id) terminal.endStream();
        if (before?.status !== turn.status && turn.status !== "completed") {
          terminal.write(`状态：${turn.status}${turn.error ? `；${turn.error}` : ""}`);
        }
      }
      displayed.set(turn.id, { answer, status: turn.status, tools: toolStates });
    }
  }

  async function select(session) {
    subscription?.close();
    terminal.endStream();
    current = session;
    displayed = new Map();
    queuePaused = false;
    renderingTurnId = null;
    reported = new Set();
    terminal.write(`Thread id: ${session.id}\n模型：${session.model || "服务端配置"}`);
    renderSession(session);
    const stream = api.subscribe(session.id, event => {
      if (event.threadId && event.threadId !== current?.id) return;
      if (isSessionEvent(event)) {
        const next = applySessionEvent(current, event);
        // 增量接不上本地文字：放弃断点，重新从快照同步。
        if (!next) return stream.resync();
        renderSession(next);
      }
      const queue = event.type === "snapshot" ? event.data.queue : event.type === "queue" ? event.data : null;
      if (queue) {
        if (queue.paused && !queuePaused) terminal.write("队列已暂停，查看 /queue 后可用 /continue 明确继续。");
        queuePaused = queue.paused;
        // Workflow 任务结束后报告一次验收结果；快照里的历史任务只记下，不重复刷屏。
        for (const job of queue.jobs) {
          if (!job.checks || !["completed", "needs-review"].includes(job.status) || reported.has(job.id)) continue;
          reported.add(job.id);
          if (event.type === "snapshot") continue;
          terminal.write(job.status === "completed" ? `验收通过（${job.workflow}）` : `验收未通过（${job.workflow}）：${failedChecks(job)}`);
        }
      }
      if (event.type === "fatal") terminal.write(`服务异常：${event.data.message}`);
      if (event.type === "tools") terminal.write(toolStatus(event.data));
    }, (status, message) => { if (status === "reconnecting") terminal.write(`${message} 正在重连；不会自动重发消息。`); });
    subscription = stream;
  }

  async function handle(line) {
    const text = line.trim();
    if (!text || exiting) return;
    if (text === "/exit") { exiting = true; terminal.close(); return; }
    if (text === "/help") return terminal.write(HELP);
    if (/^\/memory(?:\s|$)/.test(text)) {
      const command = text.slice(7).trim();
      if (!command) {
        const state = await api.request("/memory");
        terminal.write(`记忆总开关：${state.effective.enabled ? "开启" : "关闭"}\n使用已有记忆：${state.effective.use ? "开启" : "关闭"}\n新 Thread 默认参与提炼：${state.effective.generate ? "是" : "否"}\n记忆摘要：${state.hasSummary ? "已有产物" : "尚无产物"}\n记忆目录：${state.directory}\n${state.generationWarning}\n${state.note}`);
        return;
      }
      if (command === "show") {
        const summary = await api.request("/memory/summary");
        terminal.write(summary.text || "尚无记忆摘要。可能未开启或尚未满足生成条件。");
        if (summary.truncated) terminal.write("摘要过长，当前仅展示前 64 KiB。");
        return;
      }
      const match = command.match(/^contribute\s+(on|off)$/);
      if (!match) return terminal.write("用法：/memory、/memory show、/memory contribute on|off");
      if (!current) return terminal.write("请先新建或恢复会话，再修改该 Thread 的记忆参与设置。");
      const result = await api.request("/memory/contribution", { threadId: current.id, enabled: match[1] === "on" });
      terminal.write(`Thread id: ${result.threadId}\n参与提炼：${result.mode === "enabled" ? "允许" : "禁止"}\n${result.note}`);
      return;
    }
    if (text === "/tools") {
      const state = await api.request("/tools");
      terminal.write(toolStatus(state));
      for (const tool of state.tools) terminal.write(`${tool.name}：${tool.label}`);
      return;
    }
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
    if (text === "/new") { subscription?.close(); terminal.endStream(); current = null; displayed.clear(); renderingTurnId = null; return terminal.write("下一条普通消息将创建新会话。旧任务不会取消。"); }
    if (text === "/queue") {
      if (!current) return terminal.write("尚未选择会话。");
      const state = await api.request(`/state?threadId=${encodeURIComponent(current.id)}`);
      renderSession(state.session);
      terminal.write(`队列${state.queue.paused ? "（暂停）" : ""}：`);
      for (const job of state.queue.jobs) terminal.write(`${job.status}  ${job.workflow && job.workflow !== "chat" ? `[${job.workflow}] ` : ""}${job.text.slice(0,100)}${job.targetTurnId ? ` [追加目标 turn id: ${job.targetTurnId}]` : ""}${job.error ? `；${job.error}` : ""}${job.status === "needs-review" ? `；验收未通过：${failedChecks(job)}` : ""}`);
      if (!state.queue.jobs.length) terminal.write("暂无消息。");
      return;
    }
    if (text === "/continue") {
      if (!current) return terminal.write("请先选择会话。");
      await api.request("/queue/continue", { threadId: current.id });
      return terminal.write("已请求继续待执行队列；未确认的旧消息不会重发。");
    }
    let mode = "enqueue", content = text, targetTurnId, workflow;
    if (/^\/workflow(?:\s|$)/.test(text)) {
      const match = text.slice(9).trim().match(/^(\S+)((?:\s+[A-Za-z][\w-]*=\S+)*)\s*([\s\S]*)$/);
      if (!match) {
        const { agent } = await api.request("/workbench");
        for (const item of agent?.workflows || [])
          terminal.write(`${item.id}：${item.label}${item.params ? `  参数：${Object.keys(item.params.properties).map(key => `${key}=…`).join(" ")}` : ""}${item.checks.length ? `  验收：${item.checks.join("、")}` : ""}`);
        return;
      }
      const pairs = match[2].trim() ? match[2].trim().split(/\s+/).map(pair => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]) : [];
      workflow = { workflow: match[1], params: pairs.length ? Object.fromEntries(pairs) : null };
      content = match[3].trim();
    } else if (/^\/append-to(?:\s|$)/.test(text)) {
      const match = text.match(/^\/append-to\s+(\S+)\s+([\s\S]+)$/);
      if (!match) return terminal.write("用法：/append-to 目标turnID 补充内容");
      [, targetTurnId, content] = match;
      mode = "append";
    } else if (/^\/append(?:\s|$)/.test(text)) {
      mode = "append"; content = text.slice(7).trim();
      // 捕获用户操作所指向的目标，不在服务端悄悄换成另一轮。
      targetTurnId = current?.activeTurnId || current?.lastTurnId;
    } else if (text.startsWith("/")) return terminal.write("未知命令，请使用 /help。");
    if (!content) return terminal.write("请输入消息内容。");
    if (mode === "append" && !targetTurnId) return terminal.write("当前没有可追加的目标轮次；先发送普通消息。");
    if (!current) await select(await api.request("/sessions", {}));
    const clientMessageId = randomUUID();
    const result = await api.request("/messages", { threadId: current.id, clientMessageId, mode, text: content, targetTurnId, ...workflow });
    // UUID 仅用于服务端幂等处理，不作为聊天界面的编号展示。
    if (["failed", "unconfirmed"].includes(result.status)) terminal.write(`消息状态：${result.status}${result.error ? `；${result.error}` : ""}`);
  }

  terminal.write("已连接你的 Agent 服务。输入 /help 查看操作；/exit 仅关闭当前客户端。");
  terminal.rl.on("line", line => {
    chain = chain.then(() => handle(line)).catch(error => terminal.write(`操作失败：${error.message}`));
    terminal.prompt();
  });
  terminal.rl.on("SIGINT", () => { exiting = true; terminal.close(); });
  terminal.rl.on("close", () => {
    eof = true;
    // 只等已经输入的 HTTP 提交完成，不等待模型回答。不会因管道 EOF 丢掉最后一条提交。
    chain.finally(() => finished.resolve());
  });
  await finished.promise;
  exiting = true;
  subscription?.close();
  await subscription?.done;
  terminal.endStream();
  if (eof) terminal.write("已退出客户端。已提交任务由服务端继续执行。");
}
