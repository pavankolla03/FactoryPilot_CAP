# Claude Code — FactoryPilot

Read and follow **[AGENTS.md](AGENTS.md)** for project rules.

## Priority docs

- `docs/architecture/Architecture_Concept.md` (hybrid build target)
- `docs/architecture/Four_Week_Delivery_Plan.md` (current day)
- `docs/api/hub/API_CATALOG.md` (Business Accelerator Hub)

## Defaults

- Prefer hybrid architecture (CAP + FastAPI/LangGraph + thin CPI).
- S/4 via Hub APIs / Destination — do not invent service paths.
- Update `CHANGELOG.md` when making structural changes.
- Do not commit secrets.

When the user names a plan day (e.g. Day 1), execute that day's AM/PM checklists from the Four-Week plan.
