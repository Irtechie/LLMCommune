import { exec as execCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\"'\"'`)}'`;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildAdapter(runtime, baseUrl, notes = "") {
  const base = normalizeBaseUrl(baseUrl);
  const lowered = String(runtime || "unknown").trim().toLowerCase();
  if (lowered === "ollama") {
    return {
      runtime: "ollama",
      protocol: "ollama_chat",
      base_url: base,
      health_url: `${base}/api/tags`,
      models_url: `${base}/api/tags`,
      chat_url: `${base}/api/chat`,
      completions_url: `${base}/api/generate`,
      openai_compatible: false,
      model_field: "model",
      notes: notes || "Ollama-native runtime.",
    };
  }
  const protocol = lowered === "llama.cpp" ? "openai_completions" : "openai_chat";
  return {
    runtime: lowered || "unknown",
    protocol,
    base_url: base,
    health_url: `${base}/health`,
    models_url: `${base}/v1/models`,
    chat_url: `${base}/v1/chat/completions`,
    completions_url: `${base}/v1/completions`,
    openai_compatible: true,
    model_field: "model",
    notes: notes || "OpenAI-compatible runtime.",
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function runCommand(command, timeoutMs = 600000) {
  try {
    const { stdout, stderr } = await exec(command, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 20,
      shell: "/bin/bash",
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || ""),
      error: String(error?.message || error || "command failed"),
    };
  }
}

async function fetchJson(url, timeoutMs = 3000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, status: response.status, body: null };
    return { ok: true, status: response.status, body: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message || error || "fetch failed") };
  }
}

async function probeRuntime(baseUrl) {
  const models = await fetchJson(`${normalizeBaseUrl(baseUrl)}/v1/models`, 2500);
  if (models.ok) {
    const rows = Array.isArray(models.body?.data)
      ? models.body.data
      : Array.isArray(models.body?.models)
        ? models.body.models
        : [];
    const modelIds = rows
      .map((entry) => String(entry?.id || entry?.name || entry?.model || "").trim())
      .filter(Boolean);
    return {
      up: true,
      model_ids: modelIds,
      raw: models.body,
    };
  }
  const health = await fetchJson(`${normalizeBaseUrl(baseUrl)}/health`, 1500);
  return {
    up: Boolean(health.ok),
    model_ids: [],
    raw: health.body,
  };
}

function modelIdsMatch(left, right) {
  const a = String(left || "").trim().toLowerCase();
  const b = String(right || "").trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const baseA = a.split("/").filter(Boolean).pop() || a;
  const baseB = b.split("/").filter(Boolean).pop() || b;
  return a.includes(baseB) || b.includes(baseA);
}

function isoNow() {
  return new Date().toISOString();
}

