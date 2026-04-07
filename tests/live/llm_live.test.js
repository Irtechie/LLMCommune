import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

import { buildCatalog, repoRoot, writeJsonReport } from "../support/catalog.js";

const exec = promisify(execCallback);
const controllerBaseUrl = "http://127.0.0.1:4000";
const localLargeBaseUrl = "http://127.0.0.1:8000";
const localMiniBaseUrl = "http://127.0.0.1:7999";
const remoteMiniBaseUrl = "http://192.168.1.204:7999";
const settleMs = 20_000;
const sshOptions = "-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /home/admin/.ssh/trtllm_ed25519";
const workerSsh = "admin@192.168.1.204";
const liveReportPath = path.join(repoRoot, "workspace", "test-reports", "live.json");
const liveResults = [];
const preferredProfileOrder = [
  "gguf_coder_next_large",
  "gguf_qwen3_next_80b_large",
  "trt_dual_qwen235_large",
  "trt_dual_gpt_oss_120b_large",
  "trt_dual_llama33_70b_large",
  "trt_single_qwen3_32b_mini",
  "trt_single_qwen3_30b_a3b_mini",
  "gguf_deepseek_32b_mini",
];
const requestedTargets = new Set(
  String(process.env.LLMCOMMUNE_TEST_FILTER || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runShell(command, timeoutMs = 120000) {
  const { stdout, stderr } = await exec(command, {
    shell: "/bin/bash",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 20,
  });
  return {
    stdout: String(stdout || ""),
    stderr: String(stderr || ""),
  };
}

async function fetchJson(url, { method = "GET", body, timeoutMs = 10000 } = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: text.trim() ? JSON.parse(text) : null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: String(error?.message || error || "request failed"),
    };
  }
}

async function ensureControllerHealthy(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  const restartThreshold = Date.now() + 15000;
  let restartAttempted = false;
  while (Date.now() < deadline) {
    const health = await fetchJson(`${controllerBaseUrl}/health`, { timeoutMs: 3000 });
    if (health.ok) return;
    if (!restartAttempted && Date.now() >= restartThreshold) {
      await runShell("systemctl --user restart llmcommune-controller.service", 30000);
      restartAttempted = true;
    }
    await sleep(2000);
  }
  throw new Error("controller :4000 did not become healthy");
}

async function controllerPost(pathName, payload, timeoutMs = 15000) {
  await ensureControllerHealthy();
  const response = await fetchJson(`${controllerBaseUrl}${pathName}`, {
    method: "POST",
    body: payload,
    timeoutMs,
  });
  if (!response.ok) {
    throw new Error(`controller POST ${pathName} failed: ${response.status} ${response.error || JSON.stringify(response.body || {})}`);
  }
  return response.body;
}

async function getCurrentState() {
  await ensureControllerHealthy();
  const response = await fetchJson(`${controllerBaseUrl}/api/llm-host/current`, { timeoutMs: 5000 });
  if (!response.ok || !response.body) {
    throw new Error(`failed to read current state: ${response.status} ${response.error || ""}`);
  }
  return response.body;
}

async function waitForPortDown(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await fetchJson(`${url}/v1/models`, { timeoutMs: 3000 });
    if (!probe.ok) return true;
    await sleep(2000);
  }
  return false;
}

async function listContainerNames({ remote = false } = {}) {
  const cmd = remote
    ? `ssh ${sshOptions} ${workerSsh} "docker ps --format '{{.Names}}|{{.Ports}}'"`
    : "docker ps --format '{{.Names}}|{{.Ports}}'";
  const { stdout } = await runShell(cmd, 30000);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", ports = ""] = line.split("|");
      return { name, ports };
    });
}

async function verifyManagedContainersGone(kind) {
  const localContainers = await listContainerNames();
  const remoteContainers = await listContainerNames({ remote: true });
  const largeNames = ["llm-shared", "coder-main-8000", "vllm", "trtllm-multinode"];
  const miniNames = ["coder-deepseek-7999", "llm-mini-7999", "llm-trt-mini-7999"];
  const remoteMiniNames = ["llmcommune-worker-deepseek-7999", ...miniNames];

  if (kind === "large" || kind === "all") {
    assert.equal(
      localContainers.some((entry) => largeNames.includes(entry.name) || String(entry.ports).includes("8000->")),
      false,
      "large lane containers should be gone locally",
    );
    assert.equal(
      remoteContainers.some((entry) => largeNames.includes(entry.name) || String(entry.ports).includes("8000->")),
      false,
      "large lane containers should be gone on worker",
    );
  }

  if (kind === "mini" || kind === "all") {
    assert.equal(
      localContainers.some((entry) => miniNames.includes(entry.name) || String(entry.ports).includes("7999->")),
      false,
      "mini lane containers should be gone locally",
    );
    assert.equal(
      remoteContainers.some((entry) => remoteMiniNames.includes(entry.name) || String(entry.ports).includes("7999->")),
      false,
      "mini lane containers should be gone on worker",
    );
  }
}

