// Offline native-history-preserving compatibility bridge. Default is a read-only plan.
import fs from "node:fs";
import path from "node:path";
import {
  loadServerConfig,
  createLogRedactor,
} from "../server/modules/config/index.mjs";
import { AgentDefinition } from "../server/modules/agents/index.mjs";
import {
  validateLegacyUpgrade,
  recordCompatibility,
} from "../server/modules/agents/upgrade.mjs";
import { openDatabase } from "../server/modules/data/database.mjs";
import { acquireServerLock } from "../server/modules/storage/index.mjs";
const values = {};
let apply = false,
  unlock,
  pool;
let redact = String;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") {
      apply = true;
      continue;
    }
    if (
      !["--from", "--to", "--legacy-definition", "--legacy-tools"].includes(
        args[i],
      ) ||
      !args[i + 1]
    )
      throw new Error(
        "用法：sessions:upgrade -- --from <旧hash> --to <新hash> --legacy-definition <旧配置备份> --legacy-tools <旧tools快照> [--apply]",
      );
    values[args[i].slice(2)] = args[++i];
  }
  if (!values.from || !values.to)
    throw new Error(
      "必须指定 --from 与 --to 描述符 hash；不会批量放行未知版本。",
    );
  if (![values.from, values.to].every((v) => /^[a-f0-9]{64}$/.test(v)))
    throw new Error("描述符 hash 无效。");
  const config = loadServerConfig();
  redact = createLogRedactor(config.launch.env.CODEX_API_KEY, [
    config.data.databaseUrl,
  ]);
  if (apply) unlock = acquireServerLock(config.root);
  const agent = new AgentDefinition(config.root, config.agentFile);
  async function descriptor(hash) {
    if (config.data.databaseUrl) {
      pool ||= await openDatabase(config.data.databaseUrl);
      const scope = JSON.parse(
        fs.readFileSync(path.join(config.root, ".data/identity.json"), "utf8"),
      );
      const row = (
        await pool.query(
          "SELECT descriptor FROM agent_data.agent_versions WHERE instance_id=$1 AND hash=$2",
          [scope.instanceId, hash],
        )
      ).rows[0];
      if (row) return row.descriptor;
    }
    return JSON.parse(
      fs.readFileSync(
        path.join(config.root, ".data/agent-descriptors", hash + ".json"),
      ),
    );
  }
  const previous = await descriptor(values.from),
    current = await descriptor(values.to);
  if (previous.hash !== values.from || current.hash !== values.to)
    throw new Error("描述符记录与指定 hash 不匹配。");
  const result = await validateLegacyUpgrade(previous, current, {
    definitionText:
      values["legacy-definition"] &&
      fs.readFileSync(values["legacy-definition"], "utf8"),
    toolSnapshot: values["legacy-tools"],
    agent,
  });
  if (apply) recordCompatibility(config.root, result.from, result.to);
  console.log(
    JSON.stringify(
      {
        ...result,
        applied: apply,
        note: "只登记精确的兼容映射；不改 Thread、消息、任务或原生 SQLite/JSONL。",
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  unlock?.();
  await pool?.end();
}
