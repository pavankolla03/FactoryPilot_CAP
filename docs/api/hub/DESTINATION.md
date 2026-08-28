# BTP Destination — Accelerator Hub sandbox

**Name:** `SAP_ACCELERATOR_HUB_SANDBOX`  
**Created:** Day 2 (scaffold documented Day 1)

## Intended settings (confirm in Cockpit)

| Property | Suggested value |
| --- | --- |
| Type | HTTP |
| URL | `https://sandbox.api.sap.com` **or** full service root (document chosen pattern) |
| Proxy type | Internet |
| Authentication | NoAuthentication (+ API Key via additional header) **or** as required by Hub |
| Additional headers | `APIKey` = Hub application key |

## Secrets

- Local: never commit; use `.env` (gitignored)  
- GitHub Actions: `SAP_HUB_API_KEY`  
- BTP: Destination additional property / credential store  

## Smoke

`scripts/hub_smoke_delivery.sh` was never built. The equivalent, which checks
every registered object rather than just Delivery, is:

```bash
export SAP_HUB_API_KEY=...
node scripts/hub-probe.js
```

See [DAY1_MANUAL_CHECKLIST.md](DAY1_MANUAL_CHECKLIST.md) for how to get the key.
