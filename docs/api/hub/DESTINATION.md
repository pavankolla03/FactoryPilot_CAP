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

## Smoke (Day 2)

```bash
export SAP_HUB_API_KEY=...
./scripts/hub_smoke_delivery.sh
```
