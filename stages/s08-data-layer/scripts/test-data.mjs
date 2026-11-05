// Starts isolated disposable REAL PostgreSQL + Redis. Never reads .env or touches existing services.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-data-integration-"));
const port = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const n = s.address().port;
      s.close(() => resolve(n));
    });
  });
const pgPort = await port(),
  redisPort = await port();
let pgStarted = false,
  redis,
  tests;
try {
  execFileSync(
    "initdb",
    [
      "-D",
      path.join(root, "postgres"),
      "-U",
      "agent_test",
      "--auth=trust",
      "--no-locale",
      "--encoding=UTF8",
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "pg_ctl",
    [
      "-D",
      path.join(root, "postgres"),
      "-l",
      path.join(root, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${pgPort} -k ${root}`,
      "-w",
      "start",
    ],
    { stdio: "pipe" },
  );
  pgStarted = true;
  redis = spawn(
    "redis-server",
    [
      "--bind",
      "127.0.0.1",
      "--port",
      String(redisPort),
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      root,
    ],
    { stdio: "ignore" },
  );
  await new Promise((resolve, reject) => {
    redis.once("error", reject);
    const deadline = Date.now() + 5000;
    const attempt = () => {
      const s = net.connect(redisPort, "127.0.0.1");
      s.once("connect", () => {
        s.destroy();
        resolve();
      });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline)
          reject(new Error("Redis test startup timeout"));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
  tests = spawn(process.execPath, ["--test", "tests/data.integration.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      DATA_TEST_DATABASE_URL: `postgresql://agent_test@127.0.0.1:${pgPort}/postgres`,
      DATA_TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    },
  });
  process.exitCode = await new Promise((resolve) =>
    tests.once("close", (code) => resolve(code ?? 1)),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (redis && redis.exitCode === null) {
    const exited = new Promise((resolve) => redis.once("close", resolve));
    redis.kill("SIGTERM");
    await exited;
  }
  if (pgStarted)
    execFileSync(
      "pg_ctl",
      ["-D", path.join(root, "postgres"), "-m", "fast", "-w", "stop"],
      { stdio: "pipe" },
    );
  // Only this script's mkdtemp directory is removed; failures preserve logs for diagnosis.
  if (!process.exitCode) fs.rmSync(root, { recursive: true });
  else console.error(`临时验收日志已保留：${root}`);
}
