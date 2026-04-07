import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const repoRoot = "/home/admin/apps/LLMCommune";
export const configPath = path.join(repoRoot, "src", "config", "models.json");

export async function loadModelsConfig(root = repoRoot) {
  const raw = await readFile(path.join(root, "src", "config", "models.json"), "utf-8");
  return JSON.parse(raw);
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function launchScriptFromCommand(command, root) {
  const text = String(command || "").trim();
  const absoluteMatch = text.match(/(?:^|\s)bash\s+(['"]?)(\/[^'"\s]+\.sh)\1/);
  if (absoluteMatch) return absoluteMatch[2];
  const rootMatch = text.match(/(?:^|\s)bash\s+(['"]?)\$ROOT\/scripts\/([^'"\s]+\.sh)\1/);
  if (rootMatch) return path.join(root, "scripts", rootMatch[2]);
  return "";
}

function normalizeDiscoveredScript(rawPath, root) {
  if (!rawPath) return "";
  if (rawPath.startsWith("$ROOT/scripts/")) {
    return path.join(root, "scripts", rawPath.slice("$ROOT/scripts/".length));
  }
  if (rawPath.startsWith("/")) return rawPath;
  return "";
}

function shouldTrackLoaderScript(scriptPath) {
  const base = path.basename(scriptPath);
  if (!base.endsWith(".sh")) return false;
  if (base.startsWith("stop_")) return false;
  return true;
}

async function discoverDelegatedScripts(scriptPath, root, visited = new Set()) {
  if (!scriptPath || visited.has(scriptPath)) return [];
  visited.add(scriptPath);
  const content = await readFile(scriptPath, "utf-8");
  const matches = [
    ...content.matchAll(/(?:exec\s+)?bash\s+(['"]?)(\/home\/admin\/apps\/LLMCommune\/scripts\/[^'"\s]+\.sh)\1/g),
    ...content.matchAll(/(?:exec\s+)?bash\s+(['"]?)(\$ROOT\/scripts\/[^'"\s]+\.sh)\1/g),
    ...content.matchAll(/(?:^|\s)exec\s+(\/home\/admin\/apps\/LLMCommune\/scripts\/[^'"\s]+\.sh)/gm),
  ]
    .map((match) => normalizeDiscoveredScript(match[2] || match[1] || "", root))
    .filter(Boolean)
    .filter((entry) => entry !== scriptPath)
    .filter(shouldTrackLoaderScript);

  const results = [];
  for (const delegatedPath of matches) {
    if (results.includes(delegatedPath)) continue;
    results.push(delegatedPath);
    const nested = await discoverDelegatedScripts(delegatedPath, root, visited);
    for (const nestedPath of nested) {
      if (!results.includes(nestedPath)) {
        results.push(nestedPath);
      }
    }
  }
  return results;
}

function profileTopology(profile) {
  return profile?.requires_both_boxes ? "dual_box" : "single_box";
}

function summarizeEntry(entry) {
  return {
    profile_id: entry.profile_id,
    display_name: entry.display_name,
    model_id: entry.model_id,
    runtime_family: entry.runtime_family,
    size_class: entry.size_class,
    default_lane: entry.default_lane,
    topology: profileTopology(entry),
    requires_both_boxes: Boolean(entry.requires_both_boxes),
    launch_command: entry.launch_command,
    startup_expectation: entry.startup_expectation || null,
  };
}

export async function buildProfileCatalog(root = repoRoot) {
  const config = await loadModelsConfig(root);
  const profiles = [];
  for (const profile of config.profiles || []) {
    const launchScript = launchScriptFromCommand(profile.launch_command, root);
    const loaderChain = launchScript
      ? [launchScript, ...(await discoverDelegatedScripts(launchScript, root))]
      : [];
    profiles.push({
      ...summarizeEntry(profile),
      launch_script: launchScript,
      launch_script_exists: launchScript ? await fileExists(launchScript) : false,
      loader_chain: loaderChain,
      delegated_scripts: loaderChain.slice(1),
    });
  }
  return profiles;
}

export async function buildFleetCatalog(root = repoRoot) {
  const config = await loadModelsConfig(root);
  const fleets = [];
  for (const fleet of config.fleet_profiles || []) {
    const members = [];
    for (const member of fleet.members || []) {
      const launchScript = launchScriptFromCommand(member.launch_command, root);
      const loaderChain = launchScript
        ? [launchScript, ...(await discoverDelegatedScripts(launchScript, root))]
        : [];
      members.push({
        member_id: member.member_id,
        profile_id: member.profile_id,
        display_name: member.display_name,
        model_id: member.model_id,
        runtime_family: member.runtime_family,
        host_id: member.host_id,
        port: member.port,
        launch_command: member.launch_command,
        launch_script: launchScript,
        launch_script_exists: launchScript ? await fileExists(launchScript) : false,
        loader_chain: loaderChain,
        delegated_scripts: loaderChain.slice(1),
      });
    }
    fleets.push({
      fleet_id: fleet.fleet_id,
      display_name: fleet.display_name,
      mode: fleet.mode,
      selection_role: fleet.selection_role,
      startup_expectation: fleet.startup_expectation || null,
      members,
    });
  }
  return fleets;
}

export async function buildCandidateCatalog(root = repoRoot) {
  const config = await loadModelsConfig(root);
  return (config.candidate_models || []).map((candidate) => ({
    ...candidate,
    live_tested: false,
  }));
}

export async function buildCatalog(root = repoRoot) {
  const [config, profiles, fleets, candidates] = await Promise.all([
    loadModelsConfig(root),
    buildProfileCatalog(root),
    buildFleetCatalog(root),
    buildCandidateCatalog(root),
  ]);
  return {
    generated_at: new Date().toISOString(),
    controller: config.controller,
    lanes: config.lanes,
    profiles,
    fleets,
    candidates,
  };
}

export async function writeJsonReport(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}
