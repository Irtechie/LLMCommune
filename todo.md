# TODO

## Purpose
Single live runner for `LLMCommune`, the standalone two-lane LLM host controller for the dual GX10 boxes.

Shared rules:
- See [todo_rules.md](/home/admin/apps/LLMCommune/todo_rules.md)

## Objective
Keep `LLMCommune` as the minimal source of truth for:
- `:4000` controller state
- large-lane `:8000` model orchestration
- mini-lane `:7999` model orchestration
- truthful CLI-facing runtime metadata
- host-aware switching, restart, stop, and bonzai flows

## Current Focus
- keep the controller contract stable
- keep the large and mini lanes limited to proven or explicitly manual paths
- keep `models.json`, `models.md`, and `modelstocheck.md` aligned with local reality

## Current Truth
- `LLMCommune` now exists at [/home/admin/apps/LLMCommune](/home/admin/apps/LLMCommune)
- the static registry is [models.json](/home/admin/apps/LLMCommune/src/config/models.json)
- the human/app handoff doc is [models.md](/home/admin/apps/LLMCommune/models.md)
- the deep compatibility / restore report is [modelstocheck.md](/home/admin/apps/LLMCommune/modelstocheck.md)
- the controller is implemented in:
  - [index.js](/home/admin/apps/LLMCommune/src/index.js)
  - [runtime.js](/home/admin/apps/LLMCommune/src/runtime.js)
- lane rules are:
  - large lane on `:8000`
  - mini lane on `:7999`
  - at most two active profiles total
  - mini lane only for `<=32B`
  - never two large profiles at once
- the controller exposes:
  - `GET /health`
  - `GET /api/llm-host/help`
  - `GET /api/llm-host/current`
  - `GET /api/llm-host/models`
  - `POST /api/llm-host/activate`
  - `GET /api/llm-host/jobs/:job_id`
  - `POST /api/llm-host/actions/restart`
  - `POST /api/llm-host/actions/stop`
  - `POST /bonzai`
- some TRT launchers still delegate to Alpha shell scripts
  - no longer true for the active commune launchers
  - the controller and active TRT launchers are now commune-owned
- local/proven two-box lanes are currently:
  - `openai/gpt-oss-120b` on TRT `1.2.0rc6`
  - `nvidia/Llama-3.3-70B-Instruct-FP4` on TRT `1.2.0rc6`
- local/manual restore lane is currently:
  - `nvidia/Qwen3-235B-A22B-NVFP4` on TRT `1.0.0rc3`, `:8000`, `32768`
- current research/download-only families are recorded in:
  - [modelstocheck.md](/home/admin/apps/LLMCommune/modelstocheck.md)
  - `candidate_models` in [models.json](/home/admin/apps/LLMCommune/src/config/models.json)

## Success Criteria
- `models.json` stays the static source of truth for hosts, lanes, profiles, runtime family, model role, and wait guidance
- `GET /api/llm-host/current` and `GET /api/llm-host/models` stay truthful enough that a CLI can use them directly
- large and mini lane rules are enforced consistently
- `bonzai` always yields a safe known-good coding model on `:8000`
- `LLMCommune` no longer depends on the Alpha web app being up
- proven, manual-only, and download-only model paths are explicitly separated
- the live runner ends with no `Ready: yes` tasks unless a new human promotion happens

## Active Tasks
- [x] ~~Write a research-backed `modelstocheck.md` that separates proven, manual-only, and download-only model paths for the dual GX10 pair.~~
  - Task ID: llmcommune-models-to-check-report
  - Ready: yes
  - Validation: [modelstocheck.md](/home/admin/apps/LLMCommune/modelstocheck.md) exists and cites official/community/local evidence.

- [x] ~~Harden `models.json` so active profiles carry support/context/container metadata and non-active research models are visible as candidate models.~~
  - Task ID: llmcommune-model-registry-hardening
  - Ready: yes
  - Validation: [models.json](/home/admin/apps/LLMCommune/src/config/models.json) now includes `profile_policy`, `inventory_policy`, and `candidate_models`.

