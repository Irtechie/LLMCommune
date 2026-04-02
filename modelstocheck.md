# Models To Check

This report is the current reality check for `LLMCommune` on the dual GX10 pair:

- `spark-f147` / `192.168.1.203`
- `gx10-b041` / `192.168.1.204`
- direct CX7 link: `169.254.10.1 <-> 169.254.10.2`

The goal is not to list every interesting model on the internet. The goal is to separate:

- what is officially supported
- what the DGX Spark community has actually made work on two boxes
- what we have already proven locally
- what should stay download-only or parked until the stack gets less brittle

## Executive Summary

The pair is not a coffee coaster. The recent bring-up pain came from stack drift and lane drift:

- `Qwen3-235B-A22B` was proven locally on `:8000`, but later large-lane work drifted away from the known-good recipe.
- `GPT-OSS-120B` broke only when its launcher fell back to the wrong TRT image; it came back immediately on the right one.
- `Llama-3.3-70B-Instruct-FP4` was hanging because `LLMCommune` was not matching Alpha's known-good socket-mode settings.
- some recent NVFP4 / MoE experiments are colliding with current SM121 kernel instability that the community is openly discussing.

The correct posture today is:

1. keep the proven lanes narrow
2. restore known-good recipes exactly
3. do not promote >`235B-A22B` or clearly unstable paths into active controller profiles
4. use `download-only` or `parked` status for oversized or still-fragile research models

## Local Inventory Snapshot

Installed or partially cached local families that matter for this report:

- `nvidia/Qwen3-235B-A22B-NVFP4`
- `openai/gpt-oss-120b`
- `nvidia/Llama-3.3-70B-Instruct-FP4`
- `nvidia/Qwen3-30B-A3B-NVFP4`
- `nvidia/Qwen3-32B-NVFP4`
- `qwen/Qwen3-Next-80B-A3B-Instruct-Q4_K_M`
- `other/Qwen3-Coder-Next-Q4_K_M`
- `qwen/Qwen2.5-Coder-32B-Instruct-AWQ`
- `deepseek/DeepSeek-V2.5-1210-AWQ`
- `mistral/*AWQ/FP8`
- partial Hugging Face cache for `nvidia/DeepSeek-V3.2-NVFP4`

## What We Have Already Proven On This Pair

### 1. `openai/gpt-oss-120b`

Status:
- locally proven on both boxes
- serves through `spark:8000`
- runtime family: `trtllm`

Known-good local recipe:
- model: `openai/gpt-oss-120b`
- container: `nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6`
- topology: dual box
- transport mode: socket fallback on the CX7 link
  - `NCCL_IB_DISABLE=1`
  - `UCX_NET_DEVICES=enp1s0f0np0`
- launcher context: `131072`

Local evidence:
- [startup-state-8000.json](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/gpt_oss/startup-state-8000.json)
  - `ready_at`: `2026-04-01T23:36:40-04:00`
  - `startup_duration_s`: `510.0`
- direct live test from April 2, 2026:
  - `:8000/v1/models` returned `hf-8b193b0-nim`
  - `:8000/v1/chat/completions` averaged about `25.7` completion tok/s across three 128-token runs

Verdict:
- keep active
- this is a real dual-box production lane for now

### 2. `nvidia/Llama-3.3-70B-Instruct-FP4`

Status:
- locally proven on both boxes
- serves through `spark:8000`
- runtime family: `trtllm`

Known-good local recipe:
- model: `nvidia/Llama-3.3-70B-Instruct-FP4`
- container: `nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6`
- topology: dual box
- transport mode: socket fallback on the CX7 link
  - `NCCL_IB_DISABLE=1`
- currently proven local launcher cap: `2048`

Local evidence:
- [startup-state-8000.json](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/llama33_70b/startup-state-8000.json)
  - `ready_at`: `2026-04-02T01:58:32-04:00`
  - `startup_duration_s`: `112.0`
- direct live test from April 2, 2026:
  - `:8000/v1/chat/completions` worked
  - measured about `3.54` completion tok/s average over three 128-token runs

Important nuance:
- official model context is much larger than the current launcher cap
- what is proven locally is the current stable bring-up recipe, not the theoretical max

