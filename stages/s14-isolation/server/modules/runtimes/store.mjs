import path from 'node:path';
import { transaction } from '../data/database.mjs';
import { AppError } from '../../../shared/errors.mjs';
import { prepareDirectories } from './directories.mjs';

export class RuntimeStore {
  constructor(pool, instanceId, root) { Object.assign(this, { pool, instanceId, root }); }
  async assertEnabled(owner, client = this.pool) {
    const { rows } = await client.query('SELECT disabled_at,username FROM agent_data.users WHERE instance_id=$1 AND id=$2', [this.instanceId, owner]);
    if (!rows[0]?.username || rows[0].disabled_at) throw new AppError('账号不存在或已禁用。', 403, 'ACCOUNT_DISABLED');
  }
  async ensure(owner) {
    return transaction(this.pool, async client => {
      // 全库分配锁；多个实例也不能拿到相同 uid。事务失败不消耗编号。
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agent_user_runtime_uid'))");
      await this.assertEnabled(owner, client);
      const existing = await client.query('SELECT * FROM agent_data.user_runtimes WHERE instance_id=$1 AND user_id=$2', [this.instanceId, owner]);
      if (existing.rows[0]) return existing.rows[0];
      const first = await client.query("SELECT id FROM agent_data.users WHERE instance_id=$1 AND role='admin' AND username IS NOT NULL ORDER BY created_at,id LIMIT 1", [this.instanceId]);
      const home = first.rows[0]?.id === owner ? path.join(this.root, '.data/codex') : path.join(this.root, '.data/users', owner, 'codex');
      return (await client.query(`INSERT INTO agent_data.user_runtimes(instance_id,user_id,uid,codex_home)
        SELECT $1,$2,COALESCE(MAX(uid)+1,10001),$3 FROM agent_data.user_runtimes RETURNING *`, [this.instanceId, owner, home])).rows[0];
    });
  }
  async migrateDirectories(options) {
    const { rows } = await this.pool.query(`SELECT id FROM agent_data.users WHERE instance_id=$1 AND username IS NOT NULL AND disabled_at IS NULL
      ORDER BY (role='admin') DESC,created_at,id`, [this.instanceId]);
    for (const row of rows) {
      const record = await this.ensure(row.id);
      // 迁移只立即接管原 admin 原生目录；其他用户目录在首次请求时创建。
      if (record.codex_home === path.join(this.root, '.data/codex')) prepareDirectories(this.root, record, options);
    }
  }
  async listen(onDisabled, onError) {
    const client = await this.pool.connect();
    const notification = message => {
      if (message.channel !== 'agent_runtime_disabled') return;
      try {
        const event = JSON.parse(message.payload);
        if (event.instanceId === this.instanceId) Promise.resolve(onDisabled(event.userId)).catch(onError);
      } catch (error) { onError(error); }
    };
    const ended = () => onError(new Error('账号禁用通知连接已断开，停止执行器。'));
    client.on('notification', notification); client.on('error', onError); client.on('end', ended);
    try { await client.query('LISTEN agent_runtime_disabled'); }
    catch (error) { client.release(true); throw error; }
    return async () => {
      try { await client.query('UNLISTEN agent_runtime_disabled'); }
      finally { client.off('notification', notification); client.off('error', onError); client.off('end', ended); client.release(); }
    };
  }
}
