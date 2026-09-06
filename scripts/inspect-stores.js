#!/usr/bin/env node
/**
 * Show what is actually stored, and where.
 *
 * IntelliOps4 keeps its data in two places and they hold very different things:
 *
 *   PostgreSQL   the system of record. Users, quotas, business-object config,
 *                every audit row, every chat turn, token usage. Durable, and
 *                the thing that must be backed up.
 *
 *   Redis        answers only. Every entry is reconstructible by asking the
 *                question again, which is why losing Redis costs latency and
 *                nothing else, and why the app degrades to an in-process cache
 *                rather than refusing to start.
 *
 * The distinction matters when a client asks where their data lives: the answer
 * is Postgres, and Redis holds a disposable copy of answers already given.
 *
 *   node scripts/inspect-stores.js                 # summary of both
 *   node scripts/inspect-stores.js --rows 10       # more sample rows
 *   node scripts/inspect-stores.js --keys          # every cache key, not a sample
 *   cf ssh factorypilot-srv -c "cd app && node scripts/inspect-stores.js"
 *
 * Read-only: it never writes or deletes. Cached answers are business data, so
 * values are shown truncated and only with --show-values.
 */

const path = require('node:path')

const CAP = path.join(__dirname, '..', 'apps', 'cap')
const { resolveRedis } = require(path.join(CAP, 'srv', 'lib', 'cache'))
const { resolvePostgres } = require('./postgres-probe')

const B = '\x1b[1m', G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', C = '\x1b[36m', O = '\x1b[0m'
const arg = (f) => process.argv.indexOf(f) > -1
const argVal = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d }

const SAMPLE_ROWS = Number(argVal('--rows', 5))
const SHOW_VALUES = arg('--show-values')

const head = (s) => console.log(`\n${B}${s}${O}\n${'─'.repeat(Math.min(s.length, 72))}`)
const kv = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`)

/** Fixed-width table that stays readable when a cell is long. */
function table(rows, cols) {
  if (!rows.length) { console.log(`  ${D}(no rows)${O}`); return }
  const w = cols.map((c) => Math.min(Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)), 42))
  const line = (cells) => '  ' + cells.map((c, i) => String(c ?? '').slice(0, w[i]).padEnd(w[i])).join('  ')
  console.log(`${D}${line(cols)}${O}`)
  console.log(`${D}${line(w.map((n) => '─'.repeat(n)))}${O}`)
  for (const r of rows) console.log(line(cols.map((c) => r[c])))
}

async function postgres() {
  head('PostgreSQL — the system of record')
  const t = resolvePostgres()
  if (!t) {
    console.log(`  ${Y}Nothing configured.${O} No DATABASE_URL and no Postgres in VCAP_SERVICES.`)
    return
  }
  kv('host', `${t.host}:${t.port}`)
  kv('database', t.database)
  kv('user', t.user)
  kv('from', t.source)

  let pg
  try { pg = require(require.resolve('pg', { paths: [CAP] })) }
  catch (err) { console.log(`  could not load the pg driver: ${err.message}`); return }

  const client = new pg.Client({
    host: t.host, port: Number(t.port), database: t.database, user: t.user, password: t.password,
    connectionTimeoutMillis: 8000,
    ssl: t.tls ? { ...(t.ca ? { ca: t.ca } : {}), servername: t.host,
      rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== '0' } : false,
  })
  try {
    await client.connect()
  } catch (err) {
    console.log(`  ${Y}could not connect:${O} ${err.message}`)
    console.log(`  ${D}scripts/postgres-probe.js will say which layer is failing.${O}`)
    return
  }

  try {
    // Row counts per table. Postgres has no cheap exact count, and these tables
    // are small, so count() is honest and fast enough; an estimate from
    // pg_class would read as wrong to anyone checking a number they just wrote.
    const { rows: tables } = await client.query(`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`)
    if (!tables.length) {
      console.log(`\n  ${Y}The schema is not deployed here.${O} Run: npm run deploy:pg`)
      return
    }

    const counts = []
    for (const { table_name } of tables) {
      const r = await client.query(`select count(*)::int n from "${table_name}"`)
      if (r.rows[0].n > 0) counts.push({ table: table_name, rows: r.rows[0].n })
    }
    console.log(`\n  ${tables.length} tables, ${counts.length} with data:\n`)
    table(counts.sort((a, b) => b.rows - a.rows), ['table', 'rows'])

    // The tables someone actually asks about, in the order they answer
    // "what has this system been doing?"
    const interesting = [
      ['factorypilot_admin_user', 'Users', ['email', 'displayname', 'isactive']],
      ['factorypilot_token_quotapolicy', 'Quota policies', ['subject', 'limittype', 'dailylimit', 'perrequestmaxtokens', 'overagepolicy']],
      ['factorypilot_config_businessobjectconfig', 'Business objects (what it can answer about)', ['objectcode', 'objectname', 'moduledomain', 'isactive']],
      ['factorypilot_token_modelroute', 'Model routes', ['provider', 'model', 'isactive']],
      ['factorypilot_audit_sessionlog', 'Audit — one row per request', ['timestamp', 'userid', 'userquery', 'status', 'grounded', 'cacheresult']],
      ['factorypilot_token_tokenusage', 'Token usage', ['timestamp', 'userid', 'provider', 'totaltokens', 'latencyms']],
      ['factorypilot_chat_conversation', 'Chat conversations', ['id', 'userid', 'title']],
    ]
    for (const [tbl, label, cols] of interesting) {
      if (!tables.some((t) => t.table_name === tbl)) continue
      const have = (await client.query(
        `select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [tbl]
      )).rows.map((r) => r.column_name)
      const use = cols.filter((c) => have.includes(c))
      if (!use.length) continue
      const tcol = ['timestamp', 'createdat'].find((c) => have.includes(c))
      const order = tcol ? ` order by "${tcol}" desc` : ''
      const { rows } = await client.query(
        `select ${use.map((c) => `"${c}"`).join(',')} from "${tbl}"${order} limit ${SAMPLE_ROWS}`)
      console.log(`\n  ${C}${label}${O} ${D}${tbl}${O}`)
      table(rows.map((r) => {
        const o = {}
        for (const c of use) {
          const v = r[c]
          o[c] = v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19) : v
        }
        return o
      }), use)
    }
  } finally {
    await client.end().catch(() => {})
  }
}