Verdict:
- keep active
- but do not treat current context tuning as final

### 3. `nvidia/Qwen3-235B-A22B-NVFP4`

Status:
- locally proven on both boxes
- was reachable on `:8000`
- runtime family: `trtllm`
- currently removed from the active controller list after a later destabilizing run

Known-good local recipe:
- model: `nvidia/Qwen3-235B-A22B-NVFP4`
- container: `nvcr.io/nvidia/tensorrt-llm/release:1.0.0rc3`
- topology: dual box
- local proven launcher context: `32768`

Local evidence:
- [startup-state-8000.json](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/qwen235/startup-state-8000.json)
  - `ready_at`: `2026-04-01T21:56:35-04:00`
  - `startup_duration_s`: `33.0`

Important nuance:
- the controller/launcher port drift later moved this lane off the large-lane contract and then back again
- one later corrected `:8000` attempt destabilized the machine badly enough that it was removed from active profiles
- that does not erase the earlier successful local proof; it means the current lane recipe drifted away from the known-good one

Verdict:
- do not call it dead
- do not leave it active by default
- restore it only as a guarded manual lane on the exact known-good recipe

### 4. `nvidia/Qwen3-30B-A3B-NVFP4`

Status:
- locally proven on one box
- runtime family: `trtllm`
- mini-lane capable

Known-good local recipe:
- container: `nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6`
- topology: single box
- current launcher asks `32768`
- TRT inferred `40960` and then reduced the window to `32800`

Local evidence:
- [slot.json](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/qwen3_30b_a3b_nvfp4/slot.json)
- [serve-7999.log](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/qwen3_30b_a3b_nvfp4/serve-7999.log)
  - model came up
  - API responded on `:7999`
  - TRT log adjusted `max_seq_len` to `32800`

Verdict:
- active mini-lane candidate
- current limitations are configuration/runtime issues, not raw VRAM shortage

## What Official NVIDIA / Upstream Support Says

### TensorRT-LLM Supported / Relevant Families

The current TensorRT-LLM model support pages show support for the families that matter here:

- `GPT-OSS`
- `Llama 3.3`
- `Qwen3`
- `Qwen3.5-MoE`
- `DeepSeek-V3.2`

That means "unsupported" is not the current problem for the broad families. The real problems are:

- which exact quantized checkpoint is public
- which image tag is actually stable on SM121 / DGX Spark
- whether the current kernel path is mature enough on two GX10 boxes

### DeepSeek-V3.2-NVFP4

Official TensorRT-LLM support for `DeepSeek-V3.2` is real, and NVIDIA has a blog about optimizing it on Blackwell GPUs. But the same blog explicitly says the `nvidia/DeepSeek-V3.2-NVFP4` checkpoint is not yet published on Hugging Face and tells readers to stay tuned or quantize it themselves.

Practical meaning for this pair:
- the runtime path is real
- the public artifact path is not clean enough yet
- keep it `download-only / parked`

### Qwen3.5-397B-A17B Int4

Official support signals exist:

- TensorRT-LLM support pages list the family
- vLLM has current Qwen 3.5 usage guidance

But the actual dual-Spark evidence is still community-heavy, and the DGX Spark forum threads around this model are full of patching, build drift, and node-specific shutdown concerns.

Practical meaning for this pair:
- dual box only
- research-only
- do not promote into the active controller list yet

## Community-Proven On Dual DGX Spark / GB10

This section is not "official NVIDIA support." It is what the DGX Spark community is actually getting to work on two boxes.

### `Qwen3-235B-A22B` on two Sparks

Strong community evidence exists for two-box viability:

- `QuantTrio/Qwen3-VL-235B-A22B-Instruct-AWQ` via `vLLM` is repeatedly reported around `25-26 tok/s`
- `RedHatAI/Qwen3-VL-235B-A22B-Instruct-NVFP4` is reported around `21 tok/s`
- multiple forum posts say AWQ is currently faster than NVFP4 on DGX Spark

Practical meaning:
- if the goal is "best current two-box Qwen235 experience," AWQ on `vLLM` is a serious path
- if the goal is "keep using official NVIDIA NVFP4 artifacts," TRT/NVFP4 remains viable but less forgiving

