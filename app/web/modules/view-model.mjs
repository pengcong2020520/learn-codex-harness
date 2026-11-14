import { applySessionEvent, isSessionEvent } from './session-events.mjs';
export const lossMessage = '这个会话在主节点故障接管时丢失了最后一部分内容';
export const emptyState = () => ({ session: null, queue: { jobs: [], paused: false } });
export function reduceEvent(state, event) {
  if (event.threadId && state.session && event.threadId !== state.session.id) return state;
  const session = isSessionEvent(event) ? applySessionEvent(state.session, event) : state.session;
  if (isSessionEvent(event) && !session) return null;
  return { session, queue: event.type === 'snapshot' ? event.data.queue : event.type === 'queue' ? event.data : state.queue };
}
const statuses = { queued: '排队', starting: '启动中', steering: '追加中', running: '执行中', dispatching: '派发中', submitted: '已提交', completed: '完成', failed: '失败', waiting: '等待确认', proposed: '等待确认', cancelled: '已结束', interrupted: '已中断', 'needs-review': '待核对', unconfirmed: '待核对', replica_missing: '副本缺失', inProgress: '执行中' };
export const statusLabel = status => statuses[status] || status || '等待状态';
export const hasLoss = session => Boolean(session?.replicaMissing || session?.replica_missing || session?.missingTurns?.length);
export function messagesView({ session, queue }) {
  const jobs = queue?.jobs || [], rows = [], seen = new Set();
  for (const turn of session?.turns || []) {
    const related = jobs.filter(job => job.turnId === turn.id || job.targetTurnId === turn.id);
    for (const message of turn.messages || []) {
      const candidate = jobs.find(job => job.id === message.clientId) || related.find(job => job.text === message.text);
      // 同一任务重做会产生多轮消息，确认动作只挂在一个任务入口上。
      const job = candidate && !seen.has(candidate.id) ? candidate : undefined;
      if (job) seen.add(job.id);
      rows.push({ id: message.id, role: 'user', text: message.text, job, status: job?.status || turn.status });
    }
    // Workflow steps may have their own prompts. Keep the originating task visible too.
    for (const job of related) if (!seen.has(job.id)) { seen.add(job.id); rows.push({ id: job.id, role: 'user', text: job.text, job, status: job.status }); }
    for (const [id, text] of Object.entries(turn.answers || {})) rows.push({ id, role: 'assistant', text, status: related.at(-1)?.status || turn.status, error: turn.error?.message || (typeof turn.error === 'string' ? turn.error : '') });
  }
  for (const job of jobs) if (!seen.has(job.id)) rows.push({ id: job.id, role: 'user', text: job.text, job, status: job.status });
  return rows.map(row => ({ ...row, label: statusLabel(row.status), error: row.job?.error || row.error || '', confirm: ['waiting', 'proposed'].includes(row.job?.status), actions: row.job?.status === 'waiting' ? ['继续', '修改', '结束'] : row.job?.status === 'proposed' ? ['继续', '结束'] : [], reviseCount: row.job?.reviseCount || 0, model: row.job?.selectedModel || session?.model }));
}
export function pauseReason(queue) {
  return queue?.reason || queue?.budget?.reason || queue?.jobs?.find(job => ['unconfirmed', 'failed', 'interrupted', 'needs-review'].includes(job.status) && job.error)?.error || '服务端未提供暂停原因，请核对任务状态后继续。';
}
