# Getting a SAP Business Accelerator Hub API key

The Hub sandbox is SAP's public, read-only copy of an S/4HANA system. It is how
you check that the OData service paths and field names this product queries by
actually exist, without needing a real S/4 tenant.

**It is not optional to authenticate.** Verified against the live sandbox:

| Request | Response |
| --- | --- |
| No `APIKey` header | `401 steps.oauth.v2.FailedToResolveAPIKey` |
| Wrong `APIKey` | `401 oauth.v2.InvalidApiKey` |

The key is free, tied to your SAP user, and one key works for every API in the
sandbox.

## Get the key

1. Go to <https://api.sap.com> and sign in. A free SAP account is enough — no
   BTP subaccount, no licence, no cost.
2. Open any S/4HANA Cloud API — for example search for **Material Stock**
   (`API_MATERIAL_STOCK_SRV`).
3. Open the **Try Out** / **API Reference** area for that API.
4. Find **Show API Key** (SAP has moved this button between the top-right of
   the page and inside the Try Out panel; if you cannot see it, look for a key
   icon or your avatar menu). Copy the value.
5. Keep it in a password manager. It is a credential: anyone holding it can
   spend your sandbox quota.

## Use it

```bash
export SAP_HUB_API_KEY='...'
node scripts/hub-probe.js
```

That calls the sandbox for every active business object and reports two things:
whether the service path resolves, and whether every field named in
`defaultFilters` and `selectFields` actually exists upstream.

The second is the reason the key matters. OData does not fail loudly on a
filter column that does not exist — it returns zero rows. The product then
answers "no records matched", which a warehouse supervisor reads as *there is
no stock* rather than *that column name is wrong*.

Add `--capture` to save the real responses beside the synthetic fixtures in
`docs/api/hub/*/`, so the offline demo replays genuine payload shapes.

## Do not commit it

`.env.example` documents the variable; the value belongs in your shell, a
password manager, or a GitHub Actions secret named `SAP_HUB_API_KEY`. CI runs
the probe when that secret exists and skips it otherwise, so a fork without the
secret still goes green.

## Optional extras

- Download the **EDMX** for an API into `docs/api/hub/<object>/` if you want the
  full metadata document in the repo. Nothing in the build requires it.
- Extend [API_CATALOG.md](API_CATALOG.md) as you add objects.
