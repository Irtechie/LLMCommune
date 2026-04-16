// @ts-check
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultDesiredState,
  planWatchdogActions,
} from "./watchdog_logic.js";
import { logger } from "./logger.js";

function createFetchJson(fetchImpl = fetch) {
  return async function fetchJson(url, timeoutMs = 3000) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      const bodyText = await response.text();
      let body = null;
      if (bodyText.trim()) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = { raw: bodyText };
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        body,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: null,
        error: String(error?.message || error || "fetch failed"),
      };
    }
  };
}

function createPostJson(fetchImpl = fetch) {
  return async function postJson(url, payload, timeoutMs = 30000) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bodyText = await response.text();
      let body = null;
      if (bodyText.trim()) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = { raw: bodyText };
        }
      }
      return {
        ok: response.ok,
        status: response.status,
        body,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: null,
        error: String(error?.message || error || "post failed"),
      };
    }
  };
}

export function createWatchdog({
  repoRoot = "/home/admin/apps/LLMCommune",
  controllerPort = Number(process.env.PORT || 4000),
  pollMs = Number(process.env.WATCHDOG_POLL_MS || 5000),
  actionCooldownMs = Number(process.env.WATCHDOG_ACTION_COOLDOWN_MS || 30000),
  dependencies = {},
} = {}) {
  const runtimeRoot = path.join(repoRoot, "workspace", "runtime");
  const desiredStatePath = path.join(runtimeRoot, "desired_state.json");
  const watchdogPidPath = path.join(runtimeRoot, "watchdog-4000.pid");
  const watchdogLogPath = path.join(runtimeRoot, "watchdog-4000.log");
  const readJsonImpl = dependencies.readJson || (async (filePath, fallback) => {
    try {
      return JSON.parse(await readFile(filePath, "utf-8"));
    } catch {
      return fallback;
    }
  });
  const mkdirImpl = dependencies.mkdir || mkdir;
  const writeFileImpl = dependencies.writeFile || writeFile;
  const rmImpl = dependencies.rm || rm;
  const fetchJsonImpl = dependencies.fetchJson || createFetchJson(dependencies.fetchImpl || fetch);
  const postJsonImpl = dependencies.postJson || createPostJson(dependencies.fetchImpl || fetch);
  const controllerHealthyImpl = dependencies.controllerHealthy;
  const nowMs = dependencies.nowMs || (() => Date.now());
  const processRef = dependencies.processRef || process;
  const setIntervalImpl = dependencies.setInterval || setInterval;
  const clearIntervalImpl = dependencies.clearInterval || clearInterval;

  let stopping = false;
  let intervalHandle = null;
  const actionCooldowns = new Map(); // key -> { lastTs, failCount }
  const MAX_FAIL_COUNT = 8; // after this many failures, circuit opens and lane is left DARK

  function isoNow() {
    return new Date(nowMs()).toISOString();
  }

  async function ensureRuntimeRoot() {
    await mkdirImpl(runtimeRoot, { recursive: true });
  }

  async function appendWatchdogLog(message) {
    await ensureRuntimeRoot();
    const line = JSON.stringify({ ts: isoNow(), msg: message }) + "\n";
    await writeFileImpl(watchdogLogPath, line, { encoding: "utf-8", flag: "a" });
    logger.info(message, { watchdog: true });
  }

  /** Exponential backoff per key: base * 2^failCount, capped at 5 minutes. */
  function backoffMs(failCount) {
    return Math.min(actionCooldownMs * Math.pow(2, failCount), 300000);
  }

  function cooldownReady(key) {
    const entry = actionCooldowns.get(key);
    if (!entry) return true;
    return nowMs() - entry.lastTs >= backoffMs(entry.failCount);
  }

  async function writePid(filePath, pid) {
    await ensureRuntimeRoot();
    await writeFileImpl(filePath, `${pid}\n`, "utf-8");
  }

  async function clearPid(filePath) {
    await rmImpl(filePath, { force: true });
  }

  async function pidAlive(filePath) {
    try {
      const raw = (await readFile(filePath, "utf-8")).trim();
      const pid = Number(raw);
      if (!pid) return false;
      processRef.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function controllerHealthy() {
    if (controllerHealthyImpl) {
      return controllerHealthyImpl(controllerPort);
    }
    try {
      const response = await fetchJsonImpl(`http://127.0.0.1:${controllerPort}/health`, 1500);
      return Boolean(response.ok);
    } catch {
      return false;
    }
  }

  async function ensureController() {
    if (await controllerHealthy()) return true;
    await appendWatchdogLog("controller unhealthy; leaving restart ownership to systemd and skipping reconcile this poll");
    return false;
  }

  function cooldownReady(key) {
    const entry = actionCooldowns.get(key);
    if (!entry) return true;
    return nowMs() - entry.lastTs >= backoffMs(entry.failCount);
  }

  function markCooldownResult(key, success) {
    const prev = actionCooldowns.get(key) || { lastTs: 0, failCount: 0 };
    actionCooldowns.set(key, {
      lastTs: nowMs(),
      failCount: success ? 0 : prev.failCount + 1,
    });
  }

  async function triggerAction(action) {
    const circuitEntry = actionCooldowns.get(action.key);
    if (circuitEntry && circuitEntry.failCount >= MAX_FAIL_COUNT) {
      if (circuitEntry.failCount === MAX_FAIL_COUNT) {
        await appendWatchdogLog(`circuit open: ${action.key} failed ${MAX_FAIL_COUNT} times — lane left DARK, manual intervention required`);
        // Bump failCount past threshold so we only log once
        actionCooldowns.set(action.key, { ...circuitEntry, failCount: MAX_FAIL_COUNT + 1 });
      }
      return false;
    }
    if (!cooldownReady(action.key)) return false;
    await appendWatchdogLog(`triggering ${action.label}`);
    const result = await postJsonImpl(`http://127.0.0.1:${controllerPort}${action.pathName}`, action.payload, 30000);
    if (!result.ok) {
      await appendWatchdogLog(`action failed ${action.label}: ${result.error || JSON.stringify(result.body || {})}`);
      markCooldownResult(action.key, false);
      return false;
    }
    await appendWatchdogLog(`action accepted ${action.label}: status=${result.status}`);
    markCooldownResult(action.key, true);
    return true;
  }

  async function loadDesiredState() {
    const desired = await readJsonImpl(desiredStatePath, defaultDesiredState(isoNow()));
    return {
      ...defaultDesiredState(isoNow()),
      ...desired,
      lane_targets: {
        ...defaultDesiredState(isoNow()).lane_targets,
        ...(desired?.lane_targets || {}),
      },
    };
  }

  async function reconcileDesiredState() {
    const desired = await loadDesiredState();
    if (!(await ensureController())) return [];
    const current = await fetchJsonImpl(`http://127.0.0.1:${controllerPort}/api/llm-host/current`, 4000);
    if (!current.ok || !current.body) {
      await appendWatchdogLog(`cannot read current state: ${current.error || current.status}`);
      return [];
    }

    const actions = planWatchdogActions({
      desiredState: desired,
      currentState: current.body,
    });
    for (const action of actions) {
      await triggerAction(action);
    }
    return actions;
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    if (intervalHandle) {
      clearIntervalImpl(intervalHandle);
      intervalHandle = null;
    }
    await appendWatchdogLog("watchdog stopping");
    await clearPid(watchdogPidPath);
  }

  async function start() {
    await ensureRuntimeRoot();
    if (await pidAlive(watchdogPidPath)) {
      console.error("watchdog already running");
      processRef.exit(1);
      return;
    }
    await writePid(watchdogPidPath, processRef.pid);
    await appendWatchdogLog(`watchdog started pid=${processRef.pid}`);

    const cleanup = async () => {
      await stop();
      processRef.exit(0);
    };

    processRef.on("SIGINT", cleanup);
    processRef.on("SIGTERM", cleanup);

    await ensureController();
    await reconcileDesiredState();

    intervalHandle = setIntervalImpl(() => {
      ensureController()
        .then((healthy) => {
          if (!healthy) return [];
          return reconcileDesiredState();
        })
        .catch((error) => {
          appendWatchdogLog(`watchdog poll error: ${String(error?.message || error)}`).catch(() => {});
        });
    }, pollMs);
  }

  return {
    controllerPort,
    desiredStatePath,
    watchdogPidPath,
    watchdogLogPath,
    loadDesiredState,
    controllerHealthy,
    ensureController,
    reconcileDesiredState,
    start,
    stop,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  createWatchdog().start().catch(async (error) => {
    try {
      const watchdog = createWatchdog();
      await watchdog.stop();
    } catch {
      // Best-effort cleanup only.
    }
    process.exitCode = 1;
    console.error("[llmcommune-watchdog] fatal error", error?.stack || error);
  });
}
