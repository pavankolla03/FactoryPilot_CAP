# SAP Business Accelerator Hub — API catalog

Living catalog of standard APIs used by FactoryPilot.  
Hub: https://api.sap.com

**Rule:** Register these in CAP `BusinessObjectConfig`; do not invent custom OData service paths.

| objectCode | moduleDomain | Hub API (verify name on site) | OData service | Entity set (typical) | Sandbox / status | Spec folder |
| --- | --- | --- | --- | --- | --- | --- |
| `DELIVERY` | SCM | Outbound Delivery | `API_OUTBOUND_DELIVERY_SRV` | `A_OutbDeliveryHeader` | **P0 — Day 1–2** Try Out + EDMX | [delivery/](./delivery/) |
| `SALES` | SCM | Sales Order | `API_SALES_ORDER_SRV` (confirm) | TBD | Stub link only | TBD Week 2+ |
| `SHIPPING` | SCM | Shipping / Transportation | TBD on Hub | TBD | Stub | TBD |
| `GOODS_MOVEMENT` | SCM | Material Document / Goods Movement | TBD on Hub | TBD | Stub | TBD |
| `PURCHASING` | SCM | Purchase Order | TBD on Hub (e.g. `API_PURCHASEORDER_PROCESS_SRV`) | TBD | Stub | TBD |

## Day 1 checklist (manual — do on Hub)

1. Sign in at https://api.sap.com  
2. Create / open a Hub **application** and copy the **API Key** (store only in password manager / BTP Destination / GitHub Secret `SAP_HUB_API_KEY` — never commit).  
3. Search **Outbound Delivery** → open `API_OUTBOUND_DELIVERY_SRV`.  
4. **Try Out** → `GET A_OutbDeliveryHeader?$top=5`.  
5. Download **EDMX** into `docs/api/hub/delivery/` (replace placeholder).  
6. Record communication scenario ID (e.g. `SAP_COM_0106` if shown) in the Delivery README.  
7. Note sandbox base URL (typical):  
   `https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV`

## Destination (Day 2)

See [DESTINATION.md](./DESTINATION.md) (scaffold). Name: `SAP_ACCELERATOR_HUB_SANDBOX`.

## Sample filter ideas (Delivery)

```text
$top=50
$select=DeliveryDocument,OverallGoodsMovementStatus,ShippingPoint,DeliveryDate
$filter=ShippingPoint eq 'XXXX'  (adjust once sandbox fields known)
```