async function stopEverything() {
  try {
    await controllerPost("/fleet/down", { wait: true }, 60000);
  } catch {
    // Best effort. The lane stop below still cleans up local state.
  }
  await controllerPost("/api/llm-host/actions/stop", { lane_id: "all" }, 60000);
  assert.equal(await waitForPortDown(localLargeBaseUrl, 120000), true, "large lane should be down");
  assert.equal(await waitForPortDown(localMiniBaseUrl, 120000), true, "mini lane should be down");
  await verifyManagedContainersGone("all");
  const current = await getCurrentState();
  assert.equal(current.lanes.large.up, false, "large lane should be reported down");
  assert.equal(current.lanes.mini.up, false, "mini lane should be reported down");
  assert.equal(current.mini_fleet.up, false, "fleet should be reported down");
  assert.equal(current.desired_state.state, "idle", "desired state should settle to idle after full stop");
  await sleep(5000);
}

async function waitForJob(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetchJson(`${controllerBaseUrl}/api/llm-host/jobs/${encodeURIComponent(jobId)}`, {
      timeoutMs: 5000,
    });
    if (!response.ok) {
      await sleep(2000);
      continue;
    }
    const job = response.body;
    if (job.status === "ready") return job;
    if (job.status === "failed") {
      throw new Error(`job ${jobId} failed: ${job.status_detail || "no detail"}`);
    }
    await sleep(3000);
  }
  throw new Error(`job ${jobId} did not complete within ${timeoutMs}ms`);
}

async function chooseInferenceModelId(modelsPayload, lanePayload) {
  const rows = Array.isArray(modelsPayload?.data) ? modelsPayload.data : [];
  const serverId = String(rows[0]?.id || "").trim();
  return {
    preferred: String(lanePayload.model_id || "").trim(),
    fallback: serverId,
  };
}

async function runInference(callTarget, lanePayload) {
  const modelsResponse = await fetchJson(callTarget.models_url, { timeoutMs: 15000 });
  assert.equal(modelsResponse.ok, true, `models endpoint must respond for ${lanePayload.profile_id}`);
  const { preferred, fallback } = await chooseInferenceModelId(modelsResponse.body, lanePayload);
  const modelIdsToTry = [preferred, fallback].filter(Boolean);
  let lastFailure = null;

  for (const modelId of modelIdsToTry) {
    const requestBody = callTarget.protocol === "openai_completions"
      ? {
          model: modelId,
          prompt: "Reply with exactly: ok",
          max_tokens: 16,
          temperature: 0,
        }
      : {
          model: modelId,
          messages: [
            { role: "user", content: "Reply with exactly: ok" },
          ],
          max_tokens: 16,
          temperature: 0,
        };
    const endpoint = callTarget.protocol === "openai_completions"
      ? callTarget.completions_url
      : callTarget.chat_url;
    const response = await fetchJson(endpoint, {
      method: "POST",
      body: requestBody,
      timeoutMs: 60000,
    });
    if (response.ok) {
      return {
        request_model_id: modelId,
        served_model_ids: Array.isArray(modelsResponse.body?.data)
          ? modelsResponse.body.data.map((entry) => entry.id).filter(Boolean)
          : [],
        response: response.body,
      };
    }
    lastFailure = response;
  }

  throw new Error(`inference failed for ${lanePayload.profile_id}: ${lastFailure?.status} ${lastFailure?.error || JSON.stringify(lastFailure?.body || {})}`);
}

async function activateProfile(profile) {
  const activation = await controllerPost("/api/llm-host/activate", {
    profile_id: profile.profile_id,
    lane_id: profile.default_lane,
    wait: false,
    allow_preempt: true,
  }, 15000);
  assert.equal(activation.accepted, true, `activation should be accepted for ${profile.profile_id}`);
  const timeoutMs = (profile.startup_expectation?.ready_timeout_s || 900) * 1000;
  const job = await waitForJob(activation.job_id, timeoutMs);
  return { activation, job };
}

async function verifyLane(profile, laneId) {
  const lanePayload = await waitForLaneState(profile, laneId, 120000);
  const inference = await runInference(lanePayload.call_target, lanePayload);
  await sleep(settleMs);
  const settledLane = await waitForLaneState(profile, laneId, 120000);
  await runInference(settledLane.call_target, settledLane);
  return {
    lane_id: laneId,
    profile_id: profile.profile_id,
    model_id: settledLane.model_id,
    runtime_family: settledLane.runtime_family,
    host_pattern: settledLane.host_pattern,
    serving_port: settledLane.port,
    request_model_id: inference.request_model_id,
    served_model_ids: inference.served_model_ids,
  };
}

async function waitForLaneState(profile, laneId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await getCurrentState();
    const lanePayload = current.lanes[laneId];
    if (lanePayload.up === true && lanePayload.profile_id === profile.profile_id) {
      return lanePayload;
    }
    await sleep(3000);
  }
  const current = await getCurrentState();
  const lanePayload = current.lanes[laneId];
  assert.equal(lanePayload.up, true, `${profile.profile_id} should be up on ${laneId}`);
  assert.equal(lanePayload.profile_id, profile.profile_id, `${profile.profile_id} should own ${laneId}`);
  return lanePayload;
}

