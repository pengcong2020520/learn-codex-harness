import path from "node:path";
import fs from "node:fs";
import {
  openDatabase,
  verifySchema,
  identity,
  acquireDatabaseLock,
} from "./database.mjs";
import { Repository } from "./repository.mjs";
import { PostgresJobs } from "./jobs.mjs";
import { RedisQueue } from "./queue.mjs";
import { Resources } from "./resources.mjs";

export async function openData(config, { onLost = () => {} } = {}) {
  const pool = await openDatabase(config.data?.databaseUrl);
  let unlock, queue;
  try {
    await verifySchema(pool);
    const scope = identity(config.root),
      repository = new Repository(pool, scope),
      jobs = new PostgresJobs(pool, scope);
    unlock = await acquireDatabaseLock(pool, scope.instanceId, onLost);
    await repository.initialize();
    if (
      ["messages.json", "thread-agents.json"].some((name) =>
        fs.existsSync(path.join(config.root, ".data", name)),
      )
    ) {
      const imported = await repository.query(
        "SELECT 1 FROM agent_data.imports WHERE instance_id=$1 AND kind='legacy-json' AND $2::uuid IS NOT NULL",
      );
      if (!imported.rowCount)
        throw new Error(
          "检测到旧 JSON 状态。请停服后先运行 npm run data:import 预检，再运行 npm run data:import -- --apply；原文件不会删除。",
        );
    }
    queue = new RedisQueue(config.data?.redisUrl, scope.instanceId, jobs);
    await queue.open();
    return {
      pool,
      scope,
      repository,
      jobs,
      queue,
      resources(options) {
        return new Resources(pool, scope, {
          ...options,
          blobDir: path.join(config.root, ".data/files/objects"),
        });
      },
      async close() {
        await queue.close();
        await unlock();
        await pool.end();
      },
    };
  } catch (error) {
    await queue?.close();
    await unlock?.();
    await pool.end();
    throw error;
  }
}
