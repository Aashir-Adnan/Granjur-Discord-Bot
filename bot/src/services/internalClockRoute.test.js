import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleClockInRequest, handleClockOutRequest, handleClockStatusRequest, handleClockActiveRequest,
} from './internalClockRoute.js'
import { ClockError } from './clock.js'

const H = { 'x-internal-secret': 's3cret' }
const ID = '123456789012345678'
const guild = { id: 'G1' }
const guildClient = { guilds: { cache: { get: (id) => (id === 'G1' ? guild : undefined) } } }

// Every test passes this fake db: no default db export is ever reached.
function fakeDb({ member = { discordId: ID, status: 'approved', kind: 'staff' }, cfg = { id: 'g1', guildId: 'G1' } } = {}) {
  return {
    guildConfig: { findById: async (id) => (id === 'g1' ? cfg : null) },
    guildMember: {
      findUnique: async ({ where }) => {
        const k = where.guildId_discordId
        return k.guildId === 'G1' && k.discordId === ID ? member : null
      },
    },
  }
}
const base = (over = {}) => ({ headers: H, db: fakeDb(), client: guildClient, secret: 's3cret', ...over })
const never = async () => { throw new Error('the service must not run') }

const handlers = [
  ['in', handleClockInRequest, { clockIn: never }],
  ['out', handleClockOutRequest, { clockOut: never }],
  ['status', handleClockStatusRequest, { clockStatus: never }],
  ['active', handleClockActiveRequest, { clockedInNow: never }],
]

for (const [name, handler, seams] of handlers) {
  test(`${name}: 503 without a secret, 401 on a wrong or missing one`, async () => {
    const body = { guildConfigId: 'g1', discordId: ID }
    assert.equal((await handler({ ...base({ secret: '' }), body, ...seams })).status, 503)
    assert.equal((await handler({ ...base({ headers: { 'x-internal-secret': 'nope' } }), body, ...seams })).status, 401)
    assert.equal((await handler({ ...base({ headers: {} }), body, ...seams })).status, 401)
  })
  test(`${name}: a null body or an unknown guildConfigId is a 400`, async () => {
    assert.equal((await handler({ ...base(), body: null, ...seams })).status, 400)
    const r = await handler({ ...base(), body: { guildConfigId: 'nope', discordId: ID }, ...seams })
    assert.equal(r.status, 400)
  })
  test(`${name}: the server missing from the bot cache is a 500 with a sentence`, async () => {
    const r = await handler({ ...base({ client: { guilds: { cache: { get: () => undefined } } } }), body: { guildConfigId: 'g1', discordId: ID }, ...seams })
    assert.equal(r.status, 500)
    assert.equal(r.body.message, 'The Discord server is not available to the bot right now.')
  })
}

for (const [name, handler, seams] of handlers.slice(0, 3)) {
  test(`${name}: a malformed discordId is a 400`, async () => {
    for (const discordId of [undefined, '', 'abc', 123, 'x'.repeat(5), '1'.repeat(33)]) {
      const r = await handler({ ...base(), body: { guildConfigId: 'g1', discordId }, ...seams })
      assert.equal(r.status, 400, String(discordId))
    }
  })
  test(`${name}: a client, a pending member or an unknown account is a 400 with the sentence`, async () => {
    const cases = [
      fakeDb({ member: { discordId: ID, status: 'approved', kind: 'client' } }),
      fakeDb({ member: { discordId: ID, status: 'pending', kind: 'staff' } }),
      fakeDb({ member: null }),
    ]
    for (const db of cases) {
      const r = await handler({ ...base({ db }), body: { guildConfigId: 'g1', discordId: ID }, ...seams })
      assert.equal(r.status, 400)
      assert.equal(r.body.message, 'No staff member matches that Discord account.')
    }
  })
  test(`${name}: a row from before the kind column (no kind) still counts as staff`, async () => {
    const db = fakeDb({ member: { discordId: ID, status: 'approved' } })
    const r = await handler({ ...base({ db }), body: { guildConfigId: 'g1', discordId: ID }, clockIn: async () => ({ outcome: 'started', stopped: null }), clockOut: async () => ({ minutes: 1, task: null, taskTotalMinutes: null }), clockStatus: async () => ({ active: false }) })
    assert.equal(r.status, 200)
  })
}

