// @ts-check
import { exec as execCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, open, rename, rm as rmFile, copyFile, appendFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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

/**
 * Acquire an advisory lock on filePath using O_EXCL (atomic create).
 * Stale locks older than 5s are removed automatically.
 * Returns fn() result; always releases lock even on error.
 */
async function withDesiredStateLock(lockPath, fn) {
  const LOCK_TIMEOUT_MS = 5000;
  const RETRY_INTERVAL_MS = 50;
  const MAX_RETRIES = 20;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      const fh = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      await fh.writeFile(String(process.pid));
      await fh.close();
      try {
        return await fn();
      } finally {
        await rmFile(lockPath, { force: true });
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > LOCK_TIMEOUT_MS) {
          await rmFile(lockPath, { force: true });
          continue;
        }
      } catch { /* disappeared */ }
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    }
  }
  return fn(); // timed out — proceed anyway; atomic rename still protects integrity
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
  bootSetId = process.env.LLMCOMMUNE_BOOT_SET_ID || "",
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
  const swapManifestPath = paths.swapManifestPath || path.join(stateRoot, "swap_manifest.json");
  const swapJournalPath = paths.swapJournalPath || path.join(stateRoot, "swap_journal.jsonl");
  const activeManagedSlotPath = paths.activeManagedSlotPath || path.join(jobsStateRoot, "active_slot.json");
  const jobHistoryPath = paths.jobHistoryPath || path.join(stateRoot, "job_history.jsonl");
  const auditLogPath = paths.auditLogPath || path.join(stateRoot, "activation_audit.jsonl");
  const studioRoot = paths.studioRoot || path.join(repoRoot, "workspace", "studio");
  const studioDraftsPath = paths.studioDraftsPath || path.join(studioRoot, "drafts.json");
  const studioDefaultsPath = paths.studioDefaultsPath || path.join(studioRoot, "defaults.json");
  const studioEvidencePath = paths.studioEvidencePath || path.join(studioRoot, "bakeoff_evidence.json");
  const studioActionLogPath = paths.studioActionLogPath || path.join(studioRoot, "action_log.jsonl");
  const externalBakeoffScoreboardPath = paths.externalBakeoffScoreboardPath || "/home/admin/bakeoff_answers/bakeoff_scoreboard.json";
  const webhookUrl = process.env.LLMCOMMUNE_WEBHOOK_URL || "";
  const jobTtlMs = Number(process.env.LLMCOMMUNE_JOB_TTL_MS || 3600000);
  const jobs = new Map();
  let cache = { ts: 0, value: null };
  const currentIso = () => new Date(nowMs()).toISOString();
  const requestedBootSetId = String(bootSetId || "").trim();
  const controllerEpoch = `swap-epoch-${uuid()}`;
  let swapEventSeq = 0;

  // Per-lane activation mutex — prevents two concurrent activations on the same lane.
  const laneLocks = new Map();

  // Set-level activation guard — one activate-set at a time.
  let _activating = false;
  let _activatingSetId = "";
  let _activatingStartMs = 0;
  let _activatingJobId = "";
  let _activatingPromise = null;
  let _activationGeneration = 0;
  const ACTIVATION_COOLDOWN_MS = 30000; // 30s minimum between completed activations
  let _lastActivationCompletedMs = 0;

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
    // Startup reconciliation: derive persisted activation-set identity from lane targets.
    const desiredState = await loadDesiredState();
    const reconciledDesiredState = withResolvedActivationSetId(config, desiredState);
    const rawStoredSetId = String(desiredState.active_set_id || "").trim();
    const reconciledSetId = String(reconciledDesiredState.active_set_id || "").trim();
    if (rawStoredSetId !== reconciledSetId) {
      const loggerMethod = rawStoredSetId ? "warn" : "info";
      logger[loggerMethod]("startup: reconciling desired_state.active_set_id", {
        from: rawStoredSetId || null,
        to: reconciledSetId || null,
      });
      await saveDesiredState(reconciledDesiredState);
    }
    const normalizedBootSetId = canonicalActivationSetId(requestedBootSetId);
    if (!normalizedBootSetId) {
      return;
    }
    if (!activationSetById(config, normalizedBootSetId)) {
      logger.warn("startup: boot activation set missing", { set_id: normalizedBootSetId });
      return;
    }

    const current = await currentState();
    const currentDesiredState = withResolvedActivationSetId(config, current?.desired_state || reconciledDesiredState);
    const desiredLaneTargets = currentDesiredState?.lane_targets || {};
    const hasDesiredTargets = Boolean(
      String(currentDesiredState?.active_set_id || "").trim()
      || String(currentDesiredState?.fleet_id || "").trim()
      || Object.values(desiredLaneTargets).some((value) => String(value || "").trim())
    );
    const desiredStateStatus = String(currentDesiredState?.state || "").trim().toLowerCase();
    const controllerBusy = Boolean(
      current?.activating_job_id
      || current?.lanes?.large?.up
      || current?.lanes?.mini?.up
      || current?.mini_fleet?.up
    );
    const desiredBootBlocked = hasDesiredTargets && !["", "idle", "failed"].includes(desiredStateStatus);
    if (controllerBusy || desiredBootBlocked) {
      logger.info("startup: skipping boot activation", {
        set_id: normalizedBootSetId,
        busy: controllerBusy,
        desired_state: desiredStateStatus || null,
        active_set_id: String(currentDesiredState?.active_set_id || "").trim() || null,
        lane_targets: desiredLaneTargets,
      });
      return;
    }

    const bootResult = await activateSet({
      setId: normalizedBootSetId,
      wait: false,
      allowPreempt: true,
      force: true,
    });
    if (!bootResult?.ok) {
      logger.warn("startup: boot activation failed", {
        set_id: normalizedBootSetId,
        code: bootResult?.code || null,
        detail: bootResult?.detail || bootResult?.status_detail || null,
      });
      return;
    }
    logger.info("startup: boot activation queued", {
      set_id: normalizedBootSetId,
      job_id: bootResult?.job_id || null,
      status: bootResult?.status || null,
      attached: Boolean(bootResult?.attached),
    });
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

  const desiredStateLockPath = desiredStatePath + ".lock";
  const swapManifestLockPath = swapManifestPath + ".lock";

  function defaultSwapManifest() {
    return {
      schema_version: 1,
      summary_version: 1,
      controller_epoch: controllerEpoch,
      controller_revision: 0,
      last_committed_event_seq: 0,
      runtime_incarnation_id: String(process.pid),
      swap_id: "",
      current_job_id: "",
      requested_set_id: "",
      canonical_set_id: "",
      requested_generation: 0,
      observed_generation: 0,
      state: "idle",
      terminal_state: "idle",
      started_at: "",
      updated_at: "",
      phase_started_at: "",
      desired_lane_targets: {
        large: "",
        mini: "",
      },
      observed_lane_targets: {
        large: "",
        mini: "",
      },
      parity_status: "unknown",
      drain_status: "unknown",
      readiness_status: "unknown",
      known_idle: true,
      reconcile_needed: false,
      evidence_status: "none",
      evidence_refs: [],
      failure_code: "",
      failure_detail: "",
    };
  }

  function normalizeSwapManifest(nextState) {
    const base = defaultSwapManifest();
    return {
      ...base,
      ...(nextState || {}),
      controller_epoch: controllerEpoch,
      desired_lane_targets: {
        ...base.desired_lane_targets,
        ...(nextState?.desired_lane_targets || {}),
      },
      observed_lane_targets: {
        ...base.observed_lane_targets,
        ...(nextState?.observed_lane_targets || {}),
      },
      evidence_refs: Array.isArray(nextState?.evidence_refs) ? nextState.evidence_refs : base.evidence_refs,
    };
  }

  async function loadSwapManifest() {
    const loaded = await readJsonImpl(swapManifestPath, defaultSwapManifest());
    const normalized = normalizeSwapManifest(loaded);
    swapEventSeq = Math.max(swapEventSeq, Number(normalized.last_committed_event_seq || 0));
    return normalized;
  }

  async function saveSwapManifest(nextState, expectations = {}) {
    return withDesiredStateLock(swapManifestLockPath, async () => {
      const current = await loadSwapManifest();
      const expectedControllerRevision = expectations?.expectedControllerRevision;
      const expectedSwapId = String(expectations?.expectedSwapId || "").trim();
      const expectedCurrentJobId = String(expectations?.expectedCurrentJobId || "").trim();
      if (
        expectedControllerRevision !== undefined
        && Number(current.controller_revision || 0) !== Number(expectedControllerRevision)
      ) {
        return {
          persisted: false,
          manifest: current,
          rejection_reason: "controller_revision_mismatch",
          expected_controller_revision: Number(expectedControllerRevision),
        };
      }
      if (expectedSwapId && String(current.swap_id || "").trim() !== expectedSwapId) {
        return {
          persisted: false,
          manifest: current,
          rejection_reason: "swap_id_mismatch",
          expected_swap_id: expectedSwapId,
        };
      }
      if (expectedCurrentJobId && String(current.current_job_id || "").trim() !== expectedCurrentJobId) {
        return {
          persisted: false,
          manifest: current,
          rejection_reason: "current_job_id_mismatch",
          expected_current_job_id: expectedCurrentJobId,
        };
      }
      const payload = normalizeSwapManifest({
        ...current,
        ...(nextState || {}),
        controller_revision: Math.max(
          Number(current.controller_revision || 0) + 1,
          Number(nextState?.controller_revision || 0) || 0,
        ),
        updated_at: currentIso(),
      });
      await writeJsonImpl(swapManifestPath, payload);
      return {
        persisted: true,
        manifest: payload,
      };
    });
  }

  async function appendSwapJournal(eventType, payload = {}) {
    await mkdir(path.dirname(swapJournalPath), { recursive: true });
    const baseRecord = {
      schema_version: 1,
      event_seq: swapEventSeq + 1,
      event_type: String(eventType || "").trim(),
      controller_epoch: controllerEpoch,
      generated_at: currentIso(),
      ...(payload || {}),
    };
    const record = {
      ...baseRecord,
      record_checksum: createHash("sha256").update(JSON.stringify(baseRecord)).digest("hex"),
    };
    await appendFile(swapJournalPath, `${JSON.stringify(record)}\n`, "utf-8");
    swapEventSeq = record.event_seq;
    return record;
  }

  async function recordSwapTransition(jobId, eventType, nextState, eventPayload = {}, expectations = {}) {
    const saveResult = await saveSwapManifest({
      ...(nextState || {}),
      last_committed_event_seq: swapEventSeq + 1,
    }, expectations);
    const manifest = saveResult?.manifest || normalizeSwapManifest(nextState);
    if (!saveResult?.persisted) {
      return {
        ...manifest,
        transition_rejected: true,
        rejection_reason: saveResult?.rejection_reason || "swap_transition_rejected",
        expected_controller_revision: saveResult?.expected_controller_revision ?? null,
        expected_swap_id: saveResult?.expected_swap_id || "",
        expected_current_job_id: saveResult?.expected_current_job_id || "",
      };
    }
    await appendSwapJournal(eventType, {
      swap_id: manifest.swap_id || "",
      current_job_id: manifest.current_job_id || jobId || "",
      controller_revision: manifest.controller_revision,
      requested_set_id: manifest.requested_set_id || "",
      canonical_set_id: manifest.canonical_set_id || "",
      state: manifest.state,
      terminal_state: manifest.terminal_state,
      known_idle: Boolean(manifest.known_idle),
      reconcile_needed: Boolean(manifest.reconcile_needed),
      failure_code: manifest.failure_code || "",
      failure_detail: manifest.failure_detail || "",
      ...(eventPayload || {}),
    });
    if (jobId) {
      setJob(jobId, {
        swap_id: manifest.swap_id,
        controller_epoch: manifest.controller_epoch,
        controller_revision: manifest.controller_revision,
        swap_state: manifest.state,
        swap_terminal_state: manifest.terminal_state,
      });
    }
    return manifest;
  }

  function swapTransitionRejected(transition) {
    return Boolean(transition?.transition_rejected);
  }

  function swapTransitionConflictDetail(transition, fallback = "swap transition rejected after controller ownership changed") {
    const expectedRevision = transition?.expected_controller_revision;
    const currentRevision = transition?.controller_revision;
    const reason = String(transition?.rejection_reason || "").trim();
    if (reason === "controller_revision_mismatch" && expectedRevision !== null && expectedRevision !== undefined) {
      return `${fallback}; expected controller revision ${expectedRevision} but current revision is ${currentRevision}`;
    }
    if (reason === "swap_id_mismatch" && transition?.expected_swap_id) {
      return `${fallback}; expected swap ${transition.expected_swap_id} but current swap is ${transition.swap_id || "<none>"}`;
    }
    if (reason === "current_job_id_mismatch" && transition?.expected_current_job_id) {
      return `${fallback}; expected job ${transition.expected_current_job_id} but current job is ${transition.current_job_id || "<none>"}`;
    }
    return fallback;
  }

  function classifySwapFailureState({ current, failureCode = "", failureDetail = "" } = {}) {
    const largeUp = Boolean(current?.lanes?.large?.up);
    const miniUp = Boolean(current?.lanes?.mini?.up);
    const fleetUp = Boolean(current?.mini_fleet?.up);
    const knownIdle = !largeUp && !miniUp && !fleetUp;
    return {
      eventType: knownIdle ? "swap_failed_known_idle" : "swap_reconcile_needed",
      state: knownIdle ? "failed_known_idle" : "reconcile_needed",
      terminal_state: knownIdle ? "failed_known_idle" : "reconcile_needed",
      readiness_status: "failed",
      known_idle: knownIdle,
      reconcile_needed: !knownIdle,
      evidence_status: "minimal",
      observed_lane_targets: observedLaneTargetsFromPayloads(current?.lanes?.large, current?.lanes?.mini),
      failure_code: failureCode || ErrorCode.INTERNAL_ERROR,
      failure_detail: failureDetail || "activation failed",
    };
  }

  function observedLaneTargetsFromPayloads(largePayload, miniPayload) {
    return {
      large: largePayload?.up ? String(largePayload?.profile_id || "") : "",
      mini: miniPayload?.up ? String(miniPayload?.profile_id || "") : "",
    };
  }

  function buildSwapActionContract(manifest) {
    const normalized = normalizeSwapManifest(manifest);
    const reconcileNeeded = Boolean(
      normalized.reconcile_needed || String(normalized.terminal_state || "").trim().toLowerCase() === "reconcile_needed",
    );
    if (!reconcileNeeded) {
      return {
        action_policy_state: "normal",
        allowed_actions: [
          "activate",
          "activate_set",
          "restart",
          "stop",
          "bonzai",
          "fleet_up",
          "fleet_down",
        ],
        blocked_actions: [],
        operator_action_required: "",
        exit_requirements: [],
      };
    }
    return {
      action_policy_state: "reconcile_needed",
      allowed_actions: [
        "stop",
        "fleet_down",
      ],
      blocked_actions: [
        {
          action: "activate",
          reason: "swap_reconcile_needed",
          detail: "Generic activation stays blocked until the active swap is reconciled.",
        },
        {
          action: "activate_set",
          reason: "swap_reconcile_needed",
          detail: "New activation sets stay blocked until the active swap is reconciled.",
          override_hint: "force=true after operator review",
        },
        {
          action: "restart",
          reason: "swap_reconcile_needed",
          detail: "Restart routes through activation and stays blocked until the active swap is reconciled.",
        },
        {
          action: "bonzai",
          reason: "swap_reconcile_needed",
          detail: "Bonzai routes through activate-set and stays blocked until the active swap is reconciled.",
        },
        {
          action: "fleet_up",
          reason: "swap_reconcile_needed",
          detail: "Fleet-up is blocked until the controller has reconciled the active swap.",
        },
      ],
      operator_action_required: "collect_fresh_evidence",
      exit_requirements: [
        "Collect fresh Spark and GX10 runtime evidence for the active swap before clearing reconcile_needed.",
        "Confirm whether the current runtime is still serving or known idle before forcing a replacement.",
        "Record cleanup or compensation outcome before admitting a fresh activation.",
      ],
    };
  }

  function buildSwapSummary(manifest, { largePayload, miniPayload, fleet } = {}) {
    const normalized = normalizeSwapManifest(manifest);
    const observed = largePayload || miniPayload
      ? observedLaneTargetsFromPayloads(largePayload, miniPayload)
      : normalized.observed_lane_targets;
    const activeTransitionStates = new Set(["preflight", "stopping", "drained", "starting"]);
    const inferredKnownIdle = !activeTransitionStates.has(String(normalized.state || "").trim().toLowerCase())
      && !Boolean(largePayload?.up || miniPayload?.up || fleet?.up);
    const actionContract = buildSwapActionContract(normalized);
    return {
      ...normalized,
      summary_version: 1,
      current_job_id: _activating ? _activatingJobId || normalized.current_job_id || null : normalized.current_job_id || null,
      activating: _activating,
      activating_set_id: _activating ? _activatingSetId || null : null,
      observed_lane_targets: observed,
      known_idle: Boolean(normalized.known_idle) || (!_activating && inferredKnownIdle),
      last_observed_at: currentIso(),
      ...actionContract,
    };
  }

  function buildSwapAdmissionDetails(manifest, overrides = {}) {
    const normalized = normalizeSwapManifest({
      ...(manifest || {}),
      ...(overrides || {}),
    });
    const actionContract = buildSwapActionContract(normalized);
    return {
      swap_id: normalized.swap_id || "",
      current_job_id: normalized.current_job_id || "",
      active_set_id: normalized.canonical_set_id || normalized.requested_set_id || "",
      controller_epoch: normalized.controller_epoch || controllerEpoch,
      controller_revision: Number(normalized.controller_revision || 0),
      swap_state: normalized.state || "",
      swap_terminal_state: normalized.terminal_state || "",
      reconcile_needed: Boolean(normalized.reconcile_needed || String(normalized.terminal_state || "") === "reconcile_needed"),
      ...actionContract,
    };
  }

  function buildReadinessLease({ desiredState = {}, swapSummary = {}, job = null } = {}) {
    const desiredReady = String(desiredState?.state || "").trim().toLowerCase() === "ready";
    const activeSetId = canonicalActivationSetId(
      desiredState?.active_set_id
      || job?.activation_set_id
      || swapSummary?.canonical_set_id
      || swapSummary?.requested_set_id
      || "",
    );
    const swapState = String(job?.swap_state || swapSummary?.state || "").trim().toLowerCase();
    const swapTerminalState = String(job?.swap_terminal_state || swapSummary?.terminal_state || "").trim().toLowerCase();
    const reconcileNeeded = Boolean(job?.reconcile_needed ?? swapSummary?.reconcile_needed ?? false);
    const knownIdle = Boolean(job?.known_idle ?? swapSummary?.known_idle ?? false);
    const currentJobId = String(job?.job_id || swapSummary?.current_job_id || "").trim();
    const swapId = String(job?.swap_id || swapSummary?.swap_id || currentJobId).trim();
    const controllerRevision = Number(job?.controller_revision || swapSummary?.controller_revision || 0);
    const runtimeIncarnationId = String(job?.runtime_incarnation_id || swapSummary?.runtime_incarnation_id || "").trim();
    if (!desiredReady || !activeSetId || swapState !== "ready" || swapTerminalState !== "ready" || reconcileNeeded || knownIdle) {
      return null;
    }
    const issuedAt = String(job?.updated_at || desiredState?.updated_at || currentIso());
    return {
      schema_version: 1,
      lease_id: [
        controllerEpoch,
        controllerRevision,
        runtimeIncarnationId || "runtime",
        activeSetId,
        swapId || currentJobId || "unknown",
      ].join(":"),
      activation_set_id: activeSetId,
      current_job_id: currentJobId || swapId || "",
      swap_id: swapId || currentJobId || "",
      controller_epoch: controllerEpoch,
      controller_revision: controllerRevision,
      runtime_incarnation_id: runtimeIncarnationId,
      desired_state: String(desiredState?.state || "").trim(),
      desired_status_detail: String(desiredState?.status_detail || "").trim(),
      swap_state: swapState,
      swap_terminal_state: swapTerminalState,
      reconcile_needed: reconcileNeeded,
      known_idle: knownIdle,
      stage_scope: ["design_loop", "implementation"],
      fencing_token: [
        controllerEpoch,
        controllerRevision,
        runtimeIncarnationId || "runtime",
        swapId || currentJobId || "unknown",
      ].join(":"),
      issued_at: issuedAt,
    };
  }

  function buildJobReadinessLease(job = {}) {
    const status = String(job?.status || "").trim().toLowerCase();
    const phase = String(job?.current_phase || "").trim().toLowerCase();
    if (status !== "ready" || phase !== "ready") {
      return null;
    }
    const activationSetId = canonicalActivationSetId(job?.activation_set_id || job?.requested_profile_id || "");
    return buildReadinessLease({
      desiredState: {
        state: "ready",
        active_set_id: activationSetId,
        status_detail: String(job?.status_detail || "").trim(),
        updated_at: String(job?.updated_at || currentIso()),
      },
      swapSummary: {
        swap_id: String(job?.swap_id || job?.job_id || "").trim(),
        current_job_id: String(job?.job_id || "").trim(),
        canonical_set_id: activationSetId,
        requested_set_id: activationSetId,
        state: String(job?.swap_state || "ready").trim(),
        terminal_state: String(job?.swap_terminal_state || "ready").trim(),
        reconcile_needed: false,
        known_idle: false,
        controller_revision: Number(job?.controller_revision || 0),
        runtime_incarnation_id: String(job?.runtime_incarnation_id || process.pid),
      },
      job: {
        ...job,
        activation_set_id: activationSetId,
        reconcile_needed: false,
        known_idle: false,
        runtime_incarnation_id: String(job?.runtime_incarnation_id || process.pid),
      },
    });
  }

  function getJobPayload(jobId) {
    const job = jobs.get(String(jobId || "").trim());
    if (!job) return null;
    return {
      ...job,
      readiness_lease: buildJobReadinessLease(job),
    };
  }

  async function saveDesiredState(nextState) {
    return withDesiredStateLock(desiredStateLockPath, () => _saveDesiredStateImpl(nextState));
  }

  async function _saveDesiredStateImpl(nextState) {
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

  function parseTaggedJsonLine(text, prefix) {
    const source = String(text || "");
    if (!source) return null;
    const lines = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.startsWith(prefix)) continue;
      const payload = line.slice(prefix.length).trim();
      if (!payload) continue;
      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    }
    return null;
  }

  function normalizeProofReasonCodes(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }

  function parseDrainProof(result) {
    const parsed = parseTaggedJsonLine(result?.stdout, "LLMCOMMUNE_DRAIN_PROOF=")
      || parseTaggedJsonLine(result?.stderr, "LLMCOMMUNE_DRAIN_PROOF=");
    if (!parsed || typeof parsed !== "object") return null;
    const local = parsed?.local && typeof parsed.local === "object" ? parsed.local : {};
    const worker = parsed?.worker && typeof parsed.worker === "object" ? parsed.worker : {};
    return {
      status: String(parsed.status || "").trim() || "unknown",
      timeout_s: Number(parsed.timeout_s || 0) || 0,
      local: {
        clear: Boolean(local.clear),
        reason_codes: normalizeProofReasonCodes(local.reason_codes),
      },
      worker: {
        clear: Boolean(worker.clear),
        reason_codes: normalizeProofReasonCodes(worker.reason_codes),
      },
    };
  }

  function summarizeDrainProof(proof) {
    if (!proof) return "";
    const describeSide = (label, side) => {
      const codes = normalizeProofReasonCodes(side?.reason_codes);
      return `${label}=${codes.length > 0 ? codes.join(",") : "clear"}`;
    };
    return [
      describeSide("local", proof.local),
      describeSide("worker", proof.worker),
    ].join(" ");
  }

  async function evaluateDualBoxParity({ profile } = {}) {
    if (!profile) {
      return {
        ok: false,
        status: "failed",
        reason_codes: ["dual_box_profile_missing"],
        detail: "dual-box activation was requested without resolved dual-box profile metadata",
        evidence: {},
      };
    }
    if (!profile.requires_both_boxes) {
      return {
        ok: true,
        status: "not_required",
        reason_codes: [],
        detail: "",
        evidence: {},
      };
    }
    const sparkPath = String(profile?.model_paths?.spark || "").trim();
    const gx10Path = String(profile?.model_paths?.gx10 || "").trim();
    const launchCommand = String(profile?.launch_command || "").trim();
    const backingHosts = Array.isArray(profile?.backing_hosts)
      ? profile.backing_hosts.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    const reasonCodes = [];
    const detailParts = [];
    if (!sparkPath) {
      reasonCodes.push("spark_model_path_unconfigured");
      detailParts.push("spark model path is not configured");
    } else if (!(await pathExists(sparkPath))) {
      reasonCodes.push("spark_model_missing");
      detailParts.push(`spark model path missing: ${sparkPath}`);
    }
    if (!gx10Path) {
      reasonCodes.push("gx10_model_path_unconfigured");
      detailParts.push("gx10 model path is not configured");
    } else if (!(await remotePathExists(gx10Path))) {
      reasonCodes.push("gx10_model_missing");
      detailParts.push(`gx10 model path missing: ${gx10Path}`);
    }
    if (!(backingHosts.includes("spark") && backingHosts.includes("gx10"))) {
      reasonCodes.push("backing_hosts_mismatch");
      detailParts.push("profile backing_hosts must include both spark and gx10");
    }
    const workerReachable = await runCommandImpl(`ssh ${workerSshOptions} ${shellQuote(workerSsh)} "exit 0"`, 12000);
    if (!workerReachable.ok) {
      reasonCodes.push("worker_unreachable");
      detailParts.push("gx10-b041 is unreachable");
    }
    return {
      ok: reasonCodes.length === 0,
      status: reasonCodes.length === 0 ? "passed" : "failed",
      reason_codes: Array.from(new Set(reasonCodes)),
      detail: detailParts.join("; "),
      evidence: {
        profile_id: String(profile?.profile_id || "").trim(),
        spark_model_path: sparkPath,
        gx10_model_path: gx10Path,
        worker_host: workerSsh,
        launch_command: launchCommand,
        backing_hosts: backingHosts,
      },
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

  const LEGACY_ACTIVATION_SET_IDS = Object.freeze({
    inferno: "gemma431",
  });

  function canonicalActivationSetId(setId) {
    const normalized = String(setId || "").trim();
    return LEGACY_ACTIVATION_SET_IDS[normalized] || normalized;
  }

  function activationSetById(config, setId) {
    const canonicalSetId = canonicalActivationSetId(setId);
    return (config.controller?.activation_sets || [])
      .find((entry) => String(entry?.set_id || "") === canonicalSetId);
  }

  function normalizeLaneTargets(laneTargets = {}) {
    return {
      large: String(laneTargets?.large || "").trim(),
      mini: laneTargets?.mini == null ? "" : String(laneTargets.mini).trim(),
    };
  }

  function activationSetIdForLaneTargets(config, laneTargets = {}) {
    const normalizedTargets = normalizeLaneTargets(laneTargets);
    const matches = (config.controller?.activation_sets || []).filter((entry) => {
      const entryTargets = normalizeLaneTargets(entry?.lane_targets || {});
      return entryTargets.large === normalizedTargets.large && entryTargets.mini === normalizedTargets.mini;
    });
    return matches.length === 1 ? String(matches[0]?.set_id || "").trim() : "";
  }

  function withResolvedActivationSetId(config, desiredState = {}) {
    const payload = {
      ...defaultDesiredState(),
      ...(desiredState || {}),
      lane_targets: {
        ...defaultDesiredState().lane_targets,
        ...(desiredState?.lane_targets || {}),
      },
    };
    const normalizedTargets = normalizeLaneTargets(payload.lane_targets);
    return {
      ...payload,
      lane_targets: {
        large: normalizedTargets.large,
        mini: payload?.lane_targets?.mini == null ? payload.lane_targets.mini : normalizedTargets.mini,
      },
      active_set_id: activationSetIdForLaneTargets(config, normalizedTargets) || null,
      schema_version: Number(payload.schema_version || 2),
    };
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

    if (!changed && String(desired.state || "") === "ready" && !anyUp) {
      apply({
        state: "failed",
        watchdog_enforce: false,
        status_detail: desired.status_detail || "ready state lost its active runtime",
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
    const swapManifest = await loadSwapManifest();
    const swapSummary = buildSwapSummary(swapManifest, { largePayload, miniPayload, fleet });
    const readinessLease = buildReadinessLease({
      desiredState,
      swapSummary,
      job: jobs.get(String(swapSummary.current_job_id || "").trim()) || null,
    });
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
      swap: swapSummary,
      readiness_lease: readinessLease,
      activating: _activating,
      activating_set_id: _activating ? _activatingSetId : null,
      activating_job_id: _activating ? _activatingJobId || null : null,
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
          },
          reconcile_policy: "Blocked while swap.action_policy_state='reconcile_needed'. Inspect /api/llm-host/current for blocked_actions and exit_requirements.",
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
          reconcile_policy: "Blocked while swap.action_policy_state='reconcile_needed' unless force=true is used after operator review.",
        },
        restart: {
          method: "POST",
          path: "/api/llm-host/actions/restart",
          body: {
            lane_id: "required: large or mini"
          },
          reconcile_policy: "Blocked while swap.action_policy_state='reconcile_needed' because restart routes through activation.",
        },
        stop: {
          method: "POST",
          path: "/api/llm-host/actions/stop",
          body: {
            lane_id: "required: large, mini, or all"
          },
          reconcile_policy: "Allowed during reconcile_needed so operators can drain runtime and clear side effects safely.",
        },
        bonzai: {
          method: "POST",
          path: "/bonzai",
          body: {},
          effect: "Clears mini and fleet state, then launches CoderNext on :8000.",
          reconcile_policy: "Blocked while swap.action_policy_state='reconcile_needed' because bonzai routes through activate-set.",
        },
        fleet_up: {
          method: "POST",
          path: "/fleet/up",
          body: {},
          effect: "Stops the large lane and brings up the default mini fleet: Qwen on spark:7999 plus DeepSeek on gx10:7999.",
          reconcile_policy: "Blocked while swap.action_policy_state='reconcile_needed'.",
        },
        fleet_down: {
          method: "POST",
          path: "/fleet/down",
          body: {},
          effect: "Stops the mini fleet on both boxes without touching the large lane.",
          reconcile_policy: "Allowed during reconcile_needed to help clear fleet-side runtime effects.",
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
    if (!preserveDesiredState) {
      _activationGeneration += 1;
    }
    if (lane === "large") {
      const config = await loadValidatedConfig();
      const largePort = String(config.lanes?.large?.port || 8000);
      const result = await runCommandImpl(
        `LLMCOMMUNE_LARGE_PORT=${shellQuote(largePort)} bash ${shellQuote(path.join(repoRoot, "scripts", "stop_large_lane.sh"))}`,
        300000,
      );
      const enrichedResult = (() => {
        const drainProof = parseDrainProof(result);
        return drainProof ? { ...result, drain_proof: drainProof } : result;
      })();
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
        await saveDesiredState(withResolvedActivationSetId(config, desired));
      }
      return enrichedResult;
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
      const first = await stopLane("mini", { preserveDesiredState: true });
      const second = await stopLane("large", { preserveDesiredState: true });
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
    if (!preserveDesiredState) {
      _activationGeneration += 1;
    }
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

  function summarizeCommandFailure(result) {
    const drainProof = parseDrainProof(result);
    const detail = [
      String(result?.stderr || "").trim(),
      String(result?.error || "").trim(),
      String(result?.stdout || "").trim(),
    ].find(Boolean);
    const drainDetail = summarizeDrainProof(drainProof);
    if (drainDetail) {
      return [detail, `drain proof ${drainDetail}`].filter(Boolean).join("; ");
    }
    return detail || "command failed";
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

  async function abortIfActivationSuperseded({
    expectedGeneration,
    jobId,
    laneId = "",
    detail = "activation superseded",
    stopLaneOnAbort = false,
  } = {}) {
    if (expectedGeneration === _activationGeneration) return false;
    if (stopLaneOnAbort && laneId) {
      await stopLane(laneId, { preserveDesiredState: true });
    }
    setJob(jobId, {
      status: "failed",
      current_phase: "failed",
      status_detail: detail,
      code: ErrorCode.ACTIVATION_SUPERSEDED,
    });
    metrics.activations_failed++;
    await appendJobHistory(jobHistoryPath, jobs.get(jobId));
    return true;
  }

  async function supersedeInFlightActivation(requestedSetId = "") {
    const supersededSetId = String(_activatingSetId || "").trim();
    const supersededJobId = String(_activatingJobId || "").trim();
    const supersededPromise = _activatingPromise;
    _activationGeneration += 1;
    if (supersededJobId) {
      setJob(supersededJobId, {
        status: "running",
        current_phase: "superseding",
        status_detail: requestedSetId
          ? `superseded by activation request for ${requestedSetId}`
          : "superseding in-flight activation",
      });
    }
    await stopFleet({ preserveDesiredState: true });
    await stopLane("all", { preserveDesiredState: true });
    if (supersededPromise) {
      try {
        await supersededPromise;
      } catch {
        // The superseded activation reports its own failure state.
      }
    }
    if (supersededJobId) {
      await appendSwapJournal("swap_superseded", {
        swap_id: supersededJobId,
        current_job_id: supersededJobId,
        requested_set_id: supersededSetId,
        canonical_set_id: supersededSetId,
        superseded_by_set_id: requestedSetId,
      });
    }
    return { supersededSetId, supersededJobId };
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
    activationGeneration = _activationGeneration,
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

    const swapAdmissionState = await loadSwapManifest();
    const reconcileBlocked = Boolean(
      swapAdmissionState.reconcile_needed || String(swapAdmissionState.terminal_state || "") === "reconcile_needed",
    );
    if (reconcileBlocked && !dryRun) {
      const blockedDetails = buildSwapAdmissionDetails(swapAdmissionState);
      await appendAuditLog({
        action: "activate",
        profile_id: profile.profile_id,
        lane_id: selectedLane,
        ok: false,
        code: ErrorCode.RECONCILE_REQUIRED,
        swap_id: blockedDetails.swap_id,
        controller_revision: blockedDetails.controller_revision,
        active_set_id: blockedDetails.active_set_id,
        reason: "swap_reconcile_needed",
      });
      return {
        ...apiError(
          ErrorCode.RECONCILE_REQUIRED,
          `controller requires reconcile before admitting profile '${profile.profile_id}' on ${selectedLane}`,
        ),
        requested_profile_id: profile.profile_id,
        lane_id: selectedLane,
        ...blockedDetails,
      };
    }

    const current = await currentState();
    const currentLane = current.lanes[selectedLane];
    const otherLaneId = selectedLane === "large" ? "mini" : "large";
    const currentOtherLane = current.lanes[otherLaneId];
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
    if (currentLane?.profile_id === profile.profile_id && currentLane?.up) {
      if (!preserveOtherLane && conflictingCurrent.length > 0) {
        if (!allowPreempt) {
          return {
            ...apiError(ErrorCode.LANE_OCCUPIED, `requested activation would preempt ${conflictingCurrent.join(", ")}`),
            accepted: false,
          };
        }
        if (current.mini_fleet?.up) {
          await stopFleet({ preserveDesiredState: true });
        }
        if (currentOtherLane?.profile_id && currentOtherLane.up) {
          await stopLane(otherLaneId, { preserveDesiredState: true });
        }
      }
      await persistLaneState(selectedLane, profile);
      await saveDesiredState(withResolvedActivationSetId(config, {
        mode: "lane",
        state: "ready",
        watchdog_enforce: true,
        lane_targets: laneTargetsForActivation({ selectedLane, profile, preserveOtherLane, otherLaneTarget }),
        fleet_id: "",
        status_detail: `${profile.profile_id} already active on ${selectedLane}`,
      }));
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
    const workerState = await workerClearState(config);
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
          await saveDesiredState(withResolvedActivationSetId(config, {
            ...desiredBefore,
            mode: "lane",
            state: "starting",
            watchdog_enforce: false,
            lane_targets: laneTargetsForActivation({ selectedLane, profile, preserveOtherLane, otherLaneTarget }),
            fleet_id: "",
            status_detail: `starting ${profile.profile_id} on ${selectedLane}`,
          }));
          setJob(jobId, { status: "running", current_phase: "stopping_conflicts" });
          if (allowPreempt) {
            const stopResults = [];
            stopResults.push({ scope: "fleet", result: await stopFleet({ preserveDesiredState: true }) });
            if (selectedLane === "large" && !preserveOtherLane) {
              stopResults.push({ scope: "mini", result: await stopLane("mini", { preserveDesiredState: true }) });
            } else if (selectedLane === "mini" && !preserveOtherLane) {
              stopResults.push({ scope: "large", result: await stopLane("large", { preserveDesiredState: true }) });
            }
            stopResults.push({ scope: selectedLane, result: await stopLane(selectedLane, { preserveDesiredState: true }) });
            const failedStops = stopResults.filter((entry) => !entry.result?.ok);
            if (failedStops.length > 0) {
              const detail = `pre-launch stop failed before starting ${profile.profile_id}; ${failedStops.map((entry) => `${entry.scope}: ${summarizeCommandFailure(entry.result)}`).join(" | ")}`;
              const failedDesired = await loadDesiredState();
              await saveDesiredState(withResolvedActivationSetId(config, {
                ...failedDesired,
                state: "failed",
                watchdog_enforce: false,
                status_detail: detail,
              }));
              logger.error("activate: pre-launch stop failed", {
                profile_id: profile.profile_id,
                lane: selectedLane,
                stop_results: stopResults.map((entry) => ({
                  scope: entry.scope,
                  ok: Boolean(entry.result?.ok),
                  error: String(entry.result?.error || ""),
                  stderr: String(entry.result?.stderr || ""),
                })),
              });
              setJob(jobId, {
                status: "failed",
                current_phase: "failed",
                status_detail: detail,
                code: ErrorCode.ACTIVATION_FAILED,
              });
              metrics.activations_failed++;
              await appendJobHistory(jobHistoryPath, jobs.get(jobId));
              return;
            }
            setJob(jobId, { current_phase: "stopping_conflicts", status_detail: "waiting for ports to settle" });
            await sleepImpl(5000);
          }
          if (await abortIfActivationSuperseded({
            expectedGeneration: activationGeneration,
            jobId,
            detail: `activation superseded before launching ${profile.profile_id}`,
          })) {
            return;
          }
          if (profile.requires_both_boxes) {
            const postStopWorkerState = await workerClearState(config);
            if (await abortIfActivationSuperseded({
              expectedGeneration: activationGeneration,
              jobId,
              detail: `activation superseded before launching ${profile.profile_id}`,
            })) {
              return;
            }
            if (!postStopWorkerState.clear) {
              const detail = `worker gx10-b041 is not clear for dual-box launch; containers=${postStopWorkerState.blocking_containers.join(",") || "none"} ports=${postStopWorkerState.responsive_ports.join(",") || "none"}`;
              const failedDesired = await loadDesiredState();
              await saveDesiredState(withResolvedActivationSetId(config, {
                ...failedDesired,
                state: "failed",
                watchdog_enforce: false,
                status_detail: detail,
              }));
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
          if (await abortIfActivationSuperseded({
            expectedGeneration: activationGeneration,
            jobId,
            laneId: selectedLane,
            detail: `activation superseded while starting ${profile.profile_id}`,
            stopLaneOnAbort: true,
          })) {
            return;
          }
          if (!result.ok) {
            const failedDesired = await loadDesiredState();
            await saveDesiredState(withResolvedActivationSetId(config, {
              ...failedDesired,
              state: "failed",
              watchdog_enforce: false,
              status_detail: "launch failed",
            }));
            logger.error("activate: launch failed", { profile_id: profile.profile_id, lane: selectedLane, stderr: result.stderr });
            setJob(jobId, { status: "failed", current_phase: "failed", status_detail: "launch failed", code: ErrorCode.LAUNCH_FAILED });
            metrics.activations_failed++;
            await appendJobHistory(jobHistoryPath, jobs.get(jobId));
            return;
          }
          setJob(jobId, { current_phase: "waiting_for_api" });
          const lanePort = config.lanes?.[selectedLane]?.port || 8000;
          const ready = await waitForReady(lanePort, (profile.startup_expectation?.ready_timeout_s || 900) * 1000);
          if (await abortIfActivationSuperseded({
            expectedGeneration: activationGeneration,
            jobId,
            laneId: selectedLane,
            detail: `activation superseded while waiting for ${profile.profile_id}`,
            stopLaneOnAbort: true,
          })) {
            return;
          }
          if (!ready) {
            const failedDesired = await loadDesiredState();
            await saveDesiredState(withResolvedActivationSetId(config, {
              ...failedDesired,
              state: "failed",
              watchdog_enforce: false,
              status_detail: "runtime did not become ready",
            }));
            setJob(jobId, { status: "failed", current_phase: "failed", status_detail: "runtime did not become ready", code: ErrorCode.ACTIVATION_TIMEOUT });
            metrics.activations_failed++;
            await appendJobHistory(jobHistoryPath, jobs.get(jobId));
            return;
          }
          await persistLaneState(selectedLane, profile);
          const readyDesired = await loadDesiredState();
          await saveDesiredState(withResolvedActivationSetId(config, {
            ...readyDesired,
            mode: "lane",
            state: "ready",
            watchdog_enforce: true,
            lane_targets: laneTargetsForActivation({ selectedLane, profile, preserveOtherLane, otherLaneTarget }),
            fleet_id: "",
            status_detail: `${profile.profile_id} ready on ${selectedLane}`,
          }));
          setJob(jobId, { status: "ready", current_phase: "ready", status_detail: "runtime ready" });
          metrics.activations_ready++;
          metrics.activation_duration_ms.push(nowMs() - startMs);
          if (metrics.activation_duration_ms.length > 100) metrics.activation_duration_ms.shift();
          await appendJobHistory(jobHistoryPath, jobs.get(jobId));
          await fireWebhook("activation_ready", { profile_id: profile.profile_id, lane_id: selectedLane });
        } catch (error) {
          const failedDesired = await loadDesiredState();
          await saveDesiredState(withResolvedActivationSetId(config, {
            ...failedDesired,
            state: "failed",
            watchdog_enforce: false,
            status_detail: "activation failed",
          }));
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
    setId = canonicalActivationSetId(setId);
    let supersededActivation = false;

    // ── Activation lock: one set activation at a time ────────────────────
    if (_activating) {
      const eta = new Date(_activatingStartMs + 300000).toISOString();
      if (String(_activatingSetId || "") === String(setId || "") && _activatingJobId) {
        if (wait && _activatingPromise) {
          await _activatingPromise;
        }
        const attachedJob = jobs.get(_activatingJobId);
        if (attachedJob) {
          const currentSwap = await loadSwapManifest();
          const attachedDetails = buildSwapAdmissionDetails(currentSwap, {
            current_job_id: _activatingJobId || currentSwap.current_job_id || "",
          });
          await appendSwapJournal("swap_attached", {
            swap_id: attachedDetails.swap_id || attachedJob.swap_id || _activatingJobId,
            current_job_id: _activatingJobId,
            requested_set_id: setId,
            canonical_set_id: setId,
            controller_revision: attachedDetails.controller_revision,
            state: attachedDetails.swap_state,
            terminal_state: attachedDetails.swap_terminal_state,
          });
          return {
            ok: true,
            accepted: true,
            attached: true,
            active_set_id: _activatingSetId,
            estimated_ready_at: eta,
            ...attachedJob,
            ...attachedDetails,
          };
        }
      }
      if (!allowPreempt) {
        const currentSwap = await loadSwapManifest();
        const conflictDetails = buildSwapAdmissionDetails(currentSwap, {
          current_job_id: _activatingJobId || currentSwap.current_job_id || "",
        });
        await appendSwapJournal("swap_rejected_conflict", {
          swap_id: conflictDetails.swap_id || _activatingJobId || "",
          current_job_id: conflictDetails.current_job_id || _activatingJobId || "",
          requested_set_id: setId,
          canonical_set_id: setId,
          controller_revision: conflictDetails.controller_revision,
          state: conflictDetails.swap_state,
          terminal_state: conflictDetails.swap_terminal_state,
          conflicting_set_id: _activatingSetId,
        });
        return {
          ok: false,
          accepted: false,
          code: ErrorCode.CONCURRENT_ACTIVATION,
          detail: `activation in progress for set '${_activatingSetId}' — try again later`,
          active_set_id: _activatingSetId,
          estimated_ready_at: eta,
          ...conflictDetails,
        };
      }
      await supersedeInFlightActivation(setId);
      supersededActivation = true;
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

    const swapAdmissionState = await loadSwapManifest();
    const reconcileBlocked = Boolean(
      swapAdmissionState.reconcile_needed || String(swapAdmissionState.terminal_state || "") === "reconcile_needed",
    );
    if (reconcileBlocked && !force && !dryRun && !supersededActivation) {
      const blockedDetails = buildSwapAdmissionDetails(swapAdmissionState);
      await appendAuditLog({
        action: "activate-set",
        set_id: setId,
        ok: false,
        code: ErrorCode.RECONCILE_REQUIRED,
        swap_id: blockedDetails.swap_id,
        controller_revision: blockedDetails.controller_revision,
        active_set_id: blockedDetails.active_set_id,
        reason: "swap_reconcile_needed",
      });
      return {
        ...apiError(
          ErrorCode.RECONCILE_REQUIRED,
          `controller requires reconcile before admitting set '${setId}' — resolve or force the active swap first`,
        ),
        ...blockedDetails,
      };
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
            const healthyCurrent = await currentState();
            const skipLargeProfileId = String(activationSet?.lane_targets?.large || "").trim();
            const skipMiniProfileId = String(activationSet?.lane_targets?.mini || "").trim();
            const skipLargeProfile = skipLargeProfileId ? profileById(config, skipLargeProfileId) : null;
            await recordSwapTransition("", "swap_ready", {
              requested_set_id: setId,
              canonical_set_id: setId,
              state: "ready",
              terminal_state: "ready",
              phase_started_at: currentIso(),
              desired_lane_targets: {
                large: skipLargeProfileId,
                mini: skipMiniProfileId || "",
              },
              observed_lane_targets: observedLaneTargetsFromPayloads(healthyCurrent?.lanes?.large, healthyCurrent?.lanes?.mini),
              parity_status: skipLargeProfile?.requires_both_boxes ? "passed" : "not_required",
              drain_status: "complete",
              readiness_status: "ready",
              known_idle: false,
              reconcile_needed: false,
              evidence_status: "minimal",
              evidence_refs: [],
              failure_code: "",
              failure_detail: "",
            });
            logger.info("activate-set: idempotent skip", { set_id: setId });
            return {
              ok: true,
              accepted: false,
              status: "skipped",
              set_id: setId,
              detail: `set '${setId}' is already active and healthy`,
              skipped: true,
              readiness_lease: healthyCurrent.readiness_lease || null,
            };
          }
        } catch { /* health check failed — proceed with full activation */ }
      }
    }

    // Rate limit: 30s cooldown after last completed activation (skipped for same set)
    if (!force && !supersededActivation && _lastActivationCompletedMs > 0) {
      const sinceLast = Date.now() - _lastActivationCompletedMs;
      if (sinceLast < ACTIVATION_COOLDOWN_MS) {
        const eta = new Date(_lastActivationCompletedMs + ACTIVATION_COOLDOWN_MS).toISOString();
        return {
          ok: false,
          accepted: false,
          code: ErrorCode.RATE_LIMITED,
          detail: `activation cooldown active — ${Math.ceil((ACTIVATION_COOLDOWN_MS - sinceLast) / 1000)}s remaining`,
          estimated_ready_at: eta,
        };
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

    const requiresDualBox = Boolean(
      activationSet.requires_dual_box || largeProfile?.requires_both_boxes || miniProfile?.requires_both_boxes,
    );
    const dualBoxProfile = largeProfile?.requires_both_boxes ? largeProfile : miniProfile?.requires_both_boxes ? miniProfile : null;
    const dualBoxParity = requiresDualBox
      ? await evaluateDualBoxParity({ profile: dualBoxProfile })
      : {
        ok: true,
        status: "not_required",
        reason_codes: [],
        detail: "",
        evidence: {},
      };
    if (!dryRun && !dualBoxParity.ok) {
      logger.warn("activate-set: dual-box parity failed", {
        set_id: setId,
        reason_codes: dualBoxParity.reason_codes,
        detail: dualBoxParity.detail,
      });
      return {
        ...apiError(
          ErrorCode.HARDWARE_UNAVAILABLE,
          `set '${setId}' failed dual-box parity preflight — ${dualBoxParity.detail || "required Spark and GX10 assets are not aligned"}`,
        ),
        accepted: false,
        set_id: setId,
        parity_status: dualBoxParity.status,
        parity_reason_codes: dualBoxParity.reason_codes,
        parity_detail: dualBoxParity.detail,
        parity_evidence: dualBoxParity.evidence,
      };
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
          parity: {
            status: dualBoxParity.status,
            reason_codes: dualBoxParity.reason_codes,
            detail: dualBoxParity.detail,
            evidence: dualBoxParity.evidence,
          },
        },
      };
    }

    _activating = true;
    _activatingSetId = setId;
    _activatingStartMs = nowMs();
    const _activationSetStartMs = nowMs();
    const activationGeneration = _activationGeneration;
    const jobId = uuid();
    _activatingJobId = jobId;
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
      activation_set_id: String(activationSet.set_id || ""),
      startup_expectation: {
        large: largeProfile?.startup_expectation || null,
        mini: miniProfile?.startup_expectation || null,
      },
      current_phase: "queued",
      status: "queued",
      started_at_ms: nowMs(),
      updated_at: currentIso(),
      swap_id: jobId,
      controller_epoch: controllerEpoch,
      controller_revision: 0,
      swap_state: "preflight",
      swap_terminal_state: "",
    };
    jobs.set(jobId, job);
    const initialSwap = await recordSwapTransition(jobId, "swap_requested", {
      swap_id: jobId,
      current_job_id: jobId,
      requested_set_id: setId,
      canonical_set_id: setId,
      requested_generation: activationGeneration,
      observed_generation: activationGeneration,
      state: "preflight",
      terminal_state: "",
      started_at: currentIso(),
      phase_started_at: currentIso(),
      desired_lane_targets: {
        large: largeProfileId,
        mini: miniProfileId || "",
      },
      observed_lane_targets: {
        large: "",
        mini: "",
      },
        parity_status: dualBoxParity.status,
      drain_status: "pending",
      readiness_status: "pending",
      known_idle: false,
      reconcile_needed: false,
      evidence_status: "pending",
      evidence_refs: [],
      failure_code: "",
      failure_detail: "",
    }, {
      allow_preempt: Boolean(allowPreempt),
      superseded_activation: Boolean(supersededActivation),
    });
    setJob(jobId, {
      controller_revision: initialSwap.controller_revision,
    });
    let activeSwap = initialSwap;

    const launch = async () => {
      try {
        if (largeProfile) {
          const largeStart = await recordSwapTransition(jobId, "swap_start_started", {
            state: "starting",
            phase_started_at: currentIso(),
            current_job_id: jobId,
              parity_status: dualBoxParity.status,
            drain_status: "pending",
            readiness_status: "pending",
            known_idle: false,
            reconcile_needed: false,
          }, {
            phase: "activating_large",
            profile_id: largeProfile.profile_id,
          }, {
            expectedControllerRevision: activeSwap.controller_revision,
            expectedSwapId: activeSwap.swap_id,
            expectedCurrentJobId: activeSwap.current_job_id || jobId,
          });
          if (swapTransitionRejected(largeStart)) {
            const detail = swapTransitionConflictDetail(largeStart, `swap start rejected before activating ${largeProfile.profile_id}`);
            setJob(jobId, {
              status: "failed",
              current_phase: "failed",
              status_detail: detail,
              code: ErrorCode.REVISION_CONFLICT,
              controller_revision: largeStart.controller_revision,
            });
            return;
          }
          activeSwap = largeStart;
          setJob(jobId, { status: "running", current_phase: "activating_large", status_detail: `starting ${largeProfile.profile_id} on large` });
          setJob(jobId, { controller_revision: largeStart.controller_revision });
          const largeResult = await activate({
            profileId: largeProfile.profile_id,
            laneId: "large",
            wait: true,
            allowPreempt,
            override: true,
            preserveOtherLane: Boolean(miniProfile),
            otherLaneTarget: miniProfile?.profile_id || "",
            activationGeneration,
          });
          if (String(largeResult?.status || "") !== "ready") {
            const failedCurrent = await currentState();
            const failedClassification = classifySwapFailureState({
              current: failedCurrent,
              failureCode: largeResult?.code || ErrorCode.INTERNAL_ERROR,
              failureDetail: largeResult?.status_detail || `failed to activate ${largeProfile.profile_id}`,
            });
            const failedSwap = await recordSwapTransition(jobId, failedClassification.eventType, {
              state: failedClassification.state,
              terminal_state: failedClassification.terminal_state,
              phase_started_at: currentIso(),
              current_job_id: jobId,
              readiness_status: failedClassification.readiness_status,
              known_idle: failedClassification.known_idle,
              reconcile_needed: failedClassification.reconcile_needed,
              evidence_status: failedClassification.evidence_status,
              observed_lane_targets: failedClassification.observed_lane_targets,
              failure_code: failedClassification.failure_code,
              failure_detail: failedClassification.failure_detail,
            }, {
              phase: "activating_large",
              profile_id: largeProfile.profile_id,
            }, {
              expectedControllerRevision: activeSwap.controller_revision,
              expectedSwapId: activeSwap.swap_id,
              expectedCurrentJobId: activeSwap.current_job_id || jobId,
            });
            if (swapTransitionRejected(failedSwap)) {
              const detail = swapTransitionConflictDetail(failedSwap, `swap failure classification rejected after activating ${largeProfile.profile_id}`);
              setJob(jobId, {
                status: "failed",
                current_phase: "failed",
                status_detail: detail,
                code: ErrorCode.REVISION_CONFLICT,
                controller_revision: failedSwap.controller_revision,
              });
              return;
            }
            setJob(jobId, {
              status: "failed",
              current_phase: "failed",
              status_detail: largeResult?.status_detail || `failed to activate ${largeProfile.profile_id}`,
              code: largeResult?.code || ErrorCode.INTERNAL_ERROR,
              controller_revision: failedSwap.controller_revision,
            });
            return;
          }
        }

        if (activationGeneration !== _activationGeneration) {
          setJob(jobId, {
            status: "failed",
            current_phase: "failed",
            status_detail: "activation set superseded",
            code: ErrorCode.ACTIVATION_SUPERSEDED,
          });
          return;
        }

        if (miniProfile) {
          const miniStart = await recordSwapTransition(jobId, "swap_start_started", {
            state: "starting",
            phase_started_at: currentIso(),
            current_job_id: jobId,
            drain_status: "complete",
            readiness_status: "pending",
            known_idle: false,
            reconcile_needed: false,
          }, {
            phase: "activating_mini",
            profile_id: miniProfile.profile_id,
          }, {
            expectedControllerRevision: activeSwap.controller_revision,
            expectedSwapId: activeSwap.swap_id,
            expectedCurrentJobId: activeSwap.current_job_id || jobId,
          });
          if (swapTransitionRejected(miniStart)) {
            const detail = swapTransitionConflictDetail(miniStart, `swap start rejected before activating ${miniProfile.profile_id}`);
            setJob(jobId, {
              status: "failed",
              current_phase: "failed",
              status_detail: detail,
              code: ErrorCode.REVISION_CONFLICT,
              controller_revision: miniStart.controller_revision,
            });
            return;
          }
          activeSwap = miniStart;
          setJob(jobId, { status: "running", current_phase: "activating_mini", status_detail: `starting ${miniProfile.profile_id} on mini` });
          setJob(jobId, { controller_revision: miniStart.controller_revision });
          const miniResult = await activate({
            profileId: miniProfile.profile_id,
            laneId: "mini",
            wait: true,
            allowPreempt,
            override: true,
            preserveOtherLane: Boolean(largeProfile),
            otherLaneTarget: largeProfile?.profile_id || "",
            activationGeneration,
          });
          if (String(miniResult?.status || "") !== "ready") {
            const failedCurrent = await currentState();
            const failedClassification = classifySwapFailureState({
              current: failedCurrent,
              failureCode: miniResult?.code || ErrorCode.INTERNAL_ERROR,
              failureDetail: miniResult?.status_detail || `failed to activate ${miniProfile.profile_id}`,
            });
            const failedSwap = await recordSwapTransition(jobId, failedClassification.eventType, {
              state: failedClassification.state,
              terminal_state: failedClassification.terminal_state,
              phase_started_at: currentIso(),
              current_job_id: jobId,
              readiness_status: failedClassification.readiness_status,
              known_idle: failedClassification.known_idle,
              reconcile_needed: failedClassification.reconcile_needed,
              evidence_status: failedClassification.evidence_status,
              observed_lane_targets: failedClassification.observed_lane_targets,
              failure_code: failedClassification.failure_code,
              failure_detail: failedClassification.failure_detail,
            }, {
              phase: "activating_mini",
              profile_id: miniProfile.profile_id,
            }, {
              expectedControllerRevision: activeSwap.controller_revision,
              expectedSwapId: activeSwap.swap_id,
              expectedCurrentJobId: activeSwap.current_job_id || jobId,
            });
            if (swapTransitionRejected(failedSwap)) {
              const detail = swapTransitionConflictDetail(failedSwap, `swap failure classification rejected after activating ${miniProfile.profile_id}`);
              setJob(jobId, {
                status: "failed",
                current_phase: "failed",
                status_detail: detail,
                code: ErrorCode.REVISION_CONFLICT,
                controller_revision: failedSwap.controller_revision,
              });
              return;
            }
            setJob(jobId, {
              status: "failed",
              current_phase: "failed",
              status_detail: miniResult?.status_detail || `failed to activate ${miniProfile.profile_id}`,
              code: miniResult?.code || ErrorCode.INTERNAL_ERROR,
              controller_revision: failedSwap.controller_revision,
            });
            return;
          }
        }

        if (activationGeneration !== _activationGeneration) {
          setJob(jobId, {
            status: "failed",
            current_phase: "failed",
            status_detail: "activation set superseded",
            code: ErrorCode.ACTIVATION_SUPERSEDED,
          });
          return;
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
          lane_dark_states: {},
          fleet_id: "",
          status_detail: largeProfileId && miniProfileId
            ? `${largeProfileId} ready on large + ${miniProfileId} ready on mini`
            : largeProfileId
              ? `${largeProfileId} ready on large`
              : `${miniProfileId} ready on mini`,
        });
        const readyCurrent = await currentState();
        const readySwap = await recordSwapTransition(jobId, "swap_ready", {
          state: "ready",
          terminal_state: "ready",
          phase_started_at: currentIso(),
          current_job_id: jobId,
          observed_generation: activationGeneration,
          desired_lane_targets: {
            large: largeProfileId,
            mini: miniProfileId || "",
          },
          observed_lane_targets: observedLaneTargetsFromPayloads(readyCurrent?.lanes?.large, readyCurrent?.lanes?.mini),
          parity_status: largeProfile?.requires_both_boxes ? "passed" : "not_required",
          drain_status: "complete",
          readiness_status: "ready",
          known_idle: false,
          reconcile_needed: false,
          evidence_status: "minimal",
          evidence_refs: [],
          failure_code: "",
          failure_detail: "",
        }, {}, {
          expectedControllerRevision: activeSwap.controller_revision,
          expectedSwapId: activeSwap.swap_id,
          expectedCurrentJobId: activeSwap.current_job_id || jobId,
        });
        if (swapTransitionRejected(readySwap)) {
          const detail = swapTransitionConflictDetail(readySwap, "swap ready classification rejected after controller ownership changed");
          setJob(jobId, {
            status: "failed",
            current_phase: "failed",
            status_detail: detail,
            code: ErrorCode.REVISION_CONFLICT,
            controller_revision: readySwap.controller_revision,
          });
          return;
        }
        setJob(jobId, { status: "ready", current_phase: "ready", status_detail: "activation set ready" });
        setJob(jobId, { controller_revision: readySwap.controller_revision });
        await appendAuditLog({ action: "activate-set", set_id: setId, ok: true, elapsed_ms: nowMs() - _activationSetStartMs });
      } catch (error) {
        const _errDetail = String(error?.message || error || "activation set failed");
        const failedCurrent = await currentState();
        const failedClassification = classifySwapFailureState({
          current: failedCurrent,
          failureCode: ErrorCode.INTERNAL_ERROR,
          failureDetail: _errDetail,
        });
        const failedSwap = await recordSwapTransition(jobId, failedClassification.eventType, {
          state: failedClassification.state,
          terminal_state: failedClassification.terminal_state,
          phase_started_at: currentIso(),
          current_job_id: jobId,
          readiness_status: failedClassification.readiness_status,
          known_idle: failedClassification.known_idle,
          reconcile_needed: failedClassification.reconcile_needed,
          evidence_status: failedClassification.evidence_status,
          observed_lane_targets: failedClassification.observed_lane_targets,
          failure_code: failedClassification.failure_code,
          failure_detail: failedClassification.failure_detail,
        }, {}, {
          expectedControllerRevision: activeSwap.controller_revision,
          expectedSwapId: activeSwap.swap_id,
          expectedCurrentJobId: activeSwap.current_job_id || jobId,
        });
        if (swapTransitionRejected(failedSwap)) {
          setJob(jobId, {
            status: "failed",
            current_phase: "failed",
            status_detail: swapTransitionConflictDetail(failedSwap, _errDetail),
            code: ErrorCode.REVISION_CONFLICT,
            controller_revision: failedSwap.controller_revision,
          });
          await appendAuditLog({ action: "activate-set", set_id: setId, ok: false, error: swapTransitionConflictDetail(failedSwap, _errDetail), elapsed_ms: nowMs() - _activationSetStartMs });
          return;
        }
        setJob(jobId, {
          status: "failed",
          current_phase: "failed",
          status_detail: _errDetail,
          code: ErrorCode.INTERNAL_ERROR,
          controller_revision: failedSwap.controller_revision,
        });
        await appendAuditLog({ action: "activate-set", set_id: setId, ok: false, error: _errDetail, elapsed_ms: nowMs() - _activationSetStartMs });
        logger.error("activateSet: unexpected error", { set_id: setId, error: _errDetail });
      } finally {
        _activating = false;
        _activatingSetId = "";
        _activatingJobId = "";
        _activatingPromise = null;
        _lastActivationCompletedMs = Date.now();
      }
    };

    _activatingPromise = launch();
    if (wait) {
      await _activatingPromise;
      return getJobPayload(jobId);
    }
    return getJobPayload(jobId);
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
    const sets = allActivationSets(config).map((s) => ({
      set_id: String(s.set_id || ""),
      display_name: String(s.display_name || ""),
      description: String(s.description || ""),
      requires_dual_box: Boolean(s.requires_dual_box),
      studio_preset_id: String(s.studio_preset_id || ""),
      published_revision: studioRevisionForSet(s),
      lane_targets: {
        large: s.lane_targets?.large || null,
        mini: s.lane_targets?.mini || null,
      },
      currently_active: String(s.set_id || "") === activeSetId,
    }));
    return {
      ok: true,
      sets,
      activation_sets: sets,
      currently_active_set_id: activeSetId || null,
      total: allActivationSets(config).length,
    };
  }

  const MAX_SETS = 50;

  function normalizeStudioText(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function tokenizeStudioValues(values) {
    const skip = new Set([
      "and",
      "the",
      "for",
      "lane",
      "set",
      "large",
      "mini",
      "single",
      "dual",
      "instruct",
      "chat",
      "files",
      "models",
      "runtime",
      "profile",
      "activation",
    ]);
    const tokens = new Set();
    for (const value of values) {
      for (const token of normalizeStudioText(value).split(/\s+/).filter(Boolean)) {
        if (!skip.has(token)) {
          tokens.add(token);
        }
      }
    }
    return [...tokens];
  }

  function sanitizeStudioId(value, fallback = "preset") {
    const normalized = normalizeStudioText(value).replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
    const safe = normalized || fallback;
    return safe.slice(0, 63);
  }

  function parsePublishedRevision(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  }

  function studioModeForTargets(laneTargets) {
    return laneTargets?.mini ? "combo" : "solo";
  }

  function cleanLaneTargets(laneTargets = {}) {
    return {
      large: String(laneTargets?.large || "").trim() || null,
      mini: Object.prototype.hasOwnProperty.call(laneTargets || {}, "mini")
        ? (String(laneTargets?.mini || "").trim() || null)
        : null,
    };
  }

  function formatPublishedStudioSetId(presetId, publishedRevision) {
    const suffix = `_r${String(parsePublishedRevision(publishedRevision, 0)).padStart(4, "0")}`;
    const safeBase = sanitizeStudioId(presetId, "preset");
    return `${safeBase.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
  }

  function validateActivationSetTargets(config, laneTargets) {
    const cleaned = cleanLaneTargets(laneTargets);
    const profileIds = new Set((config.profiles || []).map((profile) => String(profile.profile_id || "")));
    if (cleaned.large && !profileIds.has(cleaned.large)) {
      return {
        ok: false,
        error: { ...apiError(ErrorCode.PROFILE_NOT_FOUND, `unknown profile_id '${cleaned.large}' for lane_targets.large`), accepted: false },
      };
    }
    if (cleaned.mini && !profileIds.has(cleaned.mini)) {
      return {
        ok: false,
        error: { ...apiError(ErrorCode.PROFILE_NOT_FOUND, `unknown profile_id '${cleaned.mini}' for lane_targets.mini`), accepted: false },
      };
    }
    if (!cleaned.large && !cleaned.mini) {
      return {
        ok: false,
        error: { ...apiError(ErrorCode.INPUT_INVALID, "lane_targets must include at least one of large or mini"), accepted: false },
      };
    }
    const largeProfile = cleaned.large ? profileById(config, cleaned.large) : null;
    const miniProfile = cleaned.mini ? profileById(config, cleaned.mini) : null;
    return {
      ok: true,
      lane_targets: cleaned,
      large_profile: largeProfile,
      mini_profile: miniProfile,
      requires_dual_box: Boolean(largeProfile?.requires_both_boxes || miniProfile?.requires_both_boxes),
    };
  }

  function defaultStudioDraftState() {
    return {
      version: 1,
      updated_at: currentIso(),
      drafts: [],
    };
  }

  async function loadStudioDraftState() {
    const loaded = await readJsonImpl(studioDraftsPath, defaultStudioDraftState());
    return {
      ...defaultStudioDraftState(),
      ...loaded,
      drafts: Array.isArray(loaded?.drafts) ? loaded.drafts : [],
    };
  }

  async function saveStudioDraftState(nextState) {
    const payload = {
      version: 1,
      updated_at: currentIso(),
      drafts: Array.isArray(nextState?.drafts) ? nextState.drafts : [],
    };
    await writeJsonImpl(studioDraftsPath, payload);
    return payload;
  }

  function defaultStudioDefaults() {
    return {
      version: 1,
      updated_at: currentIso(),
      solo: null,
      combo: null,
    };
  }

  async function loadStudioDefaults() {
    const loaded = await readJsonImpl(studioDefaultsPath, defaultStudioDefaults());
    return {
      ...defaultStudioDefaults(),
      ...loaded,
    };
  }

  async function saveStudioDefaults(nextDefaults) {
    const payload = {
      version: 1,
      updated_at: currentIso(),
      solo: nextDefaults?.solo || null,
      combo: nextDefaults?.combo || null,
    };
    await writeJsonImpl(studioDefaultsPath, payload);
    return payload;
  }

  async function readJsonLines(filePath) {
    try {
      const raw = await readFile(filePath, "utf-8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async function appendStudioActionLog(entry) {
    await mkdir(path.dirname(studioActionLogPath), { recursive: true });
    let rows = [];
    try {
      const raw = await readFile(studioActionLogPath, "utf-8");
      rows = raw.split("\n").filter(Boolean);
    } catch {}
    rows.push(JSON.stringify({ ts: currentIso(), ...entry }));
    if (rows.length > 200) {
      rows = rows.slice(-200);
    }
    const tmp = studioActionLogPath + ".tmp";
    await writeFile(tmp, rows.join("\n") + "\n", "utf-8");
    await rename(tmp, studioActionLogPath);
  }

  async function readStudioActionLog(limit = 30) {
    const entries = await readJsonLines(studioActionLogPath);
    return entries.slice(-Math.max(1, limit));
  }

  function parseQualityScore(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    const match = String(value || "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function normalizeScoreboardRows(payload) {
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.entries)
          ? payload.entries
          : [];
    return rows
      .map((row) => ({
        model: String(row?.model || row?.name || "").trim(),
        engine: String(row?.engine || row?.runtime || "").trim(),
        file: String(row?.file || row?.source_file || "").trim(),
        spinup_seconds: Number.isFinite(Number(row?.spinup_seconds)) ? Number(row.spinup_seconds) : null,
        tokens_per_second: Number.isFinite(Number(row?.tokens_per_second)) ? Number(row.tokens_per_second) : null,
        quality_score: parseQualityScore(row?.quality_score),
        quality_label: String(row?.quality_score || "").trim(),
        quality_notes: String(row?.quality_notes || "").trim(),
      }))
      .filter((row) => row.model || row.file);
  }

  async function loadStudioScoreboardSource() {
    const candidates = [
      path.join(repoRoot, "workspace", "bakeoff_results.json"),
      externalBakeoffScoreboardPath,
    ];
    const sources = [];
    let selectedPath = null;
    let rows = [];
    for (const candidate of candidates) {
      try {
        const meta = await stat(candidate);
        sources.push({
          path: candidate,
          present: true,
          mtime: new Date(meta.mtimeMs).toISOString(),
          mtime_ms: meta.mtimeMs,
          size_bytes: meta.size,
        });
        const normalized = normalizeScoreboardRows(await readJsonImpl(candidate, null));
        if (!selectedPath && normalized.length > 0) {
          selectedPath = candidate;
          rows = normalized;
        }
      } catch {
        sources.push({ path: candidate, present: false, mtime_ms: 0, size_bytes: 0 });
      }
    }
    return { selected_path: selectedPath, rows, sources };
  }

  function studioSourceSignature(sources) {
    return JSON.stringify((sources || []).map((source) => [
      source.path,
      Boolean(source.present),
      Number(source.mtime_ms || 0),
      Number(source.size_bytes || 0),
    ]));
  }

  function studioPresetIdForSet(set) {
    return String(set?.studio_preset_id || set?.set_id || "").trim();
  }

  function studioRevisionForSet(set) {
    return Object.prototype.hasOwnProperty.call(set || {}, "published_revision")
      ? parsePublishedRevision(set?.published_revision, 0)
      : 0;
  }

  function studioEvidenceKey(presetId, publishedRevision) {
    return `${String(presetId || "").trim()}#${parsePublishedRevision(publishedRevision, 0)}`;
  }

  function scoreStudioEvidenceMatch(setRecord, largeProfile, row) {
    const targetTokens = tokenizeStudioValues([
      largeProfile?.display_name,
      largeProfile?.model_id,
      largeProfile?.profile_id,
      setRecord?.display_name,
      setRecord?.description,
      setRecord?.set_id,
    ]);
    const rowTokens = new Set(tokenizeStudioValues([
      row?.model,
      row?.file,
      row?.engine,
    ]));
    let score = 0;
    for (const token of targetTokens) {
      if (rowTokens.has(token)) {
        score += 1;
      }
    }
    const profileIdToken = normalizeStudioText(largeProfile?.profile_id || "").replace(/\s+/g, "");
    const rowFileToken = normalizeStudioText(row?.file || "").replace(/\s+/g, "");
    if (profileIdToken && rowFileToken.includes(profileIdToken)) {
      score += 2;
    }
    const modelIdToken = normalizeStudioText(largeProfile?.model_id || "");
    const rowModelToken = normalizeStudioText(row?.model || "");
    if (modelIdToken && rowModelToken && (rowModelToken.includes(modelIdToken) || modelIdToken.includes(rowModelToken))) {
      score += 2;
    }
    return score;
  }

  function evidenceCompatibility(runtimeFamily, engine) {
    const runtimeTokens = new Set(tokenizeStudioValues([runtimeFamily]));
    const engineTokens = new Set(tokenizeStudioValues([engine]));
    if (runtimeTokens.has("llama") && runtimeTokens.has("cpp") && engineTokens.has("llama") && engineTokens.has("cpp")) {
      return "compatible";
    }
    if ((runtimeTokens.has("trt") || runtimeTokens.has("trtllm") || runtimeTokens.has("tensorrt")) &&
      (engineTokens.has("trt") || engineTokens.has("trtllm") || engineTokens.has("tensorrt"))) {
      return "compatible";
    }
    if (runtimeTokens.has("nim") && engineTokens.has("nim")) {
      return "compatible";
    }
    if (runtimeTokens.has("ollama") && engineTokens.has("ollama")) {
      return "compatible";
    }
    return engineTokens.size > 0 ? "mismatched" : "unknown";
  }

  function buildStudioEvidenceEntries(config, scoreboardRows, selectedPath) {
    return allActivationSets(config).map((set) => {
      const laneTargets = cleanLaneTargets(set?.lane_targets);
      const largeProfile = laneTargets.large ? profileById(config, laneTargets.large) : null;
      const ranked = largeProfile
        ? scoreboardRows
          .map((row) => ({ row, score: scoreStudioEvidenceMatch(set, largeProfile, row) }))
          .filter((entry) => entry.score >= 2)
          .sort((left, right) => right.score - left.score)
        : [];
      const best = ranked[0] || null;
      const compatibility = best ? evidenceCompatibility(largeProfile?.runtime_family, best.row?.engine) : "unknown";
      return {
        preset_id: studioPresetIdForSet(set),
        published_revision: studioRevisionForSet(set),
        activation_set_id: String(set?.set_id || ""),
        mode: studioModeForTargets(laneTargets),
        large_profile_id: largeProfile?.profile_id || null,
        large_model_id: largeProfile?.model_id || null,
        large_runtime_family: largeProfile?.runtime_family || null,
        evidence_status: best ? compatibility : "unknown",
        matched_score: best?.score || 0,
        matched_model: best?.row?.model || null,
        matched_engine: best?.row?.engine || null,
        matched_file: best?.row?.file || null,
        spinup_seconds: best?.row?.spinup_seconds ?? null,
        tokens_per_second: best?.row?.tokens_per_second ?? null,
        quality_score: best?.row?.quality_score ?? null,
        quality_label: best?.row?.quality_label || "",
        quality_notes: best?.row?.quality_notes || "",
        evidence_source_path: selectedPath || null,
      };
    });
  }

  function buildStudioRecommendations(evidenceEntries, stale = false) {
    if (stale) {
      return {
        solo: null,
        combo: null,
        stale: true,
        detail: "Bakeoff evidence source unavailable; recommendations suppressed.",
      };
    }
    const pick = (mode) => {
      const candidates = evidenceEntries
        .filter((entry) => entry.mode === mode && entry.evidence_status === "compatible" && entry.quality_score !== null)
        .sort((left, right) =>
          (right.quality_score || 0) - (left.quality_score || 0) ||
          (right.tokens_per_second || 0) - (left.tokens_per_second || 0) ||
          (left.spinup_seconds || Number.POSITIVE_INFINITY) - (right.spinup_seconds || Number.POSITIVE_INFINITY));
      const top = candidates[0];
      if (!top) {
        return null;
      }
      return {
        preset_id: top.preset_id,
        published_revision: top.published_revision,
        activation_set_id: top.activation_set_id,
        mode,
        quality_score: top.quality_score,
        quality_label: top.quality_label,
        tokens_per_second: top.tokens_per_second,
        spinup_seconds: top.spinup_seconds,
        rationale: `Best compatible bakeoff quality (${top.quality_label || top.quality_score}) with ${top.tokens_per_second ?? "?"} tok/s throughput.`,
      };
    };
    return {
      solo: pick("solo"),
      combo: pick("combo"),
      stale: false,
    };
  }

  function studioCatalogMetric(preset, field) {
    const value = preset?.evidence?.[field];
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function studioEvidenceStatusRank(status) {
    switch (String(status || "").trim().toLowerCase()) {
      case "compatible":
        return 4;
      case "mismatched":
        return 3;
      case "stale":
        return 2;
      default:
        return 1;
    }
  }

  function compareStudioCatalogPresets(left, right) {
    return (right.latest_for_preset ? 1 : 0) - (left.latest_for_preset ? 1 : 0) ||
      studioEvidenceStatusRank(right.evidence_status) - studioEvidenceStatusRank(left.evidence_status) ||
      ((studioCatalogMetric(right, "quality_score") ?? Number.NEGATIVE_INFINITY) -
        (studioCatalogMetric(left, "quality_score") ?? Number.NEGATIVE_INFINITY)) ||
      ((studioCatalogMetric(right, "tokens_per_second") ?? Number.NEGATIVE_INFINITY) -
        (studioCatalogMetric(left, "tokens_per_second") ?? Number.NEGATIVE_INFINITY)) ||
      ((studioCatalogMetric(left, "spinup_seconds") ?? Number.POSITIVE_INFINITY) -
        (studioCatalogMetric(right, "spinup_seconds") ?? Number.POSITIVE_INFINITY)) ||
      ((studioCatalogMetric(right, "matched_score") ?? Number.NEGATIVE_INFINITY) -
        (studioCatalogMetric(left, "matched_score") ?? Number.NEGATIVE_INFINITY)) ||
      (right.recommended ? 1 : 0) - (left.recommended ? 1 : 0) ||
      (right.default_selected ? 1 : 0) - (left.default_selected ? 1 : 0) ||
      (right.currently_active ? 1 : 0) - (left.currently_active ? 1 : 0) ||
      left.preset_id.localeCompare(right.preset_id) ||
      right.published_revision - left.published_revision;
  }

  function annotateStudioCatalogPresets(presets) {
    let nextBakeoffRank = 0;
    return presets
      .slice()
      .sort(compareStudioCatalogPresets)
      .map((preset, index) => {
        const hasBakeoffSignal = preset.evidence_status !== "unknown" &&
          (studioCatalogMetric(preset, "quality_score") !== null ||
            studioCatalogMetric(preset, "tokens_per_second") !== null ||
            studioCatalogMetric(preset, "matched_score") !== null ||
            String(preset?.evidence?.matched_model || "").trim().length > 0);
        if (hasBakeoffSignal) {
          nextBakeoffRank += 1;
        }
        return {
          ...preset,
          catalog_rank: index + 1,
          bakeoff_rank: hasBakeoffSignal ? nextBakeoffRank : null,
        };
      });
  }

  const CATALOG_FAMILY_META = Object.freeze({
    qwen80next: { display_name: "Qwen3 Next 80B" },
    qwen80nextcoder: { display_name: "CoderNext" },
    gemma431: { display_name: "Gemma 4 31B GGUF" },
    gptoss120: { display_name: "GPT-OSS 120B" },
    gptoss20: { display_name: "GPT-OSS 20B" },
    qwen36: { display_name: "Qwen3.6 35B" },
    qwen36mini: { display_name: "Qwen3.6 35B Reviewer" },
    "qwen35-122b": { display_name: "Qwen3.5 122B" },
    "minimax-m27": { display_name: "MiniMax M2.7" },
    qwen235: { display_name: "Qwen3 235B" },
    llama370: { display_name: "Llama 3.3 70B" },
    nemotron120: { display_name: "Nemotron 3 Super 120B" },
    gemma431mini: { display_name: "Gemma 4 31B GGUF Reviewer" },
    gemma426: { display_name: "Gemma 4 26B A4B" },
    gemma426mini: { display_name: "Gemma 4 26B A4B Reviewer" },
    qwen30mini: { display_name: "Qwen3 30B Mini" },
    qwen32mini: { display_name: "Qwen3 32B Mini" },
    deepseek32mini: { display_name: "DeepSeek 32B Mini" },
  });

  const LEGACY_CATALOG_ALIASES = Object.freeze(new Set([
    "gamenator_qwen",
    "gamenator_gpt",
    "inferno",
  ]));

  const CANDIDATE_COMBO_SPECS = Object.freeze([
    { family_id: "qwen36", mini_family_id: "gemma426", recommendation_state: "promote_next" },
    { family_id: "gptoss120", mini_family_id: "gemma426", recommendation_state: "promote_next" },
    { family_id: "qwen35-122b", mini_family_id: "gemma426", recommendation_state: "available_bench" },
  ]);

  function catalogFamilyDisplayName(familyId) {
    return CATALOG_FAMILY_META[familyId]?.display_name || String(familyId || "").trim() || "Unknown";
  }

  function catalogRuntimeVariantId(runtimeFamily) {
    const lowered = normalizeStudioText(runtimeFamily || "").replace(/\s+/g, "");
    if (lowered.includes("llama") && lowered.includes("cpp")) return "gguf";
    if (lowered.includes("trt")) return "trt";
    if (lowered.includes("vllm")) return "vllm";
    if (lowered.includes("nim")) return "nim";
    if (lowered.includes("ollama")) return "ollama";
    return lowered || "unknown";
  }

  function catalogRecommendationRank(state) {
    switch (String(state || "").trim().toLowerCase()) {
      case "promote_next":
        return 3;
      case "available_bench":
        return 2;
      default:
        return 1;
    }
  }

  function catalogPublicationRank(state) {
    switch (String(state || "").trim().toLowerCase()) {
      case "current_published":
        return 2;
      case "candidate":
        return 1;
      default:
        return 0;
    }
  }

  function catalogFamilyIdFromValues(...values) {
    const blob = normalizeStudioText(values.filter(Boolean).join(" ")).replace(/\s+/g, "");
    if (!blob) return "";
    if (blob.includes("qwen3codernext") || blob.includes("codernext")) return "qwen80nextcoder";
    if (blob.includes("qwen3next80b") || blob.includes("qwen3next80ba3b") || blob.includes("qwen80next")) return "qwen80next";
    if (blob.includes("qwen36mini") || blob.includes("qwen3.635bggufmini") || blob.includes("qwen36_35b_mini") || blob.includes("gguf_qwen36_35b_mini")) return "qwen36mini";
    if (blob.includes("qwen3.635b") || blob.includes("qwen3635b") || blob.includes("qwen36_35b")) return "qwen36";
    if (blob.includes("qwen3.5122b") || blob.includes("qwen35122b") || blob.includes("qwen35_122b")) return "qwen35-122b";
    if (blob.includes("qwen323bnvfp4") || blob.includes("qwen332bnvfp4") || blob.includes("qwen32mini")) return "qwen32mini";
    if (blob.includes("qwen330ba3b") || blob.includes("qwen30mini")) return "qwen30mini";
    if (blob.includes("qwen3235b") || blob.includes("qwen235")) return "qwen235";
    if (blob.includes("gptoss120b")) return "gptoss120";
    if (blob.includes("gptoss20b")) return "gptoss20";
    if (blob.includes("gemma426ba4b") || blob.includes("gemma426") || blob.includes("gemma4-26b-a4b") || blob.includes("gguf_gemma4_26b_a4b")) return "gemma426";
    if (blob.includes("gemma431b")) return "gemma431";
    if (blob.includes("deepseekr132b") || blob.includes("deepseek32")) return "deepseek32mini";
    if (blob.includes("llama3.370b") || blob.includes("llama3370b") || blob.includes("llama370")) return "llama370";
    if (blob.includes("nemotron3super120b") || blob.includes("nemotron120")) return "nemotron120";
    if (blob.includes("minimaxm2.7") || blob.includes("minimaxm27")) return "minimax-m27";
    return "";
  }

  function catalogEntryTypeForMiniFamily(miniFamilyId) {
    return miniFamilyId ? "combo" : "solo";
  }

  function catalogEntryIdForFamilies(familyId, miniFamilyId = "") {
    return miniFamilyId ? `${familyId}__${miniFamilyId}` : familyId;
  }

  function catalogActivationTargetToken(familyId, lane = "large") {
    if (lane === "mini" && familyId === "gemma431") return "gemma431mini";
    if (lane === "mini" && familyId === "gemma426") return "gemma426mini";
    return familyId;
  }

  function catalogGeneratedActivationTargetId(familyId, miniFamilyId = "") {
    const largeToken = catalogActivationTargetToken(familyId, "large");
    if (!miniFamilyId) return largeToken;
    return `${largeToken}-${catalogActivationTargetToken(miniFamilyId, "mini")}`;
  }

  function catalogEntryDisplayName(familyId, miniFamilyId = "") {
    const family = catalogFamilyDisplayName(familyId);
    if (!miniFamilyId) return family;
    return `${family} + ${catalogFamilyDisplayName(miniFamilyId)}`;
  }

  function catalogVariantSort(left, right) {
    return studioEvidenceStatusRank(right.evidence_status) - studioEvidenceStatusRank(left.evidence_status) ||
      ((right.quality_score ?? Number.NEGATIVE_INFINITY) - (left.quality_score ?? Number.NEGATIVE_INFINITY)) ||
      ((right.tokens_per_second ?? Number.NEGATIVE_INFINITY) - (left.tokens_per_second ?? Number.NEGATIVE_INFINITY)) ||
      ((left.spinup_seconds ?? Number.POSITIVE_INFINITY) - (right.spinup_seconds ?? Number.POSITIVE_INFINITY)) ||
      catalogRecommendationRank(right.recommendation_state) - catalogRecommendationRank(left.recommendation_state) ||
      catalogPublicationRank(right.publication_state) - catalogPublicationRank(left.publication_state) ||
      String(left.variant_id || "").localeCompare(String(right.variant_id || "")) ||
      String(left.activation_target_id || left.variant_display_name || "").localeCompare(String(right.activation_target_id || right.variant_display_name || ""));
  }

  function catalogRowSort(left, right) {
    const shelfOrder = { current: 3, promote_next: 2, available_bench: 1 };
    return (shelfOrder[right.catalog_shelf] || 0) - (shelfOrder[left.catalog_shelf] || 0) ||
      (studioEvidenceStatusRank(right.evidence_status) - studioEvidenceStatusRank(left.evidence_status)) ||
      ((right.quality_score ?? Number.NEGATIVE_INFINITY) - (left.quality_score ?? Number.NEGATIVE_INFINITY)) ||
      ((right.tokens_per_second ?? Number.NEGATIVE_INFINITY) - (left.tokens_per_second ?? Number.NEGATIVE_INFINITY)) ||
      ((left.spinup_seconds ?? Number.POSITIVE_INFINITY) - (right.spinup_seconds ?? Number.POSITIVE_INFINITY)) ||
      left.display_name.localeCompare(right.display_name) ||
      left.catalog_entry_id.localeCompare(right.catalog_entry_id);
  }

  function mapCandidateRecommendationState(candidate) {
    const action = String(candidate?.recommended_action || "").trim().toLowerCase();
    if (action === "promote_next" || action === "promote_into_catalog") return "promote_next";
    return "available_bench";
  }

  function scoreCandidateEvidenceMatch(candidate, row) {
    if (candidate?.scoreboard_file && String(candidate.scoreboard_file).trim() === String(row?.file || "").trim()) {
      return 100;
    }
    const targetTokens = tokenizeStudioValues([
      candidate?.display_name,
      candidate?.model_id,
      candidate?.scoreboard_file,
      candidate?.catalog_family_id,
      candidate?.notes,
    ]);
    const rowTokens = new Set(tokenizeStudioValues([
      row?.model,
      row?.file,
      row?.engine,
    ]));
    let score = 0;
    for (const token of targetTokens) {
      if (rowTokens.has(token)) score += 1;
    }
    return score;
  }

  function buildCatalogCandidateSources(config, scoreboardRows, selectedPath) {
    const candidateModels = Array.isArray(config?.candidate_models) ? config.candidate_models : [];
    const soloSources = candidateModels
      .map((candidate) => {
        const ranked = scoreboardRows
          .map((row) => ({ row, score: scoreCandidateEvidenceMatch(candidate, row) }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score);
        const best = ranked[0] || null;
        if (!best) return null;
        const familyId = String(candidate?.catalog_family_id || catalogFamilyIdFromValues(candidate?.model_id, candidate?.display_name, candidate?.notes)).trim();
        if (!familyId) return null;
        const runtimeFamily = candidate?.preferred_runtime || best.row?.engine || "unknown";
        return {
          catalog_entry_id: catalogEntryIdForFamilies(familyId),
          family_id: familyId,
          mini_family_id: "",
          entry_type: "solo",
          publication_state: "candidate",
          recommendation_state: mapCandidateRecommendationState(candidate),
          activation_target_id: null,
          alias_ids: [],
          variant_id: catalogRuntimeVariantId(runtimeFamily),
          variant_display_name: String(candidate?.display_name || catalogFamilyDisplayName(familyId)),
          display_name: catalogEntryDisplayName(familyId),
          runtime_family: runtimeFamily,
          evidence_status: evidenceCompatibility(runtimeFamily, best.row?.engine),
          matched_score: best.score,
          matched_model: best.row?.model || null,
          matched_engine: best.row?.engine || null,
          matched_file: best.row?.file || null,
          spinup_seconds: best.row?.spinup_seconds ?? null,
          tokens_per_second: best.row?.tokens_per_second ?? null,
          quality_score: best.row?.quality_score ?? null,
          quality_label: best.row?.quality_label || "",
          quality_notes: best.row?.quality_notes || "",
          evidence_source_path: selectedPath || null,
          default_selected: false,
          recommended: false,
          currently_active: false,
          latest_for_preset: true,
          draft_count: 0,
          published_revision: null,
          preset_id: familyId,
        };
      })
      .filter(Boolean);
    const soloByFamily = new Map(soloSources.map((entry) => [entry.family_id, entry]));
    const comboSources = CANDIDATE_COMBO_SPECS
      .map((spec) => {
        const solo = soloByFamily.get(spec.family_id);
        if (!solo) return null;
        const familyId = spec.family_id;
        const miniFamilyId = spec.mini_family_id;
        return {
          ...solo,
          catalog_entry_id: catalogEntryIdForFamilies(familyId, miniFamilyId),
          mini_family_id: miniFamilyId,
          entry_type: "combo",
          recommendation_state: spec.recommendation_state,
          display_name: catalogEntryDisplayName(familyId, miniFamilyId),
        };
      })
      .filter(Boolean);
    return [...soloSources, ...comboSources];
  }

  function buildCatalogPublishedSources(config, publishedPresets, generatedTargetLookup = new Map()) {
    return publishedPresets
      .map((preset) => {
        const laneTargets = cleanLaneTargets(preset?.lane_targets);
        const largeProfile = laneTargets.large ? profileById(config, laneTargets.large) : null;
        const miniProfile = laneTargets.mini ? profileById(config, laneTargets.mini) : null;
        const familyId = catalogFamilyIdFromValues(
          largeProfile?.model_id,
          largeProfile?.display_name,
          largeProfile?.profile_id,
          preset?.display_name,
          preset?.preset_id,
        );
        if (!familyId) return null;
        const miniFamilyId = miniProfile
          ? catalogFamilyIdFromValues(miniProfile?.model_id, miniProfile?.display_name, miniProfile?.profile_id)
          : "";
        const generatedTargetId = generatedTargetLookup.get(catalogEntryIdForFamilies(familyId, miniFamilyId))
          || catalogGeneratedActivationTargetId(familyId, miniFamilyId);
        const activationTargetId = String(preset?.activation_set_id || "");
        return {
          catalog_entry_id: catalogEntryIdForFamilies(familyId, miniFamilyId),
          family_id: familyId,
          mini_family_id: miniFamilyId,
          entry_type: catalogEntryTypeForMiniFamily(miniFamilyId),
          publication_state: "current_published",
          recommendation_state: "current",
          activation_target_id: activationTargetId,
          alias_ids: LEGACY_CATALOG_ALIASES.has(activationTargetId) && activationTargetId !== generatedTargetId ? [activationTargetId] : [],
          variant_id: catalogRuntimeVariantId(preset?.evidence?.large_runtime_family || largeProfile?.runtime_family),
          variant_display_name: String(preset?.display_name || catalogEntryDisplayName(familyId, miniFamilyId)),
          display_name: catalogEntryDisplayName(familyId, miniFamilyId),
          runtime_family: preset?.evidence?.large_runtime_family || largeProfile?.runtime_family || null,
          evidence_status: preset?.evidence_status || "unknown",
          matched_score: preset?.evidence?.matched_score ?? null,
          matched_model: preset?.evidence?.matched_model || null,
          matched_engine: preset?.evidence?.matched_engine || null,
          matched_file: preset?.evidence?.matched_file || null,
          spinup_seconds: preset?.evidence?.spinup_seconds ?? null,
          tokens_per_second: preset?.evidence?.tokens_per_second ?? null,
          quality_score: preset?.evidence?.quality_score ?? null,
          quality_label: preset?.evidence?.quality_label || "",
          quality_notes: preset?.evidence?.quality_notes || "",
          evidence_source_path: preset?.evidence?.evidence_source_path || null,
          default_selected: Boolean(preset?.default_selected),
          recommended: Boolean(preset?.recommended),
          currently_active: Boolean(preset?.currently_active),
          latest_for_preset: Boolean(preset?.latest_for_preset),
          draft_count: preset?.draft_count || 0,
          published_revision: preset?.published_revision,
          preset_id: preset?.preset_id,
        };
      })
      .filter(Boolean);
  }

  function summarizeCatalogVariant(source, primaryPublishedTargetId) {
    return {
      variant_id: source.variant_id,
      display_name: source.variant_display_name,
      publication_state: source.publication_state,
      activatable: Boolean(source.activation_target_id),
      activation_target_id: source.activation_target_id || null,
      is_primary: false,
      is_primary_published_target: Boolean(source.activation_target_id) && source.activation_target_id === primaryPublishedTargetId,
      evidence_status: source.evidence_status,
      matched_model: source.matched_model,
      matched_file: source.matched_file,
      quality_score: source.quality_score,
      quality_label: source.quality_label,
      tokens_per_second: source.tokens_per_second,
      spinup_seconds: source.spinup_seconds,
    };
  }

  function explainCatalogRow(row) {
    if (row.catalog_shelf === "current" && row.primary_variant?.publication_state === "candidate") {
      return `Current family with a stronger ${row.primary_variant.variant_id.toUpperCase()} candidate variant not yet published.`;
    }
    if (row.catalog_shelf === "promote_next") {
      return `Bakeoff-proven candidate with ${row.quality_label || "scored"} evidence ready for promotion work.`;
    }
    if (row.catalog_shelf === "available_bench") {
      return "Bench candidate kept visible for future wiring or comparison.";
    }
    return `Current catalog entry ranked by ${row.evidence_status} bakeoff evidence.`;
  }

  function actionHintForCatalogRow(row) {
    if (!row.activatable && row.publication_state === "candidate") {
      return "Candidate only — wire and publish this family before activation.";
    }
    if (row.primary_variant?.publication_state === "candidate" && row.activation_target_id) {
      return `Primary variant is still a candidate. Published fallback remains available via ${row.activation_target_id}.`;
    }
    if (row.activation_target_id) {
      return `Apply via published target ${row.activation_target_id}.`;
    }
    return "No activation target available yet.";
  }

  function buildStudioCatalog({ config, publishedPresets, activeSetId, scoreboardRows, selectedPath, evidenceState }) {
    const generatedTargetLookup = new Map();
    const currentSources = buildCatalogPublishedSources(config, publishedPresets, generatedTargetLookup);
    const candidateSources = buildCatalogCandidateSources(config, scoreboardRows, selectedPath);
    const grouped = new Map();
    for (const source of [...currentSources, ...candidateSources]) {
      const existing = grouped.get(source.catalog_entry_id) || {
        catalog_entry_id: source.catalog_entry_id,
        family_id: source.family_id,
        mini_family_id: source.mini_family_id,
        entry_type: source.entry_type,
        display_name: source.display_name,
        aliases: new Set(),
        sources: [],
      };
      for (const alias of source.alias_ids || []) existing.aliases.add(alias);
      existing.sources.push(source);
      grouped.set(source.catalog_entry_id, existing);
    }

    const rows = [...grouped.values()].map((entry) => {
      const generatedTargetId = catalogGeneratedActivationTargetId(entry.family_id, entry.mini_family_id);
      const allSources = entry.sources.slice().sort(catalogVariantSort);
      const publishedSources = allSources.filter((source) => source.publication_state === "current_published");
      const currentSourcesOnly = publishedSources.length > 0;
      const primaryVariant = allSources[0] || null;
      const primaryPublished = publishedSources
        .slice()
        .sort((left, right) =>
          ((right.activation_target_id === generatedTargetId) ? 1 : 0) - ((left.activation_target_id === generatedTargetId) ? 1 : 0) ||
          catalogVariantSort(left, right))
        [0] || null;
      const recommendationState = currentSourcesOnly
        ? (allSources.some((source) => source.publication_state === "candidate" && source.recommendation_state === "promote_next") ? "promote_next" : "current")
        : (allSources.some((source) => source.recommendation_state === "promote_next") ? "promote_next" : "available_bench");
      const catalogShelf = currentSourcesOnly ? "current" : (recommendationState === "promote_next" ? "promote_next" : "available_bench");
      const primaryPublishedTargetId = primaryPublished?.activation_target_id || null;
      const variants = allSources.map((source) => summarizeCatalogVariant(source, primaryPublishedTargetId));
      if (variants.length > 0) variants[0].is_primary = true;
      const row = {
        catalog_entry_id: entry.catalog_entry_id,
        family_id: entry.family_id,
        display_name: entry.display_name,
        entry_type: entry.entry_type,
        mode: entry.entry_type,
        combo_signature: entry.mini_family_id || null,
        publication_state: currentSourcesOnly ? "current_published" : "candidate",
        recommendation_state: recommendationState,
        catalog_tier: currentSourcesOnly ? "tier1" : "tier2",
        catalog_shelf: catalogShelf,
        aliases: [...entry.aliases].sort(),
        activation_target_id: primaryPublishedTargetId,
        activation_target_ids: publishedSources.map((source) => source.activation_target_id).filter(Boolean),
        activatable: Boolean(primaryPublishedTargetId),
        currently_active: allSources.some((source) => source.activation_target_id && source.activation_target_id === activeSetId),
        default_selected: allSources.some((source) => source.default_selected),
        recommended: allSources.some((source) => source.recommended),
        evidence_status: primaryVariant?.evidence_status || "unknown",
        evidence_source_path: primaryVariant?.evidence_source_path || selectedPath || null,
        quality_score: primaryVariant?.quality_score ?? null,
        quality_label: primaryVariant?.quality_label || "",
        tokens_per_second: primaryVariant?.tokens_per_second ?? null,
        spinup_seconds: primaryVariant?.spinup_seconds ?? null,
        matched_model: primaryVariant?.matched_model || null,
        matched_file: primaryVariant?.matched_file || null,
        primary_variant: variants[0] || null,
        variants,
        published_variant_count: publishedSources.length,
        candidate_variant_count: allSources.length - publishedSources.length,
        primary_variant_published: Boolean(primaryVariant?.activation_target_id),
      };
      row.why_ranked_here = explainCatalogRow(row);
      row.operator_action_hint = actionHintForCatalogRow(row);
      return row;
    }).sort(catalogRowSort);

    const shelves = {
      current: {
        solos: rows.filter((row) => row.catalog_shelf === "current" && row.entry_type === "solo"),
        combos: rows.filter((row) => row.catalog_shelf === "current" && row.entry_type === "combo"),
      },
      promote_next: {
        solos: rows.filter((row) => row.catalog_shelf === "promote_next" && row.entry_type === "solo"),
        combos: rows.filter((row) => row.catalog_shelf === "promote_next" && row.entry_type === "combo"),
      },
      available_bench: {
        solos: rows.filter((row) => row.catalog_shelf === "available_bench" && row.entry_type === "solo"),
        combos: rows.filter((row) => row.catalog_shelf === "available_bench" && row.entry_type === "combo"),
      },
    };

    let nextRank = 1;
    for (const shelfKey of ["current", "promote_next", "available_bench"]) {
      for (const bucketKey of ["solos", "combos"]) {
        for (const row of shelves[shelfKey][bucketKey]) {
          row.catalog_rank = nextRank;
          row.shelf_rank = shelves[shelfKey][bucketKey].indexOf(row) + 1;
          nextRank += 1;
        }
      }
    }

    return {
      version: 1,
      ranking_contract_version: 1,
      normalization_version: 1,
      compatibility_policy_version: 1,
      generated_at: currentIso(),
      evidence_set_hash: evidenceState?.source_signature || "",
      ranking_input_hash: JSON.stringify([
        evidenceState?.source_signature || "",
        rows.map((row) => [row.catalog_entry_id, row.publication_state, row.evidence_status, row.activation_target_id || "", row.recommendation_state]),
      ]),
      rows,
      shelves,
      warnings: rows
        .filter((row) => row.publication_state === "candidate" || row.evidence_status === "mismatched")
        .map((row) => ({
          catalog_entry_id: row.catalog_entry_id,
          kind: row.publication_state === "candidate" ? "candidate" : "evidence_mismatch",
          message: row.publication_state === "candidate"
            ? "Candidate row is visible for planning but is not yet a published activation target."
            : "Row is informed by family-level bakeoff evidence that does not match the deployed runtime family.",
        })),
    };
  }

  function defaultStudioEvidenceState() {
    return {
      version: 1,
      generated_at: currentIso(),
      stale: false,
      source_signature: "",
      selected_path: null,
      sources: [],
      presets: [],
      recommendations: buildStudioRecommendations([], false),
    };
  }

  async function ensureStudioEvidence({ force = false } = {}) {
    const cached = await readJsonImpl(studioEvidencePath, null);
    const source = await loadStudioScoreboardSource();
    const signature = studioSourceSignature(source.sources);
    if (!source.selected_path) {
      if (cached && Array.isArray(cached?.presets)) {
        return {
          ...defaultStudioEvidenceState(),
          ...cached,
          stale: true,
          source_signature: signature,
          selected_path: null,
          sources: source.sources,
          presets: (cached.presets || []).map((entry) => ({
            ...entry,
            evidence_status: entry.matched_model ? "stale" : (entry.evidence_status || "unknown"),
          })),
          recommendations: buildStudioRecommendations([], true),
        };
      }
      return {
        ...defaultStudioEvidenceState(),
        stale: true,
        source_signature: signature,
        sources: source.sources,
        recommendations: buildStudioRecommendations([], true),
      };
    }
    if (!force && cached && cached.source_signature === signature && Array.isArray(cached?.presets)) {
      return cached;
    }
    const config = await loadValidatedConfig();
    const presets = buildStudioEvidenceEntries(config, source.rows, source.selected_path);
    const payload = {
      version: 1,
      generated_at: currentIso(),
      stale: false,
      source_signature: signature,
      selected_path: source.selected_path,
      sources: source.sources,
      presets,
      recommendations: buildStudioRecommendations(presets, false),
    };
    await writeJsonImpl(studioEvidencePath, payload);
    return payload;
  }

  function findStudioPublishedSet(config, { presetId = "", publishedRevision = null, activationSetId = "" } = {}) {
    const targetSetId = String(activationSetId || "").trim();
    if (targetSetId) {
      return allActivationSets(config).find((set) => String(set?.set_id || "") === targetSetId) || null;
    }
    const targetPresetId = String(presetId || "").trim();
    const targetRevision = parsePublishedRevision(publishedRevision, -1);
    return allActivationSets(config).find((set) =>
      studioPresetIdForSet(set) === targetPresetId &&
      studioRevisionForSet(set) === targetRevision) || null;
  }

  function resolveStudioDefaultSelection(entry, publishedPresets) {
    if (!entry?.preset_id) {
      return null;
    }
    const revision = parsePublishedRevision(entry?.published_revision, -1);
    const match = publishedPresets.find((preset) =>
      preset.preset_id === String(entry.preset_id || "").trim() &&
      preset.published_revision === revision);
    return {
      preset_id: String(entry.preset_id || "").trim(),
      published_revision: revision >= 0 ? revision : null,
      activation_set_id: match?.activation_set_id || null,
      valid: Boolean(match),
    };
  }

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
    const validatedTargets = validateActivationSetTargets(config, laneTargets);
    if (!validatedTargets.ok) {
      return validatedTargets.error;
    }
    const newSet = {
      set_id: sid,
      display_name: String(displayName || sid),
      description: String(description || ""),
      requires_dual_box: validatedTargets.requires_dual_box,
      lane_targets: validatedTargets.lane_targets,
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

  async function getStudioSummary() {
    const [current, models, activationSets, defaultsState, draftState, evidenceState, config, scoreboardSource] = await Promise.all([
      currentState(),
      modelsState(),
      getActivationSets(),
      loadStudioDefaults(),
      loadStudioDraftState(),
      ensureStudioEvidence(),
      loadValidatedConfig(),
      loadStudioScoreboardSource(),
    ]);
    const activeSetId = String(current?.desired_state?.active_set_id || "");
    const evidenceByKey = new Map((evidenceState.presets || []).map((entry) => [
      studioEvidenceKey(entry.preset_id, entry.published_revision),
      entry,
    ]));
    const publishedPresets = allActivationSets(config).map((set) => {
      const presetId = studioPresetIdForSet(set);
      const publishedRevision = studioRevisionForSet(set);
      const laneTargets = cleanLaneTargets(set?.lane_targets);
      return {
        preset_id: presetId,
        activation_set_id: String(set?.set_id || ""),
        published_revision: publishedRevision,
        display_name: String(set?.display_name || presetId),
        description: String(set?.description || ""),
        lane_targets: laneTargets,
        mode: studioModeForTargets(laneTargets),
        requires_dual_box: Boolean(set?.requires_dual_box),
        currently_active: String(set?.set_id || "") === activeSetId,
        is_legacy: !Object.prototype.hasOwnProperty.call(set || {}, "published_revision"),
        evidence_status: evidenceByKey.get(studioEvidenceKey(presetId, publishedRevision))?.evidence_status || "unknown",
        evidence: evidenceByKey.get(studioEvidenceKey(presetId, publishedRevision)) || null,
      };
    });
    const latestRevisionByPreset = new Map();
    for (const preset of publishedPresets) {
      const currentLatest = latestRevisionByPreset.get(preset.preset_id);
      if (currentLatest == null || preset.published_revision > currentLatest) {
        latestRevisionByPreset.set(preset.preset_id, preset.published_revision);
      }
    }
    const recommendationKeys = new Set([evidenceState.recommendations?.solo, evidenceState.recommendations?.combo]
      .filter(Boolean)
      .map((entry) => studioEvidenceKey(entry.preset_id, entry.published_revision)));
    const defaultKeys = new Set([defaultsState.solo, defaultsState.combo]
      .filter(Boolean)
      .map((entry) => studioEvidenceKey(entry.preset_id, entry.published_revision)));
    const draftCounts = new Map();
    for (const draft of draftState.drafts || []) {
      const presetId = String(draft?.preset_id || "").trim();
      if (!presetId) continue;
      draftCounts.set(presetId, (draftCounts.get(presetId) || 0) + 1);
    }
    const enrichedPublishedPresets = annotateStudioCatalogPresets(publishedPresets
      .map((preset) => ({
        ...preset,
        latest_for_preset: latestRevisionByPreset.get(preset.preset_id) === preset.published_revision,
        default_selected: defaultKeys.has(studioEvidenceKey(preset.preset_id, preset.published_revision)),
        recommended: recommendationKeys.has(studioEvidenceKey(preset.preset_id, preset.published_revision)),
        draft_count: draftCounts.get(preset.preset_id) || 0,
      })));
    const catalog = buildStudioCatalog({
      config,
      publishedPresets: enrichedPublishedPresets,
      activeSetId,
      scoreboardRows: scoreboardSource.rows || [],
      selectedPath: scoreboardSource.selected_path || null,
      evidenceState,
    });
    return {
      ok: true,
      generated_at: currentIso(),
      current,
      models,
      activation_sets: activationSets.activation_sets || activationSets.sets || [],
      studio: {
        published_presets: enrichedPublishedPresets,
        drafts: (draftState.drafts || [])
          .slice()
          .sort((left, right) => String(right?.updated_at || "").localeCompare(String(left?.updated_at || ""))),
        defaults: {
          updated_at: defaultsState.updated_at,
          solo: resolveStudioDefaultSelection(defaultsState.solo, enrichedPublishedPresets),
          combo: resolveStudioDefaultSelection(defaultsState.combo, enrichedPublishedPresets),
        },
        recommendations: evidenceState.recommendations,
        evidence_generated_at: evidenceState.generated_at,
        evidence_stale: Boolean(evidenceState.stale),
        evidence_sources: evidenceState.sources || [],
        catalog,
        action_log_tail: await readStudioActionLog(30),
      },
    };
  }

  async function saveStudioDraft({
    draftId = "",
    expectedDraftRevision = null,
    presetId = "",
    displayName = "",
    description = "",
    laneTargets = {},
    sourceActivationSetId = "",
    basePublishedRevision = null,
  } = {}) {
    const config = await loadValidatedConfig();
    const validatedTargets = validateActivationSetTargets(config, laneTargets);
    if (!validatedTargets.ok) {
      return validatedTargets.error;
    }
    const draftsState = await loadStudioDraftState();
    const targetDraftId = String(draftId || "").trim();
    const existingIndex = targetDraftId
      ? draftsState.drafts.findIndex((draft) => String(draft?.draft_id || "") === targetDraftId)
      : -1;
    const existing = existingIndex >= 0 ? draftsState.drafts[existingIndex] : null;
    if (existing && expectedDraftRevision !== null &&
      parsePublishedRevision(expectedDraftRevision, -1) !== parsePublishedRevision(existing?.draft_revision, -1)) {
      return {
        ...apiError(ErrorCode.REVISION_CONFLICT, `draft '${targetDraftId}' changed since revision ${expectedDraftRevision}`),
        accepted: false,
      };
    }
    const resolvedPresetId = sanitizeStudioId(
      presetId || existing?.preset_id || displayName || targetDraftId || "preset",
      "preset",
    );
    const resolvedDraftId = existing?.draft_id || targetDraftId || `draft_${sanitizeStudioId(uuid(), "draft").slice(0, 16)}`;
    const nextDraft = {
      draft_id: resolvedDraftId,
      draft_revision: existing ? parsePublishedRevision(existing?.draft_revision, 0) + 1 : 1,
      preset_id: resolvedPresetId,
      display_name: String(displayName || existing?.display_name || resolvedPresetId),
      description: String(description || existing?.description || ""),
      lane_targets: validatedTargets.lane_targets,
      mode: studioModeForTargets(validatedTargets.lane_targets),
      requires_dual_box: validatedTargets.requires_dual_box,
      source_activation_set_id: String(sourceActivationSetId || existing?.source_activation_set_id || "").trim() || null,
      base_published_revision: basePublishedRevision === null
        ? parsePublishedRevision(existing?.base_published_revision, 0)
        : parsePublishedRevision(basePublishedRevision, 0),
      last_published_revision: parsePublishedRevision(existing?.last_published_revision, 0) || null,
      last_published_at: String(existing?.last_published_at || "").trim() || null,
      created_at: existing?.created_at || currentIso(),
      updated_at: currentIso(),
    };
    const drafts = draftsState.drafts.slice();
    if (existingIndex >= 0) {
      drafts[existingIndex] = nextDraft;
    } else {
      drafts.push(nextDraft);
    }
    await saveStudioDraftState({ ...draftsState, drafts });
    await appendStudioActionLog({
      action: "draft-save",
      draft_id: resolvedDraftId,
      preset_id: resolvedPresetId,
      draft_revision: nextDraft.draft_revision,
    });
    return { ok: true, accepted: true, draft: nextDraft };
  }

  async function duplicateStudioDraft({ draftId = "", presetId = "", displayName = "" } = {}) {
    const draftsState = await loadStudioDraftState();
    const targetDraftId = String(draftId || "").trim();
    const existing = draftsState.drafts.find((draft) => String(draft?.draft_id || "") === targetDraftId);
    if (!existing) {
      return { ...apiError(ErrorCode.DRAFT_NOT_FOUND, `unknown draft '${targetDraftId}'`), accepted: false };
    }
    const nextDraft = {
      ...existing,
      draft_id: `draft_${sanitizeStudioId(uuid(), "draft").slice(0, 16)}`,
      draft_revision: 1,
      preset_id: sanitizeStudioId(presetId || existing.preset_id, existing.preset_id || "preset"),
      display_name: String(displayName || `${existing.display_name || existing.preset_id} Copy`),
      created_at: currentIso(),
      updated_at: currentIso(),
    };
    await saveStudioDraftState({
      ...draftsState,
      drafts: [...draftsState.drafts, nextDraft],
    });
    await appendStudioActionLog({
      action: "draft-duplicate",
      source_draft_id: targetDraftId,
      draft_id: nextDraft.draft_id,
      preset_id: nextDraft.preset_id,
    });
    return { ok: true, accepted: true, draft: nextDraft };
  }

  async function deleteStudioDraft({ draftId = "", expectedDraftRevision = null } = {}) {
    const targetDraftId = String(draftId || "").trim();
    if (!targetDraftId) {
      return { ...apiError(ErrorCode.INPUT_INVALID, "draft_id is required"), accepted: false };
    }
    const draftsState = await loadStudioDraftState();
    const existing = draftsState.drafts.find((draft) => String(draft?.draft_id || "") === targetDraftId);
    if (!existing) {
      return { ...apiError(ErrorCode.DRAFT_NOT_FOUND, `unknown draft '${targetDraftId}'`), accepted: false };
    }
    if (expectedDraftRevision !== null &&
      parsePublishedRevision(expectedDraftRevision, -1) !== parsePublishedRevision(existing?.draft_revision, -1)) {
      return {
        ...apiError(ErrorCode.REVISION_CONFLICT, `draft '${targetDraftId}' changed since revision ${expectedDraftRevision}`),
        accepted: false,
      };
    }
    const drafts = draftsState.drafts.filter((draft) => String(draft?.draft_id || "") !== targetDraftId);
    await saveStudioDraftState({ ...draftsState, drafts });
    await appendStudioActionLog({
      action: "draft-delete",
      draft_id: targetDraftId,
      preset_id: existing.preset_id,
    });
    return { ok: true, accepted: true, deleted: targetDraftId };
  }

  async function publishStudioDraft({ draftId = "", expectedDraftRevision = null, persist = true } = {}) {
    const targetDraftId = String(draftId || "").trim();
    if (!targetDraftId) {
      return { ...apiError(ErrorCode.INPUT_INVALID, "draft_id is required"), accepted: false };
    }
    const draftsState = await loadStudioDraftState();
    const existing = draftsState.drafts.find((draft) => String(draft?.draft_id || "") === targetDraftId);
    if (!existing) {
      return { ...apiError(ErrorCode.DRAFT_NOT_FOUND, `unknown draft '${targetDraftId}'`), accepted: false };
    }
    if (expectedDraftRevision !== null &&
      parsePublishedRevision(expectedDraftRevision, -1) !== parsePublishedRevision(existing?.draft_revision, -1)) {
      return {
        ...apiError(ErrorCode.REVISION_CONFLICT, `draft '${targetDraftId}' changed since revision ${expectedDraftRevision}`),
        accepted: false,
      };
    }
    const config = await loadValidatedConfig();
    const validatedTargets = validateActivationSetTargets(config, existing.lane_targets);
    if (!validatedTargets.ok) {
      return validatedTargets.error;
    }
    const presetId = sanitizeStudioId(existing.preset_id || existing.display_name || existing.draft_id, "preset");
    const nextRevision = allActivationSets(config)
      .filter((set) => studioPresetIdForSet(set) === presetId)
      .reduce((maxRevision, set) => Math.max(maxRevision, studioRevisionForSet(set)), 0) + 1;
    const activationSetId = formatPublishedStudioSetId(presetId, nextRevision);
    if (allActivationSets(config).some((set) => String(set?.set_id || "") === activationSetId)) {
      return {
        ...apiError(ErrorCode.INPUT_INVALID, `activation set '${activationSetId}' already exists`),
        accepted: false,
      };
    }
    const publishedSet = {
      set_id: activationSetId,
      studio_preset_id: presetId,
      published_revision: nextRevision,
      display_name: String(existing.display_name || presetId),
      description: String(existing.description || ""),
      requires_dual_box: validatedTargets.requires_dual_box,
      lane_targets: validatedTargets.lane_targets,
    };
    config.controller.activation_sets.push(publishedSet);
    if (persist) {
      await writeJsonImpl(configPath, config);
    }
    _validatedConfig = config;
    const drafts = draftsState.drafts.map((draft) =>
      String(draft?.draft_id || "") === targetDraftId
        ? {
          ...draft,
          last_published_revision: nextRevision,
          last_published_at: currentIso(),
          updated_at: currentIso(),
        }
        : draft);
    await saveStudioDraftState({ ...draftsState, drafts });
    await ensureStudioEvidence({ force: true });
    await appendStudioActionLog({
      action: "publish",
      draft_id: targetDraftId,
      preset_id: presetId,
      published_revision: nextRevision,
      activation_set_id: activationSetId,
      persist: Boolean(persist),
    });
    return {
      ok: true,
      accepted: true,
      preset_id: presetId,
      published_revision: nextRevision,
      activation_set_id: activationSetId,
      persisted: Boolean(persist),
    };
  }

  async function applyStudioPreset({
    presetId = "",
    publishedRevision = null,
    activationSetId = "",
    wait = false,
    allowPreempt = true,
    force = false,
    dryRun = false,
  } = {}) {
    const config = await loadValidatedConfig();
    const selected = findStudioPublishedSet(config, {
      presetId,
      publishedRevision,
      activationSetId,
    });
    if (!selected) {
      const detail = activationSetId
        ? `unknown studio activation set '${activationSetId}'`
        : `unknown studio preset '${presetId}' revision ${publishedRevision}`;
      return { ...apiError(ErrorCode.PRESET_NOT_FOUND, detail), accepted: false };
    }
    await appendStudioActionLog({
      action: "apply-request",
      preset_id: studioPresetIdForSet(selected),
      published_revision: studioRevisionForSet(selected),
      activation_set_id: String(selected?.set_id || ""),
      wait: Boolean(wait),
      dry_run: Boolean(dryRun),
    });
    const payload = await activateSet({
      setId: String(selected?.set_id || ""),
      wait,
      allowPreempt,
      force,
      dryRun,
    });
    return {
      ...payload,
      preset_id: studioPresetIdForSet(selected),
      published_revision: studioRevisionForSet(selected),
      activation_set_id: String(selected?.set_id || ""),
    };
  }

  async function setStudioDefault({ mode = "", presetId = "", publishedRevision = null, activationSetId = "" } = {}) {
    const targetMode = String(mode || "").trim().toLowerCase();
    if (!["solo", "combo"].includes(targetMode)) {
      return { ...apiError(ErrorCode.INPUT_INVALID, "mode must be 'solo' or 'combo'"), accepted: false };
    }
    const config = await loadValidatedConfig();
    const selected = findStudioPublishedSet(config, {
      presetId,
      publishedRevision,
      activationSetId,
    });
    if (!selected) {
      const detail = activationSetId
        ? `unknown studio activation set '${activationSetId}'`
        : `unknown studio preset '${presetId}' revision ${publishedRevision}`;
      return { ...apiError(ErrorCode.PRESET_NOT_FOUND, detail), accepted: false };
    }
    const selectedMode = studioModeForTargets(cleanLaneTargets(selected?.lane_targets));
    if (selectedMode !== targetMode) {
      return {
        ...apiError(
          ErrorCode.INPUT_INVALID,
          `preset '${studioPresetIdForSet(selected)}' revision ${studioRevisionForSet(selected)} is ${selectedMode}, not ${targetMode}`,
        ),
        accepted: false,
      };
    }
    const defaultsState = await loadStudioDefaults();
    const saved = await saveStudioDefaults({
      ...defaultsState,
      [targetMode]: {
        preset_id: studioPresetIdForSet(selected),
        published_revision: studioRevisionForSet(selected),
      },
    });
    await appendStudioActionLog({
      action: "default-set",
      mode: targetMode,
      preset_id: studioPresetIdForSet(selected),
      published_revision: studioRevisionForSet(selected),
      activation_set_id: String(selected?.set_id || ""),
    });
    return {
      ok: true,
      accepted: true,
      mode: targetMode,
      preset_id: studioPresetIdForSet(selected),
      published_revision: studioRevisionForSet(selected),
      updated_at: saved.updated_at,
    };
  }

  async function refreshStudioEvidence() {
    const evidence = await ensureStudioEvidence({ force: true });
    await appendStudioActionLog({
      action: "evidence-refresh",
      stale: Boolean(evidence.stale),
      selected_path: evidence.selected_path || null,
      preset_count: Array.isArray(evidence.presets) ? evidence.presets.length : 0,
    });
    return { ok: true, ...evidence };
  }

  async function getStudioActionLog(limit = 30) {
    return {
      ok: true,
      entries: await readStudioActionLog(limit),
    };
  }

  async function bonzai() {
    const config = await loadValidatedConfig();
    // Route through activateSet so active_set_id is written to desired_state.
    const bonzaiSetId = config.controller?.bonzai_set_id;
    if (bonzaiSetId) {
      const result = await activateSet({ setId: bonzaiSetId, wait: true, allowPreempt: true });
      await fireWebhook("bonzai", { result_status: result?.status || "unknown" });
      return result;
    }
    // Fallback if bonzai_set_id is not configured (preserves old behaviour).
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
    const swapAdmissionState = await loadSwapManifest();
    const blockedDetails = buildSwapAdmissionDetails(swapAdmissionState);
    if (Array.isArray(blockedDetails.blocked_actions) && blockedDetails.blocked_actions.some((entry) => entry.action === "fleet_up")) {
      await appendAuditLog({
        action: "fleet-up",
        ok: false,
        code: ErrorCode.RECONCILE_REQUIRED,
        swap_id: blockedDetails.swap_id,
        controller_revision: blockedDetails.controller_revision,
        active_set_id: blockedDetails.active_set_id,
        reason: "swap_reconcile_needed",
      });
      return {
        ...apiError(
          ErrorCode.RECONCILE_REQUIRED,
          "controller requires reconcile before bringing the fleet up",
        ),
        accepted: false,
        ...blockedDetails,
      };
    }
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
    getStudioSummary,
    saveStudioDraft,
    duplicateStudioDraft,
    deleteStudioDraft,
    publishStudioDraft,
    applyStudioPreset,
    setStudioDefault,
    refreshStudioEvidence,
    getStudioActionLog,
    restartLane,
    stopLane,
    bonzai,
    fleetUp,
    fleetDown,
    deepHealth,
    metricsText,
    startupChecks,
    getJob(jobId) {
      const job = getJobPayload(jobId);
      if (!job) return { ...apiError(ErrorCode.JOB_NOT_FOUND, "job not found"), ok: false };
      return { ok: true, ...job };
    },
    writeInventorySnapshot,
  };
}
