# Cloud Foundry deployment

The deployable is the MTA at [`apps/cap/mta.yaml`](../../apps/cap/mta.yaml) —
three modules (`factorypilot-srv`, `factorypilot-db-deployer`,
`factorypilot-approuter`) against XSUAA, PostgreSQL and an optional Redis.

```bash
cd apps/cap && mbt build -p=cf && cf deploy mta_archives/*.mtar
```

Onboarding a new client landscape is
[`infra/scripts/onboard.sh`](../../infra/scripts/onboard.sh); what a release
must satisfy before it is tagged is
[`scripts/release.sh`](../../scripts/release.sh).

Kyma is not a supported target. The manifests that once lived beside this file
described the Python orchestrator that ADR-023 removed.
