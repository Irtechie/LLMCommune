# LLMCommune Agent Notes

## Source Of Truth

For `LLMCommune`, the static source of truth is:
- [`src/config/models.json`](/home/admin/apps/LLMCommune/src/config/models.json)

The live runtime source of truth is:
- `GET /api/llm-host/current`
- `GET /api/llm-host/models`
- `GET /api/llm-host/help`

If docs and live JSON disagree, trust the live JSON first and update the docs.

## Lane Policy

- large lane:
  - `:8000`
  - may host large or mini profiles
- mini lane:
  - `:7999`
  - mini profiles only
- maximum active total:
  - two
- forbidden:
  - never two large profiles at once

## CLI Mode

The control plane is `:4000`.

The expected CLI flow is:
1. read `GET /api/llm-host/help`
2. read `GET /api/llm-host/models`
3. pick a `profile_id`
4. call `POST /api/llm-host/activate`
5. poll `GET /api/llm-host/jobs/:job_id`
6. consume the returned adapter metadata instead of guessing the protocol

## Extraction Rule

`LLMCommune` should stay minimal and host-focused.

Do not pull game-building concerns into this repo.
If a launcher/runtime helper is still temporarily delegated to Alpha, keep that explicit in docs and avoid pretending the extraction is already complete.
