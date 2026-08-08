# FactoryPilot

AI-Assisted S/4HANA Business Insights on SAP BTP (SCM-first, module-reusable).

**Branch (Day 1):** `feature/001-repo-and-hub-workspace`

## Architecture

- [Architecture pack](docs/architecture/README.md)
- [Four-week delivery plan](docs/architecture/Four_Week_Delivery_Plan.md)
- [FAQ](docs/architecture/FAQ_and_Clarifications.md)

## S/4 APIs

Standard APIs from **[SAP Business Accelerator Hub](https://api.sap.com)** — see [docs/api/hub/API_CATALOG.md](docs/api/hub/API_CATALOG.md).

## Repo layout

```text
apps/admin-cap/          # CAP admin + Fiori (Day 3+)
apps/approuter/          # Approuter (Day 5+)
services/orchestrator/   # FastAPI + LangGraph (Day 4+)
integration/cpi/         # Thin CPI iFlow (Day 10+)
infra/                   # Terraform + scripts
deploy/cf/               # Cloud Foundry
deploy/kyma/             # Kyma
docs/api/hub/            # Hub EDMX, catalog, samples
docs/architecture/       # Design pack
docs/requirements/       # Source requirements
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
