# FactoryPilot — Agent instructions

You are helping build **FactoryPilot**: AI-assisted S/4HANA Business Insights on SAP BTP.

## Source of truth

1. [docs/architecture/Architecture_Concept.md](docs/architecture/Architecture_Concept.md) — **hybrid target** (build this)  
2. [docs/architecture/Four_Week_Delivery_Plan.md](docs/architecture/Four_Week_Delivery_Plan.md) — the original contract. **Read its status header first**: the runtime changed (ADR-023) and six days are marked SUPERSEDED. For what is actually built, read [README.md](README.md) and [CHANGELOG.md](CHANGELOG.md).  
3. [docs/architecture/Decisions_Log.md](docs/architecture/Decisions_Log.md) — ADRs  
4. [docs/architecture/Component_Contracts.md](docs/architecture/Component_Contracts.md) — API shapes  
5. [docs/api/hub/API_CATALOG.md](docs/api/hub/API_CATALOG.md) — Business Accelerator Hub APIs  

Requirements thick-CPI doc is **baseline only**, not the default build path unless the user asks.

## Architecture (locked)

- **One frontend:** Approuter shell — Insights (business) + Admin console (roles).  
- **One backend:** CAP. The agent loop runs as CAP custom handlers (ADR-023). There is no FastAPI service — do not add one.  
- **CPI:** iFlow endpoints are registered as data in IntegrationService. No LLM, quota, cache or intent logic in CPI.  
- **S/4 APIs:** from **SAP Business Accelerator Hub**; trial uses Hub **sandbox** + API Key.  
- **LLM:** `LLMProvider` adapter — OpenRouter and AI Core (config switch).  
- **No RAG / no MCP** in this CAP implementation (ADR-025). AG-UI deferred.  
- **DB/cache:** Postgres + Redis per env (HANA adapter still open).
- **Seven CAP services:** Config, Token, Admin, Audit, Cache, Integration, Insights — each separately scoped.  

## Coding rules

- Conventional commits: `feat:`, `fix:`, `chore:`, `ci:`, `docs:`.  
- Never commit secrets, Hub API keys, or `.env`.  
- Prefer small PRs aligned to day branches `feature/NNN-...`.  
- Update `CHANGELOG.md` [Unreleased] when adding user-visible or structural changes.  
- Business Object metadata must match Hub EDMX (service path, entity set).  

## Specialist roles (subagents)

| Role | Use when | Scope |
| --- | --- | --- |
| CAP Admin | CDS, Fiori, XSUAA, seeds | `apps/admin-cap/**` |
| Orchestrator | FastAPI, LangGraph, Redis, LLM, Hub client | `services/orchestrator/**` |
| CPI | An endpoint kind, implemented in `apps/cap/srv/lib/backend.js` (CpiBackend) |
| Infra | Terraform, CF/Kyma deploy, scripts | `infra/**`, `deploy/**`, `.github/workflows/**` |
| Hub APIs | Catalog, EDMX, Destination docs | `docs/api/hub/**` |

Do not mix thick-CPI orchestration into the hybrid codepaths.
