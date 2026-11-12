import { AppError } from '../../../shared/errors.mjs';
const denied = () => new AppError('迁移操作单不允许此调用。', 403, 'MOVE_OPERATION');
export async function authorizeMove(pool, { operationId, userId, caller, receiver, step, target }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId || '')) throw denied();
  const op = (await pool.query('SELECT * FROM agent_data.move_operations WHERE id=$1 AND expires_at > now()', [operationId])).rows[0];
  const states = { pause: ['paused'], drain: ['paused'], copy: ['copying'], transfer: ['copying'], content: ['copying'], resume: ['switched'] };
  if (!op || op.user_id !== userId || !states[step]?.includes(op.state)) throw denied();
  const data = ['transfer','content'].includes(step);
  if (caller !== (data ? op.source_node : op.control_node) ||
      (step === 'resume' ? ![op.source_node, op.target_node].includes(receiver) : receiver !== (data ? op.target_node : op.source_node)) ||
      (target !== undefined && target !== op.target_node)) throw denied();
  return op;
}
