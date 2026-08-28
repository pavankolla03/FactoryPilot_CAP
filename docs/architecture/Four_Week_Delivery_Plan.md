# Four-Week Delivery Plan (GitHub)

> ## Read this before using this plan
>
> **This document is the original contract, not the current state.** It is kept
> because it records what was agreed and why. Two of its assumptions no longer
> hold, and following it literally will send you to rebuild things that were
> deliberately removed.
>
> **1. The runtime changed.** Days 4, 7, 10, 11 and 14 describe a FastAPI +
> LangGraph orchestrator (`services/orchestrator`) and a thin CPI iFlow as the
> primary path. That service was deleted: orchestration now runs inside CAP
> (ADR-023), because the product's own web application is TypeScript and a
> Python runtime meant a second language and a second deployable for no gain.
> Day 16's Kyma manifests target that same deleted service. These days are
> marked **SUPERSEDED** below — the capability exists, built differently.
>
> **2. The Hub connection was never made.** Days 1, 2, 10, 11, 14 and 17 all
> depend on a live SAP Business Accelerator Hub key. No such key has ever been
> configured, so every fixture in `docs/api/hub/` is *generated*, not captured.
> This one missing dependency gates roughly a third of the plan.
>
> The five OData service paths in the seed data **have** been verified against
> the live sandbox — they resolve, and are rejected only on authentication. To
> finish the job, get a free key from <https://api.sap.com> and run:
>
> ```bash
> SAP_HUB_API_KEY='...' node scripts/hub-probe.js
> ```
>
> That reports whether every field the registry queries by actually exists
> upstream — the check that matters, because OData answers a wrong filter
> column with zero rows rather than an error, so a typo reaches a user as
> "there is no stock" instead of a failure.
>
> **What is actually built** is described in [the README](../../README.md) and
> [CHANGELOG.md](../../CHANGELOG.md); what runs a demo today is in
> [DEMO_RUNBOOK.md](../DEMO_RUNBOOK.md). The checkboxes below were never
> maintained and are not a progress measure — the work landed against a
> different structure.

