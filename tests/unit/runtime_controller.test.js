import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRuntime } from "../../src/runtime.js";
import { createServer } from "../../src/index.js";
import { buildCatalog, loadModelsConfig, repoRoot, writeJsonReport } from "../support/catalog.js";
import { createRepoFixture, seedDesiredState, seedLaneSlot } from "../support/fixture.js";

const unitReportPath = path.join(repoRoot, "workspace", "test-reports", "unit-runtime-controller.json");
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

function createProbeStub(sequence = {}) {
  const state = new Map(Object.entries(sequence));
  return async function probeRuntime(baseUrl) {
    const current = state.get(baseUrl);
    if (typeof current === "function") {
      return current();
    }
    if (Array.isArray(current) && current.length > 0) {
      return current.shift();
    }
    return current || { up: false, model_ids: [], raw: null };
  };
}

function isWorkerContainerInspection(command) {
  return command.includes("docker ps --format") && command.includes("admin@192.168.1.204");
}

async function startTestServer(runtime) {
  const server = createServer({ runtime, defaultHost: "127.0.0.1:0" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

trackedTest("catalog discovers all curated profiles and loader chains", async () => {
  const config = await loadModelsConfig();
  const catalog = await buildCatalog();

  assert.equal(catalog.profiles.length, config.profiles.length);
  assert.equal(catalog.fleets.length, config.fleet_profiles.length);
  assert.equal(catalog.candidates.length, config.candidate_models.length);
  assert.ok(catalog.profiles.every((profile) => profile.launch_script_exists));
  assert.ok(catalog.profiles.every((profile) => profile.loader_chain.length >= 1));

  const coder = catalog.profiles.find((profile) => profile.profile_id === "gguf_coder_next_large");
  const qwen30 = catalog.profiles.find((profile) => profile.profile_id === "trt_single_qwen3_30b_a3b_mini");
  const qwen235 = catalog.profiles.find((profile) => profile.profile_id === "trt_dual_qwen235_large");
  assert.ok(coder.loader_chain.some((entry) => entry.endsWith("launch_gguf_lane.sh")));
  assert.ok(qwen30.loader_chain.some((entry) => entry.endsWith("run_single_spark_trtllm_common.sh")));
  assert.ok(qwen235.loader_chain.some((entry) => entry.endsWith("run_dual_spark_trtllm_common.sh")));
});

trackedTest("activate returns ready immediately for an already-active profile", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    await seedLaneSlot(fixture.repoRoot, "large", {
      profile_id: "gguf_coder_next_large",
      slot_label: "gguf_coder_next_large",
      model_spec: "/mnt/models/other/Qwen3-Coder-Next-Q4_K_M/files/Qwen3-Coder-Next-Q4_K_M.gguf",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["Qwen3-Coder-Next-Q4_K_M.gguf"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999/": { up: false, model_ids: [], raw: null },
        }),
        uuid: () => "job-already-active",
      },
    });

    const result = await runtime.activate({
      profileId: "gguf_coder_next_large",
      laneId: "large",
      wait: true,
    });

    assert.equal(result.status, "ready");
    assert.match(result.status_detail, /already active/i);
    assert.equal(commands.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("activate returns ready for an already-active manual_only_restore profile", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    await seedLaneSlot(fixture.repoRoot, "large", {
      profile_id: "trt_dual_qwen235_large",
      slot_label: "trt_dual_qwen235_large",
      model_spec: "/mnt/models/nvidia/Qwen3-235B-A22B-NVFP4/files",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        uuid: () => "job-already-active-manual-restore",
      },
    });

    const result = await runtime.activate({
      profileId: "trt_dual_qwen235_large",
      laneId: "large",
      wait: true,
    });

    assert.equal(result.status, "ready");
    assert.match(result.status_detail, /already active/i);
    assert.equal(result.code, undefined);
    assert.equal(commands.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("stop supersedes a queued activation-set before TRT launch", async () => {
  const fixture = await createRepoFixture();
  let runtime;
  let launchCount = 0;
  let stopTriggered = false;
  try {
    runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (command.includes("run_dual_spark_trtllm_qwen235.sh")) {
            launchCount += 1;
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        sleep: async () => {
          if (!stopTriggered) {
            stopTriggered = true;
            await runtime.stopLane("all");
          }
        },
      },
    });

    const result = await runtime.activateSet({ setId: "qwen235", wait: true });

    assert.equal(result.status, "failed");
    assert.equal(result.code, "ACTIVATION_SUPERSEDED");
    assert.equal(launchCount, 0);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("legacy inferno alias resolves to gemma431 solo set", async () => {
  const fixture = await createRepoFixture();
  try {
    await seedDesiredState(fixture.repoRoot, {
      mode: "lane",
      state: "idle",
      watchdog_enforce: false,
      lane_targets: { large: "", mini: "" },
      fleet_id: "",
      active_set_id: "",
      status_detail: "",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["google/gemma-4-31b-it"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const result = await runtime.activateSet({ setId: "inferno", wait: true });

    assert.equal(result.status, "ready");
    assert.equal(result.requested_profile_id, "gemma431");

    const current = await runtime.getCurrent();
    assert.equal(current.desired_state.active_set_id, "gemma431");
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("generic activate resolves active_set_id from lane targets", async () => {
  const fixture = await createRepoFixture();
  try {
    await seedDesiredState(fixture.repoRoot, {
      mode: "lane",
      state: "ready",
      watchdog_enforce: true,
      lane_targets: {
        large: "gguf_qwen36_35b_large",
        mini: "gguf_gemma4_26b_a4b_mini",
      },
      fleet_id: "",
      active_set_id: "gamenator_qwen",
      status_detail: "stale combo state",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["gpt-oss-120b-Q4_K_M-00001-of-00002.gguf"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const result = await runtime.activate({ profileId: "gguf_gptoss120b_large", laneId: "large", wait: true });

    assert.equal(result.status, "ready");

    const current = await runtime.getCurrent();
    assert.equal(current.desired_state.active_set_id, "gptoss120");
    assert.equal(current.desired_state.lane_targets.large, "gguf_gptoss120b_large");
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("different activation set supersedes in-flight activation when preempt is allowed", async () => {
  const fixture = await createRepoFixture();
  let releaseLaunch;
  const blockedLaunch = new Promise((resolve) => { releaseLaunch = resolve; });
  try {
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (command.includes("run_dual_spark_trtllm_qwen235.sh")) {
            await blockedLaunch;
            return { ok: false, stdout: "", stderr: "superseded" };
          }
          if (command.includes("stop_large_lane.sh")) {
            releaseLaunch();
            return { ok: true, stdout: "", stderr: "" };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["qwen/Qwen3-Next-80B-A3B-Instruct-Q4_K_M"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const first = await runtime.activateSet({ setId: "qwen235", wait: false });
    const second = await runtime.activateSet({ setId: "qwen80next", wait: true, allowPreempt: true });
    const firstJob = await runtime.getJob(first.job_id);
    const current = await runtime.getCurrent();

    assert.ok(["ready", "skipped"].includes(second.status));
    assert.equal(second.status === "skipped" ? second.set_id : second.requested_profile_id, "qwen80next");
    assert.equal(firstJob.status, "failed");
    assert.equal(firstJob.code, "ACTIVATION_SUPERSEDED");
    assert.equal(firstJob.swap_id, first.job_id);
    assert.ok(firstJob.controller_epoch);
    assert.equal(current.desired_state.active_set_id, "qwen80next");
    assert.equal(current.swap.requested_set_id, "qwen80next");
    assert.equal(current.swap.terminal_state, "ready");
  } finally {
    releaseLaunch?.();
    await fixture.cleanup();
  }
});

trackedTest("different activation set conflict returns authoritative swap metadata when preempt is disabled", async () => {
  const fixture = await createRepoFixture();
  let releaseLaunch;
  let launchReleased = false;
  const blockedLaunch = new Promise((resolve) => {
    releaseLaunch = () => {
      launchReleased = true;
      resolve();
    };
  });
  try {
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (command.includes("run_dual_spark_trtllm_qwen235.sh")) {
            await blockedLaunch;
            return { ok: true, stdout: "", stderr: "" };
          }
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: async (baseUrl) => {
          if (baseUrl === "http://127.0.0.1:8000") {
            return launchReleased
              ? { up: true, model_ids: ["nvidia/Qwen3-235B-A22B-NVFP4"], raw: {} }
              : { up: false, model_ids: [], raw: null };
          }
          return { up: false, model_ids: [], raw: null };
        },
        sleep: async () => {},
        uuid: (() => {
          let count = 0;
          return () => `job-conflict-${++count}`;
        })(),
      },
    });

    const first = await runtime.activateSet({ setId: "qwen235", wait: false });
    const second = await runtime.activateSet({ setId: "qwen80next", wait: false, allowPreempt: false });

    assert.equal(second.accepted, false);
    assert.equal(second.code, "CONCURRENT_ACTIVATION");
    assert.equal(second.swap_id, first.job_id);
    assert.equal(second.current_job_id, first.job_id);
    assert.equal(second.active_set_id, "qwen235");
    assert.ok(second.controller_epoch);
    assert.equal(typeof second.controller_revision, "number");
    assert.equal(second.swap_terminal_state, "");
    assert.ok(["preflight", "starting"].includes(String(second.swap_state || "")));

    releaseLaunch?.();

    let firstJob = await runtime.getJob(first.job_id);
    for (let attempt = 0; attempt < 20 && firstJob?.status !== "ready"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      firstJob = await runtime.getJob(first.job_id);
    }
    assert.equal(firstJob?.status, "ready");
  } finally {
    releaseLaunch?.();
    await fixture.cleanup();
  }
});

trackedTest("activateSet rejects stale ready transition when swap revision has advanced", async () => {
  const fixture = await createRepoFixture();
  let releaseLaunch;
  let launchReleased = false;
  const blockedLaunch = new Promise((resolve) => {
    releaseLaunch = () => {
      launchReleased = true;
      resolve();
    };
  });
  try {
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (command.includes("run_dual_spark_trtllm_qwen235.sh")) {
            await blockedLaunch;
            return { ok: true, stdout: "", stderr: "" };
          }
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: async (baseUrl) => {
          if (baseUrl === "http://127.0.0.1:8000") {
            return launchReleased
              ? { up: true, model_ids: ["nvidia/Qwen3-235B-A22B-NVFP4"], raw: {} }
              : { up: false, model_ids: [], raw: null };
          }
          return { up: false, model_ids: [], raw: null };
        },
        sleep: async () => {},
        uuid: (() => {
          let count = 0;
          return () => `job-revision-fence-${++count}`;
        })(),
      },
    });

    const first = await runtime.activateSet({ setId: "qwen235", wait: false });

    await writeFile(
      path.join(fixture.repoRoot, "workspace", "runtime", "swap_manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        summary_version: 1,
        controller_epoch: "swap-epoch-test",
        controller_revision: 99,
        last_committed_event_seq: 99,
        runtime_incarnation_id: "runtime-test",
        swap_id: "other-swap",
        current_job_id: "other-job",
        requested_set_id: "qwen80next",
        canonical_set_id: "qwen80next",
        requested_generation: 1,
        observed_generation: 1,
        state: "starting",
        terminal_state: "",
        started_at: "2026-04-27T00:00:00.000Z",
        updated_at: "2026-04-27T00:00:01.000Z",
        phase_started_at: "2026-04-27T00:00:01.000Z",
        desired_lane_targets: { large: "gguf_qwen3_next_80b_large", mini: "" },
        observed_lane_targets: { large: "", mini: "" },
        parity_status: "not_required",
        drain_status: "pending",
        readiness_status: "pending",
        known_idle: false,
        reconcile_needed: false,
        evidence_status: "pending",
        evidence_refs: [],
        failure_code: "",
        failure_detail: "",
      }, null, 2)}\n`,
      "utf-8",
    );

    releaseLaunch?.();

    let firstJob = await runtime.getJob(first.job_id);
    for (let attempt = 0; attempt < 20 && firstJob?.status !== "failed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      firstJob = await runtime.getJob(first.job_id);
    }

    const current = await runtime.getCurrent();
    assert.equal(firstJob?.status, "failed");
    assert.equal(firstJob?.code, "REVISION_CONFLICT");
    assert.equal(current.swap.swap_id, "other-swap");
    assert.equal(current.swap.controller_revision, 99);
  } finally {
    releaseLaunch?.();
    await fixture.cleanup();
  }
});

trackedTest("activateSet persists swap manifest and journal for durable controller state", async () => {
  const fixture = await createRepoFixture();
  try {
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["qwen/Qwen3-Next-80B-A3B-Instruct-Q4_K_M"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        uuid: (() => {
          let count = 0;
          return () => `swap-test-${++count}`;
        })(),
      },
    });

    const result = await runtime.activateSet({ setId: "qwen80next", wait: true });
    const current = await runtime.getCurrent();
    const manifest = JSON.parse(await readFile(path.join(fixture.repoRoot, "workspace", "runtime", "swap_manifest.json"), "utf-8"));
    const journalLines = (await readFile(path.join(fixture.repoRoot, "workspace", "runtime", "swap_journal.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(result.status, "ready");
    assert.equal(result.readiness_lease.activation_set_id, "qwen80next");
    assert.equal(result.readiness_lease.current_job_id, result.job_id);
    assert.equal(manifest.swap_id, result.job_id);
    assert.equal(manifest.requested_set_id, "qwen80next");
    assert.equal(manifest.terminal_state, "ready");
    assert.equal(current.swap.swap_id, result.job_id);
    assert.equal(current.swap.controller_epoch, manifest.controller_epoch);
    assert.equal(current.readiness_lease.activation_set_id, "qwen80next");
    assert.equal(current.readiness_lease.current_job_id, result.job_id);
    assert.equal(runtime.getJob(result.job_id).readiness_lease.activation_set_id, "qwen80next");
    assert.ok(journalLines.some((entry) => entry.event_type === "swap_requested"));
    assert.ok(journalLines.some((entry) => entry.event_type === "swap_ready"));
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("activateSet rejects new admission while swap reconcile is required", async () => {
  const fixture = await createRepoFixture();
  const commands = [];
  try {
    await writeFile(
      path.join(fixture.repoRoot, "workspace", "runtime", "swap_manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        summary_version: 1,
        controller_epoch: "swap-epoch-test",
        controller_revision: 7,
        last_committed_event_seq: 7,
        runtime_incarnation_id: "runtime-test",
        swap_id: "swap-reconcile-1",
        current_job_id: "job-reconcile-1",
        requested_set_id: "qwen80next",
        canonical_set_id: "qwen80next",
        requested_generation: 0,
        observed_generation: 0,
        state: "reconcile_needed",
        terminal_state: "reconcile_needed",
        started_at: "2026-04-27T00:00:00.000Z",
        updated_at: "2026-04-27T00:00:01.000Z",
        phase_started_at: "2026-04-27T00:00:01.000Z",
        desired_lane_targets: { large: "gguf_qwen3_next_80b_large", mini: "" },
        observed_lane_targets: { large: "", mini: "" },
        parity_status: "unknown",
        drain_status: "unknown",
        readiness_status: "failed",
        known_idle: false,
        reconcile_needed: true,
        evidence_status: "minimal",
        evidence_refs: [],
        failure_code: "INTERNAL_ERROR",
        failure_detail: "waiting for operator reconcile",
      }, null, 2)}\n`,
      "utf-8",
    );

    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const result = await runtime.activateSet({ setId: "qwen36", wait: false });

    assert.equal(result.accepted, false);
    assert.equal(result.code, "RECONCILE_REQUIRED");
    assert.equal(result.swap_id, "swap-reconcile-1");
    assert.equal(result.current_job_id, "job-reconcile-1");
    assert.equal(result.active_set_id, "qwen80next");
    assert.equal(result.controller_revision, 7);
    assert.equal(result.swap_state, "reconcile_needed");
    assert.equal(result.swap_terminal_state, "reconcile_needed");
    assert.equal(result.action_policy_state, "reconcile_needed");
    assert.deepEqual(result.allowed_actions, ["stop", "fleet_down"]);
    assert.equal(result.operator_action_required, "collect_fresh_evidence");
    assert.ok(Array.isArray(result.exit_requirements));
    assert.ok(result.blocked_actions.some((entry) => entry.action === "activate_set"));
    assert.ok(result.blocked_actions.some((entry) => entry.action === "fleet_up"));
    const current = await runtime.getCurrent();
    assert.equal(current.swap.action_policy_state, "reconcile_needed");
    assert.deepEqual(current.swap.allowed_actions, ["stop", "fleet_down"]);
    assert.ok(current.swap.blocked_actions.some((entry) => entry.action === "activate"));
    assert.equal(commands.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("generic activate rejects new admission while swap reconcile is required", async () => {
  const fixture = await createRepoFixture();
  const commands = [];
  try {
    await writeFile(
      path.join(fixture.repoRoot, "workspace", "runtime", "swap_manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        summary_version: 1,
        controller_epoch: "swap-epoch-test",
        controller_revision: 11,
        last_committed_event_seq: 11,
        runtime_incarnation_id: "runtime-test",
        swap_id: "swap-reconcile-2",
        current_job_id: "job-reconcile-2",
        requested_set_id: "qwen235",
        canonical_set_id: "qwen235",
        requested_generation: 0,
        observed_generation: 0,
        state: "reconcile_needed",
        terminal_state: "reconcile_needed",
        started_at: "2026-04-27T00:00:00.000Z",
        updated_at: "2026-04-27T00:00:01.000Z",
        phase_started_at: "2026-04-27T00:00:01.000Z",
        desired_lane_targets: { large: "trt_dual_qwen235_large", mini: "" },
        observed_lane_targets: { large: "", mini: "" },
        parity_status: "unknown",
        drain_status: "unknown",
        readiness_status: "failed",
        known_idle: false,
        reconcile_needed: true,
        evidence_status: "minimal",
        evidence_refs: [],
        failure_code: "INTERNAL_ERROR",
        failure_detail: "waiting for operator reconcile",
      }, null, 2)}\n`,
      "utf-8",
    );

    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const result = await runtime.activate({
      profileId: "trt_single_qwen3_32b_mini",
      laneId: "mini",
      wait: false,
    });

    assert.equal(result.accepted, false);
    assert.equal(result.code, "RECONCILE_REQUIRED");
    assert.equal(result.requested_profile_id, "trt_single_qwen3_32b_mini");
    assert.equal(result.lane_id, "mini");
    assert.equal(result.swap_id, "swap-reconcile-2");
    assert.equal(result.current_job_id, "job-reconcile-2");
    assert.equal(result.active_set_id, "qwen235");
    assert.equal(result.controller_revision, 11);
    assert.equal(result.swap_state, "reconcile_needed");
    assert.equal(result.swap_terminal_state, "reconcile_needed");
    assert.equal(commands.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("fleetUp rejects new admission while swap reconcile is required", async () => {
  const fixture = await createRepoFixture();
  const commands = [];
  try {
    await writeFile(
      path.join(fixture.repoRoot, "workspace", "runtime", "swap_manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        summary_version: 1,
        controller_epoch: "swap-epoch-test",
        controller_revision: 13,
        last_committed_event_seq: 13,
        runtime_incarnation_id: "runtime-test",
        swap_id: "swap-reconcile-fleet",
        current_job_id: "job-reconcile-fleet",
        requested_set_id: "qwen235",
        canonical_set_id: "qwen235",
        requested_generation: 0,
        observed_generation: 0,
        state: "reconcile_needed",
        terminal_state: "reconcile_needed",
        started_at: "2026-04-27T00:00:00.000Z",
        updated_at: "2026-04-27T00:00:01.000Z",
        phase_started_at: "2026-04-27T00:00:01.000Z",
        desired_lane_targets: { large: "trt_dual_qwen235_large", mini: "" },
        observed_lane_targets: { large: "", mini: "" },
        parity_status: "unknown",
        drain_status: "unknown",
        readiness_status: "failed",
        known_idle: false,
        reconcile_needed: true,
        evidence_status: "minimal",
        evidence_refs: [],
        failure_code: "INTERNAL_ERROR",
        failure_detail: "waiting for operator reconcile",
      }, null, 2)}\n`,
      "utf-8",
    );

    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const result = await runtime.fleetUp({ wait: false });

    assert.equal(result.accepted, false);
    assert.equal(result.code, "RECONCILE_REQUIRED");
    assert.equal(result.swap_id, "swap-reconcile-fleet");
    assert.equal(result.current_job_id, "job-reconcile-fleet");
    assert.equal(result.action_policy_state, "reconcile_needed");
    assert.ok(result.blocked_actions.some((entry) => entry.action === "fleet_up"));
    assert.equal(commands.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("activateSet classifies known-idle pre-launch failure as failed_known_idle", async () => {
  const fixture = await createRepoFixture();
  try {
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (command.includes("PORT=") && !command.includes("stop_")) {
            return { ok: false, stdout: "", stderr: "launcher boom", error: "launcher boom" };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        uuid: () => "job-failed-known-idle",
      },
    });

    const result = await runtime.activateSet({ setId: "qwen36", wait: true });
    const current = await runtime.getCurrent();

    assert.equal(result.status, "failed");
    assert.equal(result.code, "ACTIVATION_FAILED");
    assert.equal(current.swap.state, "failed_known_idle");
    assert.equal(current.swap.terminal_state, "failed_known_idle");
    assert.equal(current.swap.known_idle, true);
    assert.equal(current.swap.reconcile_needed, false);
    assert.equal(current.swap.failure_code, "ACTIVATION_FAILED");
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("activateSet keeps dual-box launch failures in reconcile_needed when startup evidence remains", async () => {
  const fixture = await createRepoFixture();
  try {
    const startupStatePath = path.join(fixture.repoRoot, "workspace", "jobs", "_lanes", "qwen235", "startup-state-8000.json");
    await writeFile(
      path.join(fixture.repoRoot, "workspace", "jobs", "_lanes", "active_slot.json"),
      `${JSON.stringify({
        slot_label: "qwen235",
        port: 8000,
        model_spec: "/mnt/models/nvidia/Qwen3-235B-A22B-NVFP4/files",
        startup_state_path: startupStatePath,
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      startupStatePath,
      `${JSON.stringify({
        status: "api_not_ready",
        detail: "waiting for API readiness probe 3/600",
      }, null, 2)}\n`,
      "utf-8",
    );

    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (command.includes("PORT=") && !command.includes("stop_")) {
            return { ok: false, stdout: "", stderr: "launcher boom", error: "launcher boom" };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        uuid: () => "job-failed-dual-evidence",
      },
    });

    const result = await runtime.activateSet({ setId: "qwen235", wait: true });
    const current = await runtime.getCurrent();

    assert.equal(result.status, "failed");
    assert.equal(current.swap.state, "reconcile_needed");
    assert.equal(current.swap.terminal_state, "reconcile_needed");
    assert.equal(current.swap.known_idle, false);
    assert.equal(current.swap.reconcile_needed, true);
    assert.equal(current.swap.evidence_status, "managed_launcher");
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("activateSet rejects dual-box launch when parity preflight fails before teardown", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          commands.push(command);
          if (command.includes("[ -e") && !command.includes("ssh")) {
            return { ok: false, stdout: "", stderr: "spark model missing" };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const result = await runtime.activateSet({ setId: "qwen235", wait: true });

    assert.equal(result.accepted, false);
    assert.equal(result.code, "HARDWARE_UNAVAILABLE");
    assert.equal(result.parity_status, "failed");
    assert.ok(result.parity_reason_codes.includes("spark_model_missing"));
    assert.equal(commands.some((command) => command.includes("stop_large_lane.sh")), false);
    assert.equal(commands.some((command) => command.includes("run_dual_spark_trtllm_qwen235.sh")), false);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("activation set can invoke manual-restore profile through curated set", async () => {
  const fixture = await createRepoFixture();
  try {
    await seedDesiredState(fixture.repoRoot, {
      mode: "lane",
      state: "idle",
      watchdog_enforce: false,
      lane_targets: { large: "", mini: "" },
      fleet_id: "",
      active_set_id: "",
      status_detail: "",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["nvidia/Qwen3-235B-A22B-NVFP4"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const result = await runtime.activateSet({ setId: "qwen235", wait: true });

    assert.equal(result.status, "ready");
    assert.equal(result.code, undefined);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("activateSet restores combo back to solo when the large lane is already active", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    let miniRunning = true;
    await seedLaneSlot(fixture.repoRoot, "large", {
      profile_id: "trt_dual_qwen235_large",
      slot_label: "trt_dual_qwen235_large",
      model_spec: "/mnt/models/nvidia/Qwen3-235B-A22B-NVFP4/files",
    });
    await seedLaneSlot(fixture.repoRoot, "mini", {
      profile_id: "trt_single_qwen3_32b_mini",
      slot_label: "trt_single_qwen3_32b_mini",
      model_spec: "/mnt/models/nvidia/Qwen3-32B/files",
    });
    await seedDesiredState(fixture.repoRoot, {
      mode: "lane",
      state: "ready",
      watchdog_enforce: true,
      lane_targets: {
        large: "trt_dual_qwen235_large",
        mini: "trt_single_qwen3_32b_mini",
      },
      fleet_id: "",
      active_set_id: "qwen235-qwen32mini",
      status_detail: "combo ready",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          if (command.includes("stop_mini_lane.sh")) {
            miniRunning = false;
          }
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: async (baseUrl) => {
          if (baseUrl === "http://127.0.0.1:8000") {
            return { up: true, model_ids: ["files"], raw: {} };
          }
          if (baseUrl === "http://127.0.0.1:7999" || baseUrl === "http://127.0.0.1:7999/") {
            return miniRunning
              ? { up: true, model_ids: ["files"], raw: {} }
              : { up: false, model_ids: [], raw: null };
          }
          if (baseUrl === "http://192.168.1.203:7999" || baseUrl === "http://192.168.1.204:7999") {
            return { up: false, model_ids: [], raw: null };
          }
          return { up: false, model_ids: [], raw: null };
        },
        uuid: () => "job-restore-combo-to-solo",
      },
    });

    const result = await runtime.activateSet({
      setId: "qwen235",
      wait: true,
    });

    assert.equal(result.status, "ready");
    assert.equal(result.requested_profile_id, "qwen235");
    assert.ok(commands.some((command) => command.includes("stop_mini_lane.sh")));
    assert.ok(commands.every((command) => !command.includes("run_dual_spark_trtllm_common.sh")));

    const current = await runtime.getCurrent();
    assert.equal(current.desired_state.active_set_id, "qwen235");
    assert.equal(current.lanes.large.profile_id, "trt_dual_qwen235_large");
    assert.equal(current.lanes.mini.up, false);
    assert.equal(current.lanes.mini.profile_id, "");
    assert.ok(!current.desired_state.lane_targets.mini);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("large activation clears fleet, mini, then large before launching", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    await seedLaneSlot(fixture.repoRoot, "mini", {
      profile_id: "trt_single_qwen3_30b_a3b_mini",
      slot_label: "trt_single_qwen3_30b_a3b_mini",
      model_spec: "/mnt/models/nvidia/Qwen3-30B-A3B-NVFP4/files",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": [{ up: false, model_ids: [], raw: null }, { up: true, model_ids: ["hf-8b193b0-nim"], raw: {} }],
          "http://127.0.0.1:7999": { up: true, model_ids: ["files"], raw: {} },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        sleep: async () => {},
        uuid: () => "job-large-activation",
      },
    });

    const result = await runtime.activate({
      profileId: "trt_dual_gpt_oss_120b_large",
      laneId: "large",
      wait: true,
    });

    assert.equal(result.status, "ready");
    assert.equal(commands.length, 4);
    assert.match(commands[0], /fleet_down\.sh/);
    assert.match(commands[1], /LLMCOMMUNE_MINI_PORT='7999'.*stop_mini_lane\.sh/);
    assert.match(commands[2], /LLMCOMMUNE_LARGE_PORT='8000'.*stop_large_lane\.sh/);
    assert.match(commands[3], /PORT='8000'.*launch_trt_dual_gpt_oss_120b_8000\.sh/);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("mini activation clears large before launching mini", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    await seedLaneSlot(fixture.repoRoot, "large", {
      profile_id: "trt_dual_gpt_oss_120b_large",
      slot_label: "trt_dual_gpt_oss_120b_large",
      model_spec: "/mnt/models/openai/gpt-oss-120b/files/models--openai--gpt-oss-120b",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["hf-8b193b0-nim"], raw: {} },
          "http://127.0.0.1:7999": [{ up: false, model_ids: [], raw: null }, { up: true, model_ids: ["files"], raw: {} }],
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        sleep: async () => {},
        uuid: () => "job-mini-activation",
      },
    });

    const result = await runtime.activate({
      profileId: "trt_single_qwen3_32b_mini",
      laneId: "mini",
      wait: true,
    });

    assert.equal(result.status, "ready");
    assert.equal(commands.length, 4);
    assert.match(commands[0], /fleet_down\.sh/);
    assert.match(commands[1], /LLMCOMMUNE_LARGE_PORT='8000'.*stop_large_lane\.sh/);
    assert.match(commands[2], /LLMCOMMUNE_MINI_PORT='7999'.*stop_mini_lane\.sh/);
    assert.match(commands[3], /PORT='7999'.*launch_trt_single_qwen3_32b_7999\.sh/);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("allow_preempt false blocks when another lane is active", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    await seedLaneSlot(fixture.repoRoot, "large", {
      profile_id: "trt_dual_gpt_oss_120b_large",
      slot_label: "trt_dual_gpt_oss_120b_large",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["hf-8b193b0-nim"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const result = await runtime.activate({
      profileId: "trt_single_qwen3_30b_a3b_mini",
      laneId: "mini",
      wait: false,
      allowPreempt: false,
    });

    assert.equal(result.accepted, false);
    assert.match(result.detail, /would preempt/i);
    assert.equal(commands.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("dual-box profiles are marked blocked when gx10 is not clear", async () => {
  const fixture = await createRepoFixture();
  try {
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (command.includes("docker ps --format") && command.includes("admin@192.168.1.204")) {
            return {
              ok: true,
              stdout: "llmcommune-worker-deepseek-7999|container-deepseek32b-server-llama:latest|0.0.0.0:7999->7999/tcp\n",
              stderr: "",
            };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: true, model_ids: ["DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf"], raw: {} },
          "http://192.168.1.204:8000": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const models = await runtime.listModels();
    const qwen235 = models.profiles.find((profile) => profile.profile_id === "trt_dual_qwen235_large");
    const gptOss = models.profiles.find((profile) => profile.profile_id === "trt_dual_gpt_oss_120b_large");

    assert.equal(qwen235.requires_worker_clear, true);
    assert.equal(qwen235.worker_clear_now, false);
    assert.deepEqual(qwen235.worker_blocking_containers, ["llmcommune-worker-deepseek-7999"]);
    assert.deepEqual(qwen235.worker_responsive_ports, [7999]);
    assert.deepEqual(qwen235.blocked_by, ["gx10_not_clear"]);
    assert.equal(qwen235.launchable_now, false);

    assert.equal(gptOss.requires_worker_clear, true);
    assert.equal(gptOss.worker_clear_now, false);
    assert.deepEqual(gptOss.blocked_by, ["gx10_not_clear"]);
    assert.equal(gptOss.launchable_now, false);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("dual-box activation fails before launch when gx10 is not clear", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          commands.push(command);
          if (command.includes("docker ps --format") && command.includes("admin@192.168.1.204")) {
            return {
              ok: true,
              stdout: "llmcommune-worker-deepseek-7999|container-deepseek32b-server-llama:latest|0.0.0.0:7999->7999/tcp\n",
              stderr: "",
            };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: true, model_ids: ["DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf"], raw: {} },
          "http://192.168.1.204:8000": { up: false, model_ids: [], raw: null },
        }),
        sleep: async () => {},
        uuid: () => "job-dual-worker-blocked",
      },
    });

    const result = await runtime.activate({
      profileId: "trt_dual_gpt_oss_120b_large",
      laneId: "large",
      wait: true,
    });

    assert.equal(result.status, "failed");
    assert.match(result.status_detail, /worker gx10-b041 is not clear/i);
    assert.ok(commands.some((command) => command.includes("fleet_down.sh")));
    assert.ok(commands.some((command) => command.includes("stop_mini_lane.sh")));
    assert.ok(commands.some((command) => command.includes("stop_large_lane.sh")));
    assert.ok(commands.some((command) => command.includes("docker ps --format") && command.includes("admin@192.168.1.204")));
    assert.equal(commands.some((command) => command.includes("launch_trt_dual_gpt_oss_120b_8000.sh")), false);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("activation fails before launch when pre-launch stop does not drain cleanly", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          commands.push(command);
          if (command.includes("stop_large_lane.sh")) {
            return {
              ok: false,
              stdout: "",
              stderr: "worker did not drain cleanly within 180s",
              error: "stop_large_lane.sh exited 1",
            };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:8000": { up: false, model_ids: [], raw: null },
        }),
        sleep: async () => {},
        uuid: () => "job-stop-failed",
      },
    });

    const result = await runtime.activate({
      profileId: "trt_dual_gpt_oss_120b_large",
      laneId: "large",
      wait: true,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.code, "ACTIVATION_FAILED");
    assert.match(result.status_detail, /pre-launch stop failed/i);
    assert.match(result.status_detail, /worker did not drain cleanly/i);
    assert.ok(commands.some((command) => command.includes("fleet_down.sh")));
    assert.ok(commands.some((command) => command.includes("stop_mini_lane.sh")));
    assert.ok(commands.some((command) => command.includes("stop_large_lane.sh")));
    assert.equal(commands.some((command) => command.includes("launch_trt_dual_gpt_oss_120b_8000.sh")), false);

    const current = await runtime.getCurrent();
    assert.equal(current.desired_state.state, "failed");
    assert.equal(current.desired_state.watchdog_enforce, false);
    assert.match(current.desired_state.status_detail, /pre-launch stop failed/i);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("activation failure detail includes drain proof reason codes", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          commands.push(command);
          if (command.includes("stop_large_lane.sh")) {
            return {
              ok: false,
              stdout: 'LLMCOMMUNE_DRAIN_PROOF={"status":"failed","timeout_s":180,"local":{"clear":true,"reason_codes":[]},"worker":{"clear":false,"reason_codes":["gpu_compute_busy","trt_listener_present"]}}',
              stderr: "worker did not drain cleanly within 180s",
              error: "stop_large_lane.sh exited 1",
            };
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        sleep: async () => {},
        uuid: () => "job-stop-proof-failed",
      },
    });

    const result = await runtime.activate({
      profileId: "trt_dual_gpt_oss_120b_large",
      laneId: "large",
      wait: true,
    });

    assert.equal(result.status, "failed");
    assert.match(result.status_detail, /drain proof local=clear worker=gpu_compute_busy,trt_listener_present/i);
    assert.equal(commands.some((command) => command.includes("launch_trt_dual_gpt_oss_120b_8000.sh")), false);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("wait false returns a job immediately and models endpoint catalogs all profiles", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    let launchCount = 0;
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          commands.push(command);
          launchCount += 1;
          if (command.includes("launch_trt_single_qwen3_30b_a3b_7999.sh")) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": [{ up: false, model_ids: [], raw: null }, { up: true, model_ids: ["files"], raw: {} }],
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        sleep: async () => {},
        uuid: () => "job-async-mini",
      },
    });

    const activation = await runtime.activate({
      profileId: "trt_single_qwen3_30b_a3b_mini",
      laneId: "mini",
      wait: false,
    });
    assert.equal(activation.accepted, true);
    assert.equal(activation.job_id, "job-async-mini");
    assert.ok(["queued", "running", "ready"].includes(activation.status));
    assert.ok(launchCount >= 0);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const job = runtime.getJob("job-async-mini");
    assert.equal(job.ok, true);
    assert.ok(["running", "ready"].includes(job.status));

    const models = await runtime.listModels();
    const config = await loadModelsConfig(fixture.repoRoot);
    assert.equal(models.profiles.length, config.profiles.length);
    assert.equal(models.fleet_profiles.length, config.fleet_profiles.length);
    assert.deepEqual(
      models.candidate_models.map((candidate) => candidate.model_id),
      config.candidate_models.map((candidate) => candidate.model_id),
    );
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("inactive stale slot does not block activation and current hides the inactive profile", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    let miniProbeCount = 0;
    await seedLaneSlot(fixture.repoRoot, "large", {
      profile_id: "trt_dual_gpt_oss_120b_large",
      slot_label: "trt_dual_gpt_oss_120b_large",
      model_spec: "/mnt/models/openai/gpt-oss-120b/files/models--openai--gpt-oss-120b",
    });
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: async (baseUrl) => {
          if (baseUrl === "http://127.0.0.1:8000") {
            return { up: false, model_ids: [], raw: null };
          }
          if (baseUrl === "http://127.0.0.1:7999") {
            miniProbeCount += 1;
            return miniProbeCount >= 3
              ? { up: true, model_ids: ["files"], raw: {} }
              : { up: false, model_ids: [], raw: null };
          }
          return { up: false, model_ids: [], raw: null };
        },
        sleep: async () => {},
        uuid: () => "job-stale-slot",
      },
    });

    const current = await runtime.getCurrent();
    assert.equal(current.lanes.large.up, false);
    assert.equal(current.lanes.large.profile_id, "");
    assert.equal(current.lanes.large.runtime_family, "unknown");

    const result = await runtime.activate({
      profileId: "trt_single_qwen3_30b_a3b_mini",
      laneId: "mini",
      wait: true,
      allowPreempt: false,
    });

    assert.equal(result.status, "ready");
    assert.equal(commands.length, 1);
    assert.match(commands[0], /PORT='7999'.*launch_trt_single_qwen3_30b_a3b_7999\.sh/);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("stale desired state is reconciled to ready or failed based on live lanes", async () => {
  const fixture = await createRepoFixture();
  try {
    const staleTimestamp = "2026-04-04T00:00:00.000Z";

    await seedLaneSlot(fixture.repoRoot, "large", {
      profile_id: "trt_dual_gpt_oss_120b_large",
      slot_label: "trt_dual_gpt_oss_120b_large",
      model_spec: "/mnt/models/openai/gpt-oss-120b/files/models--openai--gpt-oss-120b",
    });
    await seedDesiredState(fixture.repoRoot, {
      mode: "lane",
      state: "ready",
      watchdog_enforce: true,
      lane_targets: {
        large: "trt_dual_gpt_oss_120b_large",
        mini: "",
      },
      fleet_id: "",
      status_detail: "trt_dual_gpt_oss_120b_large ready on large",
      updated_at: staleTimestamp,
    });

    const readyRuntime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["hf-8b193b0-nim"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        nowMs: () => Date.parse("2026-04-04T00:15:00.000Z"),
      },
    });

    const readyCurrent = await readyRuntime.getCurrent();
    assert.equal(readyCurrent.desired_state.state, "ready");
    assert.equal(readyCurrent.desired_state.watchdog_enforce, true);
    assert.equal(readyCurrent.desired_state.lane_targets.large, "trt_dual_gpt_oss_120b_large");

    await seedDesiredState(fixture.repoRoot, {
      mode: "lane",
      state: "ready",
      watchdog_enforce: true,
      lane_targets: {
        large: "trt_dual_gpt_oss_120b_large",
        mini: "",
      },
      fleet_id: "",
      status_detail: "trt_dual_gpt_oss_120b_large ready on large",
      updated_at: staleTimestamp,
    });

    const failedRuntime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: false, model_ids: [], raw: null },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        nowMs: () => Date.parse("2026-04-04T00:15:30.000Z"),
      },
    });

    const failedCurrent = await failedRuntime.getCurrent();
    assert.equal(failedCurrent.desired_state.state, "failed");
    assert.equal(failedCurrent.desired_state.watchdog_enforce, false);
  } finally {
    await fixture.cleanup();
  }
});


trackedTest("startupChecks queues boot activation for qwen36 from an idle state", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    await seedDesiredState(fixture.repoRoot, {
      mode: "idle",
      state: "idle",
      watchdog_enforce: false,
      lane_targets: { large: "", mini: "" },
      fleet_id: "",
      active_set_id: "",
      status_detail: "",
    });

    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      bootSetId: "qwen36",
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          commands.push(command);
          if (command.includes("gguf_qwen36_35b_large")) {
            await seedLaneSlot(fixture.repoRoot, "large", {
              profile_id: "gguf_qwen36_35b_large",
              slot_label: "gguf_qwen36_35b_large",
              model_spec: "/mnt/models/other/Qwen3.6-35B-A3B-UD-Q4_K_M/files/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
            });
          }
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": [
            { up: false, model_ids: [], raw: null },
            { up: true, model_ids: ["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"], raw: {} },
            { up: true, model_ids: ["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"], raw: {} },
          ],
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
        uuid: (() => {
          let counter = 0;
          return () => `job-qwen36-boot-${++counter}`;
        })(),
      },
    });

    await runtime.startupChecks();

    let current = await runtime.getCurrent();
    for (let attempt = 0; attempt < 20 && String(current.desired_state?.active_set_id || "") !== "qwen36"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      current = await runtime.getCurrent();
    }

    assert.equal(current.desired_state.active_set_id, "qwen36");
    assert.equal(current.desired_state.lane_targets.large, "gguf_qwen36_35b_large");
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("controller prefers commune lane slot metadata over stale shared active slot metadata", async () => {
  const fixture = await createRepoFixture();
  try {
    await seedLaneSlot(fixture.repoRoot, "large", {
      profile_id: "gguf_coder_next_large",
      slot_label: "gguf_coder_next_large",
      model_spec: "/mnt/models/other/Qwen3-Coder-Next-Q4_K_M/files/Qwen3-Coder-Next-Q4_K_M.gguf",
    });
    await writeFile(
      path.join(fixture.repoRoot, "workspace", "jobs", "_lanes", "active_slot.json"),
      `${JSON.stringify({
        slot_label: "llama33_70b",
        port: 8000,
        model_spec: "/mnt/models/nvidia/Llama-3.3-70B-Instruct-FP4/files",
      }, null, 2)}\n`,
      "utf-8",
    );

    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        probeRuntime: createProbeStub({
          "http://127.0.0.1:8000": { up: true, model_ids: ["Qwen3-Coder-Next-Q4_K_M.gguf"], raw: {} },
          "http://127.0.0.1:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.203:7999": { up: false, model_ids: [], raw: null },
          "http://192.168.1.204:7999": { up: false, model_ids: [], raw: null },
        }),
      },
    });

    const current = await runtime.getCurrent();
    assert.equal(current.lanes.large.up, true);
    assert.equal(current.lanes.large.profile_id, "gguf_coder_next_large");
    assert.equal(current.lanes.large.model_id, "other/Qwen3-Coder-Next-Q4_K_M");
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("studio summary surfaces evidence-backed presets, defaults, and recommendations", async () => {
  const fixture = await createRepoFixture();
  try {
    await writeFile(
      path.join(fixture.repoRoot, "workspace", "bakeoff_results.json"),
      `${JSON.stringify([
        {
          model: "Sparksolo Coder Next GGUF",
          engine: "llama.cpp",
          spinup_seconds: 21,
          tokens_per_second: 91,
          quality_score: "9.3",
          quality_notes: "solo winner",
          file: "sparksolo_coder_next_gguf.json",
        },
        {
          model: "Sparkcombo Coder Next GGUF",
          engine: "llama.cpp",
          spinup_seconds: 24,
          tokens_per_second: 84,
          quality_score: "8.7",
          quality_notes: "combo winner",
          file: "sparkcombo_coder_next_gguf.json",
        },
      ], null, 2)}\n`,
      "utf-8",
    );

    const runtime = createRuntime({ repoRoot: fixture.repoRoot });

    const soloDraft = await runtime.saveStudioDraft({
      draftId: "draft-sparksolo",
      presetId: "sparksolo_coder",
      displayName: "Sparksolo Coder",
      description: "Solo preset",
      laneTargets: { large: "gguf_coder_next_large", mini: null },
    });
    assert.equal(soloDraft.ok, true);
    const soloPublished = await runtime.publishStudioDraft({ draftId: "draft-sparksolo", persist: true });
    assert.equal(soloPublished.ok, true);
    assert.equal(soloPublished.published_revision, 1);

    const comboDraft = await runtime.saveStudioDraft({
      draftId: "draft-sparkcombo",
      presetId: "sparkcombo_coder",
      displayName: "Sparkcombo Coder",
      description: "Combo preset",
      laneTargets: { large: "gguf_coder_next_large", mini: "trt_single_qwen3_30b_a3b_mini" },
    });
    assert.equal(comboDraft.ok, true);
    const comboPublished = await runtime.publishStudioDraft({ draftId: "draft-sparkcombo", persist: true });
    assert.equal(comboPublished.ok, true);
    assert.equal(comboPublished.published_revision, 1);

    const soloDefault = await runtime.setStudioDefault({
      mode: "solo",
      presetId: "sparksolo_coder",
      publishedRevision: 1,
    });
    const comboDefault = await runtime.setStudioDefault({
      mode: "combo",
      presetId: "sparkcombo_coder",
      publishedRevision: 1,
    });
    assert.equal(soloDefault.ok, true);
    assert.equal(comboDefault.ok, true);

    const summary = await runtime.getStudioSummary();
    const soloPreset = summary.studio.published_presets.find((preset) => preset.preset_id === "sparksolo_coder" && preset.published_revision === 1);
    const comboPreset = summary.studio.published_presets.find((preset) => preset.preset_id === "sparkcombo_coder" && preset.published_revision === 1);
    const soloIndex = summary.studio.published_presets.findIndex((preset) => preset.preset_id === "sparksolo_coder" && preset.published_revision === 1);
    const comboIndex = summary.studio.published_presets.findIndex((preset) => preset.preset_id === "sparkcombo_coder" && preset.published_revision === 1);

    assert.equal(summary.ok, true);
    assert.equal(summary.studio.defaults.solo?.preset_id, "sparksolo_coder");
    assert.equal(summary.studio.defaults.solo?.valid, true);
    assert.equal(summary.studio.defaults.combo?.preset_id, "sparkcombo_coder");
    assert.equal(summary.studio.defaults.combo?.valid, true);
    assert.ok(summary.studio.recommendations.solo);
    assert.ok(summary.studio.recommendations.combo);
    assert.equal(summary.studio.evidence_stale, false);
    assert.equal(soloPreset?.evidence_status, "compatible");
    assert.equal(comboPreset?.evidence_status, "compatible");
    assert.ok(soloIndex >= 0);
    assert.ok(comboIndex >= 0);
    assert.ok(soloIndex < comboIndex);
    assert.equal(soloPreset?.catalog_rank, soloIndex + 1);
    assert.equal(comboPreset?.catalog_rank, comboIndex + 1);
    assert.equal(typeof soloPreset?.bakeoff_rank, "number");
    assert.equal(typeof comboPreset?.bakeoff_rank, "number");
    assert.ok(soloPreset.bakeoff_rank < comboPreset.bakeoff_rank);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("studio summary builds canonical catalog shelves and candidate rows", async () => {
  const fixture = await createRepoFixture();
  try {
    await writeFile(
      path.join(fixture.repoRoot, "workspace", "bakeoff_results.json"),
      `${JSON.stringify([
        {
          model: "Qwen3-Next-80B-A3B-Instruct-Q4_K_M (GGUF)",
          engine: "llama.cpp",
          spinup_seconds: 52,
          tokens_per_second: 28.67,
          quality_score: "9/10",
          quality_notes: "current shelf winner",
          file: "qwen3_next_80b_gguf.json",
        },
        {
          model: "GPT-OSS-120B-Q4_K_M (GGUF)",
          engine: "llama.cpp",
          spinup_seconds: 41,
          tokens_per_second: 36.11,
          quality_score: "8/10",
          quality_notes: "candidate runtime beats TRT",
          file: "gptoss120b_gguf.json",
        },
        {
          model: "Qwen3.6-35B-A3B-UD-Q4_K_M (GGUF)",
          engine: "llama.cpp",
          spinup_seconds: 26,
          tokens_per_second: 32.44,
          quality_score: "8/10",
          quality_notes: "promote next",
          file: "qwen36_35b_gguf.json",
        },
        {
          model: "Gemma-4-31B-it-Q4_K_M (GGUF)",
          engine: "llama.cpp",
          spinup_seconds: 22,
          tokens_per_second: 7.99,
          quality_score: "8/10",
          quality_notes: "gguf beats trt for gemma",
          file: "gemma4_31b_gguf.json",
        },
      ], null, 2)}\n`,
      "utf-8",
    );

    const runtime = createRuntime({ repoRoot: fixture.repoRoot });
    const summary = await runtime.getStudioSummary();
    const catalog = summary.studio.catalog;
    const qwenCombo = catalog.rows.find((row) => row.catalog_entry_id === "qwen36__gemma426");
    const gemmaSolo = catalog.rows.find((row) => row.catalog_entry_id === "gemma431");
    const gptSolo = catalog.rows.find((row) => row.catalog_entry_id === "gptoss120");
    const qwen36Solo = catalog.rows.find((row) => row.catalog_entry_id === "qwen36");

    assert.equal(summary.ok, true);
    assert.ok(catalog);
    assert.ok(qwenCombo);
    assert.ok(gemmaSolo);
    assert.ok(gptSolo);
    assert.ok(qwen36Solo);

    assert.ok(qwenCombo.aliases.includes("gamenator_qwen"));
    assert.equal(qwenCombo.publication_state, "current_published");
    assert.equal(qwenCombo.catalog_shelf, "current");
    assert.equal(qwenCombo.activation_target_id, "gamenator_qwen");


    assert.equal(gemmaSolo.primary_variant.variant_id, "gguf");
    assert.equal(gemmaSolo.publication_state, "current_published");
    assert.equal(gemmaSolo.catalog_shelf, "current");
    assert.equal(gemmaSolo.activation_target_id, "gemma431");

    assert.equal(gptSolo.publication_state, "current_published");
    assert.equal(gptSolo.recommendation_state, "promote_next");
    assert.ok(gptSolo.candidate_variant_count >= 1);
    assert.equal(gptSolo.primary_variant.variant_id, "gguf");
    assert.equal(gptSolo.activation_target_id, "gptoss120");

    assert.ok(qwen36Solo.catalog_shelf === "promote_next" || qwen36Solo.catalog_shelf === "current");
    assert.equal(qwen36Solo.activatable, true);
    assert.equal(qwen36Solo.activation_target_id, "qwen36");
    assert.equal(qwen36Solo.primary_variant.variant_id, "gguf");

    const help = await runtime.getHelp();
    assert.ok(help.controller.activation_sets.some((entry) => entry.set_id === "qwen36-qwen36mini" && entry.lane_targets?.mini === "gguf_qwen36_35b_mini"));
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("studio publish creates immutable revisions and apply reuses activate-set", async () => {
  const fixture = await createRepoFixture();
  try {
    const commands = [];
    let largeProbeCount = 0;
    const runtime = createRuntime({
      repoRoot: fixture.repoRoot,
      dependencies: {
        runCommand: async (command) => {
          if (isWorkerContainerInspection(command)) {
            return { ok: true, stdout: "", stderr: "" };
          }
          commands.push(command);
          return { ok: true, stdout: "", stderr: "" };
        },
        probeRuntime: async (baseUrl) => {
          if (baseUrl === "http://127.0.0.1:8000") {
            largeProbeCount += 1;
            return largeProbeCount >= 2
              ? { up: true, model_ids: ["Qwen3-Coder-Next-Q4_K_M.gguf"], raw: {} }
              : { up: false, model_ids: [], raw: null };
          }
          return { up: false, model_ids: [], raw: null };
        },
        sleep: async () => {},
        uuid: () => "job-studio-apply",
      },
    });

    const firstSave = await runtime.saveStudioDraft({
      draftId: "draft-immut",
      presetId: "immut_coder",
      displayName: "Immut Coder",
      laneTargets: { large: "gguf_coder_next_large", mini: null },
    });
    assert.equal(firstSave.ok, true);

    const firstPublish = await runtime.publishStudioDraft({
      draftId: "draft-immut",
      expectedDraftRevision: firstSave.draft.draft_revision,
      persist: true,
    });
    assert.equal(firstPublish.ok, true);
    assert.equal(firstPublish.published_revision, 1);

    const secondSave = await runtime.saveStudioDraft({
      draftId: "draft-immut",
      expectedDraftRevision: firstSave.draft.draft_revision,
      presetId: "immut_coder",
      displayName: "Immut Coder",
      description: "Second cut",
      laneTargets: { large: "gguf_coder_next_large", mini: null },
    });
    assert.equal(secondSave.ok, true);
    assert.equal(secondSave.draft.draft_revision, 2);

    const secondPublish = await runtime.publishStudioDraft({
      draftId: "draft-immut",
      expectedDraftRevision: secondSave.draft.draft_revision,
      persist: true,
    });
    assert.equal(secondPublish.ok, true);
    assert.equal(secondPublish.published_revision, 2);

    const catalog = await runtime.getActivationSets();
    assert.ok(catalog.activation_sets.some((set) => set.set_id === firstPublish.activation_set_id));
    assert.ok(catalog.activation_sets.some((set) => set.set_id === secondPublish.activation_set_id));

    const applied = await runtime.applyStudioPreset({
      presetId: "immut_coder",
      publishedRevision: 1,
      wait: true,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.status, "ready");
    assert.equal(applied.activation_set_id, firstPublish.activation_set_id);

    const current = await runtime.getCurrent();
    assert.equal(current.desired_state.active_set_id, firstPublish.activation_set_id);
  } finally {
    await fixture.cleanup();
  }
});

trackedTest("http routes expose the controller contract", async () => {
  const calls = [];
  const fakeRuntime = {
    async getHelp() {
      calls.push(["getHelp"]);
      return { ok: true, endpoint: "help" };
    },
    async getCurrent() {
      calls.push(["getCurrent"]);
      return { ok: true, endpoint: "current" };
    },
    async listModels() {
      calls.push(["listModels"]);
      return { ok: true, endpoint: "models" };
    },
    async getStudioSummary() {
      calls.push(["getStudioSummary"]);
      return { ok: true, studio: true };
    },
    async getStudioActionLog(limit) {
      calls.push(["getStudioActionLog", limit]);
      return { ok: true, entries: [] };
    },
    async saveStudioDraft(payload) {
      calls.push(["saveStudioDraft", payload]);
      return { ok: true, accepted: true, draft: { draft_id: payload.draftId || "draft-1" } };
    },
    async duplicateStudioDraft(payload) {
      calls.push(["duplicateStudioDraft", payload]);
      return { ok: true, accepted: true, draft: { draft_id: "draft-copy" } };
    },
    async deleteStudioDraft(payload) {
      calls.push(["deleteStudioDraft", payload]);
      return { ok: true, accepted: true, deleted: payload.draftId };
    },
    async publishStudioDraft(payload) {
      calls.push(["publishStudioDraft", payload]);
      return { ok: true, accepted: true, activation_set_id: "studio_r0001" };
    },
    async applyStudioPreset(payload) {
      calls.push(["applyStudioPreset", payload]);
      return { ok: true, accepted: true, activation_set_id: "studio_r0001" };
    },
    async setStudioDefault(payload) {
      calls.push(["setStudioDefault", payload]);
      return { ok: true, accepted: true, mode: payload.mode };
    },
    async refreshStudioEvidence() {
      calls.push(["refreshStudioEvidence"]);
      return { ok: true, stale: false };
    },
    async activate(payload) {
      calls.push(["activate", payload]);
      return { ok: true, accepted: true, endpoint: "activate" };
    },
    getJob(jobId) {
      calls.push(["getJob", jobId]);
      return jobId === "known" ? { ok: true, job_id: jobId } : { ok: false, detail: "job not found" };
    },
    async restartLane(laneId) {
      calls.push(["restartLane", laneId]);
      return { ok: true, laneId };
    },
    async stopLane(laneId) {
      calls.push(["stopLane", laneId]);
      return { ok: true, laneId };
    },
    async bonzai() {
      calls.push(["bonzai"]);
      return { ok: true };
    },
    async fleetUp(payload) {
      calls.push(["fleetUp", payload]);
      return { ok: true, accepted: true };
    },
    async fleetDown(payload) {
      calls.push(["fleetDown", payload]);
      return { ok: true, accepted: true };
    },
    async deepHealth() {
      calls.push(["deepHealth"]);
      return { ok: true, checks: {} };
    },
    async writeInventorySnapshot() {
      calls.push(["snapshot"]);
      return { ok: true, snapshot: true };
    },
  };

  const server = await startTestServer(fakeRuntime);
  try {
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200);

    const help = await fetch(`${server.baseUrl}/api/llm-host/help`);
    assert.equal(help.status, 200);
    const current = await fetch(`${server.baseUrl}/api/llm-host/current`);
    assert.equal(current.status, 200);
    const models = await fetch(`${server.baseUrl}/api/llm-host/models`);
    assert.equal(models.status, 200);
    const studioSummary = await fetch(`${server.baseUrl}/api/llm-host/studio/summary`);
    assert.equal(studioSummary.status, 200);
    const studioLog = await fetch(`${server.baseUrl}/api/llm-host/studio/action-log?limit=9`);
    assert.equal(studioLog.status, 200);

    const activate = await fetch(`${server.baseUrl}/api/llm-host/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: "foo", lane_id: "large", wait: true, allow_preempt: false }),
    });
    assert.equal(activate.status, 202);

    const missingJob = await fetch(`${server.baseUrl}/api/llm-host/jobs/missing`);
    assert.equal(missingJob.status, 404);
    const knownJob = await fetch(`${server.baseUrl}/api/llm-host/jobs/known`);
    assert.equal(knownJob.status, 200);

    const restart = await fetch(`${server.baseUrl}/api/llm-host/actions/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lane_id: "large" }),
    });
    assert.equal(restart.status, 200);

    const stop = await fetch(`${server.baseUrl}/api/llm-host/actions/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lane_id: "all" }),
    });
    assert.equal(stop.status, 200);

    const bonzai = await fetch(`${server.baseUrl}/bonzai`, { method: "POST" });
    assert.equal(bonzai.status, 200);
    const fleetUp = await fetch(`${server.baseUrl}/fleet/up`, { method: "POST" });
    assert.equal(fleetUp.status, 202);
    const fleetDown = await fetch(`${server.baseUrl}/fleet/down`, { method: "POST" });
    assert.equal(fleetDown.status, 202);
    const snapshot = await fetch(`${server.baseUrl}/api/llm-host/snapshot`, { method: "POST" });
    assert.equal(snapshot.status, 200);
    const saveDraft = await fetch(`${server.baseUrl}/api/llm-host/studio/drafts/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draft_id: "draft-1",
        preset_id: "sparksolo",
        display_name: "Sparksolo",
        lane_targets: { large: "gguf_coder_next_large", mini: null },
      }),
    });
    assert.equal(saveDraft.status, 200);
    const duplicateDraft = await fetch(`${server.baseUrl}/api/llm-host/studio/drafts/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_id: "draft-1" }),
    });
    assert.equal(duplicateDraft.status, 200);
    const publishDraft = await fetch(`${server.baseUrl}/api/llm-host/studio/drafts/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_id: "draft-1", draft_revision: 3 }),
    });
    assert.equal(publishDraft.status, 201);
    const applyPreset = await fetch(`${server.baseUrl}/api/llm-host/studio/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset_id: "sparksolo", published_revision: 1, wait: true }),
    });
    assert.equal(applyPreset.status, 202);
    const setDefault = await fetch(`${server.baseUrl}/api/llm-host/studio/defaults/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "solo", preset_id: "sparksolo", published_revision: 1 }),
    });
    assert.equal(setDefault.status, 200);
    const refreshEvidence = await fetch(`${server.baseUrl}/api/llm-host/studio/recommendations/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(refreshEvidence.status, 200);
    const deleteDraft = await fetch(`${server.baseUrl}/api/llm-host/studio/drafts/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft_id: "draft-1", draft_revision: 3 }),
    });
    assert.equal(deleteDraft.status, 200);

    assert.deepEqual(calls.find((entry) => entry[0] === "activate")?.[1], {
      profileId: "foo",
      laneId: "large",
      wait: true,
      allowPreempt: false,
      dryRun: false,
      override: false,
    });
    assert.deepEqual(calls.find((entry) => entry[0] === "saveStudioDraft")?.[1], {
      draftId: "draft-1",
      expectedDraftRevision: null,
      presetId: "sparksolo",
      displayName: "Sparksolo",
      description: "",
      laneTargets: { large: "gguf_coder_next_large", mini: null },
      sourceActivationSetId: "",
      basePublishedRevision: null,
    });
    assert.deepEqual(calls.find((entry) => entry[0] === "getStudioActionLog"), ["getStudioActionLog", 9]);
    assert.deepEqual(calls.find((entry) => entry[0] === "publishStudioDraft")?.[1], {
      draftId: "draft-1",
      expectedDraftRevision: 3,
      persist: true,
    });
    assert.deepEqual(calls.find((entry) => entry[0] === "applyStudioPreset")?.[1], {
      presetId: "sparksolo",
      publishedRevision: 1,
      activationSetId: "",
      wait: true,
      allowPreempt: true,
      force: false,
      dryRun: false,
    });
  } finally {
    await server.close();
  }
});

after(async () => {
  await writeJsonReport(unitReportPath, {
    generated_at: new Date().toISOString(),
    suite: "unit-runtime-controller",
    results: unitResults,
    passed: unitResults.filter((entry) => entry.status === "passed").length,
    failed: unitResults.filter((entry) => entry.status === "failed").length,
  });
});
