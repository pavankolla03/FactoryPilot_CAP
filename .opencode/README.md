# OpenCode — FactoryPilot

OpenCode should load project instructions from:

1. Root [AGENTS.md](../AGENTS.md)
2. [Architecture_Concept.md](../docs/architecture/Architecture_Concept.md)
3. [API_CATALOG.md](../docs/api/hub/API_CATALOG.md)

Config: [opencode.json](./opencode.json)

## Agents (logical)

Same specialist split as Cursor/Copilot:

- CAP Admin — `apps/admin-cap`
- Orchestrator — `services/orchestrator`
- CPI Thin — `integration/cpi`
- Infra — `infra`, `deploy`, workflows
- Hub APIs — `docs/api/hub`

Build hybrid only unless asked for thick-CPI baseline.
