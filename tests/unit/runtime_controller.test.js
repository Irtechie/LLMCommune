import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
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
    assert.equal(job.status, "ready");

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
      state: "starting",
      watchdog_enforce: false,
      lane_targets: {
        large: "trt_dual_gpt_oss_120b_large",
        mini: "",
      },
      fleet_id: "",
      status_detail: "starting trt_dual_gpt_oss_120b_large on large",
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
      state: "starting",
      watchdog_enforce: false,
      lane_targets: {
        large: "trt_dual_gpt_oss_120b_large",
        mini: "",
      },
      fleet_id: "",
      status_detail: "starting trt_dual_gpt_oss_120b_large on large",
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
        nowMs: () => Date.parse("2026-04-04T01:30:00.000Z"),
      },
    });

    const failedCurrent = await failedRuntime.getCurrent();
    assert.equal(failedCurrent.desired_state.state, "failed");
    assert.equal(failedCurrent.desired_state.watchdog_enforce, false);
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

    assert.deepEqual(calls.find((entry) => entry[0] === "activate")?.[1], {
      profileId: "foo",
      laneId: "large",
      wait: true,
      allowPreempt: false,
      dryRun: false,
      override: false,
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
