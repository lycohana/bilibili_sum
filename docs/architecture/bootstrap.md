# Bootstrap Notes

The repository now starts with a Python-first scaffold for the new architecture.

## Implemented in this step

- Root workspace config
- `packages/core`
- `packages/infra`
- `apps/service`
- Basic domain task models
- Basic FastAPI health endpoints
- Minimal task create/list/detail API
- SQLite-backed task repository bootstrap
- Minimal task results and task events persistence
- Minimal background worker bootstrap

## Immediate next build targets

1. Add explicit queue state and cancellation support
2. Add event streaming API or SSE
3. Replace placeholder pipeline with real processing modules
4. Move old reusable helpers from the prototype into `packages/core`
