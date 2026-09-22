import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute as clockIn, autocomplete as clockInAutocomplete, GENERAL } from './clock-in.js'
import { execute as clockOut } from './clock-out.js'
import { clockableTasks } from '../utils/timeTaskPicker.js'

const HELD = { id: 'H', title: 'My feature', status: 'open', assigneeIds: ['u1'], projectId: 'p1' }
const MINE_PROJECT = { id: 'P', title: 'Teammate task', status: 'open', assigneeIds: ['u2'], projectId: 'p1' }
const FAR = { id: 'F', title: 'Another project', status: 'open', assigneeIds: ['u2'], projectId: 'p9' }

test('clockableTasks: your own tasks, plus any task in a project you belong to', () => {
  const out = clockableTasks([HELD, MINE_PROJECT, FAR], { memberProjectIds: ['p1'], isLeadership: false, callerId: 'u1' })
  assert.deepEqual(out.map((t) => t.id), ['H', 'P'])
})

test('clockableTasks: leadership can clock into anything; a member of no project only their own', () => {
  assert.deepEqual(
    clockableTasks([HELD, MINE_PROJECT, FAR], { memberProjectIds: [], isLeadership: true, callerId: 'u1' }).map((t) => t.id),
    ['H', 'P', 'F'],
  )
  assert.deepEqual(
    clockableTasks([HELD, MINE_PROJECT, FAR], { memberProjectIds: [], isLeadership: false, callerId: 'u1' }).map((t) => t.id),
    ['H'],
  )
})

function fakeDb({ entries = [], tasks = [HELD] } = {}) {
  const rows = [...entries]
  const calls = []
  return {
    rows, calls,
    clockEntry: {
      findActive: async () => rows.find((r) => !r.clockOutAt) ?? null,
      create: async ({ data }) => { const row = { id: `e${rows.length + 1}`, ...data }; rows.push(row); calls.push(['create', row]); return row },
      update: async (id, data) => { const row = rows.find((r) => r.id === id); Object.assign(row, data); calls.push(['update', id, data]); return row },
      // The capped list must never be the source of a total.
      findMany: async () => { throw new Error('a task total must come from sumByTask, not findMany') },
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

const PLAIN_MEMBER = { permissions: { has: () => false }, roles: { cache: { some: () => false }, add: async () => {}, remove: async () => {} } }
const ADMIN_MEMBER = { permissions: { has: (p) => p === 'Administrator' }, roles: { cache: { some: () => false }, add: async () => {}, remove: async () => {} } }

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

test('clock-in starts a timer against the chosen task', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H' })
  await clockIn(it, { db, getConfig })
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].taskId, 'H')
  assert.equal(db.rows[0].source, 'timer')
  assert.equal(db.rows[0].clockOutAt, undefined)
  assert.match(it.replies[0].content, /My feature/)
})

test('clock-in on the SAME task changes nothing and says how long it has run', async () => {
  const started = new Date(Date.now() - 40 * 60000)
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: started, clockOutAt: null }] })
  const it = fakeInteraction({ task: 'H' })
  await clockIn(it, { db, getConfig })
  assert.deepEqual(db.calls, [], 'no write at all')
  assert.match(it.replies[0].content, /already/i)
  assert.match(it.replies[0].content, /40m/)
})

test('clock-in on a DIFFERENT task closes the old entry and opens the new one, in one reply', async () => {
  const started = new Date(Date.now() - 70 * 60000)
  const db = fakeDb({
    entries: [{ id: 'e1', discordId: 'u1', taskId: 'P', clockInAt: started, clockOutAt: null }],
    tasks: [HELD, MINE_PROJECT],
  })
  const it = fakeInteraction({ task: 'H' })
  await clockIn(it, { db, getConfig })
  const closed = db.rows.find((r) => r.id === 'e1')
  assert.ok(closed.clockOutAt, 'the old entry is closed')
  assert.equal(closed.minutes, 70, 'and its duration is written')
  assert.equal(db.rows.length, 2)
  assert.equal(db.rows[1].taskId, 'H')
  assert.match(it.replies[0].content, /Stopped/)
  assert.match(it.replies[0].content, /started/i)
  assert.equal(it.replies.length, 1)
})

test('switching tasks neither removes nor re-adds the clocked-in role', async () => {
  const started = new Date(Date.now() - 10 * 60000)
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: 'P', clockInAt: started, clockOutAt: null }], tasks: [HELD, MINE_PROJECT] })
  const roleCalls = []
  const member = { ...PLAIN_MEMBER, roles: { ...PLAIN_MEMBER.roles, add: async (r) => roleCalls.push(['add', r]), remove: async (r) => roleCalls.push(['remove', r]) } }
  const cfg = async () => ({ id: 'g1', clockedInRoleId: 'R1', timezone: 'UTC' })
  await clockIn(fakeInteraction({ task: 'H' }, { member }), { db, getConfig: cfg })
  assert.deepEqual(roleCalls, [])
})