async function redis() {
  head('Redis — the answer cache (disposable)')
  const t = resolveRedis()
  if (!t) {
    console.log(`  ${Y}Nothing bound.${O} The app is using its in-process cache: correct on a single`)
    console.log(`  instance, but nothing is shared between instances and everything is lost on restart.`)
    return
  }
  kv('host', `${t.host}:${t.port}`)
  kv('tls', t.tls ? 'yes' : 'no')
  kv('from', t.source)

  let redisLib
  try { redisLib = require(require.resolve('redis', { paths: [CAP] })) }
  catch (err) { console.log(`  could not load the redis driver: ${err.message}`); return }

  const client = redisLib.createClient({
    url: t.url, disableOfflineQueue: true,
    socket: {
      connectTimeout: 8000, reconnectStrategy: false,
      ...(t.tls ? { tls: true, ...(t.ca ? { ca: [t.ca] } : {}),
        ...(process.env.REDIS_TLS_REJECT_UNAUTHORIZED === '0' ? { rejectUnauthorized: false } : {}) } : {}),
    },
  })
  client.on('error', () => {})
  try {
    await client.connect()
  } catch (err) {
    console.log(`  ${Y}could not connect:${O} ${err.message}`)
    console.log(`  ${D}scripts/redis-probe.js will say which layer is failing.${O}`)
    return
  }

  try {
    const size = await client.dbSize()
    kv('total keys', String(size))

    // `fp:answer:*` are cached answers; anything else is another feature's
    // namespace and is listed separately rather than silently lumped in.
    const answers = []
    const other = []
    // node-redis v5 yields a *batch* per iteration; older versions yield one key
    // at a time. Treating a batch as a single key silently collapsed every key
    // into one comma-joined string that then read back as empty.
    for await (const batch of client.scanIterator({ MATCH: '*', COUNT: 200 })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) {
        const k = String(key)
        ;(k.startsWith('fp:answer:') ? answers : other).push(k)
      }
    }
    kv('cached answers', String(answers.length))
    if (other.length) kv('other keys', `${other.length} (${other.slice(0, 3).join(', ')}…)`)

    const show = arg('--keys') ? answers : answers.slice(0, SAMPLE_ROWS)
    if (show.length) {
      console.log(`\n  ${C}Cached answers${O} ${D}key · ttl · size${O}`)
      const rows = []
      for (const k of show) {
        const ttl = await client.ttl(k)
        const raw = await client.get(k)
        const row = {
          key: k,
          'ttl (s)': ttl < 0 ? 'no expiry' : ttl,
          bytes: raw ? Buffer.byteLength(raw) : 0,
        }
        if (SHOW_VALUES) {
          let v = raw
          try { const j = JSON.parse(raw); v = j.answer || j.text || raw } catch { /* not json */ }
          row.answer = String(v).replace(/\s+/g, ' ').slice(0, 60)
        }
        rows.push(row)
      }
      table(rows, SHOW_VALUES ? ['key', 'ttl (s)', 'bytes', 'answer'] : ['key', 'ttl (s)', 'bytes'])
      if (!SHOW_VALUES) console.log(`  ${D}--show-values prints a snippet of each cached answer.${O}`)
    }

    console.log(`\n  ${D}The key is a hash of question + plant + subject, so the question itself is`)
    console.log(`  not readable from the key. How long an entry lives comes from its business`)
    console.log(`  object's CachePolicy row — 15 minutes by default, 10 for deliveries — and a`)
    console.log(`  date-bound answer is additionally clamped so it cannot outlive the day it`)
    console.log(`  describes. Any entry can be rebuilt by asking again; none of this is a`)
    console.log(`  system of record.${O}`)
  } finally {
    await client.quit().catch(() => {})
  }
}

async function main() {
  await postgres()
  await redis()
  console.log(`\n${D}Read-only. In the app itself the same data is on the Admin screens:`)
  console.log(`Session Logs (audit), Token Usage, Cache Statistics.${O}\n`)
}

main().catch((err) => { console.error(`\ninspect-stores failed: ${err.stack || err.message}\n`); process.exit(1) })
