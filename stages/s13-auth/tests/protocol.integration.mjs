// Real installed Codex and actual model-visible payload; the Responses endpoint is a local fixture.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  installedCodex,
  RESTRICTED_FEATURES,
  NATIVE_TOOL_BASELINE,
} from "../server/modules/codex/compatibility.mjs";
import { createLogRedactor } from "../server/modules/config/index.mjs";
import { buildRestrictedLaunch as restricted } from "../server/modules/codex/launch.mjs";
import { prepareRun } from "../server/modules/codex/runtime.mjs";
import { prepareCodexConfig } from "../server/modules/codex/config.mjs";
import { CodexConnection } from "../server/modules/codex/connection.mjs";
import { PermissionGate } from "../server/modules/permissions/index.mjs";
import { tempRoot, cleanup, until } from "./helpers.mjs";
import {
  responsesFixture,
  answer,
  toolCall,
  toolSpecs,
} from "./responses-fixture.mjs";

test(
  "真实协议：Schema、生效开关、工具清单、可信三元组、失败回包、重启恢复",
  { timeout: 60000 },
  async (t) => {
    const root = tempRoot(t),
      installed = installedCodex(),
      schemaDir = path.join(root, "schema");
    execFileSync(
      process.execPath,
      [
        installed.cli,
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
        schemaDir,
      ],
      { stdio: "pipe", timeout: 10000 },
    );
    const schema = JSON.parse(
      fs.readFileSync(path.join(schemaDir, "DynamicToolCallParams.json")),
    );
    for (const key of ["threadId", "turnId", "tool", "arguments", "callId"])
      assert.ok(schema.required.includes(key));
    const agent = {
      definition: { agent: { id: "protocol" } },
      assertCurrent() {},
    };
    const gate = new PermissionGate({
      scope: { ownerId: "protocol-owner" },
      agent,
    });
    cleanup(root, () => gate.close());
    let step = 0;
    const calls = [];
    const provider = await responsesFixture(root, (body) => {
      const names = toolSpecs(body).map((s) => s.name);
      if (step === 0)
        t.diagnostic("Observed tool inventory: " + JSON.stringify(names));
      assert.deepEqual(
        [...names].sort(),
        ["inspect_context", ...NATIVE_TOOL_BASELINE].sort(),
        "model-visible tool inventory changed",
      );
      for (const forbidden of [
        "view_image",
        "exec_command",
        "shell_command",
        "apply_patch",
        "spawn_agent",
        "image_gen",
      ])
        assert.ok(
          !names.some((n) => n === forbidden || n?.endsWith("__" + forbidden)),
          `unexpected native tool ${forbidden}`,
        );
      const spec = toolSpecs(body).find((s) => s.name === "inspect_context");
      assert.ok(spec, "dynamic tool missing");
      if (step++ === 0) return toolCall(spec, { userId: "spoofed" });
      return answer("PROTOCOL_OK");
    });
    const config = {
      root,
      memory: { enabled: false, use: false, generate: false },
      launch: restricted({
        PATH: process.env.PATH,
        CODEX_API_KEY: "fixture-only",
        CODEX_BASE_URL: provider.url,
        CODEX_MODEL: "protocol-model",
        CODEX_MODEL_CATALOG_ENABLED: "true",
        CODEX_MODEL_CONTEXT_WINDOW: "128000",
        DEMO_TIMEOUT_MS: "10000",
      }),
    };
    prepareCodexConfig(config, {});
    let rpc,
      completed = [];
    const open = async () => {
      const runtime = await prepareRun(config.launch, root);
      rpc = new CodexConnection({
        launch: config.launch,
        runtime,
        redact: createLogRedactor("fixture-only"),
        log: () => {},
      });
      rpc.on("notification", (m) => {
        if (m.method === "turn/started")
          gate.started(m.params.threadId, m.params.turn.id);
        if (m.method === "turn/completed") {
          completed.push(m.params.turn);
          gate.end(m.params.threadId, m.params.turn.id);
        }
      });
      rpc.toolHandler = async (p) => {
        const ctx = gate.forTurn(p.threadId, p.turnId);
        calls.push({
          userId: ctx.userId,
          threadId: ctx.threadId,
          turnId: ctx.turnId,
        });
        assert.notEqual(ctx.userId, p.arguments.userId);
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "intentional protocol fixture rejection",
            },
          ],
        };
      };
      await rpc.open();
      assert.equal(rpc.capabilities.verified, true);
      assert.deepEqual(
        rpc.capabilities.restrictedFeatures,
        RESTRICTED_FEATURES,
      );
      return runtime;
    };
    cleanup(root, () => rpc?.close());
    const runtime = await open();
    const options = {
      cwd: runtime.workspaceDir,
      sandbox: "read-only",
      approvalPolicy: "never",
      model: "protocol-model",
      modelProvider: "project_api",
    };
    const { thread } = await rpc.request("thread/start", {
      ...options,
      dynamicTools: [
        {
          type: "function",
          name: "inspect_context",
          description: "Protocol fixture",
          inputSchema: {
            type: "object",
            properties: { userId: { type: "string" } },
            required: ["userId"],
            additionalProperties: false,
          },
        },
      ],
    });
    gate.start({ id: "one", threadId: thread.id });
    const first = await rpc.request("turn/start", {
      threadId: thread.id,
      input: [
        { type: "text", text: "Run protocol fixture", text_elements: [] },
      ],
    });
    await until(() => {
      assert.deepEqual(provider.errors, []);
      return completed.length === 1;
    }, 15000);
    assert.equal(completed[0].status, "completed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].turnId, first.turn.id);
    assert.throws(() => gate.forTurn(thread.id, first.turn.id), /未授权/);
    await rpc.close();
    await open();
    const resumed = await rpc.request("thread/resume", {
      ...options,
      threadId: thread.id,
    });
    assert.equal(resumed.thread.id, thread.id);
    assert.ok(resumed.thread.turns.length);
    gate.start({ id: "two", threadId: thread.id });
    await rpc.request("turn/start", {
      threadId: thread.id,
      input: [
        { type: "text", text: "Continue protocol fixture", text_elements: [] },
      ],
    });
    await until(() => completed.length === 2, 15000);
    assert.equal(completed[1].status, "completed");
    assert.deepEqual(provider.errors, []);
  },
);