async function runFleetTest(fleet) {
  await stopEverything();
  const start = Date.now();
  const activation = await controllerPost(
    "/fleet/up",
    { wait: true },
    ((fleet.startup_expectation?.ready_timeout_s || 1200) + 60) * 1000,
  );
  assert.equal(activation.accepted, true, "fleet activation should be accepted");
  if (activation.status === "failed") {
    throw new Error(activation.status_detail || "fleet up failed");
  }

  const sparkModels = await fetchJson(`${localMiniBaseUrl}/v1/models`, { timeoutMs: 15000 });
  const gx10Models = await fetchJson(`${remoteMiniBaseUrl}/v1/models`, { timeoutMs: 15000 });
  assert.equal(sparkModels.ok, true, "spark mini fleet member should respond");
  assert.equal(gx10Models.ok, true, "gx10 mini fleet member should respond");

  await sleep(settleMs);
  const sparkModelsSettled = await fetchJson(`${localMiniBaseUrl}/v1/models`, { timeoutMs: 15000 });
  const gx10ModelsSettled = await fetchJson(`${remoteMiniBaseUrl}/v1/models`, { timeoutMs: 15000 });
  assert.equal(sparkModelsSettled.ok, true, "spark mini fleet member should survive settle");
  assert.equal(gx10ModelsSettled.ok, true, "gx10 mini fleet member should survive settle");

  await controllerPost("/fleet/down", { wait: true }, 300000);
  assert.equal(await waitForPortDown(localMiniBaseUrl, 120000), true, "spark mini fleet should stop");
  assert.equal(await waitForPortDown(remoteMiniBaseUrl, 120000), true, "gx10 mini fleet should stop");
  await verifyManagedContainersGone("mini");

  return {
    fleet_id: fleet.fleet_id,
    status: "passed",
    startup_duration_s: activation.elapsed_s ?? Number(((Date.now() - start) / 1000).toFixed(1)),
    members: fleet.members.map((member) => ({
      member_id: member.member_id,
      profile_id: member.profile_id,
      host_id: member.host_id,
      port: member.port,
    })),
  };
}

function sortProfilesForStability(profiles) {
  const order = new Map(preferredProfileOrder.map((profileId, index) => [profileId, index]));
  return [...profiles].sort((left, right) => {
    const leftRank = order.has(left.profile_id) ? order.get(left.profile_id) : Number.MAX_SAFE_INTEGER;
    const rightRank = order.has(right.profile_id) ? order.get(right.profile_id) : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return String(left.profile_id).localeCompare(String(right.profile_id));
  });
}

test("serialized live profile and fleet sweep", { timeout: 8 * 60 * 60 * 1000 }, async () => {
  const catalog = await buildCatalog();
  const failures = [];
  const selectedProfiles = requestedTargets.size === 0
    ? sortProfilesForStability(catalog.profiles)
    : sortProfilesForStability(catalog.profiles.filter((profile) => requestedTargets.has(profile.profile_id)));
  const selectedFleets = requestedTargets.size === 0
    ? catalog.fleets
    : catalog.fleets.filter((fleet) => requestedTargets.has(fleet.fleet_id));

  await ensureControllerHealthy();

  for (const profile of selectedProfiles) {
    const entry = {
      scope: "profile",
      profile_id: profile.profile_id,
      model_id: profile.model_id,
      runtime_family: profile.runtime_family,
      default_lane: profile.default_lane,
      status: "running",
    };
    try {
      await stopEverything();
      const startedAt = Date.now();
      const { job } = await activateProfile(profile);
      const verified = await verifyLane(profile, profile.default_lane);
      await stopEverything();
      entry.status = "passed";
      entry.startup_duration_s = job.elapsed_s ?? Number(((Date.now() - startedAt) / 1000).toFixed(1));
      entry.response_verified = true;
      Object.assign(entry, verified);
    } catch (error) {
      entry.status = "failed";
      entry.detail = String(error?.message || error);
      failures.push(`${profile.profile_id}: ${entry.detail}`);
      try {
        await stopEverything();
      } catch {
        // Best effort cleanup only.
      }
    }
    liveResults.push(entry);
  }

  for (const fleet of selectedFleets) {
    const entry = {
      scope: "fleet",
      fleet_id: fleet.fleet_id,
      status: "running",
    };
    try {
      Object.assign(entry, await runFleetTest(fleet));
    } catch (error) {
      entry.status = "failed";
      entry.detail = String(error?.message || error);
      failures.push(`${fleet.fleet_id}: ${entry.detail}`);
      try {
        await stopEverything();
      } catch {
        // Best effort cleanup only.
      }
    }
    liveResults.push(entry);
  }

  assert.deepEqual(failures, []);
});

after(async () => {
  await writeJsonReport(liveReportPath, {
    generated_at: new Date().toISOString(),
    suite: "live",
    controller_base_url: controllerBaseUrl,
    results: liveResults,
    passed: liveResults.filter((entry) => entry.status === "passed").length,
    failed: liveResults.filter((entry) => entry.status === "failed").length,
  });
});
