# Running IntelliOps4 on someone else's cloud

IntelliOps4 needs two pieces of infrastructure and is deliberately incurious
about who runs them:

| | What it holds | Losing it means |
|---|---|---|
| **PostgreSQL** | The system of record — users, quotas, business-object config, every audit row, every chat turn, token usage | Data loss. This is the thing to back up. |
| **Redis** | Cached answers, nothing else | Slower answers. Every entry can be rebuilt by asking the question again. |

Both speak standard wire protocols, so **AWS RDS / ElastiCache, Google Cloud SQL
/ Memorystore, and Azure Database for PostgreSQL / Azure Cache for Redis all
work without a code change**. What follows is how to point the app at them, and
how to prove it before you deploy rather than after.

Redis is genuinely optional. With nothing bound the app uses an in-process
cache: correct on a single instance, but nothing is shared between instances and
everything is lost on restart. A client with no Redis entitlement can still run
the product.

---

## Prove it first

Both stores have a probe that walks the layers — config, DNS, TCP, TLS, auth,
a real round trip — and stops at the first failure with advice specific to it.
Run these **before** deploying. A deploy either works, or you already know which
layer will stop it.

```bash
node scripts/postgres-probe.js
```

```bash
node scripts/redis-probe.js
```

Run them from where the app runs, because that is the network that matters:

```bash
cf ssh factorypilot-srv -c "cd app && node scripts/postgres-probe.js"
```

Neither prints a password. Both exit non-zero on failure.

To see what is actually stored once you are running:

```bash
node scripts/inspect-stores.js
```

---

## Cloud Foundry: point the app at an external store

The application binds services by **name**, not by provider. Register the
client's database as a user-provided service under the name the app already
expects, and nothing else changes.

```bash
cf create-user-provided-service factorypilot-postgres -p '{"uri":"postgres://USER:PASSWORD@HOST:5432/DBNAME"}'
```

```bash
cf create-user-provided-service factorypilot-redis -p '{"uri":"rediss://:PASSWORD@HOST:6380"}'
```

Then restage so the new bindings are read:

```bash
cf restage factorypilot-srv
```

`mta.yaml` already declares both as `existing-service`, so a user-provided
service with the right name is picked up with no descriptor change.

### Outside Cloud Foundry

Set environment variables instead — same resolution, no binding required:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` |
| `REDIS_URL` | `rediss://:pass@host:6380` |
| `REDIS_CA_CERT` | PEM of the CA that signed the Redis certificate |
| `PGSSLROOTCERT` | Path to the CA file for Postgres |

An explicit URL always wins over a service binding, because someone who set one
is overriding on purpose.

---

## Per-cloud notes

The connection strings are boring. The two things that actually go wrong are
**TLS trust** and **network reach**, and they go wrong the same way everywhere.

### AWS — RDS for PostgreSQL, ElastiCache for Redis

```bash
cf create-user-provided-service factorypilot-postgres \
  -p '{"uri":"postgres://io4:PASSWORD@mydb.abc123.eu-west-1.rds.amazonaws.com:5432/io4"}'
```

- RDS requires TLS and presents a certificate signed by the **Amazon RDS root
  CA**, which is not in the public trust store. Download the regional bundle
  from AWS and set `PGSSLROOTCERT` to it, or paste the PEM into the binding as
  `sslrootcert`.
- ElastiCache with encryption in transit uses `rediss://` on **6380**, and with
  an auth token the password goes in the URL. Without encryption it is
  `redis://` on 6379 — but then traffic is plaintext, so only inside a VPC.
- ElastiCache in **cluster mode** is not supported by this client. Use a
  non-clustered replication group.
- Reach: the security group must allow inbound from the Cloud Foundry egress
  addresses for your region. This is the single most common failure, and it
  looks like a timeout, not a refusal.

### Google Cloud — Cloud SQL for PostgreSQL, Memorystore for Redis

```bash
cf create-user-provided-service factorypilot-postgres \
  -p '{"uri":"postgres://io4:PASSWORD@34.12.34.56:5432/io4"}'
```

- Cloud SQL: use the **public IP with an authorised network**, or the Cloud SQL
  Auth Proxy. The proxy is a sidecar, which Cloud Foundry does not give you, so
  from BTP the public IP with an allow-list is the practical route.
- Its server certificate is signed by a per-instance CA — download it from the
  instance's Connections page and set `PGSSLROOTCERT`.
- Memorystore has **no public IP at all**. It is reachable only from inside its
  VPC, so from SAP BTP it needs a VPN or interconnect. If that is not in place,
  run without Redis rather than pretending: the in-process cache is a supported
  configuration.

### Azure — Azure Database for PostgreSQL, Azure Cache for Redis

```bash
cf create-user-provided-service factorypilot-postgres \
  -p '{"uri":"postgres://io4:PASSWORD@myserver.postgres.database.azure.com:5432/io4"}'
```

- Flexible Server enforces TLS. Its certificate chains to **DigiCert Global Root
  G2**, which *is* in the public trust store, so usually no CA file is needed —
  the one cloud where this is not a fight.
- Single Server (the retired tier) wants the username as `user@servername`.
  Check which tier you are on before blaming the password.
- Azure Cache for Redis: TLS on **6380**, and the access key is the password.
  Port 6379 is disabled by default and should stay that way.
- Reach: add a firewall rule for the Cloud Foundry egress addresses, or use a
  private endpoint plus a network path.

---

## After pointing at a new database

An empty database is not an error — it is the state before the first deploy.
Create the schema and load seed data:

```bash
npm run deploy:pg --prefix apps/cap
```

Then confirm:

```bash
node scripts/postgres-probe.js
```

It reports the table count, so "reachable but empty" — the failure that looks
like success right up until the first question — is visible rather than
inferred.

---

## What is *not* portable

Be straight with a client about these:

- **XSUAA** is SAP BTP's identity service. Running the app outside BTP means
  replacing the authentication kind, which is a real piece of work, not a
  config switch.
- **SAP Graph / the Business Accelerator Hub** are how the app reads S/4HANA.
  They are SAP services regardless of where this application runs.
- **The destination service** used for outbound calls is a BTP service.

In other words: the *data stores* are portable today, and the *SAP integration*
is SAP's by definition. A client asking "can we keep our data in our own cloud?"
can be told yes. A client asking "can we run this entirely off SAP BTP?" is
asking a much larger question.
