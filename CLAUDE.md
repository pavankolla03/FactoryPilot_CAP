# Claude Code — FactoryPilot

Read and follow **[AGENTS.md](AGENTS.md)** for project rules.

## Priority docs

- `docs/architecture/Architecture_Concept.md` (hybrid build target)
- `docs/architecture/Four_Week_Delivery_Plan.md` (the original contract — read its status header first; several days are superseded and its checkboxes are not a progress measure)
- `docs/api/hub/API_CATALOG.md` (Business Accelerator Hub)

## Defaults

- Prefer hybrid architecture (CAP + FastAPI/LangGraph + thin CPI).
- S/4 via Hub APIs / Destination — do not invent service paths.
- Update `CHANGELOG.md` when making structural changes.
- Do not commit secrets.

When the user names a plan day (e.g. Day 1), read that day's checklists — but check the status header and any SUPERSEDED marker first, and say so rather than rebuilding something that was deliberately removed.
