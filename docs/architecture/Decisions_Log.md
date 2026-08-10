# Decisions Log

**Purpose:** Lock architecture choices that affect design and the future repo layout.  
**Parent:** [Architecture_Concept.md](./Architecture_Concept.md)

Decisions below resolve the open points from the architecture draft and the TDD (§10.2). Status `Locked` means we build against it unless stakeholders reopen the item.

---

## ADR-001 — Orchestration runtime

> **Superseded by ADR-023.** The orchestrator is CAP custom handlers, not
> FastAPI + LangGraph. Kept for the reasoning, which still holds; only the
> conclusion changed once the product turned out to be TypeScript.

| Field | Value |
| --- | --- |
| Status | Superseded (see ADR-023) |
| Decision | FastAPI + LangGraph as the query orchestrator |
| Alternatives | CAP-only orchestration; thick CPI iFlow; CrewAI |
| Rationale | CAP is strong for Fiori/CDS/admin, weak for agent graphs. CPI is strong for S/4 connectivity, weak for LLM policy/cache/audit evolution. LangGraph fits a gated enterprise pipeline; CrewAI is better for free-form multi-agent later. |

---

## ADR-002 — Config read path (FastAPI ↔ CAP)

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | Shared PostgreSQL schema; CAP owns schema/migrations; FastAPI reads tables/repos directly for runtime |
| Alternatives | FastAPI calls CAP OData only |
| Rationale | Lower latency for every query; single source of truth; CAP still owns admin write path and CDS model. CAP OData remains available for UIs and external tools. |

---

## ADR-003 — Chat / end-user UI

| Field | Value |
| --- | --- |
| Status | Locked for MVP |
| Decision | Lightweight CAP-served UI5 / Fiori chat page (or Approuter-hosted static UI) calling FastAPI |
| Alternatives | SAP Build Work Zone widget; separate React app on CF |
| Rationale | Keeps MVP inside BTP/CAP tooling and SSO. React or Work Zone can replace the shell later without changing the FastAPI contract. |

---

## ADR-004 — S/4 authentication for MVP

| Field | Value |
| --- | --- |
| Status | Locked for MVP (with gap note) |
| Decision | Technical user destination via CPI for MVP; design for principal propagation |
| Alternatives | Principal propagation only from day one |
| Rationale | Many landscapes need Cloud Connector + PP setup that blocks first demos. Filters still carry plant/warehouse/user context. Track PP as a post-MVP hardening item. |

---

## ADR-005 — LLM provider abstraction

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | `LLMProvider` adapter with **full implementations** for **OpenRouter** and **SAP AI Core**; select via `llm_provider` config. Both are production-supported, not stubs. |
| Alternatives | Hard-code OpenRouter only; AI Core only; stub AI Core until post-MVP |
| Rationale | Clients may mandate either provider. Trial may start on OpenRouter and switch to AI Core when entitled — same code path. |

---

## ADR-006 — Database portability

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | Repository interfaces with **full support** for **PostgreSQL** and **HANA Cloud**; select via `db_engine`. Default trial/client path often Postgres; HANA is first-class, not a stub. New DB service instance per environment when provisioning. |
| Alternatives | HANA-only from start; CAP SQLite only; share one DB across all clients; stub HANA until post-MVP |
| Rationale | Production-close matrix; per-env isolation; CAP + FastAPI share one schema per environment. |

---

## ADR-007 — Cache and rate-limit store

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | Redis for response cache and atomic rate-limit counters; **provision a new Redis service instance per client environment** on BTP (or hyperscaler via BTP marketplace) during Terraform onboarding |
| Alternatives | HANA cache table only; CAP-managed entities for everything; reuse an existing client Redis without provisioning |
| Rationale | Sub-second cache hits and safe concurrent quota increments. Per-env instances isolate counters/cache. HANA table remains a fallback adapter if Redis is unavailable. |

---

## ADR-008 — Intent classification

> **Superseded by ADR-024.** Tool selection is the model's, through tool
> calling, rather than a keyword pass before it.

