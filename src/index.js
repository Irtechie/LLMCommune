import http from "node:http";
import path from "node:path";
import { createRuntime } from "./runtime.js";

const repoRoot = "/home/admin/apps/LLMCommune";
const runtime = createRuntime({ repoRoot });
const port = Number(process.env.PORT || 4000);

process.on("uncaughtException", (error) => {
  console.error("[llmcommune] uncaughtException", error?.stack || error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[llmcommune] unhandledRejection", reason);
  process.exit(1);
});

process.on("SIGTERM", () => {
  console.error("[llmcommune] received SIGTERM");
  process.exit(143);
});

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function notFound(res) {
  sendJson(res, 404, { ok: false, detail: "not found" });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1:4000"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "LLMCommune", status: "ok" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/llm-host/help") {
      sendJson(res, 200, await runtime.getHelp());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/llm-host/current") {
      sendJson(res, 200, await runtime.getCurrent());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/llm-host/models") {
      sendJson(res, 200, await runtime.listModels());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/llm-host/activate") {
      const body = await readJsonBody(req);
      const payload = await runtime.activate({
        profileId: body.profile_id || body.profileId || "",
        laneId: body.lane_id || body.laneId || "",
        wait: Boolean(body.wait),
        allowPreempt: Object.prototype.hasOwnProperty.call(body, "allow_preempt")
          ? Boolean(body.allow_preempt)
          : Object.prototype.hasOwnProperty.call(body, "allowPreempt")
            ? Boolean(body.allowPreempt)
            : true,
      });
      sendJson(res, payload.accepted ? 202 : 400, payload);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/llm-host/jobs/")) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const payload = runtime.getJob(jobId);
      sendJson(res, payload.ok ? 200 : 404, payload);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/llm-host/actions/restart") {
      const body = await readJsonBody(req);
      const payload = await runtime.restartLane(body.lane_id || body.laneId || "");
      sendJson(res, payload.ok ? 200 : 400, payload);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/llm-host/actions/stop") {
      const body = await readJsonBody(req);
      const payload = await runtime.stopLane(body.lane_id || body.laneId || "all");
      sendJson(res, payload.ok ? 200 : 400, payload);
      return;
    }
    if (req.method === "POST" && url.pathname === "/bonzai") {
      sendJson(res, 200, await runtime.bonzai());
      return;
    }
    if (req.method === "POST" && (url.pathname === "/fleet/up" || url.pathname === "/api/llm-host/fleet/up")) {
      const body = await readJsonBody(req);
      const payload = await runtime.fleetUp({
        wait: Boolean(body.wait),
      });
      sendJson(res, payload.accepted ? 202 : 400, payload);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/fleet/down" || url.pathname === "/api/llm-host/fleet/down")) {
      const body = await readJsonBody(req);
      const payload = await runtime.fleetDown({
        wait: Boolean(body.wait),
      });
      sendJson(res, payload.accepted ? 202 : 400, payload);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/llm-host/snapshot") {
      sendJson(res, 200, await runtime.writeInventorySnapshot());
      return;
    }
    notFound(res);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      detail: String(error?.message || error || "request failed"),
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`LLMCommune listening on :${port}`);
});
