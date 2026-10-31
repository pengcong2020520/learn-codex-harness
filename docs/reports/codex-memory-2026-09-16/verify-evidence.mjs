// Read-only source assertions, NOT Rust unit tests or an end-to-end memory test.
// Usage: node verify-evidence.mjs RELEASE_REPO CURRENT_REPO GENERATED_SCHEMA_DIR PROJECT_DIR
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const [release, current, schema, project] = process.argv.slice(2);
if (![release, current, schema, project].every(Boolean)) {
  throw new Error("Expected RELEASE_REPO CURRENT_REPO GENERATED_SCHEMA_DIR PROJECT_DIR");
}
const read = (root, file) => readFileSync(join(root, file), "utf8");
const checks = [];
function check(name, pass) { checks.push({ name, passed: Boolean(pass) }); }
for (const [label, root] of [["release", release], ["current", current]]) {
  const cfg = read(root, "codex-rs/config/src/types.rs");
  for (const [name, value] of [
    ["MAX_ROLLOUTS_PER_STARTUP", 2], ["MAX_ROLLOUT_AGE_DAYS", 10],
    ["MIN_ROLLOUT_IDLE_HOURS", 6], ["MIN_RATE_LIMIT_REMAINING_PERCENT", 25],
    ["MAX_RAW_MEMORIES_FOR_CONSOLIDATION", 256], ["MAX_UNUSED_DAYS", 30],
  ]) check(`${label}: default ${name}=${value}`,
    new RegExp(`DEFAULT_MEMORIES_${name}: \\w+ = ${value};`).test(cfg));
  const features = read(root, "codex-rs/features/src/lib.rs");
  check(`${label}: memory feature defaults off`, /id: Feature::MemoryTool,[\s\S]*?default_enabled: false/.test(features));
  check(`${label}: read/write on but dedicated tools off after feature enabled`,
    cfg.includes("generate_memories: true") && cfg.includes("use_memories: true") && cfg.includes("dedicated_tools: false"));
  const rollout = read(root, "codex-rs/rollout/src/lib.rs");
  const allowed = rollout.match(/INTERACTIVE_SESSION_SOURCES[\s\S]*?\n\}\);/)?.[0] ?? "";
  check(`${label}: automatic candidates exclude Exec source`,
    allowed.includes("SessionSource::Cli") && allowed.includes("SessionSource::VSCode") && !allowed.includes("SessionSource::Exec"));
  check(`${label}: exec uses Exec source`, read(root, "codex-rs/exec/src/lib.rs").includes("session_source: SessionSource::Exec"));
  const extension = read(root, "codex-rs/ext/memories/src/extension.rs");
  check(`${label}: memory reading has feature/use gate`, extension.includes("Feature::MemoryTool) && config.memories.use_memories"));
  check(`${label}: dedicated tools are separately gated`, extension.includes("!config.enabled || !config.dedicated_tools"));
  check(`${label}: startup excludes ephemeral and subagents`,
    /config.ephemeral[\s\S]*?Feature::MemoryTool[\s\S]*?source.is_non_root_agent\(\)/.test(read(root, "codex-rs/memories/write/src/start.rs")));
  check(`${label}: summary injection token cap 2500`,
    read(root, "codex-rs/ext/memories/src/lib.rs").includes("SUMMARY_TOKEN_LIMIT: usize = 2_500"));
  check(`${label}: database selection requires enabled memory mode`,
    read(root, "codex-rs/state/src/runtime/memories.rs").includes("threads.memory_mode = 'enabled'"));
  check(`${label}: dedicated search uses text contains`,
    read(root, "codex-rs/ext/memories/src/local/search.rs").includes("line.as_ref().contains(query)"));
  check(`${label}: ad-hoc note creates new file without overwrite`,
    read(root, "codex-rs/ext/memories/src/local/ad_hoc_note.rs").includes("create_new(true)"));
  check(`${label}: actual caller triggers on newly started nonempty turn`,
    /if turn_has_input && started \{[\s\S]*?is_primary_environment_configured\(\)[\s\S]*?start_memories_startup_task/.test(read(root, "codex-rs/app-server/src/request_processors/turn_processor.rs")));
  check(`${label}: TUI settings persist use/generate config`,
    read(root, "codex-rs/tui/src/config_update.rs").includes('replace_config_value("memories.use_memories"') &&
    read(root, "codex-rs/tui/src/app/config_persistence.rs").includes("crate::config_update::write_config_batch"));
  check(`${label}: TUI generation setting also updates current thread`,
    read(root, "codex-rs/tui/src/app/config_persistence.rs").includes("app_server.thread_memory_mode_set(thread_id, mode).await"));
}
check("release: no memory version config", !read(release, "codex-rs/config/src/types.rs").includes("pub version: Option<MemoryVersion>"));
check("current: memory version defaults V1", read(current, "codex-rs/config/src/types.rs").includes("version: MemoryVersion::V1"));
check("current: V2 directory is memories_v2", read(current, "codex-rs/protocol/src/memory_version.rs").includes('Self::V2 => "memories_v2"'));
check("current: V2 summary still uses v1 format marker", read(current, "codex-rs/memories/write/src/workspace.rs").includes('summary.lines().next() == Some("v1")'));
check("current: memory/status is experimental", /experimental\("memory\/status"\)/.test(read(current, "codex-rs/app-server-protocol/src/protocol/common.rs")));
const methods = read(schema, "ClientRequest.json");
check("installed binary schema: thread/memoryMode/set present", methods.includes('"thread/memoryMode/set"'));
check("installed binary schema: memory/reset present", methods.includes('"memory/reset"'));
check("installed binary schema: memory/status absent", !methods.includes('"memory/status"'));
const pkg = JSON.parse(read(project, "package.json"));
check("project: CLI and TS SDK pinned 0.154.0", pkg.dependencies["@openai/codex"] === "0.154.0" && pkg.dependencies["@openai/codex-sdk"] === "0.154.0");
check("installed TS SDK invokes exec", read(project, "node_modules/@openai/codex-sdk/dist/index.js").includes('["exec", "--experimental-json"]'));
const result = {
  scope: "Read-only static source assertions and schema exported by installed binary; no LLM memory execution, no Rust test execution, no personal memory access.",
  releaseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: release, encoding: "utf8" }).trim(),
  currentCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: current, encoding: "utf8" }).trim(),
  passed: checks.filter(c => c.passed).length, total: checks.length, checks,
};
console.log(JSON.stringify(result, null, 2));
if (checks.some(c => !c.passed)) process.exitCode = 1;