| Field | Value |
| --- | --- |
| Status | Superseded (see ADR-024) |
| Decision | Keyword / synonym match against `BusinessObjectConfig.keywords` first; optional LLM fallback behind a feature flag |
| Alternatives | LLM classify every request |
| Rationale | Deterministic, cheap, and tunable by functional consultants via the admin app. |

---

## ADR-009 — Rate-limit placement (app primary; APIM optional)

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | **Primary** product rate limiting lives in FastAPI + Redis (gate before S/4 and before LLM; reconcile tokens after LLM). Integration Suite **API Management** quota/spike-arrest may be added later as **defense-in-depth** only — not as a substitute. |
| Alternatives | Rate limit only on CPI/APIM proxy; gate only before LLM (TDD); gate only before S/4 |
| Rationale | See detailed reasoning below. Protects backend load and LLM cost; matches business documentation intent and Admin CAP configuration. |

### Why not primary rate limiting on Integration Suite (APIM / CPI)?

Rate limiting **is** available at the Integration Suite edge (especially **API Management** quota and spike-arrest policies; limited throttling inside iFlows). We still keep **product** rate limits in the orchestrator because:

| Requirement | APIM / CPI proxy alone | FastAPI + Redis |
| --- | --- | --- |
| Per-user **day / week / month** windows from Admin UI | Awkward; gateway quotas are usually app/key/IP oriented | Matches `UserRateLimitConfig` |
| Limit by **LLM tokens** + reconcile after the call | Gateway never sees OpenRouter/AI Core token usage | Orchestrator owns the LLM call |
| Admin-configured overage / block / role bypass | Duplicated outside CAP | Same SSO scopes + CAP console |
| Enforce on **cache hit** (no CPI call) | CPI/APIM on S/4 path is skipped | Still enforced in LangGraph |
| Gate **before LLM** | Thin CPI path never touches LLM | One policy point in the graph |

**Split when needed later:**

- **Primary (required):** FastAPI `checkAndReserve` + Redis.  
- **Optional secondary:** APIM spike arrest / hard ceiling in front of Approuter or FastAPI for platform abuse (DDoS, runaway clients). Complementary only.

Do not move day/week/month token product limits solely onto the Integration Suite proxy, or cache hits and LLM spend will escape the rules admins configure.

---

## ADR-010 — Cache invalidation for “today” queries

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | TTL from `CacheConfig`, plus hard expire at local midnight for date-bound (“today”) query patterns |
| Alternatives | TTL only; event-based invalidation from S/4 |
| Rationale | Prevents stale “today” answers after midnight without requiring S/4 event mesh in MVP. |

---

## ADR-011 — Dashboard technology

| Field | Value |
| --- | --- |
| Status | Locked for MVP |
| Decision | CAP + Fiori Elements (Overview / ALP + CommunicationLog explorer) |
| Alternatives | SAP Analytics Cloud first |
| Rationale | No SAC license dependency for MVP; SAC can consume the same log/consumption services later. |

---

## ADR-012 — Runtime portability (CF and Kyma)

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | Support **Cloud Foundry and Kyma** as first-class runtimes (same FastAPI image; CAP packaging for both; `deploy_cf.sh` and `deploy_kyma.sh`; Terraform modules for both). |
| Alternatives | CF-only until later; Kyma-only; Kyma manifests as empty stubs |
| Rationale | Production-close product must land on either client runtime without a rewrite. Prove on BTP trial entitlements, then onboard clients via `runtime` tfvars. |

---

## ADR-013 — Documentation before repo init

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | Complete architecture + contracts + MVP roadmap before scaffolding `apps/`, `services/`, `integration/` |
| Alternatives | Scaffold repo immediately |
| Rationale | Stakeholder alignment on hybrid stack, SSO, and portability before code structure freezes habits. |

---

## ADR-014 — Multi-client provisioning and deploy

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | Terraform for BTP/service provisioning; scripts/CI for build, deploy, seed, and smoke; per-client tfvars + `client.yaml` (no product forks) |
| Alternatives | Manual Cockpit-only setup; pure Terraform including every app push; Bash-only with no Terraform |
| Rationale | Clients differ in region, runtime (CF/Kyma), and adapters (OpenRouter/AI Core, Postgres/HANA). Terraform is idempotent for long-lived services; app/CPI deploys change with every release and fit CI scripts better. See [Client_Onboarding.md](./Client_Onboarding.md). |

