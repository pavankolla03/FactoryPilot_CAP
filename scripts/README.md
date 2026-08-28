# Scripts

| Script | Purpose |
| --- | --- |
| `release.sh` | Decide whether a version tag would be telling the truth: tests, seed and router validation, end-to-end behaviour against a running instance, whether the deployed app is this commit, and a CHANGELOG entry. Tags locally on success; pushing is left to you. |
| `e2e.js` | Drive a **running** instance over HTTP and assert it behaves: grounded answers, cache hit, honest refusal, write stops for confirmation, approval applies once and cannot be replayed, one audit row per request. `--url` for a deployed instance, `--user`/`--pass` or `--token` for auth. |
| `hub-probe.js` | Call the SAP Business Accelerator Hub sandbox for every registered business object: proves the key and path work, and reports any `defaultFilters` / `selectFields` name that does not exist upstream. `--capture` saves the real payloads beside the synthetic ones. Needs `SAP_HUB_API_KEY`. |
| `demo-check.sh` | Pre-demo check: toolchain, seeds, fixtures, tests, all seven demo questions end to end, every page. `--remote` also checks the deployed BTP app. |
| `make-demo-fixtures.js` | Regenerate the synthetic fixtures under `docs/api/hub/*/`. Deterministic — the same run produces the same file. |
| `btp_account_report.sh` | Read-only report of what a BTP subaccount is entitled to. |

Deployment and onboarding scripts live in [`infra/scripts/`](../infra/scripts/):
`onboard.sh`, `provision.sh`, `deploy.sh`, `seed.sh`, `smoke.sh`.
