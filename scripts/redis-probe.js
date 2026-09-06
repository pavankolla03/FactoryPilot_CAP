#!/usr/bin/env node
/**
 * Find out why Redis will not connect — one layer at a time.
 *
 * The app's own failure message could not tell these apart, which is why the
 * cache has been silently degrading to in-process for weeks: "connect timed
 * out" is the same sentence whether the name does not resolve, the port is
 * closed, the TLS certificate is untrusted or the password is wrong. Each of
 * those has a different fix and a different person to ask.
 *
 * So this walks the layers in order and stops at the first one that fails:
 *
 *   1. config    is anything even bound?
 *   2. DNS       does the hostname resolve?
 *   3. TCP       does the port accept a connection?
 *   4. TLS       is the certificate trusted, and by what?
 *   5. AUTH      does Redis accept the password?
 *   6. round     can it actually SET and GET?
 *
 * Run it wherever the app runs, so it sees the same VCAP_SERVICES:
 *
 *   cf ssh intelliops4-approuter -c "cd app && node scripts/redis-probe.js"
 *   node scripts/redis-probe.js                          # local, uses REDIS_URL
 *   REDIS_URL=rediss://:pw@host:6380 node scripts/redis-probe.js
 *
 * It prints no password and no key material. Exit code 0 only if the round
 * trip works.
 */

const dns = require('node:dns').promises
const net = require('node:net')
const tls = require('node:tls')
const path = require('node:path')

const CAP = path.join(__dirname, '..', 'apps', 'cap')
const { resolveRedis } = require(path.join(CAP, 'srv', 'lib', 'cache'))

/** `redis` is a dependency of the CAP app, not of this script's directory. */
function loadRedis() {
  return require(require.resolve('redis', { paths: [CAP] }))
}

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', O = '\x1b[0m'
const ok = (s, d) => console.log(`  ${G}PASS${O}  ${s}${d ? `\n        ${D}${d}${O}` : ''}`)
const bad = (s, d) => console.log(`  ${R}FAIL${O}  ${s}${d ? `\n        ${D}${d}${O}` : ''}`)
const note = (s) => console.log(`  ${Y}····${O}  ${s}`)

const TIMEOUT = Number(process.env.REDIS_PROBE_TIMEOUT_MS || 8000)

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms).unref()),
  ])
}

/** Advice, not just a verdict — the point is to end the investigation. */
function adviseTcp(err, t) {
  if (err.code === 'ECONNREFUSED') return `Nothing is listening on ${t.host}:${t.port}. Wrong port, or the instance is stopped.`
  if (err.code === 'ETIMEDOUT' || /timed out/.test(err.message))
    return 'The packets went nowhere. Almost always a network rule: the Redis instance is not reachable from this ' +
      'network, or its security group / firewall does not allow this source.'
  return err.message
}

function adviseTls(err) {
  const c = err.code || ''
  if (c === 'SELF_SIGNED_CERT_IN_CHAIN' || c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || c === 'DEPTH_ZERO_SELF_SIGNED_CERT')
    return 'The certificate is signed by a private CA that this machine does not trust. Supply it: set REDIS_CA_CERT ' +
      'to the PEM, or bind a service whose credentials carry ca_certificate. REDIS_TLS_REJECT_UNAUTHORIZED=0 will ' +
      'also get you connected, but it disables verification — fine to confirm the diagnosis, not to leave on.'
  if (c === 'ERR_TLS_CERT_ALTNAME_INVALID')
    return 'The certificate is valid but issued for a different hostname. Connect using the name on the certificate.'
  if (/wrong version number|packet length/i.test(err.message))
    return 'This port is not speaking TLS. Use redis:// rather than rediss://, or connect to the TLS port instead.'
  return err.message
}

