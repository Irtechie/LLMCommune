# LLMCommune Models

`LLMCommune` is the minimal two-lane controller for the GX10 pair.

Source of truth:
- static registry: [`src/config/models.json`](/home/admin/apps/LLMCommune/src/config/models.json)
- live current state: `GET /api/llm-host/current`
- live profile and inventory view: `GET /api/llm-host/models`

Use the live JSON for runtime truth. Use `models.json` for the curated static contract: lanes, profiles, runtime families, parameter class, hosts, launch policy, and default wait times.

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
  - may host large or mini profiles
  - one active profile at a time
- Mini lane:
  - port `7999`
  - mini profiles only
  - one active profile at a time
- Max active total:
  - two
- Forbidden class:
  - never two large profiles at once
- Dual-box large profiles:
  - reserve both boxes
  - still serve through `spark:8000`

## API

- `GET /health`
- `GET /api/llm-host/help`
- `GET /api/llm-host/current`
- `GET /api/llm-host/models`
- `POST /api/llm-host/activate`
- `GET /api/llm-host/jobs/:job_id`
- `POST /api/llm-host/actions/restart`
- `POST /api/llm-host/actions/stop`
- `POST /bonzai`

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

## Current Intended Profiles

Large lane:
- `gguf_coder_next_large`
- `gguf_qwen3_next_80b_large`
- `trt_single_qwen3_30b_a3b_large`
- `trt_single_qwen3_32b_large`
- `trt_dual_qwen235_large`
- `trt_dual_gpt_oss_120b_large`
- `trt_dual_llama33_70b_large`

Mini lane:
- `gguf_deepseek_32b_mini`

`gguf_deepseek_32b_mini` is currently marked `alpha_reserved` in the config, so other apps can see it but should not treat it as the default CLI choice.

## Bonzai

`POST /bonzai`

Purpose:
- force-stop both lanes
- bring up `gguf_coder_next_large` on `:8000`

This is the safe “reset me to a working coding model” path.

## Temporary Extraction Note

`LLMCommune` is already a standalone controller app, but some TRT launcher scripts still delegate to the existing Alpha shell launchers. That means:
- `LLMCommune` does not require the Alpha web app to be running
- but a few launch commands still reuse Alpha’s proven TRT shell scripts during this extraction phase

That is intentional for now. The JSON contract and controller live here; the remaining launcher internals can be replaced later.
