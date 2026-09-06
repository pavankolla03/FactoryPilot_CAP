/**
 * Outbound delivery. (BETA)
 *
 * Nobody opens a portal to receive an alert. If the digest only lands in a
 * database table it may as well not exist, so this is the half of proactivity
 * that actually reaches a person.
 *
 * One channel to start with: a webhook, which is what `OrgSettings.webhookUrl`
 * has been modelling since the beginning without anything ever calling it.
 * A webhook covers Microsoft Teams and Slack (both accept an incoming-webhook
 * POST) and anything a customer can put an endpoint in front of, which is a
 * far wider net than picking one vendor's API.
 *
 * Delivery never throws. A digest that was built but could not be sent is
 * still worth recording, and a failed notification must not mark the job that
 * produced it as failed — those are two different facts and conflating them
 * would have an operator debugging the digest when the webhook is what broke.
 */

const cds = require('@sap/cds')

const log = cds.log('notify')

const TIMEOUT_MS = Number(process.env.FACTORYPILOT_WEBHOOK_TIMEOUT_MS || 10_000)

/**
 * Shape the payload for whoever is listening.
 *
 * Teams and Slack both render a bare `text` field, so sending that alongside
 * the structured fields means one payload works for a chat channel and for a
 * custom consumer without configuration. Anything cleverer — adaptive cards,
 * block kit — is per-vendor, and picking one would make the other worse.
 */
function payloadFor(title, text, extra = {}) {
  return {
    // Teams and Slack both read this.
    text: `**${title}**\n\n${text}`,
    // Everything else, for a consumer that wants the parts rather than the prose.
    title,
    body: text,
    product: 'IntelliOps4',
    beta: true,
    generatedAt: new Date().toISOString(),
    ...extra,
  }
}

/**
 * Send to the configured webhook.
 *
 * Returns a result rather than throwing: `{ delivered, reason }`. Callers
 * record it; none of them should fail because of it.
 */
async function send(title, text, extra = {}) {
  const { OrgSettings } = cds.entities('factorypilot.admin')
  let url
  try {
    const org = await SELECT.one.from(OrgSettings)
    url = org?.webhookUrl
  } catch (err) {
    return { delivered: false, reason: `could not read OrgSettings: ${err.message}` }
  }
  if (!url) return { delivered: false, reason: 'no webhookUrl configured' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadFor(title, text, extra)),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      log.warn(`webhook returned ${res.status}: ${detail}`)
      return { delivered: false, reason: `webhook returned ${res.status}` }
    }
    log.info(`delivered "${title}" to the configured webhook`)
    return { delivered: true }
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `webhook timed out after ${TIMEOUT_MS}ms`
      : `webhook request failed: ${err.message}`
    log.warn(reason)
    return { delivered: false, reason }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { send, payloadFor, TIMEOUT_MS }
