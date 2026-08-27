# Scripts

| Script | Purpose |
| --- | --- |
| `demo-check.sh` | Pre-demo check: toolchain, seeds, fixtures, tests, all seven demo questions end to end, every page. `--remote` also checks the deployed BTP app. |
| `make-demo-fixtures.js` | Regenerate the synthetic fixtures under `docs/api/hub/*/`. Deterministic — the same run produces the same file. |
| `btp_account_report.sh` | Read-only report of what a BTP subaccount is entitled to. |

Deployment and onboarding scripts live in [`infra/scripts/`](../infra/scripts/):
`onboard.sh`, `provision.sh`, `deploy.sh`, `seed.sh`, `smoke.sh`.
