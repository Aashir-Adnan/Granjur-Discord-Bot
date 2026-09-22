import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, execute } from './my-time.js'

// Every test passes fakes for db and getConfig. Nothing here may reach the real
// db export or the real getOrCreateGuildConfig: the root .env points at production.

const NOW = new Date('2026-09-22T12:00:00Z')
const rows = [
  { id: 'e1', guildConfigId: 'g1', taskId: 'H', discordId: 'u1', minutes: 90, clockInAt: new Date('2026-09-22T09:00:00Z'), clockOutAt: new Date('2026-09-22T10:30:00Z'), source: 'timer' },
  { id: 'e4', guildConfigId: 'g1', taskId: 'H', discordId: 'u2', minutes: 45, clockInAt: new Date('2026-09-22T09:00:00Z'), clockOutAt: new Date('2026-09-22T09:45:00Z'), source: 'timer' },
  { id: 'e5', guildConfigId: 'g1', taskId: 'H', discordId: 'u1', minutes: 60, clockInAt: new Date('2026-08-01T09:00:00Z'), clockOutAt: new Date('2026-08-01T10:00:00Z'), source: 'timer' },
]
const getConfig = async () => ({ id: 'g1', timezone: 'UTC' })
const PLAIN = { permissions: { has: () => false }, roles: { cache: { some: () => false } } }
const ADMIN = { permissions: { has: (p) => p === 'Administrator' }, roles: { cache: { some: () => false } } }

function fakeDb() {
  const reads = []
  return {
    reads,
    clockEntry: {
      findMany: async (q) => { reads.push(['findMany', q]); return rows.filter((r) => r.discordId === q.where.discordId && new Date(r.clockInAt) >= q.where.since && new Date(r.clockInAt) < q.where.until) },
      findActive: async () => { reads.push(['findActive']); return null },
    },
    task: { findByIds: async () => [{ id: 'H', guildConfigId: 'g1', title: 'My feature' }] },
  }
}

function fakeInteraction(opts = {}, { userId = 'u1', member = PLAIN, person = null } = {}) {
  const edits = []
  return {
    edits,
    deferred: true,
    guild: { id: 'guild1', members: { cache: new Map() } },
    user: { id: userId }, member,
    options: { getString: (k) => opts[k] ?? null, getUser: (k) => (k === 'person' ? person : null) },
    editReply: async (p) => { edits.push(p); return p },
  }
}
const text = (it) => JSON.stringify(it.edits[0].embeds?.[0]?.toJSON?.() ?? {})

test('the command is /my-time with a range of today, week, month, all and an optional person', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'my-time')
  const range = json.options.find((o) => o.name === 'range')
  assert.deepEqual(range.choices.map((c) => c.value), ['today', 'week', 'month', 'all'])
  assert.notEqual(range.required, true)
  const person = json.options.find((o) => o.name === 'person')
  assert.equal(person.type, 6) // USER
  assert.notEqual(person.required, true)
})

test('it shows your own time for this week by default', async () => {
  const db = fakeDb()
  const it = fakeInteraction()
  await execute(it, { db, getConfig, now: NOW })
  assert.match(text(it), /1h 30m/)
  assert.doesNotMatch(text(it), /45m/)
  const find = db.reads.find((r) => r[0] === 'findMany')[1]
  assert.equal(find.where.discordId, 'u1')
  assert.equal(find.where.since.toISOString(), '2026-09-21T00:00:00.000Z')
})

test('the range option widens what is read', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ range: 'all' })
  await execute(it, { db, getConfig, now: NOW })
  assert.match(text(it), /2h 30m/) // 90m this week + 60m in August
  assert.match(text(it), /all time/)
})

test('a non-leader asking for somebody else is refused before anything is read', async () => {
  const db = fakeDb()
  const it = fakeInteraction({}, { person: { id: 'u2' } })
  await execute(it, { db, getConfig, now: NOW })
  assert.equal(it.edits[0].content, "Only CEO and Server Manager can view someone else's time.")
  assert.deepEqual(db.reads, [])
})

test('a leader can see somebody else\'s panel', async () => {
  const db = fakeDb()
  const it = fakeInteraction({}, { userId: 'boss', member: ADMIN, person: { id: 'u2' } })
  await execute(it, { db, getConfig, now: NOW })
  assert.equal(db.reads.find((r) => r[0] === 'findMany')[1].where.discordId, 'u2')
  assert.match(text(it), /45m/)
})

test('naming yourself is allowed for anybody', async () => {
  const db = fakeDb()
  const it = fakeInteraction({}, { person: { id: 'u1' } })
  await execute(it, { db, getConfig, now: NOW })
  assert.match(text(it), /1h 30m/)
})

test('a server that is not set up is told to run /init', async () => {
  const it = fakeInteraction()
  await execute(it, { db: fakeDb(), getConfig: async () => null, now: NOW })
  assert.match(it.edits[0].content, /\/init/)
})
