# Changelog

All notable changes to FactoryPilot are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [SemVer](https://semver.org/) for tagged releases (`v0.1.0-trial`, etc.).

## [Unreleased]

### Added

- **MVP as seven decoupled CAP services (`apps/cap`), deployed to BTP trial and
  runnable locally with no SAP account.** One CDS service and one Fiori app per
  capability, so a client can adopt or drop any of them independently:
  `config`, `token`, `admin`, `audit`, `insights`, `cache`, `integration`, plus
  a `dashboard` service for monitoring.
  - Agent loop in CAP (`srv/lib/agent.js`): the model selects tools built from
    `BusinessObjectConfig`; reads execute, writes stop at a confirmation card
    and are never run inline (ADR-023, ADR-024).
  - Adapters, all config-selected: LLM (`fake` | `openrouter` | `aicore`),
    backend (`mock` | `hub` | `cpi` | `iflow`), DB (`sqlite` | `postgres`),
    cache (`memory` | `redis`).
  - Rate limiting with reserve-then-verify semantics, rollback on denial, and
    token reconciliation after the LLM call.
  - Answer cache with per-object TTL policies, key scope per user/role/global
    and a midnight clamp for "today" questions (ADR-010).
  - Integration console: register any iFlow or OData endpoint with its auth
    mode, test it, and bind it to a business object — credentials referenced by
    environment-variable *name*, never stored.
  - Custom Fiori pages (Insights, Admin, Monitoring) on Horizon design tokens,
    plus six Fiori Elements apps over the OData services.
  - Client onboarding: `infra/scripts/{onboard,provision,deploy,seed,smoke}.sh`,
    per-client `client.yaml`, and Terraform for the long-lived services.
  - Synthetic Outbound Delivery fixture at
    `docs/api/hub/delivery/sample_response.synthetic.json` — clearly marked as
    generated placeholder data, not a Hub capture.
  - 88 tests; CI runs the CDS compile, seed-integrity and router-schema
    validators, Terraform validate, shellcheck, a committed-secret scan, and an
    MTA build that asserts the UI is inside the deployable module.

- Day 1 monorepo scaffold (`apps/`, `services/`, `integration/`, `infra/`, `deploy/`).
- Architecture and requirements documentation under `docs/`.
- SAP Business Accelerator Hub workspace: `docs/api/hub/` + `API_CATALOG.md` (Delivery API prioritized).
- GitHub Actions CI stub (`.github/workflows/ci.yml`).
- AI assistant guardrails: `AGENTS.md`, Cursor rules/skills, Copilot instructions/agents, `CLAUDE.md`, OpenCode config.
- `CHANGELOG.md` (this file).

### Changed

- The Python orchestrator (`services/orchestrator`: FastAPI + an eight-node
  LangGraph pipeline) and `apps/admin-cap` were removed. Orchestration now runs
  inside CAP (ADR-023) and the admin model was split across the services above.
  The user's existing web application is TypeScript, so a Python runtime meant
  a second language and a second deployable for no benefit. Nothing had been
  released, so this supersedes rather than deprecates.
### Fixed

- **Every question returned `HTTP 504`.** Two independent causes, both of them
  an unbounded wait:
  - The answer cache awaited a Redis client whose socket kept dropping.
    node-redis only *rejects* a command when the client is closed; while it is
    reconnecting it *queues* — and the reconnect strategy never gave up, so the
    client stayed open and the queued `GET` never settled. The request awaiting
    it never returned. Redis now fails fast (`disableOfflineQueue`), every
    operation has its own timeout, reconnects are bounded, and a Redis that has
    proven dead is dropped for the life of the instance instead of being
    retried on every request. A cache is an optimisation; it can no longer hold
    a request open.
  - The agent loop was bounded by round count (8) but not by wall-clock, and a
    single model call could take 60s. A question now carries a deadline
    (`FACTORYPILOT_ASK_BUDGET_MS`, 75s): no new round starts without room to
    finish it, the remaining budget is passed down to the model and to the
    OData call, and running out of time produces a readable partial answer
    rather than a gateway error. The approuter destination timeout is now set
    explicitly (120s) instead of relying on its 30s default, so the service
    always answers before the gateway gives up.

- **A stalled response body could hang a request indefinitely.** `fetch`
  resolves when the *headers* arrive, and all three backend adapters cleared
  their abort timer at that moment — leaving `res.json()` with nothing to
  interrupt it. `CpiBackend` was worse: it accepted a `timeoutMs` and passed no
  abort signal at all. All three now read the body inside the timer.

- **An empty attachment strip rendered as a blank box above the chat input.**
  The `hidden` attribute is a user-agent rule, so the `display: flex` on its own
  class outranked it.


- **A backend that could not be reached was answered as "No records matched
  that question".** A tool call that threw was handed to the model as
  `{"error": ...}` and the model narrated around it, so an unreachable
  warehouse endpoint produced a sentence that reads as *there is no stock*
  rather than *nothing was checked*. The run was also stored as `SUCCESS` with
  no error detail, which hid the outage from the audit log and — because
  `SUCCESS` is what gates the answer cache — wrote the wrong answer to Redis,
  where it outlived the outage that produced it. A run that grounds nothing and
  whose every tool call failed is now `FAILED`, carries the reason, stays out
  of the cache, and renders as an error strip.
- Monitoring tables were injected without a scroll container. Cells are
  nowrap, so three of the five overflowed their card and their last columns
  ("Avg ms", "Tokens", "Last seen") could not be reached at any window width.
- KPI tiles inherited Fiori's 11rem `GenericTile` height, which is sized for a
  tile containing a chart; four single-number tiles filled a viewport.
- `ModelRoute.provider` was free text, where a typo silently downgraded to the
  offline provider. It is now constrained to the providers that exist.


## [0.1.0-trial] — TBD

Target end of 4-week plan (Day 20). See [Four_Week_Delivery_Plan.md](docs/architecture/Four_Week_Delivery_Plan.md).
