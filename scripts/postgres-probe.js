#!/usr/bin/env node
/**
 * Verify a PostgreSQL that IntelliOps4 is meant to run against — before deploying.
 *
 * The product does not care whose Postgres it is. On SAP BTP it binds a managed
 * instance; a client who would rather keep their data on AWS RDS, Google Cloud
 * SQL or Azure Database for PostgreSQL registers theirs as a user-provided
 * service and nothing in the application changes. That is the whole of the
 * "plug and play" claim, and this script is what makes it checkable rather than
 * hopeful: run it against the client's database first, and a deploy either
 * works or you already know which layer will stop it.
 *
 * Layers, in order, stopping at the first failure:
 *
 *   1. config    what are we connecting to, and from where
 *   2. DNS       does the host resolve
 *   3. TCP       does the port accept a connection
 *   4. TLS       is the certificate trusted (managed Postgres almost always requires TLS)
 *   5. AUTH      do the credentials work
 *   6. query     can it actually read, and is the schema deployed
 *
 *   node scripts/postgres-probe.js
 *   DATABASE_URL=postgres://user:pw@host:5432/db node scripts/postgres-probe.js
 *   cf ssh factorypilot-srv -c "cd app && node scripts/postgres-probe.js"
 *
 * No password is printed. Exit code 0 only if a query succeeds.
 */

const dns = require('node:dns').promises
const net = require('node:net')
const tls = require('node:tls')
const path = require('node:path')

const CAP = path.join(__dirname, '..', 'apps', 'cap')

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', O = '\x1b[0m'
const ok = (s, d) => console.log(`  ${G}PASS${O}  ${s}${d ? `\n        ${D}${d}${O}` : ''}`)
const bad = (s, d) => console.log(`  ${R}FAIL${O}  ${s}${d ? `\n        ${D}${d}${O}` : ''}`)
const note = (s) => console.log(`  ${Y}····${O}  ${s}`)

const TIMEOUT = Number(process.env.PG_PROBE_TIMEOUT_MS || 8000)

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms).unref()),
  ])
}

/**
 * Where the database is, from whichever source actually carries it.
 *
 * The order is deliberate: an explicit URL beats a service binding, because
 * someone who set one is overriding on purpose. On Cloud Foundry the binding
 * is the normal path and works identically whether the instance behind it is
 * SAP's or a `cf cups` pointing at RDS.
 */
function resolvePostgres() {
  const fromUrl = (url, source) => {
    try {
      const u = new URL(url)
      return {
        source, url,
        host: u.hostname,
        port: u.port || '5432',
        database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
        user: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
        // sslmode=disable is the only way to mean "really no TLS"; managed
        // Postgres otherwise requires it and refuses the connection without.
        tls: !/[?&]sslmode=disable\b/.test(url),
      }
    } catch {
      return null
    }
  }

  for (const [envVar, label] of [['DATABASE_URL', 'DATABASE_URL'], ['POSTGRES_URL', 'POSTGRES_URL']]) {
    if (process.env[envVar]) {
      const t = fromUrl(process.env[envVar], envVar)
      if (t) return t
      console.log(`  ${Y}····${O}  ${label} is set but is not a parseable URL — ignoring it.`)
    }
  }

  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}')
    for (const [label, instances] of Object.entries(vcap)) {
      for (const inst of instances || []) {
        const c = inst.credentials || {}
        const source = `VCAP_SERVICES.${label}${inst.name ? ` (${inst.name})` : ''}`
        if (c.uri && /^postgres/.test(c.uri)) {
          const t = fromUrl(c.uri, source)
          if (t) return { ...t, ca: c.sslrootcert || c.ca || undefined }
        }
        if (c.hostname && c.username) {
          return {
            source,
            host: c.hostname,
            port: String(c.port || 5432),
            database: c.dbname || c.database || 'postgres',
            user: c.username,
            password: c.password || '',
            tls: c.sslmode ? c.sslmode !== 'disable' : true,
            ca: c.sslrootcert || c.ca || undefined,
            url: `postgres://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password || '')}` +
              `@${c.hostname}:${c.port || 5432}/${c.dbname || c.database || 'postgres'}`,
          }
        }
      }
    }
  } catch {
    /* malformed VCAP is reported as "nothing bound" rather than a crash */
  }
  return null
}

function adviseTls(err) {
  const c = err.code || ''
  if (c === 'SELF_SIGNED_CERT_IN_CHAIN' || c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || c === 'DEPTH_ZERO_SELF_SIGNED_CERT')
    return 'A private CA signed this certificate. AWS, GCP and Azure each publish their RDS/Cloud SQL/Azure ' +
      'Postgres root certificate — download it and set PGSSLROOTCERT to the file, or put the PEM in the ' +
      'binding as sslrootcert.'
  if (/wrong version number/i.test(err.message))
    return 'This port is not speaking TLS. Append ?sslmode=disable if the server genuinely has TLS off.'
  return err.message
}

