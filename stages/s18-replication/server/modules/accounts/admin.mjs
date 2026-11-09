import { randomUUID } from 'node:crypto';
import { transaction } from '../data/database.mjs';
import { hashPassword, normalizeUsername } from './password.mjs';
import { moveLegacyWorkspace } from './workspace.mjs';

const adminKey = id => `accounts:${id}`;
async function accountLock(client, id) { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [adminKey(id)]); }
export async function enabledCount(store, client = store.pool) {
  return (await store.query('SELECT count(*)::int AS n FROM agent_data.users WHERE instance_id=$1 AND username IS NOT NULL AND disabled_at IS NULL', [], client)).rows[0].n;
}
export async function assertUninitialized(store, client = store.pool) {
  const initialized = await store.query('SELECT 1 FROM agent_data.users WHERE instance_id=$1 AND username IS NOT NULL', [], client);
  // 专用退出码只代表重复初始化；部署脚本不能吞掉其他错误。
  if (initialized.rowCount) throw Object.assign(new Error('账号已初始化，拒绝重复执行 auth:init。'), { exitCode: 3 });
}
export async function guardStartup(store) {
  if (!await enabledCount(store)) throw new Error('账号尚未初始化，请先运行 npm run auth:init。');
  return async () => {};
}
export async function initializeAccounts(store, { ownerId, username, password, workspace }) {
  username = normalizeUsername(username);
  if (!username) throw new Error('用户名不能为空。');
  const hash = await hashPassword(password);
  return transaction(store.pool, async client => {
    await accountLock(client, store.instanceId);
    await assertUninitialized(store, client);
    await store.query(`INSERT INTO agent_data.users(instance_id,id,name,username,password_hash,role)
      VALUES($1,$2,'local-owner',$3,$4,'admin') ON CONFLICT(instance_id,id)
      DO UPDATE SET username=$3,password_hash=$4,role='admin',disabled_at=NULL`, [ownerId, username, hash], client);
    moveLegacyWorkspace(workspace, ownerId);
    return { id: ownerId, username, role: 'admin' };
  });
}
export async function addUser(store, { username, password, admin = false }) {
  username = normalizeUsername(username);
  if (!username) throw new Error('用户名不能为空。');
  const hash = await hashPassword(password);
  return transaction(store.pool, async client => {
    await accountLock(client, store.instanceId);
    const initialized = await store.query('SELECT 1 FROM agent_data.users WHERE instance_id=$1 AND username IS NOT NULL', [], client);
    if (!initialized.rowCount) throw new Error('请先运行 npm run auth:init。');
    const id = randomUUID();
    await store.query(`INSERT INTO agent_data.users(instance_id,id,name,username,password_hash,role) VALUES($1,$2,$3,$3,$4,$5)`,
      [id, username, hash, admin ? 'admin' : 'user'], client);
    return { id, username, role: admin ? 'admin' : 'user' };
  });
}
export async function changeUser(store, username, { password, disable = false }) {
  const hash = disable ? null : await hashPassword(password);
  return transaction(store.pool, async client => {
    const result = await store.query(`UPDATE agent_data.users SET ${disable ? 'disabled_at=now()' : 'password_hash=$3'}
      WHERE instance_id=$1 AND username=$2 RETURNING id`, [normalizeUsername(username), ...(disable ? [] : [hash])], client);
    if (!result.rowCount) throw new Error('账号不存在。');
    await store.revokeAll(result.rows[0].id, client);
  });
}
