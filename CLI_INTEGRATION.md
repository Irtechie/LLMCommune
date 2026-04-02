# CLI Integration

This file is the human-oriented integration guide for any CLI that wants to use `LLMCommune`.

Use the live controller JSON as the runtime truth:
- `GET /api/llm-host/help`
- `GET /api/llm-host/current`
- `GET /api/llm-host/models`

Use [`models.json`](/home/admin/apps/LLMCommune/src/config/models.json) as the static contract for:
- hosts
- lanes
- profiles
- runtime families
- size classes
- default wait guidance

## Ports

- controller:
  - `:4000`
- large lane:
  - `:8000`
- mini lane:
  - `:7999`

## Lane Rules

- large lane may run large or mini profiles
- mini lane may run mini profiles only
- never more than two active profiles total
- never two large profiles at once
- dual-box large profiles reserve both boxes but still serve through `spark:8000`

## Required CLI Flow

1. `GET /api/llm-host/help`
2. `GET /api/llm-host/models`
3. choose a `profile_id`
4. `POST /api/llm-host/activate`
5. poll `GET /api/llm-host/jobs/:job_id`
6. use the returned adapter metadata

If the requested profile is already up, activation should return ready without restarting it.

## Control Requests

### Help

```http
GET /api/llm-host/help
```

Use this to learn:
- lane policy
- supported runtime adapters
- activation shape
- restart/stop shape
- bonzai behavior

### Current

```http
GET /api/llm-host/current
```

Use this to learn:
- which profile is active on each lane
- which host owns the lane
- how to call the active model
- which profile the CLI should treat as the current target

### Model List

```http
GET /api/llm-host/models
```

Use this to learn:
- every profile `LLMCommune` knows
- `size_class`
- `runtime_family`
- `allowed_lanes`
- `launchable_now`
- `blocked_by`
- `would_preempt`
- `health_endpoints`
- `startup_expectation`

### Activate

```http
POST /api/llm-host/activate
Content-Type: application/json

{
  "profile_id": "gguf_coder_next_large",
  "lane_id": "large",
  "wait": false,
  "allow_preempt": true
}
```

Response:
- immediate job envelope if async
- ready result if the requested profile is already active

### Restart

```http
POST /api/llm-host/actions/restart
Content-Type: application/json

{
  "lane_id": "large"
}
```

### Stop

```http
POST /api/llm-host/actions/stop
Content-Type: application/json

{
  "lane_id": "mini"
}
```

Allowed `lane_id` values:
- `large`
- `mini`
- `all`

Mini-first TRT profiles:
- `trt_single_qwen3_30b_a3b_mini`
- `trt_single_qwen3_32b_mini`
- they default to `lane_id=mini`
- they may still be placed on `large` explicitly if needed

### Bonzai

```http
POST /bonzai
```

Meaning:
- stop the large lane
- keep the mini lane untouched
- launch `gguf_coder_next_large` on `:8000`

## How To Infer Each Runtime

Do not guess from model names. Use the returned `adapter`.

### OpenAI-compatible runtimes

Runtime families:
- `trtllm`
- `vllm`
- `litellm`
- `llama.cpp` in this setup also exposes OpenAI-style endpoints

Use:
- `adapter.base_url`
- `adapter.models_url`
- `adapter.chat_url`
- `adapter.completions_url`
- `adapter.model_field`

Typical chat request:

```json
{
  "model": "<model id from current/models>",
  "messages": [
    {"role": "user", "content": "hello"}
  ],
  "stream": false
}
```

### Ollama-native runtimes

If a future profile reports:
- `runtime = ollama`
- `protocol = ollama_chat`

Use:
- `adapter.models_url`
- `adapter.chat_url`
- `adapter.completions_url`

## Health And Wait Guidance

Always respect:
- `startup_expectation.warm_switch_s`
- `startup_expectation.cold_start_s`
- `startup_expectation.ready_timeout_s`

Health checks:
- prefer `adapter.models_url`
- fall back to `adapter.health_url`

Treat a lane as ready when:
- the models endpoint responds
- and the activation job reaches `status=ready`

## Host Awareness

The CLI should read host information from:
- `current.hosts`
- `current.lanes`
- `models.hosts`

Do not assume:
- `spark` means different hardware
- `gx10` means a weaker path

Both are GX10 boxes. The main difference is role:
- `spark` = head/controller/default public serve host
- `gx10` = worker/backend/peer