test('in: calls the clock service with cfg, guild, discordId and taskId, and returns outcome, stopped and status', async () => {
  let seen
  const r = await handleClockInRequest({
    ...base(), body: { guildConfigId: 'g1', discordId: ID, taskId: 'T1' },
    clockIn: async (a) => { seen = a; return { outcome: 'switched', task: { id: 'T1' }, stopped: { title: 'x', minutes: 4 }, runningMinutes: null } },
    clockStatus: async () => ({ active: true, taskId: 'T1' }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, outcome: 'switched', stopped: { title: 'x', minutes: 4 }, status: { active: true, taskId: 'T1' } })
  assert.deepEqual({ cfg: seen.cfg, guild: seen.guild, discordId: seen.discordId, taskId: seen.taskId }, { cfg: { id: 'g1', guildId: 'G1' }, guild, discordId: ID, taskId: 'T1' })
  assert.equal(seen.member, undefined, 'the service fetches the member itself')
})
test('in: no taskId is general work (null)', async () => {
  const seen = []
  for (const body of [{ guildConfigId: 'g1', discordId: ID }, { guildConfigId: 'g1', discordId: ID, taskId: null }]) {
    await handleClockInRequest({ ...base(), body, clockIn: async (a) => { seen.push(a.taskId); return { outcome: 'started', stopped: null } }, clockStatus: async () => ({ active: true }) })
  }
  assert.deepEqual(seen, [null, null])
})
test('in: a taskId that is not a string or is too long is a 400', async () => {
  for (const taskId of [5, {}, '', 'x'.repeat(65)]) {
    const r = await handleClockInRequest({ ...base(), body: { guildConfigId: 'g1', discordId: ID, taskId }, clockIn: never })
    assert.equal(r.status, 400, String(taskId))
  }
})
test('in: a ClockError is a 409 with its own sentence and is not logged', async () => {
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a)
  try {
    const r = await handleClockInRequest({ ...base(), body: { guildConfigId: 'g1', discordId: ID, taskId: 'T1' }, clockIn: async () => { throw new ClockError('That task is not available to clock in on.') } })
    assert.equal(r.status, 409)
    assert.deepEqual(r.body, { ok: false, message: 'That task is not available to clock in on.' })
    assert.equal(errors.length, 0)
  } finally { console.error = orig }
})
test('in: any other thrown error is a logged 500', async () => {
  const orig = console.error; console.error = () => {}
  try {
    const r = await handleClockInRequest({ ...base(), body: { guildConfigId: 'g1', discordId: ID }, clockIn: async () => { throw new Error('db down') } })
    assert.equal(r.status, 500)
    assert.equal(r.body.message, 'db down')
  } finally { console.error = orig }
})

test('out: passes the note through and returns minutes, taskTitle and taskTotalMinutes', async () => {
  let seen
  const r = await handleClockOutRequest({
    ...base(), body: { guildConfigId: 'g1', discordId: ID, note: 'did things' },
    clockOut: async (a) => { seen = a; return { minutes: 42, task: { id: 'T1', title: 'Git Sync' }, taskTotalMinutes: 90 } },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, minutes: 42, taskTitle: 'Git Sync', taskTotalMinutes: 90 })
  assert.equal(seen.note, 'did things')
  assert.equal(seen.discordId, ID)
  assert.deepEqual(seen.guild, guild)
  assert.deepEqual(seen.cfg, { id: 'g1', guildId: 'G1' })
})
test('out: general work has a null taskTitle and no note is fine', async () => {
  let seen
  const r = await handleClockOutRequest({
    ...base(), body: { guildConfigId: 'g1', discordId: ID },
    clockOut: async (a) => { seen = a; return { minutes: 5, task: null, taskTotalMinutes: null } },
  })
  assert.deepEqual(r.body, { ok: true, minutes: 5, taskTitle: null, taskTotalMinutes: null })
  assert.equal(seen.note, undefined)
})
test('out: a note that is not a string is a 400', async () => {
  for (const note of [5, {}, ['a']]) {
    const r = await handleClockOutRequest({ ...base(), body: { guildConfigId: 'g1', discordId: ID, note }, clockOut: never })
    assert.equal(r.status, 400, String(note))
  }
})
test('out: a ClockError is a 409 with its sentence', async () => {
  const r = await handleClockOutRequest({ ...base(), body: { guildConfigId: 'g1', discordId: ID }, clockOut: async () => { throw new ClockError('You are not clocked in.') } })
  assert.equal(r.status, 409)
  assert.deepEqual(r.body, { ok: false, message: 'You are not clocked in.' })
})

test('status: returns the service result', async () => {
  let seen
  const result = { active: true, entryId: 'e1', taskId: null, taskTitle: 'General work', projectName: null, clockInAt: 'x', elapsedSeconds: 7 }
  const r = await handleClockStatusRequest({ ...base(), body: { guildConfigId: 'g1', discordId: ID }, clockStatus: async (a) => { seen = a; return result } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, status: result })
  assert.equal(seen.discordId, ID)
  assert.deepEqual(seen.guild, guild)
})

test('active: returns the people, with no discordId needed and no staff check', async () => {
  let seen
  const people = [{ discordId: ID, name: 'A' }]
  const db = fakeDb({ member: null })
  const r = await handleClockActiveRequest({ ...base({ db }), body: { guildConfigId: 'g1' }, clockedInNow: async (a) => { seen = a; return people } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, people })
  assert.deepEqual(seen.cfg, { id: 'g1', guildId: 'G1' })
})
