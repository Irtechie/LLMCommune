import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { repoRoot as sourceRepoRoot } from "./catalog.js";

function mergeValue(baseValue, overrideValue) {
  if (Array.isArray(baseValue) || Array.isArray(overrideValue)) {
    return overrideValue;
  }
  if (
    baseValue &&
    typeof baseValue === "object" &&
    overrideValue &&
    typeof overrideValue === "object"
  ) {
    const merged = { ...baseValue };
    for (const [key, value] of Object.entries(overrideValue)) {
      merged[key] = mergeValue(baseValue[key], value);
    }
    return merged;
  }
  return overrideValue;
}

export async function createRepoFixture(configOverride = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "llmcommune-test-"));
  await mkdir(path.join(repoRoot, "src", "config"), { recursive: true });
  await mkdir(path.join(repoRoot, "workspace", "runtime"), { recursive: true });
  await mkdir(path.join(repoRoot, "workspace", "jobs", "_lanes"), { recursive: true });
  await mkdir(path.join(repoRoot, "workspace", "current"), { recursive: true });

  const baseConfig = JSON.parse(
    await readFile(path.join(sourceRepoRoot, "src", "config", "models.json"), "utf-8"),
  );
  const mergedConfig = mergeValue(baseConfig, configOverride);
  await writeFile(
    path.join(repoRoot, "src", "config", "models.json"),
    `${JSON.stringify(mergedConfig, null, 2)}\n`,
    "utf-8",
  );

  return {
    repoRoot,
    sourceRepoRoot,
    config: mergedConfig,
    async cleanup() {
      await rm(repoRoot, { recursive: true, force: true });
    },
  };
}

export async function seedLaneSlot(repoRoot, laneId, payload) {
  const filePath = path.join(
    repoRoot,
    "workspace",
    "runtime",
    laneId === "mini" ? "mini_slot.json" : "large_slot.json",
  );
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export async function seedDesiredState(repoRoot, payload) {
  const filePath = path.join(repoRoot, "workspace", "runtime", "desired_state.json");
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}