- [x] ~~Replace Alpha-delegated TRT launchers with `LLMCommune`-owned launchers where the path is already stable.~~
  - Task ID: llmcommune-trt-launcher-extraction
  - Ready: yes
  - Validation: `rg '/home/admin/apps/Alpha' /home/admin/apps/LLMCommune/scripts` only hits the explicit Alpha-stop utility, not active commune launchers.

- [x] ~~Add explicit troubleshooting metadata and report links to `GET /api/llm-host/help`.~~
  - Task ID: llmcommune-help-troubleshooting
  - Ready: yes
  - Validation: `GET /api/llm-host/help` now includes `troubleshooting` and `source_of_truth.research_report`.

- [x] ~~Update `models.md` so other apps can discover the new research/status fields without guessing.~~
  - Task ID: llmcommune-models-md-sync
  - Ready: yes
  - Validation: [models.md](/home/admin/apps/LLMCommune/models.md) now points to [modelstocheck.md](/home/admin/apps/LLMCommune/modelstocheck.md) and documents the classification fields.

## Human Required
- [!] Confirm which additional mini-lane models should become CLI-selectable by default versus remain reserved.
  - Task ID: llmcommune-mini-lane-default-policy
  - Ready: no

## Parked / Cold Storage
- [-] Keep `Qwen/Qwen3.5-397B-A17B-GPTQ-Int4` as download-only until a stable two-box Spark recipe stops requiring forum-tier patching.
  - Task ID: llmcommune-qwen35-397b-download-only
  - Ready: no

- [-] Keep `nvidia/DeepSeek-V3.2-NVFP4` as download-only until the public NVFP4 artifact path is actually complete.
  - Task ID: llmcommune-deepseek-v32-download-only
  - Ready: no

- [-] Keep >`235B-A22B` official-but-iffy candidates off the active controller list.
  - Task ID: llmcommune-over-235b-download-only
  - Ready: no
  - Discovered from: llmcommune-models-to-check-report

## Blocked
- [!] Restore `nvidia/Qwen3-235B-A22B-NVFP4` as a selectable large-lane model only after an isolated revalidation on the exact known-good recipe.
  - Task ID: llmcommune-qwen235-restore
  - Ready: no
  - Depends on: explicit human promotion of a guarded re-test
  - Validation: successful `:8000` serve on TRT `1.0.0rc3` with `32768` start context and no destabilizing side effects.

- [!] Build an isolated `vLLM` lane for the AWQ `Qwen3-235B-A22B` community path if we decide to chase the fastest current two-Spark Qwen setup.
  - Task ID: llmcommune-qwen235-awq-vllm-lane
  - Ready: no
  - Depends on: explicit human promotion of a separate vLLM experiment lane

- [!] Promote any `candidate_models` entry only after it graduates from `download_only` or `community_proven_not_wired` into a proven local lane.
  - Task ID: llmcommune-candidate-promotion-gate
  - Ready: no
  - Depends on: per-model local proof, controller contract, and guarded benchmark validation

## Work Log
- 2026-04-01
  - created standalone `LLMCommune` controller app
  - added `models.json` static registry
  - added `models.md` integration handoff
  - added large-lane `:8000` and mini-lane `:7999` policy
  - added `bonzai` reset path
- 2026-04-02
  - wrote [modelstocheck.md](/home/admin/apps/LLMCommune/modelstocheck.md) from official docs, NVIDIA forum threads, and local startup proofs
  - classified active profiles via `profile_policy` and long-tail inventory via `inventory_policy`
  - added `candidate_models` for download-only / research-only tracks
  - added troubleshooting metadata and report links to `GET /api/llm-host/help`
  - confirmed the active commune launchers are local and no longer depend on Alpha launch scripts
