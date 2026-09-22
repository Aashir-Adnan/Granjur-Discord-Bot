import test from 'node:test'
import assert from 'node:assert/strict'
import { reportLines, runDailyReportPass } from './dailyTimeReport.js'

function fakeGuild(sent) {
  return {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async (id) => ({ id, displayName: `User ${id}` }) },
    channels: {
      fetch: async () => ({ id: 'chan1', send: async (payload) => { sent.push(payload); return { id: 'msg1' } } }),
      create: async () => ({ id: 'chan1', send: async (payload) => { sent.push(payload); return { id: 'msg1' } } }),
    },
  }
}

function harness({ lastTimeReportOn = '2026-09-21', totals = [], members = [{ discordId: '1', displayName: 'Ali', status: 'approved' }] } = {}) {
  const sent = []
  const updates = []
  const guild = fakeGuild(sent)
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => totals },
    guildMember: { findMany: async (args) => { db.lastFindMany = args; return members } },
  }
  const getConfig = async () => ({ id: 'cfg1', timezone: 'UTC', lastTimeReportOn, timeReportChannelId: 'chan1' })
  const update = async (guildId, data) => { updates.push({ guildId, data }) }
  return { client, db, getConfig, update, sent, updates }
}

test('posts the day that just ended and records it', async () => {
  const h = harness({ totals: [{ discordId: '1', minutes: 90 }] })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(h.sent.length, 1)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-22')
})

test('the roster read is uncapped — guildMemberFindMany defaults to 25', async () => {
  const h = harness()
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(h.db.lastFindMany.where.all, true)
  assert.equal(h.db.lastFindMany.where.status, 'approved')
})

test('does not post twice for the same day', async () => {
  const h = harness({ lastTimeReportOn: '2026-09-22' })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(h.sent.length, 0)
})

test('the first ever pass records the day and posts nothing', async () => {
  const h = harness({ lastTimeReportOn: null })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T12:00:00Z') })
  assert.equal(h.sent.length, 0)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-21')
})

test('a long outage posts once, for the most recent due day only', async () => {
  const h = harness({ lastTimeReportOn: '2026-09-15' })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(h.sent.length, 1)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-22')
})

test('before the cutoff, yesterday is posted rather than a partial today', async () => {
  const h = harness({ lastTimeReportOn: '2026-09-20' })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T10:00:00Z') })
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-21')
})

test('reportLines lists zeros and truncates with a truthful tail', () => {
  const ranked = [
    { discordId: '1', name: 'Ali', minutes: 120 },
    { discordId: '2', name: 'Zara', minutes: 0 },
    { discordId: '3', name: 'Bilal', minutes: 0 },
  ]
  assert.deepEqual(reportLines(ranked, 10), ['**Ali** — 2h', '**Zara** — 0m', '**Bilal** — 0m'])
  assert.deepEqual(reportLines(ranked, 2), ['**Ali** — 2h', '**Zara** — 0m', '…and 1 more'])
})
