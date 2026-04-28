// @ts-check
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./runtime.js";
import { logger } from "./logger.js";
import { ErrorCode } from "./errors.js";

// ── Config from environment ───────────────────────────────────────────────
const CORS_ORIGIN = process.env.LLMCOMMUNE_CORS_ORIGIN || "*";
const API_KEY = process.env.LLMCOMMUNE_API_KEY || "";
const RATE_LIMIT = Number(process.env.LLMCOMMUNE_RATE_LIMIT || 60);
const CONTROL_ROOM_ROUTE = "/control-room";

// ── Rate limiter (token bucket, per IP) ──────────────────────────────────
const rateBuckets = new Map(); // ip -> { count, resetAt }
/** @param {string} ip @returns {boolean} true if allowed */
function checkRateLimit(ip) {
  if (!RATE_LIMIT) return true;
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT) return false;
  return true;
}
// Prune stale rate-limit entries every 5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  }
}, 300000).unref?.();

// ── Helpers ───────────────────────────────────────────────────────────────
/** @param {http.ServerResponse} res @param {number} statusCode @param {unknown} payload @param {string} [requestId] */
export function sendJson(res, statusCode, payload, requestId) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Request-Id": requestId || "",
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

/** @param {http.ServerResponse} res @param {string} [requestId] */
export function notFound(res, requestId) {
  sendJson(res, 404, { ok: false, code: "NOT_FOUND", detail: "not found" }, requestId);
}

