# FactoryPilot

AI-Assisted S/4HANA Business Insights on SAP BTP (SCM-first, module-reusable).

## Quickstart — the whole MVP, locally

No SAP account, no BTP, no Docker. Defaults use SQLite, an in-process cache, a
synthetic S/4 fixture and a deterministic offline LLM.

```bash
python3 -m venv .venv && .venv/bin/pip install -r services/orchestrator/requirements-dev.txt
./scripts/dev_up.sh
```

| | |
| --- | --- |
| Insights chat | <http://localhost:8080/> |
| Admin console | <http://localhost:4004/> (`admin` / `admin`) |
| Smoke test | `./scripts/smoke.sh` |
| Tests | `cd services/orchestrator && ../../.venv/bin/python -m pytest -q` |

To use real data and a real model, set `SAP_HUB_API_KEY` +
`S4_ACCESS_MODE=hub_direct` and `OPENROUTER_API_KEY` + `LLM_PROVIDER=openrouter`
in `.env` (see [.env.example](.env.example)).

## Architecture

- [Architecture pack](docs/architecture/README.md)
- [Four-week delivery plan](docs/architecture/Four_Week_Delivery_Plan.md)
- [FAQ](docs/architecture/FAQ_and_Clarifications.md)

## S/4 APIs

Standard APIs from **[SAP Business Accelerator Hub](https://api.sap.com)** — see [docs/api/hub/API_CATALOG.md](docs/api/hub/API_CATALOG.md).

## Repo layout

```text
apps/admin-cap/          # CAP admin: BO/OData registry, rate limits, cache, log
apps/approuter/          # Approuter config + Insights chat UI
services/orchestrator/   # FastAPI + LangGraph pipeline and adapters
integration/cpi/         # Thin CPI iFlow (Day 14)
infra/                   # Terraform + scripts (Day 2+)
deploy/cf/               # Cloud Foundry (Day 5)
deploy/kyma/             # Kyma (Day 16)
docs/api/hub/            # Hub EDMX, catalog, samples
docs/architecture/       # Design pack
docs/requirements/       # Source requirements
scripts/                 # dev_up.sh, smoke.sh
```

## AI coding assistants

| Tool | Entry |
| --- | --- |
| All / OpenCode | [AGENTS.md](AGENTS.md) |
| Cursor | [.cursor/rules](.cursor/rules/), [.cursor/skills](.cursor/skills/) |
| GitHub Copilot | [.github/copilot-instructions.md](.github/copilot-instructions.md), [.github/agents](.github/agents/) |
| Claude Code | [CLAUDE.md](CLAUDE.md) |
| OpenCode | [.opencode/](.opencode/) + AGENTS.md |

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