export function createRuntime({
  repoRoot,
  alphaRoot = "/home/admin/apps/Alpha",
  workerSsh = "admin@192.168.1.204",
} = {}) {
  const configPath = path.join(repoRoot, "src", "config", "models.json");
  const stateRoot = path.join(repoRoot, "workspace", "runtime");
  const jobsRoot = path.join(stateRoot, "jobs");
  const localLargeSlotPath = path.join(stateRoot, "large_slot.json");
  const localMiniSlotPath = path.join(stateRoot, "mini_slot.json");
  const alphaActiveSlotPath = path.join(alphaRoot, "workspace", "jobs", "_lanes", "active_slot.json");
  const jobs = new Map();
  let cache = { ts: 0, value: null };

  async function loadConfig() {
    return readJson(configPath, {});
  }

  async function remotePathExists(remotePath) {
    const target = String(remotePath || "").trim();
    if (!target) return false;
    const result = await runCommand(
      `ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${shellQuote(workerSsh)} ${shellQuote(`bash -lc ${shellQuote(`test -e ${shellQuote(target)}`)}`)}`,
      60000,
    );
    return Boolean(result.ok);
  }

  async function pathExists(localPath) {
    const target = String(localPath || "").trim();
    if (!target) return false;
    const result = await runCommand(`[ -e ${shellQuote(target)} ]`, 15000);
    return Boolean(result.ok);
  }

  async function listContainers(remote = false) {
    const cmd = "docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'";
    const result = remote
      ? await runCommand(`ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${shellQuote(workerSsh)} ${shellQuote(cmd)}`, 30000)
      : await runCommand(cmd, 30000);
    if (!result.ok) return [];
    return String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = "", image = "", ports = ""] = line.split("|");
        return { name, image, ports };
      });
  }

  async function collectInventory(config) {
    const now = Date.now();
    if (cache.value && now - cache.ts < 30000) return cache.value;
    const rows = [];
    for (const model of config.inventory_models || []) {
      const sparkPresent = await pathExists(model?.model_paths?.spark || "");
      const gx10Present = await remotePathExists(model?.model_paths?.gx10 || "");
      rows.push({
        ...model,
        installed_on: sparkPresent && gx10Present ? "both" : sparkPresent ? "spark" : gx10Present ? "gx10" : "missing",
        spark_present: sparkPresent,
        gx10_present: gx10Present,
      });
    }
    cache = { ts: now, value: rows };
    return rows;
  }

  async function resolveLargeLaneCurrent(config) {
    const lane = config.lanes?.large || {};
    const baseUrl = `http://${config.hosts?.spark?.public_host || "127.0.0.1"}:${lane.port || 8000}`;
    const probe = await probeRuntime(`http://127.0.0.1:${lane.port || 8000}`);
    const localSlot = await readJson(localLargeSlotPath, {});
    const alphaSlot = await readJson(alphaActiveSlotPath, {});
    const slotLabel = String(localSlot?.slot_label || alphaSlot?.slot_label || "").trim();
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    let profile = profiles.find((entry) => String(entry?.profile_id || "") === slotLabel);
    if (!profile && slotLabel) {
      profile = profiles.find((entry) => String(entry?.launch_command || "").includes(slotLabel));
    }
    if (!profile && probe.up) {
      profile = profiles.find((entry) =>
        probe.model_ids.some((modelId) => modelIdsMatch(modelId, entry?.model_id)));
    }
    return {
      lane_id: "large",
      up: probe.up,
      host_id: lane.host_id || "spark",
      port: lane.port || 8000,
      base_url: baseUrl,
      model_ids: probe.model_ids,
      profile: profile || null,
      slot_label: slotLabel,
    };
  }

  async function resolveMiniLaneCurrent(config) {
    const lane = config.lanes?.mini || {};
    const baseUrl = `http://${config.hosts?.spark?.public_host || "127.0.0.1"}:${lane.port || 7999}`;
    const probe = await probeRuntime(`http://127.0.0.1:${lane.port || 7999}`);
    const localSlot = await readJson(localMiniSlotPath, {});
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    let profile = profiles.find((entry) => String(entry?.profile_id || "") === String(localSlot?.profile_id || ""));
    if (!profile && probe.up) {
      profile = profiles.find((entry) =>
        probe.model_ids.some((modelId) => modelIdsMatch(modelId, entry?.model_id)));
    }
    return {
      lane_id: "mini",
      up: probe.up,
      host_id: lane.host_id || "spark",
      port: lane.port || 7999,
      base_url: baseUrl,
      model_ids: probe.model_ids,
      profile: profile || null,
      slot_label: String(localSlot?.slot_label || "").trim(),
    };
  }

  function profileById(config, profileId) {
    return (config.profiles || []).find((entry) => String(entry?.profile_id || "") === String(profileId || ""));
  }

  function selectionRole(profile) {
    return String(profile?.selection_role || "cli_candidate");
  }

  function adapterForProfile(config, profile) {
    const laneId = String(profile?.default_lane || "large");
    const lane = config.lanes?.[laneId] || {};
    const host = config.hosts?.[lane.host_id || "spark"] || {};
    return buildAdapter(
      profile?.runtime_family || "unknown",
      `http://${host.public_host || "127.0.0.1"}:${lane.port || 8000}`,
      profile?.notes || "",
    );
  }

  function laneStatePayload(config, laneState) {
    const profile = laneState.profile;
    return {
      lane_id: laneState.lane_id,
      up: laneState.up,
      host_id: laneState.host_id,
      host_display_name: config.hosts?.[laneState.host_id]?.display_name || laneState.host_id,
      port: laneState.port,
      base_url: laneState.base_url,
      model_ids: laneState.model_ids,
      profile_id: profile?.profile_id || "",
      display_name: profile?.display_name || "",
      model_id: profile?.model_id || (laneState.model_ids[0] || ""),
      runtime_family: profile?.runtime_family || "unknown",
      size_class: profile?.size_class || "",
      selection_role: profile ? selectionRole(profile) : "",
      cli_selectable: Boolean(profile?.cli_selectable),
      requires_both_boxes: Boolean(profile?.requires_both_boxes),
      backing_hosts: profile?.backing_hosts || [],
      adapter: profile ? adapterForProfile(config, profile) : buildAdapter("unknown", laneState.base_url, "No active profile detected."),
      startup_expectation: profile?.startup_expectation || null,
    };
  }

  async function currentState() {
    const config = await loadConfig();
    const largeLane = await resolveLargeLaneCurrent(config);
    const miniLane = await resolveMiniLaneCurrent(config);
    const largePayload = laneStatePayload(config, largeLane);
    const miniPayload = laneStatePayload(config, miniLane);
    return {
      ok: true,
      generated_at: isoNow(),
      controller: {
        name: config.controller?.name || "LLMCommune",
        base_url: config.controller?.public_base_url || "http://192.168.1.203:4000",
        port: config.controller?.port || 4000,
      },
      hosts: config.hosts,
      lanes: {
        large: largePayload,
        mini: miniPayload,
      },
      active_profiles: [largePayload, miniPayload].filter((entry) => entry.up && entry.profile_id),
      cli_target: largePayload.up && largePayload.profile_id ? {
        lane_id: "large",
        profile_id: largePayload.profile_id,
        model_id: largePayload.model_id,
        base_url: largePayload.base_url,
        adapter: largePayload.adapter,
      } : miniPayload.up && miniPayload.profile_id ? {
        lane_id: "mini",
        profile_id: miniPayload.profile_id,
        model_id: miniPayload.model_id,
        base_url: miniPayload.base_url,
        adapter: miniPayload.adapter,
      } : null,
    };
  }

  async function modelsState() {
    const config = await loadConfig();
    const inventory = await collectInventory(config);
    const current = await currentState();
    const currentLarge = current.lanes.large;
    const currentMini = current.lanes.mini;
    const profiles = (config.profiles || []).map((profile) => {
      const inventoryRow = inventory.find((row) => String(row.model_id) === String(profile.model_id));
      const installedOn = inventoryRow?.installed_on || "missing";
      const defaultLane = String(profile.default_lane || "large");
      const lane = config.lanes?.[defaultLane] || {};
      const currentLane = defaultLane === "large" ? currentLarge : currentMini;
      const currentOther = defaultLane === "large" ? currentMini : currentLarge;
      const sameProfile = currentLane.profile_id && currentLane.profile_id === profile.profile_id;
      const blockedBy = [];
      const wouldPreempt = [];
      if (currentLane.profile_id && !sameProfile) {
        blockedBy.push(currentLane.profile_id);
        wouldPreempt.push(currentLane.profile_id);
      }
      const conflictsOtherLane = false;
      if (conflictsOtherLane) {
        blockedBy.push(currentOther.profile_id);
        wouldPreempt.push(currentOther.profile_id);
      }
      const launchableNow = installedOn !== "missing" && blockedBy.length === 0;
      return {
        ...profile,
        installed_on: installedOn,
        launchable_now: launchableNow || sameProfile,
        blocked_by: Array.from(new Set(blockedBy)),
        would_preempt: Array.from(new Set(wouldPreempt)),
        current_status: sameProfile ? "running" : "idle",
        adapter: adapterForProfile(config, profile),
        serving_port: lane.port || 8000,
        health_endpoints: {
          health_url: `http://${config.hosts?.[lane.host_id || "spark"]?.public_host || "127.0.0.1"}:${lane.port || 8000}/health`,
          models_url: `http://${config.hosts?.[lane.host_id || "spark"]?.public_host || "127.0.0.1"}:${lane.port || 8000}/v1/models`,
        },
      };
    });
    return {
      ok: true,
      generated_at: isoNow(),
      controller: config.controller,
      hosts: config.hosts,
      lanes: config.lanes,
      profiles,
      inventory_models: inventory,
    };
  }

  async function helpState() {
    const config = await loadConfig();
    return {
      ok: true,
      generated_at: isoNow(),
      controller: config.controller,
      source_of_truth: {
        static_models_json: path.join(repoRoot, "src", "config", "models.json"),
        live_models_endpoint: "/api/llm-host/models",
        live_current_endpoint: "/api/llm-host/current",
      },
      lane_policy: {
        summary: "At most two active profiles: one on the large lane (8000) and one on the mini lane (7999). The mini lane may only host mini models. Large models may never run on both lanes at the same time.",
        large_lane: config.lanes?.large,
        mini_lane: config.lanes?.mini,
      },
      actions: {
        activate: {
          method: "POST",
          path: "/api/llm-host/activate",
          body: {
            profile_id: "required",
            lane_id: "optional; defaults to the profile's default lane",
            wait: "optional boolean",
            allow_preempt: "optional boolean, default true"
          }
        },
        restart: {
          method: "POST",
          path: "/api/llm-host/actions/restart",
          body: {
            lane_id: "required: large or mini"
          }
        },
        stop: {
          method: "POST",
          path: "/api/llm-host/actions/stop",
          body: {
            lane_id: "required: large, mini, or all"
          }
        },
        bonzai: {
          method: "POST",
          path: "/bonzai",
          body: {},
          effect: "Stops both lanes and launches CoderNext on the large lane."
        }
      },
      runtime_adapters: {
        trtllm: buildAdapter("trtllm", "http://192.168.1.203:8000", "OpenAI-compatible TensorRT-LLM lane."),
        "llama.cpp": buildAdapter("llama.cpp", "http://192.168.1.203:7999", "OpenAI-compatible llama.cpp lane."),
        vllm: buildAdapter("vllm", "http://192.168.1.203:8000", "OpenAI-compatible vLLM lane."),
        litellm: buildAdapter("litellm", "http://192.168.1.203:8000", "OpenAI-compatible LiteLLM proxy lane."),
        ollama: buildAdapter("ollama", "http://192.168.1.203:11434", "Ollama-native lane."),
      },
      notes: [
        "If the requested profile is already up on its lane, activate returns ready immediately without restarting it.",
        "Large dual-box profiles reserve both GX10 boxes but still serve through spark on :8000.",
        "Use the live JSON endpoints over docs when there is any mismatch.",
      ],
    };
  }

  async function stopLane(laneId) {
    const lane = String(laneId || "").trim().toLowerCase();
    if (lane === "large") {
      return runCommand(`bash ${shellQuote(path.join(repoRoot, "scripts", "stop_large_lane.sh"))}`, 300000);
    }
    if (lane === "mini") {
      return runCommand(`bash ${shellQuote(path.join(repoRoot, "scripts", "stop_mini_lane.sh"))}`, 120000);
    }
    if (lane === "all") {
      const first = await stopLane("mini");
      const second = await stopLane("large");
      return {
        ok: Boolean(first.ok && second.ok),
        stdout: `${first.stdout || ""}\n${second.stdout || ""}`.trim(),
        stderr: `${first.stderr || ""}\n${second.stderr || ""}`.trim(),
        error: first.ok && second.ok ? "" : `${first.error || ""} ${second.error || ""}`.trim(),
      };
    }
    return { ok: false, error: `unknown lane ${laneId}` };
  }

  async function waitForReady(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const probe = await probeRuntime(`http://127.0.0.1:${port}`);
      if (probe.up) return true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  }

  function setJob(jobId, patch) {
    const current = jobs.get(jobId) || {};
    jobs.set(jobId, {
      ...current,
      ...patch,
      updated_at: isoNow(),
      elapsed_s: current.started_at_ms ? Number(((Date.now() - current.started_at_ms) / 1000).toFixed(1)) : 0,
    });
  }

  async function activate({ profileId, laneId = "", wait = false, allowPreempt = true } = {}) {
    const config = await loadConfig();
    const profile = profileById(config, profileId);
    if (!profile) {
      return { ok: false, accepted: false, detail: `unknown profile_id ${profileId}` };
    }
    const selectedLane = String(laneId || profile.default_lane || "large");
    if (!profile.allowed_lanes?.includes(selectedLane)) {
      return {
        ok: false,
        accepted: false,
        detail: `${profile.profile_id} cannot run on lane ${selectedLane}`,
      };
    }
    const current = await currentState();
    const currentLane = current.lanes[selectedLane];
    if (currentLane?.profile_id === profile.profile_id && currentLane?.up) {
      const adapter = adapterForProfile(config, profile);
      return {
        ok: true,
        accepted: true,
        status: "ready",
        requested_profile_id: profile.profile_id,
        lane_id: selectedLane,
        expected_adapter: adapter,
        expected_catalog_url: adapter.models_url,
        startup_expectation: profile.startup_expectation,
        status_detail: "requested profile already active",
      };
    }
    if (!allowPreempt && currentLane?.profile_id && currentLane.profile_id !== profile.profile_id) {
      return {
        ok: false,
        accepted: false,
        detail: `${selectedLane} lane is occupied by ${currentLane.profile_id}`,
      };
    }
    const jobId = randomUUID();
    const adapter = adapterForProfile(config, profile);
    const job = {
      ok: true,
      accepted: true,
      job_id: jobId,
      requested_profile_id: profile.profile_id,
      lane_id: selectedLane,
      expected_runtime: profile.runtime_family,
      expected_adapter: adapter,
      expected_catalog_url: adapter.models_url,
      startup_expectation: profile.startup_expectation,
      current_phase: "queued",
      status: "queued",
      started_at_ms: Date.now(),
      updated_at: isoNow(),
    };
    jobs.set(jobId, job);
    const launch = async () => {
      try {
        setJob(jobId, { status: "running", current_phase: "stopping_conflicts" });
        if (allowPreempt) {
          await stopLane(selectedLane);
        }
        setJob(jobId, { current_phase: "starting_runtime" });
        const result = await runCommand(profile.launch_command, (profile.startup_expectation?.ready_timeout_s || 900) * 1000);
        if (!result.ok) {
          setJob(jobId, { status: "failed", current_phase: "failed", status_detail: result.error || result.stderr || "launch failed" });
          return;
        }
        setJob(jobId, { current_phase: "waiting_for_api" });
        const lanePort = config.lanes?.[selectedLane]?.port || 8000;
        const ready = await waitForReady(lanePort, (profile.startup_expectation?.ready_timeout_s || 900) * 1000);
        if (!ready) {
          setJob(jobId, { status: "failed", current_phase: "failed", status_detail: "runtime did not become ready" });
          return;
        }
        setJob(jobId, { status: "ready", current_phase: "ready", status_detail: "runtime ready" });
      } catch (error) {
        setJob(jobId, { status: "failed", current_phase: "failed", status_detail: String(error?.message || error || "activation failed") });
      }
    };
    if (wait) {
      await launch();
      return jobs.get(jobId);
    }
    launch();
    return jobs.get(jobId);
  }

  async function restartLane(laneId) {
    const current = await currentState();
    const lane = current.lanes?.[laneId];
    if (!lane?.profile_id) {
      return { ok: false, detail: `no active profile on ${laneId}` };
    }
    return activate({ profileId: lane.profile_id, laneId, wait: true, allowPreempt: true });
  }

  async function bonzai() {
    const config = await loadConfig();
    await stopLane("all");
    return activate({
      profileId: config.controller?.bonzai_profile_id || "gguf_coder_next_large",
      laneId: "large",
      wait: true,
      allowPreempt: true,
    });
  }

  async function writeInventorySnapshot() {
    const payload = {
      generated_at: isoNow(),
      current: await currentState(),
      models: await modelsState(),
    };
    const outputPath = path.join(repoRoot, "workspace", "current", "models.live.json");
    await writeJson(outputPath, payload);
    return payload;
  }

  return {
    getHelp: helpState,
    getCurrent: currentState,
    listModels: modelsState,
    activate,
    restartLane,
    stopLane,
    bonzai,
    getJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) return { ok: false, detail: "job not found" };
      return { ok: true, ...job };
    },
    writeInventorySnapshot,
  };
}
