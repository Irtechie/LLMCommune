# LLMCommune Models

`LLMCommune` is the minimal two-lane controller for the GX10 pair.

Source of truth:
- static registry: [`src/config/models.json`](/home/admin/apps/LLMCommune/src/config/models.json)
- live current state: `GET /api/llm-host/current`
- live profile and inventory view: `GET /api/llm-host/models`
- live startup catalog: `GET /api/llm-host/startups`
- deep compatibility and restore report: [`modelstocheck.md`](/home/admin/apps/LLMCommune/modelstocheck.md)

Use the live JSON for runtime truth. Use `models.json` for the curated static contract: lanes, profiles, runtime families, parameter class, hosts, launch policy, and default wait times.

For restore or research work, use `modelstocheck.md` instead of guessing from the active profile list.

## Host Layout

- `spark-f147`
  - head/controller
  - `192.168.1.203`
  - CX7: `169.254.10.1`
  - large lane: `:8000`
  - mini lane: `:7999`
  - controller: `:4000`
- `gx10-b041`
  - worker/backend
  - `192.168.1.204`
  - CX7: `169.254.10.2`

## Lane Rules

- Large lane:
  - port `8000`
  - large profiles only
  - one active profile at a time
- Mini lane:
  - port `7999`
  - mini profiles only
  - one active profile at a time
- Mini fleet mode:
  - one mini per box
  - `spark:7999`
  - `gx10:7999`
  - intended for `fleet up`, not for stacking multiple 32B models on one box
- Mode policy:
  - either one large on `:8000`
  - or mini-only mode
  - never mix large and mini at the same time
- Dual-box large profiles:
  - reserve both boxes
  - still serve through `spark:8000`

## API

- `GET /health`
- `GET /api/llm-host/help`
- `GET /api/llm-host/current`
- `GET /api/llm-host/models`
- `GET /api/llm-host/startups`
- `POST /api/llm-host/activate`
- `GET /api/llm-host/jobs/:job_id`
- `POST /api/llm-host/actions/restart`
- `POST /api/llm-host/actions/stop`
- `POST /bonzai`
- `POST /fleet/up`
- `POST /fleet/down`

`POST /fleet/up` and `POST /fleet/down` return queued job payloads and converge in the background.

## Controller Service And Watchdog

`LLMCommune` includes a small watchdog app so keeping `:4000` alive does not depend on an interactive Codex shell.

Files:
- [`systemd/llmcommune-controller.service`](/home/admin/apps/LLMCommune/systemd/llmcommune-controller.service)
- [`systemd/llmcommune-watchdog.service`](/home/admin/apps/LLMCommune/systemd/llmcommune-watchdog.service)
- [`scripts/install_controller_service.sh`](/home/admin/apps/LLMCommune/scripts/install_controller_service.sh)
- [`src/watchdog.js`](/home/admin/apps/LLMCommune/src/watchdog.js)
- [`scripts/start_watchdog_4000.sh`](/home/admin/apps/LLMCommune/scripts/start_watchdog_4000.sh)
- [`scripts/stop_watchdog_4000.sh`](/home/admin/apps/LLMCommune/scripts/stop_watchdog_4000.sh)
- [`scripts/start_controller_4000.sh`](/home/admin/apps/LLMCommune/scripts/start_controller_4000.sh)
- [`scripts/stop_controller_4000.sh`](/home/admin/apps/LLMCommune/scripts/stop_controller_4000.sh)

Behavior:
- the preferred persistence layer is the `llmcommune-controller.service` unit for `:4000`
- `llmcommune-watchdog.service` is a separate user service
- the controller service only owns `:4000`
- the watchdog does not blindly keep `:8000` or `:7999` alive
- the watchdog only reconciles lane or fleet state when `desired_state.watchdog_enforce=true`
- during `starting`, `stopping`, or `swapping`, the watchdog leaves the model lanes alone
- writes PID/log files under `workspace/runtime/`

Runtime files:
- `workspace/runtime/watchdog-4000.pid`
- `workspace/runtime/watchdog-4000.log`
- `workspace/runtime/controller-4000.log`
- `workspace/runtime/desired_state.json`
- `workspace/runtime/startup_catalog.json`
- `workspace/current/startups.live.json`

