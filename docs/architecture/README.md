# Architecture documentation

Planning pack for the **AI-Assisted S/4HANA Business Insights** platform (SCM-first, module-reusable, production-close).

**Phase:** Documentation only — application repository scaffolding is deferred until Phase 0 sign-off. See [MVP_Roadmap.md](./MVP_Roadmap.md).

**Reference landscape:** one **BTP trial** for build/test → then Terraform onboard to client environments.

## Documents

| Document | Purpose |
| --- | --- |
| [Architecture_Concept.md](./Architecture_Concept.md) | **Target hybrid** architecture (CAP admin + FastAPI/LangGraph + thin CPI) |
| [Requirements_Aligned_Thick_CPI_Architecture.md](./Requirements_Aligned_Thick_CPI_Architecture.md) | **Requirements baseline:** thick CPI orchestrator, 3 CAPM apps, UIs, detailed iFlow design |
| [FAQ_and_Clarifications.md](./FAQ_and_Clarifications.md) | Planning Q&A (backends, FE, rate limit, LangGraph/LLM, schedule, AG-UI, RAG/MCP, dev agents) |
| [Decisions_Log.md](./Decisions_Log.md) | Locked ADRs (including ADR-019–022) |
| [Component_Contracts.md](./Component_Contracts.md) | API and adapter contracts (hybrid target) |
| [Client_Onboarding.md](./Client_Onboarding.md) | Multi-client provision/deploy; trial profile then client promotion |
| [MVP_Roadmap.md](./MVP_Roadmap.md) | Phased plan + effort estimates |
| [Four_Week_Delivery_Plan.md](./Four_Week_Delivery_Plan.md) | 20-day plan, GitHub branching, CI/CD, daily feature releases |

## Two architecture views

| View | Doc | Orchestrator | CAP | CPI |
| --- | --- | --- | --- | --- |
| As in shared requirements / TDD | [Requirements_Aligned_Thick_CPI…](./Requirements_Aligned_Thick_CPI_Architecture.md) | Thick CPI iFlow | 3 config CAPM apps + dashboard | Intent, cache, S/4, rate limit, LLM, audit |
| Chosen hybrid target | [Architecture_Concept.md](./Architecture_Concept.md) | FastAPI + LangGraph | Admin/registry/dashboard | Thin S/4 OData only |

## Requirements (inputs)

| Document | Purpose |
| --- | --- |
| [../requirements/Documentation.docx.md](../requirements/Documentation.docx.md) | Business scope and CAP-centric end-to-end flow |
| [../requirements/Technical_Design_Document.docx.md](../requirements/Technical_Design_Document.docx.md) | TDD: config apps, CPI, rate limit, cache, OpenRouter, dashboard |

## Stack at a glance (production-close)

- **Front-end (1):** Approuter shell with Insights (business) + Admin console (4 tiles)  
- **OData registry:** CAP `BusinessObjectConfig` — Admin-maintained  
- **Backends:** CAP + FastAPI/LangGraph  
- **S/4 APIs:** SAP Business Accelerator Hub (sandbox on trial; same API names on client S/4)  
- **S/4 access:** One thin generic CPI iFlow (or hub_direct early)  
- **Runtimes (both):** Cloud Foundry **and** Kyma  
- **LLM (both):** OpenRouter **and** SAP AI Core  
- **DB (both):** PostgreSQL **and** HANA Cloud  
- **Cache:** Redis (HANA table fallback) — new instances per env via Terraform  
- **Auth:** IAS / XSUAA — Admin vs BusinessUser  
- **Path:** BTP trial prove-out → client onboard (config only)  
- **Joule:** Optional channel later — not a replacement  
- **Not in runtime:** RAG, MCP; AG-UI deferred from MVP  
- **Dev tooling:** `AGENTS.md` / Copilot instructions at Phase 1  

## Clarifications

See [FAQ_and_Clarifications.md](./FAQ_and_Clarifications.md) for answers to planning questions (backends, front-end, rate limit vs APIM, LangGraph→LLM, schedule, AG-UI, RAG/MCP, dev agents).

## Next step

- For a **4-week execution** with GitHub branching/CI: see [Four_Week_Delivery_Plan.md](./Four_Week_Delivery_Plan.md).  
- When ready to code: request **Phase 1 — Initialize the repo** (align Day 1 of the 4-week plan).
