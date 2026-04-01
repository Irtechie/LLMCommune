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
- finish extracting launchers away from Alpha when practical
- keep `models.json` and the live JSON aligned

## Current Truth
- `LLMCommune` now exists at [/home/admin/apps/LLMCommune](/home/admin/apps/LLMCommune)
- the static registry is [models.json](/home/admin/apps/LLMCommune/src/config/models.json)
- the human/app handoff doc is [models.md](/home/admin/apps/LLMCommune/models.md)
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
  - this is acceptable for now
  - the controller itself is standalone

## Success Criteria
- `models.json` stays the static source of truth for hosts, lanes, profiles, runtime family, model role, and wait guidance
- `GET /api/llm-host/current` and `GET /api/llm-host/models` stay truthful enough that a CLI can use them directly
- large and mini lane rules are enforced consistently
- `bonzai` always yields a safe known-good coding model on `:8000`
- `LLMCommune` no longer depends on the Alpha web app being up
- remaining Alpha launcher dependencies are explicit and shrink over time

## Active Tasks
- [ ] Harden `models.json` classification for every installed model this box pair can realistically host.
  - Task ID: llmcommune-model-registry-hardening
  - Ready: yes
  - Validation: `GET /api/llm-host/models` includes correct lane/runtime/host metadata.

- [ ] Replace Alpha-delegated TRT launchers with `LLMCommune`-owned launchers where the path is already stable.
  - Task ID: llmcommune-trt-launcher-extraction
  - Ready: yes
  - Validation: large-lane TRT profiles launch without requiring Alpha script paths.

- [ ] Add explicit troubleshooting metadata to `help` for each runtime family.
  - Task ID: llmcommune-help-troubleshooting
  - Ready: yes
  - Validation: `GET /api/llm-host/help` includes health endpoints, stop/restart guidance, and expected ready timing.

## Human Required
- [!] Confirm which additional mini-lane models should become CLI-selectable by default versus remain reserved.
  - Task ID: llmcommune-mini-lane-default-policy
  - Ready: no

## Parked / Cold Storage
- [-] Add a worker-hosted mini sidecar lane once the single-machine CLI proof path is fully stable.
  - Task ID: llmcommune-worker-mini-sidecar
  - Ready: no

- [-] Add vLLM-specific profiles once they have a stable host/port contract for this pair.
  - Task ID: llmcommune-vllm-profile-pack
  - Ready: no

## Blocked
- [!] Full removal of Alpha launcher reuse depends on copying or rewriting the proven dual-box TRT shell logic into `LLMCommune`.
  - Task ID: llmcommune-full-alpha-detach
  - Ready: no
  - Depends on: llmcommune-trt-launcher-extraction

## Work Log
- 2026-04-01
  - created standalone `LLMCommune` controller app
  - added `models.json` static registry
  - added `models.md` integration handoff
  - added large-lane `:8000` and mini-lane `:7999` policy
  - added `bonzai` reset path
