import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, entryWindow, autocomplete } from './log-time.js'
import { autocomplete as clockInAutocomplete, GENERAL } from './clock-in.js'

const HELD = { id: 'H', title: 'My feature', status: 'open', assigneeIds: ['u1'], projectId: 'p1' }
const FAR = { id: 'F', title: 'Another project', status: 'open', assigneeIds: ['u2'], projectId: 'p9' }

// Every test passes these fakes. Nothing here may reach the real db export or
// the real getOrCreateGuildConfig: the root .env points at production.
function fakeDb({ entries = [], tasks = [HELD] } = {}) {
  const rows = [...entries]
  const calls = []
  return {
    rows, calls,
    clockEntry: {
      findActive: async () => { throw new Error('/log-time must not look at the running timer') },
      create: async ({ data }) => { const row = { id: `e${rows.length + 1}`, ...data }; rows.push(row); calls.push(['create', row]); return row },
      update: async () => { throw new Error('/log-time must not update an existing entry') },
      // Same semantics as the real query: entries STARTING in [since, until).
      // Used ONLY for the overlap read; totals come from sumByTask.
      findMany: async ({ where, take }) => {
        calls.push(['findMany', where, take])
        return rows.filter((r) =>
          r.discordId === where.discordId
          && (!where.since || new Date(r.clockInAt) >= where.since)
          && (!where.until || new Date(r.clockInAt) < where.until))
      },
      sumByTask: async ({ taskIds }) => {
        const grouped = new Map()
        for (const r of rows) {
          if (r.minutes == null || !taskIds.includes(r.taskId)) continue
          const key = `${r.taskId}|${r.discordId}`
          const cur = grouped.get(key) ?? { taskId: r.taskId, discordId: r.discordId, minutes: 0 }
          cur.minutes += r.minutes
          grouped.set(key, cur)
        }
        return [...grouped.values()]
      },
    },
    task: { findFirst: async ({ where }) => tasks.find((t) => t.id === where.id) ?? null, findMany: async () => tasks },
    project: { findMany: async () => [] },
    projectMember: { findByMember: async () => [{ projectId: 'p1' }] },
  }
}

const getConfig = async () => ({ id: 'g1', clockedInRoleId: null, timezone: 'UTC' })

const PLAIN_MEMBER = { permissions: { has: () => false }, roles: { cache: { some: () => false } } }
const ADMIN_MEMBER = { permissions: { has: (p) => p === 'Administrator' }, roles: { cache: { some: () => false } } }

function fakeInteraction(opts = {}, { userId = 'u1', member = PLAIN_MEMBER, focused = '' } = {}) {
  const replies = []
  const responses = []
  return {
    replies, responses,
    guild: { id: 'guild1', members: { cache: new Map(), fetch: async () => null } },
    user: { id: userId },
    member,
    options: { getString: (k) => opts[k] ?? null, getFocused: () => focused },
    editReply: async (p) => { replies.push(p); return p },
    respond: async (c) => { responses.push(c) },
  }
}

const NOW = new Date('2026-09-22T15:00:00.000Z')
const written = (db) => db.calls.filter((c) => c[0] === 'create')

test('entryWindow ends at the given day and runs backwards by the duration', () => {
  const today = entryWindow(90, 'today', NOW)
  assert.equal(today.clockOutAt.toISOString(), '2026-09-22T15:00:00.000Z')
  assert.equal(today.clockInAt.toISOString(), '2026-09-22T13:30:00.000Z')
  const yest = entryWindow(60, 'yesterday', NOW)
  assert.equal(yest.clockOutAt.toISOString(), '2026-09-21T15:00:00.000Z')
  const dated = entryWindow(60, '2026-09-10', NOW)
  assert.equal(dated.clockOutAt.toISOString(), '2026-09-10T15:00:00.000Z')
  assert.equal(entryWindow(60, undefined, NOW).clockOutAt.toISOString(), '2026-09-22T15:00:00.000Z')
})

test('entryWindow returns null for a date it cannot read', () => {
  assert.equal(entryWindow(60, 'last tuesday', NOW), null)
  assert.equal(entryWindow(60, '2026-9-1', NOW), null)
})

test('entryWindow returns null for an impossible date instead of rolling it into the next month', () => {
  assert.equal(entryWindow(60, '2026-02-31', NOW), null)
  assert.equal(entryWindow(60, '2026-02-29', NOW), null, '2026 is not a leap year')
  assert.equal(entryWindow(60, '2026-13-01', NOW), null)
  assert.equal(entryWindow(60, '2026-04-31', NOW), null)
  assert.equal(entryWindow(60, '2026-00-10', NOW), null)
  assert.equal(entryWindow(60, '2026-01-00', NOW), null)
})