/** Read the request body with a timeout. */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("request body read timeout"), { code: ErrorCode.BODY_TIMEOUT }));
      req.destroy();
    }, 10000);

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        clearTimeout(timer);
        reject(Object.assign(new Error("request body too large"), { code: ErrorCode.BODY_TOO_LARGE }));
        req.destroy();
      }
    });
    req.on("end", () => {
      clearTimeout(timer);
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(error, { code: ErrorCode.BODY_PARSE_ERROR }));
      }
    });
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** @param {http.ServerResponse} res @param {string} fileName @param {string} requestId */
async function serveHtml(res, fileName, requestId) {
  const htmlPath = new URL(`../public/${fileName}`, import.meta.url);
  try {
    const html = await readFile(fileURLToPath(htmlPath), "utf-8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    });
    res.end(html);
  } catch (error) {
    logger.error("static html missing", { fileName, error: String(error?.message || error) });
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Request-Id": requestId });
    res.end("Dashboard not found");
  }
}

/** MUTATING endpoint IPs for rate limiting. */
const MUTATING_PATHS = new Set([
  "/api/llm-host/activate",
  "/api/llm-host/activate-set",
  "/api/llm-host/activate-set/register",
  "/api/llm-host/studio/drafts/save",
  "/api/llm-host/studio/drafts/duplicate",
  "/api/llm-host/studio/drafts/delete",
  "/api/llm-host/studio/drafts/publish",
  "/api/llm-host/studio/apply",
  "/api/llm-host/studio/defaults/set",
  "/api/llm-host/studio/recommendations/refresh",
  "/api/llm-host/actions/restart",
  "/api/llm-host/actions/stop",
  "/bonzai",
  "/fleet/up",
  "/fleet/down",
  "/api/llm-host/fleet/up",
  "/api/llm-host/fleet/down",
]);

export function createApp({
  runtime,
  defaultHost = "127.0.0.1:4000",
  rootDashboardFile = "",
} = {}) {
  return async function handleRequest(req, res) {
    const requestId = randomUUID();
    const startMs = Date.now();
    const ip = String(req.socket?.remoteAddress || "unknown");

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": CORS_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Max-Age": "86400",
        "X-Request-Id": requestId,
      });
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || defaultHost}`);

      if (req.method === "GET" && url.pathname === "/health") {
        const health = await runtime.deepHealth();
        sendJson(res, health.ok ? 200 : 503, { service: "LLMCommune", ...health }, requestId);
        logger.info("request", { rid: requestId, method: "GET", path: "/health", status: health.ok ? 200 : 503, ms: Date.now() - startMs });
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        const body = runtime.metricsText();
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "X-Request-Id": requestId });
        res.end(body);
        logger.info("request", { rid: requestId, method: "GET", path: "/metrics", status: 200, ms: Date.now() - startMs });
        return;
      }

      const staticRootRequested = req.method === "GET" && url.pathname === "/" && rootDashboardFile;
      const classicDashboardRequested = req.method === "GET" && url.pathname === "/dashboard";
      const controlRoomRequested = req.method === "GET" && url.pathname === CONTROL_ROOM_ROUTE;

      if (staticRootRequested) {
        await serveHtml(res, rootDashboardFile, requestId);
        return;
      }
      if (classicDashboardRequested) {
        await serveHtml(res, "dashboard.html", requestId);
        return;
      }
      if (controlRoomRequested) {
        await serveHtml(res, "control-room.html", requestId);
        return;
      }

      if (API_KEY) {
        const auth = String(req.headers["authorization"] || "");
        if (auth !== `Bearer ${API_KEY}`) {
          sendJson(res, 401, { ok: false, code: ErrorCode.UNAUTHORIZED, detail: "invalid or missing Authorization header" }, requestId);
          logger.warn("request", { rid: requestId, method: req.method, path: url.pathname, status: 401, ip, ms: Date.now() - startMs });
          return;
        }
      }

      if (MUTATING_PATHS.has(url.pathname) && !checkRateLimit(ip)) {
        sendJson(res, 429, { ok: false, code: ErrorCode.RATE_LIMITED, detail: "too many requests" }, requestId);
        logger.warn("request", { rid: requestId, method: req.method, path: url.pathname, status: 429, ip, ms: Date.now() - startMs });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/llm-host/help") {
        sendJson(res, 200, await runtime.getHelp(), requestId);
      } else if (req.method === "GET" && url.pathname === "/api/llm-host/current") {
        sendJson(res, 200, await runtime.getCurrent(), requestId);
      } else if (req.method === "GET" && url.pathname === "/api/llm-host/models") {
        sendJson(res, 200, await runtime.listModels(), requestId);
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/activate") {
        const body = await readJsonBody(req);
        const profileId = String(body.profile_id || body.profileId || "").trim();
        const laneId = String(body.lane_id || body.laneId || "").trim();
        if (!profileId) {
          sendJson(res, 400, { ok: false, accepted: false, code: ErrorCode.INPUT_INVALID, detail: "profile_id is required" }, requestId);
        } else {
          const payload = await runtime.activate({
            profileId,
            laneId,
            wait: Boolean(body.wait),
            allowPreempt: Object.prototype.hasOwnProperty.call(body, "allow_preempt")
              ? Boolean(body.allow_preempt)
              : Object.prototype.hasOwnProperty.call(body, "allowPreempt")
                ? Boolean(body.allowPreempt)
                : true,
            dryRun: Boolean(body.dry_run || body.dryRun),
            override: Boolean(body.override),
          });
          sendJson(res, payload.accepted ? 202 : 400, payload, requestId);
        }
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/activate-set") {
        const body = await readJsonBody(req);
        const setId = String(body.set_id || body.setId || "").trim();
        if (!setId) {
          sendJson(res, 400, { ok: false, accepted: false, code: ErrorCode.INPUT_INVALID, detail: "set_id is required" }, requestId);
        } else {
          const payload = await runtime.activateSet({
            setId,
            wait: Boolean(body.wait),
            force: Boolean(body.force),
            allowPreempt: Object.prototype.hasOwnProperty.call(body, "allow_preempt")
              ? Boolean(body.allow_preempt)
              : Object.prototype.hasOwnProperty.call(body, "allowPreempt")
                ? Boolean(body.allowPreempt)
                : true,
            dryRun: Boolean(body.dry_run || body.dryRun),
          });
          sendJson(res, payload.accepted ? 202 : 400, payload, requestId);
        }
      } else if (req.method === "GET" && url.pathname === "/api/llm-host/activation-sets") {
        sendJson(res, 200, await runtime.getActivationSets(), requestId);
      } else if (req.method === "GET" && url.pathname === "/api/llm-host/studio/summary") {
        sendJson(res, 200, await runtime.getStudioSummary(), requestId);
      } else if (req.method === "GET" && url.pathname === "/api/llm-host/studio/action-log") {
        const limit = Number(url.searchParams.get("limit") || 30);
        sendJson(res, 200, await runtime.getStudioActionLog(Number.isFinite(limit) ? limit : 30), requestId);
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/activate-set/register") {
        const body = await readJsonBody(req);
        const setId = String(body.set_id || body.setId || "").trim();
        if (!setId) {
          sendJson(res, 400, { ok: false, accepted: false, code: "INPUT_INVALID", detail: "set_id is required" }, requestId);
        } else {
          const payload = await runtime.registerActivationSet({
            setId,
            displayName: String(body.display_name || body.displayName || "").trim(),
            description: String(body.description || "").trim(),
            laneTargets: body.lane_targets || body.laneTargets || {},
            persist: Boolean(body.persist),
          });
          sendJson(res, payload.ok ? 201 : 400, payload, requestId);
        }
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/studio/drafts/save") {
        const body = await readJsonBody(req);
        const payload = await runtime.saveStudioDraft({
          draftId: String(body.draft_id || body.draftId || "").trim(),
          expectedDraftRevision: Object.prototype.hasOwnProperty.call(body, "expected_draft_revision")
            ? body.expected_draft_revision
            : body.expectedDraftRevision ?? body.draft_revision ?? body.draftRevision ?? null,
          presetId: String(body.preset_id || body.presetId || "").trim(),
          displayName: String(body.display_name || body.displayName || "").trim(),
          description: String(body.description || "").trim(),
          laneTargets: body.lane_targets || body.laneTargets || {},
          sourceActivationSetId: String(body.source_activation_set_id || body.sourceActivationSetId || "").trim(),
          basePublishedRevision: body.base_published_revision ?? body.basePublishedRevision ?? null,
        });
        const status = payload.ok
          ? 200
          : payload.code === ErrorCode.REVISION_CONFLICT
            ? 409
            : 400;
        sendJson(res, status, payload, requestId);
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/studio/drafts/duplicate") {
        const body = await readJsonBody(req);
        const draftId = String(body.draft_id || body.draftId || "").trim();
        if (!draftId) {
          sendJson(res, 400, { ok: false, accepted: false, code: ErrorCode.INPUT_INVALID, detail: "draft_id is required" }, requestId);
        } else {
          const payload = await runtime.duplicateStudioDraft({
            draftId,
            presetId: String(body.preset_id || body.presetId || "").trim(),
            displayName: String(body.display_name || body.displayName || "").trim(),
          });
          sendJson(res, payload.ok ? 200 : (payload.code === ErrorCode.DRAFT_NOT_FOUND ? 404 : 400), payload, requestId);
        }
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/studio/drafts/delete") {
        const body = await readJsonBody(req);
        const draftId = String(body.draft_id || body.draftId || "").trim();
        if (!draftId) {
          sendJson(res, 400, { ok: false, accepted: false, code: ErrorCode.INPUT_INVALID, detail: "draft_id is required" }, requestId);
        } else {
          const payload = await runtime.deleteStudioDraft({
            draftId,
            expectedDraftRevision: Object.prototype.hasOwnProperty.call(body, "expected_draft_revision")
              ? body.expected_draft_revision
              : body.expectedDraftRevision ?? body.draft_revision ?? body.draftRevision ?? null,
          });
          const status = payload.ok
            ? 200
            : payload.code === ErrorCode.DRAFT_NOT_FOUND
              ? 404
              : payload.code === ErrorCode.REVISION_CONFLICT
                ? 409
                : 400;
          sendJson(res, status, payload, requestId);
        }
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/studio/drafts/publish") {
        const body = await readJsonBody(req);
        const draftId = String(body.draft_id || body.draftId || "").trim();
        if (!draftId) {
          sendJson(res, 400, { ok: false, accepted: false, code: ErrorCode.INPUT_INVALID, detail: "draft_id is required" }, requestId);
        } else {
          const payload = await runtime.publishStudioDraft({
            draftId,
            expectedDraftRevision: Object.prototype.hasOwnProperty.call(body, "expected_draft_revision")
              ? body.expected_draft_revision
              : body.expectedDraftRevision ?? body.draft_revision ?? body.draftRevision ?? null,
            persist: Object.prototype.hasOwnProperty.call(body, "persist") ? Boolean(body.persist) : true,
          });
          const status = payload.ok
            ? 201
            : payload.code === ErrorCode.DRAFT_NOT_FOUND
              ? 404
              : payload.code === ErrorCode.REVISION_CONFLICT
                ? 409
                : 400;
          sendJson(res, status, payload, requestId);
        }
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/studio/apply") {
        const body = await readJsonBody(req);
        const payload = await runtime.applyStudioPreset({
          presetId: String(body.preset_id || body.presetId || "").trim(),
          publishedRevision: body.published_revision ?? body.publishedRevision ?? null,
          activationSetId: String(body.activation_set_id || body.activationSetId || "").trim(),
          wait: Boolean(body.wait),
          allowPreempt: Object.prototype.hasOwnProperty.call(body, "allow_preempt")
            ? Boolean(body.allow_preempt)
            : Object.prototype.hasOwnProperty.call(body, "allowPreempt")
              ? Boolean(body.allowPreempt)
              : true,
          force: Boolean(body.force),
          dryRun: Boolean(body.dry_run || body.dryRun),
        });
        const status = payload.accepted
          ? 202
          : payload.code === ErrorCode.PRESET_NOT_FOUND
            ? 404
            : 400;
        sendJson(res, status, payload, requestId);
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/studio/defaults/set") {
        const body = await readJsonBody(req);
        const payload = await runtime.setStudioDefault({
          mode: String(body.mode || "").trim(),
          presetId: String(body.preset_id || body.presetId || "").trim(),
          publishedRevision: body.published_revision ?? body.publishedRevision ?? null,
          activationSetId: String(body.activation_set_id || body.activationSetId || "").trim(),
        });
        sendJson(res, payload.ok ? 200 : (payload.code === ErrorCode.PRESET_NOT_FOUND ? 404 : 400), payload, requestId);
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/studio/recommendations/refresh") {
        const payload = await runtime.refreshStudioEvidence();
        sendJson(res, payload.ok ? 200 : 400, payload, requestId);
      } else if (req.method === "DELETE" && url.pathname.startsWith("/api/llm-host/activation-sets/")) {
        const setId = decodeURIComponent(url.pathname.split("/").pop() || "");
        if (!setId) {
          sendJson(res, 400, { ok: false, detail: "set_id required in path" }, requestId);
        } else {
          const payload = await runtime.deleteActivationSet(setId);
          sendJson(res, payload.ok ? 200 : (payload.code === "SET_NOT_FOUND" ? 404 : 409), payload, requestId);
        }
      } else if (req.method === "GET" && url.pathname.startsWith("/api/llm-host/jobs/")) {
        const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
        const payload = runtime.getJob(jobId);
        sendJson(res, payload.ok ? 200 : 404, payload, requestId);
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/actions/restart") {
        const body = await readJsonBody(req);
        const laneId = String(body.lane_id || body.laneId || "").trim();
        if (!laneId) {
          sendJson(res, 400, { ok: false, code: ErrorCode.INPUT_INVALID, detail: "lane_id is required" }, requestId);
        } else {
          const payload = await runtime.restartLane(laneId);
          sendJson(res, payload.ok ? 200 : 400, payload, requestId);
        }
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/actions/stop") {
        const body = await readJsonBody(req);
        const payload = await runtime.stopLane(body.lane_id || body.laneId || "all");
        sendJson(res, payload.ok ? 200 : 400, payload, requestId);
      } else if (req.method === "POST" && url.pathname === "/bonzai") {
        sendJson(res, 200, await runtime.bonzai(), requestId);
      } else if (req.method === "POST" && (url.pathname === "/fleet/up" || url.pathname === "/api/llm-host/fleet/up")) {
        const body = await readJsonBody(req);
        const payload = await runtime.fleetUp({ wait: Boolean(body.wait) });
        sendJson(res, payload.accepted ? 202 : 400, payload, requestId);
      } else if (req.method === "POST" && (url.pathname === "/fleet/down" || url.pathname === "/api/llm-host/fleet/down")) {
        const body = await readJsonBody(req);
        const payload = await runtime.fleetDown({ wait: Boolean(body.wait) });
        sendJson(res, payload.accepted ? 202 : 400, payload, requestId);
      } else if (req.method === "POST" && url.pathname === "/api/llm-host/snapshot") {
        sendJson(res, 200, await runtime.writeInventorySnapshot(), requestId);
      } else if (req.method === "GET" && url.pathname.startsWith("/api/services/")) {
        const SISTER_ROUTES = {
          "/api/services/alpha/health": "http://127.0.0.1:4001/health",
          "/api/services/alpha/status": "http://127.0.0.1:4001/api/status",
          "/api/services/alpha-gamenator/health": "http://127.0.0.1:4002/health",
          "/api/services/alpha-gamenator/status": "http://127.0.0.1:4002/api/status",
        };
        const target = SISTER_ROUTES[url.pathname];
        if (target) {
          try {
            const upstream = await fetch(target, { signal: AbortSignal.timeout(3000) });
            const data = await upstream.json();
            sendJson(res, upstream.ok ? 200 : 502, data, requestId);
          } catch {
            sendJson(res, 503, { ok: false, service: "unavailable" }, requestId);
          }
        } else {
          notFound(res, requestId);
        }
      } else {
        notFound(res, requestId);
      }
    } catch (error) {
      const code = /** @type {any} */ (error)?.code || ErrorCode.INTERNAL_ERROR;
      const safeDetail = [ErrorCode.BODY_TOO_LARGE, ErrorCode.BODY_PARSE_ERROR, ErrorCode.BODY_TIMEOUT].includes(code)
        ? String(error?.message || "request error")
        : "internal server error";
      logger.error("request error", { rid: requestId, error: String(error?.message || error) });
      sendJson(res, 500, { ok: false, code, detail: safeDetail }, requestId);
    }

    const status = res.statusCode;
    logger.info("request", { rid: requestId, method: req.method, path: req.url, status, ip, ms: Date.now() - startMs });
  };
}

/** In-flight request counter for graceful drain. */
let inFlightCount = 0;
let draining = false;

export function createServer({
  runtime = createRuntime({ repoRoot: "/home/admin/apps/LLMCommune" }),
  defaultHost = "127.0.0.1:4000",
  rootDashboardFile = "",
} = {}) {
  const handler = createApp({ runtime, defaultHost, rootDashboardFile });
  const server = http.createServer(async (req, res) => {
    if (draining) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, detail: "server draining" }) + "\n");
      return;
    }
    inFlightCount++;
    res.on("finish", () => { inFlightCount--; });
    await handler(req, res);
  });
  return server;
}

export function installProcessGuards({ processRef = process, servers = [] } = {}) {
  processRef.on("uncaughtException", (error) => {
    logger.error("uncaughtException", { error: String(error?.stack || error) });
    processRef.exit(1);
  });

  processRef.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", { reason: String(reason) });
    processRef.exit(1);
  });

  const shutdown = async (signal) => {
    logger.info("shutdown", { signal, in_flight: inFlightCount, servers: servers.length });
    draining = true;
    for (const server of servers) {
      try { server?.close?.(); } catch {}
    }
    const drainDeadline = Date.now() + 30000;
    while (inFlightCount > 0 && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (inFlightCount > 0) {
      logger.warn("shutdown: drain timeout, exiting with in-flight requests", { remaining: inFlightCount });
    }
    processRef.exit(signal === "SIGTERM" ? 143 : 130);
  };

  processRef.on("SIGTERM", () => shutdown("SIGTERM"));
  processRef.on("SIGINT", () => shutdown("SIGINT"));
}

export function startServer({
  port = Number(process.env.PORT || 4000),
  host = process.env.HOST || "192.168.1.203",
  uiPort = Number(process.env.LLMCOMMUNE_UI_PORT || 8001),
  uiHost = process.env.LLMCOMMUNE_UI_HOST || host,
  runtime = createRuntime({ repoRoot: "/home/admin/apps/LLMCommune" }),
} = {}) {
  const apiServer = createServer({ runtime, defaultHost: `${host}:${port}` });
  const servers = [apiServer];
  let uiServer = null;

  if (uiPort && uiPort !== port) {
    uiServer = createServer({
      runtime,
      defaultHost: `${uiHost}:${uiPort}`,
      rootDashboardFile: "control-room.html",
    });
    servers.push(uiServer);
  }

  installProcessGuards({ servers });

  apiServer.listen(port, host, () => {
    logger.info("server started", { role: "api", port, host });
    runtime.startupChecks?.().catch((err) => logger.warn("startup checks error", { error: String(err?.message || err) }));
  });

  if (uiServer) {
    uiServer.listen(uiPort, uiHost, () => {
      logger.info("server started", { role: "ui", port: uiPort, host: uiHost, route: "/" });
    });
  }

  return { apiServer, uiServer };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  startServer();
}