---

## ADR-015 — Front-end: one shell, role-based areas

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | One product frontend (Approuter shell). Two UI areas distinguished by role: Insights for business users; Admin console for Administrators. Admin decides rate limiting, caching, and OData/BO registration (plus dashboard). Four admin tiles in one CAP/Fiori group. |
| Alternatives | Two separately deployed frontends; chat-only with no admin FE; Cockpit-only admin |
| Rationale | Matches product UX expectation: one app, different experiences by SSO role. Keeps a single SSO entry while restricting config to elevated scopes. |

---

## ADR-016 — OData registration and module reuse

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | CAP `BusinessObjectConfig` is the OData/BO registry (including `moduleDomain`). One generic CPI iFlow. New modules/services = config rows, not new iFlows or code forks. SCM is the first content pack, not a hard-coded platform limit. |
| Alternatives | Register OData only inside CPI; one iFlow per BO; SCM-only hard-coding |
| Rationale | Matches TDD “config without code change”; keeps Integration Suite thin; enables Finance/PM/etc. later via the same pipeline. |

---

## ADR-017 — Joule / Joule Studio positioning

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | Build this platform as the insights system of record; treat Joule as an optional future channel (skill calling FastAPI). Do not replace CAP registry, rate limit, cache, audit, or Terraform onboarding with Joule Studio alone. |
| Alternatives | Deliver MVP only as Joule Studio skills; skip custom chat UI |
| Rationale | Joule is strong as an assistant UX and skill host but does not natively deliver our full configurable multi-client control plane. API-first design still allows Joule integration later. |

---

## ADR-018 — BTP trial as reference landscape before client onboard

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | Develop and validate on **one shared BTP trial**. Client onboarding (new tfvars + secrets + provision/deploy) happens only after trial quality gates pass. Missing trial entitlements → implement adapters + contract tests + checklist gap; do not leave permanent stubs. |
| Alternatives | Mocks-only development; onboard first client before trial E2E; separate trial fork |
| Rationale | One trial controls cost while forcing real BTP bindings; config matrix avoids client forks. |

---

## ADR-019 — LangGraph calls LLM only via adapter

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | LangGraph `LlmContextualize` node calls `LLMProvider.complete(...)`. Implementations: OpenRouter and AI Core. Provider chosen by `llm_provider` config. No direct SDK imports inside graph nodes. |
| Alternatives | Hard-code OpenRouter in the node; separate graphs per provider; call LLM from CPI |
| Rationale | Keeps the pipeline provider-agnostic and matches the production-close matrix. |

---

## ADR-020 — AG-UI for Insights chat

| Field | Value |
| --- | --- |
| Status | Locked (defer from MVP) |
| Decision | Do **not** require AG-UI for MVP. Ship `POST /insights/query` JSON + simple chat UI. AG-UI (or SSE streaming) may be added later for Insights only (streaming / step UI). Admin console stays Fiori Elements. |
| Alternatives | AG-UI from day one; CopilotKit-only frontend |
| Rationale | Core value is gated insights + admin control plane; AG-UI improves chat UX but is not needed for rate limit, cache, registry, or dual LLM. |

---

## ADR-021 — RAG and MCP not required for product runtime

> **Amended by ADR-025.** Still true of this CAP implementation, but the
> shipped web application (version4) uses MCP as its core tool layer, so the
> blanket wording was wrong about the product as a whole.

| Field | Value |
| --- | --- |
| Status | Amended (see ADR-025) |
| Decision | **No RAG** and **no MCP servers** in the production Insights path. Facts come from live S/4 OData; tools are direct adapters (LLM, CPI, Redis, DB). Optional later: RAG over SOPs/history; MCP only as **developer** IDE tooling. |
| Alternatives | Vector RAG over S/4 extracts; expose all tools via MCP to the runtime agent |
| Rationale | Requirements are operational NL Q&A over OData, not document Q&A. MCP adds runtime complexity without matching the designed adapter model. |

---

## ADR-022 — Dev-time agents, skills, and instructions

