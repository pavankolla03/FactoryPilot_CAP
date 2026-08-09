# Insights orchestrator (FastAPI + LangGraph)

Owns the query pipeline: intent → config → rate limit → cache → S/4 → LLM →
audit. Build target is the hybrid architecture — CPI stays a thin OData
adapter and never sees the LLM, the cache, or the quota.

## Run

From the **repo root** (paths in config are repo-root-relative):

```bash
python3 -m venv .venv
.venv/bin/pip install -r services/orchestrator/requirements-dev.txt
(cd apps/admin-cap && npm install && npx cds deploy --to sqlite:db/factorypilot.db)
.venv/bin/python -m uvicorn app.main:app --app-dir services/orchestrator --port 8080
```

Then open <http://localhost:8080/> for the Insights chat, or use the API:

```bash
curl -X POST http://localhost:8080/insights/query \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: bob' -H 'X-User-Roles: BusinessUser,InsightsQuery' \
  -d '{"questionText":"How many deliveries today in my warehouse?","filters":{"warehouse":"1000"}}'
```

Defaults need no SAP account, no BTP and no external service.

## Endpoints

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `POST` | `/insights/query` | `InsightsQuery` | Ask a question |
| `GET` | `/insights/usage/me` | `InsightsReadOwnUsage` | Own quota and consumption |
| `GET` | `/insights/health` | — | Liveness for CF/Kyma probes |

Response shapes are frozen in
[Component_Contracts.md](../../docs/architecture/Component_Contracts.md) §2.

## Adapters

Every one is selected by config; business logic never imports a vendor SDK
(ADR-005/006/007/019).

| Concern | `env` | Options |
| --- | --- | --- |
| LLM | `LLM_PROVIDER` | `fake`, `openrouter`, `aicore` |
| S/4 | `S4_ACCESS_MODE` | `fake`, `hub_direct`, `cpi` |
| Database | `DB_ENGINE` | `sqlite`, `postgres` |
| Cache + counters | `CACHE_ENGINE` | `memory`, `redis` |

`fake` is not a placeholder that returns canned text — the offline LLM reads
the actual OData rows and computes real counts, and the fixture client really
filters by shipping point and date. The pipeline, cache keys and token
accounting all exercise real values without a key.

## Going live

| To do this | Set |
| --- | --- |
| Real LLM answers | `LLM_PROVIDER=openrouter` + `OPENROUTER_API_KEY` |
| Real S/4 data | `S4_ACCESS_MODE=hub_direct` + `SAP_HUB_API_KEY` (see [DAY1_MANUAL_CHECKLIST](../../docs/api/hub/DAY1_MANUAL_CHECKLIST.md)) |
| Route through CPI | `S4_ACCESS_MODE=cpi` + `CPI_URL` |
| Multi-replica quotas | `CACHE_ENGINE=redis` + `REDIS_URL` |

## Layout

```text
app/
  main.py                 # FastAPI app, lifespan, static Insights UI mount
  config.py               # the whole configuration matrix
  api/routes/insights.py  # HTTP contract
  auth/context.py         # identity; dev headers now, XSUAA on Day 13
  graph/
    pipeline.py           # LangGraph wiring and routing
    nodes.py              # the eight pipeline nodes
    state.py              # graph state + Deps
  services/
    intent.py             # keyword match, optional LLM fallback
    filters.py            # OData filter templating
    cache_key.py          # key material and TTL policy
    rate_limit.py         # reserve / rollback / reconcile
  adapters/{llm,db,cache,s4}/
```

## Tests

```bash
cd services/orchestrator && ../../.venv/bin/python -m pytest -q
```

64 tests, no network and no Node required — the suite builds its own SQLite
schema from the same DDL `cds deploy` emits, and `test_schema_parity_with_
deployed_cap_database` fails if the two drift apart.

## Known gaps

- `AUTH_MODE=xsuaa` raises 501 — real JWT/JWKS validation is Day 13.
- No HANA repository yet; the interface is there and Day 16 adds it.
- The AI Core adapter is implemented but has only been exercised against
  unit tests, not a live tenant.
