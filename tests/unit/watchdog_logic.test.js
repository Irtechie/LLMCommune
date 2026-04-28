import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createWatchdog } from "../../src/watchdog.js";
import {
  defaultDesiredState,
  planWatchdogActions,
  watchdogEnabledForDesiredState,
} from "../../src/watchdog_logic.js";
import { repoRoot, writeJsonReport } from "../support/catalog.js";

const unitReportPath = path.join(repoRoot, "workspace", "test-reports", "unit-watchdog.json");
const unitResults = [];

function recordResult(name, status, detail = "") {
  unitResults.push({ name, status, detail });
}

function trackedTest(name, fn) {
  test(name, async (t) => {
    try {
      await fn(t);
      recordResult(name, "passed");
    } catch (error) {
      recordResult(name, "failed", String(error?.message || error));
      throw error;
    }
  });
}

trackedTest("watchdog only enforces ready or running desired state", async () => {
  assert.equal(watchdogEnabledForDesiredState(defaultDesiredState()), false);
  assert.equal(
    watchdogEnabledForDesiredState({
      ...defaultDesiredState(),
      watchdog_enforce: true,
      state: "ready",
    }),
    true,
  );
  assert.equal(
    watchdogEnabledForDesiredState({
      ...defaultDesiredState(),
      watchdog_enforce: true,
      state: "running",
    }),
    true,
  );
  assert.equal(
    watchdogEnabledForDesiredState({
      ...defaultDesiredState(),
      watchdog_enforce: true,
      state: "starting",
    }),
    false,
  );
  assert.equal(
    watchdogEnabledForDesiredState({
      ...defaultDesiredState(),
      watchdog_enforce: true,
      state: "stopping",
    }),
    false,
  );
});

trackedTest("watchdog action planning restores only the lanes or fleet that should be up", async () => {
  const fleetActions = planWatchdogActions({
    desiredState: {
      ...defaultDesiredState(),
      watchdog_enforce: true,
      state: "ready",
      mode: "fleet",
      fleet_id: "mini_qwen30_deepseek32",
    },
    currentState: {
      mini_fleet: { up: false },
    },
  });
  assert.equal(fleetActions.length, 1);
  assert.equal(fleetActions[0].pathName, "/fleet/up");

  const laneActions = planWatchdogActions({
    desiredState: {
      ...defaultDesiredState(),
      watchdog_enforce: true,
      state: "ready",
      mode: "lane",
      lane_targets: {
        large: "trt_dual_gpt_oss_120b_large",
        mini: "trt_single_qwen3_30b_a3b_mini",
      },
    },
    currentState: {
      lanes: {
        large: { up: false, profile_id: "" },
        mini: { up: true, profile_id: "wrong-profile" },
      },
      mini_fleet: { up: false },
    },
  });
  assert.deepEqual(
    laneActions.map((action) => action.pathName),
    ["/api/llm-host/activate", "/api/llm-host/activate"],
  );
  assert.deepEqual(
    laneActions.map((action) => action.payload.profile_id),
    ["trt_dual_gpt_oss_120b_large", "trt_single_qwen3_30b_a3b_mini"],
  );
});

trackedTest("watchdog prefers activation-set restore when desired state carries active_set_id", async () => {
  const actions = planWatchdogActions({
    desiredState: {
      ...defaultDesiredState(),
      watchdog_enforce: true,
      state: "ready",
      mode: "lane",
      active_set_id: "gamenator_qwen",
      lane_targets: {
        large: "gguf_qwen36_35b_large",
        mini: "gguf_gemma4_26b_a4b_mini",
      },
    },
    currentState: {
      lanes: {
        large: { up: false, profile_id: "" },
        mini: { up: false, profile_id: "" },
      },
      mini_fleet: { up: false },
    },
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].pathName, "/api/llm-host/activate-set");
  assert.equal(actions[0].payload.set_id, "gamenator_qwen");
});

trackedTest("watchdog action planning respects controller blocked action policy", async () => {
  const actions = planWatchdogActions({
    desiredState: {
      ...defaultDesiredState(),
      watchdog_enforce: true,
      state: "ready",
      mode: "lane",
      active_set_id: "qwen235",
      lane_targets: {
        large: "trt_dual_qwen235_large",
        mini: "",
      },
    },
    currentState: {
      lanes: {
        large: { up: false, profile_id: "" },
        mini: { up: false, profile_id: "" },
      },
      mini_fleet: { up: false },
      swap: {
        action_policy_state: "reconcile_needed",
        reconcile_needed: true,
        allowed_actions: ["stop", "fleet_down"],
        blocked_actions: [
          { action: "activate_set" },
          { action: "activate" },
          { action: "fleet_up" },
        ],
      },
    },
  });

  assert.equal(actions.length, 0);
});