## How Another App Should Use It

1. Call `GET /api/llm-host/help`
2. Read lane policy and adapter semantics
3. Call `GET /api/llm-host/models`
4. Pick a `profile_id`
5. Call `POST /api/llm-host/activate`
6. Poll `GET /api/llm-host/jobs/:job_id`
7. Once ready, use the returned adapter and `base_url`

OpenAI-style clients should consume the returned adapter instead of guessing:
- `runtime_family`
- `protocol`
- `base_url`
- `health_url`
- `models_url`
- `chat_url`
- `completions_url`
- `model_field`

Apps should also read the controller's classification fields instead of inferring stability from the model name:
- `support_status`
- `evidence_level`
- `recommended_action`
- `recommended_context_tokens`
- `recommended_container`

For historical startup/readback work, apps should prefer the consolidated startup catalog over scraping lane folders:
- `GET /api/llm-host/startups`
- `workspace/runtime/startup_catalog.json`
- `workspace/current/startups.live.json`

That catalog is the stable way for Alpha or another app to read:
- every startup attempt
- latest ready startup per profile
- slot-to-profile mapping
- the exact `startup-state-*.json` and log file that backed the attempt

`GET /api/llm-host/models` now also exposes `candidate_models` for download-only or research-only tracks that should not be auto-promoted into the active lane list.

## Current Intended Profiles

Large lane:
- `gguf_coder_next_large`
- `gguf_qwen3_next_80b_large`
- `trt_dual_gpt_oss_120b_large`
- `trt_dual_llama33_70b_large`

Mini lane:
- `trt_single_qwen3_30b_a3b_mini`
- `trt_single_qwen3_32b_mini`
- `gguf_deepseek_32b_mini`

`gguf_deepseek_32b_mini` is currently marked `alpha_reserved` in the config, so other apps can see it but should not treat it as the default CLI choice.

## Mini Fleet

`fleet up` is the default two-mini mode:

- `spark:7999`
  - `trt_single_qwen3_30b_a3b_mini`
- `gx10:7999`
  - `gguf_deepseek_32b_worker_fleet`

Purpose:
- one 32B-class mini per box
- no large model running
- no attempt to stack multiple 32B models on the same GX10

Controller behavior:
- `POST /fleet/up`
  - stops the large lane
  - clears any existing mini/fleet state
  - starts Qwen on `spark:7999`
  - starts DeepSeek on `gx10:7999`
- `POST /fleet/down`
  - stops both mini fleet members
  - does not touch the large lane
- starting a large model through the controller tears the mini fleet down first
- starting a single mini profile through the controller also clears the large lane first

## Role Guidance

- `gguf_coder_next_large`
  - runtime: `llama.cpp`
  - host pattern: single-box on `spark-f147`
  - lane: `large`
  - serves on: `spark:8000`
  - official max context window: `262144` native
  - current launcher context window: `32768`
  - official Qwen positioning: designed specifically for coding agents and local development
  - strongest sourced fit for code generation, repo edits, tool use, long-horizon coding tasks, and recovery from execution failures
  - best default large-lane coding host for a CLI-style workflow
- `gguf_qwen3_next_80b_large`
  - runtime: `llama.cpp`
  - host pattern: single-box on `spark-f147`
  - lane: `large`
  - serves on: `spark:8000`
  - official max context window: `262144` native
  - current launcher context window: `65536`
  - official Qwen positioning: next-generation general foundation model focused on parameter efficiency, inference speed, ultra-long context, and agentic use
  - better fit than CoderNext when the task is broader reasoning, synthesis, long-context analysis, or general assistant work instead of coding-specialized throughput
  - main reasoning-oriented single-box large profile
- `trt_single_qwen3_30b_a3b_mini`
  - runtime: `trtllm`
  - host pattern: single-box on `spark-f147`
  - lane: `mini`
  - serves on: `spark:7999`
  - official max context window: `131K`
  - current launcher context window: `32768`
  - mini general-purpose TRT lane for agent systems, chatbots, RAG, and other AI application tasks
  - best fit when you want a smaller responsive helper model on the mini lane rather than the strongest possible reasoning depth
  - treat it as the fast general mini helper
