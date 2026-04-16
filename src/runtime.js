// @ts-check
import { exec as execCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, copyFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger.js";
import { ErrorCode, apiError } from "./errors.js";

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

/** Write JSON atomically: write to .tmp, then rename into place. */
async function writeJson(filePath, payload) {
  const tmpPath = `${filePath}.tmp`;
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await rename(tmpPath, filePath);
}

/** Append a completed job to the JSONL history file. */
async function appendJobHistory(historyPath, job) {
  await mkdir(path.dirname(historyPath), { recursive: true });
  await appendFile(historyPath, JSON.stringify(job) + "\n", "utf-8");
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

function runDetachedCommand(command, cwd) {
  try {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: { ...process.env },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return {
      ok: false,
      pid: 0,
      error: String(error?.message || error || "failed to launch detached command"),
    };
  }
}

async function fetchJson(url, timeoutMs = 3000, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, status: response.status, body: null };
    return { ok: true, status: response.status, body: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message || error || "fetch failed") };
  }
}

async function probeRuntime(baseUrl, fetchJsonImpl = fetchJson) {
  const models = await fetchJsonImpl(`${normalizeBaseUrl(baseUrl)}/v1/models`, 2500);
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
  const health = await fetchJsonImpl(`${normalizeBaseUrl(baseUrl)}/health`, 1500);
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
  workerSsh = "admin@192.168.1.204",
  workerSshOptions = "-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -i /home/admin/.ssh/trtllm_ed25519",
  dependencies = {},
  paths = {},
} = {}) {
  const runCommandImpl = dependencies.runCommand || runCommand;
  const runDetachedCommandImpl = dependencies.runDetachedCommand || runDetachedCommand;
  const fetchJsonImpl = dependencies.fetchJson || fetchJson;
  const probeRuntimeImpl = dependencies.probeRuntime || ((baseUrl) => probeRuntime(baseUrl, fetchJsonImpl));
  const readJsonImpl = dependencies.readJson || readJson;
  const writeJsonImpl = dependencies.writeJson || writeJson;
  const sleepImpl = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowMs = dependencies.nowMs || (() => Date.now());
  const uuid = dependencies.uuid || randomUUID;
  const configPath = paths.configPath || path.join(repoRoot, "src", "config", "models.json");
  const stateRoot = paths.stateRoot || path.join(repoRoot, "workspace", "runtime");
  const jobsStateRoot = paths.jobsStateRoot || path.join(repoRoot, "workspace", "jobs", "_lanes");
  const localLargeSlotPath = paths.localLargeSlotPath || path.join(stateRoot, "large_slot.json");
  const localMiniSlotPath = paths.localMiniSlotPath || path.join(stateRoot, "mini_slot.json");
  const desiredStatePath = paths.desiredStatePath || path.join(stateRoot, "desired_state.json");
  const activeManagedSlotPath = paths.activeManagedSlotPath || path.join(jobsStateRoot, "active_slot.json");
  const jobHistoryPath = paths.jobHistoryPath || path.join(stateRoot, "job_history.jsonl");
  const auditLogPath = paths.auditLogPath || path.join(stateRoot, "activation_audit.jsonl");
  const webhookUrl = process.env.LLMCOMMUNE_WEBHOOK_URL || "";
  const jobTtlMs = Number(process.env.LLMCOMMUNE_JOB_TTL_MS || 3600000);
  const jobs = new Map();
  let cache = { ts: 0, value: null };
  const currentIso = () => new Date(nowMs()).toISOString();

  // Per-lane activation mutex — prevents two concurrent activations on the same lane.
  const laneLocks = new Map();

  // Set-level activation guard — one activate-set at a time.
  let _activating = false;
  let _activatingSetId = "";
  let _activatingStartMs = 0;

  /** @param {string} laneId @param {() => Promise<unknown>} fn */
  async function withLaneLock(laneId, fn) {
    const prev = laneLocks.get(laneId) || Promise.resolve();
    let releaseLock;
    const next = new Promise((resolve) => { releaseLock = resolve; });
    laneLocks.set(laneId, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      releaseLock?.();
    }
  }

  // Prometheus-style counters (in-memory, exported via /metrics).
  const metrics = {
    activations_total: 0,
    activations_failed: 0,
    activations_ready: 0,
    activation_duration_ms: [],
    probe_failures_total: 0,
  };

  // Job GC: expire completed/failed jobs older than jobTtlMs.
  if (!dependencies.disableJobGc) {
    const gcInterval = setInterval(() => {
      const cutoff = nowMs() - jobTtlMs;
      for (const [jobId, job] of jobs) {
        if (["ready", "failed"].includes(String(job?.status || "")) && Number(job?.started_at_ms || 0) < cutoff) {
          jobs.delete(jobId);
        }
      }
    }, Math.max(60000, jobTtlMs / 4));
    if (gcInterval.unref) gcInterval.unref();
  }

  function defaultDesiredState() {
    return {
      mode: "idle",
      state: "idle",
      watchdog_enforce: false,
        lane_targets: {
          large: "",
          mini: "",
        },
        fleet_id: "",
        status_detail: "",
      updated_at: currentIso(),
    };
  }

  async function loadConfig() {
    return readJsonImpl(configPath, {});
  }

  /** Validate essential config fields. Throws with a clear message on failure. */
  function validateConfig(config) {
    const required = ["controller", "hosts", "lanes", "profiles"];
    const missing = required.filter((key) => !config[key]);
    if (missing.length > 0) {
      throw new Error(`Config validation failed — missing required fields: ${missing.join(", ")}. Check ${configPath}`);
    }
    if (!Array.isArray(config.profiles) || config.profiles.length === 0) {
      throw new Error("Config validation failed — profiles must be a non-empty array.");
    }
    if (!config.lanes?.large || !config.lanes?.mini) {
      throw new Error("Config validation failed — config.lanes must define both 'large' and 'mini'.");
    }
    if (config.controller?.activation_sets && !Array.isArray(config.controller.activation_sets)) {
      throw new Error("Config validation failed — controller.activation_sets must be an array when present.");
    }
  }

  let _validatedConfig = null;
  /** Load and validate config, caching the validated result. */
  async function loadValidatedConfig() {
    if (_validatedConfig) return _validatedConfig;
    const config = await loadConfig();
    validateConfig(config);
    _validatedConfig = config;
    return config;
  }

  /** Call once at startup to eagerly validate config and log a warning for missing model paths. */
  async function startupChecks() {
    const config = await loadValidatedConfig();
    // Startup model-path existence checks.
    for (const profile of (config.profiles || [])) {
      const sparkPath = profile?.model_paths?.spark || "";
      if (sparkPath) {
        const result = await runCommandImpl(`[ -e ${shellQuote(sparkPath)} ]`, 15000);
        if (!result.ok) {
          logger.warn("startup: model path missing for profile", { profile_id: profile.profile_id, path: sparkPath });
        }
      }
    }
    // Startup reconciliation: if desired_state names an unknown active_set_id, null it out.
    const desiredState = await loadDesiredState();
    const knownSetIds = new Set((config.controller?.activation_sets || []).map((s) => String(s.set_id || "")));
    const storedSetId = String(desiredState.active_set_id || "").trim();
    if (storedSetId && !knownSetIds.has(storedSetId)) {
      logger.warn("startup: desired_state.active_set_id not in catalog — clearing", { active_set_id: storedSetId });
      await saveDesiredState({ ...desiredState, active_set_id: null });
    }
  }

  async function loadDesiredState() {
    const desired = await readJsonImpl(desiredStatePath, defaultDesiredState());
    return {
      ...defaultDesiredState(),
      ...desired,
      lane_targets: {
        ...defaultDesiredState().lane_targets,
        ...(desired?.lane_targets || {}),
      },
    };
  }

  async function saveDesiredState(nextState) {
    const payload = {
      ...defaultDesiredState(),
      ...(nextState || {}),
      lane_targets: {
        ...defaultDesiredState().lane_targets,
        ...(nextState?.lane_targets || {}),
      },
      updated_at: currentIso(),
    };
    // Backup previous state before overwriting.
    try {
      await copyFile(desiredStatePath, `${desiredStatePath}.bak`).catch(() => {});
    } catch { /* no existing file yet — skip */ }
    await writeJsonImpl(desiredStatePath, payload);
    // Invalidate inventory cache so /models reflects the new state immediately.
    cache = { ts: 0, value: null };
    return payload;
  }

  async function remotePathExists(remotePath) {
    const target = String(remotePath || "").trim();
    if (!target) return false;
    const result = await runCommandImpl(
      `ssh ${workerSshOptions} ${shellQuote(workerSsh)} ${shellQuote(`bash -lc ${shellQuote(`test -e ${shellQuote(target)}`)}`)}`,
      60000,
    );
    return Boolean(result.ok);
  }

  async function pathExists(localPath) {
    const target = String(localPath || "").trim();
    if (!target) return false;
    const result = await runCommandImpl(`[ -e ${shellQuote(target)} ]`, 15000);
    return Boolean(result.ok);
  }

  async function listContainers(remote = false) {
    const cmd = "docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'";
    const result = remote
      ? await runCommandImpl(`ssh ${workerSshOptions} ${shellQuote(workerSsh)} ${shellQuote(cmd)}`, 30000)
      : await runCommandImpl(cmd, 30000);
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

  async function workerPortResponsive(port, config) {
    const workerHost = config?.hosts?.gx10?.public_host || workerSsh.split("@")[1] || "192.168.1.204";
    const probe = await probeRuntimeImpl(`http://${workerHost}:${Number(port)}`);
    if (!probe.up) metrics.probe_failures_total++;
    return Boolean(probe.up);
  }

  async function workerClearState(config) {
    const remoteContainers = await listContainers(true);
    // Managed container names — pulled from config when available, with hardcoded fallback.
    const configManagedNames = Array.isArray(config?.managed_container_names) ? config.managed_container_names : [];
    const managedNames = new Set([
      "trtllm-multinode",
      "llm-shared",
      "coder-main-8000",
      "vllm",
      "llmcommune-worker-deepseek-7999",
      "coder-deepseek-7999",
      "llm-mini-7999",
      "llm-trt-mini-7999",
      ...configManagedNames,
    ]);
    const blockingContainers = remoteContainers
      .filter((entry) => managedNames.has(String(entry.name || "")))
      .map((entry) => String(entry.name || ""))
      .filter(Boolean);
    const responsivePorts = [];
    for (const port of [7999, 8000]) {
      if (await workerPortResponsive(port, config)) {
        responsivePorts.push(port);
      }
    }
    return {
      clear: blockingContainers.length === 0 && responsivePorts.length === 0,
      blocking_containers: blockingContainers,
      responsive_ports: responsivePorts,
    };
  }

  async function collectInventory(config) {
    const now = nowMs();
    if (cache.value && now - cache.ts < 30000) return cache.value;
    const rows = [];
    const inventoryPolicy = config.inventory_policy || {};
    for (const model of config.inventory_models || []) {
      const sparkPresent = await pathExists(model?.model_paths?.spark || "");
      const gx10Present = await remotePathExists(model?.model_paths?.gx10 || "");
      rows.push({
        ...model,
        ...(inventoryPolicy[String(model?.model_id || "")] || {}),
        installed_on: sparkPresent && gx10Present ? "both" : sparkPresent ? "spark" : gx10Present ? "gx10" : "missing",
        spark_present: sparkPresent,
        gx10_present: gx10Present,
      });
    }
    cache = { ts: now, value: rows };
    return rows;
  }

  function findProfileForLane(config, { slotLabel = "", modelSpec = "", probeModelIds = [] } = {}) {
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const normalizedSlotLabel = String(slotLabel || "").trim();
    const normalizedModelSpec = String(modelSpec || "").trim();

    let profile = profiles.find((entry) => String(entry?.profile_id || "") === normalizedSlotLabel);
    if (profile) return profile;

    if (normalizedSlotLabel) {
      profile = profiles.find((entry) => String(entry?.launch_command || "").includes(normalizedSlotLabel));
      if (profile) return profile;
    }

    if (normalizedModelSpec) {
      profile = profiles.find((entry) => {
        const sparkPath = String(entry?.model_paths?.spark || "").trim();
        const gx10Path = String(entry?.model_paths?.gx10 || "").trim();
        return sparkPath === normalizedModelSpec || gx10Path === normalizedModelSpec;
      });
      if (profile) return profile;
    }

    if (Array.isArray(probeModelIds) && probeModelIds.length > 0) {
      profile = profiles.find((entry) =>
        probeModelIds.some((modelId) => modelIdsMatch(modelId, entry?.model_id)));
      if (profile) return profile;
    }

    return null;
  }

  async function resolveLargeLaneCurrent(config) {
    const lane = config.lanes?.large || {};
    const baseUrl = `http://${config.hosts?.spark?.public_host || "127.0.0.1"}:${lane.port || 8000}`;
    const probe = await probeRuntimeImpl(`http://127.0.0.1:${lane.port || 8000}`);
    const localSlot = await readJsonImpl(localLargeSlotPath, {});
    const activeManagedSlot = await readJsonImpl(activeManagedSlotPath, {});
    const lanePort = Number(lane.port || 8000);
    const managedSlotMatchesLane = Number(activeManagedSlot?.port || 0) === lanePort;
    const localSlotPopulated = Boolean(localSlot?.profile_id || localSlot?.slot_label || localSlot?.model_spec);
    const managedSlotPopulated = Boolean(activeManagedSlot?.profile_id || activeManagedSlot?.slot_label || activeManagedSlot?.model_spec);
    const slotRecord = localSlotPopulated
      ? localSlot
      : managedSlotMatchesLane && managedSlotPopulated
        ? activeManagedSlot
        : localSlot;
    const slotLabel = String(
      (localSlotPopulated ? (localSlot?.profile_id || localSlot?.slot_label) : "") ||
      (managedSlotMatchesLane ? activeManagedSlot?.profile_id || activeManagedSlot?.slot_label : "") ||
      localSlot?.slot_label ||
      "",
    ).trim();
    const profile = findProfileForLane(config, {
      slotLabel,
      modelSpec: slotRecord?.model_spec || "",
      probeModelIds: probe.model_ids,
    });
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
    const probe = await probeRuntimeImpl(`http://127.0.0.1:${lane.port || 7999}`);
    const localSlot = await readJsonImpl(localMiniSlotPath, {});
    const activeManagedSlot = await readJsonImpl(activeManagedSlotPath, {});
    const lanePort = Number(lane.port || 7999);
    const managedSlotMatchesLane = Number(activeManagedSlot?.port || 0) === lanePort;
    const localSlotPopulated = Boolean(localSlot?.profile_id || localSlot?.slot_label || localSlot?.model_spec);
    const managedSlotPopulated = Boolean(activeManagedSlot?.profile_id || activeManagedSlot?.slot_label || activeManagedSlot?.model_spec);
    const slotRecord = localSlotPopulated
      ? localSlot
      : managedSlotMatchesLane && managedSlotPopulated
        ? activeManagedSlot
        : localSlot;
    const profile = findProfileForLane(config, {
      slotLabel: slotRecord?.profile_id || slotRecord?.slot_label || "",
      modelSpec: slotRecord?.model_spec || "",
      probeModelIds: probe.model_ids,
    });
    return {
      lane_id: "mini",
      up: probe.up,
      host_id: lane.host_id || "spark",
      port: lane.port || 7999,
      base_url: baseUrl,
      model_ids: probe.model_ids,
      profile: profile || null,
      slot_label: String(slotRecord?.slot_label || "").trim(),
    };
  }

  async function resolveFleetState(config) {
    const fleet = Array.isArray(config.fleet_profiles) ? config.fleet_profiles[0] || null : null;
    if (!fleet) {
      return {
        enabled: false,
        up: false,
        fleet_id: "",
        display_name: "",
        mode: "",
        members: [],
      };
    }
    const members = [];
    for (const member of fleet.members || []) {
      const host = config.hosts?.[member.host_id || "spark"] || {};
      const baseUrl = `http://${host.public_host || "127.0.0.1"}:${member.port || 7999}`;
      const probe = await probeRuntimeImpl(baseUrl);
      members.push({
        member_id: String(member.member_id || ""),
        profile_id: String(member.profile_id || ""),
        display_name: String(member.display_name || ""),
        model_id: String(member.model_id || (probe.model_ids[0] || "")),
        runtime_family: String(member.runtime_family || "unknown"),
        host_id: String(member.host_id || ""),
        host_display_name: host.display_name || member.host_id || "",
        host_public: host.public_host || "",
        port: Number(member.port || 7999),
        up: Boolean(probe.up),
        model_ids: probe.model_ids,
        base_url: baseUrl,
        adapter: buildAdapter(member.runtime_family || "unknown", baseUrl, "Mini fleet member."),
        call_target: {
          host_type: "single_box",
          host_pattern: `single-box on ${host.display_name || member.host_id || "host"}`,
          serving_host_id: member.host_id || "",
          serving_host_display_name: host.display_name || member.host_id || "",
          serving_port: Number(member.port || 7999),
          runtime_family: String(member.runtime_family || "unknown"),
          protocol: String((member.runtime_family || "").toLowerCase() === "llama.cpp" ? "openai_completions" : "openai_chat"),
          openai_compatible: true,
          base_url: baseUrl,
          health_url: `${baseUrl}/health`,
          models_url: `${baseUrl}/v1/models`,
          chat_url: `${baseUrl}/v1/chat/completions`,
          completions_url: `${baseUrl}/v1/completions`,
          model_field: "model",
        },
      });
    }
    return {
      enabled: true,
      up: members.length > 0 && members.every((member) => member.up),
      fleet_id: String(fleet.fleet_id || ""),
      display_name: String(fleet.display_name || ""),
      mode: String(fleet.mode || ""),
      selection_role: String(fleet.selection_role || ""),
      startup_expectation: fleet.startup_expectation || null,
      members,
      notes: fleet.notes || "",
    };
  }

  function profileById(config, profileId) {
    return (config.profiles || []).find((entry) => String(entry?.profile_id || "") === String(profileId || ""));
  }

  function activationSetById(config, setId) {
    return (config.controller?.activation_sets || [])
      .find((entry) => String(entry?.set_id || "") === String(setId || ""));
  }

  function profilePolicy(config, profileId) {
    return config.profile_policy?.[String(profileId || "")] || {};
  }

  function withProfilePolicy(config, profile) {
    if (!profile) return null;
    return {
      ...profile,
      ...profilePolicy(config, profile.profile_id),
    };
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

  function hostTypeForProfile(profile) {
    return profile?.requires_both_boxes ? "dual_box" : "single_box";
  }

  function servingHostIdForProfile(config, profile) {
    const laneId = String(profile?.default_lane || "large");
    return config.lanes?.[laneId]?.host_id || "spark";
  }

  function hostPatternForProfile(config, profile) {
    const backingHosts = Array.isArray(profile?.backing_hosts) ? profile.backing_hosts : [];
    const names = backingHosts
      .map((hostId) => config.hosts?.[hostId]?.display_name || String(hostId || "").trim())
      .filter(Boolean);
    if (profile?.requires_both_boxes) {
      return `dual-box on ${names.join(" + ") || "spark + gx10"}`;
    }
    return `single-box on ${names[0] || config.hosts?.[servingHostIdForProfile(config, profile)]?.display_name || "spark"}`;
  }

  function callTargetForProfile(config, profile) {
    const adapter = adapterForProfile(config, profile);
    const laneId = String(profile?.default_lane || "large");
    const lane = config.lanes?.[laneId] || {};
    const hostId = servingHostIdForProfile(config, profile);
    const host = config.hosts?.[hostId] || {};
    return {
      host_type: hostTypeForProfile(profile),
      host_pattern: hostPatternForProfile(config, profile),
      serving_host_id: hostId,
      serving_host_display_name: host.display_name || hostId,
      serving_port: lane.port || 8000,
      runtime_family: profile?.runtime_family || "unknown",
      protocol: adapter.protocol,
      openai_compatible: Boolean(adapter.openai_compatible),
      base_url: adapter.base_url,
      health_url: adapter.health_url,
      models_url: adapter.models_url,
      chat_url: adapter.chat_url,
      completions_url: adapter.completions_url,
      model_field: adapter.model_field,
    };
  }

  function desiredReadyTimeoutMs(config, desiredState) {
    const desired = desiredState || {};
    if (String(desired.mode || "") === "fleet" && desired.fleet_id) {
      const fleet = (config.fleet_profiles || []).find((entry) => String(entry?.fleet_id || "") === String(desired.fleet_id || ""));
      return Number(fleet?.startup_expectation?.ready_timeout_s || 1200) * 1000;
    }
    const targetProfiles = [desired?.lane_targets?.large, desired?.lane_targets?.mini]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((profileId) => profileById(config, profileId))
      .filter(Boolean);
    const readyTimeoutMs = targetProfiles.reduce((maxTimeoutMs, profile) => {
      const timeoutMs = Number(profile?.startup_expectation?.ready_timeout_s || 900) * 1000;
      return Math.max(maxTimeoutMs, timeoutMs);
    }, 0);
    return readyTimeoutMs || 900000;
  }

  function normalizeDesiredState(config, desiredState, snapshot) {
    const desired = {
      ...defaultDesiredState(),
      ...(desiredState || {}),
      lane_targets: {
        ...defaultDesiredState().lane_targets,
        ...(desiredState?.lane_targets || {}),
      },
    };
    let changed = false;
    let normalized = desired;

    const largeTarget = String(desired?.lane_targets?.large || "").trim();
    const miniTarget = String(desired?.lane_targets?.mini || "").trim();
    const fleetTarget = String(desired?.fleet_id || "").trim();
    const desiredUpdatedAtMs = Date.parse(String(desired.updated_at || ""));
    const ageMs = Number.isFinite(desiredUpdatedAtMs) ? Math.max(0, nowMs() - desiredUpdatedAtMs) : 0;
    const timeoutMs = desiredReadyTimeoutMs(config, desired) + 60000;
    const largeUp = Boolean(snapshot?.large?.up);
    const miniUp = Boolean(snapshot?.mini?.up);
    const fleetUp = Boolean(snapshot?.fleet?.up);
    const anyUp = largeUp || miniUp || fleetUp;

    const apply = (patch) => {
      changed = true;
      normalized = {
        ...desired,
        ...patch,
        lane_targets: {
          ...defaultDesiredState().lane_targets,
          ...(desired.lane_targets || {}),
          ...(patch?.lane_targets || {}),
        },
        updated_at: currentIso(),
      };
    };

    if (String(desired.mode || "") === "lane") {
      const wantsLaneTargets = Boolean(largeTarget || miniTarget);
      const largeMatches = !largeTarget || (largeUp && String(snapshot?.large?.profile_id || "") === largeTarget);
      const miniMatches = !miniTarget || (miniUp && String(snapshot?.mini?.profile_id || "") === miniTarget);
      const unexpectedLarge = !largeTarget && largeUp;
      const unexpectedMini = !miniTarget && miniUp;
      if (
        wantsLaneTargets &&
        largeMatches &&
        miniMatches &&
        !unexpectedLarge &&
        !unexpectedMini &&
        !fleetUp &&
        (
          String(desired.state || "") !== "ready" ||
          !desired.watchdog_enforce ||
          String(desired.mode || "") !== "lane" ||
          String(desired.fleet_id || "") !== ""
        )
      ) {
        const statusDetail = largeTarget && miniTarget
          ? `${largeTarget} ready on large + ${miniTarget} ready on mini`
          : largeTarget
            ? `${largeTarget} ready on large`
            : `${miniTarget} ready on mini`;
        apply({
          state: "ready",
          watchdog_enforce: true,
          fleet_id: "",
          status_detail: statusDetail,
        });
      }
    }

    // Reality correction: when a lane IS up but serving a different profile than
    // desired_state records, correct lane_targets + active_set_id to truth before
    // returning — so no stale data ever leaves the controller.
    if (!changed && String(desired.mode || "") === "lane") {
      const largeActual = largeUp ? String(snapshot?.large?.profile_id || "") : "";
      const miniActual  = miniUp  ? String(snapshot?.mini?.profile_id  || "") : "";
      // Diverged: running profile differs from desired target (only when identifiable)
      const largeDiverged = largeUp && largeActual && largeActual !== largeTarget;
      const miniDiverged  = (miniUp && miniActual && miniActual !== miniTarget) ||
                            (!miniTarget && miniUp && miniActual); // unexpected mini
      if (largeDiverged || miniDiverged) {
        const correctedLarge = (largeUp && largeActual) ? largeActual : largeTarget;
        const correctedMini  = (miniUp  && miniActual)  ? miniActual  : miniTarget;
        // Find a known set that matches the corrected reality
        const matchingSet = (config.controller?.activation_sets || []).find((s) => {
          const sl = String(s.lane_targets?.large || "");
          const sm = String(s.lane_targets?.mini  || "");
          return sl === correctedLarge && sm === correctedMini;
        });
        const parts = [
          correctedLarge && `${correctedLarge} on large`,
          correctedMini  && `${correctedMini} on mini`,
        ].filter(Boolean);
        logger.warn("desired_state diverged from reality — correcting", {
          desired_large: largeTarget,    actual_large: largeActual,
          desired_mini:  miniTarget,     actual_mini:  miniActual,
          corrected_set_id: matchingSet?.set_id ?? null,
        });
        apply({
          state: "ready",
          watchdog_enforce: true,
          fleet_id: "",
          active_set_id: matchingSet?.set_id ?? null,
          lane_targets: { large: correctedLarge, mini: correctedMini },
          status_detail: `corrected from reality: ${parts.join(" + ")}`,
        });
      }
    }

    if (
      !changed &&
      String(desired.mode || "") === "fleet" &&
      fleetTarget &&
      fleetUp &&
      String(snapshot?.fleet?.fleet_id || "") === fleetTarget &&
      !largeUp &&
      !miniUp &&
      (
        String(desired.state || "") !== "ready" ||
        !desired.watchdog_enforce
      )
    ) {
      apply({
        state: "ready",
        watchdog_enforce: true,
        status_detail: `fleet ${fleetTarget} ready`,
      });
    }

    if (!changed && ["starting", "stopping", "running"].includes(String(desired.state || "")) && !anyUp && ageMs > timeoutMs) {
      apply({
        state: "failed",
        watchdog_enforce: false,
        status_detail: desired.status_detail || "desired state expired without an active runtime",
      });
    }

    if (!changed && !anyUp && !largeTarget && !miniTarget && !fleetTarget &&
      (String(desired.mode || "") !== "idle" || String(desired.state || "") !== "idle" || Boolean(desired.watchdog_enforce))) {
      changed = true;
      normalized = {
        ...defaultDesiredState(),
        updated_at: currentIso(),
      };
    }

    return { desiredState: normalized, changed };
  }

  function laneStatePayload(config, laneState) {
    const profile = laneState.up ? withProfilePolicy(config, laneState.profile) : null;
    const modelIds = Array.isArray(laneState?.model_ids) ? laneState.model_ids : [];
    const adapter = profile ? adapterForProfile(config, profile) : buildAdapter("unknown", laneState.base_url, "No active profile detected.");
    const callTarget = profile ? callTargetForProfile(config, profile) : {
      host_type: "single_box",
      host_pattern: `single-box on ${config.hosts?.[laneState.host_id]?.display_name || laneState.host_id}`,
      serving_host_id: laneState.host_id,
      serving_host_display_name: config.hosts?.[laneState.host_id]?.display_name || laneState.host_id,
      serving_port: laneState.port,
      runtime_family: profile?.runtime_family || "unknown",
      protocol: adapter.protocol,
      openai_compatible: Boolean(adapter.openai_compatible),
      base_url: adapter.base_url,
      health_url: adapter.health_url,
      models_url: adapter.models_url,
      chat_url: adapter.chat_url,
      completions_url: adapter.completions_url,
      model_field: adapter.model_field,
    };
    return {
      lane_id: laneState.lane_id,
      up: laneState.up,
      host_id: laneState.host_id,
      host_display_name: config.hosts?.[laneState.host_id]?.display_name || laneState.host_id,
      port: laneState.port,
      base_url: laneState.base_url,
      model_ids: modelIds,
      profile_id: profile?.profile_id || "",
      display_name: profile?.display_name || "",
      model_id: profile?.model_id || (modelIds[0] || ""),
      runtime_family: profile?.runtime_family || "unknown",
      host_type: profile ? hostTypeForProfile(profile) : callTarget.host_type,
      host_pattern: profile ? hostPatternForProfile(config, profile) : callTarget.host_pattern,
      size_class: profile?.size_class || "",
      selection_role: profile ? selectionRole(profile) : "",
      cli_selectable: Boolean(profile?.cli_selectable),
      requires_both_boxes: Boolean(profile?.requires_both_boxes),
      backing_hosts: profile?.backing_hosts || [],
      support_status: profile?.support_status || "",
      evidence_level: profile?.evidence_level || "",
      recommended_action: profile?.recommended_action || "",
      official_max_context_tokens: profile?.official_max_context_tokens ?? null,
      recommended_context_tokens: profile?.recommended_context_tokens ?? null,
      recommended_container: profile?.recommended_container || "",
      runtime_notes: profile?.runtime_notes || "",
      adapter,
      call_target: callTarget,
      startup_expectation: profile?.startup_expectation || null,
    };
  }

  async function currentState() {
    const config = await loadValidatedConfig();
    const largeLane = await resolveLargeLaneCurrent(config);
    const miniLane = await resolveMiniLaneCurrent(config);
    const fleet = await resolveFleetState(config);
    const largePayload = laneStatePayload(config, largeLane);
    const miniPayload = laneStatePayload(config, miniLane);
    const loadedDesiredState = await loadDesiredState();
    const normalizedDesired = normalizeDesiredState(config, loadedDesiredState, {
      large: largePayload,
      mini: miniPayload,
      fleet,
    });
    const desiredState = normalizedDesired.changed
      ? await saveDesiredState(normalizedDesired.desiredState)
      : normalizedDesired.desiredState;
    return {
      ok: true,
      generated_at: currentIso(),
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
      mini_fleet: fleet,
      desired_state: desiredState,
      watchdog: {
        service_unit: "llmcommune-watchdog.service",
        controller_service_unit: "llmcommune-controller.service",
        policy: "Controller is always supervised. Lane and fleet restarts happen only when desired_state.watchdog_enforce=true and state=ready.",
      },
      active_profiles: [largePayload, miniPayload].filter((entry) => entry.up && entry.profile_id),
      cli_target: largePayload.up && largePayload.profile_id ? {
        lane_id: "large",
        profile_id: largePayload.profile_id,
        model_id: largePayload.model_id,
        base_url: largePayload.base_url,
        adapter: largePayload.adapter,
        host_type: largePayload.host_type,
        host_pattern: largePayload.host_pattern,
        call_target: largePayload.call_target,
      } : miniPayload.up && miniPayload.profile_id ? {
        lane_id: "mini",
        profile_id: miniPayload.profile_id,
        model_id: miniPayload.model_id,
        base_url: miniPayload.base_url,
        adapter: miniPayload.adapter,
        host_type: miniPayload.host_type,
        host_pattern: miniPayload.host_pattern,
        call_target: miniPayload.call_target,
      } : fleet.up && fleet.members[0] ? {
        lane_id: "mini_fleet",
        profile_id: fleet.members[0].profile_id,
        model_id: fleet.members[0].model_id,
        base_url: fleet.members[0].base_url,
        adapter: fleet.members[0].adapter,
        host_type: "fleet",
        host_pattern: fleet.display_name,
        call_target: fleet.members[0].call_target,
      } : null,
      fleet_targets: fleet.up ? fleet.members.map((member) => ({
        member_id: member.member_id,
        profile_id: member.profile_id,
        model_id: member.model_id,
        base_url: member.base_url,
        runtime_family: member.runtime_family,
        host_id: member.host_id,
        host_display_name: member.host_display_name,
        call_target: member.call_target,
      })) : [],
    };
  }

  async function modelsState() {
    const config = await loadValidatedConfig();
    const inventory = await collectInventory(config);
    const current = await currentState();
    const workerState = await workerClearState(config);
    const currentLarge = current.lanes.large;
    const currentMini = current.lanes.mini;
    const profiles = (config.profiles || []).map((rawProfile) => {
      const profile = withProfilePolicy(config, rawProfile);
      const inventoryRow = inventory.find((row) => String(row.model_id) === String(profile.model_id));
      const installedOn = inventoryRow?.installed_on || "missing";
      const defaultLane = String(profile.default_lane || "large");
      const lane = config.lanes?.[defaultLane] || {};
      const currentLane = defaultLane === "large" ? currentLarge : currentMini;
      const currentOther = defaultLane === "large" ? currentMini : currentLarge;
      const sameProfile = Boolean(currentLane.up && currentLane.profile_id && currentLane.profile_id === profile.profile_id);
      const blockedBy = [];
      const wouldPreempt = [];
      const adapter = adapterForProfile(config, profile);
      const callTarget = callTargetForProfile(config, profile);
      if (currentLane.up && currentLane.profile_id && !sameProfile) {
        blockedBy.push(currentLane.profile_id);
        wouldPreempt.push(currentLane.profile_id);
      }
      const conflictsOtherLane = Boolean(currentOther?.profile_id && currentOther?.up);
      if (conflictsOtherLane) {
        blockedBy.push(currentOther.profile_id);
        wouldPreempt.push(currentOther.profile_id);
      }
      if (current.mini_fleet?.up) {
        blockedBy.push(current.mini_fleet.fleet_id || "mini_fleet");
        wouldPreempt.push(current.mini_fleet.fleet_id || "mini_fleet");
      }
      if (profile.requires_both_boxes && !workerState.clear) {
        blockedBy.push("gx10_not_clear");
      }
      const launchableNow = installedOn !== "missing" && blockedBy.length === 0;
      return {
        ...profile,
        installed_on: installedOn,
        launchable_now: launchableNow || sameProfile,
        blocked_by: Array.from(new Set(blockedBy)),
        would_preempt: Array.from(new Set(wouldPreempt)),
        current_status: sameProfile ? "running" : "idle",
        host_type: hostTypeForProfile(profile),
        host_pattern: hostPatternForProfile(config, profile),
        adapter,
        call_target: callTarget,
        serving_port: lane.port || 8000,
        requires_worker_clear: Boolean(profile.requires_both_boxes),
        worker_clear_now: workerState.clear,
        worker_blocking_containers: workerState.blocking_containers,
        worker_responsive_ports: workerState.responsive_ports,
        health_endpoints: {
          health_url: `http://${config.hosts?.[lane.host_id || "spark"]?.public_host || "127.0.0.1"}:${lane.port || 8000}/health`,
          models_url: `http://${config.hosts?.[lane.host_id || "spark"]?.public_host || "127.0.0.1"}:${lane.port || 8000}/v1/models`,
        },
      };
    });
    return {
      ok: true,
      generated_at: currentIso(),
      controller: config.controller,
      hosts: config.hosts,
      lanes: config.lanes,
      desired_state: await loadDesiredState(),
      profiles,
      inventory_models: inventory,
      candidate_models: config.candidate_models || [],
      fleet_profiles: config.fleet_profiles || [],
    };
  }

  async function helpState() {
    const config = await loadValidatedConfig();
    const sparkHost = config.hosts?.spark?.public_host || "192.168.1.203";
    const activationSets = (config.controller?.activation_sets || []).map((entry) => ({
      set_id: String(entry?.set_id || ""),
      display_name: String(entry?.display_name || ""),
      description: String(entry?.description || ""),
      lane_targets: {
        large: String(entry?.lane_targets?.large || ""),
        mini: String(entry?.lane_targets?.mini || ""),
      },
    }));
    return {
      ok: true,
      generated_at: currentIso(),
      controller: config.controller,
      source_of_truth: {
        static_models_json: path.join(repoRoot, "src", "config", "models.json"),
        live_models_endpoint: "/api/llm-host/models",
        live_current_endpoint: "/api/llm-host/current",
        research_report: path.join(repoRoot, "modelstocheck.md"),
      },
      response_contract: {
        current_fields: [
          "runtime_family",
          "host_type",
          "host_pattern",
          "adapter",
          "call_target",
          "desired_state",
          "watchdog",
          "support_status",
          "recommended_action",
          "recommended_context_tokens",
          "recommended_container",
        ],
        models_fields: [
          "runtime_family",
          "host_type",
          "host_pattern",
          "adapter",
          "call_target",
          "selection_role",
          "cli_selectable",
          "support_status",
          "recommended_action",
          "recommended_context_tokens",
          "recommended_container",
        ],
      },
      lane_policy: {
        summary: "Normal lane mode supports one large profile on spark:8000 plus one mini profile on spark:7999 at the same time. Generic /activate preserves the current exclusive-swap behavior unless a coordinated activation set is used. Fleet mode is separate and may instead use spark:7999 plus gx10:7999 for one mini per box.",
        large_lane: config.lanes?.large,
        mini_lane: config.lanes?.mini,
      },
      watchdog_policy: {
        controller_service_unit: "llmcommune-controller.service",
        watchdog_service_unit: "llmcommune-watchdog.service",
        desired_state_path: desiredStatePath,
        behavior: [
          "The controller on :4000 is always supervised.",
          "Large or mini lanes are only restarted when desired_state says they should be up.",
          "During starting, stopping, or swapping states the watchdog does nothing to :8000 or :7999.",
          "Fleet mode is reconciled as a unit through /fleet/up and /fleet/down.",
        ],
      },
      actions: {
        activate: {
          method: "POST",
          path: "/api/llm-host/activate",
          body: {
            profile_id: "required",
            lane_id: "optional; defaults to the profile's default lane",
            wait: "optional boolean",
            allow_preempt: "optional boolean, default true",
            dry_run: "optional boolean — returns the activation plan without executing",
            override: "optional boolean — required to activate a manual_only_restore profile",
          }
        },
        activate_set: {
          method: "POST",
          path: "/api/llm-host/activate-set",
          body: {
            set_id: "required",
            wait: "optional boolean",
            allow_preempt: "optional boolean, default true",
            dry_run: "optional boolean — returns the coordinated activation plan without executing",
          },
          activation_sets: activationSets,
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
          effect: "Clears mini and fleet state, then launches CoderNext on :8000."
        },
        fleet_up: {
          method: "POST",
          path: "/fleet/up",
          body: {},
          effect: "Stops the large lane and brings up the default mini fleet: Qwen on spark:7999 plus DeepSeek on gx10:7999."
        },
        fleet_down: {
          method: "POST",
          path: "/fleet/down",
          body: {},
          effect: "Stops the mini fleet on both boxes without touching the large lane."
        }
      },
      runtime_adapters: {
        trtllm: buildAdapter("trtllm", `http://${sparkHost}:8000`, "OpenAI-compatible TensorRT-LLM lane."),
        "llama.cpp": buildAdapter("llama.cpp", `http://${sparkHost}:7999`, "OpenAI-compatible llama.cpp lane."),
        vllm: buildAdapter("vllm", `http://${sparkHost}:8000`, "OpenAI-compatible vLLM lane."),
        litellm: buildAdapter("litellm", `http://${sparkHost}:8000`, "OpenAI-compatible LiteLLM proxy lane."),
        ollama: buildAdapter("ollama", `http://${sparkHost}:11434`, "Ollama-native lane."),
      },
      troubleshooting: {
        reports: {
          models_to_check: path.join(repoRoot, "modelstocheck.md"),
          models_md: path.join(repoRoot, "models.md"),
        },
        lane_stop_rules: {
          large: "Generic large-lane activation stops fleet first and then replaces the large lane. By default it also clears the mini lane unless a coordinated activation set preserves it.",
          mini: "Generic mini-lane activation stops fleet first and then replaces only the mini lane. By default it also clears the large lane unless a coordinated activation set preserves it.",
          fleet: "Fleet mode runs one mini per box: spark:7999 for Qwen and gx10:7999 for DeepSeek. Starting a large profile tears the fleet down first.",
          all: "Use lane_id=all only for deliberate full teardown.",
        },
        runtime_families: {
          trtllm: {
            health_endpoints: [
              "/health",
              "/v1/models",
              "/v1/chat/completions",
            ],
            logs_root: path.join(repoRoot, "workspace", "jobs", "_lanes"),
            direct_checks: [
              `curl http://${sparkHost}:8000/v1/models`,
              `curl http://${sparkHost}:7999/v1/models`,
            ],
            stop_commands: [
              "bash /home/admin/apps/LLMCommune/scripts/stop_large_lane.sh",
              "bash /home/admin/apps/LLMCommune/scripts/stop_mini_lane.sh",
            ],
            known_quirks: [
              "TensorRT-LLM sometimes reports id='files' on /v1/models; trust the controller's canonical model_id and profile_id instead.",
              "Dual-box TRT on this pair is often more stable with NCCL_IB_DISABLE=1, which still uses the CX7 link as sockets rather than the 2.5GbE LAN.",
            ],
          },
          "llama.cpp": {
            health_endpoints: [
              "/health",
              "/v1/models",
              "/v1/chat/completions",
            ],
            stop_commands: [
              "bash /home/admin/apps/LLMCommune/scripts/stop_large_lane.sh",
              "bash /home/admin/apps/LLMCommune/scripts/stop_mini_lane.sh",
            ],
            known_quirks: [
              "GGUF single-box lanes are the safest bonzai/reset targets.",
            ],
          },
          vllm: {
            health_endpoints: [
              "/health",
              "/v1/models",
              "/v1/chat/completions",
            ],
            known_quirks: [
              "Current DGX Spark / GB10 vLLM NVFP4 support is still moving. Read modelstocheck.md before promoting any Spark vLLM lane to active status.",
              "Treat disaggregated serving and NIXL as research-only until a specific lane is explicitly promoted.",
            ],
          },
          ollama: {
            health_endpoints: [
              "/api/tags",
              "/api/chat",
              "/api/generate",
            ],
          },
          litellm: {
            health_endpoints: [
              "/health",
              "/v1/models",
            ],
          },
        },
      },
      notes: [
        "If the requested profile is already up on its lane, activate returns ready immediately without restarting it.",
        "Large dual-box profiles reserve both GX10 boxes but still serve through spark on :8000.",
        "The mini lane is reserved for <=32B profiles only and is the normal single-mini target.",
        "Lane mode can carry one large target plus one mini target simultaneously when desired_state tracks both lanes.",
        "Generic /activate keeps the existing exclusive swap semantics so existing callers are not surprised.",
        "Use /api/llm-host/activate-set for named combinations such as Gamenator lane pairings.",
        "Fleet mode is separate from the primary mini lane and is intended for one mini per box, not multiple 32B models on the same box.",
        "Use the live JSON endpoints over docs when there is any mismatch.",
      ],
    };
  }

  async function stopLane(laneId, { preserveDesiredState = false } = {}) {
    const lane = String(laneId || "").trim().toLowerCase();
    if (lane === "large") {
      const config = await loadValidatedConfig();
      const largePort = String(config.lanes?.large?.port || 8000);
      const result = await runCommandImpl(
        `LLMCOMMUNE_LARGE_PORT=${shellQuote(largePort)} bash ${shellQuote(path.join(repoRoot, "scripts", "stop_large_lane.sh"))}`,
        300000,
      );
      if (!preserveDesiredState) {
        const desired = await loadDesiredState();
        desired.lane_targets.large = "";
        if (!desired.lane_targets.mini && !desired.fleet_id) {
          desired.mode = "idle";
          desired.state = "idle";
          desired.watchdog_enforce = false;
        } else {
          desired.state = "ready";
        }
        desired.status_detail = "large lane stopped";
        await saveDesiredState(desired);
      }
      return result;
    }
    if (lane === "mini") {
      const config = await loadValidatedConfig();
      const miniPort = String(config.lanes?.mini?.port || 7999);
      const result = await runCommandImpl(
        `LLMCOMMUNE_MINI_PORT=${shellQuote(miniPort)} bash ${shellQuote(path.join(repoRoot, "scripts", "stop_mini_lane.sh"))}`,
        120000,
      );
      if (!preserveDesiredState) {
        const desired = await loadDesiredState();
        desired.lane_targets.mini = "";
        if (desired.mode === "fleet") {
          desired.fleet_id = "";
        }
        if (!desired.lane_targets.large && !desired.fleet_id) {
          desired.mode = "idle";
          desired.state = "idle";
          desired.watchdog_enforce = false;
        } else {
          desired.state = "ready";
        }
        desired.status_detail = "mini lane stopped";
        await saveDesiredState(desired);
      }
      return result;
    }
    if (lane === "all") {
      const first = await stopLane("mini", { preserveDesiredState });
      const second = await stopLane("large", { preserveDesiredState });
      if (!preserveDesiredState) {
        await saveDesiredState(defaultDesiredState());
      }
      return {
        ok: Boolean(first.ok && second.ok),
        stdout: `${first.stdout || ""}\n${second.stdout || ""}`.trim(),
        stderr: `${first.stderr || ""}\n${second.stderr || ""}`.trim(),
        error: first.ok && second.ok ? "" : `${first.error || ""} ${second.error || ""}`.trim(),
      };
    }
    return { ok: false, error: `unknown lane ${laneId}` };
  }

  async function stopFleet({ preserveDesiredState = false } = {}) {
    const config = await loadValidatedConfig();
    const result = await runCommandImpl(
      `LLMCOMMUNE_MINI_PORT=${shellQuote(String(config.lanes?.mini?.port || 7999))} LLMCOMMUNE_WORKER_MINI_PORT=${shellQuote(String(config.lanes?.mini?.port || 7999))} bash ${shellQuote(path.join(repoRoot, "scripts", "fleet_down.sh"))}`,
      180000,
    );
    if (!preserveDesiredState) {
      const desired = await loadDesiredState();
      desired.fleet_id = "";
      if (!desired.lane_targets.large && !desired.lane_targets.mini) {
        desired.mode = "idle";
        desired.state = "idle";
        desired.watchdog_enforce = false;
      } else {
        desired.mode = "lane";
        desired.state = "ready";
      }
      desired.status_detail = "fleet stopped";
      await saveDesiredState(desired);
    }
    return result;
  }

  async function persistLaneState(laneId, profile) {
    const lane = String(laneId || "").trim().toLowerCase();
    const filePath = lane === "mini" ? localMiniSlotPath : localLargeSlotPath;
    await writeJsonImpl(filePath, {
      lane_id: lane,
      profile_id: String(profile?.profile_id || ""),
      slot_label: String(profile?.profile_id || ""),
      model_id: String(profile?.model_id || ""),
      runtime_family: String(profile?.runtime_family || ""),
      updated_at: currentIso(),
    });
  }

  async function waitForReady(port, timeoutMs) {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      const probe = await probeRuntimeImpl(`http://127.0.0.1:${port}`);
      if (probe.up) return true;
      await sleepImpl(2000);
    }
    return false;
  }

  async function waitForFleet(config, targetUp, timeoutMs) {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      const fleet = await resolveFleetState(config);
      if (targetUp && fleet.up) return true;
      if (!targetUp && fleet.members.every((member) => !member.up)) return true;
      await sleepImpl(3000);
    }
    return false;
  }

  function setJob(jobId, patch) {
    const current = jobs.get(jobId) || {};
    jobs.set(jobId, {
      ...current,
      ...patch,
      updated_at: currentIso(),
      elapsed_s: current.started_at_ms ? Number((((nowMs()) - current.started_at_ms) / 1000).toFixed(1)) : 0,
    });
  }

  function isLargeActivation(profile, laneId) {
    return String(laneId || "").trim().toLowerCase() === "large" && String(profile?.size_class || "") === "large";
  }

  function isMiniActivation(profile, laneId) {
    return String(laneId || "").trim().toLowerCase() === "mini" && String(profile?.size_class || "") === "mini";
  }

  function laneTargetsForActivation({ selectedLane, profile, preserveOtherLane = false, otherLaneTarget = "" }) {
    const currentTarget = String(profile?.profile_id || "").trim();
    const preservedTarget = preserveOtherLane ? String(otherLaneTarget || "").trim() : "";
    return {
      large: selectedLane === "large" ? currentTarget : preservedTarget,
      mini: selectedLane === "mini" ? currentTarget : preservedTarget,
    };
  }

  async function activate({
    profileId,
    laneId = "",
    wait = false,
    allowPreempt = true,
    dryRun = false,
    override = false,
    preserveOtherLane = false,
    otherLaneTarget = "",
  } = {}) {
    const config = await loadValidatedConfig();
    const profile = profileById(config, profileId);
    if (!profile) {
      return { ...apiError(ErrorCode.PROFILE_NOT_FOUND, `unknown profile_id ${profileId}`), accepted: false };
    }
    const selectedLane = String(laneId || profile.default_lane || "large");
    if (!["large", "mini"].includes(selectedLane)) {
      return { ...apiError(ErrorCode.LANE_INVALID, `lane_id must be 'large' or 'mini', got '${selectedLane}'`), accepted: false };
    }
    if (!profile.allowed_lanes?.includes(selectedLane)) {
      return {
        ...apiError(ErrorCode.LANE_NOT_ALLOWED, `${profile.profile_id} cannot run on lane ${selectedLane}`),
        accepted: false,
      };
    }

    // Profile policy enforcement: block manual_only_restore unless override=true.
    const policy = profilePolicy(config, profile.profile_id);
    const supportStatus = String(policy?.support_status || profile?.support_status || "").toLowerCase();
    if (["manual_only_restore", "reserved_alpha"].includes(supportStatus) && !override) {
      return {
        ...apiError(
          ErrorCode.POLICY_BLOCKED,
          `Profile '${profile.profile_id}' has support_status='${supportStatus}' and cannot be activated via the API without override=true.`,
        ),
        accepted: false,
      };
    }

    const current = await currentState();
    const workerState = await workerClearState(config);
    const currentLane = current.lanes[selectedLane];
    if (currentLane?.profile_id === profile.profile_id && currentLane?.up) {
      await persistLaneState(selectedLane, profile);
      await saveDesiredState({
        mode: "lane",
        state: "ready",
        watchdog_enforce: true,
        lane_targets: laneTargetsForActivation({ selectedLane, profile, preserveOtherLane, otherLaneTarget }),
        fleet_id: "",
        status_detail: `${profile.profile_id} already active on ${selectedLane}`,
      });
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
    const currentOtherLane = selectedLane === "large" ? current.lanes?.mini : current.lanes?.large;
    const conflictingCurrent = [];
    const preservingMatchingOtherLane = preserveOtherLane &&
      currentOtherLane?.profile_id &&
      currentOtherLane.up &&
      String(currentOtherLane.profile_id) === String(otherLaneTarget || "");
    if (currentLane?.up && currentLane?.profile_id && currentLane.profile_id !== profile.profile_id) {
      conflictingCurrent.push(currentLane.profile_id);
    }
    if (currentOtherLane?.profile_id && currentOtherLane.up && !preservingMatchingOtherLane) {
      conflictingCurrent.push(currentOtherLane.profile_id);
    }
    if (current.mini_fleet?.up) {
      conflictingCurrent.push(current.mini_fleet.fleet_id || "mini_fleet");
    }
    if (!allowPreempt && conflictingCurrent.length > 0) {
      return {
        ...apiError(ErrorCode.LANE_OCCUPIED, `requested activation would preempt ${conflictingCurrent.join(", ")}`),
        accepted: false,
      };
    }

    // Dry-run: return the plan without executing.
    if (dryRun) {
      const adapter = adapterForProfile(config, profile);
      return {
        ok: true,
        accepted: false,
        code: ErrorCode.DRY_RUN_ONLY,
        dry_run: true,
        plan: {
          profile_id: profile.profile_id,
          lane_id: selectedLane,
          would_preempt: conflictingCurrent,
          launch_command_preview: `PORT=${shellQuote(String(config.lanes?.[selectedLane]?.port || 8000))} ${profile.launch_command}`,
          expected_adapter: adapter,
          startup_expectation: profile.startup_expectation,
        },
      };
    }

    const jobId = uuid();
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
      started_at_ms: nowMs(),
      updated_at: currentIso(),
    };
    jobs.set(jobId, job);
    metrics.activations_total++;

    const launch = async () => {
      return withLaneLock(selectedLane, async () => {
        const startMs = nowMs();
        try {
          const desiredBefore = await loadDesiredState();
          await saveDesiredState({
            ...desiredBefore,
            mode: "lane",
            state: "starting",
            watchdog_enforce: false,
            lane_targets: laneTargetsForActivation({ selectedLane, profile, preserveOtherLane, otherLaneTarget }),
            fleet_id: "",
            status_detail: `starting ${profile.profile_id} on ${selectedLane}`,
          });
          setJob(jobId, { status: "running", current_phase: "stopping_conflicts" });
          if (allowPreempt) {
            await stopFleet({ preserveDesiredState: true });
            if (selectedLane === "large" && !preserveOtherLane) {
              await stopLane("mini", { preserveDesiredState: true });
            } else if (selectedLane === "mini" && !preserveOtherLane) {
              await stopLane("large", { preserveDesiredState: true });
            }
            await stopLane(selectedLane, { preserveDesiredState: true });
            setJob(jobId, { current_phase: "stopping_conflicts", status_detail: "waiting for ports to settle" });
            await sleepImpl(5000);
          }
          if (profile.requires_both_boxes) {
            const postStopWorkerState = await workerClearState(config);
            if (!postStopWorkerState.clear) {
              const detail = `worker gx10-b041 is not clear for dual-box launch; containers=${postStopWorkerState.blocking_containers.join(",") || "none"} ports=${postStopWorkerState.responsive_ports.join(",") || "none"}`;
              const failedDesired = await loadDesiredState();
              await saveDesiredState({
                ...failedDesired,
                state: "failed",
                watchdog_enforce: false,
                status_detail: detail,
              });
              setJob(jobId, { status: "failed", current_phase: "failed", status_detail: "worker gx10-b041 is not clear for dual-box launch" });
              metrics.activations_failed++;
              await appendJobHistory(jobHistoryPath, { ...jobs.get(jobId), code: ErrorCode.WORKER_NOT_CLEAR });
              return;
            }
          }
          setJob(jobId, { current_phase: "starting_runtime" });
          const selectedLanePort = String(config.lanes?.[selectedLane]?.port || 8000);
          const launchCommand = `PORT=${shellQuote(selectedLanePort)} ${profile.launch_command}`;
          const result = await runCommandImpl(launchCommand, (profile.startup_expectation?.ready_timeout_s || 900) * 1000);
          if (!result.ok) {
            const failedDesired = await loadDesiredState();
            await saveDesiredState({
              ...failedDesired,
              state: "failed",
              watchdog_enforce: false,
              status_detail: "launch failed",
            });
            logger.error("activate: launch failed", { profile_id: profile.profile_id, lane: selectedLane, stderr: result.stderr });
            setJob(jobId, { status: "failed", current_phase: "failed", status_detail: "launch failed", code: ErrorCode.LAUNCH_FAILED });
            metrics.activations_failed++;
            await appendJobHistory(jobHistoryPath, jobs.get(jobId));
            return;
          }
          setJob(jobId, { current_phase: "waiting_for_api" });
          const lanePort = config.lanes?.[selectedLane]?.port || 8000;
          const ready = await waitForReady(lanePort, (profile.startup_expectation?.ready_timeout_s || 900) * 1000);
          if (!ready) {
            const failedDesired = await loadDesiredState();
            await saveDesiredState({
              ...failedDesired,
              state: "failed",
              watchdog_enforce: false,
              status_detail: "runtime did not become ready",
            });
            setJob(jobId, { status: "failed", current_phase: "failed", status_detail: "runtime did not become ready", code: ErrorCode.ACTIVATION_TIMEOUT });
            metrics.activations_failed++;
            await appendJobHistory(jobHistoryPath, jobs.get(jobId));
            return;
          }
          await persistLaneState(selectedLane, profile);
          const readyDesired = await loadDesiredState();
          await saveDesiredState({
            ...readyDesired,
            mode: "lane",
            state: "ready",
            watchdog_enforce: true,
            lane_targets: laneTargetsForActivation({ selectedLane, profile, preserveOtherLane, otherLaneTarget }),
            fleet_id: "",
            status_detail: `${profile.profile_id} ready on ${selectedLane}`,
          });
          setJob(jobId, { status: "ready", current_phase: "ready", status_detail: "runtime ready" });
          metrics.activations_ready++;
          metrics.activation_duration_ms.push(nowMs() - startMs);
          if (metrics.activation_duration_ms.length > 100) metrics.activation_duration_ms.shift();
          await appendJobHistory(jobHistoryPath, jobs.get(jobId));
          await fireWebhook("activation_ready", { profile_id: profile.profile_id, lane_id: selectedLane });
        } catch (error) {
          const failedDesired = await loadDesiredState();
          await saveDesiredState({
            ...failedDesired,
            state: "failed",
            watchdog_enforce: false,
            status_detail: "activation failed",
          });
          logger.error("activate: unexpected error", { profile_id: profile.profile_id, error: String(error?.message || error) });
          setJob(jobId, { status: "failed", current_phase: "failed", status_detail: "activation failed", code: ErrorCode.INTERNAL_ERROR });
          metrics.activations_failed++;
          await appendJobHistory(jobHistoryPath, jobs.get(jobId));
          await fireWebhook("activation_failed", { profile_id: profile.profile_id, lane_id: selectedLane });
        }
      });
    };
    if (wait) {
      await launch();
      return jobs.get(jobId);
    }
    launch();
    return jobs.get(jobId);
  }

  /** Append an entry to the activation audit log; self-caps at 500 rows via atomic rename. */
  async function appendAuditLog(entry) {
    try {
      await mkdir(path.dirname(auditLogPath), { recursive: true });
      let rows = [];
      try {
        const raw = await readFile(auditLogPath, "utf-8");
        rows = raw.split("\n").filter(Boolean);
      } catch { /* first run — file may not exist yet */ }
      rows.push(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
      if (rows.length > 500) rows = rows.slice(-500);
      const tmp = auditLogPath + ".tmp";
      await writeFile(tmp, rows.join("\n") + "\n", "utf-8");
      await rename(tmp, auditLogPath);
    } catch (err) {
      logger.warn("appendAuditLog failed", { error: String(err?.message || err) });
    }
  }

  async function activateSet({ setId, wait = false, allowPreempt = true, dryRun = false, force = false } = {}) {
    // ── Activation lock: one set activation at a time ────────────────────
    if (_activating) {
      const eta = new Date(_activatingStartMs + 300000).toISOString();
      return {
        ok: false,
        accepted: false,
        code: ErrorCode.CONCURRENT_ACTIVATION,
        detail: `activation in progress for set '${_activatingSetId}' — try again later`,
        active_set_id: _activatingSetId,
        estimated_ready_at: eta,
      };
    }

    const config = await loadValidatedConfig();

    // ── set_id format validation ─────────────────────────────────────────────
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(setId)) {
      return { ...apiError(ErrorCode.INPUT_INVALID, `set_id must match ^[a-z0-9][a-z0-9_-]{0,62}$ — got '${setId}'`), accepted: false };
    }

    const activationSet = activationSetById(config, setId);
    if (!activationSet) {
      return { ...apiError(ErrorCode.SET_NOT_FOUND, `unknown activation set '${setId}'`), accepted: false };
    }

    // ── Idempotency: skip if already active and healthy ───────────────────────
    if (!force && !dryRun) {
      const existingState = await loadDesiredState();
      if (String(existingState.active_set_id || "") === setId) {
        const largeLanePort = config.lanes?.large?.port || 8000;
        try {
          const healthResp = await fetch(`http://127.0.0.1:${largeLanePort}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          if (healthResp.ok) {
            logger.info("activate-set: idempotent skip", { set_id: setId });
            return {
              ok: true,
              accepted: false,
              status: "skipped",
              set_id: setId,
              detail: `set '${setId}' is already active and healthy`,
              skipped: true,
            };
          }
        } catch { /* health check failed — proceed with full activation */ }
      }
    }

    const largeProfileId = String(activationSet?.lane_targets?.large || "").trim();
    const miniProfileId = String(activationSet?.lane_targets?.mini || "").trim();
    const largeProfile = largeProfileId ? profileById(config, largeProfileId) : null;
    const miniProfile = miniProfileId ? profileById(config, miniProfileId) : null;
    if (largeProfileId && !largeProfile) {
      return { ...apiError(ErrorCode.PROFILE_NOT_FOUND, `unknown profile_id ${largeProfileId}`), accepted: false };
    }
    if (miniProfileId && !miniProfile) {
      return { ...apiError(ErrorCode.PROFILE_NOT_FOUND, `unknown profile_id ${miniProfileId}`), accepted: false };
    }
    if (!largeProfile && !miniProfile) {
      return { ...apiError(ErrorCode.INPUT_INVALID, `activation set ${setId} has no lane targets`), accepted: false };
    }
    if (largeProfile && !largeProfile.allowed_lanes?.includes("large")) {
      return {
        ...apiError(ErrorCode.LANE_NOT_ALLOWED, `${largeProfile.profile_id} cannot run on lane large`),
        accepted: false,
      };
    }
    if (miniProfile && !miniProfile.allowed_lanes?.includes("mini")) {
      return {
        ...apiError(ErrorCode.LANE_NOT_ALLOWED, `${miniProfile.profile_id} cannot run on lane mini`),
        accepted: false,
      };
    }

    const current = await currentState();
    const conflictingCurrent = [];
    if (current.lanes?.large?.profile_id && current.lanes.large.up && current.lanes.large.profile_id !== largeProfileId) {
      conflictingCurrent.push(current.lanes.large.profile_id);
    }
    if (current.lanes?.mini?.profile_id && current.lanes.mini.up && current.lanes.mini.profile_id !== miniProfileId) {
      conflictingCurrent.push(current.lanes.mini.profile_id);
    }
    if (current.mini_fleet?.up) {
      conflictingCurrent.push(current.mini_fleet.fleet_id || "mini_fleet");
    }
    if (!allowPreempt && conflictingCurrent.length > 0) {
      return {
        ...apiError(ErrorCode.LANE_OCCUPIED, `requested activation set would preempt ${Array.from(new Set(conflictingCurrent)).join(", ")}`),
        accepted: false,
      };
    }

    // ── Dual-box reachability pre-check (fail fast before stopping anything) ──
    if (activationSet.requires_dual_box) {
      const gx10Check = await runCommandImpl(`ssh ${workerSshOptions} ${shellQuote(workerSsh)} "exit 0"`, 12000);
      if (!gx10Check.ok) {
        logger.warn("activate-set: gx10-b041 unreachable for dual-box set", { set_id: setId });
        return {
          ...apiError(ErrorCode.HARDWARE_UNAVAILABLE, `set '${setId}' requires dual-box but gx10-b041 is unreachable`),
          accepted: false,
        };
      }
    }

    if (dryRun) {
      return {
        ok: true,
        accepted: false,
        code: ErrorCode.DRY_RUN_ONLY,
        dry_run: true,
        plan: {
          set_id: String(activationSet.set_id || ""),
          display_name: String(activationSet.display_name || ""),
          lane_targets: {
            large: largeProfileId,
            mini: miniProfileId,
          },
          would_preempt: Array.from(new Set(conflictingCurrent)),
          startup_expectation: {
            large: largeProfile?.startup_expectation || null,
            mini: miniProfile?.startup_expectation || null,
          },
        },
      };
    }

    _activating = true;
    _activatingSetId = setId;
    _activatingStartMs = nowMs();
    const _activationSetStartMs = nowMs();
    const jobId = uuid();
    const job = {
      ok: true,
      accepted: true,
      job_id: jobId,
      requested_profile_id: String(activationSet.set_id || ""),
      lane_id: "set",
      expected_runtime: "mixed",
      expected_adapter: {
        large: largeProfile ? adapterForProfile(config, largeProfile) : null,
        mini: miniProfile ? adapterForProfile(config, miniProfile) : null,
      },
      expected_catalog_url: largeProfile ? adapterForProfile(config, largeProfile).models_url : miniProfile ? adapterForProfile(config, miniProfile).models_url : "",
      startup_expectation: {
        large: largeProfile?.startup_expectation || null,
        mini: miniProfile?.startup_expectation || null,
      },
      current_phase: "queued",
      status: "queued",
      started_at_ms: nowMs(),
      updated_at: currentIso(),
    };
    jobs.set(jobId, job);

    const launch = async () => {
      try {
        if (largeProfile) {
          setJob(jobId, { status: "running", current_phase: "activating_large", status_detail: `starting ${largeProfile.profile_id} on large` });
          const largeResult = await activate({
            profileId: largeProfile.profile_id,
            laneId: "large",
            wait: true,
            allowPreempt,
            preserveOtherLane: Boolean(miniProfile),
            otherLaneTarget: miniProfile?.profile_id || "",
          });
          if (String(largeResult?.status || "") !== "ready") {
            setJob(jobId, {
              status: "failed",
              current_phase: "failed",
              status_detail: largeResult?.status_detail || `failed to activate ${largeProfile.profile_id}`,
              code: largeResult?.code || ErrorCode.INTERNAL_ERROR,
            });
            return;
          }
        }

        if (miniProfile) {
          setJob(jobId, { status: "running", current_phase: "activating_mini", status_detail: `starting ${miniProfile.profile_id} on mini` });
          const miniResult = await activate({
            profileId: miniProfile.profile_id,
            laneId: "mini",
            wait: true,
            allowPreempt,
            preserveOtherLane: Boolean(largeProfile),
            otherLaneTarget: largeProfile?.profile_id || "",
          });
          if (String(miniResult?.status || "") !== "ready") {
            setJob(jobId, {
              status: "failed",
              current_phase: "failed",
              status_detail: miniResult?.status_detail || `failed to activate ${miniProfile.profile_id}`,
              code: miniResult?.code || ErrorCode.INTERNAL_ERROR,
            });
            return;
          }
        }

        const laneTargets = {
          large: largeProfileId,
          mini: miniProfileId || null,
        };
        await saveDesiredState({
          mode: "lane",
          state: "ready",
          watchdog_enforce: true,
          lane_targets: laneTargets,
          active_set_id: setId,
          schema_version: 2,
          fleet_id: "",
          status_detail: largeProfileId && miniProfileId
            ? `${largeProfileId} ready on large + ${miniProfileId} ready on mini`
            : largeProfileId
              ? `${largeProfileId} ready on large`
              : `${miniProfileId} ready on mini`,
        });
        setJob(jobId, { status: "ready", current_phase: "ready", status_detail: "activation set ready" });
        await appendAuditLog({ action: "activate-set", set_id: setId, ok: true, elapsed_ms: nowMs() - _activationSetStartMs });
      } catch (error) {
        const _errDetail = String(error?.message || error || "activation set failed");
        setJob(jobId, {
          status: "failed",
          current_phase: "failed",
          status_detail: _errDetail,
          code: ErrorCode.INTERNAL_ERROR,
        });
        await appendAuditLog({ action: "activate-set", set_id: setId, ok: false, error: _errDetail, elapsed_ms: nowMs() - _activationSetStartMs });
        logger.error("activateSet: unexpected error", { set_id: setId, error: _errDetail });
      } finally {
        _activating = false;
        _activatingSetId = "";
      }
    };

    if (wait) {
      await launch();
      return jobs.get(jobId);
    }
    launch();
    return jobs.get(jobId);
  }

  /** Fire a webhook event if LLMCOMMUNE_WEBHOOK_URL is set. Never throws. */
  async function fireWebhook(eventType, payload) {
    if (!webhookUrl) return;
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: eventType, generated_at: currentIso(), ...payload }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      logger.warn("webhook delivery failed", { url: webhookUrl, event: eventType, error: String(error?.message || error) });
    }
  }

  async function restartLane(laneId) {
    const current = await currentState();
    const lane = current.lanes?.[laneId];
    if (!lane?.profile_id) {
      return { ok: false, detail: `no active profile on ${laneId}` };
    }
    return activate({ profileId: lane.profile_id, laneId, wait: true, allowPreempt: true });
  }

  // ── Activation-set catalog management ────────────────────────────────────

  function allActivationSets(config) {
    return (config.controller?.activation_sets || []);
  }

  async function getActivationSets() {
    const config = await loadValidatedConfig();
    const desired = await loadDesiredState();
    const activeSetId = String(desired.active_set_id || "");
    return {
      ok: true,
      sets: allActivationSets(config).map((s) => ({
        set_id: String(s.set_id || ""),
        display_name: String(s.display_name || ""),
        description: String(s.description || ""),
        requires_dual_box: Boolean(s.requires_dual_box),
        lane_targets: {
          large: s.lane_targets?.large || null,
          mini: s.lane_targets?.mini || null,
        },
        currently_active: String(s.set_id || "") === activeSetId,
      })),
      currently_active_set_id: activeSetId || null,
      total: allActivationSets(config).length,
    };
  }

  const MAX_SETS = 50;

  async function registerActivationSet({ setId, displayName, description, laneTargets, persist = false } = {}) {
    const sid = String(setId || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(sid)) {
      return { ...apiError(ErrorCode.INPUT_INVALID, `set_id must match ^[a-z0-9][a-z0-9_-]{0,62}$`), accepted: false };
    }
    const config = await loadValidatedConfig();
    const sets = allActivationSets(config);
    if (sets.length >= MAX_SETS) {
      return { ...apiError(ErrorCode.SET_LIMIT_REACHED, `cannot exceed ${MAX_SETS} registered activation sets`), accepted: false };
    }
    if (sets.find((s) => s.set_id === sid)) {
      return { ...apiError(ErrorCode.INPUT_INVALID, `set_id '${sid}' already registered`), accepted: false };
    }
    // Validate profile IDs exist in catalog
    const profiles = config.profiles || [];
    const profileIds = new Set(profiles.map((p) => p.profile_id));
    const largeId = String(laneTargets?.large || "").trim();
    const miniId = String(laneTargets?.mini || "").trim();
    if (largeId && !profileIds.has(largeId)) {
      return { ...apiError(ErrorCode.PROFILE_NOT_FOUND, `unknown profile_id '${largeId}' for lane_targets.large`), accepted: false };
    }
    if (miniId && !profileIds.has(miniId)) {
      return { ...apiError(ErrorCode.PROFILE_NOT_FOUND, `unknown profile_id '${miniId}' for lane_targets.mini`), accepted: false };
    }
    if (!largeId && !miniId) {
      return { ...apiError(ErrorCode.INPUT_INVALID, "lane_targets must include at least one of large or mini"), accepted: false };
    }
    const newSet = {
      set_id: sid,
      display_name: String(displayName || sid),
      description: String(description || ""),
      requires_dual_box: false,
      lane_targets: { large: largeId || null, mini: miniId || null },
    };
    config.controller.activation_sets.push(newSet);
    _validatedConfig = config;  // update in-memory cache
    if (persist) {
      await writeJsonImpl(configPath, config);
    }
    logger.info("registerActivationSet", { set_id: sid, persist });
    return { ok: true, accepted: true, set_id: sid, persisted: persist };
  }

  async function deleteActivationSet(setId) {
    const sid = String(setId || "").trim();
    const config = await loadValidatedConfig();
    const desired = await loadDesiredState();
    if (String(desired.active_set_id || "") === sid) {
      return { ...apiError(ErrorCode.SET_ACTIVE, `cannot delete active set '${sid}' — deactivate first`), accepted: false };
    }
    const before = allActivationSets(config).length;
    config.controller.activation_sets = allActivationSets(config).filter((s) => s.set_id !== sid);
    if (config.controller.activation_sets.length === before) {
      return { ...apiError(ErrorCode.SET_NOT_FOUND, `unknown activation set '${sid}'`), accepted: false };
    }
    _validatedConfig = config;
    await writeJsonImpl(configPath, config);
    logger.info("deleteActivationSet", { set_id: sid });
    return { ok: true, deleted: sid };
  }

  async function bonzai() {
    const config = await loadValidatedConfig();
    await stopLane("large");
    const result = await activate({
      profileId: config.controller?.bonzai_profile_id || "gguf_coder_next_large",
      laneId: "large",
      wait: true,
      allowPreempt: true,
    });
    await fireWebhook("bonzai", { result_status: result?.status || "unknown" });
    return result;
  }

  async function fleetUp({ wait = false } = {}) {
    const config = await loadValidatedConfig();
    const fleet = Array.isArray(config.fleet_profiles) ? config.fleet_profiles[0] || null : null;
    if (!fleet) {
      return { ok: false, detail: "no fleet configured" };
    }
    const jobId = uuid();
    const job = {
      ok: true,
      accepted: true,
      job_id: jobId,
      requested_profile_id: String(fleet.fleet_id || ""),
      lane_id: "mini_fleet",
      expected_runtime: "mixed",
      expected_adapter: null,
      expected_catalog_url: `http://${config.hosts?.spark?.public_host || "192.168.1.203"}:7999/v1/models`,
      startup_expectation: fleet.startup_expectation || null,
      current_phase: "queued",
      status: "queued",
      started_at_ms: nowMs(),
      updated_at: currentIso(),
    };
    jobs.set(jobId, job);
    const launch = async () => {
      try {
        await saveDesiredState({
          mode: "fleet",
          state: "starting",
          watchdog_enforce: false,
          lane_targets: {
            large: "",
            mini: "",
          },
          fleet_id: String(fleet.fleet_id || ""),
          status_detail: `starting fleet ${fleet.fleet_id || ""}`,
        });
        setJob(jobId, { status: "running", current_phase: "starting_runtime" });
        const miniPort = String(config.lanes?.mini?.port || 7999);
        const largePort = String(config.lanes?.large?.port || 8000);
        const fleetCommand = `PORT=${shellQuote(miniPort)} LLMCOMMUNE_LARGE_PORT=${shellQuote(largePort)} LLMCOMMUNE_MINI_PORT=${shellQuote(miniPort)} LLMCOMMUNE_WORKER_MINI_PORT=${shellQuote(miniPort)} bash ${shellQuote(path.join(repoRoot, "scripts", "fleet_up.sh"))}`;
        let started = null;
        if (wait) {
          const result = await runCommandImpl(
            fleetCommand,
            (fleet.startup_expectation?.ready_timeout_s || 1200) * 1000,
          );
          if (!result.ok) {
            await saveDesiredState({
              mode: "fleet",
              state: "failed",
              watchdog_enforce: false,
              lane_targets: {
                large: "",
                mini: "",
              },
              fleet_id: String(fleet.fleet_id || ""),
              status_detail: result.error || result.stderr || "fleet up failed",
            });
            setJob(jobId, {
              status: "failed",
              current_phase: "failed",
              status_detail: result.error || result.stderr || "fleet up failed",
            });
            return;
          }
        } else {
          started = runDetachedCommandImpl(fleetCommand, repoRoot);
        }
        if (!wait && !started.ok) {
          await saveDesiredState({
            mode: "fleet",
            state: "failed",
            watchdog_enforce: false,
            lane_targets: {
              large: "",
              mini: "",
            },
            fleet_id: String(fleet.fleet_id || ""),
            status_detail: started.error || "fleet up failed",
          });
          setJob(jobId, { status: "failed", current_phase: "failed", status_detail: started.error || "fleet up failed" });
          return;
        }
        setJob(jobId, {
          current_phase: "waiting_for_api",
          status_detail: wait ? "fleet command completed; verifying readiness" : `fleet launcher pid ${started.pid}`,
        });
        const ready = await waitForFleet(config, true, (fleet.startup_expectation?.ready_timeout_s || 1200) * 1000);
        if (!ready) {
          await saveDesiredState({
            mode: "fleet",
            state: "failed",
            watchdog_enforce: false,
            lane_targets: {
              large: "",
              mini: "",
            },
            fleet_id: String(fleet.fleet_id || ""),
            status_detail: "fleet did not become ready",
          });
          setJob(jobId, { status: "failed", current_phase: "failed", status_detail: "fleet did not become ready" });
          return;
        }
        await saveDesiredState({
          mode: "fleet",
          state: "ready",
          watchdog_enforce: true,
          lane_targets: {
            large: "",
            mini: "",
          },
          fleet_id: String(fleet.fleet_id || ""),
          status_detail: `fleet ${fleet.fleet_id || ""} ready`,
        });
        setJob(jobId, { status: "ready", current_phase: "ready", status_detail: "fleet ready" });
      } catch (error) {
        await saveDesiredState({
          mode: "fleet",
          state: "failed",
          watchdog_enforce: false,
          lane_targets: {
            large: "",
            mini: "",
          },
          fleet_id: String(fleet.fleet_id || ""),
          status_detail: String(error?.message || error || "fleet up failed"),
        });
        setJob(jobId, { status: "failed", current_phase: "failed", status_detail: String(error?.message || error || "fleet up failed") });
      }
    };
    if (wait) {
      await launch();
      return jobs.get(jobId);
    }
    launch();
    return jobs.get(jobId);
  }

  async function fleetDown({ wait = false } = {}) {
    const jobId = uuid();
    const job = {
      ok: true,
      accepted: true,
      job_id: jobId,
      requested_profile_id: "mini_fleet",
      lane_id: "mini_fleet",
      expected_runtime: "mixed",
      expected_adapter: null,
      expected_catalog_url: "",
      startup_expectation: null,
      current_phase: "queued",
      status: "queued",
      started_at_ms: nowMs(),
      updated_at: currentIso(),
    };
    jobs.set(jobId, job);
    const shutdown = async () => {
      try {
        await saveDesiredState({
          ...(await loadDesiredState()),
          mode: "idle",
          state: "stopping",
          watchdog_enforce: false,
          lane_targets: {
            large: "",
            mini: "",
          },
          fleet_id: "",
          status_detail: "stopping fleet",
        });
        setJob(jobId, { status: "running", current_phase: "stopping_conflicts" });
        const miniPort = String((await loadConfig()).lanes?.mini?.port || 7999);
        const fleetCommand = `PORT=${shellQuote(miniPort)} LLMCOMMUNE_MINI_PORT=${shellQuote(miniPort)} LLMCOMMUNE_WORKER_MINI_PORT=${shellQuote(miniPort)} bash ${shellQuote(path.join(repoRoot, "scripts", "fleet_down.sh"))}`;
        let started = null;
        if (wait) {
          const result = await runCommandImpl(fleetCommand, 300000);
          if (!result.ok) {
            await saveDesiredState({
              ...(await loadDesiredState()),
              mode: "idle",
              state: "failed",
              watchdog_enforce: false,
              lane_targets: {
                large: "",
                mini: "",
              },
              fleet_id: "",
              status_detail: result.error || result.stderr || "fleet down failed",
            });
            setJob(jobId, {
              status: "failed",
              current_phase: "failed",
              status_detail: result.error || result.stderr || "fleet down failed",
            });
            return;
          }
        } else {
          started = runDetachedCommandImpl(fleetCommand, repoRoot);
        }
        if (!wait && !started.ok) {
          await saveDesiredState({
            ...(await loadDesiredState()),
            mode: "idle",
            state: "failed",
            watchdog_enforce: false,
            lane_targets: {
              large: "",
              mini: "",
            },
            fleet_id: "",
            status_detail: started.error || "fleet down failed",
          });
          setJob(jobId, { status: "failed", current_phase: "failed", status_detail: started.error || "fleet down failed" });
          return;
        }
        setJob(jobId, {
          current_phase: "stopping_conflicts",
          status_detail: wait ? "fleet down command completed; verifying shutdown" : `fleet-down launcher pid ${started.pid}`,
        });
        const stopped = await waitForFleet(await loadValidatedConfig(), false, 180000);
        if (!stopped) {
          await saveDesiredState({
            ...(await loadDesiredState()),
            mode: "idle",
            state: "failed",
            watchdog_enforce: false,
            lane_targets: {
              large: "",
              mini: "",
            },
            fleet_id: "",
            status_detail: "fleet did not stop cleanly",
          });
          setJob(jobId, { status: "failed", current_phase: "failed", status_detail: "fleet did not stop cleanly" });
          return;
        }
        await saveDesiredState(defaultDesiredState());
        setJob(jobId, { status: "ready", current_phase: "ready", status_detail: "fleet stopped" });
      } catch (error) {
        await saveDesiredState({
          ...(await loadDesiredState()),
          mode: "idle",
          state: "failed",
          watchdog_enforce: false,
          lane_targets: {
            large: "",
            mini: "",
          },
          fleet_id: "",
          status_detail: String(error?.message || error || "fleet down failed"),
        });
        setJob(jobId, { status: "failed", current_phase: "failed", status_detail: String(error?.message || error || "fleet down failed") });
      }
    };
    if (wait) {
      await shutdown();
      return jobs.get(jobId);
    }
    shutdown();
    return jobs.get(jobId);
  }

  async function writeInventorySnapshot() {
    const payload = {
      generated_at: currentIso(),
      current: await currentState(),
      models: await modelsState(),
    };
    const outputPath = path.join(repoRoot, "workspace", "current", "models.live.json");
    await writeJsonImpl(outputPath, payload);
    return payload;
  }

  /** Deep health check — probes actual dependencies. */
  async function deepHealth() {
    const checks = {};

    // State file readable?
    try {
      await readFile(desiredStatePath, "utf-8");
      checks.state_file = "ok";
    } catch {
      checks.state_file = "missing";
    }

    // Watchdog PID alive?
    try {
      const raw = await readFile(path.join(stateRoot, "watchdog-4000.pid"), "utf-8");
      const pid = Number(raw.trim());
      process.kill(pid, 0);
      checks.watchdog = "ok";
    } catch {
      checks.watchdog = "dead_or_missing";
    }

    // Large lane port responsive?
    const largeLane = await probeRuntimeImpl("http://127.0.0.1:8000");
    checks.large_lane = largeLane.up ? "up" : "down";

    // Mini lane port responsive?
    const miniLane = await probeRuntimeImpl("http://127.0.0.1:7999");
    checks.mini_lane = miniLane.up ? "up" : "down";

    const ok = checks.state_file !== "missing";
    return { ok, checks };
  }

  /** Export Prometheus-compatible text metrics. */
  function metricsText() {
    const avgDuration = metrics.activation_duration_ms.length > 0
      ? (metrics.activation_duration_ms.reduce((a, b) => a + b, 0) / metrics.activation_duration_ms.length / 1000).toFixed(3)
      : "0";
    return [
      `# HELP llmcommune_activations_total Total activation requests`,
      `# TYPE llmcommune_activations_total counter`,
      `llmcommune_activations_total ${metrics.activations_total}`,
      `# HELP llmcommune_activations_failed_total Failed activations`,
      `# TYPE llmcommune_activations_failed_total counter`,
      `llmcommune_activations_failed_total ${metrics.activations_failed}`,
      `# HELP llmcommune_activations_ready_total Successful activations`,
      `# TYPE llmcommune_activations_ready_total counter`,
      `llmcommune_activations_ready_total ${metrics.activations_ready}`,
      `# HELP llmcommune_activation_duration_seconds_avg Average activation duration`,
      `# TYPE llmcommune_activation_duration_seconds_avg gauge`,
      `llmcommune_activation_duration_seconds_avg ${avgDuration}`,
      `# HELP llmcommune_probe_failures_total Total probe failures`,
      `# TYPE llmcommune_probe_failures_total counter`,
      `llmcommune_probe_failures_total ${metrics.probe_failures_total}`,
      `# HELP llmcommune_active_jobs Current in-memory job count`,
      `# TYPE llmcommune_active_jobs gauge`,
      `llmcommune_active_jobs ${jobs.size}`,
    ].join("\n") + "\n";
  }

  return {
    getHelp: helpState,
    getCurrent: currentState,
    listModels: modelsState,
    activate,
    activateSet,
    getActivationSets,
    registerActivationSet,
    deleteActivationSet,
    restartLane,
    stopLane,
    bonzai,
    fleetUp,
    fleetDown,
    deepHealth,
    metricsText,
    startupChecks,
    getJob(jobId) {
      const job = jobs.get(String(jobId || "").trim());
      if (!job) return { ...apiError(ErrorCode.JOB_NOT_FOUND, "job not found"), ok: false };
      return { ok: true, ...job };
    },
    writeInventorySnapshot,
  };
}
