# Running on SAP AI Core / Generative AI Hub

## Why a client asks for this

By default IntelliOps4 routes questions to free models on OpenRouter. That means
an operational question — *"how much stock of P123 is in plant 1710"* — leaves
the SAP estate and reaches a third party.

For most clients that is fine, because the question carries a material number
and a plant, not a customer list. For some it is not, and the objection is
usually procurement or data-residency policy rather than a specific risk.

SAP AI Core answers it: the model runs in **the client's own BTP tenant**, under
their own contract, and the question never leaves. Same product, same answers,
same audit rows. What changes is configuration, not code.

**Generative AI Hub** is the part of AI Core that offers foundation models
(GPT, Claude, Gemini, open-weight models) through one endpoint. When people say
"Gen AI Hub keys" they mean an AI Core service key with the Gen AI Hub
entitlement. There is no separate credential type.

## The honest cost note

This is **not free**. AI Core's `extended` service plan is required for
Generative AI Hub, and on a trial account `aicore` is usually not in the
marketplace at all. So:

- **Trial / demo** → OpenRouter free models. What the product runs on today.
- **Client production** → AI Core, on their contract, at their cost.

Do not promise a client zero cost *and* SAP-native inference in the same
sentence. They are two different configurations.

## What you need

Five values. All from the client's BTP subaccount.

| Environment variable | Where it comes from |
|---|---|
| `AICORE_BASE_URL` | Service key → `serviceurls.AI_API_URL` |
| `AICORE_TOKEN_URL` | Service key → `url` (an `authentication.sap.hana.ondemand.com` host) |
| `AICORE_CLIENT_ID` | Service key → `clientid` |
| `AICORE_CLIENT_SECRET` | Service key → `clientsecret` |
| `AICORE_DEPLOYMENT_ID` | AI Launchpad → ML Operations → Deployments |
| `AICORE_RESOURCE_GROUP` | Optional, defaults to `default` |

The one people get wrong is `AICORE_DEPLOYMENT_ID`. It is the **deployment**
(`d1234567890abcde`), not the model name. `gpt-4o` is not a deployment id.

### Getting them

1. **BTP cockpit → Instances and Subscriptions → your AI Core instance →
   Service Keys.** Create one if there is none. Four of the five values are in
   that JSON.
2. **AI Launchpad → ML Operations → Configurations.** Create a configuration
   choosing a foundation model. It must be a **chat model that supports tool
   calling** — see the warning below.
3. **Deployments → Create** from that configuration. Wait for status
   `RUNNING`. Copy the deployment id.

### Tool calling is not optional

Every grounded answer in IntelliOps4 comes from a tool call. The model is asked
*which business object to query*, and the answer is computed from what SAP
returns. A model that cannot call tools does not degrade gracefully — it answers
warehouse questions from its own imagination, fluently and wrongly.

The probe's last check exists precisely for this, and it will refuse a
deployment that will not call a tool.

## Setting it up

```bash
cf set-env factorypilot-srv AICORE_BASE_URL "https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com/v2"
```

Set all five the same way, then restage:

```bash
cf restage factorypilot-srv
```

Secrets go in the environment, never in the database or the repository. The
`credentialRef` mechanism stores only the *name* of the variable pair
(`AICORE` → `AICORE_CLIENT_ID` / `AICORE_CLIENT_SECRET`).

## Verify before routing traffic

```bash
node scripts/aicore-probe.js
```

It walks config → OAuth → deployment status → a real inference call → a real
tool call, and stops at the first failure with advice specific to that layer.
Five values from three cockpit screens fail in ways that do not name the value
that is wrong; this names it.

## Switching traffic over

Two ways, and they mean different things.

**Per route (preferred).** In Admin → Model Routes, set `provider` to `aicore`.
Routes can be selective — heavy questions to AI Core, trivial ones left on a
free model — so a client can adopt it gradually.

**Whole instance.** `LLM_PROVIDER=aicore` pins every request. Pinning promotes
that rung to the front but does not remove the others: a pinned provider that
fails still falls through the chain, so a paused deployment degrades rather than
taking the product down.

Verify what is actually running:

```bash
curl -s https://<approuter>/insights/health | grep -o '"provider":"[a-z]*"'
```

Every answer records its provider and model in the audit log, so
Admin → Session Logs shows what really served each question — not what the
configuration claims.

## What is still shared

Be precise with a client, because "nothing leaves SAP" is close but not exact:

- **The question and the retrieved rows** go to their own AI Core tenant. Not
  to a third party. This is the part they care about.
- **SAP Graph and the Business Accelerator Hub** are still called to read
  S/4HANA — SAP services, their tenant.
- **Nothing else leaves.** With AI Core configured and no OpenRouter key set,
  no external model provider is contacted at all.

That last point is worth checking rather than asserting: unset
`OPENROUTER_API_KEY` in the client's environment. Otherwise it remains in the
chain as a fallback, and a fallback that fires during a demo is exactly the
thing the client asked you to prevent.
