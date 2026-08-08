# MVP Roadmap

**Status:** Planning (documentation phase)  
**Parent:** [Architecture_Concept.md](./Architecture_Concept.md)

This roadmap sequences work so documentation and contracts land before any repository scaffolding.  
**Quality bar:** production-close configuration matrix (CF + Kyma, OpenRouter + AI Core, Postgres + HANA, Redis).  
**Reference landscape:** one BTP trial → then client onboard.

---

## Phase 0 — Documentation and planning (current)

**Goal:** Agree architecture, decisions, and API contracts without generating application code.

| Deliverable | Location | Done when |
| --- | --- | --- |
| Architecture concept | [Architecture_Concept.md](./Architecture_Concept.md) | Hybrid stack, matrix, trial→client path documented |
| Decisions / ADRs | [Decisions_Log.md](./Decisions_Log.md) | Open points resolved or explicitly deferred |
| Component contracts | [Component_Contracts.md](./Component_Contracts.md) | Request/response shapes for FastAPI, CAP, CPI, LLM |
| Client onboarding / IaC | [Client_Onboarding.md](./Client_Onboarding.md) | Terraform + scripts; trial profile + client promotion |
| This roadmap | [MVP_Roadmap.md](./MVP_Roadmap.md) | Phases and exit criteria clear |
| Architecture index | [README.md](./README.md) | Navigable docs set |

**Exit criteria:** Stakeholders accept hybrid model, **production-close matrix**, one FE with role areas, CAP OData registry, Joule-as-channel, **BTP trial first then client onboard**.

**Not in this phase:** application code, live Terraform apply (docs only).

---

## Phase 1 — Repository initialization

**Goal:** Monorepo skeleton with **both** deploy targets and adapter skeletons wired for config selection.

```text
FactoryPilot/
  docs/
  apps/admin-cap/
  apps/approuter/
  services/orchestrator/       # adapters: openrouter + aicore, postgres + hana, redis + hana_table
  integration/cpi/
  infra/
    terraform/                 # CF + Kyma + LLM/DB/cache modules
    scripts/                   # provision, deploy_cf, deploy_kyma, seed, smoke
    client-config/
      trial/                   # BTP trial profile (default)
      _template/               # copy for real clients
  deploy/cf/
  deploy/kyma/                 # real manifests, not placeholders
```

**Exit criteria:** Local health endpoints; `infra/client-config/trial` present; both `deploy_cf` / `deploy_kyma` scripts exist (even if trial only has CF entitled initially).

---

## Phase 2 — Vertical slice on BTP trial (DELIVERY)

**Goal:** End-to-end on the **shared BTP trial** with production-shaped adapters.

1. CDS + DB schema; seed **DELIVERY** (`moduleDomain=SCM`)
2. Admin console: BO/OData, rate limit, cache, dashboard list
3. FastAPI + LangGraph on trial (default profile: CF + Postgres + Redis + OpenRouter if entitled)
4. **Implement** OpenRouter **and** AI Core adapters; live-test whichever trial allows; contract-test the other
5. Redis cache + rate-limit gate
6. Thin CPI + destination (or mock S/4 if trial has no S/4 — document gap)
7. SSO Admin vs BusinessUser
8. `provision` + `deploy_cf` (+ `deploy_kyma` when Kyma entitled) + `seed` + `smoke` against **trial**
9. Flip trial tfvars to exercise alternate cells (e.g. `llm_provider=aicore`, `runtime=kyma`) as entitlements allow
10. Matrix checklist signed (live vs contract-tested per cell)

**Demo script (trial):**  
NL delivery question → rate limit → cache miss → OData (or mock) → LLM summary → cache + audit → UI.

**Exit criteria:** Trial smoke green; matrix checklist complete; no “stub forever” adapters.

---

## Phase 3 — Harden content + promote to client

- Remaining SCM BOs via CAP config (Sales, Shipping, Goods Movement, Purchasing)
- Dashboard KPIs
- Principal propagation if landscape ready
- Harden CPI automated deploy / subaccount modules as needed
- **Client onboard:** copy `_template` → `client-<name>-<env>`, fill tfvars/secrets, `provision` → `deploy` → `seed` → `smoke` (no product fork)

---

## Explicit non-goals until later

| Item | Notes |
| --- | --- |
| SAC dashboard | License-dependent |
| CrewAI | Only if multi-agent research required |
| Event-driven S/4 cache invalidation | Post initial delivery |
| Fully unattended IdP / Cloud Connector | Often client-ops prerequisite |
| Treating Kyma / AI Core / HANA as “Phase 3 stubs” | **Rejected** — first-class in product scope |

---

## Suggested review checkpoints

1. **After Phase 0:** Architecture sign-off (matrix + trial→client).
2. **After Phase 1:** Repo + dual deploy skeletons + trial config + `AGENTS.md` / Copilot instructions.
3. **After Phase 2:** Trial E2E demo + matrix checklist.
4. **After Phase 3:** First real client onboard via tfvars only.

---

## Effort estimates (indicative)

Assumes **1–2 experienced SAP BTP + AI engineers**, BTP trial access, S/4 real or mocked, and no long entitlement waits. Not a fixed SOW.

| Milestone | Calendar |
| --- | --- |
| Phase 1 — repo / dual deploy skeletons | ~1–2 weeks |
| Phase 2 — trial DELIVERY vertical slice | ~4–7 weeks |
| Phase 3 — harden SCM BOs + first client onboard | ~3–6 weeks |
| **Demo-ready on trial** | **~6–10 weeks** |
| **Production-close matrix + first client** | **~3–4.5 months** |

Common slip factors: missing trial entitlements (Kyma, AI Core, Redis), Cloud Connector / S/4 auth, IAS roles, Terraform provider gaps.

**Compressed execution:** If calendar is fixed at **4 weeks**, use [Four_Week_Delivery_Plan.md](./Four_Week_Delivery_Plan.md) (scoped trial E2E `v0.1.0-trial`, daily GitHub feature releases) rather than the fuller 3–4.5 month path above.

---

## Next action

When Phase 0 is accepted, request: **“Initialize the repo (Phase 1).”** Until then, keep changes limited to `docs/`.
