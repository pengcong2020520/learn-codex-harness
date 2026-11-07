// 会话事件协议 v2，CLI 与网页工作台共用：
// - snapshot / session：完整会话，直接替换；
// - turn：一个轮次的完整状态，替换同 id 的轮次；
// - delta：一条回复新增的文字，offset 是它在整条回复里的起点。
// 只处理 isSessionEvent 为真的事件。返回新的会话对象；返回 null 表示本地缺了增量，调用方需要重新同步快照。
export const SESSION_TURN_LIMIT = 30;

export function applySessionEvent(session, event) {
  if (event.type === "snapshot") return event.data.session;
  if (event.type === "session") return event.data;
  if (!["turn", "delta"].includes(event.type) || !session || event.threadId !== session.id) return session;
  if (event.type === "turn") {
    const { turn, ...fields } = event.data;
    const index = session.turns.findIndex(item => item.id === turn.id);
    const turns = index === -1 ? [...session.turns, turn].slice(-SESSION_TURN_LIMIT) : session.turns.with(index, turn);
    return { ...session, ...fields, turns };
  }
  const { turnId, itemId, offset, text } = event.data;
  const index = session.turns.findIndex(item => item.id === turnId);
  if (index === -1) return null;
  const turn = session.turns[index];
  const answer = turn.answers[itemId] || "";
  if (offset > answer.length) return null;
  // 重连补发可能与已有文字重叠，只追加还没有的部分。
  if (offset + text.length <= answer.length) return session;
  const answers = { ...turn.answers, [itemId]: answer + text.slice(answer.length - offset) };
  return { ...session, turns: session.turns.with(index, { ...turn, answers }) };
}

// 这几类事件描述的状态都包含在会话快照里。
export const SESSION_EVENT_TYPES = new Set(["session", "turn", "delta"]);
export const isSessionEvent = event => event.type === "snapshot" || SESSION_EVENT_TYPES.has(event.type);
