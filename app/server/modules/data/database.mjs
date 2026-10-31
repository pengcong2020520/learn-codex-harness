import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readJson, writeJson } from "../storage/index.mjs";

export async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function identity(root) {
  const file = path.join(root, ".data/identity.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink())
    throw new Error("数据身份目录不能是链接。");
  if (fs.existsSync(file)) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("数据身份文件不能是链接。");
  }
  let value = readJson(file, null);
  if (!value) {
    value = { instanceId: randomUUID(), ownerId: randomUUID() };
    writeJson(file, value);
  }
  for (const id of [value.instanceId, value.ownerId])
    if (!/^[a-f0-9-]{36}$/.test(id || ""))
      throw new Error("数据实例身份文件无效。");
  return value;
}

export async function openDatabase(url) {
  if (!url)
    throw new Error(
      "缺少 DATABASE_URL。请配置 PostgreSQL 后运行 npm run data:migrate；不会回退到 JSON 存储。",
    );
  const pool = new Pool({
    connectionString: url,
    max: 6,
    connectionTimeoutMillis: 3000,
    query_timeout: 12000,
    keepAlive: true,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 15000,
  });
  pool.on("error", () => {}); // Requests/worker heartbeat surface failures without printing connection secrets.
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch {
    await pool.end();
    throw new Error("无法连接 PostgreSQL；请检查 DATABASE_URL 和数据库状态。");
  }
}

const migrations = ['schema.sql', 'migrations/002-knowledge.sql', 'migrations/003-workflows.sql', 'migrations/004-workflow-steps.sql'].map((name, index) => {
  const sql = fs.readFileSync(new URL(name, import.meta.url), 'utf8');
  return { version: index + 1, sql, checksum: createHash('sha256').update(sql).digest('hex') };
});
function compatible(rows) {
  return rows.length <= migrations.length && rows.every((row, i) => row.version === migrations[i].version && row.checksum === migrations[i].checksum);
}
export async function migrate(pool) {
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('agent_data_migration'))");
    await client.query('CREATE SCHEMA IF NOT EXISTS agent_data; CREATE TABLE IF NOT EXISTS agent_data.migrations(version integer PRIMARY KEY, checksum text NOT NULL)');
    const { rows } = await client.query('SELECT * FROM agent_data.migrations ORDER BY version');
    if (!compatible(rows)) throw new Error('数据库迁移版本或校验值不匹配；请勿修改已经执行的 migration。');
    for (const migration of migrations.slice(rows.length)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO agent_data.migrations VALUES($1,$2)', [migration.version, migration.checksum]);
    }
  });
}
export async function verifySchema(pool) {
  let rows;
  try { rows = (await pool.query('SELECT * FROM agent_data.migrations ORDER BY version')).rows; }
  catch { throw new Error('数据库尚未初始化，请先运行 npm run data:migrate。'); }
  if (!compatible(rows) || rows.length !== migrations.length) throw new Error('数据库版本不匹配，请运行 npm run data:migrate。');
}

// This service intentionally has one executor per instance, not distributed workers.
export async function acquireDatabaseLock(pool, instanceId, onLost) {
  const client = await pool.connect();
  let lost = false;
  const fail = () => {
    if (!lost) {
      lost = true;
      onLost(new Error("数据库执行器锁连接已丢失；停止调度，请核对执行结果。"));
    }
  };
  client.on("error", fail);
  try {
    const result = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
      [instanceId],
    );
    if (!result.rows[0].locked)
      throw new Error("这个数据实例已有执行器，不能重复启动。");
  } catch (error) {
    client.off("error", fail);
    client.release();
    throw error;
  }
  const timer = setInterval(() => {
    client.query("SELECT 1").catch(fail);
  }, 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    client.off("error", fail);
    if (!lost)
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          instanceId,
        ])
        .catch(() => {});
    client.release(lost);
  };
}
