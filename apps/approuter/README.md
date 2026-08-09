# Approuter

SSO front door and the single product frontend: **Insights** for business
users, **Admin console** for administrators, separated by scope rather than by
deploying two apps (ADR-015).

## Contents

| File | Purpose |
| --- | --- |
| `xs-app.json` | Routes `/insights/*` → orchestrator, `/odata/admin/*` → CAP, everything else → `resources/` |
| `xs-security.json` | Scopes, role templates and role collections |
| `resources/insights/index.html` | The Insights chat UI |

## Running the UI locally

The Approuter itself needs XSUAA, so local development skips it: the
orchestrator mounts `resources/insights` at `/` and serves the same file.

```bash
.venv/bin/python -m uvicorn app.main:app --app-dir services/orchestrator --port 8080
# → http://localhost:8080/
```

The page calls `insights/query` with a **relative** URL, so it works unchanged
behind the Approuter in BTP and behind the orchestrator locally.

## Roles

| Role collection | Sees |
| --- | --- |
| `FactoryPilot_BusinessUser` | Insights only; own usage |
| `FactoryPilot_Viewer` | Read-only config and dashboard |
| `FactoryPilot_Administrator` | Everything, including config writes |

The `warehouse` attribute on a user becomes their default shipping point when
a question does not name one.

## Not yet done

Deploying this needs an XSUAA instance and destinations for the two backends
(`factorypilot-orchestrator`, `factorypilot-admin-cap`) — Day 5 and Day 13 of
the delivery plan. `npm install` is not run here yet.