async function main() {
  console.log(`\nRedis probe${D} — timeout ${TIMEOUT}ms per layer${O}\n`)

  // 1 · config -------------------------------------------------------------
  const t = resolveRedis()
  if (!t) {
    bad('config — nothing is bound',
      'Neither REDIS_URL nor a Redis service in VCAP_SERVICES. The app is running on its in-process ' +
      'cache: correct on one instance, but nothing is shared and everything is lost on restart.')
    process.exit(1)
  }
  ok(`config — ${t.host}:${t.port} ${t.tls ? 'over TLS' : 'plaintext'}${t.ca ? ' with a pinned CA' : ''}`,
    `from ${t.source}`)
  if (t.tls && !t.ca && !process.env.REDIS_CA_CERT)
    note('TLS with no CA supplied — if the handshake fails below, that is why.')

  // 2 · DNS ----------------------------------------------------------------
  let addr = t.host
  if (!net.isIP(t.host)) {
    try {
      const r = await withTimeout(dns.lookup(t.host), TIMEOUT, 'DNS lookup')
      addr = r.address
      ok(`DNS — ${t.host} resolves to ${r.address}`)
    } catch (err) {
      bad(`DNS — ${t.host} does not resolve`,
        err.code === 'ENOTFOUND'
          ? 'The hostname does not exist from here. On Cloud Foundry a managed Redis often resolves only from ' +
            'inside the space, so run this with cf ssh rather than from a laptop.'
          : err.message)
      process.exit(1)
    }
  } else ok(`DNS — ${t.host} is already an address`)

  // 3 · TCP ----------------------------------------------------------------
  try {
    await withTimeout(new Promise((res, rej) => {
      const s = net.connect({ host: addr, port: Number(t.port) })
      s.once('connect', () => { s.destroy(); res() })
      s.once('error', rej)
    }), TIMEOUT, 'TCP connect')
    ok(`TCP — port ${t.port} accepts connections`)
  } catch (err) {
    bad(`TCP — cannot reach ${t.host}:${t.port}`, adviseTcp(err, t))
    process.exit(1)
  }

  // 4 · TLS ----------------------------------------------------------------
  if (t.tls) {
    try {
      const cert = await withTimeout(new Promise((res, rej) => {
        const s = tls.connect({
          host: addr, port: Number(t.port), servername: t.host,
          ...(t.ca ? { ca: [t.ca] } : {}),
          ...(process.env.REDIS_TLS_REJECT_UNAUTHORIZED === '0' ? { rejectUnauthorized: false } : {}),
        })
        s.once('secureConnect', () => { const c = s.getPeerCertificate(); s.destroy(); res(c) })
        s.once('error', rej)
      }), TIMEOUT, 'TLS handshake')
      ok('TLS — handshake completed',
        cert && cert.subject ? `certificate for ${cert.subject.CN || '(no CN)'}, expires ${cert.valid_to}` : '')
    } catch (err) {
      bad('TLS — handshake rejected', adviseTls(err))
      process.exit(1)
    }
  } else note('TLS — not in use (plaintext connection)')

  // 5 & 6 · AUTH and a real round trip -------------------------------------
  let client
  let redis
  try {
    redis = loadRedis()
  } catch (err) {
    // Not an auth failure, and saying so would send someone to re-read a
    // password that was never the problem.
    bad('setup — the redis client library could not be loaded',
      `${err.message}\n        Run npm install in ${CAP} first.`)
    process.exit(1)
  }
  try {
    client = redis.createClient({
      url: t.url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: TIMEOUT,
        ...(t.tls ? {
          tls: true,
          ...(t.ca ? { ca: [t.ca] } : {}),
          ...(process.env.REDIS_TLS_REJECT_UNAUTHORIZED === '0' ? { rejectUnauthorized: false } : {}),
        } : {}),
        reconnectStrategy: false,
      },
    })
    client.on('error', () => { /* reported by the await below */ })
    await withTimeout(client.connect(), TIMEOUT, 'redis connect')
    ok('AUTH — Redis accepted the connection')
  } catch (err) {
    bad('AUTH — Redis refused the connection',
      /WRONGPASS|NOAUTH|invalid password/i.test(err.message)
        ? 'The password is wrong or missing. Re-read it from the service binding — do not retype it by hand.'
        : err.message)
    process.exit(1)
  }

  try {
    const key = `intelliops4:probe:${Date.now()}`
    await withTimeout(client.set(key, 'ok', { EX: 30 }), TIMEOUT, 'SET')
    const got = await withTimeout(client.get(key), TIMEOUT, 'GET')
    await client.del(key).catch(() => {})
    if (got === 'ok') ok('round trip — SET and GET both work', 'The cache is fully usable.')
    else { bad('round trip — GET returned something unexpected', `expected "ok", got ${JSON.stringify(got)}`); process.exit(1) }
  } catch (err) {
    bad('round trip — a command failed', err.message)
    process.exit(1)
  } finally {
    await client.quit().catch(() => {})
  }

  console.log(`\n${G}Redis is reachable and working.${O} If the app still says it is on the in-process cache, ` +
    `the difference is environment, not Redis — compare what this process sees with what the app sees.\n`)
}

main().catch((err) => { console.error(`\n${R}probe crashed:${O} ${err.stack || err.message}\n`); process.exit(1) })