| Field | Value |
| --- | --- |
| Status | Locked |
| Decision | Use repo instructions for coding assistants: `AGENTS.md`, Cursor rules, and/or `.github/copilot-instructions.md`; optional `.github/agents` (or Cursor skills) for CAP / orchestrator / CPI / infra specialists. Scaffold at Phase 1; not a substitute for architecture docs. |
| Alternatives | No project AI instructions; rely on chat memory only |
| Rationale | Multi-stack repo (hybrid vs thick-CPI baseline) needs durable guardrails so Copilot/Cursor does not invent a third architecture. |

---

## Still reopenable (stakeholder confirm)

These are locked for planning but should be explicitly confirmed in the next review meeting:

1. Technical user vs principal propagation timeline for S/4.
2. Exact XSUAA scope names / role collection naming in the customer IAS.
3. OpenRouter model default (cost vs quality) and whether model is configurable per business object.
4. Whether `Viewer` role is required in MVP or Admin + BusinessUser only.
5. Preferred Terraform remote state backend (Terraform Cloud vs customer cloud storage).
6. Whether subaccount creation is automated or pre-created by the client’s BTP admin.
7. Whether delivery ships the custom Insights Chat UI only, or also a Joule skill stub.
8. Exact BTP marketplace / trial entitlements available (CF, Kyma, AI Core, Postgres, Redis, HANA) — drives which matrix cells are live-tested vs contract-tested on trial.
9. Whether a client may **bring their own** existing Postgres/Redis (import into Terraform) vs always create new instances (default: create new).
10. Whether to schedule AG-UI / streaming Insights UI in Phase 3 or leave backlog.

---

## ADR-023 — Orchestration runs in CAP, not a separate Python service

| Field | Value |
| --- | --- |
| Status | Locked |
| Supersedes | ADR-001 |
| Decision | The agent loop runs as CAP custom handlers in `apps/cap/srv/lib/agent.js`, inside the same deployable as the CAP services |
| Alternatives | FastAPI + LangGraph beside CAP (ADR-001); thick CPI |

**Why this changed.** ADR-001 reasoned that CAP is a poor host for an agent
graph, and that is still true in the abstract. What it assumed was Python. The
product that actually exists (`pavankolla03/FactoryPilot`, branch `version4`)
is NestJS/TypeScript, and CAP is Node.js — so the loop can live *in* CAP
instead of in a second runtime beside it. That removes an app, a route, a
deployment and a network hop, and keeps one auth chain.

**What it costs.** CAP offers nothing for graph state, retries or checkpoints;
those are plain code in `agent.js`. If the pipeline ever needs durable
multi-step state, this decision should be revisited rather than worked around.

---

## ADR-024 — The model selects tools; keywords remain for discovery

| Field | Value |
| --- | --- |
| Status | Locked |
| Supersedes | ADR-008 |
| Decision | Tool choice is made by the model through tool calling. `BusinessObjectConfig.keywords` is passed to the model as part of each tool description rather than being matched before it |
| Alternatives | Deterministic keyword pass first, LLM fallback (ADR-008) |

**Why.** With the registry generating one tool per business object, the model
already sees every option and its keywords. A keyword pass in front picks a
tool the model then has to live with, and it loses multi-tool questions
entirely.

**What it costs.** Tool choice is no longer deterministic, so a functional
consultant cannot force a routing by editing keywords alone — they influence
it. The offline provider keeps a keyword matcher so the product still answers
with no model configured; that matcher is a stand-in, not the contract.

---

## ADR-025 — MCP is out of scope here, not out of scope for the product

| Field | Value |
| --- | --- |
| Status | Locked |
| Amends | ADR-021 |
| Decision | This CAP implementation exposes tools from the CAP registry and does not run MCP. The statement that MCP has no place in the product runtime is withdrawn |

**Why.** ADR-021 said no MCP in the product runtime. The shipped web
application uses MCP servers as its core tool layer, so as written the ADR
contradicted the running system. Scoping it to this implementation makes it
true again.

**Open.** If the two codebases converge, one of these tool layers has to win.
That decision has not been made and should not be inferred from this ADR.
