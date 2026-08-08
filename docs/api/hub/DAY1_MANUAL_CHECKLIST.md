# Day 1 — Manual Hub steps (you)

CI and repo scaffold are in place. Complete these on [api.sap.com](https://api.sap.com):

1. Sign in and create/open a Hub application → copy **API Key** (password manager only).
2. Open **Outbound Delivery** / `API_OUTBOUND_DELIVERY_SRV`.
3. **Try Out** `GET A_OutbDeliveryHeader?$top=5`.
4. Download **EDMX** into `docs/api/hub/delivery/`.
5. Fill Try Out notes + communication scenario in `docs/api/hub/delivery/README.md`.
6. Add Hub links for Sales / PO candidates into `API_CATALOG.md` if time.

Do **not** commit the API key. Day 2 will create the BTP Destination and `hub_smoke_delivery.sh`.
