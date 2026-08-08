# FactoryPilot — GitHub Copilot instructions

Follow [AGENTS.md](../AGENTS.md) and `docs/architecture/Architecture_Concept.md`.

## Build target

Hybrid: CAP admin + FastAPI/LangGraph + thin CPI. S/4 APIs from SAP Business Accelerator Hub.

## Do not

- Implement thick CPI orchestration (LLM/rate limit/cache inside iFlow) unless explicitly requested.
- Commit secrets or Hub API keys.
- Add RAG/MCP to the product runtime.
- Invent OData service paths — use Hub EDMX / `docs/api/hub/API_CATALOG.md`.

## Do

- Prefer adapters for LLM and DB.
- Update CHANGELOG [Unreleased] for structural changes.
- Keep PRs aligned to `feature/NNN-*` day branches.
