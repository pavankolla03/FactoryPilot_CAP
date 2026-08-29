# FactoryPilot

AI-assisted S/4HANA business insights on SAP BTP (SCM-first, module-reusable).

Ask an operational question in plain English — *"how much stock do we have for
P123?"* — and get an answer built from your own S/4 data, with the query it ran,
the tokens it cost and whether it was grounded in real records all visible. Any
write is proposed for confirmation, never executed inline.

---

## Run it locally

**No SAP account, no BTP, no credentials, no network.** Everything below was run
against a clean clone; each business object answers from a synthetic fixture.

**You need:** Node 20 or newer, and git.

```bash
git clone --branch version2 https://github.com/pavankolla03/FactoryPilot_CAP.git FactoryPilot && cd FactoryPilot
```

Install dependencies and build the local database:

```bash
cd apps/cap && npm ci && npx cds deploy --to sqlite:db/factorypilot.db && cd ../..
```

Check that everything works before you start it:

```bash
./scripts/demo-check.sh
```

That runs the toolchain, seed integrity, fixtures, the test suite, all seven
demo questions end to end, approving a write, and every page — each line
`PASS`, `WARN` or `FAIL` with the fix beside it. Expect `Demo path is ready`.

Rehearsing spends the same daily request allowance as the real thing, so if it
reports no quota headroom, clear the local usage and run it again:

```bash
./scripts/demo-check.sh --reset-quota
```

Start the server:

```bash
cd apps/cap && FACTORYPILOT_DEMO_MODE=1 CDS_REQUIRES_AUTH_KIND=dummy npx cds serve --port 4004
```

| | |
| --- | --- |
| Insights chat | <http://localhost:4004/insights/index.html> |
| Admin console | <http://localhost:4004/admin/index.html> |
| Monitoring | <http://localhost:4004/dashboard/index.html> |
| Tests | `cd apps/cap && npm test` |
| End-to-end | `node scripts/e2e.js` (against a running instance) |

`Ctrl-C` stops it.

### What those two environment variables do

`FACTORYPILOT_DEMO_MODE=1` makes every endpoint answer from the synthetic
fixtures in `docs/api/hub/*/`, so no S/4 system, iFlow or credential is
involved. The agent loop, quota, cache, approval and audit paths all still run
for real — only the transport is replaced.

`CDS_REQUIRES_AUTH_KIND=dummy` skips authentication. Convenient locally, but it
means **scope enforcement is not being exercised** — "it worked locally" does
not prove the permissions are right. To test real auth, drop that variable and
log in as `admin` / `admin`; the mocked users and their roles are in
[apps/cap/package.json](apps/cap/package.json).

### Questions to try

1. How many deliveries today?
2. How much stock do we have?
3. How much stock do we have for P123?
4. Show me goods movements today
5. What purchase orders are open?
6. Move 250 units of P123 to shipping in warehouse 1000 — *a write; it stops for confirmation*
7. Ask #1 again — *cache hit*

Ask it something it cannot ground (*what is the weather in Berlin?*) and it says
so rather than inventing an answer.

The fixtures are **generated, not captured** — see the `_synthetic` block in each
file. Regenerate them with `node scripts/make-demo-fixtures.js`.

### Checking against the real SAP Hub

The fixtures are generated, so the field names in `defaultFilters` and
`selectFields` follow the published OData services but have not been confirmed
against live data. With a free key from <https://api.sap.com>:

```bash
SAP_HUB_API_KEY='...' node scripts/hub-probe.js
```

It reports, per business object, whether the service path resolves and whether
every field the registry queries by actually exists upstream. That matters
because OData does not fail loudly on a wrong filter column — it returns zero
rows, and the product then says "no records matched" for data that is there.
Add `--capture` to save the real responses beside the synthetic ones.

All five reach the Hub's gateway and are rejected only on authentication, so
the host and base path are right. The service paths and entity sets themselves
are still unconfirmed — the gateway validates the key before routing, so a
401 says nothing about what lies behind it. A real key settles it.

### Real data and a real model

Drop `FACTORYPILOT_DEMO_MODE` to call the endpoints registered in Admin →
Integration. For model-phrased answers instead of the deterministic offline
provider, set `OPENROUTER_API_KEY` and `LLM_PROVIDER=openrouter`, or point
`ModelRoute.provider` at `aicore` to run against a model in your own SAP AI Core
tenant. See [.env.example](.env.example) for every setting.

---

## Deploying to BTP

See [infra/README.md](infra/README.md) for client onboarding, and
[docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) for what a live demo needs.

```bash
./infra/scripts/onboard.sh <client-directory>
```

---

## Architecture

Seven decoupled CAP services — config, tokenisation, admin, audit, insights,
cache, integration — plus a dashboard service. One CDS service and one Fiori app
per capability, so a client can adopt or drop any of them independently.

- [Architecture pack](docs/architecture/README.md)
- [Decisions log](docs/architecture/Decisions_Log.md)
- [Four-week delivery plan](docs/architecture/Four_Week_Delivery_Plan.md)
- [FAQ](docs/architecture/FAQ_and_Clarifications.md)

## S/4 APIs

Standard APIs from **[SAP Business Accelerator Hub](https://api.sap.com)** — see
[docs/api/hub/API_CATALOG.md](docs/api/hub/API_CATALOG.md).

## Repo layout

```text
apps/cap/                # The application: 8 CAP services, Fiori apps, agent loop
  db/                    #   CDS models and seed CSVs
  srv/                   #   services, handlers, and lib/ (agent, llm, backend, cache)
  app/                   #   Insights, Admin, Monitoring + Fiori Elements apps
  test/                  #   unit, service and concurrency tests
infra/                   # Terraform, client onboarding and deploy scripts
deploy/cf/               # How the MTA is deployed
docs/api/hub/            # Hub EDMX, catalog, and the synthetic fixtures
docs/architecture/       # Design pack and decisions log
docs/requirements/       # Source requirements
scripts/                 # demo-check.sh, hub-probe.js, make-demo-fixtures.js
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
