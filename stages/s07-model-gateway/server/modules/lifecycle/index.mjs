import { unlinkSync } from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../storage/index.mjs";

export function createLifecycle() {
  const cleanup = [];
  let closing;
  return {
    defer(action) { cleanup.push(action); },
    close() {
      closing ||= (async () => {
        const failures = [];
        for (const action of cleanup.reverse()) { try { await action(); } catch (error) { failures.push(error); } }
        if (failures.length) throw new AggregateError(failures, "部分资源未能正常关闭。");
      })();
      return closing;
    }
  };
}

export function publishConnection(root, connection, lifecycle) {
  const file = path.join(root, ".data", "connection.json");
  writeJson(file, connection);
  lifecycle.defer(() => { if (readJson(file, null)?.token === connection.token) unlinkSync(file); });
}
