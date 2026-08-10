# Infrastructure

Onboarding a client is a config directory plus four scripts. If onboarding
someone requires editing a script, that is a bug in the product, not a task.

## Onboard

```bash
cp -r infra/client-config/_template infra/client-config/acme
$EDITOR infra/client-config/acme/client.yaml
cf login --sso -a <client api endpoint>
cf target -o <org> -s <space>
./infra/scripts/onboard.sh acme
```

Add `--dry-run` to see every step without creating anything.

## What runs

| Script | Does |
| --- | --- |
| `onboard.sh` | Preflight, then provision → deploy → seed → smoke |
| `provision.sh` | Terraform: XSUAA, database, cache, destination |
| `deploy.sh` | `mbt build` + `cf deploy`, then verifies the apps are actually running |
| `seed.sh` | Validates and registers client-specific iFlow endpoints |
| `smoke.sh` | Nine checks against the live landscape |

Terraform owns what lives between releases. It does **not** push applications:
those change every release and belong in `deploy.sh`, where a bad build is a
rollback rather than a state-file conflict (ADR-014).

State is written per client (`infra/client-config/<client>/terraform.tfstate`),
so two clients can never share one state file.

## Secrets

None of them are in this repository or in `client.yaml`. Config stores the
**name** of an environment variable; the runtime reads the value at call time:

```bash
cf set-env factorypilot-srv OPENROUTER_API_KEY '<key>'
cf set-env factorypilot-srv CPI_CLIENT_ID      '<id>'
cf set-env factorypilot-srv CPI_CLIENT_SECRET  '<secret>'
cf restage factorypilot-srv
```

`credentialRef: CPI` expands to `CPI_CLIENT_ID` and `CPI_CLIENT_SECRET`.

## Two things no script can do

1. **Assign role collections** to real users, in the BTP cockpit. Without it a
   user authenticates and then gets 403 on every call.
2. **Set the secrets** above.

Both are printed at the end of `onboard.sh` so they are not forgotten.

## Preflight catches

- CF pointed at a different org than `client.yaml` names — the classic way to
  deploy into someone else's landscape.
- A requested adapter the subaccount is not entitled to, before anything is
  created rather than halfway through.
