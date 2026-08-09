# CAP Admin app

The admin console backend and the **OData business-object registry** — the
thing that makes adding a business object a config row instead of a code
deploy (ADR-016).

## Run

```bash
npm install
npx cds deploy --to sqlite:db/factorypilot.db   # schema + seed data
npx cds watch
```

Then <http://localhost:4004>. Mocked users: `admin/admin` (full),
`viewer/viewer` (read-only), `bob/bob` (business user — gets 403 here by
design).

## Entities

| Entity | Purpose |
| --- | --- |
| `BusinessObjectConfig` | OData/BO registry: service path, entity set, keywords, filters, prompt hints |
| `UserRateLimitConfig` | Day/week/month caps per user, role or `DEFAULT` |
| `UserConsumption` | Durable counters the dashboard reads |
| `CacheConfig` | TTL and key strategy per object / query pattern |
| `CommunicationLog` | One row per request — written by the orchestrator |

`UsageByObject` aggregates the log for the dashboard overview.

## Seeded data

| Object | Service | Status |
| --- | --- | --- |
| `DELIVERY` | `API_OUTBOUND_DELIVERY_SRV` / `A_OutbDeliveryHeader` | **Active** |
| `SALES` | `API_SALES_ORDER_SRV` / `A_SalesOrder` | Inactive stub |
| `PURCHASING` | `API_PURCHASEORDER_PROCESS_SRV` (verify on Hub) | Inactive stub |
| `SHIPPING`, `GOODS_MOVEMENT` | TBD on Hub | Inactive, no service path |

Service paths and entity sets come from
[API_CATALOG.md](../../docs/api/hub/API_CATALOG.md). Confirm each against the
downloaded EDMX before activating — the plan's rule is never to invent an
OData path.

## Authorization

Scopes are enforced with `@restrict`, not hidden UI: `ConfigRead` /
`ConfigMaintain` for the registry, `RateLimitMaintain`, `CacheMaintain`,
`DashboardRead` / `DashboardAdmin` for the log. A business user has none of
them and cannot read this service at all.

## testConnection

The action calls `$metadata` on the configured Hub URL. Without
`SAP_HUB_API_KEY` it reports that plainly rather than returning a false green —
an admin who sees "ok" will assume the destination is wired.

## Not yet done

- Draft-enabled editing (`@odata.draft.enabled`) — deferred to keep the
  orchestrator's direct reads simple.
- Fiori Elements app descriptors (`app/` manifests). Annotations are in place,
  so a generated FE app will pick up list/object pages as configured.