async function main() {
  console.log(`\nPostgreSQL probe${D} — timeout ${TIMEOUT}ms per layer${O}\n`)

  const t = resolvePostgres()
  if (!t) {
    bad('config — no database is configured',
      'No DATABASE_URL and no Postgres in VCAP_SERVICES. On Cloud Foundry, bind one — a client database is\n' +
      '        registered with:  cf cups factorypilot-postgres -p \'{"uri":"postgres://user:pw@host:5432/db"}\'')
    process.exit(1)
  }
  ok(`config — ${t.user}@${t.host}:${t.port}/${t.database} ${t.tls ? 'over TLS' : 'plaintext'}`, `from ${t.source}`)
  if (t.tls && !t.ca && !process.env.PGSSLROOTCERT)
    note('TLS with no CA supplied — if the handshake fails below, that is why.')

  let addr = t.host
  if (!net.isIP(t.host)) {
    try {
      const r = await withTimeout(dns.lookup(t.host), TIMEOUT, 'DNS lookup')
      addr = r.address
      ok(`DNS — ${t.host} resolves to ${r.address}`)
    } catch (err) {
      bad(`DNS — ${t.host} does not resolve`,
        err.code === 'ENOTFOUND'
          ? 'The hostname does not exist from here. A managed database is often only resolvable from inside its ' +
            'own VPC or the CF space — run this with cf ssh rather than from a laptop.'
          : err.message)
      process.exit(1)
    }
  } else ok(`DNS — ${t.host} is already an address`)

  try {
    await withTimeout(new Promise((res, rej) => {
      const s = net.connect({ host: addr, port: Number(t.port) })
      s.once('connect', () => { s.destroy(); res() })
      s.once('error', rej)
    }), TIMEOUT, 'TCP connect')
    ok(`TCP — port ${t.port} accepts connections`)
  } catch (err) {
    bad(`TCP — cannot reach ${t.host}:${t.port}`,
      err.code === 'ECONNREFUSED'
        ? 'Nothing is listening there. Wrong port, or the instance is stopped.'
        : 'The packets went nowhere — almost always a security group, firewall rule or VPC boundary. ' +
          'Allow inbound from the Cloud Foundry egress addresses for your region.')
    process.exit(1)
  }

  // Postgres does not open a TLS socket directly: the client connects in
  // plaintext and asks to upgrade. Probing raw TLS on 5432 would fail even on
  // a correctly configured server, so leave the handshake to the driver below
  // and report what it says.
  if (t.tls) note('TLS — negotiated inside the Postgres protocol; verified by the connection below')

  let pg
  try {
    pg = require(require.resolve('pg', { paths: [CAP] }))
  } catch (err) {
    bad('setup — the pg client library could not be loaded', `${err.message}\n        Run npm install in ${CAP} first.`)
    process.exit(1)
  }

  const client = new pg.Client({
    host: addr, port: Number(t.port), database: t.database, user: t.user, password: t.password,
    connectionTimeoutMillis: TIMEOUT,
    ssl: t.tls
      ? {
          ...(t.ca ? { ca: t.ca } : {}),
          servername: t.host,
          rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== '0',
        }
      : false,
  })

  try {
    await withTimeout(client.connect(), TIMEOUT, 'connect')
    ok('AUTH — the server accepted these credentials')
  } catch (err) {
    if (/self.signed|certificate|SSL/i.test(err.message)) bad('TLS — certificate rejected', adviseTls(err))
    else if (/password|authentication|role .* does not exist/i.test(err.message))
      bad('AUTH — rejected', `${err.message}\n        Re-read the credentials from the binding; do not retype them.`)
    else if (/database .* does not exist/i.test(err.message))
      bad('AUTH — connected, but that database does not exist', err.message)
    else bad('AUTH — connection failed', err.message)
    process.exit(1)
  }

  try {
    const v = await withTimeout(client.query('select version()'), TIMEOUT, 'query')
    ok('query — the database answered', String(v.rows[0].version).split(',')[0])

    // Is the model actually deployed here? A reachable but empty database is
    // the failure that looks like success until the first question.
    const tables = await withTimeout(
      client.query(
        "select count(*)::int n from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"
      ), TIMEOUT, 'schema check')
    const n = tables.rows[0].n
    if (n > 0) ok(`schema — ${n} table(s) present`, 'The CDS model looks deployed.')
    else note('schema — the database is empty. Expected before the first deploy; the db-deployer creates the tables.')
  } catch (err) {
    bad('query — the connection opened but a query failed', err.message)
    process.exit(1)
  } finally {
    await client.end().catch(() => {})
  }

  console.log(`\n${G}This PostgreSQL is usable by IntelliOps4.${O}\n`)
}

module.exports = { resolvePostgres }

// Only probe when run directly — inspect-stores.js reuses the resolver above.
if (require.main === module) {
  main().catch((err) => { console.error(`\n${R}probe crashed:${O} ${err.stack || err.message}\n`); process.exit(1) })
}