test('a fresh clock-in adds the role and clock-out removes it', async () => {
  const db = fakeDb()
  const roleCalls = []
  const member = { ...PLAIN_MEMBER, roles: { ...PLAIN_MEMBER.roles, add: async (r) => roleCalls.push(['add', r]), remove: async (r) => roleCalls.push(['remove', r]) } }
  const cfg = async () => ({ id: 'g1', clockedInRoleId: 'R1', timezone: 'UTC' })
  await clockIn(fakeInteraction({ task: 'H' }, { member }), { db, getConfig: cfg })
  await clockOut(fakeInteraction({}, { member }), { db, getConfig: cfg })
  assert.deepEqual(roleCalls, [['add', 'R1'], ['remove', 'R1']])
})

test('clock-in with the general sentinel logs against no task', async () => {
  const db = fakeDb()
  await clockIn(fakeInteraction({ task: GENERAL }), { db, getConfig })
  assert.equal(db.rows[0].taskId, null)
})

test('clock-in refuses a task the caller may not clock into, and writes nothing', async () => {
  const db = fakeDb({ tasks: [FAR] })
  db.projectMember.findByMember = async () => []
  const it = fakeInteraction({ task: 'F' })
  await clockIn(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /not available|cannot/i)
})

test('a task that does not exist gets the same refusal as one the caller may not use', async () => {
  const db = fakeDb({ tasks: [FAR] })
  db.projectMember.findByMember = async () => []
  const hidden = fakeInteraction({ task: 'F' })
  const missing = fakeInteraction({ task: 'nope' })
  await clockIn(hidden, { db, getConfig })
  await clockIn(missing, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.equal(hidden.replies[0].content, missing.replies[0].content)
})

test('leadership can clock into a task they do not hold and are not a project member of', async () => {
  const db = fakeDb({ tasks: [FAR] })
  db.projectMember.findByMember = async () => []
  const it = fakeInteraction({ task: 'F' }, { member: ADMIN_MEMBER })
  await clockIn(it, { db, getConfig })
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].taskId, 'F')
})

test('clock-out closes the entry, writes minutes and reports the task total', async () => {
  const started = new Date(Date.now() - 30 * 60000)
  const db = fakeDb({ entries: [
    { id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: started, clockOutAt: null },
    { id: 'e0', discordId: 'u1', taskId: 'H', clockInAt: started, clockOutAt: started, minutes: 60 },
  ] })
  const it = fakeInteraction({ note: 'finished the parser' })
  await clockOut(it, { db, getConfig })
  const row = db.rows.find((r) => r.id === 'e1')
  assert.equal(row.minutes, 30)
  assert.equal(row.note, 'finished the parser')
  assert.match(it.replies[0].content, /30m/)
  assert.match(it.replies[0].content, /1h 30m/, 'the task total includes this session')
})

test('clock-out totals across everyone who logged on the task', async () => {
  const started = new Date(Date.now() - 30 * 60000)
  const db = fakeDb({ entries: [
    { id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: started, clockOutAt: null },
    { id: 'e0', discordId: 'u2', taskId: 'H', clockInAt: started, clockOutAt: started, minutes: 90 },
  ] })
  const it = fakeInteraction()
  await clockOut(it, { db, getConfig })
  assert.match(it.replies[0].content, /2h/, '30m + 90m from a teammate')
})

test('clock-out of general work shows no task total', async () => {
  const started = new Date(Date.now() - 20 * 60000)
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: null, clockInAt: started, clockOutAt: null }] })
  const it = fakeInteraction()
  await clockOut(it, { db, getConfig })
  assert.match(it.replies[0].content, /20m/)
  assert.doesNotMatch(it.replies[0].content, /total/i)
})

test('clock-out with no timer running refuses and writes nothing', async () => {
  const db = fakeDb()
  const it = fakeInteraction()
  await clockOut(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /not clocked in/i)
})

test('autocomplete offers general work first, then clockable tasks, finished ones included', async () => {
  const DONE = { id: 'D', title: 'Shipped thing', status: 'finished', assigneeIds: ['u2'], projectId: 'p1' }
  const db = fakeDb({ tasks: [HELD, DONE, FAR] })
  const it = fakeInteraction({}, { focused: '' })
  await clockInAutocomplete(it, { db, getConfig })
  const names = it.responses[0]
  assert.deepEqual(names[0], { name: 'No task — general work', value: GENERAL })
  assert.deepEqual(names.slice(1).map((c) => c.value), ['H', 'D'], 'FAR is another project, so it is not offered')
})

test('autocomplete filters by what was typed and never exceeds 25 choices', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: 'open', assigneeIds: ['u1'], projectId: 'p1' }))
  const db = fakeDb({ tasks: many })
  const all = fakeInteraction({}, { focused: '' })
  await clockInAutocomplete(all, { db, getConfig })
  assert.equal(all.responses[0].length, 25)
  const some = fakeInteraction({}, { focused: 'Task 3' })
  await clockInAutocomplete(some, { db, getConfig })
  assert.ok(some.responses[0].slice(1).every((c) => /Task 3/.test(c.name)))
})