**Status:** Execution plan (granular)  
**Horizon:** 20 working days (4 weeks)  
**Hosting:** GitHub  
**S/4 API source of truth:** [SAP Business Accelerator Hub](https://api.sap.com) (sandbox first, client system later)  
**Target landscape:** BTP trial → E2E tested product slice  
**Architecture:** Hybrid — [Architecture_Concept.md](./Architecture_Concept.md)  
**Related:** [MVP_Roadmap.md](./MVP_Roadmap.md), [Component_Contracts.md](./Component_Contracts.md), [FAQ_and_Clarifications.md](./FAQ_and_Clarifications.md)

---

## 0. Non-negotiable priority: Business Accelerator Hub APIs

All operational data access for the 4-week slice is based on **standard APIs published on SAP Business Accelerator Hub**, not inventing custom OData paths.

| Priority | Action | When |
| --- | --- | --- |
| P0 | Hub account, catalog SCM APIs, download specs, Try Out sandbox | **Days 1–2** |
| P0 | BTP Destination `SAP_ACCELERATOR_HUB_SANDBOX` + API Key | **Day 2** |
| P0 | Working `GET` against sandbox Delivery API from Postman/curl | **Day 2 EOD** |
| P0 | Seed `BusinessObjectConfig` from Hub metadata (service, entity, `$select`) | **Day 3** |
| P0 | Thin CPI / orchestrator call Hub sandbox via Destination | **Days 3–4, 10, 14** |

### Primary API for Week 1–4 vertical slice (DELIVERY)

| Field | Value (confirm on Hub; adjust if package renamed) |
| --- | --- |
| Hub product | SAP S/4HANA Cloud (or S/4HANA as listed) |
| API | **Outbound Delivery** — `API_OUTBOUND_DELIVERY_SRV` |
| Communication scenario (Cloud) | e.g. Delivery Processing Integration (`SAP_COM_0106`) — record exact ID from Hub |
| Entity set (typical) | `A_OutbDeliveryHeader` |
| Sandbox base (typical) | `https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV` |
| Auth (sandbox) | API Key header `APIKey` (Hub application key) |
| Spec artifacts | Download **EDMX** (+ OpenAPI if available) into `docs/api/hub/` |

### SCM API catalog to prepare (register in CAP; only DELIVERY must be live by Day 20)

| objectCode | Hub search keywords | Example service (verify on Hub) | Week |
| --- | --- | --- | --- |
| `DELIVERY` | Outbound Delivery | `API_OUTBOUND_DELIVERY_SRV` | **Live W1–W4** |
| `SALES` | Sales Order | `API_SALES_ORDER_SRV` | Spec + CAP stub W2 |
| `SHIPPING` | Shipping / Transportation | confirm on Hub | Spec stub W3 |
| `GOODS_MOVEMENT` | Material Document / Goods Movement | confirm on Hub | Spec stub W3 |
| `PURCHASING` | Purchase Order | `API_PURCHASEORDER_PROCESS_SRV` (verify) | Spec stub W3 |

Store a living sheet: `docs/api/hub/API_CATALOG.md` (API name, Hub URL, service path, entity, sandbox URL, key fields, sample `$filter`).

### How Hub APIs flow in our architecture

```text
Admin registers Hub API metadata in CAP BusinessObjectConfig
        ↓
FastAPI LangGraph LoadConfig → builds OData query
        ↓
Thin CPI (or direct HTTP in early days) → BTP Destination
        ↓
SAP Business Accelerator Hub Sandbox  OR  client S/4 (same service names)
        ↓
LLM contextualize → answer
```

Client onboard later: same `objectCode` / service path; only **Destination URL + auth** change from Hub sandbox → real S/4.

---

## 1. Goal for Day 20

Signed-off **v0.1.0-trial** on BTP trial:

1. Hub sandbox **Outbound Delivery** API called successfully end-to-end (via Destination + CPI or orchestrator HTTP).  
2. One frontend: Insights + Admin; SSO Admin vs BusinessUser.  
3. CAP: BO registry seeded from Hub, rate limit, cache, communication log list.  
4. FastAPI + LangGraph full pipeline.  
5. OpenRouter live; AI Core adapter + contract tests.  
6. Postgres + Redis on trial.  
7. CF deploy + GitHub CI/CD; Kyma dry-run.  
8. E2E tests green (query, cache hit, rate limit deny, Hub API failure handling).

**Out of 4-week must-ship:** full client S/4 PP, all five BOs live calls, AG-UI, RAG, MCP, Joule, SAC.

---

## 2. Team streams

| Stream | Focus |
| --- | --- |
| **A — Platform** | CAP, Approuter, Fiori, XSUAA, Hub catalog docs in Admin seed |
| **B — Runtime** | FastAPI, LangGraph, Destination/CPI to Hub, Redis, LLM |
| **Both** | GitHub Actions, trial deploy, Hub API key secrets, E2E |

---

## 3. Branching strategy (GitHub)

### Branches

| Branch | Rule |
| --- | --- |
| `main` | Only via squash-merged PR; always trial-deployable |
| `feature/<NNN>-short-name` | One day (or AM/PM slice); delete after merge |
| `release/v0.1.0-trial` | Created Day 19; hotfixes only |
| `hotfix/*` | Break-glass after tag |

Flow: `feature/*` → PR + CI → `main` → `cd-trial` → smoke.

### Naming examples

```text
feature/001-repo-and-hub-workspace
feature/002-hub-sandbox-destination
feature/003-cap-cds-hub-seed-delivery
```

### Daily release

1. Open PR by midday (draft OK).  
2. CI green → squash-merge before EOD.  
3. Auto or `workflow_dispatch` deploy to trial.  
4. Run smoke; comment results on PR.  
5. Optional tag `v0.1.0-dayNN`.

---

## 4. GitHub workflows

| Workflow | Trigger | Jobs (granular) |
| --- | --- | --- |
| `ci.yml` | PR + `main` | `hub-spec-lint` (files exist under `docs/api/hub/`); `orchestrator-test`; `cap-build`; `terraform-validate`; `docker-orchestrator` |
| `cd-trial.yml` | push `main` + manual | build/push image; `cf deploy`/`cf push`; inject `APIKey` secret into Destination or app env; `smoke_test.sh` including **Hub GET** |
| `release.yml` | tag `v0.1.*` | changelog + GitHub Release |
| `cd-kyma-dryrun.yml` | PR touching `deploy/kyma/**` | helm template / kubectl dry-run |

**Secrets:** `CF_*`, `OPENROUTER_API_KEY`, `SAP_HUB_API_KEY` (Accelerator Hub application key), optional `AICORE_*`.

---

## 5. Day-by-day plan (granular)

Each day: **AM / PM** checklists, **branch**, **files/artifacts**, **ship**, **DoD**.

---

### Week 1 — Hub APIs first + foundations

#### Day 1 — Repo + Hub workspace (P0 Hub start)

**Branch:** `feature/001-repo-and-hub-workspace`

**AM (Both) — GitHub / monorepo**

- [ ] Create GitHub repo; protect `main` (CI required).  
- [ ] Scaffold: `apps/`, `services/orchestrator/`, `integration/cpi/`, `infra/`, `deploy/cf/`, `deploy/kyma/`, `docs/api/hub/`.  
- [ ] Add `.gitignore`, root README pointer, `AGENTS.md` (hybrid + Hub APIs mandatory).  
- [ ] Add `.github/workflows/ci.yml` (checkout + job stubs).  
- [ ] Create GitHub Project board; labels `day-01`…`day-20`, `hub-api`, `stream-a`, `stream-b`.

**PM (Both) — Accelerator Hub kickoff**

- [ ] Login [api.sap.com](https://api.sap.com); create Hub **application** / get **API Key**.  
- [ ] Search and open **Outbound Delivery** (`API_OUTBOUND_DELIVERY_SRV`).  
- [ ] Run Hub **Try Out**: `GET A_OutbDeliveryHeader?$top=5`.  
- [ ] Download EDMX (and OpenAPI if present) → `docs/api/hub/delivery/`.  
- [ ] Create `docs/api/hub/API_CATALOG.md` with Delivery row filled (URL, entity, key fields, sample filter).  
- [ ] List candidate Hub APIs for Sales / PO / Goods Movement (links only).

**Ship:** PR → `main`.  
**DoD:** Hub Try Out succeeded; EDMX in repo; CI runs on PR; catalog file exists.

---

#### Day 2 — Hub Destination on BTP + proven HTTP call (P0)

**Branch:** `feature/002-hub-sandbox-destination`

**AM (B) — Destination & secrets**

- [ ] In BTP trial Cockpit: Destination service instance (or reuse).  
- [ ] Create Destination `SAP_ACCELERATOR_HUB_SANDBOX`:  
  - URL = Hub sandbox host (`https://sandbox.api.sap.com`) or full service root (document which pattern you choose).  
  - Additional property / header: `APIKey` = Hub key (prefer Destination additional headers if supported; else app env).  
- [ ] Store `SAP_HUB_API_KEY` in GitHub Secrets.  
- [ ] Document destination JSON shape in `docs/api/hub/DESTINATION.md`.

**PM (B) — Curl/Postman + script**

- [ ] From laptop: curl/Postman `GET` …/`API_OUTBOUND_DELIVERY_SRV/A_OutbDeliveryHeader?$top=5&$select=DeliveryDocument,...` with `APIKey`.  
- [ ] Save raw sample JSON → `docs/api/hub/delivery/sample_response.json` (sanitize if needed).  
- [ ] Add `scripts/hub_smoke_delivery.sh` (reads key from env; exits non-zero on failure).  
- [ ] Wire script into CI as optional job `hub-sandbox-smoke` (allowed to skip if no secret on fork).  
- [ ] Draft `$filter` examples for “today” / shipping point in `API_CATALOG.md`.

**Ship:** PR → `main`.  
**DoD:** Script green against Hub sandbox; Destination created; sample payload committed.

---

#### Day 3 — CAP CDS + seed DELIVERY from Hub metadata (P0)

**Branch:** `feature/003-cap-cds-hub-seed-delivery` (**A** lead)

**AM — CDS**

- [ ] Init CAP Node app under `apps/admin-cap`.  
- [ ] Define entities: `BusinessObjectConfig` (include `hubApiUrl`, `hubApiName`, `communicationScenario`, `odataServicePath`, `entitySet`, `selectFields`, `defaultFilters`, `keywords`, `moduleDomain`, `apiVersion`, `isActive`).  
- [ ] Add `UserRateLimitConfig`, `UserConsumption`, `CacheConfig`, `CommunicationLog`.  
- [ ] `cds build` passes; local SQLite boot.

**PM — Seed from Hub**

- [ ] CSV/JSON seed `db/data/` or `seed_delivery.json`:  
  - `objectCode=DELIVERY`, `moduleDomain=SCM`  
  - `odataServicePath=/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV`  
  - `entitySet=A_OutbDeliveryHeader`  
  - `destinationName=SAP_ACCELERATOR_HUB_SANDBOX`  
  - `selectFields` from EDMX (e.g. DeliveryDocument, OverallGoodsMovementStatus, ShippingPoint, DeliveryDate, …)  
  - `keywords=delivery,outbound delivery,ship,warehouse,to be delivered`  
  - `hubApiName` + link to api.sap.com page  
- [ ] Stub seed rows for SALES/PURCHASING with `isActive=false` and Hub links only.  
- [ ] Add CAP action stub `testConnection` (calls `$metadata` or Hub GET — can be TODO body returning 501 until Day 6).

**Ship:** PR → `main`.  
**DoD:** `cds watch` shows seeded DELIVERY matching Hub service/entity.

---

#### Day 4 — FastAPI skeleton + Hub OData client (direct)

> **SUPERSEDED** — the FastAPI service described here was removed; the same capability runs in CAP (ADR-023).

**Branch:** `feature/004-orchestrator-hub-client` (**B**)

**AM — FastAPI**

- [ ] `services/orchestrator` app: `/insights/health`, settings via env.  
- [ ] `LLMProvider` protocol + OpenRouter/AI Core empty classes + factory.  
- [ ] Dockerfile; CI job builds image.  
- [ ] Unit test: provider factory switches on `LLM_PROVIDER`.

**PM — Hub client (before CPI)**

- [ ] Implement `adapters/s4/hub_odata_client.py`: build URL from BO config; send `APIKey`; parse OData v2 `d.results`.  
- [ ] Endpoint `GET /debug/hub/delivery?top=5` (dev-only, disable in prod flag) hitting Hub via env URL+key.  
- [ ] Unit test with `sample_response.json` fixture (no network).  
- [ ] Integration test marked `@hub` calling real sandbox if `SAP_HUB_API_KEY` set.

**Ship:** PR → `main`.  
**DoD:** Debug endpoint returns Hub deliveries (or CI fixture path documented).

---

#### Day 5 — Approuter, Postgres, Redis, first trial deploy

**Branch:** `feature/005-approuter-data-trial-deploy` (**Both**)

**AM**

- [ ] Approuter: routes `/` UI, `/odata/admin/` → CAP, `/insights/` → FastAPI.  
- [ ] `xs-app.json` + `xs-security.json` draft scopes.  
- [ ] Provision trial **Postgres** + **Redis** (Terraform or Cockpit); bind to apps.  
- [ ] Point CAP to Postgres; run deploy/migrate.

**PM**

- [ ] Complete `cd-trial.yml` (build CAP MTA or cf push modules; push orchestrator Docker).  
- [ ] First deploy to CF trial.  
- [ ] Smoke: health CAP + orchestrator; `hub_smoke_delivery.sh` from Actions.  
- [ ] Fix binding/env until green or file blocker issue with owner.

**Ship:** PR → `main` → **auto deploy**.  
**DoD:** Trial URLs live; Hub smoke from CI or documented secret gap.

**Week 1 exit gate:** Hub Delivery API proven (Try Out + Destination + script + seeded CAP + orchestrator client). No LLM/UI required yet.

---

### Week 2 — Pipeline + Admin + Hub behind LangGraph

#### Day 6 — Admin BO UI + Test Connection to Hub

**Branch:** `feature/006-admin-bo-ui-test-connection` (**A**)

**AM**

- [ ] Fiori Elements List Report + Object Page on `BusinessObjectConfig`.  
- [ ] Fields visible: Hub name, service path, entity, destination, keywords, select, filters, active.  
- [ ] Restrict to Admin scope (even if JWT still stubbed).

**PM**

- [ ] Implement `testConnection` action: `$metadata` or `$top=1` via Destination/Hub.  
- [ ] Show success/failure in UI message.  
- [ ] Manual test on trial: open DELIVERY → Test Connection → OK.  
- [ ] Document Admin runbook snippet in `docs/api/hub/ADMIN_SEED.md`.

**Ship:** Merge → deploy.  
**DoD:** Admin can view Hub-seeded DELIVERY and test connection successfully.

---

#### Day 7 — LangGraph: Auth stub, Intent, LoadConfig

> **SUPERSEDED** — the LangGraph pipeline was replaced by the CAP agent loop in `apps/cap/srv/lib/agent.js` (ADR-023, ADR-024).

**Branch:** `feature/007-langgraph-intent-loadconfig` (**B**)

**AM**

- [ ] Graph state schema: userId, query, objectCode, boConfig, filters, …  
- [ ] Node `IntentResolve`: keyword match on active BOs from DB.  
- [ ] Node `LoadConfig`: load DELIVERY row (Hub fields).  
- [ ] `POST /insights/query` with body per Component_Contracts; return resolved metadata only.

**PM**

- [ ] Tests: “deliveries today warehouse” → `DELIVERY`.  
- [ ] Tests: unknown intent → 400/ERROR.  
- [ ] Log unresolved intents for keyword tuning.  
- [ ] Deploy; smoke query resolve-only mode (`PIPELINE_MODE=resolve`).

**Ship:** Merge → deploy.  
**DoD:** Trial query returns `objectCode=DELIVERY` and Hub service path from config.

---

#### Day 8 — Rate limit (Redis) + Admin rate-limit UI

**Branches:** `feature/008-rate-limit-redis` (**B**), `feature/008b-admin-rate-limit-ui` (**A**)

**AM (B)**

- [ ] Redis client; keys `rl:{user}:{day|week|month}:{period}`.  
- [ ] `checkAndReserve` + `reconcile`; map DEFAULT + user config from CAP/DB.  
- [ ] Graph node `RateLimitGate` before S/4/LLM.  
- [ ] Tests: deny when dailyLimit=0.

**PM (A + B)**

- [ ] Fiori FE for `UserRateLimitConfig` + read-only consumption.  
- [ ] Seed DEFAULT limits (e.g. 50/200/500 requests).  
- [ ] E2E: set limit 1 → second query 429.  
- [ ] Deploy both PRs.

**Ship:** Merge.  
**DoD:** 429 path works on trial with Redis.

---

#### Day 9 — Cache layer + Cache Admin UI

**Branch:** `feature/009-cache-redis-admin` (**Both**)

**AM (B)**

- [ ] Cache key hash (objectCode + normalized filters + strategy).  
- [ ] Get/Set with TTL; midnight clamp for `datePreset=today`.  
- [ ] Graph: CacheLookup / CacheWrite nodes (write still empty until LLM — store placeholder or skip write).  
- [ ] Tests with fakeredis.

**PM (A)**

- [ ] CacheConfig FE; seed DELIVERY TTL 15 minutes, PER_USER.  
- [ ] Deploy; verify config read by orchestrator.

**Ship:** Merge.  
**DoD:** Cache miss/hit flags correct when forced via debug.

---

#### Day 10 — CallS4 via Hub client + thin CPI contract

> **SUPERSEDED** — the S/4 call now runs through the backend adapters in `apps/cap/srv/lib/backend.js`; thin CPI remains one configurable option, not the primary path.

**Branch:** `feature/010-call-s4-hub-and-cpi-contract` (**B**)

**AM**

- [ ] Graph node `CallS4`: use Hub OData client + BO config (`$filter`/`$select`/`$top`).  
- [ ] Map Hub sandbox quirks (CSRF N/A, OData v2 JSON).  
- [ ] Error mapping: Hub 401/403/429/5xx → graph ERROR codes.  
- [ ] Integration test `@hub` optional.

**PM**

- [ ] Define CPI payload contract file `integration/cpi/CONTRACT.md` (same as Component_Contracts §4).  
- [ ] Scaffold iFlow project folder + Postman collection calling Hub through future iFlow.  
- [ ] Env `S4_ACCESS_MODE=hub_direct|cpi` (default `hub_direct` for speed).  
- [ ] Deploy; query returns raw delivery count in metadata (pre-LLM).

**Ship:** Merge.  
**DoD:** End-to-end resolve → rate limit → cache miss → **Hub Delivery data** in response metadata.

**Week 2 exit gate:** Live Hub data in pipeline (not mock-only).

---

### Week 3 — LLM, UI, CPI, SSO

#### Day 11 — OpenRouter contextualize + CommunicationLog

> **SUPERSEDED** — contextualisation and logging live in the CAP insights service; `CommunicationLog` became `SessionLog` / `AgentRun`.

**Branch:** `feature/011-openrouter-audit` (**B**)

**AM**

- [ ] Implement `OpenRouterLLMProvider.complete`.  
- [ ] Prompt: user question + trimmed Hub JSON + DELIVERY `promptHints`.  
- [ ] Graph `LlmContextualize`; parse summaryText/metrics.  
- [ ] Reconcile tokens after call.

**PM**

- [ ] Persist `CommunicationLog` (objectCode, odata URL, cache, rate limit, tokens, status).  
- [ ] CacheWrite stores contextualized answer.  
- [ ] Secret `OPENROUTER_API_KEY` on CF + GitHub.  
- [ ] Deploy; ask “How many outbound deliveries…” → NL answer from Hub data.

**Ship:** Merge.  
**DoD:** Full happy path with Hub + OpenRouter on trial.

---

#### Day 12 — Insights chat UI

**Branch:** `feature/012-insights-chat-ui` (**A**)

**AM**

- [ ] UI5/static chat: input, send, render `summaryText`, metrics, cache/rate badges.  
- [ ] Call Approuter `/insights/query`.  
- [ ] Loading and error states (429, Hub down).

**PM**

- [ ] Wire into Approuter welcome page / tile “Insights”.  
- [ ] Manual UX test with Admin and (later) Business user.  
- [ ] Screenshot for release notes.

**Ship:** Merge.  
**DoD:** Browser E2E demo without Postman.

---

#### Day 13 — XSUAA roles Admin vs BusinessUser

**Branch:** `feature/013-xsuaa-roles` (**Both**)

**AM**

- [ ] Finalize scopes in `xs-security.json`; create role collections on trial.  
- [ ] Assign two IAS/trial users.  
- [ ] CAP `@requires` on config services; public read none.

**PM**

- [ ] FastAPI JWT validation (JWKS); require `InsightsQuery`.  
- [ ] Hide Admin tiles without `ConfigMaintain`.  
- [ ] Test matrix: BusinessUser cannot POST BO; can query.  
- [ ] Deploy.

**Ship:** Merge.  
**DoD:** Role separation verified on trial.

---

#### Day 14 — Thin CPI iFlow → Hub Destination

> **SUPERSEDED** — an iFlow is now one endpoint kind among several, registered as data in the Integration console rather than being the default route.

**Branch:** `feature/014-cpi-thin-hub` (**B**)

**AM**

- [ ] Implement thin iFlow: HTTPS in → dynamic OData GET using payload fields → Hub Destination.  
- [ ] Deploy iFlow to Integration Suite trial.  
- [ ] Postman: iFlow returns same Hub payload as direct client.

**PM**

- [ ] Orchestrator `S4_ACCESS_MODE=cpi`; CPI client adapter.  
- [ ] Compare latency direct vs CPI; document.  
- [ ] Failure test: bad entity → graceful ERROR log.  
- [ ] Deploy.

**Ship:** Merge.  
**DoD:** Default trial path can use CPI→Hub; direct remains fallback.

---

#### Day 15 — AI Core adapter + Admin log dashboard

**Branch:** `feature/015-aicore-dashboard` (**Both**)

**AM (B)**

- [x] Finish `AICoreLLMProvider` + VCR/contract tests. — `AICoreProvider` in `apps/cap/srv/lib/llm.js`; 6 contract tests pin the deployment path, the `AI-Resource-Group` header, the 401-retry and the env wiring.
- [x] If trial has AI Core: flip `LLM_PROVIDER=aicore` smoke; else mark checklist “contract-only”. — **contract-only**: the trial subaccount has no AI Core entitlement, so no live call has been made.

**PM (A)**

- [ ] Fiori list for `CommunicationLog` (filter user, objectCode, status, date).  
- [ ] Simple usage cards if time (requests today, cache hits).  
- [ ] Deploy.

**Ship:** Merge.  
**DoD:** Logs visible; AI Core path implemented.

**Week 3 exit gate:** UI + SSO + Hub + LLM + logs.

---

### Week 4 — Harden, E2E, release

#### Day 16 — Kyma manifests + extra Hub API stubs

> **SUPERSEDED** — the Kyma manifests here target the deleted orchestrator; Cloud Foundry via MTA is the deployment path.

**Branch:** `feature/016-kyma-and-hub-stubs`

**AM**

- [ ] `deploy/kyma/*` Deployment/Service/APIRule for orchestrator; script dry-run in CI.  
- [ ] HANA repository interface tests (Postgres still default).

**PM**

- [ ] Add inactive CAP seeds + EDMX folders for SALES / PURCHASING from Hub (download specs).  
- [ ] Update `API_CATALOG.md`.  
- [ ] No live calls required.

**Ship:** Merge.  
**DoD:** Kyma dry-run CI green; Hub catalog expanded.

---

#### Day 17 — Automated E2E + CD smoke (includes Hub)

**Branch:** `feature/017-e2e-hub-smoke`

**AM**

- [ ] API E2E suite:  
  1. Hub connectivity  
  2. Intent→DELIVERY  
  3. Query success  
  4. Cache hit  
  5. Rate limit deny  
  6. Invalid API key → ERROR logged  
- [ ] Optionally Playwright on Insights UI.

**PM**

- [ ] `cd-trial.yml` post-deploy must run suite; fail deploy on smoke fail.  
- [ ] Fix flakes.  
- [ ] Deploy.

**Ship:** Merge.  
**DoD:** Broken Hub key fails pipeline.

---

#### Day 18 — Bug bash (Hub + pipeline)

**Branches:** `hotfix/*` / `feature/018-harden`

**Checklist**

- [ ] Hub timeout/retry settings (3–5s connect, 15s read).  
- [ ] Trim payload size before LLM (`$top`, `$select`).  
- [ ] Always write CommunicationLog.  
- [ ] Redis race on concurrent reserve.  
- [ ] Approuter CSRF/session issues.  
- [ ] Close all P0/P1.

**Ship:** Continuous merges.  
**DoD:** Zero open P0.

---

#### Day 19 — Release branch freeze

**Branch:** `release/v0.1.0-trial` from `main`

**AM**

- [ ] Freeze features; only fixes into release.  
- [ ] Fill matrix checklist (Hub live, OpenRouter live, AI Core ?, Kyma dry-run, …).  
- [ ] Write `CHANGELOG.md` + runbook `docs/api/hub/RUNBOOK_TRIAL.md`.

**PM**

- [ ] Stakeholder dry demo.  
- [ ] Merge release → `main`.

**DoD:** Checklist signed.

---

#### Day 20 — E2E sign-off + GitHub Release

**Tag:** `v0.1.0-trial`

**AM**

- [ ] Execute full manual script (Admin Test Connection → Insights question → Dashboard log).  
- [ ] Capture evidence (screenshots, correlation IDs).  

**PM**

- [ ] `git tag` + `gh release create`.  
- [ ] Demo; list post-week backlog.  
- [ ] Leave trial running.

**DoD:** Release published; Hub-based E2E signed off.

---

## 6. Daily operating rhythm

| Slot | Action |
| --- | --- |
| 09:30 | Standup: Hub blockers first |
| 10:00–13:00 | AM checklist on `feature/NNN-...` |
| 13:00 | Push; open/update PR |
| 14:00–17:30 | PM checklist |
| 17:30 | CI green → squash-merge → deploy → smoke (include Hub) |
| 18:00 | Board: move card to Deployed/Done; note blockers |

---

## 7. Definition of Done (daily)

- [ ] AM+PM checklists completed or explicitly deferred with ticket  
- [ ] PR + tests  
- [ ] CI green  
- [ ] Merged to `main`  
- [ ] Trial deploy (from Day 5)  
- [ ] Smoke including Hub when touch S/4 path  
- [ ] `API_CATALOG.md` / runbook updated if Hub metadata changed  

---

## 8. Risks (Hub-specific)

| Risk | Mitigation |
| --- | --- |
| Hub sandbox data empty / odd | Keep `sample_response.json`; LLM still demoable; document |
| API Key quota / 429 | Cache aggressively; rate-limit users; retry backoff |
| Wrong API version on Hub | Pin EDMX in repo; seed exact path from download |
| Destination header limitations | Fall back to orchestrator `hub_direct` + env APIKey |
| Integration Suite not on trial | Stay on `hub_direct` until Day 14; CPI optional |

---

## 9. Post–Day 20

1. Point Destination from Hub sandbox → client S/4 (same Hub API names).  
2. Activate remaining SCM Hub APIs in CAP.  
3. Client Terraform onboard.  
4. Kyma/AI Core/HANA live cells.  

---

## 10. Git commands (quick)

```bash
git checkout main && git pull
git checkout -b feature/002-hub-sandbox-destination
# ...
gh pr create --base main --title "feat: Hub sandbox destination and smoke script"
gh pr merge --squash
# Day 20
git tag -a v0.1.0-trial -m "Trial E2E with Business Accelerator Hub APIs"
git push origin v0.1.0-trial
gh release create v0.1.0-trial --generate-notes
```

---

## 11. Scope honesty

This 4-week plan is a **compressed trial E2E** with **Business Accelerator Hub APIs prioritized in Days 1–3** and kept on the critical path through Day 20. Fuller matrix + real client S/4 onboard follow the tag, using the same Hub API names in `BusinessObjectConfig`.