### `GPT-OSS-120B` on two Sparks

Community evidence also exists for `GPT-OSS-120B` on dual Sparks with `vLLM` and community Spark Docker flows. Official TRT support is also current.

Practical meaning:
- both TRT and vLLM are real paths
- on this pair, the locally proven TRT path is already good enough to keep

### `Qwen3.5-397B-A17B Int4` on two Sparks

Community evidence says it can run on a Spark duo with `vLLM`, but the same threads also document:

- patching
- crashes / shutdowns on some units
- build drift
- new regressions even after prior success

Practical meaning:
- download-only / research-only
- not an active lane

## Valid NVIDIA Containers And Community Containers

### Official NVIDIA containers worth pinning

#### `nvcr.io/nvidia/tensorrt-llm/release:1.0.0rc3`

Use for:
- restoring `Qwen3-235B-A22B-NVFP4` on this pair

Why:
- locally proven on `:8000`
- also cited in DGX Spark forum testing for Qwen235 two-node work

#### `nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6`

Use for:
- `GPT-OSS-120B`
- `Llama-3.3-70B-Instruct-FP4`
- current single-box `Qwen3-30B-A3B-NVFP4`
- current single-box `Qwen3-32B-NVFP4`

Why:
- locally proven for these lanes
- fixes the GPT-OSS `mxfp4` failure that appeared when the launcher drifted down to `1.0.0rc3`

#### `nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc5`

Status:
- community-tested on Spark for Qwen235
- not my first restore choice here

Why not first:
- forum reports mention Triton-on-platform fallback warnings and confusing diagnostics
- our pair already has a cleaner known-good local proof on `1.0.0rc3` for Qwen235

### Official NVIDIA vLLM container

Community guidance on the NVIDIA forum points to:

- NVIDIA `25.11-py3` for vLLM on Spark

Use for:
- AWQ / vLLM Qwen235 experiments
- current dual-Spark vLLM work when you want official NVIDIA packaging instead of raw upstream or custom builds

### Community container / build path

Community guidance repeatedly points to:

- `eugr/spark-vllm-docker`

Use for:
- dual-Spark vLLM setups when the current official container lags needed features or fixes

Status:
- useful
- not official
- should stay labeled community in our docs and config

## Where We Actually Drifted

This is where the recent bring-up work went wrong:

### 1. Lane contract drift

`Qwen3-235B-A22B` was allowed to serve on `8356` while the controller contract expected `8000`.

Result:
- the model looked dead to the controller even when TRT was live

### 2. Container drift

`GPT-OSS-120B` got pulled onto `1.0.0rc3`, which does not accept its `mxfp4` quantization path.

Result:
- hard failure on a model that had already been working locally

### 3. Transport drift

Large dual-box TRT lanes that were happier in socket mode were allowed to drift back toward IB/RDMA behavior.

Result:
- worker-side UCX / GID churn
- long stalls during startup

### 4. Research lanes promoted too early

`Qwen3.5-397B-A17B`, `DeepSeek-V3.2`, and other post-235B tracks were getting too much attention before the known-good `Qwen235` / `GPT-OSS` / `Llama3.3` baselines were locked down.

Result:
- it felt like everything was broken, even though several proven paths were already there

### 5. Current NVFP4 / SM121 fragility is real

The recent DGX Spark forum PSA on NVFP4 in `vLLM` matches what we saw locally: broken or fragile CUTLASS paths on SM121 are still a real thing.

Result:
- some failures are not operator error; the stack is still moving underneath us

## Recommended Classification For LLMCommune

### Keep active

- `openai/gpt-oss-120b`
  - dual box
  - TRT `1.2.0rc6`
  - `:8000`
- `nvidia/Llama-3.3-70B-Instruct-FP4`
  - dual box
  - TRT `1.2.0rc6`
  - `:8000`
- `nvidia/Qwen3-30B-A3B-NVFP4`
  - single box
  - TRT `1.2.0rc6`
  - `:7999`
- `nvidia/Qwen3-32B-NVFP4`
  - single box
  - TRT `1.2.0rc6`
  - `:7999`
