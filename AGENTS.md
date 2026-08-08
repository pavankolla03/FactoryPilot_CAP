# FactoryPilot — Agent instructions

You are helping build **FactoryPilot**: AI-assisted S/4HANA Business Insights on SAP BTP.

## Source of truth

1. [docs/architecture/Architecture_Concept.md](docs/architecture/Architecture_Concept.md) — **hybrid target** (build this)  
2. [docs/architecture/Four_Week_Delivery_Plan.md](docs/architecture/Four_Week_Delivery_Plan.md) — day plan  
3. [docs/architecture/Decisions_Log.md](docs/architecture/Decisions_Log.md) — ADRs  
4. [docs/architecture/Component_Contracts.md](docs/architecture/Component_Contracts.md) — API shapes  
5. [docs/api/hub/API_CATALOG.md](docs/api/hub/API_CATALOG.md) — Business Accelerator Hub APIs  

Requirements thick-CPI doc is **baseline only**, not the default build path unless the user asks.

## Architecture (locked)

- **One frontend:** Approuter shell — Insights (business) + Admin console (roles).  
- **Two backends:** CAP (admin/config/dashboard) + FastAPI/LangGraph (orchestration).  
- **CPI:** thin generic OData iFlow only — no LLM, rate limit, cache, or intent in CPI.  
- **S/4 APIs:** from **SAP Business Accelerator Hub**; trial uses Hub **sandbox** + API Key.  
- **LLM:** `LLMProvider` adapter — OpenRouter and AI Core (config switch).  
- **No RAG / no MCP** in product runtime. AG-UI deferred.  
- **DB/cache:** Postgres + Redis per env (adapters for HANA later).  

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
| CPI | Thin iFlow only | `integration/cpi/**` |
| Infra | Terraform, CF/Kyma deploy, scripts | `infra/**`, `deploy/**`, `.github/workflows/**` |
| Hub APIs | Catalog, EDMX, Destination docs | `docs/api/hub/**` |

Do not mix thick-CPI orchestration into the hybrid codepaths.
