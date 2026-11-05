// Starts isolated disposable PostgreSQL + Redis. --real-smoke explicitly enables a real-model child; default suites remain offline.
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
  tests, chroma;
const withRag = process.argv.includes("--rag");
let chromaUrl;
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
  if (withRag) {
    const chromaPort = await port();
    chromaUrl = `http://127.0.0.1:${chromaPort}`;
    const output = fs.openSync(path.join(root, 'chroma.log'), 'a');
    chroma = spawn(process.env.CHROMA_TEST_BIN || 'chroma', ['run', '--path', path.join(root, 'chroma'), '--host', '127.0.0.1', '--port', String(chromaPort)],
      { stdio: ['ignore', output, output], env: { ...process.env, ANONYMIZED_TELEMETRY: 'False' } });
    fs.closeSync(output);
    let failure;
    chroma.on('error', error => { failure = error; });
    const deadline = Date.now() + 45000;
    for (;;) {
      if (failure) throw failure;
      if (chroma.exitCode !== null) throw new Error('临时 Chroma 启动失败。');
      try { if ((await fetch(chromaUrl + '/api/v2/heartbeat', {signal: AbortSignal.timeout(1000)})).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error('临时 Chroma 启动超时。');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  tests = spawn(process.execPath, process.argv.includes("--real-smoke") ? ["scripts/real-smoke.mjs"] : ["--test", "--test-concurrency=1", "tests/data.integration.mjs", "tests/knowledge.integration.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      CHROMA_TEST_URL: chromaUrl || "",
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
  if (chroma && chroma.exitCode === null) {
    const exited = new Promise(resolve => chroma.once('close', resolve));
    chroma.kill('SIGTERM'); await exited;
  }
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
