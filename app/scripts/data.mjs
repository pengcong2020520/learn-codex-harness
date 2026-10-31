import path from "node:path";
import {
  loadEnvironment,
  createLogRedactor,
} from "../server/modules/config/index.mjs";
import { PROJECT_ROOT } from "../shared/paths.mjs";
import { acquireServerLock } from "../server/modules/storage/index.mjs";
import {
  identity,
  openDatabase,
  migrate,
  verifySchema,
  acquireDatabaseLock,
} from "../server/modules/data/database.mjs";
import { Repository } from "../server/modules/data/repository.mjs";
import { importLegacy } from "../server/modules/data/legacy.mjs";
import { RedisQueue } from "../server/modules/data/queue.mjs";
import { selectAgentFile } from "../server/modules/agents/selection.mjs";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import { Resources } from "../server/modules/data/resources.mjs";
import { createFileTools } from "../server/modules/data/files.mjs";

const [command, ...args] = process.argv.slice(2),
  env = loadEnvironment();
const redact = createLogRedactor(env.CODEX_API_KEY, [
  env.DATABASE_URL,
  env.REDIS_URL,
]);
let pool, release, unlock, queue;
try {
  if (
    !["migrate", "check", "import", "reconcile", "revoke", "relocate"].includes(
      command,
    )
  )
    throw new Error(
      "用法：data.mjs migrate|check|import [--apply]|reconcile|revoke <id>|relocate <id> <新路径>",
    );
  if (command !== "check") release = acquireServerLock(PROJECT_ROOT);
  pool = await openDatabase(env.DATABASE_URL);
  if (command === "migrate") {
    await migrate(pool);
    console.log("数据库 schema 已就绪；未导入旧数据，未修改 Codex 原生存储。");
  } else {
    await verifySchema(pool);
    const scope = identity(PROJECT_ROOT),
      repo = new Repository(pool, scope);
    if (command !== "check") {
      unlock = await acquireDatabaseLock(pool, scope.instanceId, () => {});
      await repo.initialize();
    }
    if (command === "check") {
      queue = new RedisQueue(env.REDIS_URL, scope.instanceId, null);
      await queue.open();
      console.log("PostgreSQL schema 与 Redis 连接检查通过；尚未调用模型。");
    } else if (command === "import") {
      if (args.some((arg) => arg !== "--apply"))
        throw new Error("导入只接受 --apply；默认仅预检。");
      console.log(
        JSON.stringify(
          await importLegacy(repo, PROJECT_ROOT, {
            apply: args.includes("--apply"),
          }),
        ),
      );
    } else {
      const agent = new AgentDefinition(
        PROJECT_ROOT,
        selectAgentFile(PROJECT_ROOT, env.AGENT_DEFINITION),
      );
      const files = createFileTools(PROJECT_ROOT, {
        workspaceDir: agent.workspacePath,
        sources: agent.sources,
        outputs: agent.outputs,
        assertCurrent: () => agent.assertCurrent(),
      });
      const resources = new Resources(pool, scope, {
        files,
        sources: agent.sources,
        outputs: agent.outputs,
        blobDir: path.join(PROJECT_ROOT, ".data/files/objects"),
      });
      if (command === "reconcile")
        console.log(JSON.stringify(await resources.reconcile()));
      if (command === "revoke") {
        await resources.revoke(args[0]);
        console.log("已撤销读取并使派生内容失效；正文未删除。");
      }
      if (command === "relocate")
        console.log(JSON.stringify(await resources.relocate(args[0], args[1])));
    }
  }
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  await queue?.close();
  await unlock?.();
  await pool?.end();
  release?.();
}
