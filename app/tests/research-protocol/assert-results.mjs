import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
export function assertResearchResults(directory, version) {
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(directory, name)));
  const base = read(`results-${version}.json`).tests,
    multi = read(`results-multi-${version}.json`).tests;
  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push(name);
    } catch (error) {
      throw new Error(`${name}: ${error.message}`);
    }
  };
  check("registered dynamic tools; no native execution/image bypass", () => {
    assert.equal(base.s1_s5_registered_tools.dynamicToolsVisible, true);
    assert.deepEqual(base.s1_s5_registered_tools.nativeExecOrPatch, []);
  });
  check("20 turns: identity gate, ordering and unique call IDs", () => {
    const r = base.s2_ordering_gate;
    assert.equal(r.gateAllowed, 20);
    assert.equal(r.gateDenied, 0);
    assert.equal(r.toolCallBeforeTurnStarted, 0);
    assert.equal(r.duplicateCallIdDeliveries, 0);
    assert.deepEqual(r.statuses, ["completed"]);
  });
  check("30-second cooperative timeout returns to model", () => {
    const r = base.s3a_tool_timeout_respects_signal;
    assert.ok(r.abortedAfterMs >= 29000 && r.abortedAfterMs < 40000);
    assert.equal(r.turnStatus, "completed");
    assert.match(JSON.stringify(r.modelSawOutput), /超时/);
  });
  check("uncooperative handler timeout and late rejection stay bounded", () => {
    const r = base.s3c_timeout_ignores_signal;
    assert.equal(r.turnStatus, "completed");
    assert.ok(r.elapsedMs < 5000);
    assert.match(JSON.stringify(r.modelSawOutput), /超时/);
    assert.equal(r.connectionFailure, null);
  });
  check("interrupt suppresses late result; connection can continue", () => {
    const r = base.s3b_interrupt_with_hung_tool;
    assert.equal(r.turnStatus, "interrupted");
    assert.equal(r.handlerCalls, 1);
    assert.equal(r.modelRequestsAfterLateReply, 0);
    assert.equal(r.connectionFailure, null);
    assert.equal(r.nextTurnOnSameThread, "completed");
    assert.deepEqual(r.lateReplyProtocolTail, []);
  });
  check(
    "0.154 dynamicTools remain immutable on resume; deleted tool is rejected",
    () => {
      const r = base.s4_deleted_tool_on_resumed_thread;
      assert.equal(r.resumeWithNewDynamicToolsError, null);
      assert.equal(r.legacyStillVisible, true);
      assert.equal(r.newToolVisibleAfterResume, false);
      assert.deepEqual(r.handlerSaw, ["legacy_tool"]);
      assert.match(JSON.stringify(r.modelSawToolOutput), /不在允许范围/);
      assert.equal(r.turnStatus, "completed");
    },
  );
  check(
    "raw shared-process probe reproduces broadcast and missing user isolation",
    () => {
      const r = multi.s6_multi_connection;
      assert.equal(Boolean(r.sameRequestIdBroadcast), true);
      assert.equal(r.otherUserC_threadListContainsA, true);
      assert.match(r.otherUserC_threadRead, /可以读取/);
      assert.match(r.otherUserC_threadResume, /可以订阅/);
      assert.match(JSON.stringify(r.modelGotOutput), /reply-from-B/);
      assert.equal(r.secondTurnAfterBDisconnect, "completed");
    },
  );
  check(
    "process-cost observations are complete, without asserting hardware-specific limits",
    () => {
      const r = multi.s7_process_per_user_cost;
      assert.equal(r.each.length, 4);
      assert.ok(
        r.each.every(
          (p) => p.openMs >= 0 && p.threadStartMs >= 0 && p.rssMb > 0,
        ),
      );
    },
  );
  check(
    "MCP configuration reload changes old Thread tools; removed tool is rejected",
    () => {
      const r = multi.s8_mcp_hot_reload;
      assert.ok(r.turn1_initial.hubTools.some((n) => n.includes("hub_alpha")));
      assert.ok(
        r.turn3b_sameThread_afterConfigChange.hubTools.some((n) =>
          n.includes("hub_beta"),
        ),
      );
      assert.ok(
        !r.turn3b_sameThread_afterConfigChange.hubTools.some((n) =>
          n.includes("hub_alpha"),
        ),
      );
      assert.equal(r.sameThread_callRemovedTool.status, "completed");
      assert.match(
        JSON.stringify(r.sameThread_callRemovedTool.modelSawOutput),
        /unsupported|removed/i,
      );
    },
  );
  for (const suffix of ["", "-hardened", "-hardened-skills-off"])
    check(`extension isolation ${suffix || "production defaults"}`, () => {
      const r = read(`results-ext-${version}${suffix}.json`);
      assert.equal(r.turnStatus, "completed");
      assert.equal(r.dynamicToolHandlerCalls, 1);
      assert.deepEqual(r.hookMarkersWritten, []);
      assert.ok(Array.isArray(r.hooksList.data) && r.hooksList.data.length);
      for (const entry of r.hooksList.data) { assert.deepEqual(entry.hooks, []); assert.deepEqual(entry.errors, []); }
      assert.deepEqual(r.pluginList.marketplaces, []);
      assert.deepEqual(r.pluginInstalled.marketplaces, []);
      assert.ok(
        r.launchArgs.includes("features.hooks=false") &&
          r.launchArgs.includes("features.plugins=false"),
      );
      assert.ok(!r.modelSawTools.some((n) => /plugin_tool|view_image/.test(n)));
      assert.ok(!JSON.stringify(r.pluginList).includes("leak-market"));
      if (suffix.endsWith("skills-off")) {
        assert.deepEqual(r.modelContextMentions, []);
        assert.ok(r.skillsAfterDisable.every((s) => s.endsWith(":false")));
      } else
        for (const name of ["home-skill", "workspace-skill", "codexhome-skill"])
          assert.ok(r.modelContextMentions.includes(name));
    });
  return checks;
}