- `trt_single_qwen3_32b_mini`
  - runtime: `trtllm`
  - host pattern: single-box on `spark-f147`
  - lane: `mini`
  - serves on: `spark:7999`
  - official max context window: `32768` native, `131072` with YaRN
  - current launcher context window: `32768`
  - mini TRT profile with stronger official coding preservation than a generic small helper; published FP4 evals show near-full HumanEval recovery and most general/reasoning capability retained
  - use when you want more depth than the 30B A3B path and can accept lower speed
- `gguf_deepseek_32b_mini`
  - runtime: `llama.cpp`
  - host pattern: single-box on `spark-f147`
  - lane: `mini`
  - serves on: `spark:7999`
  - official local serving example max context window: `32768`
  - current launcher context window: `16384`
  - official DeepSeek positioning: distilled reasoning model with strong math, code, and reasoning behavior inherited from DeepSeek-R1
  - mini helper/reserved lane for Alpha-style reasoning work
  - visible to other apps, but currently not the default CLI choice
- `trt_dual_gpt_oss_120b_large`
  - runtime: `trtllm`
  - host pattern: dual-box on `spark-f147` + `gx10-b041`
  - lane: `large`
  - serves on: `spark:8000`
  - official max context window: `128k` native
  - current launcher context window: `131072`
  - dual-box large coding/reasoning candidate
  - use only when both boxes are intentionally reserved for the large lane
- `trt_dual_llama33_70b_large`
  - runtime: `trtllm`
  - host pattern: dual-box on `spark-f147` + `gx10-b041`
  - lane: `large`
  - serves on: `spark:8000`
  - official max context window: `128K`
  - current launcher context window: `131072`
  - dual-box general assistant candidate
  - useful as a comparison option once the shared TRT lane is stable
- `trt_dual_qwen235_large`
  - runtime: `trtllm`
  - host pattern: dual-box on `spark-f147` + `gx10-b041`
  - lane: `large`
  - serves on: `spark:8000`
  - official max context window: `131072`
  - current launcher requested context window: `131072`
  - current effective runtime cap observed locally: about `40960`
  - guarded manual-restore large lane
  - latest local rc3 restore did come up at the higher request, but TRT clamped the actual runtime token budget lower on this hardware

Source notes:
- Qwen3-Coder-Next official card: coding agents, local development, tool use, long-horizon reasoning, CLI/IDE integration
  - https://huggingface.co/Qwen/Qwen3-Coder-Next
- Qwen3-Next-80B-A3B-Instruct official card: parameter-efficient general model, strong reasoning/coding/agent performance, ultra-long-context focus
  - https://huggingface.co/Qwen/Qwen3-Next-80B-A3B-Instruct
- DeepSeek-R1-Distill-Qwen-32B official card: distilled reasoning model with strong math/code/reasoning performance
  - https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-32B
- Qwen3-32B-NVFP4 evaluation card used for the mini TRT characterization
  - https://huggingface.co/RedHatAI/Qwen3-32B-NVFP4
- NVIDIA Qwen3-30B-A3B-NVFP4 card used for the mini TRT general-use characterization
  - https://huggingface.co/nvidia/Qwen3-30B-A3B-NVFP4

## Bonzai

`POST /bonzai`

Purpose:
- force-reset into large-mode
- clear any mini or fleet state first
- bring up `gguf_coder_next_large` on `:8000`

This is the safe “reset me to a working coding model” path.

Single-box TRT Qwen3 30B/32B profiles are mini-only now:
- they live on `:7999`
- if you want two minis, use `fleet up`

Context note:
- "official max context window" comes from the model card or official local serving guidance
- "current launcher context window" is what the current `LLMCommune` scripts are configured to serve today
- for the single-box Qwen3 Next and Coder Next models, the official cards explicitly warn that `256K` may fail to start and recommend reducing to values like `32768` when memory is tight

Manual-only restore:
- `nvidia/Qwen3-235B-A22B-NVFP4`
  - active in the controller as `trt_dual_qwen235_large`
  - not CLI-selectable by default
  - use the exact rc3 restore path only
  - latest local higher-context test requested `131072` and still loaded, but the effective TRT cap settled near `40960`