test('entryWindow accepts a real leap day', () => {
  const w = entryWindow(60, '2028-02-29', new Date('2028-03-05T15:00:00.000Z'))
  assert.equal(w.clockOutAt.toISOString(), '2028-02-29T15:00:00.000Z')
})

test('a long entry is accepted — there is no maximum', async () => {
  const db = fakeDb()
  await execute(fakeInteraction({ task: 'H', duration: '200h' }), { db, getConfig, now: NOW })
  assert.equal(db.rows[0].minutes, 12000)
  assert.equal(db.rows[0].source, 'manual')
})

test('a duration too large to store is refused, with nothing written', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '99999999999999999999h' })
  await execute(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /too large to store/i)
})

test('one minute over the INT ceiling is refused', async () => {
  const over = fakeDb()
  const itOver = fakeInteraction({ task: 'H', duration: '2147483648' })
  await execute(itOver, { db: over, getConfig, now: NOW })
  assert.deepEqual(over.calls, [])
  assert.match(itOver.replies[0].content, /too large to store/i)
})

test('a duration that would start before the database can store a date is refused', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '1000000000m' })
  await execute(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /too large to store/i)
})

test('the manual entry records who, what, when and how', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '1h30m', note: 'wrote the parser' })
  await execute(it, { db, getConfig, now: NOW })
  assert.equal(written(db).length, 1)
  const row = db.rows[0]
  assert.equal(row.guildConfigId, 'g1')
  assert.equal(row.discordId, 'u1')
  assert.equal(row.taskId, 'H')
  assert.equal(row.source, 'manual')
  assert.equal(row.minutes, 90)
  assert.equal(row.note, 'wrote the parser')
  assert.equal(row.clockOutAt.toISOString(), '2026-09-22T15:00:00.000Z')
  assert.equal(row.clockInAt.toISOString(), '2026-09-22T13:30:00.000Z')
  assert.equal(it.replies.length, 1)
  assert.match(it.replies[0].content, /1h 30m/)
  assert.match(it.replies[0].content, /My feature/)
})

test('an unparseable duration writes nothing and says what is accepted', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: 'ages' })
  await execute(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /2h30m/)
})

test('an unknown date writes nothing', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '1h', when: 'last tuesday' })
  await execute(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /YYYY-MM-DD/)
})

test('an impossible date is refused, not rolled into the next month', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '1h', when: '2026-02-31' })
  await execute(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /today, yesterday or YYYY-MM-DD/)
})

test('a real leap day is accepted', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '1h', when: '2028-02-29' })
  await execute(it, { db, getConfig, now: new Date('2028-03-05T15:00:00.000Z') })
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].clockOutAt.toISOString(), '2028-02-29T15:00:00.000Z')
})

test('an entry ending in the future is refused', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '1h', when: '2026-09-23' })
  await execute(it, { db, getConfig, now: NOW })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /That is in the future\./)
})

test('an entry for today ends exactly now and is accepted', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '1h', when: 'today' })
  await execute(it, { db, getConfig, now: NOW })
  assert.equal(db.rows.length, 1)
  assert.doesNotMatch(it.replies[0].content, /future/i)
})

test('the reply shows the task total from sumByTask, across everyone', async () => {
  const before = new Date('2026-09-01T10:00:00.000Z')
  const db = fakeDb({ entries: [
    { id: 'x1', discordId: 'u2', taskId: 'H', clockInAt: before, clockOutAt: new Date('2026-09-01T11:00:00.000Z'), minutes: 60 },
  ] })
  const it = fakeInteraction({ task: 'H', duration: '30m' })
  await execute(it, { db, getConfig, now: NOW })
  assert.match(it.replies[0].content, /1h 30m/, '60m from a teammate plus this 30m')
  assert.match(it.replies[0].content, /total/i)
})

test('general work is logged against no task and shows no total', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: GENERAL, duration: '45m' })
  await execute(it, { db, getConfig, now: NOW })
  assert.equal(db.rows[0].taskId, null)
  assert.match(it.replies[0].content, /45m/)
  assert.doesNotMatch(it.replies[0].content, /total/i)
})

test('a task the caller may not use is refused, indistinguishably from one that does not exist', async () => {
  const db = fakeDb({ tasks: [FAR] })
  db.projectMember.findByMember = async () => []
  const hidden = fakeInteraction({ task: 'F', duration: '1h' })
  const missing = fakeInteraction({ task: 'nope', duration: '1h' })
  await execute(hidden, { db, getConfig, now: NOW })
  await execute(missing, { db, getConfig, now: NOW })
  assert.deepEqual(db.calls, [])
  assert.match(hidden.replies[0].content, /not available/i)
  assert.equal(hidden.replies[0].content, missing.replies[0].content)
})

