# Changelog

All notable changes to FactoryPilot are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [SemVer](https://semver.org/) for tagged releases (`v0.1.0-trial`, etc.).

## [Unreleased]

### Added

- **MVP vertical slice (plan days 3–12), runnable locally with no SAP account.**
  - CAP admin (`apps/admin-cap`): `BusinessObjectConfig`, `UserRateLimitConfig`,
    `UserConsumption`, `CacheConfig`, `CommunicationLog`, a `UsageByObject`
    aggregate view, Fiori Elements annotations for all four admin tiles, scope
    enforcement via `@restrict`, a `testConnection` action, and seed data for
    DELIVERY (active) plus four inactive stubs.
  - Orchestrator (`services/orchestrator`): FastAPI + the eight-node LangGraph
    pipeline, `POST /insights/query`, `GET /insights/usage/me`,
    `GET /insights/health`.
  - Adapters, all config-selected: LLM (`fake` | `openrouter` | `aicore`),
    S/4 (`fake` | `hub_direct` | `cpi`), DB (`sqlite` | `postgres`),
    cache and counters (`memory` | `redis`).
  - Rate limiting with reserve-then-verify semantics, rollback on denial, and
    token reconciliation after the LLM call.
  - Cache keys scoped by user/role/global with a midnight clamp for "today"
    questions (ADR-010).
  - Insights chat UI (`apps/approuter/resources/insights`), `xs-app.json` and
    `xs-security.json` with scopes, role templates and role collections.
  - `scripts/dev_up.sh` (one-command local stack) and `scripts/smoke.sh`
    (six-path end-to-end check).
  - Synthetic Outbound Delivery fixture at
    `docs/api/hub/delivery/sample_response.synthetic.json` — clearly marked as
    generated placeholder data, not a Hub capture.
  - 64 orchestrator tests; CI now runs pytest, `cds build`/`deploy`, and the
    smoke suite.
- Day 1 monorepo scaffold (`apps/`, `services/`, `integration/`, `infra/`, `deploy/`).
- Architecture and requirements documentation under `docs/`.
- SAP Business Accelerator Hub workspace: `docs/api/hub/` + `API_CATALOG.md` (Delivery API prioritized).
- GitHub Actions CI stub (`.github/workflows/ci.yml`).
- AI assistant guardrails: `AGENTS.md`, Cursor rules/skills, Copilot instructions/agents, `CLAUDE.md`, OpenCode config.
- `CHANGELOG.md` (this file).

## [0.1.0-trial] — TBD

Target end of 4-week plan (Day 20). See [Four_Week_Delivery_Plan.md](docs/architecture/Four_Week_Delivery_Plan.md).
