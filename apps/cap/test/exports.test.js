const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const cds = require('@sap/cds')

const PROJECT = path.resolve(__dirname, '..')
const { GET } = cds.test(PROJECT).in(PROJECT)

const exportsLib = require('../srv/lib/exports')

/**
 * Scheduled exports.
 *
 * The interesting part is not the reports; it is the CSV. Getting escaping
 * wrong shifts every later column of a row, and the corruption is invisible
 * until a total is wrong in a meeting — by which point nobody trusts any of
 * the numbers, including the correct ones.
 */

const ADMIN = { auth: { username: 'admin', password: 'admin' } }

describe('CSV escaping, where the real risk is', () => {
  test('a plain value is left alone', () => {
    assert.equal(exportsLib.cell('1710'), '1710')
    assert.equal(exportsLib.cell(42), '42')
  })

  test('empty and missing become empty, not "null"', () => {
    assert.equal(exportsLib.cell(null), '')
    assert.equal(exportsLib.cell(undefined), '')
    assert.equal(exportsLib.cell(''), '')
  })

  test('a comma is quoted, or every later column shifts', () => {
    assert.equal(exportsLib.cell('Smith, John'), '"Smith, John"')
  })

  test('a quote is doubled inside quotes', () => {
    assert.equal(exportsLib.cell('he said "no"'), '"he said ""no"""')
  })

  test('a newline is quoted — a user question can contain one', () => {
    assert.equal(exportsLib.cell('line one\nline two'), '"line one\nline two"')
  })

  test('a header-only file is still valid when there are no rows', () => {
    const csv = exportsLib.toCsv([], ['a', 'b'])
    assert.equal(csv, 'a,b', 'an empty report is a header, not an empty file')
  })

  test('rows follow the column order given, not object key order', () => {
    const csv = exportsLib.toCsv([{ b: 2, a: 1 }], ['a', 'b'])
    assert.equal(csv, 'a,b\n1,2')
  })
})

describe('building a report', () => {
  test('every named report builds', async () => {
    for (const name of Object.keys(exportsLib.REPORTS)) {
      const built = await exportsLib.build(name)
      assert.ok(built.csv, `${name} should produce csv`)
      assert.ok(built.filename.endsWith('.csv'))
      assert.ok(built.title, 'and carry a human title')
    }
  })

  test('an unknown report names the ones that exist', async () => {
    // The caller has almost always mistyped one of them.
    await assert.rejects(
      () => exportsLib.build('everything'),
      /Known reports: usage, quality, failures/)
  })

  test('the window is honoured', async () => {
    const built = await exportsLib.build('usage', { days: 3 })
    assert.equal(built.days, 3)
    assert.ok(built.since instanceof Date)
  })

  test('one broken report does not cost the others', async () => {
    // Recorded rather than dropped, so an incomplete export is never mistaken
    // for a quiet week.
    const all = await exportsLib.buildAll()
    assert.equal(all.length, Object.keys(exportsLib.REPORTS).length)
    for (const r of all) {
      assert.ok(r.csv !== undefined || r.error, `${r.name} was neither built nor explained`)
    }
  })

  test('the summary says when an export is incomplete', () => {
    const text = exportsLib.describe([
      { name: 'usage', title: 'Usage by user', rowCount: 4, days: 7 },
      { name: 'quality', error: 'table missing' },
    ])
    assert.match(text, /Usage by user: 4 rows over 7 days/)
    assert.match(text, /could not be built/)
    assert.match(text, /this export is incomplete/)
    assert.match(text, /\[BETA\]/)
  })
})

describe('over the service', () => {
  test('a report can be fetched on demand without sending it to anyone', async () => {
    // "Let me see it" and "send it to everyone" are different intentions.
    const { data } = await GET("/odata/jobs/exportReport(name='usage',days=7)", ADMIN)
    assert.equal(data.name, 'usage')
    assert.ok(data.csv.startsWith('userID,requests'))
    assert.ok(data.filename.includes('usage'))
  })

  test('an unknown report is a 400 that says what exists', async () => {
    await assert.rejects(
      () => GET("/odata/jobs/exportReport(name='nonsense',days=7)", ADMIN),
      /Known reports/)
  })
})

describe('the scheduled job', () => {
  test('it is registered but off by default', async () => {
    // A weekly file arriving unrequested is the definition of noise.
    const jobs = require('../srv/lib/jobs')
    const spec = jobs.JOBS.find((j) => j.name === 'weekly-export')
    assert.ok(spec, 'the export job should be registered')
    assert.equal(spec.defaults.isActive, false, 'and should not run until asked for')
    assert.equal(spec.defaults.runAtHour, 7)
  })
})
