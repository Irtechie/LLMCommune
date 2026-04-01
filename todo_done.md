# TODO Done

Historical completion ledger for `LLMCommune`.

Move completed or superseded work here when [todo.md](/home/admin/apps/LLMCommune/todo.md) starts getting noisy.

## Completed
- [x] ~~Create standalone `LLMCommune` controller app with minimal dependency-free Node runtime.~~
  - Validation: `node --check` passed for [index.js](/home/admin/apps/LLMCommune/src/index.js) and [runtime.js](/home/admin/apps/LLMCommune/src/runtime.js)

- [x] ~~Add static model/host/lane source of truth in `models.json`.~~
  - Validation: [models.json](/home/admin/apps/LLMCommune/src/config/models.json) now defines controller, hosts, lanes, profiles, and inventory models.

- [x] ~~Add human/app handoff doc in `models.md`.~~
  - Validation: [models.md](/home/admin/apps/LLMCommune/models.md) describes the API, lane rules, and consumption pattern for other apps.

- [x] ~~Add controller routes for help/current/models/activate/jobs/restart/stop/bonzai.~~
  - Validation: live smoke on temporary `:4100` succeeded for `/health`, `/api/llm-host/help`, `/api/llm-host/current`, `/api/llm-host/models`, and `/api/llm-host/snapshot`.

- [x] ~~Ignore libraries, build output, venvs, and workspace artifacts in Git.~~
  - Validation: [`.gitignore`](/home/admin/apps/LLMCommune/.gitignore) ignores `node_modules`, venvs, `site-packages`, `vendor`, `build`, `dist`, and `workspace/`.
