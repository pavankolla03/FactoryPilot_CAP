# Demo runbook

Everything needed to demonstrate FactoryPilot, and what to do when a piece of it
is not available on the day.

---

## The one command to run first

```bash
./scripts/demo-check.sh
```

It checks the toolchain, the seed data, the fixtures, the test suite, quota
headroom, all seven demo questions end to end, **approving a write**, and every
page. `PASS` / `WARN` / `FAIL` with the fix
next to each one. Add `--remote` to check the deployed BTP app as well.

Exit code is non-zero only when something would actually break the demo.

**Rehearsing spends the demo's quota.** Each full run-through costs about nine
requests against a 50/day limit, and the symptom of running out is every
question returning `RATE_LIMITED` — mid-demo, with no warning. Clear the local
usage before you start:

```bash
./scripts/demo-check.sh --reset-quota
```

---

## Two ways to run the demo

### A. Offline — nothing external can break it

```bash
cd apps/cap
FACTORYPILOT_DEMO_MODE=1 CDS_REQUIRES_AUTH_KIND=dummy npx cds serve --port 4004
```

Then open <http://localhost:4004/insights/index.html>.

Every endpoint answers from synthetic fixtures in `docs/api/hub/*/`. No S/4, no
Integration Suite, no credentials, no network. The agent loop, quota, cache,
approval and audit paths all run for real — only the transport is replaced, so
what the audience sees is the actual product, not a mock-up.

**This is the recommended path for a first demo.** It cannot fail because of
someone else's system.

### B. Against the deployed BTP app

Open the approuter URL (`cf apps` shows it). Requires: a live `cf login`, the
role collection assigned to your user, and — for real data — the CPI
credentials set. See *What I need from you* below.

To make the deployed app use fixtures too, so a broken iFlow cannot spoil it:

```bash
cf set-env factorypilot-srv FACTORYPILOT_DEMO_MODE 1 && cf restage factorypilot-srv
```

Unset it with `cf unset-env factorypilot-srv FACTORYPILOT_DEMO_MODE` when the
real backends are ready.

---

## The script

Seven questions, in this order. Each one shows a different part of the product.

| # | Say this | What it demonstrates |
|---|---|---|
| 1 | *How many deliveries today?* | Natural language → the right S/4 object, filtered by date and plant. Point at the **Grounded in data** badge. |
| 2 | *How much stock do we have?* | A different business object, no code change — just configuration. |
| 3 | *How much stock do we have for P123?* | The model extracts the material and narrows the query. Compare the number with #2. |
| 4 | *Show me goods movements today* | A third object; the answer separates movement types and flags reversals. |
| 5 | *What purchase orders are open?* | Money. Open value, top supplier, deleted orders excluded. |
| 6 | *Move 250 units of P123 to shipping in warehouse 1000* | **The important one.** A write is never executed inline — it stops with a confirmation card. Show that nothing has happened yet, then confirm. |
| 7 | Ask #1 again | Cache hit. Point at the **Cache HIT** badge and the response time. |

Then switch tabs:

- **Admin** — the tiles are live counts. Open *Business Objects* and show that
  adding an S/4 object is a row, not a release. Open *Integration* and show that
  a customer's own iFlow is registered by pasting its URL.
- **Monitoring** — requests, tokens, cache hit rate, grounded share, failures.
  This is the answer to "how do we know what it is doing and what it costs?"

### The line that lands

Ask something the system cannot ground, e.g. *what is the weather in Berlin?*
It says it has no data rather than inventing an answer. That is the difference
between this and a chatbot bolted onto SAP.

---

## If something goes wrong on stage

| Symptom | Cause | Fix |
|---|---|---|
| "I could not reach the source system" | The endpoint is unreachable or its credentials are unset. **This is the honest failure, not a bug.** | Switch to demo mode (above). |
| Every answer says *Not grounded* | No business object matched the question. | Use a question from the table; check Admin → Business Objects for keywords. |
| `403 Forbidden` on the deployed app | Role collection not assigned, or assigned after the current login. | Assign it, then log out and back in — the token is minted at login. |
| Chat returns `429` | Daily quota reached. | Admin → Quota Policies, raise the limit, or use a different user. |
| Page loads but tiles are empty | The OData call failed. | Browser console; then `cf logs factorypilot-srv --recent`. |

---

## What I need from you

Nothing below blocks the **offline** demo. It is all for the deployed one.

### Blocking for a deployed demo

1. **A `cf login`.** The session has expired, so nothing built since the cache
   work is deployed. Run it yourself — I will not enter your password:
   ```bash
   cf login --sso -a https://api.cf.us10-003.hana.ondemand.com
   ```
   Then tell me it is done and I will deploy.

2. **Assign yourself the `FactoryPilot_Administrator` role collection**
   (BTP cockpit → Security → Users → your user → Role Collections), then **log
   out and back in**. Without this the chat is `403` for you — the token is
   minted at login, so assigning it while logged in changes nothing.

### Needed only if you want real S/4 data rather than fixtures

3. **A rotated CPI client secret.** The one in the transcript is still live and
   still exposed. Rotate it in the Integration Suite, then:
   ```bash
   cf set-env factorypilot-srv CPI_CLIENT_ID "<new id>"
   cf set-env factorypilot-srv CPI_CLIENT_SECRET "<new secret>"
   cf restage factorypilot-srv
   ```
   Do not paste the value into chat — set it directly.

4. **Confirmation that the four iFlows return data**, and the field names they
   return. The current `defaultFilters` and `selectFields` follow the standard
   S/4 OData field names; if your iFlows reshape the payload, I need one sample
   response per iFlow to correct them.

### Optional, improves the demo

5. **An `OPENROUTER_API_KEY`.** Without it the offline provider answers — from
   real fixture data, correctly, but in fixed phrasing. With it, answers are
   phrased by a real model and follow-up questions work naturally. Set it the
   same way as above, with `cf set-env`.

6. **Who the audience is.** If they are SAP-technical, the Integration and
   Business Objects screens matter most. If they are business stakeholders,
   spend the time on the confirmation card and the Monitoring page instead.

---

## Facts

- Subaccount `674521f2trial`, org `674521f2trial`, space `dev`
- API endpoint `https://api.cf.us10-003.hana.ondemand.com`
- Apps: `factorypilot-srv`, `factorypilot-approuter`
- Role collections: `FactoryPilot_Administrator`, `FactoryPilot_ConfigAdministrator`,
  `FactoryPilot_Viewer`, `FactoryPilot_BusinessUser`
- Fixtures are **generated, not captured** — see the `_synthetic` block in each
  file, and say so if anyone asks whether it is real data.