test('a task in one of the caller\'s projects is allowed', async () => {
  const teammates = { id: 'P', title: 'Teammate task', status: 'open', assigneeIds: ['u2'], projectId: 'p1' }
  const db = fakeDb({ tasks: [teammates] })
  await execute(fakeInteraction({ task: 'P', duration: '1h' }), { db, getConfig, now: NOW })
  assert.equal(db.rows[0].taskId, 'P')
})

test('leadership can log against a task they do not hold and are not a project member of', async () => {
  const db = fakeDb({ tasks: [FAR] })
  db.projectMember.findByMember = async () => []
  await execute(fakeInteraction({ task: 'F', duration: '1h' }, { member: ADMIN_MEMBER }), { db, getConfig, now: NOW })
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].taskId, 'F')
})

const at = (iso) => new Date(iso)
const existing = (over) => ({ id: 'old', discordId: 'u1', taskId: 'H', source: 'timer', ...over })

test('an entry overlapping another of the caller\'s warns, and both entries stay', async () => {
  const db = fakeDb({ entries: [existing({
    clockInAt: at('2026-09-22T13:00:00.000Z'), clockOutAt: at('2026-09-22T14:00:00.000Z'), minutes: 60,
  })] })
  const it = fakeInteraction({ task: 'H', duration: '90m' }) // 13:30 - 15:00
  await execute(it, { db, getConfig, now: NOW })
  assert.equal(db.rows.length, 2, 'the new entry is written regardless')
  assert.equal(db.rows[0].id, 'old')
  assert.match(it.replies[0].content, /overlaps another entry of yours/)
  assert.match(it.replies[0].content, /\/my-time/)
  const read = db.calls.find((c) => c[0] === 'findMany')
  assert.equal(read[1].guildConfigId, 'g1')
  assert.equal(read[1].discordId, 'u1')
  assert.equal(read[1].since.toISOString(), '2026-09-15T13:30:00.000Z', 'seven days before the entry starts')
  assert.equal(read[1].until.toISOString(), '2026-09-22T15:00:00.000Z', 'the entry end')
  assert.equal(read[2], 500)
})

test('an entry that does not overlap anything gets no warning', async () => {
  const db = fakeDb({ entries: [existing({
    clockInAt: at('2026-09-22T09:00:00.000Z'), clockOutAt: at('2026-09-22T10:00:00.000Z'), minutes: 60,
  })] })
  const it = fakeInteraction({ task: 'H', duration: '90m' })
  await execute(it, { db, getConfig, now: NOW })
  assert.equal(db.rows.length, 2)
  assert.doesNotMatch(it.replies[0].content, /overlap/i)
})

test('an entry that only touches another at a boundary gets no warning', async () => {
  const db = fakeDb({ entries: [existing({
    clockInAt: at('2026-09-22T12:00:00.000Z'), clockOutAt: at('2026-09-22T13:30:00.000Z'), minutes: 90,
  })] })
  const it = fakeInteraction({ task: 'H', duration: '90m' }) // starts exactly 13:30
  await execute(it, { db, getConfig, now: NOW })
  assert.doesNotMatch(it.replies[0].content, /overlap/i)
})

test('another person\'s entry at the same time is not an overlap', async () => {
  const db = fakeDb({ entries: [existing({
    discordId: 'u2', clockInAt: at('2026-09-22T13:00:00.000Z'), clockOutAt: at('2026-09-22T14:00:00.000Z'), minutes: 60,
  })] })
  const it = fakeInteraction({ task: 'H', duration: '90m' })
  await execute(it, { db, getConfig, now: NOW })
  assert.doesNotMatch(it.replies[0].content, /overlap/i)
})

test('the entry never overlaps itself when the read returns it', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '90m' })
  await execute(it, { db, getConfig, now: NOW })
  assert.equal(db.calls.find((c) => c[0] === 'findMany')[0], 'findMany')
  assert.doesNotMatch(it.replies[0].content, /overlap/i)
})

test('a failing overlap read is logged and the reply still goes out', async () => {
  const db = fakeDb()
  db.clockEntry.findMany = async () => { throw new Error('read failed') }
  const it = fakeInteraction({ task: 'H', duration: '90m' })
  const logged = []
  const original = console.error
  console.error = (...a) => logged.push(a.join(' '))
  try {
    await execute(it, { db, getConfig, now: NOW })
  } finally {
    console.error = original
  }
  assert.equal(db.rows.length, 1, 'the write already happened')
  assert.equal(it.replies.length, 1)
  assert.match(it.replies[0].content, /1h 30m/)
  assert.doesNotMatch(it.replies[0].content, /overlap/i)
  assert.ok(logged.some((l) => /read failed/.test(l)))
})

test('autocomplete is the /clock-in picker', () => {
  assert.equal(autocomplete, clockInAutocomplete)
})