trackedTest("watchdog reconcile skips lane restore when desired state is not enforceable", async () => {
  const postCalls = [];
  const watchdog = createWatchdog({
    repoRoot,
    dependencies: {
      controllerHealthy: async () => true,
      readJson: async () => ({
        ...defaultDesiredState(),
        state: "starting",
        watchdog_enforce: true,
        lane_targets: {
          large: "trt_dual_qwen235_large",
          mini: "",
        },
      }),
      fetchJson: async (url) => {
        if (url.endsWith("/api/llm-host/current")) {
          return {
            ok: true,
            status: 200,
            body: {
              lanes: {
                large: { up: false, profile_id: "" },
                mini: { up: false, profile_id: "" },
              },
              mini_fleet: { up: false },
            },
          };
        }
        return { ok: true, status: 200, body: { ok: true } };
      },
      postJson: async (url, payload) => {
        postCalls.push({ url, payload });
        return { ok: true, status: 202, body: { ok: true } };
      },
      writeFile: async () => {},
      mkdir: async () => {},
      rm: async () => {},
    },
  });

  const actions = await watchdog.reconcileDesiredState();
  assert.equal(actions.length, 0);
  assert.equal(postCalls.length, 0);
});

trackedTest("watchdog reconcile skips restore when controller swap policy blocks activation", async () => {
  const postCalls = [];
  const watchdog = createWatchdog({
    repoRoot,
    dependencies: {
      controllerHealthy: async () => true,
      readJson: async () => ({
        ...defaultDesiredState(),
        state: "ready",
        watchdog_enforce: true,
        active_set_id: "qwen235",
        lane_targets: {
          large: "trt_dual_qwen235_large",
          mini: "",
        },
      }),
      fetchJson: async (url) => {
        if (url.endsWith("/api/llm-host/current")) {
          return {
            ok: true,
            status: 200,
            body: {
              lanes: {
                large: { up: false, profile_id: "" },
                mini: { up: false, profile_id: "" },
              },
              mini_fleet: { up: false },
              swap: {
                action_policy_state: "reconcile_needed",
                reconcile_needed: true,
                allowed_actions: ["stop", "fleet_down"],
                blocked_actions: [
                  { action: "activate_set" },
                  { action: "activate" },
                ],
              },
            },
          };
        }
        return { ok: true, status: 200, body: { ok: true } };
      },
      postJson: async (url, payload) => {
        postCalls.push({ url, payload });
        return { ok: true, status: 202, body: { ok: true } };
      },
      writeFile: async () => {},
      mkdir: async () => {},
      rm: async () => {},
    },
  });

  const actions = await watchdog.reconcileDesiredState();
  assert.equal(actions.length, 0);
  assert.equal(postCalls.length, 0);
});

trackedTest("watchdog reconcile restores the intended activation set when the controller says it is down", async () => {
  const postCalls = [];
  const watchdog = createWatchdog({
    repoRoot,
    dependencies: {
      controllerHealthy: async () => true,
      readJson: async () => ({
        ...defaultDesiredState(),
        state: "ready",
        watchdog_enforce: true,
        active_set_id: "gptoss120",
        lane_targets: {
          large: "gguf_gptoss120b_large",
          mini: "",
        },
      }),
      fetchJson: async (url) => {
        if (url.endsWith("/api/llm-host/current")) {
          return {
            ok: true,
            status: 200,
            body: {
              lanes: {
                large: { up: false, profile_id: "" },
                mini: { up: false, profile_id: "" },
              },
              mini_fleet: { up: false },
            },
          };
        }
        return { ok: true, status: 200, body: { ok: true } };
      },
      postJson: async (url, payload) => {
        postCalls.push({ url, payload });
        return { ok: true, status: 202, body: { ok: true } };
      },
      writeFile: async () => {},
      mkdir: async () => {},
      rm: async () => {},
      nowMs: (() => {
        let current = 40_000;
        return () => {
          current += 1_000;
          return current;
        };
      })(),
    },
  });

  const actions = await watchdog.reconcileDesiredState();
  assert.equal(actions.length, 1);
  assert.equal(postCalls.length, 1);
  assert.match(postCalls[0].url, /\/api\/llm-host\/activate-set$/);
  assert.equal(postCalls[0].payload.set_id, "gptoss120");
});

after(async () => {
  await writeJsonReport(unitReportPath, {
    generated_at: new Date().toISOString(),
    suite: "unit-watchdog",
    results: unitResults,
    passed: unitResults.filter((entry) => entry.status === "passed").length,
    failed: unitResults.filter((entry) => entry.status === "failed").length,
  });
});
