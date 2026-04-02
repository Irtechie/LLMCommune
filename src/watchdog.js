import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = "/home/admin/apps/LLMCommune";
const runtimeRoot = path.join(repoRoot, "workspace", "runtime");
const desiredStatePath = path.join(runtimeRoot, "desired_state.json");
const watchdogPidPath = path.join(runtimeRoot, "watchdog-4000.pid");
const watchdogLogPath = path.join(runtimeRoot, "watchdog-4000.log");

const controllerPort = Number(process.env.PORT || 4000);
const pollMs = Number(process.env.WATCHDOG_POLL_MS || 5000);
const actionCooldownMs = Number(process.env.WATCHDOG_ACTION_COOLDOWN_MS || 30000);
let stopping = false;
const actionCooldowns = new Map();

function isoNow() {
  return new Date().toISOString();
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
    updated_at: isoNow(),
  };
}

async function ensureRuntimeRoot() {
  await mkdir(runtimeRoot, { recursive: true });
}

async function appendWatchdogLog(message) {
  await ensureRuntimeRoot();
  await writeFile(watchdogLogPath, `[${isoNow()}] ${message}\n`, { encoding: "utf-8", flag: "a" });
}

async function writePid(filePath, pid) {
  await ensureRuntimeRoot();
  await writeFile(filePath, `${pid}\n`, "utf-8");
}

async function clearPid(filePath) {
  await rm(filePath, { force: true });
}

async function pidAlive(filePath) {
  try {
    const raw = (await readFile(filePath, "utf-8")).trim();
    const pid = Number(raw);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

async function fetchJson(url, timeoutMs = 3000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
}

async function postJson(url, payload, timeoutMs = 30000) {
  try {
    const response = await fetch(url, {
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
}

async function controllerHealthy() {
  try {
    const response = await fetch(`http://127.0.0.1:${controllerPort}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
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
  const lastTs = Number(actionCooldowns.get(key) || 0);
  return Date.now() - lastTs >= actionCooldownMs;
}

function markCooldown(key) {
  actionCooldowns.set(key, Date.now());
}

async function triggerAction(key, label, pathName, payload) {
  if (!cooldownReady(key)) return;
  markCooldown(key);
  await appendWatchdogLog(`triggering ${label}`);
  const result = await postJson(`http://127.0.0.1:${controllerPort}${pathName}`, payload, 30000);
  if (!result.ok) {
    await appendWatchdogLog(`action failed ${label}: ${result.error || JSON.stringify(result.body || {})}`);
    return;
  }
  await appendWatchdogLog(`action accepted ${label}: status=${result.status}`);
}

async function loadDesiredState() {
  const desired = await readJson(desiredStatePath, defaultDesiredState());
  return {
    ...defaultDesiredState(),
    ...desired,
    lane_targets: {
      ...defaultDesiredState().lane_targets,
      ...(desired?.lane_targets || {}),
    },
  };
}

async function reconcileDesiredState() {
  const desired = await loadDesiredState();
  if (!desired.watchdog_enforce) return;
  if (!["ready", "running"].includes(String(desired.state || "").toLowerCase())) return;

  if (!(await ensureController())) return;
  const current = await fetchJson(`http://127.0.0.1:${controllerPort}/api/llm-host/current`, 4000);
  if (!current.ok || !current.body) {
    await appendWatchdogLog(`cannot read current state: ${current.error || current.status}`);
    return;
  }

  if (desired.mode === "fleet" && desired.fleet_id) {
    if (!current.body?.mini_fleet?.up) {
      await triggerAction(
        `fleet:${desired.fleet_id}`,
        `fleet ${desired.fleet_id}`,
        "/fleet/up",
        {},
      );
    }
    return;
  }

  const largeTarget = String(desired?.lane_targets?.large || "").trim();
  const miniTarget = String(desired?.lane_targets?.mini || "").trim();
  const largeCurrent = current.body?.lanes?.large || {};
  const miniCurrent = current.body?.lanes?.mini || {};

  if (largeTarget && (!largeCurrent.up || String(largeCurrent.profile_id || "") !== largeTarget)) {
    await triggerAction(
      `lane:large:${largeTarget}`,
      `restore large lane ${largeTarget}`,
      "/api/llm-host/activate",
      {
        profile_id: largeTarget,
        lane_id: "large",
        wait: false,
        allow_preempt: true,
      },
    );
  }

  if (miniTarget && (!miniCurrent.up || String(miniCurrent.profile_id || "") !== miniTarget)) {
    await triggerAction(
      `lane:mini:${miniTarget}`,
      `restore mini lane ${miniTarget}`,
      "/api/llm-host/activate",
      {
        profile_id: miniTarget,
        lane_id: "mini",
        wait: false,
        allow_preempt: true,
      },
    );
  }
}

async function main() {
  await ensureRuntimeRoot();
  if (await pidAlive(watchdogPidPath)) {
    console.error("watchdog already running");
    process.exit(1);
  }
  await writePid(watchdogPidPath, process.pid);
  await appendWatchdogLog(`watchdog started pid=${process.pid}`);
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    await appendWatchdogLog("watchdog stopping");
    await clearPid(watchdogPidPath);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await ensureController();
  await reconcileDesiredState();

  setInterval(() => {
    ensureController()
      .then((healthy) => {
        if (!healthy) return;
        return reconcileDesiredState();
      })
      .catch((error) => {
        appendWatchdogLog(`watchdog poll error: ${String(error?.message || error)}`).catch(() => {});
      });
  }, pollMs);
}

main().catch(async (error) => {
  await appendWatchdogLog(`fatal error: ${String(error?.message || error)}`);
  await clearPid(watchdogPidPath);
  process.exit(1);
});
