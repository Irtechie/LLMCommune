#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildCatalog, repoRoot, writeJsonReport } from "../tests/support/catalog.js";

const reportRoot = path.join(repoRoot, "workspace", "test-reports");

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const catalog = await buildCatalog();
  const unitRuntime = await readJson(path.join(reportRoot, "unit-runtime-controller.json"), {
    suite: "unit-runtime-controller",
    results: [],
    passed: 0,
    failed: 0,
  });
  const unitWatchdog = await readJson(path.join(reportRoot, "unit-watchdog.json"), {
    suite: "unit-watchdog",
    results: [],
    passed: 0,
    failed: 0,
  });
  const live = await readJson(path.join(reportRoot, "live.json"), {
    suite: "live",
    results: [],
    passed: 0,
    failed: 0,
  });

  const latest = {
    generated_at: new Date().toISOString(),
    catalog,
    unit: {
      suites: [unitRuntime, unitWatchdog],
      passed: Number(unitRuntime.passed || 0) + Number(unitWatchdog.passed || 0),
      failed: Number(unitRuntime.failed || 0) + Number(unitWatchdog.failed || 0),
    },
    live,
    final_result:
      Number(unitRuntime.failed || 0) === 0 &&
      Number(unitWatchdog.failed || 0) === 0 &&
      Number(live.failed || 0) === 0
        ? "passed"
        : "failed",
  };

  const outputPath = path.join(reportRoot, "latest.json");
  await writeJsonReport(outputPath, latest);

  console.log("LLMCommune Test Report");
  console.log(`- Profiles cataloged: ${catalog.profiles.length}`);
  console.log(`- Fleet profiles cataloged: ${catalog.fleets.length}`);
  console.log(`- Candidate models cataloged only: ${catalog.candidates.length}`);
  console.log(`- Unit passed: ${latest.unit.passed}`);
  console.log(`- Unit failed: ${latest.unit.failed}`);
  console.log(`- Live passed: ${Number(live.passed || 0)}`);
  console.log(`- Live failed: ${Number(live.failed || 0)}`);
  console.log(`- Final result: ${latest.final_result}`);
  console.log(`- Machine report: ${outputPath}`);

  for (const entry of live.results || []) {
    const label = entry.profile_id || entry.fleet_id || entry.scope || "unknown";
    const startup = entry.startup_duration_s != null ? ` startup=${entry.startup_duration_s}s` : "";
    const detail = entry.detail ? ` detail=${entry.detail}` : "";
    console.log(`  - ${label}: ${entry.status}${startup}${detail}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
