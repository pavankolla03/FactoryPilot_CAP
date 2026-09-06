/**
 * The morning digest. (BETA)
 *
 * The first thing this product does without being asked, and the reason the
 * scheduler exists. A chat window that answers questions is a commodity; a
 * system that says "the count in 1710 is still open" before anyone asks is not.
 *
 * Two design decisions worth keeping:
 *
 * It reads through the *same* tools the agent uses, rather than a private query
 * path. A digest that drifts from what the chat would say about the same data
 * is worse than no digest — it makes both untrustworthy, and the divergence is
 * invisible until someone checks by hand.
 *
 * Every section degrades on its own. A digest is delivered at six in the
 * morning to someone who will not be reading logs; one unreachable business
 * object must cost that section and nothing else. The alternative — an
 * all-or-nothing digest — fails silently exactly when it is least likely to be
 * noticed.
 */

const cds = require('@sap/cds')
const tools = require('./tools')

const log = cds.log('digest')

/** Per-section budget. The whole digest is bounded by the job's lease. */
const SECTION_TIMEOUT_MS = Number(process.env.FACTORYPILOT_DIGEST_SECTION_MS || 20_000)

/**
 * What the digest reports on, in the order an operator would want it.
 *
 * Ordered by what ruins a morning: something needing action first, then things
 * that merely moved. `pick` turns rows into the one line worth reading — the
 * digest is a prompt to look, not a substitute for looking.
 */
const SECTIONS = [
  {
    key: 'PURCHASING',
    title: 'Purchase orders',
    lead: (n) => (n ? `${n} purchase order${n === 1 ? '' : 's'} open` : 'No open purchase orders'),
  },
  {
    key: 'PHYSICAL_INVENTORY',
    title: 'Inventory counts',
    lead: (n) => (n ? `${n} physical inventory document${n === 1 ? '' : 's'} still open` : 'No open counts'),
  },
  {
    key: 'DELIVERY',
    title: 'Deliveries',
    lead: (n) => (n ? `${n} deliver${n === 1 ? 'y' : 'ies'} in scope` : 'No deliveries today'),
  },
  {
    key: 'MATERIAL_DOCUMENT',
    title: 'Goods movements',
    lead: (n) => (n ? `${n} goods movement${n === 1 ? '' : 's'} recorded` : 'No goods movements'),
  },
]

/**
 * Read one section, or explain why it could not be read.
 *
 * Never throws. The caller is a scheduled job at six in the morning; an
 * exception here would lose every other section with it.
 */
async function readSection(section, businessObjects, defaults, correlationId) {
  const bo = businessObjects.find((b) => b.objectCode === section.key)
  if (!bo) return { ...section, skipped: 'not registered in this tenant' }

  const started = Date.now()
  try {
    const result = await tools.executeRead(
      tools.toolNameFor(section.key), {},
      { businessObjects, defaults, correlationId, timeoutMs: SECTION_TIMEOUT_MS }
    )
    return {
      ...section,
      rowCount: result.rowCount ?? result.rows?.length ?? 0,
      elapsedMs: Date.now() - started,
    }
  } catch (err) {
    // Recorded, not hidden. "Purchase orders — could not be read" is useful;
    // a section silently missing from the digest is not, because the reader
    // cannot tell the difference between nothing to report and nothing read.
    log.warn(`digest section ${section.key} failed: ${err.message}`)
    return { ...section, error: err.message.slice(0, 200), elapsedMs: Date.now() - started }
  }
}

/**
 * How the system itself has been behaving.
 *
 * Included because the person who reads this is also the person who has to
 * answer for it — and unlike the S/4 sections it cannot fail, since it reads
 * the local audit tables.
 */
async function readActivity() {
  const { SessionLog } = cds.entities('factorypilot.audit')
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  try {
    const rows = await SELECT.from(SessionLog).where({ timestamp: { '>': since } })
    const total = rows.length
    const failed = rows.filter((r) => r.status === 'FAILED').length
    const grounded = rows.filter((r) => r.grounded).length
    const cached = rows.filter((r) => r.cacheResult === 'HIT').length
    return { total, failed, grounded, cached }
  } catch (err) {
    log.warn(`digest activity section failed: ${err.message}`)
    return null
  }
}

/** Render the digest as plain text — readable in an email, a webhook, a log. */
function render({ sections, activity, warehouse, generatedAt }) {
  const when = generatedAt.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })
  const out = [`IntelliOps4 digest — ${when}`, warehouse ? `Plant ${warehouse}` : null, '', '[BETA]', '']
    .filter((l) => l !== null)

  for (const s of sections) {
    if (s.skipped) { out.push(`${s.title}: not configured (${s.skipped})`); continue }
    if (s.error) { out.push(`${s.title}: could not be read — ${s.error}`); continue }
    out.push(`${s.title}: ${s.lead(s.rowCount)}`)
  }

  if (activity) {
    out.push('', 'Yesterday in IntelliOps4:',
      `  ${activity.total} question${activity.total === 1 ? '' : 's'} asked` +
      (activity.total ? `, ${activity.grounded} answered from data, ${activity.cached} served from cache` : ''),
      activity.failed ? `  ${activity.failed} failed — worth a look` : '  none failed')
  }

  const unread = sections.filter((s) => s.error).length
  if (unread) {
    out.push('', `${unread} section${unread === 1 ? '' : 's'} could not be read. ` +
      'That is a connection problem, not an empty result — the figures above are incomplete.')
  }
  return out.join('\n')
}

/**
 * Build the digest. Returns the text and enough structure to act on.
 *
 * Separated from delivery so it can be rendered, tested and previewed without
 * sending anything to anyone.
 */
async function build({ correlationId = `digest-${Date.now()}` } = {}) {
  const { BusinessObjectConfig } = cds.entities('factorypilot.config')
  const { OrgSettings } = cds.entities('factorypilot.admin')

  const businessObjects = await SELECT.from(BusinessObjectConfig).where({ isActive: true })
  const org = await SELECT.one.from(OrgSettings)
  const warehouse = org?.defaultWarehouse || ''
  const defaults = { warehouse }

  const sections = []
  for (const section of SECTIONS) {
    sections.push(await readSection(section, businessObjects, defaults, correlationId))
  }
  const activity = await readActivity()
  const generatedAt = new Date()

  return {
    generatedAt, warehouse, sections, activity,
    text: render({ sections, activity, warehouse, generatedAt }),
    unreadable: sections.filter((s) => s.error).length,
  }
}

module.exports = { build, render, readSection, readActivity, SECTIONS }
