import { businessQuery } from '../data/write.mjs';
import { transaction } from '../data/database.mjs';

export class AccountStore {
  constructor(pool, instanceId) { Object.assign(this, { pool, instanceId }); }
  query(sql, values = [], client = this.pool) { return businessQuery(client, sql, [this.instanceId, ...values]); }
  async byUsername(username) {
    return (await this.query('SELECT * FROM agent_data.users WHERE instance_id=$1 AND username=$2', [username])).rows[0];
  }
  async createSession(user, session) {
    return transaction(this.pool, async client => {
      const current = (await this.query('SELECT * FROM agent_data.users WHERE instance_id=$1 AND id=$2 FOR UPDATE', [user.id], client)).rows[0];
      if (!current || current.disabled_at || current.password_hash !== user.password_hash) return false;
      await this.query(`INSERT INTO agent_data.auth_sessions(instance_id,id,user_id,token_hash,created_at,last_seen_at,expires_at,client_hint)
        VALUES($1,$2,$3,$4,$5,$5,$6,$7)`, [session.id, session.userId, session.tokenHash, session.createdAt, session.expiresAt, session.clientHint], client);
      return true;
    });
  }
  async session(hash) {
    return (await this.query(`SELECT u.id,u.username,u.role,u.disabled_at,s.id AS session_id,s.created_at,s.last_seen_at,s.expires_at,s.revoked_at
      FROM agent_data.auth_sessions s JOIN agent_data.users u ON u.instance_id=s.instance_id AND u.id=s.user_id
      WHERE s.instance_id=$1 AND s.token_hash=$2`, [hash])).rows[0];
  }
  async touch(id, now) {
    await this.query(`UPDATE agent_data.auth_sessions SET last_seen_at=$3 WHERE instance_id=$1 AND id=$2 AND revoked_at IS NULL
      AND last_seen_at <= $3::timestamptz - interval '1 minute'`, [id, now]);
  }
  async revokeAll(userId, client) {
    if (!client) return transaction(this.pool, async locked => {
      await this.query('SELECT id FROM agent_data.users WHERE instance_id=$1 AND id=$2 FOR UPDATE', [userId], locked);
      return this.revokeAll(userId, locked);
    });
    await this.query('UPDATE agent_data.auth_sessions SET revoked_at=now() WHERE instance_id=$1 AND user_id=$2 AND revoked_at IS NULL', [userId], client);
  }
}