- `Qwen3-Coder-Next-Q4_K_M`
  - single box
  - `llama.cpp`
  - `:8000`
- `Qwen3-Next-80B-A3B-Instruct-Q4_K_M`
  - single box
  - `llama.cpp`
  - `:8000`

### Manual restore only

- `nvidia/Qwen3-235B-A22B-NVFP4`
  - keep inventory-visible
  - restore only on the exact proven `1.0.0rc3` / `:8000` / `32768` recipe
  - do not leave it in the default large-lane rotation yet

### Worth evaluating after the above is stable

- `QuantTrio/Qwen3-VL-235B-A22B-Instruct-AWQ`
  - dual box
  - `vLLM`
  - likely best current two-Spark Qwen235 experience if the goal is speed

### Download-only / parked for now

- `Qwen/Qwen3.5-397B-A17B-GPTQ-Int4`
- `nvidia/DeepSeek-V3.2-NVFP4`
- `lukealonso/GLM-5-NVFP4`
- `nvidia/Kimi-K2.5-NVFP4`

Reason:
- either over the `235B-A22B` comfort threshold for this controller
- or still too unstable / artifact-incomplete for promotion

## Recommended Starting Context Targets

These are not "absolute model maxima." They are the recommended starting points for this pair today.

| Model | Topology | Runtime | Official headline context | Recommended starting context here | Notes |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-oss-120b` | dual | TRT | `128K` | `131072` | locally proven |
| `nvidia/Llama-3.3-70B-Instruct-FP4` | dual | TRT | `128K` | `2048` for current stable lane | needs later tuning upward |
| `nvidia/Qwen3-235B-A22B-NVFP4` | dual | TRT | `128K` | `32768` | exact local proof exists |
| `QuantTrio/...Qwen3-VL-235B-A22B-Instruct-AWQ` | dual | vLLM | model-dependent | start `32768` | raise only after stability proof |
| `nvidia/Qwen3-30B-A3B-NVFP4` | single | TRT | `131K` | `32768` | TRT currently adjusts to about `32800` |
| `nvidia/Qwen3-32B-NVFP4` | single | TRT | `32768` native / `131072` with YaRN | `32768` | do not assume YaRN until proven locally |
| `Qwen/Qwen3.5-397B-A17B-GPTQ-Int4` | dual | vLLM | `256K` in community reports | do not promote yet | research-only |

## Fit Math For The Big Research Candidates

This pair has about `121.63 GiB` device memory per box in the live TRT logs, or about `243.26 GiB` total across both boxes.

For rough first-pass feasibility, the important number is still total weight storage, not active parameters. MoE active parameters mostly affect compute cost and some runtime behavior, but the full expert weights still have to live somewhere.

Very rough raw weight math at 4-bit:

- `236B` total params
  - raw 4-bit weights: about `118 GB` or `109.9 GiB`
- `235B` total params
  - raw 4-bit weights: about `117.5 GB` or `109.4 GiB`
- `397B` total params
  - raw 4-bit weights: about `198.5 GB` or `184.9 GiB`
- `685B` total params
  - raw 4-bit weights: about `342.5 GB` or `319.0 GiB`
- `1T` total params
  - raw 4-bit weights: about `500 GB` or `465.7 GiB`

That raw math is optimistic because it does not include:

- quantization metadata / group scales / zeros
- runtime workspaces
- KV cache
- activations
- framework overhead

### `LGAI-EXAONE/K-EXAONE-236B-A23B`

Published size:
- `236B` total
- `23B` active

Math:
- almost the same total-parameter class as `Qwen3-235B-A22B`
- raw 4-bit weight math is essentially in the same bucket as the Qwen235 lane we already proved

Verdict:
- yes, this is mathematically plausible on two GX10 boxes
- your instinct is good here
- policy-wise it still stays `download-only` until there is a real serve recipe we trust

### `Qwen/Qwen3.5-397B-A17B-GPTQ-Int4`

Published size:
- `397B` total
- `17B` active

Math:
- raw 4-bit weights are about `184.9 GiB`
- that is under the pair's `243.26 GiB` total device memory
- but it leaves much less headroom than the `235B`/`236B` class once you add cache and runtime overhead

Verdict:
- not fantasy
- not comfortable
- mathematically plausible on two boxes, which matches the community dual-Spark reports
- still too brittle to promote today

### `DeepSeek-V3.2`

Published size:
- roughly `685B` total
- `37B` active

Math:
- raw 4-bit weights are about `319.0 GiB`
- that already exceeds the pair's total device memory before runtime overhead

Verdict:
- no, not as a normal two-box fit on this pair
- this is not a "we tuned it wrong" issue; the published model class is simply too large here without a different compression or serving strategy

### `Kimi-K2.5`

Published size:
- `1T` total
- `32B` active

Math:
- raw 4-bit weights are about `465.7 GiB`
- far beyond the pair's total device memory

Verdict:
- no, not a two-box fit here

## Revised Short Read

Among the current big research candidates:

- `K-EXAONE-236B-A23B`
  - yes, likely fit on two GX10s
- `Qwen3.5-397B-A17B-GPTQ-Int4`
  - maybe, mathematically plausible but tight and fragile
- `DeepSeek-V3.2`
  - no, too large for two GX10s at published size
- `Kimi-K2.5`
  - no, too large for two GX10s at published size

## References

Official:
- TensorRT-LLM supported models
  - https://nvidia.github.io/TensorRT-LLM/latest/models/supported-models.html
- TensorRT-LLM GPT-OSS quick start / deployment guidance
  - https://nvidia.github.io/TensorRT-LLM/latest/deployment-guide/quick-start-recipe-for-gpt-oss-on-trtllm.html
- TensorRT-LLM DeepSeek-V3.2 Blackwell blog
  - https://nvidia.github.io/TensorRT-LLM/1.2.0rc8/blogs/tech_blog/blog15_Optimizing_DeepSeek_V32_on_NVIDIA_Blackwell_GPUs.html
- vLLM docs: disaggregated serving / NIXL / Qwen 3.5 usage guidance
  - https://docs.vllm.ai/

Community / DGX Spark forum:
- Qwen3 235B on 2x DGX Spark performance thread
  - https://forums.developer.nvidia.com/t/question-on-inference-performance-results-of-qwen3-235b-a22b-on-2x-dgx-spark/355053
- PSA: FP4 / NVFP4 support state in vLLM on DGX Spark
  - https://forums.developer.nvidia.com/t/psa-state-of-fp4-nvfp4-support-for-dgx-spark-in-vllm/353069
- Qwen3 235B NVFP4 playbook hangs
  - https://forums.developer.nvidia.com/t/qwen3-235b-a22b-nvfp4-playbook-example-hangs/358610
- Can Qwen3 235B FP4 fit into a single Spark?
  - https://forums.developer.nvidia.com/t/can-qwen3-235b-fp4-fit-into-single-spark/359611
- Qwen3.5-397B-A17B run in dual spark, with concerns
  - https://forums.developer.nvidia.com/t/qwen3-5-397b-a17b-run-in-dual-spark-but-i-have-a-concern/361967
- Qwen3.5-397B-A17B + DGX Spark duo
  - https://forums.developer.nvidia.com/t/qwen3-5-397b-a17b-dgx-spark-duo/360780
- vLLM compatibility problem with GPT-OSS-120B on Spark
  - https://forums.developer.nvidia.com/t/vllm-compatibility-problem-with-gpt-oss-120b-and-openclaw-by-spark-vllm-docker/360299
- TensorRT-LLM + Llama 3.3 70B at about 5 tok/s on Spark
  - https://forums.developer.nvidia.com/t/tensorrt-llm-nvidia-llama-3-3-70b-instruct-nvfp4-5-tok-s/357791

Local proof files:
- [Qwen235 startup proof](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/qwen235/startup-state-8000.json)
- [GPT-OSS startup proof](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/gpt_oss/startup-state-8000.json)
- [Llama 3.3 startup proof](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/llama33_70b/startup-state-8000.json)
- [Qwen3 30B mini lane slot](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/qwen3_30b_a3b_nvfp4/slot.json)
- [Qwen3 30B mini lane serve log](/home/admin/apps/LLMCommune/workspace/jobs/_lanes/qwen3_30b_a3b_nvfp4/serve-7999.log)
