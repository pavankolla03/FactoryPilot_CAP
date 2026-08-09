# FactoryPilot CAP services

Five CAP services in one project — one deployable, one auth chain, one database.
This is the target for migrating the `version4` web app off Netlify + Render
onto BTP.

## Services

| Service | Path | Owns |
| --- | --- | --- |
| **ConfigService** | `/odata/config` | OData/business-object registry, connections, cache policy |
| **TokenService** | `/odata/token` | Quota policy, consumption, token usage, model routing, API key refs |
| **AdminService** | `/odata/admin` | Users, warehouse scopes, approval policy, org settings |
| **AuditService** | `/odata/audit` | Session log, agent runs and steps, pending actions, feedback |
| **InsightsService** | `/insights` | The agent loop — `ask`, `confirmAction` |

They are separate because they are separate jobs. A functional consultant
registering an OData service should not thereby be able to change quotas or
promote an administrator, and the audit trail should not be writable by anything
that can write config.

## Run

```bash
npm install
npx cds deploy --to sqlite:db/factorypilot.db   # schema + seed
npx cds watch
```

<http://localhost:4004>. Mocked users: `admin/admin`, `viewer/viewer`,
`bob/bob` (business user: write scope on warehouse 1000, read-only on 1010,
5 requests/day).

Nothing external is required — SQLite, an offline model and a fixture backend
cover the whole flow.

## The agent loop

`InsightsService.ask` runs inside CAP as a custom handler:

```
quota reserve → tool catalogue → model → read tools → model → answer
                                            │
                                       write tool → PendingAction card, loop stops
```

Facts worth knowing about it:

- **Quota is reserved before anything else runs**, so a user over their limit
  costs nothing to refuse, and the reservation is reconciled against real token
  usage afterwards — including refunding it in full when a run fails.
- **A write never executes inline.** The loop stops and records a
  `PendingAction`. `confirmAction` is the only path that mutates a backend, and
  it consumes the action with a conditional `UPDATE`, so a double-click cannot
  post the same goods movement twice.
- **Most-restrictive-wins policy merge.** ORG, WAREHOUSE and USER policies stack;
  a permissive user policy cannot widen what the org allows.
- **Anomalous writes are never auto-approved**, whatever the policy says.
- **Every request writes exactly one `SessionLog` row**, including failures, and
  each row records whether the answer was `grounded` in tool output.

## Tools come from the registry

Each active `BusinessObjectConfig` with `exposedAsTool` becomes one agent tool.
Onboarding a module gives the agent a new capability with no code change — that
is the point of the registry.

## Adapters

| Concern | Selected by | Options |
| --- | --- | --- |
| Model | `LLM_PROVIDER` env, else the active `ModelRoute` | `openrouter`, offline |
| Backend | the `Connection` row on each business object | `mock`, `hub_sandbox`, `cpi` |
| Database | `cds.requires.db` / `--profile production` | SQLite (dev), PostgreSQL (BTP) |

An explicit `LLM_PROVIDER` always wins and a missing key there is an error, not
a silent downgrade. Without it, a `ModelRoute` asking for OpenRouter with no key
present falls back to the offline provider, logs a warning once, and records
`fake` as the provider in the audit row — so a report never implies a model ran
when none did.

## Tests

```bash
npm test
```

34 tests: quota windows, filter templating, policy merge, history sanitising,
tool choice, and the services end to end — including that a replayed
confirmation is refused and that every request leaves exactly one audit row.

## Deploying to PostgreSQL

```bash
npx cds deploy --to postgres --profile production
```

`@cap-js/postgres` is a runtime dependency; the CDS model is the source of
truth for the schema, replacing `infra/db/schema.sql` from the web app repo.

## Not done yet

- **Socket.IO streaming.** The web app streams tokens over `/ws`.
  `@cap-js-community/websocket` (v1.11.1) is the CAP equivalent and keeps the
  existing event names, but it is not wired up — `ask` currently returns a
  complete answer.
- **The remaining 15 modules** from `version4`: ESG, slotting, stockout radar,
  scenario studio, suppliers, alerts, scheduled reports, MCP tool servers.
- **Fiori Elements app descriptors.** The annotations are in place and reach
  `$metadata`; the generated apps under `app/` are not scaffolded.
- **React frontend serving.** The SPA is not yet copied in or routed.
- **XSUAA.** Configured for the `production` profile but only tested against
  mocked auth.
