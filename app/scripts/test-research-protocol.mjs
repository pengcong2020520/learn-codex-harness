// Reviewed researcher probes, adapted to this repository. No real provider or business database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { PROJECT_ROOT } from "../shared/paths.mjs";
import { assertResearchResults } from "../tests/research-protocol/assert-results.mjs";
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--cli"))
  throw new Error("Only --cli /path/to/codex.js is supported.");
const cli = path.resolve(
  args[1] || path.join(PROJECT_ROOT, "node_modules/@openai/codex/bin/codex.js"),
);
const version = execFileSync(process.execPath, [cli, "--version"], {
  encoding: "utf8",
  timeout: 10000,
})
  .trim()
  .replace(/^codex-cli /, "");
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "harness-research-protocol-"),
);
const output = path.join(scratch, "reports"),
  home = path.join(scratch, "home");
fs.mkdirSync(output);
fs.mkdirSync(home);
const phases = [
  ["base", "probe.mjs", []],
  ["multi", "probe-multi.mjs", []],
  ["extensions", "probe-ext.mjs", []],
  ["hardened", "probe-ext.mjs", ["--hardened"]],
  ["skills-off", "probe-ext.mjs", ["--hardened", "--disable-skills"]],
];
const summary = {
  version,
  at: new Date().toISOString(),
  passed: false,
  phases: [],
  checks: [],
};
let active,
  stopping = false;
function killGroup(signal = "SIGTERM") {
  if (active) {
    try {
      process.kill(-active.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
function stop() {
  stopping = true;
  killGroup();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  for (const [name, file, options] of phases) {
    if (stopping) throw new Error("Protocol run interrupted");
    console.log(`research protocol: ${name}`);
    const logPath = path.join(scratch, name + ".log"),
      log = fs.openSync(logPath, "w");
    active = spawn(
      process.execPath,
      [
        path.join(PROJECT_ROOT, "tests/research-protocol", file),
        "--cli",
        cli,
        ...options,
      ],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: scratch,
          LANG: "en_US.UTF-8",
          PROTOCOL_REPORT_DIR: output,
        },
      },
    );
    fs.closeSync(log);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
    }, 120000);
    let code;
    try {
      [code] = await once(active, "close");
    } finally {
      clearTimeout(timer);
      killGroup();
      active = null;
    }
    if (code !== 0 || timedOut)
      throw new Error(
        `${name} failed (${timedOut ? "timeout" : code}); log: ${logPath}`,
      );
    summary.phases.push({ name, completed: true });
  }
  summary.checks = assertResearchResults(output, version);
  summary.passed = true;
  console.log(`research protocol: PASS (${summary.checks.length} assertions)`);
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  killGroup();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  const destination = path.join(
    PROJECT_ROOT,
    "docs/verification/research-protocol",
  );
  fs.mkdirSync(destination, { recursive: true });
  // Old researcher records remain in the archive; these files represent local reruns only.
  for (const file of fs.readdirSync(output))
    if (file.endsWith(".json"))
      fs.copyFileSync(path.join(output, file), path.join(destination, file));
  fs.writeFileSync(
    path.join(destination, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  if (summary.passed) fs.rmSync(scratch, { recursive: true, force: true });
  else console.error(`Preserved diagnostic directory: ${scratch}`);
}
