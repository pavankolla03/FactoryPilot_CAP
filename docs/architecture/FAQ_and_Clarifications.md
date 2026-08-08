# FAQ and Clarifications

**Status:** Living log of architecture Q&A from planning discussions  
**Parent:** [Architecture_Concept.md](./Architecture_Concept.md)  
**Decisions:** [Decisions_Log.md](./Decisions_Log.md)

This document records questions raised during design and the agreed answers, with pointers to the authoritative section or ADR.

---

## 1. Runtime shape (backends, front-end, CPI)

### Q: How many backends on CF / Kyma?

**A:** **Two** application backends (+ Approuter): **CAP** (admin/config/dashboard) and **FastAPI** (LangGraph orchestrator). Managed services (Postgres, Redis, XSUAA, Destination) are not counted as app backends.

→ [Architecture_Concept.md](./Architecture_Concept.md) §6

### Q: Where do S/4 OData APIs come from?

**A:** **SAP Business Accelerator Hub** ([api.sap.com](https://api.sap.com)) — standard APIs (Outbound Delivery first). Trial uses Hub **sandbox** + API Key Destination; clients later point the same `BusinessObjectConfig` service paths at their S/4. Hub setup is **Days 1–3 priority** in the 4-week plan.

→ [Four_Week_Delivery_Plan.md](./Four_Week_Delivery_Plan.md) §0; Architecture Concept §6.3

### Q: What logic is in Integration Suite?

**A (hybrid target):** **One thin generic iFlow** — dynamic S/4 OData only (destination, path, entity, filter, select). No intent, rate limit, cache, LLM, or OData catalog in CPI. Calls Hub sandbox or client S/4 via Destination.

**A (requirements baseline):** Thick iFlow owns the full pipeline — see [Requirements_Aligned_Thick_CPI_Architecture.md](./Requirements_Aligned_Thick_CPI_Architecture.md).

→ Hybrid: Architecture Concept §6.3; Baseline: Requirements-Aligned doc §9

### Q: One front-end or two?

**A:** **One** product frontend (Approuter shell). **Two role-based areas:** Insights (business users) and Admin console (Administrators). Admin configures **OData/BO registration, rate limiting, caching**, and sees the **dashboard**. Distinction is SSO scopes, not a second deployed UI.

→ Architecture Concept §3; ADR-015

### Q: Do we have CAP for OData registration? Is it reusable for other modules?

**A:** **Yes.** CAP `BusinessObjectConfig` is the registry (`moduleDomain` e.g. SCM, FIN, PM). SCM is the first content pack. New OData / modules = config rows; **same** FastAPI + **same** thin CPI. No new iFlow per service for standard OData.

→ Architecture Concept §§4–5; ADR-016

### Q: Can Joule / Joule Studio replace this?

**A:** **No** as a full replacement. Joule is an optional **channel** (skill calling our API later). It does not replace CAP registry, rate/cache admin, audit dashboard, or Terraform multi-client onboarding.

→ Architecture Concept §12; ADR-017

---

## 2. Rate limiting, data stores, onboarding

### Q: Can rate limiting be done at Integration Suite (APIM / proxy)? Why not only there?

**A:** **Yes, APIM can** do quota/spike arrest, but that is **not** the primary product control. Primary limits are **FastAPI + Redis** (per-user day/week/month, request or token, Admin-configured) because CPI/APIM does not see LLM tokens, cache hits, or CAP policies. APIM remains **optional defense-in-depth**.

→ Architecture Concept §9 (rate-limit layers); ADR-009

### Q: Do we provision Redis and Postgres as new instances on BTP?

**A:** **Yes.** Default: **new service instances per client environment** via Terraform; bind to CAP + FastAPI (Postgres) and FastAPI (Redis). Not assumed to pre-exist. Prefer isolation per env; “bring your own” only if explicitly agreed.

→ Client_Onboarding.md (Postgres/Redis section); ADR-006, ADR-007

### Q: Must we support CF and Kyma, OpenRouter and AI Core (etc.) from the start?

**A:** **Yes — production-close matrix.** Both runtimes and both LLM providers (and Postgres/HANA, Redis/HANA-table) are **first-class**, selected by config — not Phase-3 stubs. Prove on **one BTP trial**, then onboard clients with new tfvars.

→ Architecture Concept §10; ADR-005, ADR-012, ADR-018

---

## 3. LangGraph and LLM providers

### Q: How does LangGraph call OpenRouter or AI Core?

**A:** LangGraph runs the gated pipeline. Only the **`LlmContextualize`** node calls an **`LLMProvider` adapter**. Factory selects `OpenRouterLLMProvider` or `AICoreLLMProvider` from `llm_provider` config. Graph nodes never import vendor SDKs directly. Same `complete(messages, …)` interface for both.

```text
… → CallS4 → LlmContextualize → llm.complete() → CacheWrite → AuditLog
                      │
         ┌────────────┴────────────┐
         ▼                         ▼
   OpenRouter adapter        AI Core adapter
```

→ Architecture Concept §7 and §15 (LangGraph ↔ LLM); Component_Contracts.md §5; ADR-005, ADR-019

---

## 4. Schedule

### Q: Roughly how many days/weeks to complete?

**A (indicative, 1–2 experienced BTP+AI engineers):**

| Milestone | Calendar |
| --- | --- |
| Phase 1 repo skeleton | ~1–2 weeks |
| Phase 2 trial vertical slice (DELIVERY E2E) | ~4–7 weeks |
| Phase 3 harden + first client onboard | ~3–6 weeks |
| **Demo-ready on trial** | **~6–10 weeks** |
| **Production-close + first client** | **~3–4.5 months** |

Assumes trial access; S/4 real or mocked; no long entitlement blockers. Thick-CPI-only path is similar order of magnitude for CAP/IaC, different orchestration effort.

→ [MVP_Roadmap.md](./MVP_Roadmap.md) §Effort estimates  

**Fixed 4-week calendar:** use [Four_Week_Delivery_Plan.md](./Four_Week_Delivery_Plan.md) (daily features, GitHub branching, CI/CD, scoped trial release `v0.1.0-trial`).

---

## 5. AG-UI, RAG, MCP, and dev agents

### Q: Can we use AG-UI? Is it useful?

**A:** **Possible** for Insights chat (streaming, step timeline, React/CopilotKit-style). **Not required for MVP.** Admin Fiori Elements does not use AG-UI. Core delivery stays `POST /insights/query` JSON; AG-UI is an optional later channel on the same LangGraph.

→ Architecture Concept §16; ADR-020

### Q: Do we need RAG and MCP servers for this product?

**A:** **No for the designed runtime.** Answers come from **live S/4 OData** + LLM summary, not document retrieval (RAG). Runtime tools are **direct adapters** (LLM, CPI, Redis, DB), not MCP. MCP may optionally help **developers** in Cursor/Copilot; it is not part of the production Insights path.

→ Architecture Concept §17; ADR-021

### Q: Should we use agents / skills / instructions for development (like `.github/agents`)?

**A:** **Yes, useful for building the product** (not for end-user runtime). Use `AGENTS.md`, Cursor rules, and/or `.github/copilot-instructions.md` (+ optional specialist agents for CAP / orchestrator / CPI / infra) so coding assistants follow the hybrid architecture and ADRs. Add light scaffolding at Phase 1; expand when folders exist.

→ Architecture Concept §18; ADR-022

---

## 6. Two architecture documents — which one do we build?

| Document | Role |
| --- | --- |
| [Requirements_Aligned_Thick_CPI_Architecture.md](./Requirements_Aligned_Thick_CPI_Architecture.md) | Requirements/TDD **baseline** (thick CPI + 3 CAPM apps + detailed iFlow) |
| [Architecture_Concept.md](./Architecture_Concept.md) | **Chosen hybrid target** (FastAPI + LangGraph + thin CPI) |

Build against the hybrid concept unless stakeholders explicitly switch back to thick CPI.
