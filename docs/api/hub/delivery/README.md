# Outbound Delivery — Hub API workspace

| Item | Value |
| --- | --- |
| objectCode | `DELIVERY` |
| Hub search | Outbound Delivery |
| Service | `API_OUTBOUND_DELIVERY_SRV` |
| Entity | `A_OutbDeliveryHeader` |
| Sandbox root (typical) | `https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV` |
| Auth | Header `APIKey: <Hub application key>` |

## Files to add (Day 1 PM / Day 2)

| File | Status |
| --- | --- |
| `API_OUTBOUND_DELIVERY_SRV.edmx` | **Download from Hub** — place here |
| `openapi.yaml` or `.json` | Optional if Hub provides |
| `sample_response.json` | From Try Out / curl (Day 2) — sanitize PII |
| `sample_response.synthetic.json` | Present — **synthetic, not a real capture** (see below) |

## About `sample_response.synthetic.json`

Machine-generated placeholder data in the `A_OutbDeliveryHeader` shape, so the
orchestrator's `S4_ACCESS_MODE=fake` path runs the full pipeline with no Hub
account. **It is not a capture from a real Try Out or any customer system** and
must never be presented as one.

72 rows across shipping points 1000 / 1010 / 2000 and goods-movement statuses
A / B / C. Dates are rebased to the current day at read time, so "today"
questions keep returning rows however old the file gets.

Replace it with a real `sample_response.json` once `SAP_HUB_API_KEY` exists,
and switch to `S4_ACCESS_MODE=hub_direct`.

## Try Out notes

Paste results of your first successful Try Out here (date, `$select` used, row count):

```text
(pending — complete on api.sap.com)
```

## Communication scenario

```text
(pending — copy from Hub page, e.g. SAP_COM_0106)
```
